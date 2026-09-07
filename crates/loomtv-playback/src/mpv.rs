use libloading::Library;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::PathBuf,
    sync::{mpsc, Arc},
    time::Duration,
};
use tokio::sync::oneshot;

type MpvHandle = *mut c_void;
type Reply = oneshot::Sender<Result<Value, String>>;

enum Request {
    Start {
        source: String,
        options: Value,
        drawable: usize,
        reply: Reply,
    },
    Command {
        session: String,
        command: Value,
        reply: Reply,
    },
    Stop {
        session: Option<String>,
        reply: Reply,
    },
    Shutdown {
        reply: Reply,
    },
}

/// A small, dynamically loaded libmpv service.
///
/// The library is deliberately owned by the playback worker. This keeps the
/// native handle, callbacks, and library lifetime on one thread and lets the
/// Tauri side report libmpv as unavailable when its runtime was not packaged.
pub struct MpvPlaybackService {
    sender: mpsc::SyncSender<Request>,
}

impl MpvPlaybackService {
    pub fn new(
        path: Option<PathBuf>,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel(32);
        std::thread::Builder::new()
            .name("loomtv-libmpv".into())
            .spawn(move || {
                let mut player: Option<MpvPlayer> = None;
                loop {
                    match receiver.recv_timeout(Duration::from_millis(16)) {
                        Ok(Request::Start {
                            source,
                            options,
                            drawable,
                            reply,
                        }) => {
                            let result = (|| {
                                if let Some(mut previous) = player.take() {
                                    let session = previous.session.clone();
                                    previous.close();
                                    emit(json!({
                                        "sessionId": session,
                                        "status": "closed"
                                    }));
                                }
                                let path = path
                                    .as_ref()
                                    .ok_or("The packaged libmpv runtime is missing.")?;
                                let next =
                                    unsafe { MpvPlayer::open(path, source, options, drawable) }?;
                                let response = json!({
                                    "ok": true,
                                    "sessionId": next.session,
                                    "surface": "composited-window"
                                });
                                player = Some(next);
                                Ok(response)
                            })();
                            let _ = reply.send(result);
                        }
                        Ok(Request::Command {
                            session,
                            command,
                            reply,
                        }) => {
                            let result = match player.as_mut() {
                                Some(player) if player.session == session => unsafe {
                                    player.command(command)
                                },
                                _ => Err("This playback session is no longer active.".into()),
                            };
                            let _ = reply.send(result);
                        }
                        Ok(Request::Stop { session, reply }) => {
                            let matching = player.as_ref().is_some_and(|p| {
                                session
                                    .as_ref()
                                    .is_none_or(|candidate| candidate == &p.session)
                            });
                            if matching {
                                if let Some(mut previous) = player.take() {
                                    let session = previous.session.clone();
                                    previous.close();
                                    emit(json!({
                                        "sessionId": session,
                                        "status": "closed"
                                    }));
                                }
                            }
                            let _ = reply.send(Ok(json!(matching)));
                        }
                        Ok(Request::Shutdown { reply }) => {
                            if let Some(mut previous) = player.take() {
                                previous.close();
                            }
                            let _ = reply.send(Ok(json!(true)));
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }

                    if let Some(player) = player.as_mut() {
                        if let Err(error) = unsafe { player.poll_events() } {
                            player.status = "error";
                            emit(json!({
                                "sessionId": player.session,
                                "status": "error",
                                "error": error
                            }));
                        }
                        match unsafe { player.snapshot() } {
                            Ok(value) => emit(value),
                            Err(error) => emit(json!({
                                "sessionId": player.session,
                                "status": "error",
                                "error": error
                            })),
                        }
                    }
                }
            })
            .map_err(|_| "The libmpv playback worker could not start.")?;
        Ok(Self { sender })
    }

    async fn send(&self, build: impl FnOnce(Reply) -> Request) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(build(tx))
            .map_err(|_| "The playback command queue is busy or closed.")?;
        rx.await.map_err(|_| "The playback worker stopped.")?
    }

    pub async fn start(
        &self,
        source: String,
        options: Value,
        drawable: usize,
    ) -> Result<Value, String> {
        self.send(|reply| Request::Start {
            source,
            options,
            drawable,
            reply,
        })
        .await
    }

    pub async fn command(&self, session: String, command: Value) -> Result<Value, String> {
        self.send(|reply| Request::Command {
            session,
            command,
            reply,
        })
        .await
    }

    pub async fn stop(&self, session: Option<String>) -> Result<Value, String> {
        self.send(|reply| Request::Stop { session, reply }).await
    }

    pub async fn shutdown(&self) -> Result<Value, String> {
        self.send(|reply| Request::Shutdown { reply }).await
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MpvNode {
    value: MpvNodeValue,
    format: c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
union MpvNodeValue {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double_: f64,
    list: *mut MpvNodeList,
    byte_array: *mut MpvByteArray,
}

#[repr(C)]
struct MpvNodeList {
    num: c_int,
    values: *mut MpvNode,
    keys: *mut *mut c_char,
}

#[repr(C)]
struct MpvByteArray {
    data: *mut c_void,
    size: usize,
}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

const MPV_FORMAT_STRING: c_int = 1;
const MPV_FORMAT_FLAG: c_int = 3;
const MPV_FORMAT_INT64: c_int = 4;
const MPV_FORMAT_DOUBLE: c_int = 5;
const MPV_FORMAT_NODE: c_int = 6;
const MPV_FORMAT_NODE_ARRAY: c_int = 7;
const MPV_FORMAT_NODE_MAP: c_int = 8;

const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_START_FILE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;

macro_rules! mpv {
    ($owner:expr, $name:literal, $ty:ty $(, $arg:expr)*) => {{
        let function = $owner
            .library
            .get::<$ty>(concat!($name, "\0").as_bytes())
            .map_err(|_| concat!("Missing libmpv API: ", $name).to_string())?;
        function($($arg),*)
    }};
}

struct MpvPlayer {
    library: Library,
    handle: MpvHandle,
    session: String,
    status: &'static str,
    initial_seek: Option<f64>,
    volume: f64,
    muted: bool,
    speed: f64,
    native_subtitles: bool,
    subtitle_files: Vec<String>,
    tracks: Value,
    poll_count: u32,
    stopping: bool,
}

impl MpvPlayer {
    unsafe fn open(
        path: &std::path::Path,
        source: String,
        options: Value,
        drawable: usize,
    ) -> Result<Self, String> {
        if drawable == 0 {
            return Err("The native video view is unavailable.".into());
        }
        if !cfg!(any(target_os = "macos", windows)) {
            return Err("Native libmpv embedding is not implemented on this platform.".into());
        }

        let library =
            Library::new(path).map_err(|_| "The approved libmpv runtime could not be loaded.")?;
        let create = library
            .get::<unsafe extern "C" fn() -> MpvHandle>(b"mpv_create\0")
            .map_err(|_| "The libmpv create API is unavailable.")?;
        let handle = create();
        if handle.is_null() {
            return Err("libmpv could not create a player.".into());
        }
        let subtitle_files = options["subtitleFiles"]
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .map(|file| {
                        file["path"]
                            .as_str()
                            .ok_or("The subtitle path is missing.")
                            .map(ToOwned::to_owned)
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        if subtitle_files.len() > 32 {
            return Err("Too many external subtitle files.".into());
        }
        let result = Self {
            library,
            handle,
            session: uuid::Uuid::new_v4().to_string(),
            status: "starting",
            initial_seek: options["startSeconds"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.),
            volume: options["volume"].as_f64().unwrap_or(1.).clamp(0., 1.),
            muted: options["muted"].as_bool().unwrap_or(false),
            speed: options["speed"].as_f64().unwrap_or(1.).clamp(0.25, 3.),
            native_subtitles: options["nativeSubtitles"].as_bool().unwrap_or(true),
            subtitle_files,
            tracks: json!([]),
            poll_count: 0,
            stopping: false,
        };

        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("load-scripts", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("input-cursor", "no"),
            ("focus-on-open", "no"),
            ("keep-open", "no"),
            ("idle", "no"),
            ("hwdec", "auto-safe"),
        ] {
            let name = CString::new(name).map_err(|_| "Invalid libmpv option name.")?;
            let value = CString::new(value).map_err(|_| "Invalid libmpv option value.")?;
            let code = mpv!(
                result,
                "mpv_set_option_string",
                unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int,
                result.handle,
                name.as_ptr(),
                value.as_ptr()
            );
            if code < 0 {
                return Err(result.error_message(code));
            }
        }

        let wid_name = CString::new("wid").unwrap();
        let mut wid = drawable as i64;
        let code = mpv!(
            result,
            "mpv_set_option",
            unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
            result.handle,
            wid_name.as_ptr(),
            MPV_FORMAT_INT64,
            (&mut wid as *mut i64).cast::<c_void>()
        );
        if code < 0 {
            return Err(result.error_message(code));
        }

        let code = mpv!(
            result,
            "mpv_initialize",
            unsafe extern "C" fn(MpvHandle) -> c_int,
            result.handle
        );
        if code < 0 {
            return Err(result.error_message(code));
        }

        result.set_property("volume", &(result.volume * 100.).to_string())?;
        result.set_property("mute", if result.muted { "yes" } else { "no" })?;
        result.set_property("speed", &result.speed.to_string())?;
        if let Some(value) = options["audioDelay"]
            .as_f64()
            .filter(|value| value.is_finite())
        {
            result.set_property("audio-delay", &value.to_string())?;
        }
        if let Some(value) = options["subtitleDelay"]
            .as_f64()
            .filter(|value| value.is_finite())
        {
            result.set_property("sub-delay", &value.to_string())?;
        }
        if let Some(language) = options["audioLanguage"].as_str() {
            if language.len() > 64
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                return Err("The audio language is invalid.".into());
            }
            result.set_property("alang", language)?;
        } else if let Some(track) = options["audioTrackId"].as_i64() {
            if !(0..=i64::from(i32::MAX)).contains(&track) {
                return Err("The audio track is invalid.".into());
            }
            result.set_property("aid", &track.to_string())?;
        }
        if let Some(style) = options["subtitleStyle"].as_object() {
            if let Some(value) = style.get("fontSize").and_then(Value::as_f64) {
                result.set_property("sub-font-size", &value.to_string())?;
            }
            for (key, property) in [
                ("color", "sub-color"),
                ("borderColor", "sub-border-color"),
                ("backgroundColor", "sub-back-color"),
            ] {
                if let Some(value) = style.get(key).and_then(Value::as_str) {
                    result.set_property(property, value)?;
                }
            }
            if let Some(value) = style.get("borderWidth").and_then(Value::as_f64) {
                result.set_property("sub-border-size", &value.to_string())?;
            }
            if let Some(value) = style.get("position").and_then(Value::as_f64) {
                result.set_property("sub-pos", &value.to_string())?;
            }
        }

        let source =
            CString::new(source).map_err(|_| "The source contains an invalid character.")?;
        result.command_strings(&["loadfile", source.to_string_lossy().as_ref(), "replace"])?;
        if !result.native_subtitles {
            result.set_property("sid", "no")?;
        }
        Ok(result)
    }

    unsafe fn error_message(&self, code: c_int) -> String {
        let fallback = format!("libmpv returned error {code}.");
        let Ok(function) = self
            .library
            .get::<unsafe extern "C" fn(c_int) -> *const c_char>(b"mpv_error_string\0")
        else {
            return fallback;
        };
        let value = function(code);
        if value.is_null() {
            fallback
        } else {
            CStr::from_ptr(value).to_string_lossy().into_owned()
        }
    }

    unsafe fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|_| "Invalid libmpv property name.")?;
        let value = CString::new(value).map_err(|_| "Invalid libmpv property value.")?;
        let code = mpv!(
            self,
            "mpv_set_property_string",
            unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int,
            self.handle,
            name.as_ptr(),
            value.as_ptr()
        );
        if code < 0 {
            return Err(self.error_message(code));
        }
        Ok(())
    }

    unsafe fn command_strings(&self, values: &[&str]) -> Result<(), String> {
        let values = values
            .iter()
            .map(|value| CString::new(*value).map_err(|_| "The libmpv command is invalid."))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers = values
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        pointers.push(std::ptr::null());
        let code = mpv!(
            self,
            "mpv_command",
            unsafe extern "C" fn(MpvHandle, *const *const c_char) -> c_int,
            self.handle,
            pointers.as_ptr()
        );
        if code < 0 {
            return Err(self.error_message(code));
        }
        Ok(())
    }

    unsafe fn command(&mut self, command: Value) -> Result<Value, String> {
        let number = |key: &str| {
            command[key]
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("Invalid {key}."))
        };
        let command_type = command["type"]
            .as_str()
            .ok_or("The player command type is missing.")?;
        match command_type {
            "set-paused" => self.set_property(
                "pause",
                if command["paused"].as_bool().ok_or("Invalid pause state.")? {
                    "yes"
                } else {
                    "no"
                },
            )?,
            "seek" => self.command_strings(&[
                "seek",
                &number("position")?.max(0.).to_string(),
                "absolute+exact",
            ])?,
            "set-volume" => {
                self.volume = number("volume")?.clamp(0., 1.);
                self.set_property("volume", &(self.volume * 100.).to_string())?;
            }
            "set-muted" => {
                self.muted = command["muted"].as_bool().ok_or("Invalid mute state.")?;
                self.set_property("mute", if self.muted { "yes" } else { "no" })?;
            }
            "set-speed" => {
                self.speed = number("speed")?.clamp(0.25, 3.);
                self.set_property("speed", &self.speed.to_string())?;
            }
            "set-video-track" => self.set_track("vid", &command)?,
            "set-audio-track" => self.set_track("aid", &command)?,
            "set-subtitle-track" => self.set_track("sid", &command)?,
            "set-secondary-subtitle-track" => self.set_track("secondary-sid", &command)?,
            "set-subtitle-delay" => {
                self.set_property("sub-delay", &number("seconds")?.to_string())?
            }
            "set-audio-delay" => {
                self.set_property("audio-delay", &number("seconds")?.to_string())?
            }
            "set-subtitle-style" => {
                for (key, property) in [
                    ("fontSize", "sub-font-size"),
                    ("borderWidth", "sub-border-size"),
                    ("position", "sub-pos"),
                ] {
                    if let Some(value) = command[key].as_f64().filter(|value| value.is_finite()) {
                        self.set_property(property, &value.to_string())?;
                    }
                }
                for (key, property) in [
                    ("color", "sub-color"),
                    ("borderColor", "sub-border-color"),
                    ("backgroundColor", "sub-back-color"),
                ] {
                    if let Some(value) = command[key].as_str() {
                        self.set_property(property, value)?;
                    }
                }
            }
            "set-video-aspect" => self.set_property(
                "video-aspect-override",
                command["aspect"].as_str().unwrap_or("-1"),
            )?,
            "set-video-crop" => {
                self.set_property("video-crop", command["crop"].as_str().unwrap_or("no"))?
            }
            "set-video-rotation" => {
                self.set_property("video-rotate", &number("degrees")?.to_string())?
            }
            _ => return Ok(json!(false)),
        }
        Ok(json!(true))
    }

    unsafe fn set_track(&self, property: &str, command: &Value) -> Result<(), String> {
        let value = match command.get("trackId") {
            Some(Value::Null) => "no".to_owned(),
            Some(value) => value
                .as_i64()
                .filter(|id| *id >= 0 && *id <= i64::from(i32::MAX))
                .ok_or("Invalid track ID.")?
                .to_string(),
            None => return Err("The track ID is missing.".into()),
        };
        self.set_property(property, &value)
    }

    unsafe fn poll_events(&mut self) -> Result<(), String> {
        let event = mpv!(
            self,
            "mpv_wait_event",
            unsafe extern "C" fn(MpvHandle, f64) -> *mut MpvEvent,
            self.handle,
            0.
        );
        if event.is_null() {
            return Ok(());
        }
        match (*event).event_id {
            MPV_EVENT_START_FILE => self.status = "loading",
            MPV_EVENT_FILE_LOADED => {
                self.status = "ready";
                for path in self.subtitle_files.clone() {
                    self.command_strings(&["sub-add", path.as_str(), "auto"])?;
                }
                if let Some(position) = self.initial_seek.take() {
                    self.command_strings(&[
                        "seek",
                        &position.max(0.).to_string(),
                        "absolute+exact",
                    ])?;
                }
            }
            MPV_EVENT_END_FILE => {
                self.status = if self.stopping { "closed" } else { "ended" };
            }
            MPV_EVENT_SHUTDOWN => self.status = "closed",
            _ => {}
        }
        Ok(())
    }

    unsafe fn property_string(&self, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let function = self
            .library
            .get::<unsafe extern "C" fn(MpvHandle, *const c_char) -> *mut c_char>(
                b"mpv_get_property_string\0",
            )
            .ok()?;
        let free = self
            .library
            .get::<unsafe extern "C" fn(*mut c_void)>(b"mpv_free\0")
            .ok()?;
        let value = function(self.handle, name.as_ptr());
        if value.is_null() {
            return None;
        }
        let result = CStr::from_ptr(value).to_string_lossy().into_owned();
        free(value.cast::<c_void>());
        Some(result)
    }

    unsafe fn snapshot(&mut self) -> Result<Value, String> {
        self.poll_count = self.poll_count.wrapping_add(1);
        if self.poll_count % 10 == 1 {
            self.tracks = self.tracks()?;
        }
        let position = self
            .property_string("time-pos")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .unwrap_or(0.);
        let duration = self
            .property_string("duration")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.);
        let paused = self
            .property_string("pause")
            .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"));
        let volume = self
            .property_string("volume")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| (value / 100.).clamp(0., 1.));
        let muted = self
            .property_string("mute")
            .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"));
        let speed = self
            .property_string("speed")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite());
        let hardware_decoder = self.property_string("hwdec-current");
        let mut snapshot = json!({
            "sessionId": self.session,
            "status": self.status,
            "position": position,
            "paused": paused,
            "volume": volume.unwrap_or(self.volume),
            "muted": muted,
            "speed": speed.unwrap_or(self.speed),
            "tracks": self.tracks.clone(),
        });
        if let Some(duration) = duration {
            snapshot["duration"] = json!(duration);
        }
        if let Some(hardware_decoder) = hardware_decoder {
            let hardware_decode = hardware_decoder != "no";
            snapshot["diagnostics"] = json!({
                "hardwareDecoder": hardware_decoder,
                "hardwareDecode": hardware_decode
            });
        }
        Ok(snapshot)
    }

    unsafe fn tracks(&self) -> Result<Value, String> {
        let name = CString::new("track-list").unwrap();
        let mut node: MpvNode = std::mem::zeroed();
        let code = mpv!(
            self,
            "mpv_get_property",
            unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
            self.handle,
            name.as_ptr(),
            MPV_FORMAT_NODE,
            (&mut node as *mut MpvNode).cast::<c_void>()
        );
        if code < 0 || node.format != MPV_FORMAT_NODE_ARRAY {
            return Ok(json!([]));
        }
        let mut tracks = Vec::new();
        let list = node.value.list;
        if !list.is_null() && (*list).num >= 0 && !(*list).values.is_null() {
            let values = std::slice::from_raw_parts((*list).values, (*list).num as usize);
            for value in values {
                let Some(kind) = node_map_string(value, "type") else {
                    continue;
                };
                if !matches!(kind.as_str(), "video" | "audio" | "sub") {
                    continue;
                }
                let track_type = if kind == "sub" {
                    "subtitle"
                } else {
                    kind.as_str()
                };
                let id = node_map_i64(value, "id").unwrap_or(-1);
                if id < 0 {
                    continue;
                }
                let external = node_map_bool(value, "external").unwrap_or(false);
                let mut track = json!({
                    "id": id,
                    "streamIndex": node_map_i64(value, "ff-index"),
                    "type": track_type,
                    "title": node_map_string(value, "title").unwrap_or_default(),
                    "language": node_map_string(value, "lang"),
                    "codec": node_map_string(value, "codec"),
                    "default": node_map_bool(value, "default").unwrap_or(false),
                    "forced": node_map_bool(value, "forced").unwrap_or(false),
                    "selected": node_map_bool(value, "selected").unwrap_or(false),
                    "external": external,
                    "source": if external { "sidecar" } else { "embedded" },
                });
                if track["language"].is_null() {
                    track
                        .as_object_mut()
                        .map(|object| object.remove("language"));
                }
                if track["codec"].is_null() {
                    track.as_object_mut().map(|object| object.remove("codec"));
                }
                if track["streamIndex"].is_null() {
                    track
                        .as_object_mut()
                        .map(|object| object.remove("streamIndex"));
                }
                tracks.push(track);
            }
        }
        if let Ok(free) = self
            .library
            .get::<unsafe extern "C" fn(*mut MpvNode)>(b"mpv_free_node_contents\0")
        {
            free(&mut node);
        }
        Ok(Value::Array(tracks))
    }

    fn close(&mut self) {
        self.stopping = true;
        unsafe {
            if !self.handle.is_null() {
                if let Ok(terminate) = self
                    .library
                    .get::<unsafe extern "C" fn(MpvHandle)>(b"mpv_terminate_destroy\0")
                {
                    terminate(self.handle);
                }
                self.handle = std::ptr::null_mut();
            }
        }
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        self.close();
    }
}

unsafe fn node_map_value<'a>(node: &'a MpvNode, key: &str) -> Option<&'a MpvNode> {
    if node.format != MPV_FORMAT_NODE_MAP || node.value.list.is_null() {
        return None;
    }
    let list = &*node.value.list;
    if list.num <= 0 || list.values.is_null() || list.keys.is_null() {
        return None;
    }
    let values = std::slice::from_raw_parts(list.values, list.num as usize);
    let keys = std::slice::from_raw_parts(list.keys, list.num as usize);
    values.iter().zip(keys).find_map(|(value, pointer)| {
        if pointer.is_null() {
            return None;
        }
        (CStr::from_ptr(*pointer).to_string_lossy() == key).then_some(value)
    })
}

unsafe fn node_map_string(node: &MpvNode, key: &str) -> Option<String> {
    let value = node_map_value(node, key)?;
    if value.format != MPV_FORMAT_STRING || value.value.string.is_null() {
        return None;
    }
    Some(
        CStr::from_ptr(value.value.string)
            .to_string_lossy()
            .into_owned(),
    )
}

unsafe fn node_map_i64(node: &MpvNode, key: &str) -> Option<i64> {
    let value = node_map_value(node, key)?;
    match value.format {
        MPV_FORMAT_INT64 => Some(value.value.int64),
        MPV_FORMAT_DOUBLE => Some(value.value.double_ as i64),
        _ => None,
    }
}

unsafe fn node_map_bool(node: &MpvNode, key: &str) -> Option<bool> {
    let value = node_map_value(node, key)?;
    match value.format {
        MPV_FORMAT_FLAG => Some(value.value.flag != 0),
        MPV_FORMAT_INT64 => Some(value.value.int64 != 0),
        _ => None,
    }
}
