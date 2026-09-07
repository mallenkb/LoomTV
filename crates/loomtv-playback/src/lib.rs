pub mod mpv;

use libloading::Library;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::PathBuf,
    sync::{mpsc, Arc},
    time::Duration,
};
use tokio::sync::oneshot;

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
            let mut player:Option<Player>=None;
            loop {
                // Native subtitle overlays follow the playback timestamp
                // emitted after each snapshot. Keep this cadence close to a
                // video frame so cues do not visibly trail the picture.
                match receiver.recv_timeout(Duration::from_millis(16)) {
                    Ok(Request::Start{source,options,drawable,reply}) => {
                        let result=(|| {
                            if let Some(mut previous)=player.take() { previous.close(); emit(json!({"sessionId":previous.session,"status":"closed"})); }
                            let path=path.as_ref().ok_or("The packaged LibVLC runtime is missing.")?;
                            let next=unsafe {Player::open(path,plugins.as_deref(),source,options,drawable)}?;
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
                        let _=reply.send(result);
                    }
                    Ok(Request::Stop{session,reply}) => {
                        let matching=player.as_ref().is_some_and(|p|session.as_ref().is_none_or(|s|s==&p.session));
                        if matching {if let Some(mut previous)=player.take(){previous.close();emit(json!({"sessionId":previous.session,"status":"closed"}));}}
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
                        Ok(value)=>emit(value),
                        Err(error)=>emit(json!({"sessionId":player.session,"status":"error","error":error})),
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

struct Player {
    library: Library,
    instance: *mut c_void,
    media: *mut c_void,
    player: *mut c_void,
    session: String,
    initial_seek: Option<i64>,
    volume: i32,
    muted: bool,
    speed: f64,
    tracks: Value,
    poll_count: u32,
    restore_pending: bool,
    restore_commands: std::collections::BTreeMap<String, Value>,
}

macro_rules! vlc {
    ($owner:expr,$name:literal,$ty:ty $(,$arg:expr)*)=>{{
        let function=$owner.library.get::<$ty>(concat!($name,"\0").as_bytes()).map_err(|_|concat!("Missing LibVLC 3 API: ",$name).to_string())?;
        function($($arg),*)
    }};
}
impl Player {
    unsafe fn open(
        path: &std::path::Path,
        plugins: Option<&std::path::Path>,
        source: String,
        options: Value,
        drawable: usize,
    ) -> Result<Self, String> {
        if drawable == 0 {
            return Err("The native video view is unavailable.".into());
        }
        let library =
            Library::new(path).map_err(|_| "The approved LibVLC runtime could not be loaded.")?;
        let version = library
            .get::<unsafe extern "C" fn() -> *const c_char>(b"libvlc_get_version\0")
            .map_err(|_| "The LibVLC version API is unavailable.")?();
        if version.is_null() || !CStr::from_ptr(version).to_bytes().starts_with(b"3.") {
            return Err("This adapter requires the bundled LibVLC 3 ABI.".into());
        }
        // LibVLC uses its plugin path during initialization. This process owns one engine.
        if let Some(plugins) = plugins {
            std::env::set_var("VLC_PLUGIN_PATH", plugins);
        }
        let arguments = [
            "--no-video-title-show",
            "--no-snapshot-preview",
            "--no-osd",
            "--no-xlib",
            "--no-video-on-top",
            "--avcodec-hw=any",
        ];
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
        let instance = new(pointers.len() as c_int, pointers.as_ptr());
        if instance.is_null() {
            return Err("LibVLC initialization failed.".into());
        }
        let mut result = Self {
            library,
            instance,
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
            poll_count: 0,
            restore_pending: false,
            restore_commands: std::collections::BTreeMap::new(),
        };
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
        if !cfg!(any(target_os = "macos", windows)) {
            return Err("Native LibVLC embedding is not implemented on this platform.".into());
        }
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
        result.command(json!({"type":"set-volume","volume":result.volume as f64/100.}))?;
        result.command(json!({"type":"set-muted","muted":result.muted}))?;
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
                self.poll_count = 0;
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
                self.poll_count = 0;
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
                self.poll_count = 0;
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
        self.poll_count = self.poll_count.wrapping_add(1);
        let tracks_changed = self.poll_count % 10 == 1;
        if tracks_changed {
            self.tracks = self.tracks()?;
        }
        let mut snapshot = json!({"sessionId":self.session,"status":match state{0|1=>"starting",2=>"loading",3|4=>"ready",5=>"closed",6=>"ended",_=>"error"},"paused":state==4,"position":vlc!(self,"libvlc_media_player_get_time",unsafe extern "C" fn(*mut c_void)->i64,self.player).max(0)as f64/1000.,"duration":vlc!(self,"libvlc_media_player_get_length",unsafe extern "C" fn(*mut c_void)->i64,self.player).max(0)as f64/1000.,"volume":self.volume as f64/100.,"muted":self.muted,"speed":self.speed});
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
            if !self.instance.is_null() {
                if let Ok(release) = self
                    .library
                    .get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_release\0")
                {
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
