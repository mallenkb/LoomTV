use libloading::Library;
use loomtv_core::{Error, Result};
use loomtv_playback::mpv::contract;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::sync::Mutex;

type Create = unsafe extern "C" fn(*const c_char, *mut c_char, usize) -> *mut c_void;
type Attach = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_char, usize) -> i32;
type Command = unsafe extern "C" fn(*mut c_void, u64, *const c_char, *mut c_char, usize) -> i32;
type Poll = unsafe extern "C" fn(*mut c_void) -> *mut c_char;
type Free = unsafe extern "C" fn(*mut c_void);
type Destroy = unsafe extern "C" fn(*mut c_void);

struct Native {
    _bridge: Option<Library>,
    engine: usize,
    attach: Attach,
    command: Command,
    poll: Poll,
    free: Free,
    destroy: Destroy,
    attached: bool,
}

// The bridge serializes engine control through this mutex. AppKit work is
// dispatched to the main thread inside the bridge and no pointer reaches JS.
unsafe impl Send for Native {}

struct Session {
    id: String,
    awaiting_start: bool,
    state: contract::State,
    after_load: Vec<Value>,
    load_request: Option<u64>,
}

struct Inner {
    lifecycle: Mutex<()>,
    next_request: AtomicU64,
    native: Mutex<Option<Native>>,
    session: Mutex<Option<Session>>,
    startup_error: StdMutex<Option<String>>,
    library_path: Option<String>,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    available: AtomicBool,
}

#[derive(Clone)]
pub struct LibMpvService(Arc<Inner>);

fn native_error(buffer: &[c_char]) -> String {
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .trim()
        .to_owned()
}

fn failure(message: impl Into<String>) -> Error {
    Error::new("libmpv_error", message)
}

impl LibMpvService {
    pub fn new(
        bridge_path: Option<&Path>,
        library_path: Option<&Path>,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Self {
        let loaded = (|| unsafe {
            let bridge_path = bridge_path.ok_or("The bundled libmpv bridge is missing.")?;
            let library_path = library_path.ok_or("The bundled libmpv library is missing.")?;
            let bridge = Library::new(bridge_path)
                .map_err(|error| format!("The libmpv bridge could not load: {error}"))?;
            let version = *bridge
                .get::<unsafe extern "C" fn() -> u32>(b"loom_mpv_bridge_version\0")
                .map_err(|_| "The libmpv bridge version API is missing.".to_owned())?;
            if version() != 1 {
                return Err("The bundled libmpv bridge version is unsupported.".to_owned());
            }
            let create = *bridge
                .get::<Create>(b"loom_mpv_create\0")
                .map_err(|_| "The libmpv create API is missing.".to_owned())?;
            let attach = *bridge
                .get::<Attach>(b"loom_mpv_attach\0")
                .map_err(|_| "The libmpv attach API is missing.".to_owned())?;
            let command = *bridge
                .get::<Command>(b"loom_mpv_command\0")
                .map_err(|_| "The libmpv command API is missing.".to_owned())?;
            let poll = *bridge
                .get::<Poll>(b"loom_mpv_poll\0")
                .map_err(|_| "The libmpv poll API is missing.".to_owned())?;
            let free = *bridge
                .get::<Free>(b"loom_mpv_free\0")
                .map_err(|_| "The libmpv free API is missing.".to_owned())?;
            let destroy = *bridge
                .get::<Destroy>(b"loom_mpv_destroy\0")
                .map_err(|_| "The libmpv destroy API is missing.".to_owned())?;
            let path = CString::new(library_path.to_string_lossy().as_bytes())
                .map_err(|_| "The libmpv library path is invalid.".to_owned())?;
            let mut error = [0 as c_char; 1024];
            let engine = create(path.as_ptr(), error.as_mut_ptr(), error.len());
            if engine.is_null() {
                let message = native_error(&error);
                return Err(if message.is_empty() {
                    "libmpv initialization failed.".to_owned()
                } else {
                    message
                });
            }
            Ok(Native {
                _bridge: Some(bridge),
                engine: engine as usize,
                attach,
                command,
                poll,
                free,
                destroy,
                attached: false,
            })
        })();

        let (native, startup_error) = match loaded {
            Ok(native) => (Some(native), None),
            Err(error) => (None, Some(error)),
        };
        let available = native.is_some();
        let service = Self(Arc::new(Inner {
            lifecycle: Mutex::new(()),
            next_request: AtomicU64::new(1),
            native: Mutex::new(native),
            session: Mutex::new(None),
            startup_error: StdMutex::new(startup_error),
            library_path: library_path.map(|path| path.to_string_lossy().into_owned()),
            emit,
            available: AtomicBool::new(available),
        }));
        service.start_polling();
        service
    }

    fn start_polling(&self) {
        let inner = self.0.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if !inner.available.load(Ordering::Acquire) {
                    break;
                }
                // Keep the session stable from the native read through state delivery.
                // Otherwise a replacement load can receive the previous file's events.
                let mut session = inner.session.lock().await;
                let Some(session) = session.as_mut() else {
                    continue;
                };
                let events = {
                    let native = inner.native.lock().await;
                    let Some(native) = native.as_ref() else { break };
                    unsafe {
                        let pointer = (native.poll)(native.engine as *mut c_void);
                        if pointer.is_null() {
                            None
                        } else {
                            let bytes = CStr::from_ptr(pointer).to_bytes().to_vec();
                            (native.free)(pointer.cast());
                            serde_json::from_slice::<Vec<Value>>(&bytes).ok()
                        }
                    }
                };
                let Some(events) = events else { continue };
                for event in events {
                    let load_failed = event["request_id"]
                        .as_u64()
                        .is_some_and(|request| Some(request) == session.load_request)
                        && event["error"]
                            .as_str()
                            .is_some_and(|error| error != "success");
                    if event["event"] == "start-file" {
                        session.awaiting_start = false;
                    }
                    // Ignore idle-core properties left over from the stopped file.
                    if session.awaiting_start && !load_failed && event["event"] != "bridge-error" {
                        continue;
                    }
                    if event["event"] == "file-loaded" {
                        // Resume seeking and sidecars belong to the loaded file.
                        // Applying either while the persistent core is idle can
                        // fail or affect the previous file.
                        let native = inner.native.lock().await;
                        if let Some(native) = native.as_ref() {
                            let queued = std::mem::take(&mut session.after_load);
                            for command in queued {
                                let request = inner.next_request.fetch_add(1, Ordering::Relaxed);
                                if let Ok(command) = CString::new(command.to_string()) {
                                    let mut error = [0 as c_char; 1024];
                                    unsafe {
                                        (native.command)(
                                            native.engine as *mut c_void,
                                            request,
                                            command.as_ptr(),
                                            error.as_mut_ptr(),
                                            error.len(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if event["event"] == "bridge-error" || load_failed {
                        session.state.value["status"] = json!("error");
                        session.state.value["error"] = event["error"].clone();
                        session.state.dirty = true;
                    } else {
                        session.state.event(&event);
                    }
                }
                if let Some(value) = session.state.take_update() {
                    (inner.emit)(value);
                }
            }
        });
    }

    pub async fn availability(&self) -> Value {
        // Availability must remain responsive while a render view attaches.
        let available = self.0.available.load(Ordering::Acquire);
        let warning = self
            .0
            .startup_error
            .lock()
            .ok()
            .and_then(|value| value.clone());
        json!({
            "available":available,
            "enabled":true,
            "surface":if available { "composited-window" } else { "unavailable" },
            "runtimeSource":"bundled",
            "libraryPath":self.0.library_path,
            "warning":warning,
            "reason":warning
        })
    }

    async fn send(&self, command: Value) -> Result<()> {
        let verb = command[0].as_str().unwrap_or("unknown");
        let label = if verb == "set_property" {
            format!("set_property {}", command[1].as_str().unwrap_or("unknown"))
        } else {
            verb.to_owned()
        };
        let mut session = self.0.session.lock().await;
        let session = session
            .as_mut()
            .ok_or_else(|| failure("This libmpv session is no longer active."))?;
        let request = self.0.next_request.fetch_add(1, Ordering::Relaxed);
        if verb == "loadfile" {
            session.load_request = Some(request);
        }
        let bytes = serde_json::to_vec(&command)?;
        let command = CString::new(bytes)
            .map_err(|_| failure("The libmpv command contains an invalid character."))?;
        let native = self.0.native.lock().await;
        let native = native
            .as_ref()
            .ok_or_else(|| failure("libmpv is unavailable."))?;
        let mut error = [0 as c_char; 1024];
        let code = unsafe {
            (native.command)(
                native.engine as *mut c_void,
                request,
                command.as_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if code < 0 {
            let message = native_error(&error);
            return Err(failure(if message.is_empty() {
                format!("libmpv rejected the {label} command.")
            } else {
                format!("libmpv {label} failed: {message}")
            }));
        }
        Ok(())
    }

    pub async fn start(&self, source: String, options: Value, drawable: usize) -> Result<Value> {
        let _lifecycle = self.0.lifecycle.lock().await;
        if source.is_empty() || source.len() > 32_768 || source.contains('\0') {
            return Err(failure("The authorized media source is invalid."));
        }
        let commands = contract::start_commands(&options).map_err(failure)?;
        self.stop_inner(None).await?;
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut native = self.0.native.lock().await;
            let native = native.as_mut().ok_or_else(|| {
                failure(
                    self.0
                        .startup_error
                        .lock()
                        .ok()
                        .and_then(|value| value.clone())
                        .unwrap_or_else(|| "libmpv is unavailable.".to_owned()),
                )
            })?;
            if !native.attached {
                let mut error = [0 as c_char; 1024];
                let code = unsafe {
                    (native.attach)(
                        native.engine as *mut c_void,
                        drawable as *mut c_void,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if code < 0 {
                    let message = native_error(&error);
                    return Err(failure(if message.is_empty() {
                        "The libmpv render view could not attach.".to_owned()
                    } else {
                        message
                    }));
                }
                native.attached = true;
            }
            // The idle core retains events from its previous session. Do not
            // publish those as state for the new session.
            unsafe {
                let events = (native.poll)(native.engine as *mut c_void);
                if !events.is_null() {
                    (native.free)(events.cast());
                }
            }
        }
        *self.0.session.lock().await = Some(Session {
            state: contract::State::new(&id, &options),
            id: id.clone(),
            awaiting_start: true,
            load_request: None,
            after_load: commands
                .into_iter()
                .chain(std::iter::once(json!(["set_property", "pause", false])))
                .chain(
                    options["startSeconds"]
                        .as_f64()
                        .filter(|value| *value > 0.)
                        .map(|position| json!(["seek", position, "absolute+exact"])),
                )
                .chain(
                    options["subtitleFiles"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|file| json!(["sub-add", file["path"], "auto"])),
                )
                .collect(),
        });
        // Properties such as volume are unavailable while the persistent core
        // is idle. Load first, then apply the queued session settings when
        // libmpv reports file-loaded.
        let result = self.send(json!(["loadfile", source, "replace"])).await;
        if let Err(error) = result {
            let _ = self.stop_inner(Some(id.clone())).await;
            return Err(error);
        }
        Ok(json!({"ok":true,"sessionId":id,"surface":"composited-window"}))
    }

    pub async fn command(&self, id: String, value: Value) -> Result<Value> {
        let _lifecycle = self.0.lifecycle.lock().await;
        if self
            .0
            .session
            .lock()
            .await
            .as_ref()
            .map(|row| row.id.as_str())
            != Some(id.as_str())
        {
            return Err(failure("This libmpv session is no longer active."));
        }
        for command in contract::commands(&value).map_err(failure)? {
            self.send(command).await?;
        }
        Ok(json!(true))
    }

    pub async fn stop(&self, id: Option<String>) -> Result<Value> {
        let _lifecycle = self.0.lifecycle.lock().await;
        self.stop_inner(id).await
    }

    async fn stop_inner(&self, id: Option<String>) -> Result<Value> {
        self.stop_inner_with_timeout(id, Duration::from_secs(5))
            .await
    }

    async fn stop_inner_with_timeout(
        &self,
        id: Option<String>,
        timeout: Duration,
    ) -> Result<Value> {
        let mut session = self.0.session.lock().await;
        let matches = session
            .as_ref()
            .is_some_and(|session| id.as_ref().is_none_or(|id| id == &session.id));
        if !matches {
            return Ok(json!(false));
        }
        // Stop owns both locks until acknowledgement or engine retirement.
        let mut native = self.0.native.lock().await;
        let request = self.0.next_request.fetch_add(1, Ordering::Relaxed);
        let result = match native.as_ref() {
            Some(native) => stop_native(native, request, timeout).await,
            None => Err(failure("libmpv is unavailable.")),
        };
        if let Err(error) = result {
            self.0.available.store(false, Ordering::Release);
            if let Ok(mut warning) = self.0.startup_error.lock() {
                *warning = Some(error.message.clone());
            }
            // An unconfirmed stop cannot be reused by a replacement renderer.
            if let Some(native) = native.take() {
                unsafe { (native.destroy)(native.engine as *mut c_void) };
            }
            if let Some(stopped) = session.take() {
                (self.0.emit)(
                    json!({"sessionId":stopped.id,"status":"closed","error":error.message}),
                );
            }
            return Err(error);
        }
        if let Some(stopped) = session.take() {
            (self.0.emit)(json!({"sessionId":stopped.id,"status":"closed"}));
        }
        Ok(json!(true))
    }

    pub async fn shutdown(&self) {
        let _lifecycle = self.0.lifecycle.lock().await;
        let _ = self.stop_inner(None).await;
        self.0.available.store(false, Ordering::Release);
        if let Some(native) = self.0.native.lock().await.take() {
            unsafe { (native.destroy)(native.engine as *mut c_void) };
        }
    }
}

// The caller holds session and native ownership. Polling cannot steal this reply.
async fn stop_native(native: &Native, request: u64, timeout: Duration) -> Result<()> {
    let command = CString::new("[\"stop\"]").map_err(|_| failure("Invalid stop command."))?;
    let mut error = [0 as c_char; 1024];
    let code = unsafe {
        (native.command)(
            native.engine as *mut c_void,
            request,
            command.as_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if code < 0 {
        return Err(failure(format!(
            "libmpv could not stop: {}",
            native_error(&error)
        )));
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let events = unsafe {
            let pointer = (native.poll)(native.engine as *mut c_void);
            if pointer.is_null() {
                Vec::new()
            } else {
                let bytes = CStr::from_ptr(pointer).to_bytes().to_vec();
                (native.free)(pointer.cast());
                serde_json::from_slice::<Vec<Value>>(&bytes)?
            }
        };
        if let Some(reply) = events.iter().find(|event| {
            event["event"] == "command-reply" && event["request_id"].as_u64() == Some(request)
        }) {
            return match reply["error"].as_str() {
                Some("success") => Ok(()),
                Some(error) => Err(failure(format!("libmpv could not stop: {error}"))),
                None => Err(failure("libmpv returned an invalid stop acknowledgement.")),
            };
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(failure(
                "libmpv did not acknowledge stop. Restart the app to use native playback.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct Fake {
        commands: Vec<(u64, Value)>,
        events: VecDeque<String>,
        acknowledge: bool,
        reject: bool,
        destroyed: bool,
    }

    unsafe extern "C" fn attach(_: *mut c_void, _: *mut c_void, _: *mut c_char, _: usize) -> i32 {
        0
    }
    unsafe extern "C" fn command(
        engine: *mut c_void,
        id: u64,
        command: *const c_char,
        _: *mut c_char,
        _: usize,
    ) -> i32 {
        let fake = &*engine.cast::<Arc<StdMutex<Fake>>>();
        let mut fake = fake.lock().unwrap();
        let value: Value = serde_json::from_slice(CStr::from_ptr(command).to_bytes()).unwrap();
        let stop = value[0] == "stop";
        fake.commands.push((id, value));
        if fake.reject {
            return -1;
        }
        if stop && fake.acknowledge {
            fake.events.push_back(
                json!([{"event":"command-reply","request_id":id,"error":"success"}]).to_string(),
            );
        }
        0
    }
    unsafe extern "C" fn poll(engine: *mut c_void) -> *mut c_char {
        let fake = &*engine.cast::<Arc<StdMutex<Fake>>>();
        fake.lock()
            .unwrap()
            .events
            .pop_front()
            .map(|events| CString::new(events).unwrap().into_raw())
            .unwrap_or(std::ptr::null_mut())
    }
    unsafe extern "C" fn free(pointer: *mut c_void) {
        drop(CString::from_raw(pointer.cast()));
    }
    unsafe extern "C" fn destroy(engine: *mut c_void) {
        let fake = Box::from_raw(engine.cast::<Arc<StdMutex<Fake>>>());
        fake.lock().unwrap().destroyed = true;
    }

    fn fixture() -> (
        LibMpvService,
        Arc<StdMutex<Fake>>,
        Arc<StdMutex<Vec<Value>>>,
    ) {
        let fake = Arc::new(StdMutex::new(Fake {
            acknowledge: true,
            ..Fake::default()
        }));
        let updates = Arc::new(StdMutex::new(Vec::new()));
        let output = updates.clone();
        let service = LibMpvService(Arc::new(Inner {
            lifecycle: Mutex::new(()),
            next_request: AtomicU64::new(1),
            native: Mutex::new(Some(Native {
                _bridge: None,
                engine: Box::into_raw(Box::new(fake.clone())) as usize,
                attach,
                command,
                poll,
                free,
                destroy,
                attached: false,
            })),
            session: Mutex::new(None),
            startup_error: StdMutex::new(None),
            library_path: None,
            emit: Arc::new(move |value| output.lock().unwrap().push(value)),
            available: AtomicBool::new(true),
        }));
        (service, fake, updates)
    }

    async fn until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("native operation did not finish");
    }

    #[test]
    fn replacement_waits_for_matching_stop_reply_and_rejects_stale_session() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (service, fake, updates) = fixture();
            let first = service.start("first".into(), json!({}), 1).await.unwrap();
            fake.lock().unwrap().acknowledge = false;
            let stopping = {
                let service = service.clone();
                tokio::spawn(async move { service.stop(None).await })
            };
            until(|| fake.lock().unwrap().commands.len() == 2).await;
            let replacing = {
                let service = service.clone();
                tokio::spawn(async move { service.start("second".into(), json!({}), 1).await })
            };
            let request = fake.lock().unwrap().commands[1].0;
            fake.lock().unwrap().events.push_back(
                json!([
                    {"event":"command-reply","request_id":request - 1,"error":"success"},
                    {"event":"property-change","name":"eof-reached","data":true}
                ])
                .to_string(),
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!stopping.is_finished());
            assert_eq!(fake.lock().unwrap().commands.len(), 2);
            assert!(updates.lock().unwrap().is_empty());
            {
                let mut fake = fake.lock().unwrap();
                fake.acknowledge = true;
                fake.events.push_back(
                    json!([{"event":"command-reply","request_id":request,"error":"success"}])
                        .to_string(),
                );
            }
            let second = tokio::time::timeout(Duration::from_secs(2), async {
                assert_eq!(stopping.await.unwrap().unwrap(), true);
                replacing.await.unwrap().unwrap()
            })
            .await
            .unwrap();
            assert_ne!(first["sessionId"], second["sessionId"]);
            assert_eq!(
                service
                    .stop(Some(first["sessionId"].as_str().unwrap().into()))
                    .await
                    .unwrap(),
                false
            );
            assert!(service
                .command(first["sessionId"].as_str().unwrap().into(), json!({}))
                .await
                .is_err());
            assert_eq!(fake.lock().unwrap().commands.len(), 3);
            assert!(fake
                .lock()
                .unwrap()
                .commands
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0));
            service.shutdown().await;
            assert!(fake.lock().unwrap().destroyed);
        });
    }

    #[test]
    fn stop_failures_retire_engine_clear_session_and_allow_shutdown() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for mode in ["timeout", "submit", "reply", "malformed", "missing-error"] {
                let (service, fake, updates) = fixture();
                service.start("first".into(), json!({}), 1).await.unwrap();
                {
                    let mut fake = fake.lock().unwrap();
                    fake.acknowledge = false;
                    fake.reject = mode == "submit";
                    match mode {
                        "reply" => fake.events.push_back(
                            json!([{"event":"command-reply","request_id":2,"error":"failed"}])
                                .to_string(),
                        ),
                        "malformed" => fake.events.push_back("invalid JSON".into()),
                        "missing-error" => fake.events.push_back(
                            json!([{"event":"command-reply","request_id":2}]).to_string(),
                        ),
                        _ => {}
                    }
                }
                assert!(
                    service
                        .stop_inner_with_timeout(None, Duration::from_millis(10))
                        .await
                        .is_err(),
                    "{mode}"
                );
                assert!(fake.lock().unwrap().destroyed, "{mode}");
                assert!(service.0.session.lock().await.is_none());
                assert_eq!(service.availability().await["available"], false);
                assert_eq!(updates.lock().unwrap().last().unwrap()["status"], "closed");
                assert!(service.start("second".into(), json!({}), 1).await.is_err());
                tokio::time::timeout(Duration::from_secs(1), service.shutdown())
                    .await
                    .unwrap();
            }
        });
    }

    #[test]
    fn polling_ignores_idle_events_until_start_file() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (service, fake, updates) = fixture();
            service.start("first".into(), json!({}), 1).await.unwrap();
            fake.lock().unwrap().events.push_back(
                json!([
                    {"event":"property-change","name":"eof-reached","data":true},
                    {"event":"property-change","name":"time-pos","data":99},
                    {"event":"file-loaded"}
                ])
                .to_string(),
            );
            service.start_polling();
            until(|| !updates.lock().unwrap().is_empty()).await;
            assert_eq!(
                updates.lock().unwrap().last().unwrap()["status"],
                "starting"
            );
            assert!(updates.lock().unwrap().last().unwrap()["position"].is_null());
            assert_eq!(fake.lock().unwrap().commands.len(), 1);
            fake.lock().unwrap().events.push_back(
                json!([
                    {"event":"start-file"}, {"event":"file-loaded"},
                    {"event":"property-change","name":"time-pos","data":3}
                ])
                .to_string(),
            );
            until(|| {
                updates
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|value| value["position"].as_f64() == Some(3.0))
            })
            .await;
            assert_eq!(updates.lock().unwrap().last().unwrap()["status"], "ready");
            assert!(fake.lock().unwrap().commands.len() > 1);
            service.shutdown().await;
        });
    }

    #[test]
    fn rejected_load_cleans_up_and_async_load_error_reaches_renderer() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (service, fake, _) = fixture();
            fake.lock().unwrap().reject = true;
            assert!(service.start("first".into(), json!({}), 1).await.is_err());
            assert!(service.0.session.lock().await.is_none());
            assert!(fake.lock().unwrap().destroyed);
            service.shutdown().await;

            let (service, fake, updates) = fixture();
            service.start("first".into(), json!({}), 1).await.unwrap();
            fake.lock().unwrap().events.push_back(
                json!([{"event":"command-reply","request_id":1,"error":"load failed"}]).to_string(),
            );
            service.start_polling();
            until(|| {
                updates
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|value| value["status"] == "error")
            })
            .await;
            assert_eq!(fake.lock().unwrap().commands.len(), 1);
            service.shutdown().await;
        });
    }
}
