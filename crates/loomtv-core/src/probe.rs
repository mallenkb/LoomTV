use crate::{Error, Result, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    sync::{oneshot, Mutex, Semaphore},
};

const PROCESS_LIMIT: usize = 2;
const OUTPUT_LIMIT: usize = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const QUEUE_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const CACHE_ENTRIES: usize = 128;
const MAX_PENDING: usize = 16;
const MAX_WAITERS: usize = 32;

#[derive(Clone)]
pub struct MediaProbe {
    inner: Arc<Inner>,
}

struct Inner {
    binary: Option<PathBuf>,
    gate: Arc<Semaphore>,
    state: Mutex<ProbeState>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

struct ProbeState {
    cache: HashMap<CacheKey, CacheEntry>,
    lru: VecDeque<CacheKey>,
    pending: HashMap<CacheKey, Vec<oneshot::Sender<Result<Value>>>>,
}

#[derive(Clone, Eq)]
struct CacheKey {
    path: PathBuf,
    size: u64,
    modified_ns: i128,
}

impl PartialEq for CacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.size == other.size && self.modified_ns == other.modified_ns
    }
}

impl Hash for CacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.path.hash(state);
        self.size.hash(state);
        self.modified_ns.hash(state);
    }
}

struct CacheEntry {
    value: Value,
    last_access: Instant,
}

struct Authorization {
    source: String,
    path: PathBuf,
    profile: String,
    revision: i64,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    format: Option<FfprobeFormat>,
    streams: Option<Vec<FfprobeStream>>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    bit_rate: Option<String>,
    format_name: Option<String>,
    #[allow(dead_code)]
    tags: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    index: Option<f64>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    color_space: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    channels: Option<f64>,
    disposition: Option<HashMap<String, f64>>,
    tags: Option<HashMap<String, String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTrack {
    index: f64,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pixel_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_transfer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_primaries: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_rate: Option<f64>,
    default: bool,
    forced: bool,
}

impl MediaProbe {
    pub fn new(binary: Option<PathBuf>) -> Self {
        Self {
            inner: Arc::new(Inner {
                binary,
                gate: Arc::new(Semaphore::new(PROCESS_LIMIT)),
                state: Mutex::new(ProbeState {
                    cache: HashMap::new(),
                    lru: VecDeque::new(),
                    pending: HashMap::new(),
                }),
                shutdown: tokio::sync::watch::channel(false).0,
            }),
        }
    }

    pub async fn probe(&self, store: Arc<Mutex<Store>>, source: &str) -> Result<Value> {
        if *self.inner.shutdown.borrow() {
            return Err(cancelled());
        }
        let authorization = authorize(&store, source).await?;
        let key = cache_key(&authorization.path).await?;
        let response = {
            let mut state = self.inner.state.lock().await;
            prune_expired(&mut state);
            if let Some(value) = cached(&mut state, &key) {
                drop(state);
                verify_authorization(&store, &authorization).await?;
                return Ok(value);
            }
            let (reply, response) = oneshot::channel();
            if let Some(waiters) = state.pending.get_mut(&key) {
                waiters.retain(|waiter| !waiter.is_closed());
                if waiters.len() >= MAX_WAITERS {
                    return Err(Error::new(
                        "probe_busy",
                        "Too many pending requests for this media.",
                    ));
                }
                waiters.push(reply);
            } else {
                if state.pending.len() >= MAX_PENDING {
                    return Err(Error::new("probe_busy", "The media probe queue is full."));
                }
                state.pending.insert(key.clone(), vec![reply]);
                let service = self.clone();
                let path = authorization.path.clone();
                let source = authorization.source.clone();
                let task_key = key.clone();
                tokio::spawn(async move {
                    let result = service.probe_uncached(&path, &source).await;
                    service.finish(task_key, result).await;
                });
            }
            response
        };
        let value = response.await.map_err(|_| cancelled())??;
        verify_authorization(&store, &authorization).await?;
        Ok(value)
    }

    pub async fn shutdown(&self) {
        self.inner.shutdown.send_replace(true);
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.inner
                .gate
                .clone()
                .acquire_many_owned(PROCESS_LIMIT as u32),
        )
        .await;
        let waiters = {
            let mut state = self.inner.state.lock().await;
            state.cache.clear();
            state.lru.clear();
            state
                .pending
                .drain()
                .flat_map(|(_, waiters)| waiters)
                .collect::<Vec<_>>()
        };
        for waiter in waiters {
            let _ = waiter.send(Err(cancelled()));
        }
    }

    async fn probe_uncached(&self, path: &Path, source: &str) -> Result<Value> {
        let binary = self.inner.binary.as_ref().ok_or_else(|| {
            Error::new(
                "ffprobe_missing",
                "The packaged ffprobe runtime is missing.",
            )
        })?;
        let mut stopped = self.inner.shutdown.subscribe();
        if *stopped.borrow() {
            return Err(cancelled());
        }
        let permit = tokio::select! {
            _ = stopped.changed() => return Err(cancelled()),
            result = tokio::time::timeout(QUEUE_TIMEOUT, self.inner.gate.clone().acquire_owned()) => {
                result
                    .map_err(|_| Error::new("probe_busy", "Media probing is busy. Try again."))?
                    .map_err(|_| cancelled())?
            }
        };
        if *stopped.borrow() {
            return Err(cancelled());
        }
        let mut child = tokio::process::Command::new(binary)
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Error::new("probe_failed", "The media probe did not start."))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("probe_failed", "The media probe did not start."))?;
        let work = tokio::time::timeout(PROBE_TIMEOUT, async {
            let mut bytes = Vec::new();
            stdout
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > OUTPUT_LIMIT {
                return Err(Error::new(
                    "probe_too_large",
                    "The media probe response is too large.",
                ));
            }
            if !child.wait().await?.success() {
                return Err(Error::new("probe_failed", "The media probe failed."));
            }
            normalize_output(source, &bytes)
        });
        let result = tokio::select! {
            _ = stopped.changed() => Err(cancelled()),
            result = work => result.unwrap_or_else(|_| Err(Error::new("probe_timeout", "The media probe timed out."))),
        };
        if result.is_err() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        drop(permit);
        result
    }

    async fn finish(&self, key: CacheKey, result: Result<Value>) {
        let waiters = {
            let mut state = self.inner.state.lock().await;
            let waiters = state.pending.remove(&key).unwrap_or_default();
            if !*self.inner.shutdown.borrow() {
                if let Ok(value) = &result {
                    insert_cache(&mut state, key, value.clone());
                }
            }
            waiters
        };
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
    }
}

pub fn can_direct_play(probe_result: &Value, backend: &str) -> Result<bool> {
    if !["html5", "hls"].contains(&backend) {
        return Err(Error::new(
            "invalid_backend",
            "Choose a supported playback backend.",
        ));
    }
    if backend != "html5" {
        return Ok(false);
    }
    let video_codec = probe_result
        .get("videoCodec")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let audio_codec = probe_result
        .get("audioCodec")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let video = probe_result
        .get("tracks")
        .and_then(Value::as_array)
        .and_then(|tracks| {
            tracks
                .iter()
                .find(|track| track.get("type").and_then(Value::as_str) == Some("video"))
        });
    let pixel_format = video
        .and_then(|track| track.get("pixelFormat"))
        .and_then(Value::as_str);
    let profile = video
        .and_then(|track| track.get("profile"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let container = probe_result["container"].as_str().unwrap_or_default();
    Ok(["mov", "mp4", "m4v"].contains(&container)
        && video_codec == "h264"
        && pixel_format == Some("yuv420p")
        && !profile.contains("10")
        && ["aac", "mp3"].contains(&audio_codec.as_str()))
}

async fn authorize(store: &Arc<Mutex<Store>>, source: &str) -> Result<Authorization> {
    if source.is_empty() || source.len() > 16_384 || source.contains('\0') {
        return Err(Error::new(
            "invalid_argument",
            "A local media path is required.",
        ));
    }
    let store = store.lock().await;
    let profile = store.require_active(None)?;
    let revision = store.selection_revision();
    let path = store.authorize_media(source)?;
    Ok(Authorization {
        source: source.into(),
        path,
        profile,
        revision,
    })
}

async fn verify_authorization(
    store: &Arc<Mutex<Store>>,
    authorization: &Authorization,
) -> Result<()> {
    let store = store.lock().await;
    store.require_active(Some(&authorization.profile))?;
    if store.selection_revision() != authorization.revision {
        return Err(Error::new(
            "stale_profile_selection",
            "The active profile changed during media probing.",
        ));
    }
    let current = store.authorize_media(&authorization.source)?;
    if current != authorization.path {
        return Err(Error::new(
            "stale_media_source",
            "The media source changed during probing.",
        ));
    }
    Ok(())
}

async fn cache_key(path: &Path) -> Result<CacheKey> {
    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(Error::new(
            "invalid_media",
            "The media source must be a file.",
        ));
    }
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as i128)
        .unwrap_or(0);
    Ok(CacheKey {
        path: path.to_owned(),
        size: metadata.len(),
        modified_ns,
    })
}

fn cached(state: &mut ProbeState, key: &CacheKey) -> Option<Value> {
    let value = state.cache.get_mut(key)?;
    value.last_access = Instant::now();
    let result = value.value.clone();
    touch_lru(state, key);
    Some(result)
}

fn insert_cache(state: &mut ProbeState, key: CacheKey, value: Value) {
    state.cache.insert(
        key.clone(),
        CacheEntry {
            value,
            last_access: Instant::now(),
        },
    );
    touch_lru(state, &key);
    while state.cache.len() > CACHE_ENTRIES {
        if let Some(oldest) = state.lru.pop_front() {
            state.cache.remove(&oldest);
        }
    }
}

fn touch_lru(state: &mut ProbeState, key: &CacheKey) {
    if let Some(index) = state.lru.iter().position(|candidate| candidate == key) {
        state.lru.remove(index);
    }
    state.lru.push_back(key.clone());
}

fn prune_expired(state: &mut ProbeState) {
    let now = Instant::now();
    while let Some(key) = state.lru.front() {
        let expired = state
            .cache
            .get(key)
            .is_none_or(|entry| now.duration_since(entry.last_access) >= CACHE_TTL);
        if !expired {
            break;
        }
        if let Some(key) = state.lru.pop_front() {
            state.cache.remove(&key);
        }
    }
}

fn normalize_output(source: &str, bytes: &[u8]) -> Result<Value> {
    let parsed: FfprobeOutput = serde_json::from_slice(bytes)
        .map_err(|_| Error::new("probe_invalid", "ffprobe returned invalid media metadata."))?;
    let tracks = parsed
        .streams
        .unwrap_or_default()
        .into_iter()
        .map(normalize_track)
        .collect::<Vec<_>>();
    let video = tracks.iter().find(|track| track.kind == "video");
    let audio = tracks.iter().find(|track| track.kind == "audio");
    let subtitles = tracks
        .iter()
        .filter(|track| track.kind == "subtitle")
        .cloned()
        .collect::<Vec<_>>();
    let mut result = json!({
        "filePath": source,
        "subtitleStreams": subtitles,
        "tracks": tracks,
    });
    if let Some(format) = parsed.format {
        if let Some(container) = format
            .format_name
            .map(|value| value.split(',').next().unwrap_or_default().to_owned())
        {
            result["container"] = json!(container);
        }
        if let Some(duration) = format.duration.as_deref().and_then(parse_rounded) {
            result["durationSeconds"] = json!(duration);
        }
        if let Some(bitrate) = format
            .bit_rate
            .as_deref()
            .filter(|value| !value.is_empty())
            .and_then(parse_finite)
            .map(|value| (value / 1000.0).round())
        {
            result["bitrateKbps"] = json!(bitrate);
        }
    }
    if let Some(video) = video {
        if let Some(codec) = &video.codec {
            result["videoCodec"] = json!(codec);
        }
        let mut resolution = serde_json::Map::new();
        if let Some(width) = video.width {
            resolution.insert("width".into(), json!(width));
        }
        if let Some(height) = video.height {
            resolution.insert("height".into(), json!(height));
        }
        result["resolution"] = Value::Object(resolution);
    }
    if let Some(audio) = audio {
        if let Some(codec) = &audio.codec {
            result["audioCodec"] = json!(codec);
        }
    }
    Ok(result)
}

fn normalize_track(stream: FfprobeStream) -> MediaTrack {
    let kind = match stream.codec_type.as_deref() {
        Some("video") => "video",
        Some("audio") => "audio",
        Some("subtitle") => "subtitle",
        Some("data") => "data",
        _ => "unknown",
    };
    let language = stream
        .tags
        .as_ref()
        .and_then(|tags| tags.get("language"))
        .cloned();
    let title = stream
        .tags
        .as_ref()
        .and_then(|tags| tags.get("title"))
        .cloned();
    let default = stream
        .disposition
        .as_ref()
        .and_then(|value| value.get("default"))
        == Some(&1.0);
    let forced = stream
        .disposition
        .as_ref()
        .and_then(|value| value.get("forced"))
        == Some(&1.0);
    MediaTrack {
        index: stream.index.unwrap_or(0.0),
        kind,
        codec: stream.codec_name,
        language,
        title,
        channels: stream.channels,
        width: stream.width,
        height: stream.height,
        profile: stream.profile,
        pixel_format: stream.pix_fmt,
        color_transfer: stream.color_transfer,
        color_primaries: stream.color_primaries,
        color_space: stream.color_space,
        frame_rate: stream
            .avg_frame_rate
            .as_deref()
            .and_then(parse_frame_rate)
            .or_else(|| stream.r_frame_rate.as_deref().and_then(parse_frame_rate)),
        default,
        forced,
    }
}

fn parse_frame_rate(value: &str) -> Option<f64> {
    let mut parts = value.split('/');
    let numerator = parse_finite(parts.next()?)?;
    let denominator = parse_finite(parts.next().unwrap_or("1"))?;
    if numerator <= 0.0 || denominator == 0.0 {
        return None;
    }
    let rate = numerator / denominator;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

fn parse_finite(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn parse_rounded(value: &str) -> Option<f64> {
    if value.is_empty() {
        return None;
    }
    parse_finite(value).map(f64::round)
}

fn cancelled() -> Error {
    Error::new("probe_cancelled", "The media probe was cancelled.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_result_matches_renderer_fields_and_subtitle_indices() {
        let raw = br#"{"format":{"duration":"12.25","format_name":"mov,mp4","bit_rate":"250000"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","avg_frame_rate":"24000/1001","width":1920,"height":1080},{"index":2,"codec_type":"audio","codec_name":"aac"},{"index":7,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"eng"}}]}"#;
        let result = normalize_output("fixture.mp4", raw).unwrap();
        assert_eq!(result["container"], "mov");
        assert_eq!(result["bitrateKbps"], 250.0);
        assert_eq!(result["subtitleStreams"][0]["index"], 7.0);
        assert!(can_direct_play(&result, "html5").unwrap());
        assert!(!can_direct_play(&result, "hls").unwrap());
        let mut mkv = result.clone();
        mkv["container"] = json!("matroska");
        assert!(!can_direct_play(&mkv, "html5").unwrap());
        assert!(can_direct_play(&result, "unknown").is_err());
    }
}
