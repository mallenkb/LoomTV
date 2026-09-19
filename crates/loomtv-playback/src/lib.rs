pub mod mpv;
mod snapshot_delivery;

use snapshot_delivery::SnapshotDelivery;

use libloading::Library;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::PathBuf,
    rc::Rc,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<Value, String>>;
enum Request {
    Availability {
        reply: Reply,
    },
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

pub struct PlaybackService {
    sender: mpsc::SyncSender<Request>,
}
impl PlaybackService {
    pub fn new(
        path: Option<PathBuf>,
        plugins: Option<PathBuf>,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel(32);
        std::thread::Builder::new().name("loomtv-libvlc".into()).spawn(move || {
            // Native pointers and the loaded library never leave this owner thread.
            let runtime = path.as_deref().ok_or_else(|| "The packaged LibVLC runtime is missing.".to_string())
                .and_then(|path| unsafe { WarmRuntime::open(path, plugins.as_deref()).map(Rc::new) });
            let mut player:Option<Player>=None;
            let mut delivery = SnapshotDelivery::default();
            loop {
                // Native subtitle overlays follow the playback timestamp
                // emitted after each snapshot. Keep this cadence close to a
                // video frame so cues do not visibly trail the picture.
                let request = match player.as_ref().and_then(|_| delivery.poll_interval()) {
                    Some(interval) => receiver.recv_timeout(interval),
                    None => receiver.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                };
                match request {
                    Ok(Request::Availability { reply }) => {
                        let warning = runtime.as_ref().err();
                        let _ = reply.send(Ok(json!({"available":runtime.is_ok(),"enabled":true,"surface":if runtime.is_ok(){"composited-window"}else{"unavailable"},"libraryPath":path,"runtimeSource":"bundled","warning":warning})));
                    }
                    Ok(Request::Start{source,options,drawable,reply}) => {
                        delivery = SnapshotDelivery::default();
                        let result=(|| {
                            if let Some(mut previous)=player.take() { previous.close(); emit(json!({"sessionId":previous.session,"status":"closed"})); }
                            let runtime = runtime.as_ref().map_err(Clone::clone)?;
                            let mut next=unsafe {Player::open(Rc::clone(runtime),source,options,drawable)}?;
                            unsafe { next.verify_start()?; }
                            let response=json!({"ok":true,"sessionId":next.session,"surface":"composited-window"});
                            player=Some(next);Ok(response)
                        })();
                        let _=reply.send(result);
                    }
                    Ok(Request::Command{session,command,reply}) => {
                        let result=match player.as_mut() {
                            Some(player) if player.session==session=>unsafe{player.command(command)},
                            _=>Err("This playback session is no longer active.".into()),
                        };
                        if result.is_ok() { delivery.acknowledge_command(); }
                        let _=reply.send(result);
                    }
                    Ok(Request::Stop{session,reply}) => {
                        let matching=player.as_ref().is_some_and(|p|session.as_ref().is_none_or(|s|s==&p.session));
                        if matching {delivery = SnapshotDelivery::default();if let Some(mut previous)=player.take(){previous.close();emit(json!({"sessionId":previous.session,"status":"closed"}));}}
                        let _=reply.send(Ok(json!(matching)));
                    }
                    Ok(Request::Shutdown{reply}) => {
                        if let Some(mut previous)=player.take(){previous.close();}
                        let _=reply.send(Ok(json!(true)));break;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected)=>break,
                    Err(mpsc::RecvTimeoutError::Timeout)=>{},
                }
                if let Some(player)=player.as_mut() {
                    match unsafe {player.snapshot()} {
                        Ok(value)=>{ if let Some(changed) = delivery.changed(value) { emit(changed); } },
                        Err(error)=>{ if let Some(changed) = delivery.changed(json!({"sessionId":player.session,"status":"error","error":error})) { emit(changed); } },
                    }
                }
            }
        }).map_err(|_|"The playback worker could not start.")?;
        Ok(Self { sender })
    }
    async fn send(&self, build: impl FnOnce(Reply) -> Request) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(build(tx))
            .map_err(|_| "The playback command queue is busy or closed.")?;
        rx.await.map_err(|_| "The playback worker stopped.")?
    }
    pub async fn availability(&self) -> Result<Value, String> {
        self.send(|reply| Request::Availability { reply }).await
    }
    /// The drawable comes only from the native window host. Its owner must keep it alive through stop.
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
struct TrackDescription {
    id: c_int,
    name: *mut c_char,
    next: *mut TrackDescription,
}

#[repr(C)]
#[derive(Default)]
struct MediaStats {
    read_bytes: c_int,
    input_bitrate: f32,
    demux_bytes: c_int,
    demux_bitrate: f32,
    corrupt: c_int,
    discontinuities: c_int,
    decoded_video: c_int,
    decoded_audio: c_int,
    displayed: c_int,
    lost: c_int,
    played_audio: c_int,
    lost_audio: c_int,
    sent_packets: c_int,
    sent_bytes: c_int,
    sent_bitrate: f32,
}

// Initialized on the owner worker at app startup. Sessions share plugin discovery
// and the LibVLC instance, but keep their media/player handles independent.
struct WarmRuntime {
    library: Library,
    _core_library: Option<Library>,
    instance: *mut c_void,
    path: PathBuf,
    plugins: Option<PathBuf>,
}
impl WarmRuntime {
    unsafe fn open(
        path: &std::path::Path,
        plugins: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        // The VLC app normally loads this dependency before libvlc. Tauri has
        // no VLC executable rpath, so retain the sibling core for the process lifetime.
        let core_name = if cfg!(windows) {
            "libvlccore.dll"
        } else if cfg!(target_os = "linux") {
            "libvlccore.so.9"
        } else {
            "libvlccore.dylib"
        };
        let core_path = path.with_file_name(core_name);
        let core_library = if core_path.is_file() {
            Some(
                Library::new(&core_path)
                    .map_err(|error| format!("LibVLC core could not be loaded: {error}"))?,
            )
        } else {
            None
        };
        let library =
            Library::new(path).map_err(|error| format!("LibVLC could not be loaded: {error}"))?;
        let version = library
            .get::<unsafe extern "C" fn() -> *const c_char>(b"libvlc_get_version\0")
            .map_err(|_| "The LibVLC version API is unavailable.")?();
        if version.is_null() || !CStr::from_ptr(version).to_bytes().starts_with(b"3.") {
            return Err("This adapter requires the bundled LibVLC 3 ABI.".into());
        }
        let instance = Self::create_instance(&library, plugins, false)?;
        Ok(Self {
            library,
            _core_library: core_library,
            instance,
            path: path.to_path_buf(),
            plugins: plugins.map(PathBuf::from),
        })
    }

    unsafe fn create_instance(
        library: &Library,
        plugins: Option<&std::path::Path>,
        observe_decoder: bool,
    ) -> Result<*mut c_void, String> {
        let mut arguments = vec!["--no-plugins-cache"];
        if observe_decoder {
            arguments.extend(["--quiet", "--verbose=2"]);
        } else if std::env::var("LOOMTV_DEBUG_LIBVLC").as_deref() == Ok("1") {
            arguments.extend(["--no-quiet", "--verbose=2"]);
        } else {
            arguments.push("--quiet");
        }
        let arguments = arguments
            .iter()
            .map(|s| CString::new(*s))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Invalid LibVLC arguments.")?;
        let pointers = arguments.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
        let new = library
            .get::<unsafe extern "C" fn(c_int, *const *const c_char) -> *mut c_void>(
                b"libvlc_new\0",
            )
            .map_err(|_| "The LibVLC instance API is unavailable.")?;
        let previous_plugin_path = plugins.map(|plugins| {
            let previous = std::env::var_os("VLC_PLUGIN_PATH");
            std::env::set_var("VLC_PLUGIN_PATH", plugins);
            previous
        });
        let instance = new(pointers.len() as c_int, pointers.as_ptr());
        if let Some(previous) = previous_plugin_path {
            if let Some(previous) = previous {
                std::env::set_var("VLC_PLUGIN_PATH", previous);
            } else {
                std::env::remove_var("VLC_PLUGIN_PATH");
            }
        }
        if instance.is_null() {
            return Err("LibVLC initialization failed.".into());
        }
        Ok(instance)
    }
}
impl Drop for WarmRuntime {
    fn drop(&mut self) {
        unsafe {
            if let Ok(release) = self
                .library
                .get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_release\0")
            {
                release(self.instance);
            }
        }
    }
}
struct Player {
    runtime: Rc<WarmRuntime>,
    instance: *mut c_void,
    owns_instance: bool,
    decoder_probe: *mut c_void,
    decode_mode: DecodeMode,
    initially_paused: bool,
    media: *mut c_void,
    player: *mut c_void,
    session: String,
    initial_seek: Option<i64>,
    volume: i32,
    muted: bool,
    speed: f64,
    tracks: Value,
    last_track_refresh: Option<Instant>,
    restore_pending: bool,
    restore_commands: std::collections::BTreeMap<String, Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DecodeMode { Hardware, Software }

impl std::ops::Deref for Player {
    type Target = WarmRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

macro_rules! vlc {
    ($owner:expr,$name:literal,$ty:ty $(,$arg:expr)*)=>{{
        let function=$owner.library.get::<$ty>(concat!($name,"\0").as_bytes()).map_err(|_|concat!("Missing LibVLC 3 API: ",$name).to_string())?;
        function($($arg),*)
    }};
}
impl Player {
    unsafe fn verify_start(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut first_unproven_video = None;
        while Instant::now() < deadline {
            let state = vlc!(self,"libvlc_media_player_get_state",unsafe extern "C" fn(*mut c_void)->c_int,self.player);
            if state == 7 { return Err("LibVLC reported a playback error before video became ready.".into()); }
            let mut stats = MediaStats::default();
            let frames = if let Ok(get_stats) = self.library.get::<unsafe extern "C" fn(*mut c_void,*mut MediaStats)->c_int>(b"libvlc_media_get_stats\0") {
                if get_stats(self.media, &mut stats) != 0 { stats.decoded_video } else { 0 }
            } else { 0 };
            let ready = state == 3 || state == 4;
            let hardware = self.decode_mode == DecodeMode::Hardware
                && loomtv_vlc_probe::loom_vlc_probe_hardware(self.decoder_probe) == 1;
            let moving = vlc!(self,"libvlc_media_player_get_time",unsafe extern "C" fn(*mut c_void)->i64,self.player) > 0;
            let video_tracks = self.library
                .get::<unsafe extern "C" fn(*mut c_void)->c_int>(b"libvlc_video_get_track_count\0")
                .map(|count| count(self.player)).unwrap_or(-1);
            if self.decode_mode == DecodeMode::Hardware && ready && frames > 0 && !hardware {
                let first = first_unproven_video.get_or_insert_with(Instant::now);
                if first.elapsed() >= Duration::from_millis(250) {
                    return Err("LibVLC decoded video without proving hardware decoding.".into());
                }
            }
            if ready && match self.decode_mode {
                DecodeMode::Hardware => hardware && frames > 0,
                DecodeMode::Software => frames > 0 || (video_tracks == 0 && moving),
            } {
                vlc!(self,"libvlc_audio_set_volume",unsafe extern "C" fn(*mut c_void,c_int)->c_int,self.player,self.volume);
                vlc!(self,"libvlc_audio_set_mute",unsafe extern "C" fn(*mut c_void,c_int),self.player,self.muted as c_int);
                if self.initially_paused {
                    vlc!(self,"libvlc_media_player_set_pause",unsafe extern "C" fn(*mut c_void,c_int),self.player,1);
                }
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(match self.decode_mode {
            DecodeMode::Hardware => "LibVLC did not prove hardware video decoding before the startup deadline.",
            DecodeMode::Software => "LibVLC did not decode the first video frame before the startup deadline.",
        }.into())
    }
    unsafe fn open(
        runtime: Rc<WarmRuntime>,
        source: String,
        options: Value,
        drawable: usize,
    ) -> Result<Self, String> {
        if drawable == 0 {
            return Err("The native video view is unavailable.".into());
        }
        let decode_mode = match options["decodeMode"].as_str().unwrap_or("hardware") {
            "hardware" => DecodeMode::Hardware,
            "software" => DecodeMode::Software,
            _ => return Err("The decoder mode is invalid.".into()),
        };
        let owns_instance = decode_mode == DecodeMode::Hardware;
        let instance = if owns_instance {
            WarmRuntime::create_instance(&runtime.library, runtime.plugins.as_deref(), true)?
        } else { runtime.instance };
        let mut result = Self {
            runtime,
            instance,
            owns_instance,
            decoder_probe: std::ptr::null_mut(),
            decode_mode,
            initially_paused: options["paused"].as_bool().unwrap_or(false),
            media: std::ptr::null_mut(),
            player: std::ptr::null_mut(),
            session: uuid::Uuid::new_v4().to_string(),
            initial_seek: options["startSeconds"]
                .as_f64()
                .filter(|s| s.is_finite() && *s > 0.)
                .map(|s| (s * 1000.) as i64),
            volume: (options["volume"].as_f64().unwrap_or(1.).clamp(0., 1.) * 100.).round() as i32,
            muted: options["muted"].as_bool().unwrap_or(false),
            speed: options["speed"].as_f64().unwrap_or(1.).clamp(0.25, 3.),
            tracks: json!([]),
            last_track_refresh: None,
            restore_pending: false,
            restore_commands: std::collections::BTreeMap::new(),
        };
        if decode_mode == DecodeMode::Hardware {
            let path = CString::new(result.runtime.path.to_string_lossy().as_bytes())
                .map_err(|_| "The LibVLC path is invalid.")?;
            result.decoder_probe = loomtv_vlc_probe::loom_vlc_probe_attach(path.as_ptr(), instance);
            if result.decoder_probe.is_null() {
                return Err("LibVLC decoder logging could not be attached.".into());
            }
        }
        let network = source.starts_with("http://127.0.0.1:");
        let source =
            CString::new(source).map_err(|_| "The source contains an invalid character.")?;
        result.media = if network {
            vlc!(
                result,
                "libvlc_media_new_location",
                unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
                instance,
                source.as_ptr()
            )
        } else {
            vlc!(
                result,
                "libvlc_media_new_path",
                unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
                instance,
                source.as_ptr()
            )
        };
        if result.media.is_null() {
            return Err("LibVLC could not open the media source.".into());
        }
        let mut media_options = Vec::new();
        #[cfg(target_os = "macos")]
        media_options.push(":vout=macosx".to_string());
        #[cfg(windows)]
        media_options.push(":vout=direct3d11".to_string());
        #[cfg(target_os = "linux")]
        media_options.push(":vout=xcb_x11".to_string());
        if decode_mode == DecodeMode::Hardware {
            #[cfg(target_os = "macos")]
            // Codec preferences also apply to audio and subtitle decoders.
            // The decoder probe separately verifies hardware video decoding.
            media_options.extend([":codec=videotoolbox,any".into(), ":videotoolbox-hw-decoder-only".into()]);
            #[cfg(not(target_os = "macos"))]
            media_options.push(":avcodec-hw=any".into());
        } else {
            media_options.extend([":avcodec-hw=none".into(), ":codec=avcodec,dav1d,any".into()]);
        }
        if let Some(language) = options["audioLanguage"].as_str() {
            if language.len() > 32
                || !language
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                return Err("The audio language is invalid.".into());
            }
            media_options.push(format!(":audio-language={language}"));
        }
        if let Some(track) = options["audioTrackId"].as_i64() {
            media_options.push(format!(":audio-track={track}"));
        }
        if let Some(files) = options["subtitleFiles"].as_array() {
            if files.len() > 32 {
                return Err("Too many external subtitle files.".into());
            }
            for file in files {
                let path = file["path"]
                    .as_str()
                    .ok_or("The subtitle path is missing.")?;
                media_options.push(format!(":sub-file={path}"));
            }
        }
        if options["nativeSubtitles"] == false {
            media_options.push(":no-spu".into());
        }
        for option in media_options {
            let option = CString::new(option).map_err(|_| "The media option is invalid.")?;
            vlc!(
                result,
                "libvlc_media_add_option",
                unsafe extern "C" fn(*mut c_void, *const c_char),
                result.media,
                option.as_ptr()
            );
        }
        result.player = vlc!(
            result,
            "libvlc_media_player_new_from_media",
            unsafe extern "C" fn(*mut c_void) -> *mut c_void,
            result.media
        );
        if result.player.is_null() {
            return Err("LibVLC could not create a player.".into());
        }
        #[cfg(target_os = "macos")]
        vlc!(
            result,
            "libvlc_media_player_set_nsobject",
            unsafe extern "C" fn(*mut c_void, *mut c_void),
            result.player,
            drawable as *mut c_void
        );
        #[cfg(windows)]
        vlc!(
            result,
            "libvlc_media_player_set_hwnd",
            unsafe extern "C" fn(*mut c_void, *mut c_void),
            result.player,
            drawable as *mut c_void
        );
        #[cfg(target_os = "linux")]
        vlc!(
            result,
            "libvlc_media_player_set_xwindow",
            unsafe extern "C" fn(*mut c_void, u32),
            result.player,
            drawable as u32
        );
        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        return Err("Native LibVLC embedding is not implemented on this platform.".into());
        vlc!(
            result,
            "libvlc_video_set_mouse_input",
            unsafe extern "C" fn(*mut c_void, u32),
            result.player,
            0
        );
        vlc!(
            result,
            "libvlc_video_set_key_input",
            unsafe extern "C" fn(*mut c_void, u32),
            result.player,
            0
        );
        if vlc!(
            result,
            "libvlc_media_player_play",
            unsafe extern "C" fn(*mut c_void) -> c_int,
            result.player
        ) != 0
        {
            return Err("LibVLC could not start playback.".into());
        }
        vlc!(result,"libvlc_audio_set_volume",unsafe extern "C" fn(*mut c_void,c_int)->c_int,result.player,0);
        vlc!(result,"libvlc_audio_set_mute",unsafe extern "C" fn(*mut c_void,c_int),result.player,1);
        result.command(json!({"type":"set-speed","speed":result.speed}))?;
        if let Some(delay) = options["audioDelay"].as_f64() {
            result.command(json!({"type":"set-audio-delay","seconds":delay}))?;
        }
        if let Some(delay) = options["subtitleDelay"].as_f64() {
            result.command(json!({"type":"set-subtitle-delay","seconds":delay}))?;
        }
        Ok(result)
    }
    unsafe fn command(&mut self, command: Value) -> Result<Value, String> {
        let number = |key: &str| {
            command[key]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| format!("Invalid {key}."))
        };
        match command["type"]
            .as_str()
            .ok_or("The player command type is missing.")?
        {
            "set-paused" => {
                let paused = command["paused"].as_bool().ok_or("Invalid pause state.")?;
                if !paused
                    && vlc!(
                        self,
                        "libvlc_media_player_get_state",
                        unsafe extern "C" fn(*mut c_void) -> c_int,
                        self.player
                    ) == 6
                {
                    self.restore_pending = true;
                    vlc!(
                        self,
                        "libvlc_media_player_stop",
                        unsafe extern "C" fn(*mut c_void),
                        self.player
                    );
                    vlc!(
                        self,
                        "libvlc_media_player_play",
                        unsafe extern "C" fn(*mut c_void) -> c_int,
                        self.player
                    );
                }
                vlc!(
                    self,
                    "libvlc_media_player_set_pause",
                    unsafe extern "C" fn(*mut c_void, c_int),
                    self.player,
                    paused as c_int
                );
            }
            "seek" => {
                let time = (number("position")?.max(0.) * 1000.) as i64;
                if vlc!(
                    self,
                    "libvlc_media_player_get_state",
                    unsafe extern "C" fn(*mut c_void) -> c_int,
                    self.player
                ) == 6
                {
                    self.restore_pending = true;
                    vlc!(
                        self,
                        "libvlc_media_player_stop",
                        unsafe extern "C" fn(*mut c_void),
                        self.player
                    );
                    vlc!(
                        self,
                        "libvlc_media_player_play",
                        unsafe extern "C" fn(*mut c_void) -> c_int,
                        self.player
                    );
                    self.initial_seek = Some(time);
                } else {
                    vlc!(
                        self,
                        "libvlc_media_player_set_time",
                        unsafe extern "C" fn(*mut c_void, i64),
                        self.player,
                        time
                    );
                }
            }
            "set-volume" => {
                self.volume = (number("volume")?.clamp(0., 1.) * 100.).round() as i32;
                vlc!(
                    self,
                    "libvlc_audio_set_volume",
                    unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
                    self.player,
                    self.volume
                );
            }
            "set-muted" => {
                self.muted = command["muted"].as_bool().ok_or("Invalid mute state.")?;
                vlc!(
                    self,
                    "libvlc_audio_set_mute",
                    unsafe extern "C" fn(*mut c_void, c_int),
                    self.player,
                    self.muted as c_int
                );
            }
            "set-speed" => {
                self.speed = number("speed")?.clamp(0.25, 3.);
                if vlc!(
                    self,
                    "libvlc_media_player_set_rate",
                    unsafe extern "C" fn(*mut c_void, f32) -> c_int,
                    self.player,
                    self.speed as f32
                ) != 0
                {
                    return Err("This source does not support the requested playback speed.".into());
                }
            }
            "set-audio-delay" => {
                vlc!(
                    self,
                    "libvlc_audio_set_delay",
                    unsafe extern "C" fn(*mut c_void, i64) -> c_int,
                    self.player,
                    (number("seconds")? * 1_000_000.) as i64
                );
            }
            "set-subtitle-delay" => {
                vlc!(
                    self,
                    "libvlc_video_set_spu_delay",
                    unsafe extern "C" fn(*mut c_void, i64) -> c_int,
                    self.player,
                    (number("seconds")? * 1_000_000.) as i64
                );
            }
            "set-audio-track" => {
                let track = match command.get("trackId") {
                    Some(Value::Null) => -1,
                    Some(value) => value
                        .as_i64()
                        .filter(|id| *id >= -1 && *id <= i32::MAX as i64)
                        .ok_or("Invalid track ID.")? as c_int,
                    None => return Err("The track ID is missing.".into()),
                };
                if vlc!(
                    self,
                    "libvlc_audio_set_track",
                    unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
                    self.player,
                    track
                ) < 0
                {
                    return Ok(json!(false));
                }
                self.last_track_refresh = None;
            }
            "set-subtitle-track" => {
                let track = match command.get("trackId") {
                    Some(Value::Null) => -1,
                    Some(value) => value
                        .as_i64()
                        .filter(|id| *id >= -1 && *id <= i32::MAX as i64)
                        .ok_or("Invalid track ID.")? as c_int,
                    None => return Err("The track ID is missing.".into()),
                };
                if vlc!(
                    self,
                    "libvlc_video_set_spu",
                    unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
                    self.player,
                    track
                ) < 0
                {
                    return Ok(json!(false));
                }
                self.last_track_refresh = None;
            }
            "set-video-track" => {
                let track = match command.get("trackId") {
                    Some(Value::Null) => -1,
                    Some(value) => value
                        .as_i64()
                        .filter(|id| *id >= -1 && *id <= i32::MAX as i64)
                        .ok_or("Invalid track ID.")? as c_int,
                    None => return Err("The track ID is missing.".into()),
                };
                if vlc!(
                    self,
                    "libvlc_video_set_track",
                    unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
                    self.player,
                    track
                ) < 0
                {
                    return Ok(json!(false));
                }
                self.last_track_refresh = None;
            }
            "set-video-aspect" => {
                let value = CString::new(command["aspect"].as_str().unwrap_or(""))
                    .map_err(|_| "Invalid aspect ratio.")?;
                vlc!(
                    self,
                    "libvlc_video_set_aspect_ratio",
                    unsafe extern "C" fn(*mut c_void, *const c_char),
                    self.player,
                    value.as_ptr()
                );
            }
            "set-video-crop" => {
                let value = CString::new(command["crop"].as_str().unwrap_or(""))
                    .map_err(|_| "Invalid crop.")?;
                vlc!(
                    self,
                    "libvlc_video_set_crop_geometry",
                    unsafe extern "C" fn(*mut c_void, *const c_char),
                    self.player,
                    value.as_ptr()
                );
            }
            "set-video-rotation" => return Ok(json!(number("degrees")? == 0.)),
            "set-subtitle-style" | "set-secondary-subtitle-track" => return Ok(json!(false)),
            _ => return Ok(json!(false)),
        }
        if let Some(kind) = command["type"].as_str().filter(|kind| *kind != "seek") {
            self.restore_commands.insert(kind.to_owned(), command);
        }
        Ok(json!(true))
    }
    unsafe fn snapshot(&mut self) -> Result<Value, String> {
        let state = vlc!(
            self,
            "libvlc_media_player_get_state",
            unsafe extern "C" fn(*mut c_void) -> c_int,
            self.player
        );
        if (state == 3 || state == 4) && self.initial_seek.is_some() {
            if let Some(time) = self.initial_seek.take() {
                vlc!(
                    self,
                    "libvlc_media_player_set_time",
                    unsafe extern "C" fn(*mut c_void, i64),
                    self.player,
                    time
                );
            }
        }
        if (state == 3 || state == 4) && self.restore_pending {
            self.restore_pending = false;
            let commands = self.restore_commands.values().cloned().collect::<Vec<_>>();
            for command in commands {
                let _ = self.command(command)?;
            }
        }
        let mut tracks_changed = false;
        if self
            .last_track_refresh
            .is_none_or(|last| last.elapsed() >= Duration::from_millis(500))
        {
            let tracks = self.tracks()?;
            tracks_changed = self.last_track_refresh.is_none() || tracks != self.tracks;
            self.tracks = tracks;
            self.last_track_refresh = Some(Instant::now());
        }
        let mut snapshot = json!({"sessionId":self.session,"status":match state{0|1=>"starting",2=>"loading",3|4=>"ready",5=>"closed",6=>"ended",_=>"error"},"paused":state==4,"position":vlc!(self,"libvlc_media_player_get_time",unsafe extern "C" fn(*mut c_void)->i64,self.player).max(0)as f64/1000.,"duration":vlc!(self,"libvlc_media_player_get_length",unsafe extern "C" fn(*mut c_void)->i64,self.player).max(0)as f64/1000.,"volume":self.volume as f64/100.,"muted":self.muted,"speed":self.speed,"diagnostics":{"hardwareDecode":self.decode_mode==DecodeMode::Hardware}});
        if self.decode_mode == DecodeMode::Hardware {
            let mut decoder = [0i8; 64];
            let length = loomtv_vlc_probe::loom_vlc_probe_decoder(self.decoder_probe, decoder.as_mut_ptr(), decoder.len());
            if length > 0 {
                snapshot["diagnostics"]["hardwareDecoder"] = json!(CStr::from_ptr(decoder.as_ptr()).to_string_lossy().into_owned());
            }
        }
        if tracks_changed {
            snapshot["tracks"] = self.tracks.clone();
        }
        Ok(snapshot)
    }
    unsafe fn tracks(&self) -> Result<Value, String> {
        let mut tracks = Vec::new();
        for (kind, symbol) in [
            ("video", b"libvlc_video_get_track_description\0".as_slice()),
            ("audio", b"libvlc_audio_get_track_description\0".as_slice()),
            ("subtitle", b"libvlc_video_get_spu_description\0".as_slice()),
        ] {
            let get = self
                .library
                .get::<unsafe extern "C" fn(*mut c_void) -> *mut TrackDescription>(symbol)
                .map_err(|_| "LibVLC track descriptions are unavailable.")?;
            let selected = if kind == "video" {
                vlc!(
                    self,
                    "libvlc_video_get_track",
                    unsafe extern "C" fn(*mut c_void) -> c_int,
                    self.player
                )
            } else if kind == "audio" {
                vlc!(
                    self,
                    "libvlc_audio_get_track",
                    unsafe extern "C" fn(*mut c_void) -> c_int,
                    self.player
                )
            } else {
                vlc!(
                    self,
                    "libvlc_video_get_spu",
                    unsafe extern "C" fn(*mut c_void) -> c_int,
                    self.player
                )
            };
            let head = get(self.player);
            let mut current = head;
            for _ in 0..1024 {
                let Some(track) = current.as_ref() else {
                    break;
                };
                if track.id >= 0 {
                    tracks.push(json!({"id":track.id,"selected":track.id==selected,"type":kind,"title":if track.name.is_null(){String::new()}else{CStr::from_ptr(track.name).to_string_lossy().into_owned()},"source":"embedded"}));
                }
                current = track.next;
            }
            if !head.is_null() {
                vlc!(
                    self,
                    "libvlc_track_description_list_release",
                    unsafe extern "C" fn(*mut TrackDescription),
                    head
                );
            }
        }
        Ok(json!(tracks))
    }
    fn close(&mut self) {
        // Normal stop and every failure path run on the worker, never on the UI thread.
        unsafe {
            if !self.player.is_null() {
                if let Ok(stop) = self
                    .library
                    .get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_player_stop\0")
                {
                    stop(self.player);
                }
                if let Ok(release) = self
                    .library
                    .get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_player_release\0")
                {
                    release(self.player);
                }
                self.player = std::ptr::null_mut();
            }
            if !self.media.is_null() {
                if let Ok(release) = self
                    .library
                    .get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_release\0")
                {
                    release(self.media);
                }
                self.media = std::ptr::null_mut();
            }
            if !self.decoder_probe.is_null() {
                loomtv_vlc_probe::loom_vlc_probe_detach(self.decoder_probe);
                self.decoder_probe = std::ptr::null_mut();
            }
            if self.owns_instance && !self.instance.is_null() {
                if let Ok(release) = self.library.get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_release\0") {
                    release(self.instance);
                }
                self.instance = std::ptr::null_mut();
            }
        }
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn missing_instance_api_does_not_change_plugin_environment() {
        let library: Library = libloading::os::unix::Library::this().into();
        let before = std::env::var_os("VLC_PLUGIN_PATH");
        let result = unsafe {
            WarmRuntime::create_instance(&library, Some(std::path::Path::new("/unused/plugins")), false)
        };
        assert_eq!(
            result.unwrap_err(),
            "The LibVLC instance API is unavailable."
        );
        assert_eq!(std::env::var_os("VLC_PLUGIN_PATH"), before);
    }

    #[tokio::test]
    async fn failed_start_never_creates_an_active_session() {
        let service = PlaybackService::new(None, None, Arc::new(|_| {})).unwrap();
        assert_eq!(service.availability().await.unwrap()["available"], false);
        assert!(service
            .start("fixture.mkv".into(), json!({}), 1)
            .await
            .is_err());
        assert!(service
            .command("stale".into(), json!({"type":"seek","position":1}))
            .await
            .is_err());
        assert_eq!(service.stop(None).await.unwrap(), false);
        assert_eq!(service.stop(None).await.unwrap(), false);
        assert_eq!(service.shutdown().await.unwrap(), true);
        assert!(service
            .command("stale".into(), json!({"type":"set-paused","paused":false}))
            .await
            .is_err());
    }
}
