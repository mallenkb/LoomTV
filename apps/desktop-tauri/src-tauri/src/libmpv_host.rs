use libloading::Library;
use loomtv_core::{Error, Result};
use loomtv_playback::mpv::contract;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
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
    _bridge: Library,
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
    request: u64,
    state: contract::State,
    after_load: Vec<Value>,
    load_request: Option<u64>,
}

struct Inner {
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
                _bridge: bridge,
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
                    if event["event"] == "file-loaded" {
                        // Resume seeking and sidecars belong to the loaded file.
                        // Applying either while the persistent core is idle can
                        // fail or affect the previous file.
                        let native = inner.native.lock().await;
                        if let Some(native) = native.as_ref() {
                            let queued = std::mem::take(&mut session.after_load);
                            for command in queued {
                                session.request += 1;
                                if let Ok(command) = CString::new(command.to_string()) {
                                    let mut error = [0 as c_char; 1024];
                                    unsafe {
                                        (native.command)(
                                            native.engine as *mut c_void,
                                            session.request,
                                            command.as_ptr(),
                                            error.as_mut_ptr(),
                                            error.len(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    let load_failed = event["request_id"]
                        .as_u64()
                        .is_some_and(|request| Some(request) == session.load_request)
                        && event["error"]
                            .as_str()
                            .is_some_and(|error| error != "success");
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
        session.request = session.request.saturating_add(1).max(1);
        if verb == "loadfile" {
            session.load_request = Some(session.request);
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
                session.request,
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
        if source.is_empty() || source.len() > 32_768 || source.contains('\0') {
            return Err(failure("The authorized media source is invalid."));
        }
        let commands = contract::start_commands(&options).map_err(failure)?;
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
            request: 0,
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
            let _ = self.stop(Some(id.clone())).await;
            self.0.session.lock().await.take();
            return Err(error);
        }
        Ok(json!({"ok":true,"sessionId":id,"surface":"composited-window"}))
    }

    pub async fn command(&self, id: String, value: Value) -> Result<Value> {
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
        let matches = self
            .0
            .session
            .lock()
            .await
            .as_ref()
            .is_some_and(|session| id.as_ref().is_none_or(|id| id == &session.id));
        if !matches {
            return Ok(json!(false));
        }
        let result = self.send(json!(["stop"])).await;
        let session = self.0.session.lock().await.take();
        if let Some(session) = session {
            (self.0.emit)(json!({"sessionId":session.id,"status":"closed"}));
        }
        result.map(|_| json!(true))
    }

    pub async fn shutdown(&self) {
        let _ = self.stop(None).await;
        self.0.available.store(false, Ordering::Release);
        if let Some(native) = self.0.native.lock().await.take() {
            unsafe { (native.destroy)(native.engine as *mut c_void) };
        }
    }
}
