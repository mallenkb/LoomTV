use crate::media_tools::{MediaTools, Transform};
use crate::{
    remote::{media_route, RemoteClient},
    Error, Result, Store,
};
use serde::Serialize;
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
    path::PathBuf,
    process::Stdio,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    process::Command,
    sync::{oneshot, Mutex},
};

const MAX_ACTIVE_TRANSCODE_SESSIONS: usize = 2;
const ENCODER_IDLE_TIMEOUT_MS: u64 = 30_000;
const CACHE_PRUNE_INTERVAL_MS: u64 = 5_000;
const TRANSCODE_READY_TIMEOUT_MS: u64 = 30_000;
const TRANSCODE_READY_POLL_MS: u64 = 80;
const HLS_PENDING_SEGMENT_TIMEOUT_MS: u64 = 30_000;
const HLS_PENDING_SEGMENT_POLL_MS: u64 = 80;
const HLS_RESTART_BUDGET_WINDOW_MS: i64 = 30_000;
const MAX_HLS_RESTARTS_PER_WINDOW: usize = 16;
const SEGMENT_REQUEST_CONTIGUITY: i64 = 3;
const MAX_CACHED_BYTES_PER_SESSION: usize = 256 * 1024 * 1024;

#[derive(Clone)]
enum Scope {
    Local { profile: String, revision: i64 },
    Remote { epoch: u64 },
    Iptv(crate::iptv_proxy::IptvPlaybackScope),
    Transcode {
        session_id: String,
        profile: String,
        revision: i64,
    },
}

#[derive(Clone)]
struct TranscodeSession {
    id: String,
    key: String,
    file_path: String,
    profile: String,
    revision: i64,
    output_dir: PathBuf,
    scope: String,
    options: crate::serde_json::Value,
    preset: String,
    codec: String,
    seekable: bool,
    start_seconds: i64,
    segment_seconds: f64,
    segment_count: usize,
    window_segments: usize,
    window_start_index: i64,
    last_requested_index: i64,
    last_activity: Instant,
    last_pruned_at: Instant,
    restart_timestamps: Vec<Instant>,
    process: Option<tokio::process::Child>,
    stderr: String,
    stopped: bool,
}

#[derive(Clone, Serialize)]
struct TranscodeSessionInfo {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "filePath")]
    file_path: String,
    #[serde(rename = "outputDir")]
    output_dir: String,
    #[serde(rename = "seekable")]
    seekable: bool,
    #[serde(rename = "startSeconds")]
    start_seconds: i64,
    preset: Option<String>,
    codec: Option<String>,
    playlist_url: String,
}

#[derive(Clone)]
struct Grant {
    source: String,
    scope: Scope,
    expires: Instant,
    generation: u64,
    transform: Option<Transform>,
}
#[derive(Clone)]
pub struct MediaServer {
    pub port: u16,
    pub token: String,
    resource_key: [u8; 32],
    generation: Arc<AtomicU64>,
    tools: MediaTools,
    store: Arc<Mutex<Store>>,
    remote: Arc<RemoteClient>,
    iptv: crate::iptv_proxy::IptvProxy,
    grants: Arc<Mutex<HashMap<String, Grant>>>,
}
impl MediaServer {
    pub async fn start(
        store: Arc<Mutex<Store>>,
        remote: Arc<RemoteClient>,
        ffmpeg: Option<std::path::PathBuf>,
    ) -> Result<(Self, oneshot::Sender<()>)> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let server = Self {
            port: listener.local_addr()?.port(),
            generation: Arc::new(AtomicU64::new(0)),
            tools: MediaTools::new(ffmpeg),
            token: uuid::Uuid::new_v4().to_string(),
            resource_key: {
                let mut key = [0; 32];
                key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
                key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
                key
            },
            iptv: crate::iptv_proxy::IptvProxy::new(store.clone()),
            store,
            remote,
            grants: Arc::new(Mutex::new(HashMap::new())),
        };
        let routes = Router::new()
            .route("/media/{id}", get(deliver))
            .route("/media/{id}/resource/{reference}", get(deliver_resource))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, routes)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await;
        });
        Ok((server, stop))
    }
    pub async fn grant(&self, source: &str) -> Result<String> {
        self.grant_inner(source, None).await
    }
    pub async fn grant_resource(&self, source: &str, transform: Transform) -> Result<String> {
        self.grant_inner(source, Some(transform)).await
    }
    async fn grant_inner(&self, source: &str, transform: Option<Transform>) -> Result<String> {
        let (source, scope) = if source.starts_with("iptv:") {
            if transform.is_some() {
                return Err(Error::new(
                    "live_media_transform",
                    "Live TV does not support local media conversion.",
                ));
            }
            let resolved = self.iptv.resolve_reference(source).await?;
            (
                resolved.upstream_url.to_string(),
                Scope::Iptv(resolved.scope),
            )
        } else if source.starts_with("loomtv:") || source.starts_with("plexserver:") {
            let source = media_route(source)?;
            if self.remote.session().await?["status"] != "connected" {
                return Err(Error::new(
                    "pairing_required",
                    "Connect to a LoomTV host before opening media.",
                ));
            }
            (
                source,
                Scope::Remote {
                    epoch: self.remote.epoch(),
                },
            )
        } else {
            let store = self.store.lock().await;
            (
                store
                    .authorize_media(source)?
                    .to_string_lossy()
                    .into_owned(),
                Scope::Local {
                    profile: store.require_active(None)?,
                    revision: store.revision,
                },
            )
        };
        let mut grants = self.grants.lock().await;
        grants.retain(|_, g| g.expires > Instant::now());
        if grants.len() >= 1024 {
            return Err(Error::new(
                "media_grant_limit",
                "Close an existing playback session before opening another.",
            ));
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        grants.insert(
            id.clone(),
            Grant {
                source,
                scope,
                generation: self.generation.load(Ordering::SeqCst),
                transform,
                expires: Instant::now() + Duration::from_secs(4 * 60 * 60),
            },
        );
        Ok(format!("http://127.0.0.1:{}/media/{id}", self.port))
    }
    async fn valid(&self, grant: &Grant) -> bool {
        if grant.expires <= Instant::now()
            || grant.generation != self.generation.load(Ordering::SeqCst)
        {
            return false;
        }
        match &grant.scope {
            Scope::Remote { epoch } => self.remote.epoch() == *epoch,
            Scope::Iptv(scope) => self.iptv.validate_scope(scope).await.is_ok(),
            Scope::Local { profile, revision } => {
                let store = self.store.lock().await;
                store.revision == *revision && store.require_active(Some(profile)).is_ok()
            }
        }
    }
    pub async fn local_resource(
        &self,
        source: &str,
        transform: &Transform,
        profile: &str,
        revision: i64,
    ) -> Result<(Vec<u8>, &'static str)> {
        let path = {
            let store = self.store.lock().await;
            store.require_active(Some(profile))?;
            if store.revision != revision {
                return Err(Error::new(
                    "stale_resource",
                    "The resource belongs to an earlier profile session.",
                ));
            }
            store.authorize_media(source)?
        };
        let generation = self.generation.load(Ordering::SeqCst);
        let result = self.tools.convert(&path, transform).await?;
        let store = self.store.lock().await;
        store.require_active(Some(profile))?;
        if store.revision != revision || self.generation.load(Ordering::SeqCst) != generation {
            return Err(Error::new(
                "stale_resource",
                "The active media session changed.",
            ));
        }
        Ok(result)
    }
    pub async fn shutdown(&self) {
        self.revoke_all().await;
        self.tools.shutdown().await;
    }
    pub async fn revoke_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.grants.lock().await.clear();
    }
    fn resource_cipher(&self) -> Result<aead::LessSafeKey> {
        aead::UnboundKey::new(&aead::AES_256_GCM, &self.resource_key)
            .map(aead::LessSafeKey::new)
            .map_err(|_| {
                Error::new(
                    "resource_unavailable",
                    "The media resource could not be prepared.",
                )
            })
    }
    fn resource_url(&self, id: &str, source: &str) -> Result<String> {
        // Keep upstream query credentials out of renderer-visible URLs.
        let mut nonce = [0; 12];
        SystemRandom::new().fill(&mut nonce).map_err(|_| {
            Error::new(
                "resource_unavailable",
                "The media resource could not be prepared.",
            )
        })?;
        let mut payload = source.as_bytes().to_vec();
        self.resource_cipher()?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(id.as_bytes()),
                &mut payload,
            )
            .map_err(|_| {
                Error::new(
                    "resource_unavailable",
                    "The media resource could not be prepared.",
                )
            })?;
        let mut sealed = nonce.to_vec();
        sealed.extend(payload);
        let reference = URL_SAFE_NO_PAD.encode(sealed);
        Ok(format!(
            "http://127.0.0.1:{}/media/{id}/resource/{reference}",
            self.port
        ))
    }
}
async fn deliver_resource(
    State(server): State<MediaServer>,
    Path((id, reference)): Path<(String, String)>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Response {
    if reference.len() > 24_000 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let sealed = match URL_SAFE_NO_PAD.decode(reference) {
        Ok(value) if value.len() >= 28 => value,
        _ => return StatusCode::FORBIDDEN.into_response(),
    };
    let mut nonce = [0; 12];
    nonce.copy_from_slice(&sealed[..12]);
    let mut payload = sealed[12..].to_vec();
    let source = server.resource_cipher().ok().and_then(|cipher| {
        cipher
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(id.as_bytes()),
                &mut payload,
            )
            .ok()
            .and_then(|bytes| std::str::from_utf8(bytes).ok().map(str::to_owned))
    });
    let Some(source) = source else {
        return StatusCode::FORBIDDEN.into_response();
    };
    match deliver_inner(server, id, headers, method, Some(source)).await {
        Ok(response) => response,
        Err(status) => status.into_response(),
    }
}
async fn deliver(
    State(server): State<MediaServer>,
    Path(id): Path<String>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Response {
    match deliver_inner(server, id, headers, method, None).await {
        Ok(response) => response,
        Err(status) => status.into_response(),
    }
}
async fn deliver_inner(
    server: MediaServer,
    id: String,
    headers: HeaderMap,
    method: axum::http::Method,
    resource: Option<String>,
) -> std::result::Result<Response, StatusCode> {
    if headers.get(header::HOST).and_then(|v| v.to_str().ok())
        != Some(format!("127.0.0.1:{}", server.port).as_str())
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut grant = server
        .grants
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !server.valid(&grant).await {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(resource) = resource {
        if !matches!(grant.scope, Scope::Remote { .. } | Scope::Iptv(_)) {
            return Err(StatusCode::FORBIDDEN);
        }
        grant.source = resource;
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    if let Scope::Iptv(scope) = &grant.scope {
        let mut upstream = server
            .iptv
            .fetch(scope, &grant.source, method.as_str(), range)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let playlist = upstream
            .is_hls_playlist()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let mut response = Response::builder()
            .status(upstream.status)
            .header(header::CACHE_CONTROL, "private, no-store")
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff");
        if playlist {
            let final_url = upstream.final_url.to_string();
            let bytes = upstream
                .body
                .read_manifest()
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| StatusCode::BAD_GATEWAY)?;
            let body = crate::hls::rewrite(text, &mut |reference| {
                let resolved = crate::iptv_proxy::resolve_hls_reference(reference, &final_url)?
                    .ok_or_else(|| {
                        Error::new(
                            "invalid_playlist_resource",
                            "The live TV playlist contains an unsupported resource.",
                        )
                    })?;
                server.resource_url(&id, &resolved)
            })
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
            if !server.valid(&grant).await {
                return Err(StatusCode::FORBIDDEN);
            }
            return response
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .header(header::CONTENT_LENGTH, body.len())
                .body(Body::from(body))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
        }
        for (name, value) in &upstream.headers {
            response = response.header(name, value);
        }
        let body = if method == axum::http::Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(futures_util::stream::try_unfold(
                (upstream.body, server, grant),
                |(mut body, server, grant)| async move {
                    if !server.valid(&grant).await {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "The media grant expired.",
                        ));
                    }
                    let next = body.next_chunk().await.map_err(std::io::Error::other)?;
                    if !server.valid(&grant).await {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "The media grant expired.",
                        ));
                    }
                    Ok(next.map(|chunk| (chunk, (body, server, grant))))
                },
            ))
        };
        return response
            .body(body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    if let Scope::Remote { epoch } = grant.scope {
        let mut upstream = server
            .remote
            .fetch_media(&grant.source, method.as_str(), range, epoch)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if crate::hls::is_playlist(
            &grant.source,
            upstream
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
        ) && upstream.status().is_success()
        {
            let mut body = Vec::new();
            if method != axum::http::Method::HEAD {
                if upstream
                    .content_length()
                    .is_some_and(|size| size > crate::hls::MAX_PLAYLIST_BYTES as u64)
                {
                    return Err(StatusCode::PAYLOAD_TOO_LARGE);
                }
                while let Some(chunk) = upstream
                    .chunk()
                    .await
                    .map_err(|_| StatusCode::BAD_GATEWAY)?
                {
                    if !server.valid(&grant).await {
                        return Err(StatusCode::FORBIDDEN);
                    }
                    if body.len() + chunk.len() > crate::hls::MAX_PLAYLIST_BYTES {
                        return Err(StatusCode::PAYLOAD_TOO_LARGE);
                    }
                    body.extend_from_slice(&chunk);
                }
                let text = std::str::from_utf8(&body).map_err(|_| StatusCode::BAD_GATEWAY)?;
                let host = server
                    .remote
                    .media_base_url(epoch)
                    .await
                    .map_err(|_| StatusCode::FORBIDDEN)?;
                let base = host
                    .join(&grant.source)
                    .map_err(|_| StatusCode::BAD_GATEWAY)?;
                body = crate::hls::rewrite(text, &mut |reference| {
                    let resolved = base.join(reference).map_err(|_| {
                        Error::new(
                            "invalid_playlist_resource",
                            "The playlist resource URL is invalid.",
                        )
                    })?;
                    if resolved.origin() != host.origin()
                        || !resolved.username().is_empty()
                        || resolved.password().is_some()
                        || resolved.fragment().is_some()
                    {
                        return Err(Error::new(
                            "playlist_resource_forbidden",
                            "The remote playlist references an unrelated media host.",
                        ));
                    }
                    let path = format!(
                        "{}{}",
                        resolved.path(),
                        resolved
                            .query()
                            .map(|query| format!("?{query}"))
                            .unwrap_or_default()
                    );
                    let path = media_route(&format!("loomtv://remote{path}"))?;
                    server.resource_url(&id, &path)
                })
                .map_err(|_| StatusCode::BAD_GATEWAY)?
                .into_bytes();
            }
            if !server.valid(&grant).await {
                return Err(StatusCode::FORBIDDEN);
            }
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .header(header::CACHE_CONTROL, "private, no-store")
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Content-Type-Options", "nosniff");
            if method != axum::http::Method::HEAD {
                response = response.header(header::CONTENT_LENGTH, body.len());
            }
            return response
                .body(Body::from(body))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
        }
        let mut response = Response::builder()
            .status(upstream.status())
            .header(header::CACHE_CONTROL, "private, no-store")
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff");
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ] {
            if let Some(value) = upstream.headers().get(&name) {
                response = response.header(name, value);
            }
        }
        let body = if method == axum::http::Method::HEAD {
            Body::empty()
        } else {
            let stream = upstream.bytes_stream().then(move |chunk| {
                let server = server.clone();
                let grant = grant.clone();
                async move {
                    if !server.valid(&grant).await {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "The media grant expired.",
                        ));
                    }
                    chunk.map_err(std::io::Error::other)
                }
            });
            Body::from_stream(stream)
        };
        return response
            .body(body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    let path = server
        .store
        .lock()
        .await
        .authorize_media(&grant.source)
        .map_err(|_| StatusCode::FORBIDDEN)?;
    if let Some(transform) = &grant.transform {
        let (bytes, content_type) = server
            .tools
            .convert(&path, transform)
            .await
            .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
        if !server.valid(&grant).await {
            return Err(StatusCode::FORBIDDEN);
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CACHE_CONTROL, "private, no-store")
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(if method == axum::http::Method::HEAD {
                Body::empty()
            } else {
                Body::from(bytes)
            })
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let size = file
        .metadata()
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .len();
    let (start, end, partial) = match parse_range(range, size) {
        Some(value) => value,
        None => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let body = if method == axum::http::Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(futures_util::stream::try_unfold(
            (file, length, server, grant),
            |(mut file, remaining, server, grant)| async move {
                if remaining == 0 {
                    return Ok(None);
                }
                if !server.valid(&grant).await {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "The media grant expired.",
                    ));
                }
                let mut bytes = vec![0; remaining.min(64 * 1024) as usize];
                let count = file.read(&mut bytes).await?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "The media file changed during playback.",
                    ));
                }
                bytes.truncate(count);
                Ok(Some((
                    Bytes::from(bytes),
                    (file, remaining - count as u64, server, grant),
                )))
            },
        ))
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type(&path))
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64, bool)> {
    let Some(header) = header else {
        return Some((0, size.saturating_sub(1), false));
    };
    if size == 0 {
        return None;
    }
    let range = header.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1, true));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    if start >= size || end < start {
        return None;
    }
    Some((start, end, true))
}

pub fn content_type(path: &std::path::Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
}
