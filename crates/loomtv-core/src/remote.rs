use crate::{now, Error, Result};
use reqwest::{Client, Method, Response};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Mutex;
use url::Url;
use x509_parser::prelude::FromDer;

const MAX_BODY: usize = 16 * 1024;
const MAX_API: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    base_url: String,
    cert_fingerprint: String,
    device_id: String,
    access_token: String,
    refresh_token: String,
    access_token_expires_at: i64,
    refresh_token_expires_at: i64,
    host_device_id: Option<String>,
    host_device_name: Option<String>,
    client_device_name: String,
}
impl Session {
    fn public(&self, library: Option<Value>, etag: Option<Value>) -> Value {
        let mut result = json!({"baseUrl":self.base_url,"deviceId":self.device_id,"deviceToken":"","refreshToken":"","accessTokenExpiresAt":self.access_token_expires_at,"refreshTokenExpiresAt":self.refresh_token_expires_at,"library":library.unwrap_or(json!({"movies":[],"tvShows":[],"animeShows":[],"libraryFolders":[]})),"libraryEtag":etag.unwrap_or(json!(""))});
        if let Some(value) = &self.host_device_id {
            result["hostDeviceId"] = json!(value);
        }
        if let Some(value) = &self.host_device_name {
            result["hostDeviceName"] = json!(value);
        }
        result
    }
}
struct RemoteState {
    loaded: bool,
    session: Option<Session>,
    client: Option<Client>,
    addresses: Vec<SocketAddr>,
    load_failed: bool,
}
pub struct RemoteClient {
    state: Mutex<RemoteState>,
    epoch: AtomicU64,
}
impl Default for RemoteClient {
    fn default() -> Self {
        Self {
            state: Mutex::new(RemoteState {
                loaded: false,
                session: None,
                client: None,
                addresses: vec![],
                load_failed: false,
            }),
            epoch: AtomicU64::new(0),
        }
    }
}
fn remote_error(code: &str, message: &str) -> Error {
    Error::new(code, message)
}
fn transport_error(_: impl std::fmt::Display) -> Error {
    remote_error(
        "remote_transport",
        "The secure request to the LoomTV host failed.",
    )
}
fn credentials() -> Result<keyring::Entry> {
    keyring::Entry::new("com.mallenkb.loomtv.tauri", "remote-session-v2").map_err(|_| {
        remote_error(
            "secret_store_unavailable",
            "OS credential storage is unavailable.",
        )
    })
}
fn normalize_pin(value: &str) -> Result<String> {
    let value = value
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_lowercase();
    if value.len() != 64 {
        return Err(remote_error(
            "invalid_fingerprint",
            "The LoomTV certificate fingerprint is invalid.",
        ));
    }
    Ok(value)
}
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}
async fn addresses(url: &Url) -> Result<Vec<SocketAddr>> {
    let hostname = url
        .host_str()
        .ok_or_else(|| remote_error("invalid_host", "Enter a LoomTV host address."))?
        .trim_matches(['[', ']']);
    let port = url
        .port_or_known_default()
        .ok_or_else(|| remote_error("invalid_host", "Include the host's advertised port."))?;
    let mut addresses = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((hostname, port)),
    )
    .await
    .map_err(transport_error)?
    .map_err(transport_error)?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|a| !private(a.ip())) {
        return Err(remote_error(
            "remote_host_forbidden",
            "Remote libraries must use a private local-network address.",
        ));
    }
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}
fn base_url(value: &str) -> Result<Url> {
    let value = value.trim();
    let value = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&value).map_err(|_| {
        remote_error(
            "invalid_host",
            "Enter a secure LoomTV host address and port.",
        )
    })?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(remote_error(
            "invalid_host",
            "Enter only the secure host address and port.",
        ));
    }
    Ok(url)
}

#[derive(Debug)]
struct CertificateVerifier {
    pin: Option<String>,
}
impl ServerCertVerifier for CertificateVerifier {
    fn verify_server_cert(
        &self,
        certificate: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        time: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let (_, cert) = x509_parser::certificate::X509Certificate::from_der(certificate.as_ref())
            .map_err(|_| {
            rustls::Error::InvalidCertificate(rustls::CertificateError::BadEncoding)
        })?;
        let timestamp = time.as_secs() as i64;
        if cert.validity().not_before.timestamp() > timestamp
            || cert.validity().not_after.timestamp() <= timestamp
        {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::Expired,
            ));
        }
        if self.pin.as_ref().is_some_and(|expected| {
            *expected != format!("{:x}", Sha256::digest(certificate.as_ref()))
        }) {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::UnknownIssuer,
            ));
        }
        // Unpinned verification is used only by the certificate-only probe below. No HTTP data or secrets are sent on it.
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
fn tls(pin: Option<String>) -> Result<rustls::ClientConfig> {
    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(transport_error)?
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(CertificateVerifier { pin }))
    .with_no_client_auth())
}
async fn probe(url: &Url, addresses: &[SocketAddr]) -> Result<String> {
    let hostname = url
        .host_str()
        .ok_or_else(|| remote_error("invalid_host", "The host name is missing."))?
        .trim_matches(['[', ']']);
    let name = ServerName::try_from(hostname.to_owned()).map_err(transport_error)?;
    let socket = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect(addresses),
    )
    .await
    .map_err(transport_error)?
    .map_err(transport_error)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls(None)?));
    let stream = tokio::time::timeout(Duration::from_secs(10), connector.connect(name, socket))
        .await
        .map_err(transport_error)?
        .map_err(transport_error)?;
    let certificate = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .ok_or_else(|| {
            remote_error(
                "missing_certificate",
                "The LoomTV host did not provide a TLS certificate.",
            )
        })?;
    Ok(format!("{:x}", Sha256::digest(certificate.as_ref())))
}
fn client(url: &Url, pin: String, addresses: &[SocketAddr]) -> Result<Client> {
    let hostname = url
        .host_str()
        .ok_or_else(|| remote_error("invalid_host", "The host name is missing."))?
        .trim_matches(['[', ']']);
    Client::builder()
        .use_preconfigured_tls(tls(Some(pin))?)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .resolve_to_addrs(hostname, addresses)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .build()
        .map_err(transport_error)
}
pub async fn bounded_text(mut response: Response, limit: usize) -> Result<String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(remote_error(
            "response_too_large",
            "The host response is too large.",
        ));
    }
    let mut data = Vec::new();
    while let Some(bytes) = response.chunk().await.map_err(transport_error)? {
        if data.len() + bytes.len() > limit {
            return Err(remote_error(
                "response_too_large",
                "The host response is too large.",
            ));
        }
        data.extend_from_slice(&bytes);
    }
    String::from_utf8(data)
        .map_err(|_| remote_error("invalid_response", "The host returned invalid text."))
}
fn route(path: &str, method: &str, media: bool) -> Result<String> {
    let base = Url::parse("https://loomtv.invalid").map_err(transport_error)?;
    let parsed = base.join(path).map_err(transport_error)?;
    if parsed.origin() != base.origin() || parsed.fragment().is_some() {
        return Err(remote_error(
            "route_forbidden",
            "That remote-library route is not allowed.",
        ));
    }
    let allowed = if media {
        [
            "/stream",
            "/subtitle",
            "/api/thumbnail",
            "/api/embedded-thumbnail",
            "/api/local-image",
            "/api/cached-artwork",
            "/api/custom-artwork",
        ]
        .contains(&parsed.path())
            || parsed.path().starts_with("/hls/")
    } else {
        let methods: &[&str] = match parsed.path() {
            "/api/v2/library"
            | "/api/v2/library/index"
            | "/api/v2/profiles/active"
            | "/api/v2/playback/segments" => &["GET"],
            "/api/v2/profiles" | "/api/v2/progress" | "/api/v2/playback-track-preferences" => {
                &["GET", "POST"]
            }
            "/api/v2/profiles/select"
            | "/api/v2/profiles/lock"
            | "/api/v2/profiles/auto-sign-in"
            | "/api/v2/start-hls"
            | "/api/v2/playback-plan" => &["POST"],
            "/api/v2/profile-preferences" => &["GET", "PATCH"],
            "/api/v2/profile-lists" => &["GET", "PUT", "DELETE"],
            value if value.starts_with("/api/v2/library/items/") => &["GET"],
            _ => &[],
        };
        methods.contains(&method)
    };
    if !allowed {
        return Err(remote_error(
            "route_forbidden",
            "That remote-library operation is not allowed.",
        ));
    }
    Ok(format!(
        "{}{}",
        parsed.path(),
        parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
    ))
}

impl RemoteClient {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    pub async fn media_base_url(&self, expected_epoch: u64) -> Result<Url> {
        let mut state = self.state.lock().await;
        Self::load(&mut state).await?;
        if self.epoch() != expected_epoch {
            return Err(remote_error(
                "stale_remote_session",
                "The remote profile or host changed.",
            ));
        }
        let session = state.session.as_ref().ok_or_else(|| {
            remote_error(
                "pairing_required",
                "Connect to a LoomTV host before opening media.",
            )
        })?;
        base_url(&session.base_url)
    }
    async fn load(state: &mut RemoteState) -> Result<()> {
        if state.loaded {
            return Ok(());
        }
        let saved = tokio::task::spawn_blocking(|| {
            credentials()?.get_password().map_err(|error| match error {
                keyring::Error::NoEntry => remote_error("no_session", "No saved pairing exists."),
                _ => remote_error(
                    "secret_store_unavailable",
                    "The saved pairing could not be read.",
                ),
            })
        })
        .await
        .map_err(transport_error)?;
        state.loaded = true;
        match saved {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(session) => state.session = Some(session),
                Err(_) => state.load_failed = true,
            },
            Err(error) if error.code == "no_session" => {}
            Err(_) => {
                state.load_failed = true;
            }
        }
        Ok(())
    }
    async fn persist(session: &Session) -> Result<()> {
        let text = serde_json::to_string(session)?;
        tokio::task::spawn_blocking(move || {
            credentials()?.set_password(&text).map_err(|_| {
                remote_error(
                    "secret_store_unavailable",
                    "The pairing credentials could not be saved.",
                )
            })
        })
        .await
        .map_err(transport_error)?
    }
    pub async fn session(&self) -> Result<Value> {
        let mut state = self.state.lock().await;
        Self::load(&mut state).await?;
        Ok(if let Some(session) = &state.session {
            json!({"status":"connected","connection":session.public(None,None)})
        } else if state.load_failed {
            json!({"status":"pairing-required","reason":"The saved pairing credentials could not be read."})
        } else {
            json!({"status":"none"})
        })
    }
    pub async fn connect(
        &self,
        base: &str,
        code: &str,
        expected: Option<&str>,
        device_name: &str,
    ) -> Result<Value> {
        if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(remote_error(
                "invalid_pairing_code",
                "Enter the 6-digit pairing PIN.",
            ));
        }
        let mut state = self.state.lock().await;
        let url = base_url(base)?;
        let addresses = addresses(&url).await?;
        let fingerprint = probe(&url, &addresses).await?;
        if let Some(expected) = expected {
            if normalize_pin(expected)? != fingerprint {
                return Err(remote_error(
                    "certificate_changed",
                    "The discovered host certificate changed before pairing.",
                ));
            }
        }
        let client = client(&url, fingerprint.clone(), &addresses)?;
        let response = client
            .post(url.join("/api/v2/pair").map_err(transport_error)?)
            .header("X-Loom-Profile-Api-Version", "1")
            .json(&json!({"code":code,"deviceName":device_name}))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(remote_error(
                "pairing_failed",
                "The host did not accept the pairing request. Check the PIN and try again.",
            ));
        }
        let payload: Value = serde_json::from_str(&bounded_text(response, MAX_API).await?)?;
        let field = |name: &str| {
            payload[name]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() < 16_384)
                .map(str::to_owned)
                .ok_or_else(|| {
                    remote_error(
                        "invalid_pairing_response",
                        "The host returned invalid pairing credentials.",
                    )
                })
        };
        if normalize_pin(&field("certFingerprint")?)? != fingerprint {
            return Err(remote_error(
                "certificate_changed",
                "The host TLS identity changed during pairing.",
            ));
        }
        let session = Session {
            base_url: url.origin().ascii_serialization(),
            cert_fingerprint: fingerprint,
            device_id: field("deviceId")?,
            access_token: field("accessToken")?,
            refresh_token: field("refreshToken")?,
            access_token_expires_at: payload["accessTokenExpiresAt"]
                .as_i64()
                .filter(|v| *v > now())
                .ok_or_else(|| {
                    remote_error(
                        "invalid_pairing_response",
                        "The host returned expired credentials.",
                    )
                })?,
            refresh_token_expires_at: payload["refreshTokenExpiresAt"]
                .as_i64()
                .filter(|v| *v > now())
                .ok_or_else(|| {
                    remote_error(
                        "invalid_pairing_response",
                        "The host returned expired credentials.",
                    )
                })?,
            host_device_id: payload["hostDeviceId"].as_str().map(str::to_owned),
            host_device_name: payload["hostDeviceName"].as_str().map(str::to_owned),
            client_device_name: device_name.into(),
        };
        Self::persist(&session).await?;
        let public = session.public(
            payload.get("library").cloned(),
            payload.get("libraryEtag").cloned(),
        );
        state.session = Some(session);
        state.client = Some(client);
        state.addresses = addresses;
        state.loaded = true;
        state.load_failed = false;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(public)
    }
    async fn current(state: &mut RemoteState) -> Result<(Session, Client)> {
        Self::load(state).await?;
        let session = state.session.clone().ok_or_else(|| {
            remote_error("pairing_required", "Pair this desktop with a LoomTV host.")
        })?;
        let url = base_url(&session.base_url)?;
        let current_addresses = addresses(&url).await?;
        if state.client.is_none() || state.addresses != current_addresses {
            state.client = Some(client(
                &url,
                normalize_pin(&session.cert_fingerprint)?,
                &current_addresses,
            )?);
            state.addresses = current_addresses;
        }
        let client = state.client.clone().ok_or_else(|| {
            remote_error(
                "remote_transport",
                "The remote connection could not be created.",
            )
        })?;
        Ok((session, client))
    }
    async fn refresh(state: &mut RemoteState) -> Result<()> {
        let (mut session, client) = Self::current(state).await?;
        if session.refresh_token_expires_at <= now() {
            return Err(remote_error(
                "pairing_required",
                "The pairing expired. Pair this desktop again.",
            ));
        }
        let response=client.post(format!("{}/api/v2/auth/refresh",session.base_url)).header("X-Loom-Profile-Api-Version","1").json(&json!({"refreshToken":session.refresh_token,"deviceName":session.client_device_name})).timeout(Duration::from_secs(20)).send().await.map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(remote_error(
                "pairing_required",
                "The host did not refresh the pairing credentials.",
            ));
        }
        let payload: Value = serde_json::from_str(&bounded_text(response, 256 * 1024).await?)?;
        session.access_token = payload["accessToken"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                remote_error("invalid_response", "The refreshed credentials are invalid.")
            })?
            .into();
        session.refresh_token = payload["refreshToken"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                remote_error("invalid_response", "The refreshed credentials are invalid.")
            })?
            .into();
        session.access_token_expires_at = payload["accessTokenExpiresAt"]
            .as_i64()
            .filter(|v| *v > now())
            .ok_or_else(|| {
                remote_error("invalid_response", "The refreshed credentials expired.")
            })?;
        session.refresh_token_expires_at = payload["refreshTokenExpiresAt"]
            .as_i64()
            .filter(|v| *v > now())
            .ok_or_else(|| {
                remote_error("invalid_response", "The refreshed credentials expired.")
            })?;
        Self::persist(&session).await?;
        state.session = Some(session);
        Ok(())
    }
    pub async fn request(&self, path: &str, request: Value) -> Result<Value> {
        let method = request["method"].as_str().unwrap_or("GET");
        let path = route(path, method, false)?;
        let body = request["body"].as_str().unwrap_or("");
        if body.len() > MAX_BODY {
            return Err(remote_error(
                "request_too_large",
                "The remote request is too large.",
            ));
        }
        let mut state = self.state.lock().await;
        let (session, _) = Self::current(&mut state).await?;
        if session.access_token_expires_at <= now() + 60_000 {
            Self::refresh(&mut state).await?;
        }
        let mut response = None;
        for attempt in 0..2 {
            let (session, client) = Self::current(&mut state).await?;
            let mut builder = client
                .request(
                    Method::from_bytes(method.as_bytes()).map_err(transport_error)?,
                    format!("{}{path}", session.base_url),
                )
                .bearer_auth(&session.access_token)
                .header("X-Loom-Profile-Api-Version", "1")
                .timeout(Duration::from_secs(20));
            for header in ["content-type", "if-none-match"] {
                if let Some((_, value)) = request["headers"]
                    .as_object()
                    .and_then(|h| h.iter().find(|(key, _)| key.eq_ignore_ascii_case(header)))
                {
                    if let Some(value) = value.as_str() {
                        builder = builder.header(header, value);
                    }
                }
            }
            if method != "GET" {
                builder = builder.body(body.to_owned());
            }
            let next = builder.send().await.map_err(transport_error)?;
            if next.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                Self::refresh(&mut state).await?;
                continue;
            }
            response = Some(next);
            break;
        }
        let response = response.ok_or_else(|| {
            remote_error("remote_transport", "The remote request did not complete.")
        })?;
        if response.status().is_redirection() {
            return Err(remote_error(
                "redirect_forbidden",
                "The host returned an unexpected redirect.",
            ));
        }
        let status = response.status().as_u16();
        let mut headers = serde_json::Map::new();
        for header in ["cache-control", "content-type", "etag", "retry-after"] {
            if let Some(value) = response.headers().get(header).and_then(|v| v.to_str().ok()) {
                headers.insert(header.into(), json!(value));
            }
        }
        let body = bounded_text(response, MAX_API).await?;
        if status < 300
            && ["/api/v2/profiles/select", "/api/v2/profiles/lock"]
                .iter()
                .any(|p| path.starts_with(p))
        {
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
        Ok(json!({"status":status,"headers":headers,"body":body}))
    }
    pub async fn fetch_media(
        &self,
        path: &str,
        method: &str,
        range: Option<&str>,
        expected_epoch: u64,
    ) -> Result<Response> {
        let path = route(path, method, true)?;
        let stale = || {
            remote_error(
                "stale_remote_session",
                "The remote profile or host changed.",
            )
        };
        if self.epoch() != expected_epoch {
            return Err(stale());
        }
        let (mut session, mut client) = {
            let mut state = self.state.lock().await;
            let (session, _) = Self::current(&mut state).await?;
            if session.access_token_expires_at <= now() + 60_000 {
                Self::refresh(&mut state).await?;
            }
            Self::current(&mut state).await?
        };
        for attempt in 0..2 {
            if self.epoch() != expected_epoch {
                return Err(stale());
            }
            let mut request = client
                .request(
                    if method == "HEAD" {
                        Method::HEAD
                    } else {
                        Method::GET
                    },
                    format!("{}{path}", session.base_url),
                )
                .bearer_auth(&session.access_token)
                .header("X-Loom-Profile-Api-Version", "1");
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            let response = request.send().await.map_err(transport_error)?;
            if self.epoch() != expected_epoch {
                return Err(stale());
            }
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                drop(response);
                let mut state = self.state.lock().await;
                if self.epoch() != expected_epoch {
                    return Err(stale());
                }
                // Parallel segment requests share one refresh instead of rotating the same token twice.
                if state
                    .session
                    .as_ref()
                    .is_some_and(|current| current.access_token == session.access_token)
                {
                    Self::refresh(&mut state).await?;
                }
                (session, client) = Self::current(&mut state).await?;
                continue;
            }
            if response.status().is_redirection() {
                return Err(remote_error(
                    "redirect_forbidden",
                    "The media host returned an unexpected redirect.",
                ));
            }
            return Ok(response);
        }
        Err(transport_error("media request did not complete"))
    }
    pub async fn disconnect(&self, revoke: bool) -> Result<Value> {
        let mut state = self.state.lock().await;
        Self::load(&mut state).await?;
        let old = Self::current(&mut state).await.ok();
        tokio::task::spawn_blocking(|| match credentials()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(remote_error(
                "secret_store_unavailable",
                "The saved pairing could not be removed.",
            )),
        })
        .await
        .map_err(transport_error)??;
        state.session = None;
        state.client = None;
        state.addresses.clear();
        state.load_failed = false;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        drop(state);
        if revoke {
            if let Some((session, client)) = old {
                let _ = client
                    .post(format!("{}/api/v2/unpair", session.base_url))
                    .bearer_auth(session.access_token)
                    .header("X-Loom-Profile-Api-Version", "1")
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await;
            }
        }
        Ok(json!(true))
    }
}

/// Decode only the app-owned remote media schemes. Absolute web URLs are never accepted here.
pub fn media_route(source: &str) -> Result<String> {
    let parsed = Url::parse(source).map_err(transport_error)?;
    if !["loomtv", "plexserver"].contains(&parsed.scheme())
        || parsed.host_str() != Some("remote")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
    {
        return Err(remote_error(
            "invalid_media_url",
            "The remote media URL is invalid.",
        ));
    }
    route(
        &format!(
            "{}{}",
            parsed.path(),
            parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
        ),
        "GET",
        true,
    )
}
