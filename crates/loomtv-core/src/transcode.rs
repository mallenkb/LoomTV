//! Local HLS fallback. Every encoder, directory and URL belongs to one profile revision.
use crate::{probe::MediaProbe, transcode_plan as plan, Error, Result, Store};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};
use tokio::{
    io::AsyncReadExt,
    process::Child,
    sync::{watch, Mutex, Semaphore},
};

const MAX_SESSIONS: usize = 2;
const MAX_REQUESTS: usize = 8;
const MAX_SEGMENTS: usize = 100_000;
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const ENCODER_IDLE: Duration = Duration::from_secs(30);
const SESSION_IDLE: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct Transcodes(Arc<Inner>);
struct Inner {
    store: Arc<Mutex<Store>>,
    probe: MediaProbe,
    binary: Option<PathBuf>,
    root: PathBuf,
    port: u16,
    generation: AtomicU64,
    closed: AtomicBool,
    admission: Mutex<()>,
    requests: Arc<Semaphore>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    stop: watch::Sender<bool>,
}
struct Session {
    id: String,
    key: String,
    original: String,
    source: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    profile: String,
    revision: i64,
    generation: u64,
    directory: PathBuf,
    options: Value,
    media_info: Value,
    duration: f64,
    segment_seconds: f64,
    segment_count: usize,
    cancel: watch::Sender<bool>,
    state: Mutex<Encoder>,
}
struct Encoder {
    child: Option<Child>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    preset: String,
    start: i64,
    last_requested: i64,
    last_activity: Instant,
    restarts: VecDeque<Instant>,
}

impl Transcodes {
    pub fn new(
        store: Arc<Mutex<Store>>,
        probe: MediaProbe,
        binary: Option<PathBuf>,
        cache: PathBuf,
        port: u16,
    ) -> Self {
        let service = Self(Arc::new(Inner {
            store,
            probe,
            binary,
            root: cache.join(uuid::Uuid::new_v4().simple().to_string()),
            port,
            generation: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            admission: Mutex::new(()),
            requests: Arc::new(Semaphore::new(MAX_REQUESTS)),
            sessions: Mutex::new(HashMap::new()),
            stop: watch::channel(false).0,
        }));
        let weak = Arc::downgrade(&service.0);
        let mut stop = service.0.stop.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
                let Some(inner) = weak.upgrade() else { break };
                Self(inner).maintain().await;
            }
        });
        service
    }

    pub async fn start(&self, source: &str, options: &Value) -> Result<Value> {
        let _admission = self.0.admission.try_lock().map_err(|_| busy())?;
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if self.0.binary.is_none() {
            return Err(Error::new(
                "ffmpeg_missing",
                "The packaged FFmpeg runtime is missing.",
            ));
        }
        let generation = self.0.generation.load(Ordering::SeqCst);
        let mut options = validate_options(options)?;
        let (path, profile, revision) = {
            let store = self.0.store.lock().await;
            let profile = store.require_active(None)?;
            let path = store.authorize_media(source)?;
            for name in ["subtitleFilePath", "secondarySubtitleFilePath"] {
                if let Some(subtitle) = options[name].as_str() {
                    options[name] = json!(store.authorize_media(subtitle)?);
                }
            }
            (path, profile, store.selection_revision())
        };
        let metadata = tokio::fs::metadata(&path).await?;
        let probe = self.0.probe.probe(self.0.store.clone(), source).await?;
        normalize_track_selections(&probe, &mut options)?;
        let media_info = selected_media_info(&probe, &options)?;
        let duration = probe["durationSeconds"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(0.0);
        let segment_seconds = plan::frame_aligned_segment_seconds(
            plan::LOCAL_HLS_SEGMENT_SECONDS,
            media_info["frameRate"].as_f64(),
        );
        let segment_count = plan::transcode_segment_count(duration, segment_seconds);
        if segment_count > MAX_SEGMENTS {
            return Err(Error::new(
                "media_too_long",
                "This media exceeds the bounded HLS playlist size.",
            ));
        }
        let start = options["startSeconds"].as_f64().unwrap_or(0.0);
        let first = if segment_count > 0 {
            ((start / segment_seconds).floor() as i64).min(segment_count as i64 - 1)
        } else {
            0
        };
        let mut identity_options = options.clone();
        if duration > 0.0 {
            identity_options
                .as_object_mut()
                .ok_or_else(invalid_options)?
                .remove("startSeconds");
        }
        let key = format!(
            "{profile}\0{revision}\0{}\0{}\0{:?}\0{}",
            path.display(),
            metadata.len(),
            metadata.modified().ok(),
            identity_options
        );
        let existing = self
            .0
            .sessions
            .lock()
            .await
            .values()
            .find(|s| s.key == key && s.generation == generation)
            .cloned();
        if let Some(session) = existing {
            self.prepare(&session, first).await?;
            return self.info(&session).await;
        }
        let evicted = {
            let mut sessions = self.0.sessions.lock().await;
            if sessions.len() >= MAX_SESSIONS {
                let oldest = sessions
                    .iter()
                    .filter_map(|(id, s)| {
                        s.state
                            .try_lock()
                            .ok()
                            .map(|e| (id.clone(), e.last_activity))
                    })
                    .min_by_key(|(_, time)| *time)
                    .map(|(id, _)| id);
                match oldest {
                    Some(id) => sessions.remove(&id),
                    None => return Err(busy()),
                }
            } else {
                None
            }
        };
        if let Some(session) = evicted {
            self.dispose(&session).await?;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let directory = self.0.root.join(&id);
        tokio::fs::create_dir_all(&directory).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.0.root, std::fs::Permissions::from_mode(0o700))
                .await?;
            tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let preset = match options["preset"].as_str() {
            Some("auto") | None => {
                if cfg!(target_os = "macos") {
                    "videotoolbox"
                } else {
                    "software"
                }
            }
            Some(value) => value,
        }
        .to_owned();
        let session = Arc::new(Session {
            id: id.clone(),
            key,
            original: source.into(),
            source: path,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            profile,
            revision,
            generation,
            directory,
            options,
            media_info,
            duration,
            segment_seconds,
            segment_count,
            cancel: watch::channel(false).0,
            state: Mutex::new(Encoder {
                child: None,
                stderr_task: None,
                preset,
                start: first,
                last_requested: first,
                last_activity: Instant::now(),
                restarts: VecDeque::new(),
            }),
        });
        {
            let mut sessions = self.0.sessions.lock().await;
            if self.0.generation.load(Ordering::SeqCst) != generation
                || self.0.closed.load(Ordering::SeqCst)
            {
                drop(sessions);
                self.dispose(&session).await?;
                return Err(cancelled());
            }
            sessions.insert(id.clone(), session.clone());
        }
        if let Err(error) = self.prepare(&session, first).await {
            self.0.sessions.lock().await.remove(&id);
            self.dispose(&session).await?;
            return Err(error);
        }
        self.info(&session).await
    }

    async fn info(&self, session: &Session) -> Result<Value> {
        self.validate(session).await?;
        let encoder = session.state.lock().await;
        Ok(json!({
            "sessionId": session.id, "filePath": session.original,
            "outputDir": session.directory, "playlistUrl": format!("http://127.0.0.1:{}/transcode/{}/index.m3u8",self.0.port,session.id),
            "seekable": session.duration > 0.0,
            "startSeconds": if session.duration > 0.0 { 0.0 } else { session.options["startSeconds"].as_f64().unwrap_or(0.0) },
            "preset": encoder.preset, "codec": plan::normalize_playback_profile(&session.options).codec
        }))
    }

    async fn validate(&self, session: &Session) -> Result<()> {
        if *session.cancel.borrow()
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.generation.load(Ordering::SeqCst) != session.generation
        {
            return Err(cancelled());
        }
        let store = self.0.store.lock().await;
        store.require_active(Some(&session.profile))?;
        if store.selection_revision() != session.revision
            || store.authorize_media(&session.original)? != session.source
        {
            return Err(cancelled());
        }
        Ok(())
    }

    pub async fn authorize(&self, id: &str) -> Result<()> {
        let session = self.session(id).await?;
        self.validate(&session).await
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.0
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("transcode_not_found", "This playback session has ended."))
    }

    pub async fn playlist(&self, id: &str) -> Result<Vec<u8>> {
        let session = self.session(id).await?;
        self.validate(&session).await?;
        session.state.lock().await.last_activity = Instant::now();
        if session.duration > 0.0 {
            Ok(plan::build_vod_playlist(session.duration, session.segment_seconds).into_bytes())
        } else {
            let file = tokio::fs::File::open(session.directory.join("encoder.m3u8")).await?;
            let mut bytes = Vec::new();
            file.take(crate::hls::MAX_PLAYLIST_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > crate::hls::MAX_PLAYLIST_BYTES {
                return Err(invalid_options());
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| invalid_options())?;
            let result = crate::hls::rewrite(text, &mut |name| {
                segment_index(name)
                    .map(|_| name.to_owned())
                    .ok_or_else(invalid_options)
            })?;
            self.validate(&session).await?;
            Ok(result.into_bytes())
        }
    }

    pub async fn segment(&self, id: &str, name: &str) -> Result<tokio::fs::File> {
        let index = segment_index(name)
            .ok_or_else(|| Error::new("invalid_segment", "The HLS segment name is invalid."))?;
        let session = self.session(id).await?;
        if session.segment_count > 0 && index as usize >= session.segment_count {
            return Err(Error::new(
                "invalid_segment",
                "The HLS segment is outside the media timeline.",
            ));
        }
        self.prepare(&session, index).await?;
        let path = session.directory.join(name);
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid_options());
        }
        let file = tokio::fs::File::open(path).await?;
        self.validate(&session).await?;
        Ok(file)
    }

    async fn prepare(&self, session: &Session, index: i64) -> Result<()> {
        let mut stop = session.cancel.subscribe();
        let mut encoder = tokio::select! {
            _ = stop.changed() => return Err(cancelled()),
            result = tokio::time::timeout(READY_TIMEOUT, session.state.lock()) => result.map_err(|_| busy())?,
        };
        self.validate(session).await?;
        let metadata = tokio::fs::metadata(&session.source).await?;
        if metadata.len() != session.size || metadata.modified().ok() != session.modified {
            return Err(Error::new(
                "media_changed",
                "The source changed. Reopen the video.",
            ));
        }
        encoder.last_activity = Instant::now();
        let path = session.directory.join(plan::transcode_segment_name(index));
        let on_disk = complete_segment(&path).await;
        let alive = match encoder.child.as_mut() {
            Some(child) => child.try_wait()?.is_none(),
            None => false,
        };
        let reposition = plan::should_reposition_encoder(
            index,
            encoder.start,
            encoder.last_requested,
            on_disk,
            alive,
            3,
        ) || (!on_disk
            && index >= encoder.start + plan::LOCAL_HLS_WINDOW_SEGMENTS as i64);
        if reposition {
            self.spawn(session, &mut encoder, index).await?;
        }
        encoder.last_requested = index;
        if on_disk {
            return Ok(());
        }
        let started = Instant::now();
        loop {
            self.validate(session).await?;
            if complete_segment(&path).await {
                self.prune(session, &encoder).await?;
                return Ok(());
            }
            let status = match encoder.child.as_mut() {
                Some(child) => child.try_wait()?,
                None => return Err(cancelled()),
            };
            if let Some(status) = status {
                // Recheck after wait: the last rename may have raced the preceding stat.
                if complete_segment(&path).await {
                    return Ok(());
                }
                if encoder.preset != "software" {
                    encoder.preset = "software".into();
                    self.spawn(session, &mut encoder, index).await?;
                } else {
                    return Err(Error::new(
                        "transcode_failed",
                        if status.success() {
                            "The encoder ended before producing the requested segment."
                        } else {
                            "FFmpeg could not encode this media with the selected tracks."
                        },
                    ));
                }
            }
            if started.elapsed() >= READY_TIMEOUT {
                stop_encoder(&mut encoder).await?;
                return Err(Error::new(
                    "transcode_timeout",
                    "FFmpeg did not produce a playable segment in time.",
                ));
            }
            tokio::select! {
                _ = stop.changed() => { stop_encoder(&mut encoder).await?; return Err(cancelled()); },
                _ = tokio::time::sleep(Duration::from_millis(80)) => {}
            }
        }
    }

    async fn spawn(&self, session: &Session, encoder: &mut Encoder, index: i64) -> Result<()> {
        self.validate(session).await?;
        let now = Instant::now();
        while encoder
            .restarts
            .front()
            .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(30))
        {
            encoder.restarts.pop_front();
        }
        if encoder.restarts.len() >= 16 {
            return Err(Error::new(
                "transcode_seek_limit",
                "Too many encoder restarts. Pause seeking and retry.",
            ));
        }
        stop_encoder(encoder).await?;
        let binary = self.0.binary.as_ref().ok_or_else(|| {
            Error::new("ffmpeg_missing", "The packaged FFmpeg runtime is missing.")
        })?;
        let mut options = session.options.clone();
        if session.duration > 0.0 {
            options["startSeconds"] = json!(index as f64 * session.segment_seconds);
        }
        let args = plan::build_hls_args(
            &session.source,
            &session.directory.join("encoder.m3u8"),
            &options,
            &encoder.preset,
            Some(&session.media_info),
            session.duration > 0.0,
            index,
            session.segment_seconds,
            plan::LOCAL_HLS_WINDOW_SEGMENTS as i64,
            None,
        )?;
        let mut command = tokio::process::Command::new(binary);
        command
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-threads",
                "2",
            ])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| Error::new("transcode_failed", "FFmpeg could not be started."))?;
        if let Some(mut stderr) = child.stderr.take() {
            // Drain without retaining media paths or credentials in logs or memory.
            encoder.stderr_task = Some(tokio::spawn(async move {
                let mut buffer = [0; 4096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            }));
        }
        encoder.child = Some(child);
        encoder.start = index;
        encoder.restarts.push_back(now);
        Ok(())
    }

    async fn prune(&self, session: &Session, encoder: &Encoder) -> Result<()> {
        let mut directory = tokio::fs::read_dir(&session.directory).await?;
        let mut files = Vec::new();
        let mut bytes = 0_u64;
        while let Some(entry) = directory.next_entry().await? {
            let metadata = match entry.metadata().await {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            bytes = bytes.saturating_add(metadata.len());
            if let Some(index) = segment_index(&name) {
                files.push((index, entry.path(), metadata.len()));
            }
            if files.len() > MAX_SEGMENTS {
                return Err(Error::new(
                    "transcode_quota",
                    "The transcode cache contains too many files.",
                ));
            }
        }
        files
            .sort_by_key(|(index, _, _)| std::cmp::Reverse((index - encoder.last_requested).abs()));
        let mut count = files.len();
        for (index, path, size) in files {
            if index == encoder.last_requested {
                continue;
            }
            if bytes <= MAX_BYTES && count <= plan::LOCAL_HLS_WINDOW_SEGMENTS * 4 {
                break;
            }
            tokio::fs::remove_file(path).await?;
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
        if bytes > MAX_BYTES {
            return Err(Error::new(
                "transcode_quota",
                "This transcode exceeded its disk cache limit.",
            ));
        }
        Ok(())
    }

    pub async fn stop(&self, id: &str) -> Result<bool> {
        let session = self.0.sessions.lock().await.remove(id);
        let Some(session) = session else {
            return Ok(false);
        };
        self.dispose(&session).await?;
        Ok(true)
    }

    async fn dispose(&self, session: &Session) -> Result<()> {
        session.cancel.send_replace(true);
        stop_encoder(&mut *session.state.lock().await).await?;
        // Only directories created by this process, never a caller-supplied output path.
        if session.directory.parent() != Some(self.0.root.as_path()) {
            return Err(invalid_options());
        }
        match tokio::fs::remove_dir_all(&session.directory).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn revoke_all(&self) {
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        let sessions = self
            .0
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, s)| s)
            .collect::<Vec<_>>();
        for session in &sessions {
            session.cancel.send_replace(true);
        }
        for session in sessions {
            let _ = self.dispose(&session).await;
        }
    }

    pub async fn shutdown(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        self.0.stop.send_replace(true);
        self.revoke_all().await;
        // remove_dir deliberately fails rather than recursively deleting unexpected files.
        let _ = tokio::fs::remove_dir(&self.0.root).await;
    }

    async fn maintain(&self) {
        let sessions = self
            .0
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            let invalid = self.validate(&session).await.is_err();
            let mut expire = invalid;
            if let Ok(mut encoder) = session.state.try_lock() {
                expire |= encoder.last_activity.elapsed() >= SESSION_IDLE;
                if !expire && encoder.last_activity.elapsed() >= ENCODER_IDLE {
                    if stop_encoder(&mut encoder).await.is_err() {
                        expire = true;
                    }
                }
                if !expire && self.prune(&session, &encoder).await.is_err() {
                    expire = true;
                }
            }
            if expire {
                let _ = self.stop(&session.id).await;
            }
        }
    }
}

async fn stop_encoder(encoder: &mut Encoder) -> Result<()> {
    if let Some(child) = encoder.child.as_mut() {
        if child.try_wait()?.is_none() {
            child.start_kill()?;
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .map_err(|_| {
                    Error::new(
                        "transcode_stop_timeout",
                        "FFmpeg did not exit after cancellation.",
                    )
                })??;
        }
    }
    encoder.child = None;
    if let Some(mut task) = encoder.stderr_task.take() {
        if tokio::time::timeout(Duration::from_secs(1), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
    Ok(())
}
async fn complete_segment(path: &Path) -> bool {
    tokio::fs::symlink_metadata(path)
        .await
        .is_ok_and(|metadata| {
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0
        })
}
fn segment_index(name: &str) -> Option<i64> {
    let digits = name.strip_prefix("segment-")?.strip_suffix(".ts")?;
    if !(5..=6).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let index = digits.parse::<i64>().ok()?;
    (index < MAX_SEGMENTS as i64 && plan::transcode_segment_name(index) == name).then_some(index)
}
fn invalid_options() -> Error {
    Error::new(
        "invalid_transcode_options",
        "Choose valid transcode options.",
    )
}
fn busy() -> Error {
    Error::new(
        "transcode_busy",
        "Playback preparation is busy. Retry the request.",
    )
}
fn cancelled() -> Error {
    Error::new(
        "transcode_cancelled",
        "The playback session changed or ended.",
    )
}

fn validate_options(value: &Value) -> Result<Value> {
    let value = if value.is_null() {
        json!({})
    } else {
        value.clone()
    };
    let object = value.as_object().ok_or_else(invalid_options)?;
    if serde_json::to_vec(object)?.len() > 16_384 {
        return Err(invalid_options());
    }
    for field in [
        "startSeconds",
        "maxWidth",
        "maxHeight",
        "videoBitrateKbps",
        "audioBitrateKbps",
    ] {
        if let Some(value) = object.get(field) {
            if !value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= 1_000_000.0)
            {
                return Err(invalid_options());
            }
        }
    }
    for field in [
        "videoTrackIndex",
        "audioTrackIndex",
        "subtitleTrackIndex",
        "subtitleStreamOrdinal",
        "secondarySubtitleTrackIndex",
        "secondarySubtitleStreamOrdinal",
    ] {
        if object
            .get(field)
            .is_some_and(|n| !n.is_null() && !n.as_i64().is_some_and(|n| (-1..=1024).contains(&n)))
        {
            return Err(invalid_options());
        }
    }
    for field in ["subtitleFilePath", "secondarySubtitleFilePath"] {
        if let Some(value) = object.get(field) {
            if !value.is_null()
                && !value
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 16_384 && !s.contains('\0'))
            {
                return Err(invalid_options());
            }
        }
    }
    if let Some(preset) = object.get("preset") {
        if !preset.as_str().is_some_and(|s| {
            [
                "auto",
                "software",
                "videotoolbox",
                "nvenc",
                "qsv",
                "vaapi",
                "amf",
                "rkmpp",
            ]
            .contains(&s)
        }) {
            return Err(invalid_options());
        }
    }
    for field in ["codec", "targetVideoCodec"] {
        if object.get(field).is_some_and(|c| {
            !c.as_str()
                .is_some_and(|c| ["h264", "hevc", "av1"].contains(&c))
        }) {
            return Err(invalid_options());
        }
    }
    Ok(value)
}

fn normalize_track_selections(probe: &Value, options: &mut Value) -> Result<()> {
    let tracks = probe["tracks"].as_array().ok_or_else(invalid_options)?;
    if !tracks.iter().any(|track| track["type"] == "audio") {
        options["audioTrackIndex"] = json!(-1);
    }
    let subtitles = tracks
        .iter()
        .filter(|track| track["type"] == "subtitle")
        .collect::<Vec<_>>();
    for (track_key, ordinal_key, codec_key) in [
        (
            "subtitleTrackIndex",
            "subtitleStreamOrdinal",
            "subtitleCodec",
        ),
        (
            "secondarySubtitleTrackIndex",
            "secondarySubtitleStreamOrdinal",
            "secondarySubtitleCodec",
        ),
    ] {
        if let Some(index) = options[track_key].as_i64().filter(|index| *index >= 0) {
            let ordinal = subtitles
                .iter()
                .position(|track| track["index"].as_f64() == Some(index as f64))
                .ok_or_else(|| {
                    Error::new(
                        "invalid_track",
                        "The selected subtitle track is not in this media.",
                    )
                })?;
            if options[ordinal_key]
                .as_u64()
                .is_some_and(|requested| requested != ordinal as u64)
            {
                return Err(invalid_options());
            }
            options[ordinal_key] = json!(ordinal);
            options[codec_key] = subtitles[ordinal]["codec"].clone();
        }
    }
    Ok(())
}

fn selected_media_info(probe: &Value, options: &Value) -> Result<Value> {
    let tracks = probe["tracks"].as_array().ok_or_else(invalid_options)?;
    let select = |kind: &str, field: &str| -> Result<Option<&Value>> {
        let index = options[field].as_i64();
        if index == Some(-1) {
            return Ok(None);
        }
        let selected = tracks.iter().find(|track| {
            track["type"] == kind
                && index.is_none_or(|index| track["index"].as_f64() == Some(index as f64))
        });
        if index.is_some() && selected.is_none() {
            return Err(Error::new(
                "invalid_track",
                "The selected track is not in this media.",
            ));
        }
        Ok(selected)
    };
    let video = select("video", "videoTrackIndex")?
        .ok_or_else(|| Error::new("video_missing", "This media has no selected video track."))?;
    let audio = select("audio", "audioTrackIndex")?;
    Ok(
        json!({"videoCodec":video["codec"],"videoProfile":video["profile"],"pixelFormat":video["pixelFormat"],"colorTransfer":video["colorTransfer"],"colorPrimaries":video["colorPrimaries"],"colorSpace":video["colorSpace"],"frameRate":video["frameRate"],"audioCodec":audio.map(|a| a["codec"].clone())}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn segment_names_cannot_escape_the_session_directory() {
        for name in [
            "../segment-00000.ts",
            "segment-00000.ts.tmp",
            "segment--0001.ts",
            "segment-0.ts",
            "segment-000000.ts",
            "/etc/passwd",
            "segment-100000.ts",
            "segment-00001.ts?x=1",
        ] {
            assert_eq!(segment_index(name), None, "{name}");
        }
        assert_eq!(segment_index("segment-00000.ts"), Some(0));
        assert_eq!(segment_index("segment-99999.ts"), Some(99999));
    }
    #[test]
    fn invalid_options_are_rejected_before_starting_a_process() {
        for value in [
            json!([]),
            json!({"startSeconds":-1}),
            json!({"preset":"shell"}),
            json!({"audioTrackIndex":1.5}),
            json!({"subtitleFilePath":"a\u{0}b"}),
            json!({"codec":"unknown"}),
        ] {
            assert!(validate_options(&value).is_err());
        }
        assert!(validate_options(
            &json!({"startSeconds":12.5,"audioTrackIndex":-1,"preset":"software"})
        )
        .is_ok());
    }
    #[test]
    fn selected_tracks_use_stream_indices_not_ordinals() {
        let probe = json!({"tracks":[{"index":2,"type":"video","codec":"h264","frameRate":24.0},{"index":5,"type":"audio","codec":"aac"},{"index":7,"type":"audio","codec":"ac3"}]});
        let info = selected_media_info(&probe, &json!({"audioTrackIndex":7})).unwrap();
        assert_eq!(info["audioCodec"], "ac3");
        assert!(selected_media_info(&probe, &json!({"audioTrackIndex":1})).is_err());
    }
}

pub fn router(service: Transcodes) -> axum::Router {
    axum::Router::new()
        .route("/transcode/{id}/{name}", axum::routing::get(deliver))
        .with_state(service)
}

async fn deliver(
    axum::extract::State(service): axum::extract::State<Transcodes>,
    axum::extract::Path((id, name)): axum::extract::Path<(String, String)>,
    headers: axum::http::HeaderMap,
    method: axum::http::Method,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match deliver_inner(service, id, name, headers, method).await {
        Ok(response) => response,
        Err(error) => {
            let status = match error.code.as_str() {
                "transcode_busy" | "transcode_seek_limit" => {
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }
                "transcode_not_found" => axum::http::StatusCode::NOT_FOUND,
                "invalid_segment" => axum::http::StatusCode::BAD_REQUEST,
                "transcode_failed" => axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "transcode_timeout" => axum::http::StatusCode::GATEWAY_TIMEOUT,
                _ => axum::http::StatusCode::FORBIDDEN,
            };
            (status, [("Cache-Control", "no-store")], axum::Json(error)).into_response()
        }
    }
}

async fn deliver_inner(
    service: Transcodes,
    id: String,
    name: String,
    headers: axum::http::HeaderMap,
    method: axum::http::Method,
) -> Result<axum::response::Response> {
    use axum::{
        body::{Body, Bytes},
        http::{header, Method, StatusCode},
        response::Response,
    };
    use tokio::io::AsyncSeekExt;
    if headers.get(header::HOST).and_then(|h| h.to_str().ok())
        != Some(format!("127.0.0.1:{}", service.0.port).as_str())
    {
        return Err(cancelled());
    }
    let permit = service
        .0
        .requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let response = Response::builder()
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .header("X-Content-Type-Options", "nosniff");
    if name == "index.m3u8" {
        let playlist = service.playlist(&id).await?;
        return response
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CONTENT_LENGTH, playlist.len())
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(playlist)
            })
            .map_err(|_| invalid_options());
    }
    let mut file = service.segment(&id, &name).await?;
    let size = file.metadata().await?.len();
    let range = headers
        .get(header::RANGE)
        .map(|h| h.to_str().map_err(|_| invalid_options()))
        .transpose()?;
    let Some((start, end, partial)) = crate::streaming::parse_range(range, size) else {
        return response
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Body::empty())
            .map_err(|_| invalid_options());
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut response = response
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(futures_util::stream::try_unfold(
            (file, length, service, id, permit),
            |(mut file, remaining, service, id, permit)| async move {
                if remaining == 0 {
                    return Ok(None);
                }
                service.authorize(&id).await.map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "The playback session ended.",
                    )
                })?;
                let mut buffer = vec![0; remaining.min(64 * 1024) as usize];
                let count = file.read(&mut buffer).await?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "The segment ended unexpectedly.",
                    ));
                }
                buffer.truncate(count);
                Ok(Some((
                    Bytes::from(buffer),
                    (file, remaining - count as u64, service, id, permit),
                )))
            },
        ))
    };
    response.body(body).map_err(|_| invalid_options())
}
