use crate::{Error, Result};
use futures_util::future::join_all;
use reqwest::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::{Client, Method, Request, Response, StatusCode};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONCURRENCY_WAIT: Duration = Duration::from_secs(10);
const PINNED_CLIENT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CONCURRENT_REQUESTS: usize = 8;
const DEFAULT_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const ANILIST_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
const MAX_URL_BYTES: usize = 32 * 1024;
const MAX_QUERY_ENTRIES: usize = 64;
const MAX_QUERY_KEY_BYTES: usize = 256;
const MAX_QUERY_VALUE_BYTES: usize = 30_000;
const MAX_CREDENTIAL_BYTES: usize = 8 * 1024;
const MAX_VARIABLE_DEPTH: usize = 32;
const MAX_VARIABLE_NODES: usize = 10_000;

const OMDB_URL: &str = "https://www.omdbapi.com/";
const OMDB_HOST: &str = "www.omdbapi.com";
const TMDB_API_ROOT: &str = "https://api.themoviedb.org/3/";
const TMDB_CONFIGURATION_URL: &str = "https://api.themoviedb.org/3/configuration";
const TMDB_HOST: &str = "api.themoviedb.org";
const ANILIST_URL: &str = "https://graphql.anilist.co/";
const ANILIST_HOST: &str = "graphql.anilist.co";
const FANART_TEST_URL: &str = "https://webservice.fanart.tv/v3/movies/120";
const FANART_HOST: &str = "webservice.fanart.tv";
const OPEN_SUBTITLES_TEST_URL: &str = "https://api.opensubtitles.com/api/v1/infos/languages";
const OPEN_SUBTITLES_HOST: &str = "api.opensubtitles.com";
const TVDB_LOGIN_URL: &str = "https://api4.thetvdb.com/v4/login";
const TVDB_HOST: &str = "api4.thetvdb.com";

#[derive(Clone)]
pub struct MetadataProviderGateway {
    clients: Arc<ProviderClients>,
    permits: Arc<Semaphore>,
}

#[derive(Default)]
struct ProviderClients {
    tvmaze: Mutex<Option<PinnedClient>>,
    omdb: Mutex<Option<PinnedClient>>,
    tmdb: Mutex<Option<PinnedClient>>,
    anilist: Mutex<Option<PinnedClient>>,
    fanart: Mutex<Option<PinnedClient>>,
    open_subtitles: Mutex<Option<PinnedClient>>,
    tvdb: Mutex<Option<PinnedClient>>,
}

impl ProviderClients {
    fn slot(&self, hostname: &str) -> Result<&Mutex<Option<PinnedClient>>> {
        match hostname {
            "api.tvmaze.com" => Ok(&self.tvmaze),
            OMDB_HOST => Ok(&self.omdb),
            TMDB_HOST => Ok(&self.tmdb),
            ANILIST_HOST => Ok(&self.anilist),
            FANART_HOST => Ok(&self.fanart),
            OPEN_SUBTITLES_HOST => Ok(&self.open_subtitles),
            TVDB_HOST => Ok(&self.tvdb),
            _ => Err(metadata_error(
                "metadata_host_forbidden",
                "The metadata provider host is not allowed.",
            )),
        }
    }
}

struct PinnedClient {
    client: Client,
    expires_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataKeyTestResult {
    pub provider: String,
    pub ok: bool,
    pub message: String,
}

struct BufferedResponse {
    status: StatusCode,
    body: Vec<u8>,
}

fn metadata_error(code: &str, message: impl Into<String>) -> Error {
    Error::new(code, message)
}

fn invalid(message: impl Into<String>) -> Error {
    metadata_error("invalid_argument", message)
}

fn transport_error() -> Error {
    metadata_error(
        "metadata_transport",
        "The metadata provider request failed.",
    )
}

fn response_too_large() -> Error {
    metadata_error(
        "metadata_response_too_large",
        "The metadata provider response is too large.",
    )
}

fn invalid_response() -> Error {
    metadata_error(
        "metadata_invalid_response",
        "The metadata provider returned invalid JSON.",
    )
}

fn provider_http_error(provider: &str, status: StatusCode) -> Error {
    metadata_error(
        "metadata_http_error",
        format!("{provider} request failed with status {}.", status.as_u16()),
    )
}

impl MetadataProviderGateway {
    pub fn new() -> Result<Self> {
        Ok(Self {
            clients: Arc::new(ProviderClients::default()),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
        })
    }

    async fn client_for(&self, hostname: &str) -> Result<Client> {
        let mut cached = self.clients.slot(hostname)?.lock().await;
        let now = Instant::now();
        if let Some(client) = cached.as_ref().filter(|client| client.expires_at > now) {
            return Ok(client.client.clone());
        }
        let client = pinned_client(hostname).await?;
        *cached = Some(PinnedClient {
            client: client.clone(),
            expires_at: now + PINNED_CLIENT_TTL,
        });
        Ok(client)
    }

    pub async fn request_metadata_provider(
        &self,
        request: &Value,
        settings: &Value,
    ) -> Result<Value> {
        let settings = settings
            .as_object()
            .ok_or_else(|| invalid("Metadata settings must be an object."))?;
        if settings
            .get("metadataOfflineMode")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(metadata_error(
                "metadata_offline",
                "Metadata offline mode is enabled. Turn it off to contact metadata providers.",
            ));
        }

        let input = request
            .as_object()
            .ok_or_else(|| invalid("The metadata provider request must be an object."))?;
        let provider = required_string(input, "provider", 32, false)?;
        match provider.as_str() {
            "tvmaze" => self.request_tvmaze(input).await,
            "omdb" => self.request_omdb(input, settings).await,
            "tmdb" => self.request_tmdb(input, settings).await,
            "anilist" => self.request_anilist(input).await,
            _ => Err(invalid("The metadata provider is not supported.")),
        }
    }

    pub async fn test_metadata_keys(
        &self,
        keys: &Value,
        offline_mode: bool,
    ) -> Result<Vec<MetadataKeyTestResult>> {
        if offline_mode {
            return Err(metadata_error(
                "metadata_offline",
                "Metadata offline mode is enabled. Turn it off to contact metadata providers.",
            ));
        }
        let keys = keys
            .as_object()
            .ok_or_else(|| invalid("Metadata API keys must be an object."))?;
        if keys.len() > MAX_QUERY_ENTRIES {
            return Err(invalid("Too many metadata API keys were supplied."));
        }

        let mut cleaned = BTreeMap::new();
        for (provider, value) in keys {
            if provider.len() > MAX_QUERY_KEY_BYTES || provider.chars().any(char::is_control) {
                return Err(invalid("A metadata provider name is invalid."));
            }
            let value = value
                .as_str()
                .ok_or_else(|| invalid("Every metadata API key must be a string."))?
                .trim();
            let provider = normalize_provider_id(provider);
            if provider.is_empty() || value.is_empty() {
                continue;
            }
            validate_credential(value)?;
            cleaned.insert(provider, value.to_owned());
        }

        Ok(
            join_all(cleaned.into_iter().map(|(provider, value)| async move {
                match self.test_key(&provider, &value).await {
                    Ok(result) => result,
                    Err(error) => MetadataKeyTestResult {
                        provider,
                        ok: false,
                        message: error.message,
                    },
                }
            }))
            .await,
        )
    }

    async fn request_tvmaze(&self, input: &Map<String, Value>) -> Result<Value> {
        let path = required_string(input, "path", 120, true)?;
        let parts: Vec<_> = path.split('/').collect();
        let allowed = path == "search/shows" || (parts.len() >= 2
            && parts[0] == "shows" && !parts[1].is_empty()
            && parts[1].bytes().all(|byte| byte.is_ascii_digit())
            && (parts.len() == 2 || (parts.len() == 3
                && matches!(parts[2], "episodes" | "cast" | "images"))));
        if !allowed { return Err(invalid("TVmaze path is not allowed.")); }
        let mut url = fixed_url(&format!("https://api.tvmaze.com/{path}"))?;
        for (key, value) in optional_query(input, "query")? {
            if !matches!(key.as_str(), "q" | "embed" | "specials") {
                return Err(invalid("TVmaze query is not allowed."));
            }
            url.query_pairs_mut().append_pair(&key, &value);
        }
        validate_url_size(&url)?;
        self.send_json(Request::new(Method::GET, url), "TVmaze", DEFAULT_RESPONSE_BYTES, 2).await
    }

    async fn request_omdb(
        &self,
        input: &Map<String, Value>,
        settings: &Map<String, Value>,
    ) -> Result<Value> {
        let query = required_query(input, "query")?;
        let credential = metadata_key(settings, "omdb", "omdbApiKey")?.ok_or_else(|| {
            metadata_error("metadata_missing_credential", "OMDb API key is missing.")
        })?;
        let mut url = fixed_url(OMDB_URL)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                if key != "apikey" {
                    pairs.append_pair(&key, &value);
                }
            }
            pairs.append_pair("apikey", &credential);
        }
        validate_url_size(&url)?;
        let request = Request::new(Method::GET, url);
        self.send_json(request, "OMDb", DEFAULT_RESPONSE_BYTES, 2)
            .await
    }

    async fn request_tmdb(
        &self,
        input: &Map<String, Value>,
        settings: &Map<String, Value>,
    ) -> Result<Value> {
        let path = required_string(input, "path", 240, true)?;
        if path.contains("..")
            || !path
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'/' | b'-'))
        {
            return Err(invalid("TMDB path is not allowed."));
        }
        let query = optional_query(input, "query")?;
        let credential = metadata_key(settings, "tmdb", "tmdbApiKey")?.ok_or_else(|| {
            metadata_error("metadata_missing_credential", "TMDB API key is missing.")
        })?;
        let mut url = fixed_url(&format!("{TMDB_API_ROOT}{path}"))?;
        {
            let mut pairs = url.query_pairs_mut();
            if !query.iter().any(|(key, _)| key == "language") {
                pairs.append_pair("language", "en-US");
            }
            for (key, value) in query {
                if key != "api_key" {
                    pairs.append_pair(&key, &value);
                }
            }
            if !is_tmdb_read_access_token(&credential) {
                pairs.append_pair("api_key", &credential);
            }
        }
        validate_url_size(&url)?;
        let mut request = Request::new(Method::GET, url);
        if is_tmdb_read_access_token(&credential) {
            insert_sensitive_header(&mut request, AUTHORIZATION, &format!("Bearer {credential}"))?;
        }
        self.send_json(request, "TMDB", DEFAULT_RESPONSE_BYTES, 2)
            .await
    }

    async fn request_anilist(&self, input: &Map<String, Value>) -> Result<Value> {
        let query = required_string(input, "query", 30_000, true)?;
        let variables = match input.get("variables") {
            None => None,
            Some(Value::Object(value)) => {
                let value = Value::Object(value.clone());
                validate_variables(&value)?;
                Some(value)
            }
            Some(_) => return Err(invalid("AniList variables must be an object.")),
        };
        let mut body = Map::new();
        body.insert("query".to_owned(), Value::String(query));
        if let Some(variables) = variables {
            body.insert("variables".to_owned(), variables);
        }
        let body = serde_json::to_vec(&Value::Object(body)).map_err(|_| invalid_response())?;
        if body.len() > MAX_REQUEST_BODY_BYTES {
            return Err(invalid("The AniList request body is too large."));
        }
        let request = json_post_request(fixed_url(ANILIST_URL)?, body);
        self.send_json(request, "AniList", ANILIST_RESPONSE_BYTES, 0)
            .await
    }

    async fn send_json(
        &self,
        request: Request,
        provider: &str,
        max_bytes: usize,
        retries: usize,
    ) -> Result<Value> {
        let response = self.execute(request, max_bytes, retries).await?;
        if !response.status.is_success() {
            return Err(provider_http_error(provider, response.status));
        }
        serde_json::from_slice(&response.body).map_err(|_| invalid_response())
    }

    async fn execute(
        &self,
        request: Request,
        max_bytes: usize,
        retries: usize,
    ) -> Result<BufferedResponse> {
        let permit = tokio::time::timeout(CONCURRENCY_WAIT, self.permits.clone().acquire_owned())
            .await
            .map_err(|_| {
                metadata_error(
                    "metadata_busy",
                    "Too many metadata provider requests are in progress.",
                )
            })?
            .map_err(|_| transport_error())?;
        let hostname = request
            .url()
            .host_str()
            .ok_or_else(transport_error)?
            .to_owned();
        let client = self.client_for(&hostname).await?;

        let retryable_method = request.method() == Method::GET || request.method() == Method::HEAD;
        for attempt in 0..=retries {
            let next = request.try_clone().ok_or_else(transport_error)?;
            let response = client.execute(next).await.map_err(|_| transport_error())?;
            let status = response.status();
            if retryable_method
                && (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                && attempt < retries
            {
                drop(response);
                tokio::time::sleep(Duration::from_millis(250 * (1_u64 << attempt))).await;
                continue;
            }
            let result = read_bounded(response, max_bytes).await;
            drop(permit);
            return result;
        }
        drop(permit);
        Err(transport_error())
    }

    async fn test_key(&self, provider: &str, value: &str) -> Result<MetadataKeyTestResult> {
        match provider {
            "tmdb" => self.test_tmdb_key(value).await,
            "omdb" => self.test_omdb_key(value).await,
            "fanart" => self.test_fanart_key(value).await,
            "opensubtitles" => self.test_open_subtitles_key(value).await,
            "tvdb" => self.test_tvdb_key(value).await,
            _ => Ok(key_result(
                provider,
                false,
                "No built-in test for this provider.",
            )),
        }
    }

    async fn test_tmdb_key(&self, value: &str) -> Result<MetadataKeyTestResult> {
        let value = value.trim();
        let credential = value
            .get(..7)
            .filter(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
            .map(|_| &value[7..])
            .unwrap_or(value);
        if credential.is_empty() {
            return Ok(key_result("tmdb", false, "Missing key."));
        }
        let mut url = fixed_url(TMDB_CONFIGURATION_URL)?;
        let bearer = is_tmdb_read_access_token(credential);
        if !bearer {
            url.query_pairs_mut().append_pair("api_key", credential);
        }
        let mut request = Request::new(Method::GET, url);
        if bearer {
            insert_sensitive_header(&mut request, AUTHORIZATION, &format!("Bearer {credential}"))?;
        }
        let response = self.execute(request, DEFAULT_RESPONSE_BYTES, 0).await?;
        Ok(key_result(
            "tmdb",
            response.status.is_success(),
            if response.status.is_success() {
                "TMDB key works.".to_owned()
            } else {
                format!("TMDB returned {}.", response.status.as_u16())
            },
        ))
    }

    async fn test_omdb_key(&self, value: &str) -> Result<MetadataKeyTestResult> {
        let mut url = fixed_url(OMDB_URL)?;
        url.query_pairs_mut()
            .append_pair("apikey", value)
            .append_pair("i", "tt0133093");
        let request = Request::new(Method::GET, url);
        let response = self.execute(request, DEFAULT_RESPONSE_BYTES, 0).await?;
        let payload: Value = serde_json::from_slice(&response.body).unwrap_or_else(|_| json!({}));
        let rejected = payload.get("Response").and_then(Value::as_str) == Some("False");
        let ok = response.status.is_success() && !rejected;
        let message = if ok {
            "OMDb key works.".to_owned()
        } else if let Some(message) = payload.get("Error").and_then(Value::as_str) {
            safe_provider_message(message, value, "OMDb rejected that key.")
        } else {
            format!("OMDb returned {}.", response.status.as_u16())
        };
        Ok(key_result("omdb", ok, message))
    }

    async fn test_fanart_key(&self, value: &str) -> Result<MetadataKeyTestResult> {
        let mut url = fixed_url(FANART_TEST_URL)?;
        url.query_pairs_mut().append_pair("api_key", value);
        let request = Request::new(Method::GET, url);
        let response = self.execute(request, DEFAULT_RESPONSE_BYTES, 0).await?;
        let ok = response.status.is_success();
        Ok(key_result(
            "fanart",
            ok,
            if ok {
                "Fanart.tv key works.".to_owned()
            } else {
                format!("Fanart.tv returned {}.", response.status.as_u16())
            },
        ))
    }

    async fn test_open_subtitles_key(&self, value: &str) -> Result<MetadataKeyTestResult> {
        let mut request = Request::new(Method::GET, fixed_url(OPEN_SUBTITLES_TEST_URL)?);
        insert_sensitive_header(&mut request, HeaderName::from_static("api-key"), value)?;
        request
            .headers_mut()
            .insert(USER_AGENT, HeaderValue::from_static("LoomTV v1"));
        let response = self.execute(request, DEFAULT_RESPONSE_BYTES, 0).await?;
        let ok = response.status.is_success();
        Ok(key_result(
            "opensubtitles",
            ok,
            if ok {
                "OpenSubtitles key works.".to_owned()
            } else {
                format!("OpenSubtitles returned {}.", response.status.as_u16())
            },
        ))
    }

    async fn test_tvdb_key(&self, value: &str) -> Result<MetadataKeyTestResult> {
        let body =
            serde_json::to_vec(&json!({ "apikey": value })).map_err(|_| invalid_response())?;
        let request = json_post_request(fixed_url(TVDB_LOGIN_URL)?, body);
        let response = self.execute(request, DEFAULT_RESPONSE_BYTES, 0).await?;
        let payload: Value = serde_json::from_slice(&response.body).unwrap_or_else(|_| json!({}));
        let token = payload
            .pointer("/data/token")
            .or_else(|| payload.get("token"))
            .and_then(Value::as_str)
            .is_some_and(|token| !token.is_empty());
        let ok = response.status.is_success() && token;
        let message = if ok {
            "TheTVDB key works.".to_owned()
        } else if matches!(
            response.status,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            "TheTVDB rejected that key.".to_owned()
        } else {
            format!("TheTVDB returned {}.", response.status.as_u16())
        };
        Ok(key_result("tvdb", ok, message))
    }
}

fn insert_sensitive_header(request: &mut Request, name: HeaderName, value: &str) -> Result<()> {
    let mut value =
        HeaderValue::from_str(value).map_err(|_| invalid("A metadata credential is invalid."))?;
    value.set_sensitive(true);
    request.headers_mut().insert(name, value);
    Ok(())
}

fn json_post_request(url: Url, body: Vec<u8>) -> Request {
    let mut request = Request::new(Method::POST, url);
    request
        .headers_mut()
        .insert(ACCEPT, HeaderValue::from_static("application/json"));
    request
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    *request.body_mut() = Some(body.into());
    request
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(REQUEST_TIMEOUT)
        .read_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .pool_max_idle_per_host(2)
}

async fn pinned_client(hostname: &str) -> Result<Client> {
    let addresses = resolve_public_addresses(hostname).await?;
    client_builder()
        .resolve_to_addrs(hostname, &addresses)
        .build()
        .map_err(|_| transport_error())
}

async fn resolve_public_addresses(hostname: &str) -> Result<Vec<SocketAddr>> {
    let mut addresses =
        tokio::time::timeout(REQUEST_TIMEOUT, tokio::net::lookup_host((hostname, 443)))
            .await
            .map_err(|_| transport_error())?
            .map_err(|_| transport_error())?
            .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public(address.ip())) {
        return Err(metadata_error(
            "metadata_address_forbidden",
            "The metadata provider resolved to a private or reserved address.",
        ));
    }
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 168)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    ipv6_prefix_contains(address, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
        && !ipv6_prefix_contains(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
        && !ipv6_prefix_contains(address, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
        && !ipv6_prefix_contains(address, Ipv6Addr::new(0x3ffe, 0, 0, 0, 0, 0, 0, 0), 16)
}

fn ipv6_prefix_contains(address: Ipv6Addr, network: Ipv6Addr, bits: u32) -> bool {
    let shift = 128 - bits;
    (u128::from(address) >> shift) == (u128::from(network) >> shift)
}

async fn read_bounded(mut response: Response, limit: usize) -> Result<BufferedResponse> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(response_too_large());
    }
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| transport_error())? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(response_too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(BufferedResponse { status, body })
}

fn fixed_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| transport_error())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(transport_error());
    }
    Ok(url)
}

fn validate_url_size(url: &Url) -> Result<()> {
    if url.as_str().len() > MAX_URL_BYTES {
        return Err(invalid("The metadata provider query is too large."));
    }
    Ok(())
}

fn required_string(
    input: &Map<String, Value>,
    key: &str,
    max_bytes: usize,
    trim: bool,
) -> Result<String> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("Metadata request field {key} must be a string.")))?;
    let value = if trim { value.trim() } else { value };
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(invalid(format!("Metadata request field {key} is invalid.")));
    }
    Ok(value.to_owned())
}

fn required_query(input: &Map<String, Value>, key: &str) -> Result<Vec<(String, String)>> {
    match input.get(key) {
        Some(Value::Object(query)) => parse_query(query),
        _ => Err(invalid(format!(
            "Metadata request field {key} must be an object."
        ))),
    }
}

fn optional_query(input: &Map<String, Value>, key: &str) -> Result<Vec<(String, String)>> {
    match input.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Object(query)) => parse_query(query),
        Some(_) => Err(invalid(format!(
            "Metadata request field {key} must be an object."
        ))),
    }
}

fn parse_query(query: &Map<String, Value>) -> Result<Vec<(String, String)>> {
    if query.len() > MAX_QUERY_ENTRIES {
        return Err(invalid("The metadata provider query has too many fields."));
    }
    query
        .iter()
        .map(|(key, value)| {
            if key.len() > MAX_QUERY_KEY_BYTES || key.chars().any(char::is_control) {
                return Err(invalid("A metadata provider query field name is invalid."));
            }
            let value = match value {
                Value::String(value)
                    if value.len() <= MAX_QUERY_VALUE_BYTES && !value.contains('\0') =>
                {
                    value.clone()
                }
                Value::Number(value) => value.to_string(),
                Value::Bool(value) => value.to_string(),
                _ => return Err(invalid(
                    "Metadata provider query values must be strings, finite numbers, or booleans.",
                )),
            };
            Ok((key.clone(), value))
        })
        .collect()
}

fn metadata_key(
    settings: &Map<String, Value>,
    provider: &str,
    legacy_key: &str,
) -> Result<Option<String>> {
    if let Some(keys) = settings.get("metadataApiKeys") {
        let keys = keys
            .as_object()
            .ok_or_else(|| invalid("metadataApiKeys must be an object."))?;
        if let Some(value) = keys.get(provider) {
            let value = value
                .as_str()
                .ok_or_else(|| invalid("A metadata API key must be a string."))?
                .trim();
            if !value.is_empty() {
                validate_credential(value)?;
                return Ok(Some(value.to_owned()));
            }
        }
    }
    if let Some(value) = settings.get(legacy_key) {
        let value = value
            .as_str()
            .ok_or_else(|| invalid("A metadata API key must be a string."))?
            .trim();
        if !value.is_empty() {
            validate_credential(value)?;
            return Ok(Some(value.to_owned()));
        }
    }
    Ok(None)
}

fn validate_credential(value: &str) -> Result<()> {
    if value.len() > MAX_CREDENTIAL_BYTES || value.chars().any(char::is_control) {
        return Err(invalid("A metadata API key is invalid."));
    }
    Ok(())
}

fn is_tmdb_read_access_token(value: &str) -> bool {
    let mut segments = value.split('.');
    let valid = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    matches!(
        (segments.next(), segments.next(), segments.next(), segments.next()),
        (Some(first), Some(second), Some(third), None)
            if valid(first) && valid(second) && valid(third)
    )
}

fn validate_variables(value: &Value) -> Result<()> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
        if depth > MAX_VARIABLE_DEPTH {
            return Err(invalid("AniList variables are nested too deeply."));
        }
        *nodes = nodes.saturating_add(1);
        if *nodes > MAX_VARIABLE_NODES {
            return Err(invalid("AniList variables contain too many values."));
        }
        match value {
            Value::String(value) if value.len() > MAX_QUERY_VALUE_BYTES || value.contains('\0') => {
                Err(invalid("An AniList variable string is invalid."))
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, depth + 1, nodes)?;
                }
                Ok(())
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if key.len() > MAX_QUERY_KEY_BYTES || key.chars().any(char::is_control) {
                        return Err(invalid("An AniList variable field name is invalid."));
                    }
                    visit(value, depth + 1, nodes)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    visit(value, 0, &mut 0)
}

fn normalize_provider_id(value: &str) -> String {
    let mut normalized = String::new();
    let mut replacing = false;
    for byte in value.trim().bytes() {
        let byte = byte.to_ascii_lowercase();
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') {
            normalized.push(char::from(byte));
            replacing = false;
        } else if !replacing {
            normalized.push('-');
            replacing = true;
        }
    }
    normalized.trim_matches('-').to_owned()
}

fn safe_provider_message(message: &str, credential: &str, fallback: &str) -> String {
    let message = message.trim();
    if message.is_empty()
        || message.len() > 240
        || message.contains(credential)
        || message.contains("http://")
        || message.contains("https://")
        || message.chars().any(char::is_control)
    {
        fallback.to_owned()
    } else {
        message.to_owned()
    }
}

fn key_result(
    provider: impl Into<String>,
    ok: bool,
    message: impl Into<String>,
) -> MetadataKeyTestResult {
    MetadataKeyTestResult {
        provider: provider.into(),
        ok,
        message: message.into(),
    }
}
