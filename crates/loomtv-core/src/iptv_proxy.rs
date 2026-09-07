use crate::{
    iptv::{parse_fetch_url, pinned_request},
    Error, Result, Store,
};
use axum::body::Bytes;
use reqwest::{
    header::{
        HeaderMap, HeaderValue, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
        LOCATION,
    },
    Method, Response, StatusCode,
};
use rusqlite::OptionalExtension;
use std::{collections::VecDeque, sync::Arc, time::Duration};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use url::Url;

const MAX_REFERENCE_CHARS: usize = 8_192;
const MAX_SOURCE_ID_CHARS: usize = 120;
const MAX_CHANNEL_ID_CHARS: usize = 2_048;
const MAX_RANGE_CHARS: usize = 128;
pub const IPTV_MANIFEST_MAX_BYTES: usize = 4 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);
const FETCH_CONCURRENCY: usize = 8;
const MAX_REDIRECTS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IptvPlaybackFormat {
    Hls,
    Direct,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IptvPlaybackScope {
    pub profile_id: String,
    pub selection_revision: i64,
}

#[derive(Clone, Debug)]
pub struct ResolvedIptvReference {
    pub source_id: String,
    pub channel_id: String,
    pub format: IptvPlaybackFormat,
    pub upstream_url: Url,
    pub scope: IptvPlaybackScope,
}

pub struct IptvProxyResponse {
    pub final_url: Url,
    pub status: StatusCode,
    /// Only response metadata that the loopback server may forward.
    /// The loopback server must replace Content-Length after an HLS rewrite.
    pub headers: HeaderMap,
    pub body: IptvProxyBody,
}

impl IptvProxyResponse {
    pub async fn is_hls_playlist(&mut self) -> Result<bool> {
        if !self.status.is_success() || self.body.method == Method::HEAD {
            return Ok(false);
        }
        let content_type = self
            .headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .unwrap_or("");
        let content_type_is_hls = [
            "application/vnd.apple.mpegurl",
            "application/x-mpegurl",
            "audio/vnd.apple.mpegurl",
            "audio/x-mpegurl",
        ]
        .iter()
        .any(|candidate| content_type.eq_ignore_ascii_case(candidate));
        let path = self.final_url.path().to_ascii_lowercase();
        let path_is_hls = path.ends_with(".m3u") || path.ends_with(".m3u8");
        let prefix = self.body.peek_prefix(256).await?;
        let prefix = String::from_utf8_lossy(&prefix);
        let body_is_hls = prefix
            .trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with("#EXTM3U");
        Ok(content_type_is_hls || path_is_hls || body_is_hls)
    }
}

pub struct IptvProxyBody {
    proxy: IptvProxy,
    scope: IptvPlaybackScope,
    method: Method,
    response: Response,
    buffered: VecDeque<Bytes>,
    ended: bool,
    _permit: OwnedSemaphorePermit,
}

impl IptvProxyBody {
    /// Read one upstream chunk while retaining the fetch concurrency permit.
    /// Continuous streams have no total lifetime ceiling; each idle read is
    /// bounded and every chunk is bound to the original profile selection.
    pub async fn next_chunk(&mut self) -> Result<Option<Bytes>> {
        self.proxy.validate_scope(&self.scope).await?;
        let chunk = if let Some(chunk) = self.buffered.pop_front() {
            Some(chunk)
        } else if self.ended {
            None
        } else {
            let chunk = tokio::time::timeout(FETCH_TIMEOUT, self.response.chunk())
                .await
                .map_err(|_| proxy_error("The live TV provider stopped responding."))?
                .map_err(|_| proxy_error("The live TV provider response could not be read."))?;
            if chunk.is_none() {
                self.ended = true;
            }
            chunk
        };
        self.proxy.validate_scope(&self.scope).await?;
        Ok(chunk)
    }

    /// Buffer an HLS manifest for URI rewriting. Direct streams and media
    /// segments must be relayed through `next_chunk`.
    pub async fn read_manifest(mut self) -> Result<Vec<u8>> {
        if self
            .response
            .content_length()
            .is_some_and(|length| length > IPTV_MANIFEST_MAX_BYTES as u64)
        {
            return Err(proxy_error("The live TV playlist is too large."));
        }
        let mut body = Vec::new();
        while let Some(chunk) = self.next_chunk().await? {
            if body.len().saturating_add(chunk.len()) > IPTV_MANIFEST_MAX_BYTES {
                return Err(proxy_error("The live TV playlist is too large."));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    async fn peek_prefix(&mut self, maximum: usize) -> Result<Vec<u8>> {
        while self.buffered.iter().map(|chunk| chunk.len()).sum::<usize>() < maximum && !self.ended
        {
            self.proxy.validate_scope(&self.scope).await?;
            let chunk = tokio::time::timeout(FETCH_TIMEOUT, self.response.chunk())
                .await
                .map_err(|_| proxy_error("The live TV provider stopped responding."))?
                .map_err(|_| proxy_error("The live TV provider response could not be read."))?;
            self.proxy.validate_scope(&self.scope).await?;
            match chunk {
                Some(chunk) => self.buffered.push_back(chunk),
                None => self.ended = true,
            }
        }
        Ok(self
            .buffered
            .iter()
            .flat_map(|chunk| chunk.iter().copied())
            .take(maximum)
            .collect())
    }
}

#[derive(Clone)]
pub struct IptvProxy {
    store: Arc<Mutex<Store>>,
    fetch_permits: Arc<Semaphore>,
}

impl IptvProxy {
    pub fn new(store: Arc<Mutex<Store>>) -> Self {
        Self {
            store,
            fetch_permits: Arc::new(Semaphore::new(FETCH_CONCURRENCY)),
        }
    }

    /// Resolve a renderer-safe IPTV reference to the stored channel URL and
    /// bind it to the current unlocked profile selection. IPTV is available to
    /// every active profile, including Kids profiles, as in the Electron app.
    pub async fn resolve_reference(&self, reference: &str) -> Result<ResolvedIptvReference> {
        let parsed = parse_playback_reference(reference)?;
        let store = self.store.lock().await;
        let profile_id = store.require_active(None)?;
        let selection_revision = store.selection_revision();
        let stream_url = store
            .db
            .query_row(
                "SELECT c.stream_url FROM iptv_channels c \
                 INNER JOIN iptv_sources s ON s.id=c.source_id \
                 WHERE c.source_id=? AND c.channel_id=?",
                [&parsed.source_id, &parsed.channel_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                Error::new(
                    "iptv_channel_not_found",
                    "That live TV channel is no longer available.",
                )
            })?;
        let upstream_url = parse_fetch_url(&stream_url)?;
        Ok(ResolvedIptvReference {
            source_id: parsed.source_id,
            channel_id: parsed.channel_id,
            format: parsed.format,
            upstream_url,
            scope: IptvPlaybackScope {
                profile_id,
                selection_revision,
            },
        })
    }

    /// Recheck a root or child resource against the profile selection that
    /// issued it. Call this for signed child resources before serving them.
    pub async fn validate_scope(&self, scope: &IptvPlaybackScope) -> Result<()> {
        let store = self.store.lock().await;
        store.require_active(Some(&scope.profile_id))?;
        if store.selection_revision() != scope.selection_revision {
            return Err(Error::new(
                "stale_profile_selection",
                "The live TV resource belongs to an earlier profile session.",
            ));
        }
        Ok(())
    }

    /// Fetch a root playlist, direct stream response, or signed HLS child.
    /// The scope check before and after the request prevents a response started
    /// under one profile selection from being released after a profile change.
    pub async fn fetch(
        &self,
        scope: &IptvPlaybackScope,
        upstream_url: &str,
        method: &str,
        range: Option<&str>,
    ) -> Result<IptvProxyResponse> {
        self.validate_scope(scope).await?;
        let url = parse_fetch_url(upstream_url)?;
        let method = parse_method(method)?;
        let range = parse_range(range)?;
        let permit =
            tokio::time::timeout(FETCH_TIMEOUT, self.fetch_permits.clone().acquire_owned())
                .await
                .map_err(|_| proxy_error("Too many live TV stream requests are in progress."))?
                .map_err(|_| proxy_error("The live TV stream service is unavailable."))?;
        let response = tokio::time::timeout(
            FETCH_OPERATION_TIMEOUT,
            fetch_with_retry(url, method, range),
        )
        .await
        .map_err(|_| proxy_error("The live TV provider took too long to respond."))??;
        self.validate_scope(scope).await?;
        Ok(IptvProxyResponse {
            final_url: response.final_url,
            status: response.status,
            headers: response.headers,
            body: IptvProxyBody {
                proxy: self.clone(),
                scope: scope.clone(),
                method: response.method,
                response: response.response,
                buffered: VecDeque::new(),
                ended: false,
                _permit: permit,
            },
        })
    }
}

struct ParsedReference {
    source_id: String,
    channel_id: String,
    format: IptvPlaybackFormat,
}

fn parse_playback_reference(reference: &str) -> Result<ParsedReference> {
    if reference.is_empty()
        || reference.chars().count() > MAX_REFERENCE_CHARS
        || reference.contains('\0')
    {
        return Err(invalid_reference());
    }
    let url = Url::parse(reference).map_err(|_| invalid_reference())?;
    if url.scheme() != "iptv"
        || url.host_str() != Some("channel")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(invalid_reference());
    }
    let segments = url
        .path_segments()
        .ok_or_else(invalid_reference)?
        .filter(|segment| !segment.is_empty())
        .map(percent_decode)
        .collect::<Result<Vec<_>>>()?;
    if segments.len() != 2 {
        return Err(invalid_reference());
    }
    validate_identifier(&segments[0], MAX_SOURCE_ID_CHARS)?;
    validate_identifier(&segments[1], MAX_CHANNEL_ID_CHARS)?;
    let format = if url
        .query_pairs()
        .find(|(key, _)| key == "format")
        .is_some_and(|(_, value)| value == "direct")
    {
        IptvPlaybackFormat::Direct
    } else {
        IptvPlaybackFormat::Hls
    };
    Ok(ParsedReference {
        source_id: segments[0].clone(),
        channel_id: segments[1].clone(),
        format,
    })
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(invalid_reference());
            }
            let high = hex(bytes[index + 1]).ok_or_else(invalid_reference)?;
            let low = hex(bytes[index + 2]).ok_or_else(invalid_reference)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| invalid_reference())
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn validate_identifier(value: &str, max_chars: usize) -> Result<()> {
    if value.is_empty() || value.chars().count() > max_chars || value.contains('\0') {
        return Err(invalid_reference());
    }
    Ok(())
}

fn invalid_reference() -> Error {
    Error::new(
        "invalid_iptv_reference",
        "The live TV playback reference is invalid.",
    )
}

fn parse_method(value: &str) -> Result<Method> {
    match value {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        _ => Err(Error::new(
            "invalid_iptv_method",
            "Live TV streams accept GET and HEAD requests only.",
        )),
    }
}

fn parse_range(value: Option<&str>) -> Result<Option<HeaderValue>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() || value.len() > MAX_RANGE_CHARS || !value.is_ascii() {
        return Err(invalid_range());
    }
    let Some(specification) = value.strip_prefix("bytes=") else {
        return Err(invalid_range());
    };
    if specification.contains(',') {
        return Err(invalid_range());
    }
    let Some((start, end)) = specification.split_once('-') else {
        return Err(invalid_range());
    };
    if start.is_empty() && end.is_empty()
        || !start.bytes().all(|byte| byte.is_ascii_digit())
        || !end.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid_range());
    }
    let start = if start.is_empty() {
        None
    } else {
        Some(start.parse::<u64>().map_err(|_| invalid_range())?)
    };
    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse::<u64>().map_err(|_| invalid_range())?)
    };
    if start.is_none() && end == Some(0) || start.zip(end).is_some_and(|(start, end)| start > end) {
        return Err(invalid_range());
    }
    HeaderValue::from_str(value)
        .map(Some)
        .map_err(|_| invalid_range())
}

fn invalid_range() -> Error {
    Error::new("invalid_iptv_range", "The live TV byte range is invalid.")
}

fn proxy_error(message: impl Into<String>) -> Error {
    let mut error = Error::new("iptv_proxy_failed", message);
    error.retryable = true;
    error
}

async fn fetch_with_retry(
    url: Url,
    method: Method,
    range: Option<HeaderValue>,
) -> Result<PendingResponse> {
    for attempt in 0..=1 {
        let response = fetch_attempt(url.clone(), method.clone(), range.clone()).await?;
        if (response.status == StatusCode::TOO_MANY_REQUESTS || response.status.is_server_error())
            && attempt == 0
        {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        return Ok(response);
    }
    Err(proxy_error("The live TV provider request failed."))
}

async fn fetch_attempt(
    mut url: Url,
    method: Method,
    range: Option<HeaderValue>,
) -> Result<PendingResponse> {
    for redirects in 0..=MAX_REDIRECTS {
        let response = pinned_request(
            url.clone(),
            method.clone(),
            range.clone(),
            FETCH_TIMEOUT,
            None,
        )
        .await
        .map_err(|_| proxy_error("The live TV provider request failed."))?;
        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(proxy_error(
                    "The live TV provider redirected too many times.",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| proxy_error("The live TV provider returned an invalid redirect."))?;
            let next = url
                .join(location)
                .map_err(|_| proxy_error("The live TV provider returned an invalid redirect."))?;
            url = parse_fetch_url(next.as_str())?;
            continue;
        }
        return Ok(PendingResponse {
            final_url: url,
            status: response.status(),
            headers: response_headers(response.headers()),
            method,
            response,
        });
    }
    Err(proxy_error(
        "The live TV provider redirected too many times.",
    ))
}

fn response_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
        if let Some(value) = upstream.get(&name) {
            headers.insert(name, value.clone());
        }
    }
    headers
}

struct PendingResponse {
    final_url: Url,
    status: StatusCode,
    headers: HeaderMap,
    method: Method,
    response: Response,
}

/// Resolve an HLS URI against the final playlist URL. Plain HTTP child
/// references fail the whole playlist; data and unsupported schemes are left
/// untouched by returning `None`.
pub fn resolve_hls_reference(reference: &str, playlist_url: &str) -> Result<Option<String>> {
    if reference.is_empty() || reference.starts_with("data:") {
        return Ok(None);
    }
    let playlist_url = parse_fetch_url(playlist_url)?;
    let resolved = playlist_url.join(reference).map_err(|_| {
        Error::new(
            "invalid_iptv_resource",
            "The live TV playlist contains an invalid media address.",
        )
    })?;
    if resolved.scheme() == "http" {
        return Err(Error::new(
            "insecure_iptv_resource",
            "The live TV playlist contains an insecure media address.",
        ));
    }
    if resolved.scheme() != "https" {
        return Ok(None);
    }
    parse_fetch_url(resolved.as_str()).map(|url| Some(url.to_string()))
}
