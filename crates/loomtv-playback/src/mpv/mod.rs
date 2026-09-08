//! Owned external-window mpv fallback. Only reviewed playback commands reach IPC.
pub mod contract;
mod runtime;
#[cfg(test)]
mod tests;
pub use runtime::{validate as validate_executable, Candidate, ResolvedRuntime, RuntimeResolver};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{timeout, Instant},
};

type Result<T> = std::result::Result<T, String>;
type Reply = oneshot::Sender<Result<Value>>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;
const MAX_FRAME: usize = 1024 * 1024;
const ACK_TIMEOUT: Duration = Duration::from_secs(3);
const OBSERVATIONS: &[&str] = &[
    "time-pos",
    "duration",
    "pause",
    "volume",
    "mute",
    "speed",
    "track-list",
    "video-params",
    "hwdec-current",
    "frame-drop-count",
    "decoder-frame-drop-count",
    "demuxer-cache-duration",
    "paused-for-cache",
    "video-codec",
    "estimated-vf-fps",
    "eof-reached",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowState {
    pub geometry: Option<String>,
    pub minimized: bool,
}
enum Request {
    Start {
        executable: PathBuf,
        source: String,
        options: Value,
        window: WindowState,
        reply: Reply,
    },
    Command {
        session: String,
        value: Value,
        reply: Reply,
    },
    Stop {
        session: Option<String>,
        reply: Reply,
    },
    Shutdown {
        reply: Reply,
    },
    #[cfg(test)]
    Inspect {
        reply: Reply,
    },
}
pub struct MpvService {
    sender: mpsc::Sender<Request>,
    window: watch::Sender<WindowState>,
}
impl MpvService {
    /// Called inside the application's existing Tokio runtime. No engine starts until Start.
    pub fn new(emit: Emit) -> Self {
        let (sender, receiver) = mpsc::channel(64);
        let (window, state) = watch::channel(WindowState::default());
        tokio::spawn(worker(receiver, state, emit, false));
        Self { sender, window }
    }
    async fn send(&self, build: impl FnOnce(Reply) -> Request) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(build(tx))
            .map_err(|_| "The mpv command queue is busy or closed.")?;
        timeout(Duration::from_secs(20), rx)
            .await
            .map_err(|_| "The mpv request timed out.")?
            .map_err(|_| "The mpv worker stopped.")?
    }
    pub async fn start(
        &self,
        executable: PathBuf,
        source: String,
        options: Value,
        window: WindowState,
    ) -> Result<Value> {
        contract::start_commands(&options)?;
        self.send(|reply| Request::Start {
            executable,
            source,
            options,
            window,
            reply,
        })
        .await
    }
    pub async fn command(&self, session: String, value: Value) -> Result<Value> {
        contract::commands(&value)?;
        self.send(|reply| Request::Command {
            session,
            value,
            reply,
        })
        .await
    }
    pub async fn stop(&self, session: Option<String>) -> Result<Value> {
        self.send(|reply| Request::Stop { session, reply }).await
    }
    pub async fn shutdown(&self) -> Result<Value> {
        self.send(|reply| Request::Shutdown { reply }).await
    }
    pub fn set_window(&self, value: WindowState) {
        self.window.send_if_modified(|old| {
            if old == &value {
                false
            } else {
                *old = value;
                true
            }
        });
    }
}
enum Wake {
    Request(Option<Request>),
    Message(Option<Result<Value>>),
    Tick,
}
async fn worker(
    mut requests: mpsc::Receiver<Request>,
    mut window: watch::Receiver<WindowState>,
    emit: Emit,
    headless: bool,
) {
    let mut current: Option<Session> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let wake = if let Some(session) = current.as_mut() {
            tokio::select! {r=requests.recv()=>Wake::Request(r),message=session.messages.recv()=>Wake::Message(message),_=tick.tick()=>Wake::Tick}
        } else {
            Wake::Request(requests.recv().await)
        };
        match wake {
            Wake::Request(Some(Request::Start {
                executable,
                source,
                options,
                window: initial,
                reply,
            })) => {
                if reply.is_closed() {
                    continue;
                }
                if let Some(previous) = current.take() {
                    previous.close(&emit).await;
                }
                window.borrow_and_update();
                match Session::open(&executable, &source, &options, &initial, headless).await {
                    Ok(mut session) => {
                        session.flush(&emit);
                        let result =
                            json!({"ok":true,"sessionId":session.id,"surface":"external-window"});
                        if reply.send(Ok(result)).is_err() {
                            session.close(&emit).await;
                        } else {
                            current = Some(session);
                        }
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Wake::Request(Some(Request::Command {
                session,
                value,
                reply,
            })) => {
                if reply.is_closed() {
                    continue;
                }
                let result = match current.as_mut() {
                    Some(player) if player.id == session => player.command(&value).await,
                    _ => Err("This playback session is no longer active.".into()),
                };
                if let Some(player) = current.as_mut() {
                    player.flush(&emit);
                }
                let _ = reply.send(result.map(|_| json!(true)));
            }
            Wake::Request(Some(Request::Stop { session, reply })) => {
                let matched = current
                    .as_ref()
                    .is_some_and(|p| session.as_ref().is_none_or(|id| id == &p.id));
                if matched {
                    if let Some(previous) = current.take() {
                        previous.close(&emit).await;
                    }
                }
                let _ = reply.send(Ok(json!(matched)));
            }
            Wake::Request(Some(Request::Shutdown { reply })) => {
                if let Some(previous) = current.take() {
                    previous.close(&emit).await;
                }
                let _ = reply.send(Ok(json!(true)));
                break;
            }
            Wake::Request(None) => {
                if let Some(previous) = current.take() {
                    previous.close(&emit).await;
                }
                break;
            }
            #[cfg(test)]
            Wake::Request(Some(Request::Inspect { reply })) => {
                let _=reply.send(Ok(current.as_ref().map(|p|json!({"pid":p.child.id(),"directory":p._endpoint.directory,"state":p.state.value})).unwrap_or(Value::Null)));
            }
            Wake::Message(Some(Ok(message))) => {
                if let Some(p) = current.as_mut() {
                    let old = p.state.value["status"].clone();
                    p.state.event(&message);
                    if old != p.state.value["status"] {
                        p.flush(&emit);
                    }
                }
            }
            Wake::Message(Some(Err(_)) | None) => {
                if let Some(mut p) = current.take() {
                    if !p.state.ended {
                        p.fail("The mpv control connection closed.", &emit);
                    }
                    p.close(&emit).await;
                }
            }
            Wake::Tick => {
                if let Some(p) = current.as_mut() {
                    if p.child.try_wait().ok().flatten().is_some() {
                        if !p.state.ended {
                            p.fail("mpv exited before playback completed.", &emit);
                        }
                        if let Some(p) = current.take() {
                            p.close(&emit).await;
                        }
                        continue;
                    }
                    if window.has_changed().unwrap_or(false) {
                        let value = window.borrow_and_update().clone();
                        let _ = p.window(&value).await;
                    }
                    p.flush(&emit);
                }
            }
        }
    }
}
trait Ipc: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Ipc for T {}
type Stream = Box<dyn Ipc>;
struct Endpoint {
    address: String,
    directory: Option<PathBuf>,
}
impl Endpoint {
    fn new() -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            // A short path avoids the Unix socket path limit on macOS. create_dir is exclusive.
            let directory =
                PathBuf::from("/tmp").join(format!("loomtv-mpv-{}", uuid::Uuid::new_v4().simple()));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .map_err(|_| "The private mpv socket directory could not be created.")?;
            Ok(Self {
                address: directory.join("ipc").to_string_lossy().into_owned(),
                directory: Some(directory),
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                address: format!(
                    r"\\.\pipe\loomtv-tauri-mpv-{}",
                    uuid::Uuid::new_v4().simple()
                ),
                directory: None,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err("mpv IPC is unavailable on this platform.".into())
        }
    }
    async fn connect(&self, child: &mut Child) -> Result<Stream> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child
                .try_wait()
                .map_err(|_| "mpv process state is unavailable.")?
                .is_some()
            {
                return Err("mpv exited before opening its control connection.".into());
            }
            #[cfg(unix)]
            if let Ok(socket) = tokio::net::UnixStream::connect(&self.address).await {
                return Ok(Box::new(socket));
            }
            #[cfg(windows)]
            if let Ok(pipe) =
                tokio::net::windows::named_pipe::ClientOptions::new().open(&self.address)
            {
                use std::os::windows::io::AsRawHandle;
                #[link(name = "kernel32")]
                unsafe extern "system" {
                    fn GetNamedPipeServerProcessId(
                        pipe: *mut std::ffi::c_void,
                        pid: *mut u32,
                    ) -> i32;
                }
                let mut pid = 0;
                // Borrowed pipe handle stays alive; pid points to an initialized writable u32.
                if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0
                    || Some(pid) != child.id()
                {
                    return Err("The mpv pipe belongs to a different process.".into());
                }
                return Ok(Box::new(pipe));
            }
            if Instant::now() >= deadline {
                return Err("mpv did not open its control connection.".into());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Some(path) = &self.directory {
            let _ = std::fs::remove_file(path.join("ipc"));
            let _ = std::fs::remove_dir(path);
        }
    }
}
struct Session {
    id: String,
    child: Child,
    _endpoint: Endpoint,
    writer: tokio::io::WriteHalf<Stream>,
    messages: mpsc::Receiver<Result<Value>>,
    reader: JoinHandle<()>,
    stderr: JoinHandle<()>,
    request: u64,
    state: contract::State,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.reader.abort();
        self.stderr.abort();
        let _ = self.child.start_kill();
    }
}
impl Session {
    async fn open(
        executable: &Path,
        source: &str,
        options: &Value,
        window: &WindowState,
        headless: bool,
    ) -> Result<Self> {
        if source.is_empty() || source.len() > 32_768 || source.contains('\0') {
            return Err("The authorized media source is invalid.".into());
        }
        let initial = contract::start_commands(options)?;
        let endpoint = Endpoint::new()?;
        let mut command = Command::new(executable);
        command.args([
            "--no-config",
            "--load-scripts=no",
            "--no-border",
            "--force-window=immediate",
            "--keep-open=yes",
            "--idle=yes",
            "--pause=no",
            "--osc=no",
            "--osd-level=0",
            "--input-default-bindings=no",
            "--input-cursor=no",
            "--input-media-keys=no",
            "--cursor-autohide=no",
            "--audio-display=no",
            "--sub-auto=no",
            "--audio-file-auto=no",
            "--cover-art-auto=no",
            "--hwdec=auto-safe",
            "--terminal=no",
            "--input-terminal=no",
        ]);
        #[cfg(target_os = "macos")]
        command.arg("--focus-on-open=no");
        command.arg(format!("--input-ipc-server={}", endpoint.address));
        if let Some(start) = options["startSeconds"].as_f64() {
            command.arg(format!("--start={}", start.clamp(0., 86_400_000.)));
        }
        if let Some(files) = options["subtitleFiles"].as_array() {
            for file in files {
                command.arg(format!(
                    "--sub-file={}",
                    file["path"]
                        .as_str()
                        .ok_or("The subtitle path is invalid.")?
                ));
            }
        }
        if let Some(geometry) = &window.geometry {
            validate_geometry(geometry)?;
            command.arg(format!("--geometry={geometry}"));
        }
        // Null outputs are exclusively for generated-media tests, never a renderer capability.
        #[cfg(test)]
        if headless {
            command.args(["--vo=null", "--ao=null", "--hwdec=no", "--force-window=no"]);
        }
        #[cfg(not(test))]
        let _ = headless;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: mpv owns its video window, not a console.
        let mut child = command
            .spawn()
            .map_err(|_| "The selected mpv executable could not start.")?;
        let mut error_output = child.stderr.take().ok_or("mpv stderr is unavailable.")?;
        let stderr = tokio::spawn(async move {
            let mut buffer = [0_u8; 8192];
            while let Ok(n) = error_output.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
            }
        });
        let socket = match endpoint.connect(&mut child).await {
            Ok(socket) => socket,
            Err(error) => {
                let _ = child.kill().await;
                stderr.abort();
                return Err(error);
            }
        };
        let (reader_stream, writer) = tokio::io::split(socket);
        let (tx, messages) = mpsc::channel(32);
        let reader = tokio::spawn(async move {
            let result = read_messages(reader_stream, &tx).await;
            if let Err(error) = result {
                let _ = tx.send(Err(error)).await;
            }
        });
        let id = uuid::Uuid::new_v4().to_string();
        let state = contract::State::new(&id, options);
        let mut session = Self {
            id,
            child,
            _endpoint: endpoint,
            writer,
            messages,
            reader,
            stderr,
            request: 0,
            state,
        };
        let initialized = async {
            for (index, name) in OBSERVATIONS.iter().enumerate() {
                session
                    .send(json!(["observe_property", index + 1, name]))
                    .await?;
            }
            for command in initial {
                session.send(command).await?;
            }
            // Loading through JSON keeps private source paths and media grants out of argv.
            session.send(json!(["loadfile", source, "replace"])).await?;
            session.window(window).await?;
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = initialized {
            let quiet: Emit = Arc::new(|_| {});
            session.close(&quiet).await;
            return Err(error);
        }
        Ok(session)
    }
    async fn send(&mut self, command: Value) -> Result<Value> {
        self.request = (self.request % 9_007_199_254_740_990) + 1;
        let id = self.request;
        let mut bytes = serde_json::to_vec(&json!({"command":command,"request_id":id}))
            .map_err(|_| "The mpv command could not be encoded.")?;
        if bytes.len() > 64 * 1024 {
            return Err("The mpv command exceeds its size limit.".into());
        }
        bytes.push(b'\n');
        let operation = async {
            self.writer
                .write_all(&bytes)
                .await
                .map_err(|_| "The mpv command could not be sent.")?;
            loop {
                let message = self
                    .messages
                    .recv()
                    .await
                    .ok_or("The mpv connection closed.")??;
                if message["request_id"].as_u64() == Some(id) {
                    return if message["error"] == "success" {
                        Ok(message["data"].clone())
                    } else {
                        Err("mpv rejected the playback operation.".into())
                    };
                }
                self.state.event(&message);
            }
        };
        timeout(ACK_TIMEOUT, operation)
            .await
            .map_err(|_| "mpv did not acknowledge the playback operation.")?
    }
    async fn command(&mut self, value: &Value) -> Result<()> {
        let commands = contract::commands(value)?;
        if self.state.ended && value["type"] == "set-paused" && value["paused"] == false {
            self.send(json!(["seek", 0, "absolute+exact"])).await?;
            self.state.ended = false;
        }
        for command in commands {
            self.send(command).await?;
        }
        if value["type"] == "seek" || value["type"] == "set-paused" && value["paused"] == false {
            self.state.value["status"] = json!("ready");
            self.state.ended = false;
            self.state.dirty = true;
        }
        Ok(())
    }
    async fn window(&mut self, state: &WindowState) -> Result<()> {
        if let Some(geometry) = &state.geometry {
            validate_geometry(geometry)?;
            self.send(json!(["set_property", "geometry", geometry]))
                .await?;
        }
        // Some headless VOs do not expose a window. No window commands are sent in those tests.
        if state.geometry.is_some() {
            self.send(json!(["set_property", "window-minimized", state.minimized]))
                .await?;
        }
        Ok(())
    }
    fn flush(&mut self, emit: &Emit) {
        if let Some(value) = self.state.take_update() {
            emit(value);
        }
    }
    fn fail(&mut self, error: &str, emit: &Emit) {
        self.state.value["status"] = json!("error");
        self.state.value["paused"] = json!(true);
        self.state.value["error"] = json!(error);
        self.state.dirty = true;
        self.flush(emit);
    }
    async fn close(mut self, emit: &Emit) {
        let _ = timeout(
            Duration::from_millis(300),
            self.writer.write_all(b"{\"command\":[\"quit\"]}\n"),
        )
        .await;
        if timeout(Duration::from_millis(1500), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
        self.reader.abort();
        self.stderr.abort();
        emit(json!({"sessionId":self.id,"status":"closed"}));
    }
}
fn validate_geometry(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || b"x+-".contains(&c))
    {
        return Err("The native window geometry is invalid.".into());
    }
    Ok(())
}
async fn read_messages(
    mut reader: impl AsyncRead + Unpin,
    tx: &mpsc::Sender<Result<Value>>,
) -> Result<()> {
    let mut frame = Vec::with_capacity(8192);
    let mut buffer = [0; 8192];
    loop {
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "The mpv IPC read failed.")?;
        if n == 0 {
            return if frame.is_empty() {
                Ok(())
            } else {
                Err("mpv closed an incomplete IPC message.".into())
            };
        }
        for byte in &buffer[..n] {
            if *byte == b'\n' {
                if frame.is_empty() {
                    continue;
                }
                let value: Value =
                    serde_json::from_slice(&frame).map_err(|_| "mpv sent invalid IPC JSON.")?;
                frame.clear();
                if !value.is_object() {
                    return Err("mpv sent an invalid IPC envelope.".into());
                }
                if tx.send(Ok(value)).await.is_err() {
                    return Ok(());
                }
            } else {
                if frame.len() >= MAX_FRAME {
                    return Err("mpv IPC exceeded its message limit.".into());
                }
                frame.push(*byte);
            }
        }
    }
}
