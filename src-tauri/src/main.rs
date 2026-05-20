#![allow(clippy::cast_possible_truncation)]

use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::RngCore;
use rfd::AsyncFileDialog;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{image::Image, AppHandle, Builder, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

mod database;

type JsonValue = Value;

const DATA_LIBRARY_FILE: &str = "library.json";
const DATA_SETTINGS_FILE: &str = "settings.json";
const DEFAULT_MEDIA_SERVER_PORT: u16 = 3847;
const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "avi", "mov", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "m2ts", "3gp", "ts",
];
const SUBTITLE_EXTENSIONS: &[&str] = &["vtt", "srt", "ass", "ssa"];
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif"];
const TRANSCODE_EXTENSIONS: &[&str] = &[
    "mkv", "avi", "wmv", "flv", "m2ts", "3gp", "ts", "mpg", "mpeg",
];
const SCAN_CACHE_VERSION: u64 = 1;
const LOCAL_ACCESS_QUERY_PARAM: &str = "loomtvToken";
const LOCAL_ACCESS_HEADER: &str = "x-loomtv-token";
const LAN_SIGNATURE_PARAM: &str = "sig";
const LAN_SIGNATURE_EXPIRY_PARAM: &str = "exp";
const LAN_SIGNATURE_NONCE_PARAM: &str = "nonce";
const LAN_URL_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const MDNS_SERVICE_TYPE: &str = "_loomtv._tcp.local.";
const UPDATE_OWNER: &str = "mallenkb";
const UPDATE_REPO: &str = "LoomTV";
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

static MEDIA_SERVER_PORT: AtomicU16 = AtomicU16::new(DEFAULT_MEDIA_SERVER_PORT);
static TRANSCODE_SESSIONS: OnceLock<Mutex<HashMap<String, ActiveTranscode>>> = OnceLock::new();
static LOCAL_ACCESS_TOKEN: OnceLock<String> = OnceLock::new();
static MDNS_DAEMON: OnceLock<Mutex<Option<ServiceDaemon>>> = OnceLock::new();
static MDNS_SERVICE_FULLNAME: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static UPDATE_STATE: OnceLock<Mutex<JsonValue>> = OnceLock::new();

thread_local! {
    static CURRENT_REQUEST_HEADERS: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

type HmacSha256 = Hmac<Sha256>;

struct ActiveTranscode {
    output_dir: PathBuf,
    child: Child,
}

fn media_server_port() -> u16 {
    MEDIA_SERVER_PORT.load(Ordering::Relaxed)
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    let fallback = std::env::temp_dir();
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| fallback.clone());
    let _ = fs::create_dir_all(&data_dir);
    data_dir
}

fn loomtv_icon() -> Option<Image<'static>> {
    Image::from_bytes(APP_ICON_PNG).ok()
}

fn apply_runtime_app_icon(app: &AppHandle) {
    let Some(icon) = loomtv_icon() else {
        eprintln!("LoomTV icon could not be loaded from bundled PNG");
        return;
    };

    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_icon(icon) {
            eprintln!("LoomTV window icon update failed: {error}");
        }
    }
}

fn loomtv_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    context.set_default_window_icon(loomtv_icon());
    context
}

fn with_database_fallback<T>(
    app: &AppHandle,
    fallback: T,
    action: impl FnOnce(&Path) -> rusqlite::Result<T>,
) -> T {
    let data_dir = app_data_dir(app);
    match action(&data_dir) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("LoomTV database error: {error}");
            fallback
        }
    }
}

fn read_json_with_default(path: &Path, default: JsonValue) -> JsonValue {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(default),
        Err(_) => default,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut values = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut values);
    hex_encode(&values)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

fn local_access_token() -> &'static str {
    LOCAL_ACCESS_TOKEN
        .get_or_init(|| random_hex(32))
        .as_str()
}

fn local_access_query_pair() -> String {
    format!(
        "{}={}",
        LOCAL_ACCESS_QUERY_PARAM,
        percent_escape(local_access_token())
    )
}

fn append_query_pair(url: &str, key: &str, value: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}{key}={}", percent_escape(value))
}

fn append_raw_query(url: &str, query_string: &str) -> String {
    if query_string.trim().is_empty() {
        return url.to_string();
    }
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}{query_string}")
}

fn append_local_access_token_to_url(url: &str) -> String {
    append_query_pair(url, LOCAL_ACCESS_QUERY_PARAM, local_access_token())
}

fn percent_escape(input: &str) -> String {
    input
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect::<Vec<_>>()
        .join("")
}

fn percent_decode(input: &str) -> String {
    let mut output = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = &input[index + 1..index + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    index += 3;
                    continue;
                }
                output.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            value => {
                output.push(value);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).to_string()
}

fn file_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

fn file_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

fn parent_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

fn clean_title(input: &str) -> String {
    let without_ext = Path::new(input)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(input);
    let mut title = without_ext.replace(['.', '_'], " ");
    for token in [
        "2160p", "1080p", "720p", "480p", "bluray", "bdrip", "web-dl", "webrip", "hdtv", "x264",
        "x265", "h264", "h265", "hevc", "aac", "dts",
    ] {
        title = title.replace(token, "");
        title = title.replace(&token.to_ascii_uppercase(), "");
    }
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|value: char| value == '-' || value.is_whitespace())
        .trim()
        .to_string();
    if title.is_empty() {
        without_ext.to_string()
    } else {
        title
    }
}

fn metadata_lookup_title(input: &str) -> String {
    let mut title = clean_title(input);
    loop {
        let trimmed = title.trim_start();
        if !trimmed.starts_with('[') {
            break;
        }
        let Some(end) = trimmed.find(']') else {
            break;
        };
        title = trimmed[end + 1..]
            .trim_start_matches(|value: char| value.is_whitespace() || value == '-' || value == '.')
            .to_string();
    }

    for suffix in [" film review", " movie review", " review"] {
        if title.to_ascii_lowercase().ends_with(suffix) {
            let end = title.len().saturating_sub(suffix.len());
            title = title[..end].trim().to_string();
            break;
        }
    }

    for (index, _) in title.char_indices() {
        let candidate = &title[index..];
        let Some(year) = candidate.get(0..4) else {
            continue;
        };
        if !year.chars().all(|value| value.is_ascii_digit()) {
            continue;
        }
        let Ok(year_value) = year.parse::<u64>() else {
            continue;
        };
        if !(1900..=2100).contains(&year_value) {
            continue;
        }

        let before = title[..index].trim_matches(|value: char| {
            value.is_whitespace() || value == '(' || value == '[' || value == '-' || value == '.'
        });
        let previous = title[..index].chars().next_back();
        let next = candidate.chars().nth(4);
        let has_left_boundary = previous
            .map(|value| !value.is_ascii_digit())
            .unwrap_or(true);
        let has_right_boundary = next.map(|value| !value.is_ascii_digit()).unwrap_or(true);
        if has_left_boundary && has_right_boundary && !before.is_empty() {
            return before.to_string();
        }
    }

    title
}

fn stable_id(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_subtitle_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| SUBTITLE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn content_type_for_path(path: &str) -> &'static str {
    match file_extension(path).as_str() {
        "mp4" | "mov" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" | "avi" | "wmv" | "flv" | "m2ts" | "3gp" | "ts" | "mpg" | "mpeg" => "video/mp4",
        "srt" | "vtt" => "text/vtt; charset=utf-8",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn local_host_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "LoomTV Device".to_string())
}

fn local_network_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        let _ = socket.connect("8.8.8.8:80");
        if let Ok(addr) = socket.local_addr() {
            addresses.push(addr.ip().to_string());
        }
    }
    addresses.push("127.0.0.1".to_string());
    unique_strings(addresses)
}

fn mdns_daemon_store() -> &'static Mutex<Option<ServiceDaemon>> {
    MDNS_DAEMON.get_or_init(|| Mutex::new(None))
}

fn mdns_service_fullname_store() -> &'static Mutex<Option<String>> {
    MDNS_SERVICE_FULLNAME.get_or_init(|| Mutex::new(None))
}

fn sanitized_mdns_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>();
    if name.is_empty() {
        "LoomTV".to_string()
    } else {
        name
    }
}

fn unregister_lan_service() {
    let fullname = mdns_service_fullname_store().lock().unwrap().take();
    let Some(fullname) = fullname else {
        return;
    };
    if let Some(daemon) = mdns_daemon_store().lock().unwrap().as_ref() {
        let _ = daemon.unregister(&fullname);
    }
}

fn sync_lan_advertisement(data_dir: &Path) {
    let settings = ensure_network_settings(read_server_settings(data_dir));
    if !settings
        .get("localNetworkSharingEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        unregister_lan_service();
        return;
    }

    let device_id = settings
        .get("localNetworkDeviceId")
        .and_then(Value::as_str)
        .unwrap_or("loomtv-desktop");
    let device_name = settings
        .get("localNetworkDeviceName")
        .and_then(Value::as_str)
        .unwrap_or("LoomTV");
    let instance_name = sanitized_mdns_name(&format!("{device_name}-{device_id}"));
    let host_name = format!("{}.local.", sanitized_mdns_name(device_id));
    let properties = [
        ("deviceId", device_id),
        ("deviceName", device_name),
        ("appVersion", env!("CARGO_PKG_VERSION")),
    ];

    unregister_lan_service();
    let mut daemon_guard = mdns_daemon_store().lock().unwrap();
    if daemon_guard.is_none() {
        match ServiceDaemon::new() {
            Ok(daemon) => *daemon_guard = Some(daemon),
            Err(error) => {
                eprintln!("LoomTV mDNS daemon error: {error}");
                return;
            }
        }
    }
    let Some(daemon) = daemon_guard.as_ref() else {
        return;
    };
    let service = match ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance_name,
        &host_name,
        "",
        media_server_port(),
        &properties[..],
    ) {
        Ok(service) => service.enable_addr_auto(),
        Err(error) => {
            eprintln!("LoomTV mDNS service error: {error}");
            return;
        }
    };
    let fullname = service.get_fullname().to_string();
    if let Err(error) = daemon.register(service) {
        eprintln!("LoomTV mDNS register error: {error}");
        return;
    }
    *mdns_service_fullname_store().lock().unwrap() = Some(fullname);
}

fn discover_lan_peers(timeout_ms: u64, exclude_device_id: Option<&str>) -> Vec<JsonValue> {
    let Ok(daemon) = ServiceDaemon::new() else {
        return Vec::new();
    };
    let Ok(receiver) = daemon.browse(MDNS_SERVICE_TYPE) else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let started = now_millis();
    let mut peers: HashMap<String, JsonValue> = HashMap::new();
    while now_millis().saturating_sub(started) < timeout_ms.max(500) {
        let remaining = timeout_ms
            .max(500)
            .saturating_sub(now_millis().saturating_sub(started));
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(remaining.min(250))) else {
            continue;
        };
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        let properties = info.get_properties();
        let device_id = properties
            .get_property_val_str("deviceId")
            .unwrap_or("")
            .trim()
            .to_string();
        if device_id.is_empty() || exclude_device_id == Some(device_id.as_str()) {
            continue;
        }
        let device_name = properties
            .get_property_val_str("deviceName")
            .unwrap_or_else(|| info.get_fullname())
            .trim()
            .to_string();
        let app_version = properties
            .get_property_val_str("appVersion")
            .unwrap_or("")
            .trim()
            .to_string();
        let addresses = info
            .get_addresses()
            .iter()
            .map(|address| address.to_ip_addr())
            .filter(|address| matches!(address, IpAddr::V4(_)))
            .map(|address| address.to_string())
            .collect::<Vec<_>>();
        let host = addresses
            .first()
            .cloned()
            .unwrap_or_else(|| info.get_hostname().trim_end_matches('.').to_string());
        peers.insert(
            device_id.clone(),
            json!({
                "deviceId": device_id,
                "deviceName": if device_name.is_empty() { host.clone() } else { device_name },
                "host": host,
                "port": info.get_port(),
                "addresses": addresses,
                "appVersion": app_version,
            }),
        );
    }
    let _ = daemon.shutdown();
    let mut peers = peers.into_values().collect::<Vec<_>>();
    peers.sort_by(|left, right| {
        left.get("deviceName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("deviceName").and_then(Value::as_str).unwrap_or(""))
    });
    peers
}

fn generated_share_code(seed: &str) -> String {
    let mut digits = stable_id(&format!("{seed}-{}", now_millis()))
        .chars()
        .filter_map(|ch| ch.to_digit(16))
        .map(|value| char::from(b'0' + (value % 10) as u8))
        .collect::<String>();
    while digits.len() < 6 {
        digits.push('0');
    }
    digits.truncate(6);
    digits
}

fn ensure_network_settings(mut settings: JsonValue) -> JsonValue {
    if !settings.is_object() {
        settings = json!({});
    }
    if settings
        .get("localNetworkDeviceId")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        settings["localNetworkDeviceId"] =
            json!(format!("loomtv-{}", stable_id(&local_host_name())));
    }
    if settings
        .get("localNetworkDeviceName")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        settings["localNetworkDeviceName"] = json!(local_host_name());
    }
    if settings
        .get("localNetworkShareToken")
        .and_then(Value::as_str)
        .map(|value| value.len() != 6 || !value.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or(true)
    {
        let seed = settings
            .get("localNetworkDeviceId")
            .and_then(Value::as_str)
            .unwrap_or("loomtv");
        settings["localNetworkShareToken"] = json!(generated_share_code(seed));
    }
    if settings
        .get("localNetworkPairedDevices")
        .and_then(Value::as_array)
        .is_none()
    {
        settings["localNetworkPairedDevices"] = json!([]);
    }
    if settings
        .get("localNetworkHmacSecret")
        .and_then(Value::as_str)
        .map(|value| value.len() < 32)
        .unwrap_or(true)
    {
        settings["localNetworkHmacSecret"] = json!(random_hex(32));
    }
    settings
}

fn request_bearer_token(headers: &[(String, String)], query: &[(String, String)]) -> String {
    let authorization = header_value(headers, "authorization")
        .map(String::as_str)
        .unwrap_or("");
    if let Some(token) = authorization.strip_prefix("Bearer ") {
        return token.trim().to_string();
    }
    query_value(query, "token").unwrap_or_default()
}

fn paired_device_for_token(settings: &JsonValue, token: &str) -> Option<JsonValue> {
    if token.trim().is_empty() {
        return None;
    }
    settings
        .get("localNetworkPairedDevices")
        .and_then(Value::as_array)?
        .iter()
        .find(|device| device.get("token").and_then(Value::as_str) == Some(token))
        .cloned()
}

fn library_etag(payload: &JsonValue) -> String {
    stable_id(&serde_json::to_string(payload).unwrap_or_default())
}

fn should_transcode(path: &str, force_transcode: bool) -> bool {
    if force_transcode {
        return true;
    }
    TRANSCODE_EXTENSIONS.contains(&file_extension(path).as_str())
}

fn library_default() -> JsonValue {
    json!({
        "movies": [],
        "tvShows": [],
        "animeShows": [],
        "libraryFolders": [],
        "libraryFolderGroups": {
            "movies": [],
            "tvShows": [],
            "anime": [],
            "others": [],
        },
    })
}

fn settings_default() -> JsonValue {
    json!({})
}

fn load_library(app: &AppHandle) -> JsonValue {
    with_database_fallback(app, library_default(), database::load_library)
}

fn save_library(app: &AppHandle, library: &JsonValue) -> bool {
    with_database_fallback(app, false, |data_dir| {
        database::save_library(data_dir, library)?;
        Ok(true)
    })
}

fn load_settings(app: &AppHandle) -> JsonValue {
    with_database_fallback(app, settings_default(), |data_dir| {
        Ok(database::load_settings(data_dir)?.unwrap_or_else(settings_default))
    })
}

fn save_settings(app: &AppHandle, settings: &JsonValue) -> bool {
    with_database_fallback(app, false, |data_dir| {
        database::save_settings(data_dir, settings)?;
        Ok(true)
    })
}

fn normalized_provider_id(provider: &str) -> String {
    provider
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-' || *value == '_')
        .collect()
}

fn normalize_settings_payload(mut settings: JsonValue) -> JsonValue {
    if !settings.is_object() {
        settings = json!({});
    }

    let mut keys = settings
        .get("metadataApiKeys")
        .and_then(Value::as_object)
        .map(|raw_keys| {
            let mut normalized = serde_json::Map::new();
            for (provider, value) in raw_keys {
                let provider_id = normalized_provider_id(provider);
                let api_key = value.as_str().unwrap_or("").trim();
                if !provider_id.is_empty() && !api_key.is_empty() {
                    normalized.insert(provider_id, json!(api_key));
                }
            }
            normalized
        })
        .unwrap_or_default();

    for (legacy_key, provider) in [("tmdbApiKey", "tmdb"), ("omdbApiKey", "omdb")] {
        if let Some(api_key) = settings
            .get(legacy_key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            keys.entry(provider.to_string())
                .or_insert_with(|| json!(api_key));
        }
    }

    if !keys.is_empty() {
        settings["metadataApiKeys"] = JsonValue::Object(keys.clone());
        settings["tmdbApiKey"] = keys.get("tmdb").cloned().unwrap_or_else(|| json!(""));
        settings["omdbApiKey"] = keys.get("omdb").cloned().unwrap_or_else(|| json!(""));
    } else {
        settings["metadataApiKeys"] = json!({});
        settings["tmdbApiKey"] = json!("");
        settings["omdbApiKey"] = json!("");
    }

    settings
}

fn merge_settings_payload(existing: JsonValue, incoming: JsonValue) -> JsonValue {
    let mut merged = normalize_settings_payload(existing);
    if !merged.is_object() {
        merged = json!({});
    }

    let Some(incoming_obj) = incoming.as_object() else {
        return normalize_settings_payload(merged);
    };

    if let Some(merged_obj) = merged.as_object_mut() {
        for (key, value) in incoming_obj {
            merged_obj.insert(key.clone(), value.clone());
        }
    }

    normalize_settings_payload(merged)
}

fn load_artwork(app: &AppHandle) -> JsonValue {
    let library = load_library(app);
    let mut entries = Map::new();
    for key in ["movies", "tvShows", "animeShows"] {
        for item in library
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                let artwork = artwork_for_media(app, id);
                if artwork
                    .as_object()
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
                {
                    entries.insert(id.to_string(), artwork);
                }
            }
        }
    }
    JsonValue::Object(entries)
}

fn artwork_for_media(app: &AppHandle, media_id: &str) -> JsonValue {
    with_database_fallback(app, json!({}), |data_dir| {
        let mut artwork = database::get_custom_artwork(data_dir, media_id)?;
        rewrite_artwork_map_for_renderer(data_dir, &mut artwork);
        Ok(artwork)
    })
}

fn rewrite_artwork_map_for_renderer(data_dir: &Path, artwork: &mut JsonValue) {
    let Some(entries) = artwork.as_object_mut() else {
        return;
    };
    for value in entries.values_mut() {
        if let Some(source) = value.as_str().map(str::to_string) {
            *value = json!(local_cached_artwork_url(data_dir, &source));
        }
    }
}

fn apply_artwork_to_item(item: &mut JsonValue, artwork: &JsonValue) {
    let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let Some(custom) = artwork.get(&id).and_then(Value::as_object) else {
        return;
    };
    if let Some(value) = custom.get("thumbnail").or_else(|| custom.get("poster")) {
        item["poster"] = value.clone();
    }
    if let Some(value) = custom.get("cover").or_else(|| custom.get("backdrop")) {
        item["backdrop"] = value.clone();
    }
    if let Some(value) = custom.get("logo") {
        item["logo"] = value.clone();
    }
}

fn library_for_renderer(app: &AppHandle, mut library: JsonValue) -> JsonValue {
    let artwork = load_artwork(app);
    let data_dir = app_data_dir(app);
    for key in ["movies", "tvShows", "animeShows"] {
        if let Some(items) = library.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                apply_artwork_to_item(item, &artwork);
                rewrite_item_artwork_for_renderer(&data_dir, item);
            }
        }
    }
    library
}

fn open_with_system_target(target: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }

    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", "", target])
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .status();

    #[cfg(not(target_os = "windows"))]
    let status = {
        if cfg!(target_os = "macos") {
            Command::new("open")
                .arg(target)
                .stderr(Stdio::null())
                .stdout(Stdio::null())
                .status()
        } else {
            Command::new("xdg-open")
                .arg(target)
                .stderr(Stdio::null())
                .stdout(Stdio::null())
                .status()
        }
    };

    status.ok().map(|value| value.success()).unwrap_or(false)
}

fn locate_executable(name: &str) -> Option<String> {
    let version_args = if matches!(name, "ffmpeg" | "ffprobe") {
        ["-version", "--version"]
    } else {
        ["--version", "-version"]
    };
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let platform_folder = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "win"
    } else {
        "linux"
    };
    let mut candidates = Vec::new();
    if matches!(name, "ffmpeg" | "ffprobe") {
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(bundle_dir) = current_exe.parent() {
                candidates.push(
                    bundle_dir
                        .join("resources")
                        .join("ffmpeg")
                        .join(platform_folder)
                        .join(&executable),
                );
                candidates.push(
                    bundle_dir
                        .join("../Resources/ffmpeg")
                        .join(platform_folder)
                        .join(&executable),
                );
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(
                cwd.join("resources")
                    .join("ffmpeg")
                    .join(platform_folder)
                    .join(&executable),
            );
        }
    }

    for candidate in candidates {
        if candidate.is_file()
            && Command::new(&candidate)
                .arg(version_args[0])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()
                .map(|status| status.success())
                .unwrap_or(false)
        {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    for arg in version_args {
        if Command::new(name)
            .arg(arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(name.to_string());
        }
    }
    None
}

fn command_result(path: Option<String>) -> JsonValue {
    json!({
        "available": path.is_some(),
        "path": path,
    })
}

fn response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
        body.len(),
        cors_header_lines()
    )
    .into_bytes();
    payload.extend_from_slice(body);
    payload
}

fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let _ = stream.write_all(&response(status, content_type, body));
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn query_value(query: &[(String, String)], key: &str) -> Option<String> {
    query
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.clone())
}

fn parse_range(header: Option<&String>, file_size: u64) -> Option<(u64, u64)> {
    let value = header?.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = if end.trim().is_empty() {
        file_size.saturating_sub(1)
    } else {
        end.parse::<u64>().ok()?.min(file_size.saturating_sub(1))
    };
    if start <= end {
        Some((start, end))
    } else {
        None
    }
}

fn parse_request(
    stream: &mut TcpStream,
) -> Option<(
    String,
    String,
    Vec<(String, String)>,
    Vec<(String, String)>,
    String,
)> {
    let mut buffer = [0_u8; 8192];
    let bytes_read = stream.read(&mut buffer).ok()?;
    if bytes_read == 0 {
        return None;
    }
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let (head, body) = request.split_once("\r\n\r\n").unwrap_or((&request, ""));
    let mut lines = head.lines();
    let request_line = lines.next()?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next()?.to_string();
    let target = request_parts.next()?.to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let headers = lines
        .take_while(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<Vec<_>>();
    Some((
        method,
        path.to_string(),
        parse_query(query),
        headers,
        body.to_string(),
    ))
}

fn header_value<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a String> {
    headers
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(_, value)| value)
}

fn remember_request_headers(headers: &[(String, String)]) {
    CURRENT_REQUEST_HEADERS.with(|current| {
        *current.borrow_mut() = headers.to_vec();
    });
}

fn current_request_headers() -> Vec<(String, String)> {
    CURRENT_REQUEST_HEADERS.with(|current| current.borrow().clone())
}

fn allowed_cors_origin(headers: &[(String, String)]) -> Option<String> {
    let origin = header_value(headers, "origin")?.trim();
    if origin.is_empty() {
        return None;
    }
    if origin == "null" || origin == "file://" {
        return Some(origin.to_string());
    }
    let normalized = origin.to_ascii_lowercase();
    if normalized.starts_with("tauri://") {
        return Some(origin.to_string());
    }
    let Some((scheme, rest)) = normalized.split_once("://") else {
        return None;
    };
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
    if matches!(host, "tauri.localhost" | "localhost" | "127.0.0.1") {
        return Some(origin.to_string());
    }
    None
}

fn cors_request_allowed(headers: &[(String, String)]) -> bool {
    header_value(headers, "origin").is_none() || allowed_cors_origin(headers).is_some()
}

fn cors_header_lines() -> String {
    let headers = current_request_headers();
    let mut lines = String::from("Vary: Origin\r\n");
    if let Some(origin) = allowed_cors_origin(&headers) {
        lines.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
        lines.push_str(&format!(
            "Access-Control-Allow-Headers: Range, Content-Type, Authorization, {LOCAL_ACCESS_HEADER}\r\n"
        ));
        lines.push_str("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        lines.push_str(
            "Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, ETag\r\n",
        );
    }
    lines
}

fn request_local_access_token(headers: &[(String, String)], query: &[(String, String)]) -> String {
    header_value(headers, LOCAL_ACCESS_HEADER)
        .cloned()
        .or_else(|| {
            header_value(headers, "authorization")
                .and_then(|value| value.strip_prefix("Bearer ").map(str::trim))
                .map(str::to_string)
        })
        .or_else(|| query_value(query, LOCAL_ACCESS_QUERY_PARAM))
        .unwrap_or_default()
}

fn timing_safe_string_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (left, right) in left.as_bytes().iter().zip(right.as_bytes()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn has_valid_local_access(headers: &[(String, String)], query: &[(String, String)]) -> bool {
    let token = request_local_access_token(headers, query);
    !token.is_empty() && timing_safe_string_equal(&token, local_access_token())
}

fn canonical_signature_payload(path: &str, query: &[(String, String)]) -> String {
    let mut parts = query
        .iter()
        .filter(|(key, _)| key != LAN_SIGNATURE_PARAM)
        .map(|(key, value)| format!("{}={}", percent_escape(key), percent_escape(value)))
        .collect::<Vec<_>>();
    parts.sort();
    format!("{path}?{}", parts.join("&"))
}

fn sign_lan_query(secret: &str, path: &str, query: &[(String, String)]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(canonical_signature_payload(path, query).as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

fn lan_hmac_secret(settings: &JsonValue) -> String {
    settings
        .get("localNetworkHmacSecret")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "loomtv-fallback-secret".to_string())
}

fn signed_lan_query(settings: &JsonValue, path: &str, mut query: Vec<(String, String)>) -> String {
    query.retain(|(key, _)| {
        key != LAN_SIGNATURE_PARAM
            && key != LAN_SIGNATURE_EXPIRY_PARAM
            && key != LAN_SIGNATURE_NONCE_PARAM
    });
    query.push((
        LAN_SIGNATURE_EXPIRY_PARAM.to_string(),
        now_millis().saturating_add(LAN_URL_TTL_MS).to_string(),
    ));
    query.push((LAN_SIGNATURE_NONCE_PARAM.to_string(), random_hex(8)));
    let signature = sign_lan_query(&lan_hmac_secret(settings), path, &query);
    query.push((LAN_SIGNATURE_PARAM.to_string(), signature));
    query
        .into_iter()
        .map(|(key, value)| format!("{}={}", percent_escape(&key), percent_escape(&value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn signed_lan_url(settings: &JsonValue, base: &str, path: &str, query: Vec<(String, String)>) -> String {
    let query = signed_lan_query(settings, path, query);
    format!("{}{}?{}", base.trim_end_matches('/'), path, query)
}

fn valid_signed_lan_request(data_dir: &Path, path: &str, query: &[(String, String)]) -> bool {
    let Some(expiry) = query_value(query, LAN_SIGNATURE_EXPIRY_PARAM)
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return false;
    };
    if expiry < now_millis() {
        return false;
    }
    let Some(signature) = query_value(query, LAN_SIGNATURE_PARAM) else {
        return false;
    };
    let settings = ensure_network_settings(read_server_settings(data_dir));
    if !settings
        .get("localNetworkSharingEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    let expected = sign_lan_query(&lan_hmac_secret(&settings), path, query);
    timing_safe_string_equal(&signature, &expected)
}

fn has_media_route_access(
    data_dir: &Path,
    path: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
) -> bool {
    has_valid_local_access(headers, query) || valid_signed_lan_request(data_dir, path, query)
}

fn stream_file(mut stream: TcpStream, file_path: &str, headers: &[(String, String)]) {
    let Ok(mut file) = fs::File::open(file_path) else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        );
        return;
    };
    let Ok(metadata) = file.metadata() else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        );
        return;
    };
    let file_size = metadata.len();
    let content_type = content_type_for_path(file_path);

    if let Some((start, end)) = parse_range(header_value(headers, "range"), file_size) {
        let length = end.saturating_sub(start) + 1;
        let header = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nContent-Range: bytes {start}-{end}/{file_size}\r\nAccept-Ranges: bytes\r\n{}Connection: close\r\n\r\n",
            cors_header_lines()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = file.seek(SeekFrom::Start(start));
        let mut remaining = length;
        let mut buffer = [0_u8; 256 * 1024];
        while remaining > 0 {
            let read_size = buffer.len().min(remaining as usize);
            let Ok(read) = file.read(&mut buffer[..read_size]) else {
                break;
            };
            if read == 0 {
                break;
            }
            let _ = stream.write_all(&buffer[..read]);
            remaining = remaining.saturating_sub(read as u64);
        }
        return;
    }

    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {file_size}\r\nAccept-Ranges: bytes\r\n{}Connection: close\r\n\r\n",
        cors_header_lines()
    );
    let _ = stream.write_all(header.as_bytes());
    let mut buffer = [0_u8; 256 * 1024];
    while let Ok(read) = file.read(&mut buffer) {
        if read == 0 {
            break;
        }
        if stream.write_all(&buffer[..read]).is_err() {
            break;
        }
    }
}

fn transcode_stream(mut stream: TcpStream, file_path: &str, query: &[(String, String)]) {
    let Some(ffmpeg) = locate_executable("ffmpeg") else {
        stream_file(stream, file_path, &[]);
        return;
    };
    let options = options_with_selected_preset(&ffmpeg, transcode_options_from_query(query));
    let args = mp4_transcode_args(file_path, &options, "pipe:1");

    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nTransfer-Encoding: chunked\r\n{}Connection: close\r\n\r\n",
        cors_header_lines()
    );
    let _ = stream.write_all(header.as_bytes());

    let Ok(mut child) = Command::new(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };

    if let Some(mut stdout) = child.stdout.take() {
        let mut buffer = [0_u8; 64 * 1024];
        while let Ok(read) = stdout.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let chunk_header = format!("{read:x}\r\n");
            if stream.write_all(chunk_header.as_bytes()).is_err()
                || stream.write_all(&buffer[..read]).is_err()
                || stream.write_all(b"\r\n").is_err()
            {
                let _ = child.kill();
                break;
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n");
    }
    let _ = child.wait();
}

fn transcode_sessions() -> &'static Mutex<HashMap<String, ActiveTranscode>> {
    TRANSCODE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn json_number(value: &JsonValue, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .or_else(|| {
            value
                .get(key)
                .and_then(Value::as_i64)
                .map(|value| value as f64)
        })
        .or_else(|| {
            value
                .get(key)
                .and_then(Value::as_u64)
                .map(|value| value as f64)
        })
}

fn query_number(query: &[(String, String)], key: &str) -> Option<f64> {
    query_value(query, key).and_then(|value| value.parse::<f64>().ok())
}

fn transcode_options_from_query(query: &[(String, String)]) -> JsonValue {
    let mut options = serde_json::Map::new();
    for (query_key, option_key) in [
        ("t", "startSeconds"),
        ("startSeconds", "startSeconds"),
        ("video", "videoTrackIndex"),
        ("audio", "audioTrackIndex"),
        ("subtitle", "subtitleTrackIndex"),
        ("subtitleOrdinal", "subtitleStreamOrdinal"),
        ("secondarySubtitle", "secondarySubtitleTrackIndex"),
        ("secondarySubtitleOrdinal", "secondarySubtitleStreamOrdinal"),
    ] {
        if let Some(value) = query_number(query, query_key) {
            options.insert(option_key.to_string(), json!(value));
        }
    }
    for (query_key, option_key) in [
        ("subtitleCodec", "subtitleCodec"),
        ("secondarySubtitleCodec", "secondarySubtitleCodec"),
        ("preset", "preset"),
    ] {
        if let Some(value) = query_value(query, query_key).filter(|value| !value.trim().is_empty())
        {
            options.insert(option_key.to_string(), json!(value));
        }
    }
    if let Some(value) = query_value(query, "subtitleStyle") {
        if let Ok(style) = serde_json::from_str::<JsonValue>(&value) {
            options.insert("subtitleStyle".to_string(), style);
        }
    }
    JsonValue::Object(options)
}

fn stream_map(track_type: &str, option: Option<f64>, optional: bool) -> String {
    let suffix = if optional { "?" } else { "" };
    match option {
        Some(value) if value >= 0.0 => format!("0:{}{}", value.floor(), suffix),
        _ => format!("0:{track_type}:0{suffix}"),
    }
}

fn filter_stream(option: Option<f64>) -> String {
    match option {
        Some(value) if value >= 0.0 => format!("0:{}", value.floor()),
        _ => "0:v:0".to_string(),
    }
}

fn escape_filter_path(file_path: &str) -> String {
    file_path
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn is_bitmap_subtitle_codec(codec: Option<&str>) -> bool {
    let normalized = codec.unwrap_or("").to_ascii_lowercase();
    normalized.contains("pgs") || normalized.contains("dvd") || normalized.contains("dvb")
}

#[derive(Clone)]
struct SubtitleSelection {
    track_index: f64,
    stream_ordinal: f64,
    codec: Option<String>,
    placement: &'static str,
}

fn subtitle_selections(options: &JsonValue) -> Vec<SubtitleSelection> {
    let mut selections = Vec::new();
    if let Some(track_index) =
        json_number(options, "subtitleTrackIndex").filter(|value| *value >= 0.0)
    {
        selections.push(SubtitleSelection {
            track_index,
            stream_ordinal: json_number(options, "subtitleStreamOrdinal").unwrap_or(0.0),
            codec: options
                .get("subtitleCodec")
                .and_then(Value::as_str)
                .map(str::to_string),
            placement: "primary",
        });
    }
    if let Some(track_index) =
        json_number(options, "secondarySubtitleTrackIndex").filter(|value| *value >= 0.0)
    {
        if Some(track_index) != json_number(options, "subtitleTrackIndex") {
            selections.push(SubtitleSelection {
                track_index,
                stream_ordinal: json_number(options, "secondarySubtitleStreamOrdinal")
                    .unwrap_or(0.0),
                codec: options
                    .get("secondarySubtitleCodec")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                placement: "secondary",
            });
        }
    }
    selections
}

fn style_number(style: Option<&JsonValue>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    style
        .and_then(|value| value.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .max(min)
        .min(max)
}

fn ass_color(style: Option<&JsonValue>, key: &str, fallback: &str) -> String {
    if let Some(value) = style
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
    {
        let normalized = value.trim().to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "transparent" | "none" | "rgba(0,0,0,0)" | "rgba(0, 0, 0, 0)" | "#00000000"
        ) {
            return "&HFF000000".to_string();
        }
    }

    let hex = style
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .filter(|value| value.len() == 7 && value.starts_with('#'))
        .unwrap_or(fallback);
    let red = &hex[1..3];
    let green = &hex[3..5];
    let blue = &hex[5..7];
    format!("&H00{blue}{green}{red}").to_ascii_uppercase()
}

fn subtitle_force_style(style: Option<&JsonValue>, placement: &str) -> String {
    let font_size = style_number(style, "fontSize", 32.0, 24.0, 96.0)
        * style_number(style, "scale", 1.0, 0.5, 2.0);
    let position = if placement == "secondary" {
        8.0
    } else {
        style_number(style, "position", 95.0, 0.0, 100.0)
    };
    let margin_v = if placement == "secondary" {
        (position * 6.0).round()
    } else {
        ((100.0 - position) * 6.0).round()
    };
    let border_width = if style
        .and_then(|value| value.get("borderEnabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        0.0
    } else {
        style_number(style, "borderWidth", 3.0, 0.0, 20.0)
    };
    format!(
        "Fontsize={},PrimaryColour={},OutlineColour={},BackColour={},Outline={},Shadow=0,Alignment={},MarginV={}",
        font_size.round(),
        ass_color(style, "fontColor", "#ffffff"),
        ass_color(style, "borderColor", "#000000"),
        if style.and_then(|value| value.get("backgroundEnabled")).and_then(Value::as_bool).unwrap_or(false) {
            ass_color(style, "backgroundColor", "#000000")
        } else {
            "&HFF000000".to_string()
        },
        border_width.round(),
        if placement == "secondary" { 8 } else { 2 },
        margin_v
    )
}

fn subtitle_filter_segment(
    file_path: &str,
    subtitle_ordinal: f64,
    style: Option<&JsonValue>,
    placement: &str,
) -> String {
    format!(
        "subtitles='{}':si={}:force_style='{}'",
        escape_filter_path(file_path),
        subtitle_ordinal.floor(),
        subtitle_force_style(style, placement)
    )
}

fn text_subtitle_filter(
    file_path: &str,
    options: &JsonValue,
    primary: &SubtitleSelection,
    secondary: Option<&SubtitleSelection>,
) -> String {
    let style = options.get("subtitleStyle");
    let mut filters = vec![subtitle_filter_segment(
        file_path,
        primary.stream_ordinal,
        style,
        primary.placement,
    )];
    if let Some(secondary) = secondary {
        filters.push(subtitle_filter_segment(
            file_path,
            secondary.stream_ordinal,
            style,
            secondary.placement,
        ));
    }
    let subtitle_filter = filters.join(",");
    let seek_offset = json_number(options, "startSeconds")
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor())
        .unwrap_or(0.0);
    if seek_offset <= 0.0 {
        format!("{subtitle_filter},format=yuv420p")
    } else {
        format!("setpts=PTS+{seek_offset}/TB,{subtitle_filter},setpts=PTS-{seek_offset}/TB,format=yuv420p")
    }
}

fn subtitle_filter_complex(
    file_path: &str,
    options: &JsonValue,
    selections: &[SubtitleSelection],
) -> (String, String) {
    let style = options.get("subtitleStyle");
    let mut current_label = filter_stream(json_number(options, "videoTrackIndex"));
    let mut filters = Vec::new();
    for (index, selection) in selections.iter().enumerate() {
        let output = format!("vsub{index}");
        if is_bitmap_subtitle_codec(selection.codec.as_deref()) {
            filters.push(format!(
                "[{}][0:{}]overlay,format=yuv420p[{output}]",
                current_label,
                selection.track_index.floor()
            ));
        } else {
            filters.push(format!(
                "[{}]{},format=yuv420p[{output}]",
                current_label,
                subtitle_filter_segment(
                    file_path,
                    selection.stream_ordinal,
                    style,
                    selection.placement
                )
            ));
        }
        current_label = output;
    }
    (filters.join(";"), current_label)
}

fn transcode_preset(options: &JsonValue) -> &str {
    options
        .get("preset")
        .and_then(Value::as_str)
        .unwrap_or("software")
}

fn ffmpeg_has_encoder(ffmpeg: &str, encoder: &str) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).contains(encoder))
            } else {
                None
            }
        })
        .unwrap_or(false)
}

fn selected_transcode_preset(ffmpeg: &str, options: &JsonValue) -> String {
    let requested = options
        .get("preset")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if requested != "auto" {
        return requested.to_string();
    }
    let candidates: &[(&str, &str)] = if cfg!(target_os = "macos") {
        &[
            ("videotoolbox", "h264_videotoolbox"),
            ("nvenc", "h264_nvenc"),
            ("qsv", "h264_qsv"),
        ]
    } else {
        &[
            ("nvenc", "h264_nvenc"),
            ("qsv", "h264_qsv"),
            ("videotoolbox", "h264_videotoolbox"),
        ]
    };
    candidates
        .iter()
        .find(|(_, encoder)| ffmpeg_has_encoder(ffmpeg, encoder))
        .map(|(preset, _)| (*preset).to_string())
        .unwrap_or_else(|| "software".to_string())
}

fn options_with_selected_preset(ffmpeg: &str, options: JsonValue) -> JsonValue {
    let mut options = if options.is_object() { options } else { json!({}) };
    let preset = selected_transcode_preset(ffmpeg, &options);
    options["preset"] = json!(preset);
    options
}

fn mp4_transcode_args(file_path: &str, options: &JsonValue, output: &str) -> Vec<String> {
    let mut args = vec!["-nostdin".to_string()];
    if let Some(start) = json_number(options, "startSeconds").filter(|value| *value > 0.0) {
        args.extend(["-ss".to_string(), start.floor().to_string()]);
    }
    let preset = transcode_preset(options).to_string();
    if preset == "nvenc" {
        args.extend(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"].map(str::to_string));
    } else if preset == "qsv" {
        args.extend(["-hwaccel", "qsv"].map(str::to_string));
    }
    args.extend(["-i".to_string(), file_path.to_string()]);

    let selections = subtitle_selections(options);
    let has_subtitle = !selections.is_empty();
    let has_bitmap_subtitle = selections
        .iter()
        .any(|selection| is_bitmap_subtitle_codec(selection.codec.as_deref()));

    if has_subtitle && has_bitmap_subtitle {
        let (filter, output_label) = subtitle_filter_complex(file_path, options, &selections);
        args.extend([
            "-filter_complex".to_string(),
            filter,
            "-map".to_string(),
            format!("[{output_label}]"),
        ]);
    } else {
        args.extend([
            "-map".to_string(),
            stream_map("v", json_number(options, "videoTrackIndex"), false),
        ]);
    }

    let audio_track = json_number(options, "audioTrackIndex");
    if audio_track != Some(-1.0) {
        args.extend(["-map".to_string(), stream_map("a", audio_track, true)]);
    }

    args.extend(["-sn", "-dn", "-map_chapters", "-1", "-map_metadata", "-1"].map(str::to_string));

    if has_subtitle && !has_bitmap_subtitle {
        let primary = selections
            .iter()
            .find(|selection| selection.placement == "primary")
            .unwrap_or(&selections[0]);
        let secondary = selections
            .iter()
            .find(|selection| selection.placement == "secondary");
        args.extend([
            "-vf".to_string(),
            text_subtitle_filter(file_path, options, primary, secondary),
        ]);
    } else if !has_bitmap_subtitle {
        args.extend(["-vf".to_string(), "format=yuv420p".to_string()]);
    }

    match preset.as_str() {
        "nvenc" => args.extend(
            ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-b:v", "0"]
                .map(str::to_string),
        ),
        "qsv" => args.extend(
            ["-c:v", "h264_qsv", "-global_quality", "23", "-look_ahead", "0"]
                .map(str::to_string),
        ),
        "videotoolbox" => args.extend(
            [
                "-c:v",
                "h264_videotoolbox",
                "-allow_sw",
                "1",
                "-realtime",
                "1",
                "-b:v",
                "6500k",
                "-maxrate",
                "8500k",
                "-bufsize",
                "12000k",
                "-profile:v",
                "main",
            ]
            .map(str::to_string),
        ),
        _ => args.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "main",
            ]
            .map(str::to_string),
        ),
    }

    if audio_track == Some(-1.0) {
        args.push("-an".to_string());
    } else {
        args.extend(["-c:a", "aac", "-b:a", "160k", "-ac", "2"].map(str::to_string));
    }

    args.extend(
        [
            "-f",
            "mp4",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            output,
        ]
        .map(str::to_string),
    );
    args
}

fn hls_transcode_args(file_path: &str, output_path: &str, options: &JsonValue) -> Vec<String> {
    let mut args = mp4_transcode_args(file_path, options, output_path);
    if let Some(index) = args.iter().position(|value| value == "-f") {
        args.truncate(index);
    }
    let segment_pattern = Path::new(output_path)
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("segment-%05d.ts")
        .to_string_lossy()
        .to_string();
    args.extend(
        [
            "-fflags",
            "+genpts",
            "-avoid_negative_ts",
            "make_zero",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_list_size",
            "0",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "append_list+independent_segments",
            "-hls_segment_filename",
            &segment_pattern,
            "-force_key_frames",
            "expr:gte(t,n_forced*1)",
            output_path,
        ]
        .map(str::to_string),
    );
    args
}

fn srt_to_vtt(content: &str) -> String {
    let body = content
        .lines()
        .map(|line| {
            if line.contains("-->") {
                line.replace(',', ".")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("WEBVTT\n\n{}", body.trim_start())
}

fn playlist_has_ready_segments(playlist_path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(playlist_path) else {
        return false;
    };
    if !content.contains("#EXTINF") {
        return false;
    }
    let segments = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return false;
    }
    let playlist_dir = playlist_path.parent().unwrap_or_else(|| Path::new(""));
    segments.iter().take(1).all(|segment| {
        let segment_path = playlist_dir.join(segment);
        segment_path.is_file()
            && fs::metadata(segment_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
    })
}

fn wait_for_playlist(playlist_path: &Path, child: &mut Child) -> Result<(), String> {
    let started_at = now_millis();
    loop {
        if playlist_has_ready_segments(playlist_path) {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Transcode process exited before the playlist was ready ({status})."
            ));
        }
        if now_millis().saturating_sub(started_at) > 30_000 {
            return Err("Timed out waiting for the transcode playlist.".to_string());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn append_query_to_hls_playlist(content: &str, query_string: &str) -> String {
    if query_string.trim().is_empty() {
        return content.to_string();
    }
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                line.to_string()
            } else {
                append_raw_query(line, query_string)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn query_string_without_path(query: &[(String, String)]) -> String {
    query
        .iter()
        .filter(|(key, _)| key != "path")
        .map(|(key, value)| format!("{}={}", percent_escape(key), percent_escape(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn serve_hls_file(mut stream: TcpStream, data_dir: &Path, path: &str, query: &[(String, String)]) {
    let relative = path.trim_start_matches("/hls/");
    let Some((session_id, file_name)) = relative.split_once('/') else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"HLS file not found",
        );
        return;
    };
    let output_root = data_dir.join("transcodes").join(session_id);
    let file_path = output_root.join(file_name);
    let Ok(output_root) = fs::canonicalize(&output_root) else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"HLS session not found",
        );
        return;
    };

    if file_name.ends_with(".m3u8") || file_name.ends_with(".ts") {
        let started_at = now_millis();
        while !file_path.exists() && now_millis().saturating_sub(started_at) < 8_000 {
            thread::sleep(Duration::from_millis(80));
        }
    }

    let Ok(file_path) = fs::canonicalize(&file_path) else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"HLS file not found",
        );
        return;
    };
    if !file_path.starts_with(&output_root) {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"HLS file not found",
        );
        return;
    }

    let content_type = if file_path.extension().and_then(|value| value.to_str()) == Some("m3u8") {
        "application/vnd.apple.mpegurl"
    } else if file_path.extension().and_then(|value| value.to_str()) == Some("ts") {
        "video/mp2t"
    } else {
        "application/octet-stream"
    };
    let Ok(mut body) = fs::read(&file_path) else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"HLS file not found",
        );
        return;
    };
    if file_path.extension().and_then(|value| value.to_str()) == Some("m3u8") {
        if let Ok(content) = String::from_utf8(body) {
            body = append_query_to_hls_playlist(&content, &query_string_without_path(query)).into_bytes();
        } else {
            body = Vec::new();
        }
    }
    let cache_control = if file_path.extension().and_then(|value| value.to_str()) == Some("m3u8") {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };
    let mut payload = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: {cache_control}\r\n{}Connection: close\r\n\r\n",
        body.len(),
        cors_header_lines()
    )
    .into_bytes();
    payload.extend_from_slice(&body);
    let _ = stream.write_all(&payload);
}

fn cleanup_old_transcodes(data_dir: &Path) {
    let root = data_dir.join("transcodes");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::create_dir_all(&root);
}

fn stop_transcode_session(session_id: &str) -> bool {
    let mut sessions = transcode_sessions().lock().unwrap();
    let Some(mut session) = sessions.remove(session_id) else {
        return false;
    };
    let _ = session.child.kill();
    let _ = session.child.wait();
    let _ = fs::remove_dir_all(session.output_dir);
    true
}

fn start_hls_transcode(
    data_dir: &Path,
    file_path: String,
    options: Option<JsonValue>,
) -> JsonValue {
    if !Path::new(&file_path).is_file() {
        return json!({ "ok": false, "error": "File not found." });
    }
    let Some(ffmpeg) = locate_executable("ffmpeg") else {
        return json!({ "ok": false, "error": "FFmpeg is not available." });
    };

    let options = options_with_selected_preset(&ffmpeg, options.unwrap_or_else(|| json!({})));
    let session_id = format!("session-{}-{}", now_millis(), stable_id(&file_path));
    let output_dir = data_dir.join("transcodes").join(&session_id);
    if fs::create_dir_all(&output_dir).is_err() {
        return json!({ "ok": false, "error": "Unable to create transcode output directory." });
    }
    let playlist_path = output_dir.join("index.m3u8");
    let args = hls_transcode_args(&file_path, &playlist_path.to_string_lossy(), &options);

    let child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        let _ = fs::remove_dir_all(&output_dir);
        return json!({ "ok": false, "error": "Unable to start FFmpeg." });
    };

    if let Err(error) = wait_for_playlist(&playlist_path, &mut child) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&output_dir);
        return json!({ "ok": false, "error": error });
    }

    {
        let mut sessions = transcode_sessions().lock().unwrap();
        sessions.insert(
            session_id.clone(),
            ActiveTranscode {
                output_dir: output_dir.clone(),
                child,
            },
        );
    }

    json!({
        "ok": true,
        "data": {
            "sessionId": session_id,
            "filePath": file_path,
            "playlistUrl": format!(
                "http://127.0.0.1:{}/hls/{}/index.m3u8?{}",
                media_server_port(),
                session_id,
                local_access_query_pair()
            ),
            "outputDir": output_dir.to_string_lossy()
        }
    })
}

fn thumbnail_response(
    mut stream: TcpStream,
    file_path: &str,
    time: Option<String>,
    stream_index: Option<String>,
) {
    let Some(ffmpeg) = locate_executable("ffmpeg") else {
        write_response(
            &mut stream,
            "503 Service Unavailable",
            "text/plain; charset=utf-8",
            b"ffmpeg is not available",
        );
        return;
    };
    let seek = time.unwrap_or_else(|| "00:03:00".to_string());
    let mut args = Vec::<String>::new();
    if stream_index.is_none() {
        args.extend(["-ss".to_string(), seek]);
    }
    args.extend(["-i".to_string(), file_path.to_string()]);
    if let Some(index) = stream_index {
        args.extend(["-map".to_string(), format!("0:{index}")]);
    }
    args.extend(
        [
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ]
        .map(str::to_string),
    );
    let output = Command::new(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(payload) if payload.status.success() && !payload.stdout.is_empty() => {
            write_response(&mut stream, "200 OK", "image/jpeg", &payload.stdout);
        }
        _ => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Thumbnail unavailable",
        ),
    }
}

fn local_image_response(mut stream: TcpStream, file_path: &str) {
    let path = Path::new(file_path);
    if !path.is_file() || !is_image_file(path) {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        );
        return;
    }
    match fs::read(path) {
        Ok(body) => write_response(
            &mut stream,
            "200 OK",
            content_type_for_path(file_path),
            &body,
        ),
        Err(_) => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        ),
    }
}

fn image_mime_from_source(source: &str) -> &'static str {
    match source
        .split('?')
        .next()
        .map(file_extension)
        .unwrap_or_default()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}

fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let (header, body) = data_url.split_once(',')?;
    let mime_type = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = if header.contains(";base64") {
        general_purpose::STANDARD.decode(body).ok()?
    } else {
        percent_decode(body).into_bytes()
    };
    Some((mime_type, bytes))
}

fn image_data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime_type};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

fn materialize_custom_artwork_source(data_dir: &Path, source: &str) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Artwork source is empty.".to_string());
    }

    if trimmed.starts_with("data:") {
        let Some((mime_type, bytes)) = decode_data_url(trimmed) else {
            return Err("Artwork data URL is invalid.".to_string());
        };
        if !mime_type.starts_with("image/") || bytes.is_empty() {
            return Err("Artwork data URL is not an image.".to_string());
        }
        return Ok(trimmed.to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let output = Command::new("curl")
            .args([
                "-fsSL",
                "--connect-timeout",
                "8",
                "--max-time",
                "20",
                trimmed,
            ])
            .output()
            .map_err(|error| format!("Artwork request failed: {error}"))?;
        if !output.status.success() || output.stdout.is_empty() {
            return Err("Artwork request did not return image data.".to_string());
        }
        if output.stdout.len() > 8 * 1024 * 1024 {
            return Err("Artwork image is too large to cache.".to_string());
        }
        let mime_type = image_mime_from_source(trimmed);
        let data_url = image_data_url(mime_type, &output.stdout);
        let _ = database::save_cached_artwork(data_dir, trimmed, &data_url, mime_type, output.stdout.len());
        return Ok(data_url);
    }

    let file_path = if let Some(path) = trimmed.strip_prefix("file://") {
        PathBuf::from(percent_decode(path))
    } else {
        PathBuf::from(trimmed)
    };
    if is_image_file(&file_path) {
        let bytes = fs::read(&file_path).map_err(|error| format!("Artwork file could not be read: {error}"))?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            return Err("Artwork file is empty or too large.".to_string());
        }
        return Ok(image_data_url(content_type_for_path(&file_path.to_string_lossy()), &bytes));
    }

    Err("Artwork source could not be cached.".to_string())
}

fn cached_artwork_response(mut stream: TcpStream, data_dir: &Path, source: &str) {
    if source.trim().is_empty()
        || source.starts_with("data:")
        || source.starts_with("file:")
        || source.contains("127.0.0.1")
        || source.contains("localhost")
    {
        write_response(
            &mut stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"Invalid artwork source",
        );
        return;
    }

    if let Ok(Some(cached)) = database::get_cached_artwork(data_dir, source) {
        if let Some((mime_type, bytes)) = cached
            .get("dataUrl")
            .and_then(Value::as_str)
            .and_then(decode_data_url)
        {
            write_response(&mut stream, "200 OK", &mime_type, &bytes);
            return;
        }
    }

    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--connect-timeout",
            "8",
            "--max-time",
            "20",
            source,
        ])
        .output();
    let Ok(output) = output else {
        write_response(
            &mut stream,
            "502 Bad Gateway",
            "text/plain; charset=utf-8",
            b"Artwork unavailable",
        );
        return;
    };
    if !output.status.success() || output.stdout.is_empty() {
        write_response(
            &mut stream,
            "502 Bad Gateway",
            "text/plain; charset=utf-8",
            b"Artwork unavailable",
        );
        return;
    }

    let mime_type = image_mime_from_source(source);
    let data_url = format!(
        "data:{mime_type};base64,{}",
        general_purpose::STANDARD.encode(&output.stdout)
    );
    let _ =
        database::save_cached_artwork(data_dir, source, &data_url, mime_type, output.stdout.len());
    write_response(&mut stream, "200 OK", mime_type, &output.stdout);
}

fn embedded_subtitle_response(mut stream: TcpStream, file_path: &str, subtitle_ordinal: u32) {
    let Some(ffmpeg) = locate_executable("ffmpeg") else {
        write_response(
            &mut stream,
            "500 Internal Server Error",
            "text/plain; charset=utf-8",
            b"ffmpeg unavailable",
        );
        return;
    };

    let output = Command::new(ffmpeg)
        .args([
            "-loglevel",
            "error",
            "-i",
            file_path,
            "-map",
            &format!("0:s:{subtitle_ordinal}"),
            "-f",
            "webvtt",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(result) if result.status.success() && !result.stdout.is_empty() => {
            write_response(
                &mut stream,
                "200 OK",
                "text/vtt; charset=utf-8",
                &result.stdout,
            );
        }
        _ => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Subtitle stream not found",
        ),
    }
}

fn subtitle_response(mut stream: TcpStream, file_path: &str) {
    match fs::read_to_string(file_path) {
        Ok(content) => {
            let extension = file_extension(file_path);
            let body = if extension == "srt" {
                srt_to_vtt(&content)
            } else {
                content
            };
            let content_type = if extension == "vtt" || extension == "srt" {
                "text/vtt; charset=utf-8"
            } else {
                "text/plain; charset=utf-8"
            };
            write_response(&mut stream, "200 OK", content_type, body.as_bytes());
        }
        Err(_) => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        ),
    }
}

fn read_server_library(data_dir: &Path) -> JsonValue {
    database::load_library(data_dir).unwrap_or_else(|_| {
        read_json_with_default(&data_dir.join(DATA_LIBRARY_FILE), library_default())
    })
}

fn configured_library_roots(library: &JsonValue) -> Vec<PathBuf> {
    normalize_library_folder_groups(library)
        .as_object()
        .map(|groups| {
            groups
                .values()
                .flat_map(|value| value.as_array().cloned().unwrap_or_default())
                .filter_map(|value| value.as_str().map(PathBuf::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn media_path_allowed(data_dir: &Path, file_path: &str) -> bool {
    let path = Path::new(file_path);
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    let transcode_root = data_dir.join("transcodes");
    if canonical_path.starts_with(&transcode_root) {
        return true;
    }
    let library = read_server_library(data_dir);
    let roots = configured_library_roots(&library);
    if roots.is_empty() {
        return true;
    }
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|canonical_root| canonical_path.starts_with(canonical_root))
            .unwrap_or(false)
    })
}

fn read_server_settings(data_dir: &Path) -> JsonValue {
    normalize_settings_payload(
        database::load_settings(data_dir)
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                read_json_with_default(&data_dir.join(DATA_SETTINGS_FILE), settings_default())
            }),
    )
}

fn write_server_settings(data_dir: &Path, settings: JsonValue) -> bool {
    let merged = merge_settings_payload(read_server_settings(data_dir), settings);
    let ok = database::save_settings(data_dir, &merged).is_ok();
    if ok {
        sync_lan_advertisement(data_dir);
    }
    ok
}

fn write_server_library(data_dir: &Path, library: &JsonValue) -> bool {
    database::save_library(data_dir, library).is_ok()
}

fn server_artwork_for_media(data_dir: &Path, media_id: &str) -> JsonValue {
    database::get_custom_artwork(data_dir, media_id).unwrap_or_else(|_| json!({}))
}

fn official_artwork_result(candidate: &JsonValue) -> JsonValue {
    json!({
        "thumbnail": candidate.get("thumbnail").cloned().unwrap_or_else(|| json!("")),
        "cover": candidate.get("cover").cloned().unwrap_or_else(|| json!("")),
        "summary": candidate.get("summary").cloned().unwrap_or_else(|| json!("")),
        "rating": candidate.get("rating").cloned().unwrap_or_else(|| json!(0)),
        "episodes": candidate.get("episodes").cloned(),
        "episodeSource": candidate.get("source").cloned(),
        "posterCandidates": candidate.get("posterCandidates").cloned().unwrap_or_else(|| json!([])),
        "backdropCandidates": candidate.get("backdropCandidates").cloned().unwrap_or_else(|| json!([])),
        "logo": candidate.get("logo").cloned().unwrap_or_else(|| json!("")),
        "logoCandidates": candidate.get("logoCandidates").cloned().unwrap_or_else(|| json!([])),
    })
}

fn split_path_and_query(value: &str) -> (String, Vec<(String, String)>) {
    let (path, query) = value.split_once('?').unwrap_or((value, ""));
    (path.to_string(), parse_query(query))
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.to_ascii_lowercase();
    normalized == "127.0.0.1" || normalized == "localhost" || normalized == "::1"
}

fn local_server_path_query(source: &str) -> Option<(String, Vec<(String, String)>)> {
    let (_, rest) = source.split_once("://")?;
    let slash = rest.find('/')?;
    let host = rest[..slash].split(':').next().unwrap_or("");
    if !is_loopback_host(host) {
        return None;
    }
    let path_query = &rest[slash..];
    let (path, mut query) = split_path_and_query(path_query);
    query.retain(|(key, _)| {
        key != LOCAL_ACCESS_QUERY_PARAM
            && key != LAN_SIGNATURE_PARAM
            && key != LAN_SIGNATURE_EXPIRY_PARAM
            && key != LAN_SIGNATURE_NONCE_PARAM
    });
    Some((path, query))
}

fn is_external_http_url(source: &str) -> bool {
    if let Some((_, rest)) = source.split_once("://") {
        let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
        return (source.starts_with("http://") || source.starts_with("https://"))
            && !is_loopback_host(host);
    }
    false
}

fn local_artwork_route(path: &str) -> bool {
    matches!(
        path,
        "/api/thumbnail" | "/api/local-image" | "/api/cached-artwork"
    )
}

fn query_string(query: &[(String, String)]) -> String {
    query
        .iter()
        .map(|(key, value)| format!("{}={}", percent_escape(key), percent_escape(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn remote_artwork_url(settings: &JsonValue, base: &str, source: &str) -> String {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return trimmed.to_string();
    }
    if let Some((path, query)) = local_server_path_query(trimmed) {
        return signed_lan_url(settings, base, &path, query);
    }
    if is_external_http_url(trimmed) {
        return signed_lan_url(
            settings,
            base,
            "/api/cached-artwork",
            vec![("source".to_string(), trimmed.to_string())],
        );
    }
    trimmed.to_string()
}

/// Routes a remote artwork URL through the local DB-backed caching proxy so it is
/// persisted on first fetch and served from SQLite afterwards. Saved loopback
/// artwork URLs are also rebound to the current server port/token so database
/// thumbnails keep working across app restarts.
fn local_cached_artwork_url(_data_dir: &Path, source: &str) -> String {
    let trimmed = source.trim();
    if let Some((path, query)) = local_server_path_query(trimmed) {
        if local_artwork_route(&path) {
            let url = format!("http://127.0.0.1:{}{}", media_server_port(), path);
            return append_local_access_token_to_url(&append_raw_query(&url, &query_string(&query)));
        }
    }
    if !is_external_http_url(trimmed) {
        return trimmed.to_string();
    }
    append_local_access_token_to_url(&format!(
        "http://127.0.0.1:{}/api/cached-artwork?source={}",
        media_server_port(),
        percent_escape(trimmed)
    ))
}

/// Rewrites every remote artwork field on a library item to the local caching
/// proxy. Keeps already-local thumbnails and custom data-URL artwork intact.
fn rewrite_item_artwork_for_renderer(data_dir: &Path, item: &mut JsonValue) {
    for key in ["poster", "backdrop", "logo"] {
        if let Some(source) = item.get(key).and_then(Value::as_str).map(str::to_string) {
            item[key] = json!(local_cached_artwork_url(data_dir, &source));
        }
    }
    for key in ["posterCandidates", "backdropCandidates", "logoCandidates"] {
        if let Some(values) = item.get_mut(key).and_then(Value::as_array_mut) {
            for value in values {
                if let Some(source) = value.as_str() {
                    *value = json!(local_cached_artwork_url(data_dir, source));
                }
            }
        }
    }
    if let Some(episodes) = item.get_mut("episodes").and_then(Value::as_array_mut) {
        for episode in episodes {
            if let Some(still) = episode.get("still").and_then(Value::as_str).map(str::to_string) {
                episode["still"] = json!(local_cached_artwork_url(data_dir, &still));
            }
        }
    }
}

fn collect_external_artwork(item: &JsonValue, out: &mut Vec<String>) {
    for key in ["poster", "backdrop", "logo"] {
        if let Some(source) = item.get(key).and_then(Value::as_str) {
            if is_external_http_url(source) {
                out.push(source.to_string());
            }
        }
    }
    for key in ["posterCandidates", "backdropCandidates", "logoCandidates"] {
        for value in item.get(key).and_then(Value::as_array).into_iter().flatten() {
            if let Some(source) = value.as_str() {
                if is_external_http_url(source) {
                    out.push(source.to_string());
                }
            }
        }
    }
    for episode in item.get("episodes").and_then(Value::as_array).into_iter().flatten() {
        if let Some(source) = episode.get("still").and_then(Value::as_str) {
            if is_external_http_url(source) {
                out.push(source.to_string());
            }
        }
    }
}

/// Downloads every remote artwork URL in the library into the SQLite artwork
/// cache so posters render instantly and keep working offline. Safe to run in a
/// background thread; already-cached sources are skipped.
fn prewarm_artwork_cache(app: &AppHandle) {
    let data_dir = app_data_dir(app);
    let library = load_library(app);
    let mut sources: Vec<String> = Vec::new();
    for key in ["movies", "tvShows", "animeShows"] {
        for item in library.get(key).and_then(Value::as_array).into_iter().flatten() {
            collect_external_artwork(item, &mut sources);
        }
    }
    sources.sort();
    sources.dedup();
    for source in sources {
        if matches!(database::get_cached_artwork(&data_dir, &source), Ok(Some(_))) {
            continue;
        }
        let _ = materialize_custom_artwork_source(&data_dir, &source);
    }
}

fn spawn_artwork_prewarm(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || prewarm_artwork_cache(&handle));
}

fn remote_subtitle_url(settings: &JsonValue, base: &str, source: &str) -> String {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    let (path, mut query) = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        local_server_path_query(trimmed).unwrap_or_else(|| split_path_and_query(trimmed))
    } else {
        split_path_and_query(trimmed)
    };
    query.retain(|(key, _)| key != LOCAL_ACCESS_QUERY_PARAM);
    if path == "/subtitle" {
        signed_lan_url(settings, base, &path, query)
    } else {
        trimmed.to_string()
    }
}

fn signed_stream_url(settings: &JsonValue, base: &str, file_path: &str) -> String {
    signed_lan_url(
        settings,
        base,
        "/stream",
        vec![("path".to_string(), file_path.to_string())],
    )
}

fn rewrite_item_for_lan(item: &JsonValue, settings: &JsonValue, base: &str) -> JsonValue {
    let mut item = item.clone();
    if let Some(file_path) = item.get("filePath").and_then(Value::as_str) {
        item["filePath"] = json!(signed_stream_url(settings, base, file_path));
    }
    for key in ["poster", "backdrop", "logo"] {
        if let Some(source) = item.get(key).and_then(Value::as_str).map(str::to_string) {
            item[key] = json!(remote_artwork_url(settings, base, &source));
        }
    }
    for key in ["posterCandidates", "backdropCandidates", "logoCandidates"] {
        if let Some(values) = item.get_mut(key).and_then(Value::as_array_mut) {
            for value in values {
                if let Some(source) = value.as_str() {
                    *value = json!(remote_artwork_url(settings, base, source));
                }
            }
        }
    }
    if let Some(subtitles) = item.get_mut("subtitles").and_then(Value::as_array_mut) {
        for subtitle in subtitles {
            if let Some(url) = subtitle.get("url").and_then(Value::as_str).map(str::to_string) {
                subtitle["url"] = json!(remote_subtitle_url(settings, base, &url));
            }
        }
    }
    if let Some(episode_files) = item.get_mut("episodeFiles").and_then(Value::as_array_mut) {
        for episode_file in episode_files {
            if let Some(file_path) = episode_file
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                episode_file["filePath"] = json!(signed_stream_url(settings, base, &file_path));
            }
        }
    }
    if let Some(episodes) = item.get_mut("episodes").and_then(Value::as_array_mut) {
        for episode in episodes {
            if let Some(still) = episode.get("still").and_then(Value::as_str).map(str::to_string) {
                episode["still"] = json!(remote_artwork_url(settings, base, &still));
            }
        }
    }
    item
}

fn library_for_lan(data_dir: &Path, settings: &JsonValue, base: &str) -> JsonValue {
    let library = read_server_library(data_dir);
    let mut output = library.clone();
    output["libraryFolders"] = json!([]);
    output["libraryFolderGroups"] = json!({
        "movies": [],
        "tvShows": [],
        "anime": [],
        "others": [],
    });
    for key in ["movies", "tvShows", "animeShows"] {
        if let Some(items) = output.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                *item = rewrite_item_for_lan(item, settings, base);
            }
        }
    }
    output
}

fn handle_media_connection(mut stream: TcpStream, data_dir: PathBuf) {
    let _ = stream.set_nodelay(true);
    let Some((method, path, query, headers, body)) = parse_request(&mut stream) else {
        return;
    };
    remember_request_headers(&headers);

    if method == "OPTIONS" {
        if !cors_request_allowed(&headers) {
            write_response(
                &mut stream,
                "403 Forbidden",
                "text/plain; charset=utf-8",
                b"CORS origin is not allowed",
            );
            return;
        }
        write_response(
            &mut stream,
            "204 No Content",
            "text/plain; charset=utf-8",
            b"",
        );
        return;
    }

    if path == "/api/ping" {
        write_response(
            &mut stream,
            "200 OK",
            "application/json",
            br#"{"ok":true,"app":"LoomTV"}"#,
        );
        return;
    }

    if path == "/api/lan/info" {
        let settings = ensure_network_settings(read_server_settings(&data_dir));
        let port = media_server_port();
        let body = serde_json::to_vec(&json!({
            "ok": true,
            "app": "LoomTV",
            "deviceId": settings.get("localNetworkDeviceId").and_then(Value::as_str).unwrap_or("loomtv-desktop"),
            "deviceName": settings.get("localNetworkDeviceName").and_then(Value::as_str).unwrap_or("LoomTV"),
            "sharingEnabled": settings.get("localNetworkSharingEnabled").and_then(Value::as_bool).unwrap_or(false),
            "port": port,
            "addresses": local_network_addresses(),
            "appVersion": env!("CARGO_PKG_VERSION"),
        })).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path.starts_with("/hls/") {
        if !has_media_route_access(&data_dir, &path, &query, &headers) {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"Unauthorized",
            );
            return;
        }
        serve_hls_file(stream, &data_dir, &path, &query);
        return;
    }

    if path == "/api/lan/library" {
        let settings = ensure_network_settings(read_server_settings(&data_dir));
        let token = request_bearer_token(&headers, &query);
        if !settings
            .get("localNetworkSharingEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || paired_device_for_token(&settings, &token).is_none()
        {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "application/json",
                br#"{"error":"Unauthorized"}"#,
            );
            return;
        }
        let host = header_value(&headers, "host")
            .cloned()
            .unwrap_or_else(|| format!("127.0.0.1:{}", media_server_port()));
        let base_url = format!("http://{host}");
        let library = library_for_lan(&data_dir, &settings, &base_url);
        let etag = library_etag(&library);
        if header_value(&headers, "if-none-match").map(|value| value.trim_matches('"'))
            == Some(etag.as_str())
        {
            write_response(&mut stream, "304 Not Modified", "application/json", b"");
            return;
        }
        let body = serde_json::to_vec(&library).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/settings" {
        if method == "GET" {
            let settings = read_server_settings(&data_dir);
            let body = serde_json::to_vec(&settings).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, "200 OK", "application/json", &body);
            return;
        }
        if method == "POST" {
            let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
            let ok = write_server_settings(&data_dir, incoming);
            let body = serde_json::to_vec(&json!({ "ok": ok })).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, "200 OK", "application/json", &body);
            return;
        }
    }

    if path == "/api/metadata/test-keys" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let keys = incoming
            .get("keys")
            .cloned()
            .unwrap_or_else(|| incoming.clone());
        let result = run_metadata_key_tests(keys);
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"[]".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/artwork" {
        if method == "GET" {
            let media_id = query_value(&query, "mediaId").unwrap_or_default();
            let artwork = server_artwork_for_media(&data_dir, &media_id);
            let body = serde_json::to_vec(&artwork).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, "200 OK", "application/json", &body);
            return;
        }
        if method == "POST" {
            let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
            let media_id = incoming
                .get("mediaId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let target = incoming.get("target").and_then(Value::as_str).unwrap_or("");
            let data_url = incoming
                .get("dataUrl")
                .or_else(|| incoming.get("data_url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let artwork = materialize_custom_artwork_source(&data_dir, data_url)
                .and_then(|durable_artwork| {
                    database::save_custom_artwork(&data_dir, media_id, target, &durable_artwork)
                        .map_err(|error| error.to_string())
                })
                .unwrap_or_else(|_| json!({}));
            let body = serde_json::to_vec(&artwork).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, "200 OK", "application/json", &body);
            return;
        }
    }

    if path == "/api/artwork/official-candidates" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let media_id = incoming
            .get("mediaId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let library = read_server_library(&data_dir);
        let settings = read_server_settings(&data_dir);
        let result = find_library_item(&library, media_id)
            .map(|item| json!(official_metadata_candidates_for_item(&item, &settings)))
            .unwrap_or_else(|| json!([]));
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"[]".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/artwork/refresh-official" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let media_id = incoming
            .get("mediaId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut library = read_server_library(&data_dir);
        let settings = read_server_settings(&data_dir);
        let metadata = find_library_item(&library, media_id)
            .and_then(|item| fetch_best_metadata_for_item(&item, &settings));
        let result = apply_refreshed_metadata_to_library(
            &mut library,
            media_id,
            metadata,
            server_artwork_for_media(&data_dir, media_id),
        );
        let _ = write_server_library(&data_dir, &library);
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/artwork/apply-official" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let media_id = incoming
            .get("mediaId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let candidate = incoming
            .get("candidate")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut library = read_server_library(&data_dir);
        if candidate.is_object() && update_library_item(&mut library, media_id, &candidate) {
            let _ = write_server_library(&data_dir, &library);
        }
        let result = if candidate.is_object() {
            official_artwork_result(&candidate)
        } else {
            json!({})
        };
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/artwork/playback-logo" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let media_id = incoming
            .get("mediaId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let artwork = server_artwork_for_media(&data_dir, media_id);
        let result = json!({
            "logo": artwork.get("logo").cloned().unwrap_or(JsonValue::Null),
            "logoCandidates": artwork.get("logoCandidates").cloned().unwrap_or_else(|| json!([])),
        });
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/artwork/import" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let entries = incoming
            .get("entries")
            .cloned()
            .unwrap_or_else(|| incoming.clone());
        let ok = database::import_custom_artwork(&data_dir, &entries).is_ok();
        let body = serde_json::to_vec(&json!({ "ok": ok })).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/media/start-transcode" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let file_path = incoming
            .get("filePath")
            .or_else(|| incoming.get("file_path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let options = incoming.get("options").cloned();
        let result = start_hls_transcode(&data_dir, file_path, options);
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/media/probe" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let file_path = incoming
            .get("filePath")
            .or_else(|| incoming.get("file_path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let result = probe_media_file(file_path);
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/media/stop-transcode" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let session_id = incoming
            .get("sessionId")
            .or_else(|| incoming.get("session_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let result = json!({ "ok": true, "data": stop_transcode_session(session_id) });
        let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/lan/pair" && method == "POST" {
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let mut settings = ensure_network_settings(read_server_settings(&data_dir));
        let expected_code = settings
            .get("localNetworkShareToken")
            .and_then(Value::as_str)
            .unwrap_or("");
        let submitted_code = incoming.get("code").and_then(Value::as_str).unwrap_or("");
        if !settings
            .get("localNetworkSharingEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || expected_code != submitted_code
        {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "application/json",
                br#"{"error":"Invalid sharing code"}"#,
            );
            return;
        }
        let requested_device_id = incoming
            .get("deviceId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("remote-{}", now_millis()));
        let requested_device_name = incoming
            .get("deviceName")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("LoomTV device");
        let device_token = stable_id(&format!("{requested_device_id}:{}", now_millis()));
        let now = now_millis();
        let mut devices = settings
            .get("localNetworkPairedDevices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|device| {
                device.get("id").and_then(Value::as_str) != Some(requested_device_id.as_str())
            })
            .collect::<Vec<_>>();
        devices.push(json!({
            "id": requested_device_id,
            "name": requested_device_name,
            "token": device_token,
            "createdAt": now,
            "lastSeenAt": now,
        }));
        settings["localNetworkPairedDevices"] = json!(devices);
        let _ = write_server_settings(&data_dir, settings.clone());
        let host = header_value(&headers, "host")
            .cloned()
            .unwrap_or_else(|| format!("127.0.0.1:{}", media_server_port()));
        let base_url = format!("http://{host}");
        let library = library_for_lan(&data_dir, &settings, &base_url);
        let payload = json!({
            "deviceId": requested_device_id,
            "deviceToken": device_token,
            "hostDeviceId": settings.get("localNetworkDeviceId").and_then(Value::as_str).unwrap_or("loomtv-desktop"),
            "hostDeviceName": settings.get("localNetworkDeviceName").and_then(Value::as_str).unwrap_or("LoomTV"),
            "library": library,
            "libraryEtag": library_etag(&library),
        });
        let body = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
        write_response(&mut stream, "200 OK", "application/json", &body);
        return;
    }

    if path == "/api/lan/unpair" && method == "POST" {
        let token = request_bearer_token(&headers, &query);
        let incoming = serde_json::from_str::<JsonValue>(&body).unwrap_or_else(|_| json!({}));
        let requested_device_id = incoming
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut settings = ensure_network_settings(read_server_settings(&data_dir));
        if paired_device_for_token(&settings, &token).is_none() {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "application/json",
                br#"{"error":"Unauthorized"}"#,
            );
            return;
        }
        if let Some(devices) = settings
            .get_mut("localNetworkPairedDevices")
            .and_then(Value::as_array_mut)
        {
            devices.retain(|device| {
                device.get("id").and_then(Value::as_str) != Some(requested_device_id)
            });
            let _ = write_server_settings(&data_dir, settings);
        }
        write_response(&mut stream, "200 OK", "application/json", br#"{"ok":true}"#);
        return;
    }

    if path == "/api/cached-artwork" {
        let source = query_value(&query, "source").unwrap_or_default();
        cached_artwork_response(stream, &data_dir, &source);
        return;
    }

    let Some(file_path) = query_value(&query, "path") else {
        write_response(
            &mut stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"Missing path",
        );
        return;
    };
    if !media_path_allowed(&data_dir, &file_path) {
        write_response(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Media path is not in the configured library.",
        );
        return;
    }

    if path == "/api/thumbnail" {
        if !has_media_route_access(&data_dir, &path, &query, &headers) {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"Unauthorized",
            );
            return;
        }
        thumbnail_response(
            stream,
            &file_path,
            query_value(&query, "t"),
            query_value(&query, "stream"),
        );
        return;
    }

    if path == "/api/local-image" {
        if !has_media_route_access(&data_dir, &path, &query, &headers) {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"Unauthorized",
            );
            return;
        }
        local_image_response(stream, &file_path);
        return;
    }

    if path == "/subtitle" {
        if !has_media_route_access(&data_dir, &path, &query, &headers) {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"Unauthorized",
            );
            return;
        }
        match query_value(&query, "streamOrdinal").and_then(|value| value.parse::<u32>().ok()) {
            Some(ordinal) => embedded_subtitle_response(stream, &file_path, ordinal),
            None => subtitle_response(stream, &file_path),
        }
        return;
    }

    if path == "/stream" {
        if !has_media_route_access(&data_dir, &path, &query, &headers) {
            write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"Unauthorized",
            );
            return;
        }
        let force_transcode = query_value(&query, "forceTranscode").as_deref() == Some("1")
            || query_value(&query, "force_transcode").as_deref() == Some("1")
            || query_value(&query, "subtitle").is_some()
            || query_value(&query, "video").is_some()
            || query_value(&query, "audio").is_some();
        if should_transcode(&file_path, force_transcode) {
            transcode_stream(stream, &file_path, &query);
        } else {
            stream_file(stream, &file_path, &headers);
        }
        return;
    }

    write_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"Not found",
    );
}

fn start_media_server(app: AppHandle) {
    let data_dir = app_data_dir(&app);
    cleanup_old_transcodes(&data_dir);
    for port in DEFAULT_MEDIA_SERVER_PORT..(DEFAULT_MEDIA_SERVER_PORT + 8) {
        if let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) {
            MEDIA_SERVER_PORT.store(port, Ordering::Relaxed);
            sync_lan_advertisement(&data_dir);
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let data_dir = data_dir.clone();
                    thread::spawn(move || handle_media_connection(stream, data_dir));
                }
            });
            return;
        }
    }
}

fn tag_value<'a>(tags: Option<&'a Map<String, JsonValue>>, keys: &[&str]) -> &'a str {
    let Some(tags) = tags else {
        return "";
    };
    for key in keys {
        if let Some(value) = tags.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    ""
}

fn parse_integer_tag(value: &str) -> Option<u64> {
    value
        .split(['/', '-', ' '])
        .next()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn provider_ids_from_text(value: &str) -> JsonValue {
    let mut ids = Map::new();
    let lower = value.to_ascii_lowercase();
    for (label, key) in [
        ("tmdb", "tmdbId"),
        ("imdb", "imdbId"),
        ("tvdb", "tvdbId"),
        ("mal", "malId"),
    ] {
        if let Some(position) = lower.find(label) {
            let digits = lower[position + label.len()..]
                .chars()
                .skip_while(|value| !value.is_ascii_alphanumeric())
                .take_while(|value| value.is_ascii_alphanumeric())
                .collect::<String>();
            if !digits.is_empty() {
                ids.insert(key.to_string(), json!(digits));
            }
        }
    }
    JsonValue::Object(ids)
}

fn probe_media_details(file_path: &str) -> JsonValue {
    let Some(ffprobe) = locate_executable("ffprobe") else {
        return json!({});
    };
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            file_path,
        ])
        .output();
    let Ok(output) = output else {
        return json!({});
    };
    if !output.status.success() {
        return json!({});
    }
    let parsed: JsonValue = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| json!({}));
    let streams = parsed
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tracks = streams
        .iter()
        .map(|stream| {
            let disposition = stream.get("disposition").and_then(Value::as_object);
            let tags = stream.get("tags").and_then(Value::as_object);
            json!({
                "index": stream.get("index").and_then(Value::as_i64).unwrap_or(0),
                "type": stream.get("codec_type").and_then(Value::as_str).unwrap_or("unknown"),
                "codec": stream.get("codec_name").and_then(Value::as_str).unwrap_or(""),
                "language": tags.and_then(|tags| tags.get("language")).and_then(Value::as_str).unwrap_or(""),
                "title": tags.and_then(|tags| tags.get("title")).and_then(Value::as_str).unwrap_or(""),
                "channels": stream.get("channels").and_then(Value::as_i64),
                "width": stream.get("width").and_then(Value::as_i64),
                "height": stream.get("height").and_then(Value::as_i64),
                "profile": stream.get("profile").and_then(Value::as_str).unwrap_or(""),
                "pixelFormat": stream.get("pix_fmt").and_then(Value::as_str).unwrap_or(""),
                "attachedPic": disposition.and_then(|value| value.get("attached_pic")).and_then(Value::as_i64).unwrap_or(0) == 1,
                "default": disposition.and_then(|value| value.get("default")).and_then(Value::as_i64).unwrap_or(0) == 1,
                "forced": disposition.and_then(|value| value.get("forced")).and_then(Value::as_i64).unwrap_or(0) == 1,
            })
        })
        .collect::<Vec<_>>();
    let video = tracks
        .iter()
        .find(|track| {
            track.get("type").and_then(Value::as_str) == Some("video")
                && !track
                    .get("attachedPic")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .or_else(|| {
            tracks
                .iter()
                .find(|track| track.get("type").and_then(Value::as_str) == Some("video"))
        });
    let audio = tracks
        .iter()
        .find(|track| track.get("type").and_then(Value::as_str) == Some("audio"));
    let subtitle_streams = tracks
        .iter()
        .filter(|track| track.get("type").and_then(Value::as_str) == Some("subtitle"))
        .cloned()
        .collect::<Vec<_>>();
    let format = parsed.get("format").cloned().unwrap_or_else(|| json!({}));
    let format_tags = format.get("tags").and_then(Value::as_object);
    let video_tags = video
        .and_then(|track| track.get("index").and_then(Value::as_i64))
        .and_then(|index| {
            streams
                .iter()
                .find(|stream| stream.get("index").and_then(Value::as_i64) == Some(index))
        })
        .and_then(|stream| stream.get("tags").and_then(Value::as_object));
    let embedded_thumbnail_stream = streams.iter().find(|stream| {
        let disposition = stream.get("disposition").and_then(Value::as_object);
        let codec = stream
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        disposition
            .and_then(|value| value.get("attached_pic"))
            .and_then(Value::as_i64)
            == Some(1)
            || (stream.get("codec_type").and_then(Value::as_str) == Some("attachment")
                && matches!(codec, "mjpeg" | "jpeg" | "png" | "webp" | "bmp"))
    });
    let title = tag_value(format_tags, &["title", "name"])
        .trim()
        .to_string();
    let video_title = tag_value(video_tags, &["title", "name"]).trim().to_string();
    let show_title = tag_value(
        format_tags,
        &[
            "show",
            "showtitle",
            "series",
            "series_title",
            "tvshow",
            "tv_show",
            "album",
        ],
    )
    .trim()
    .to_string();
    let video_show_title = tag_value(
        video_tags,
        &[
            "show",
            "showtitle",
            "series",
            "series_title",
            "tvshow",
            "tv_show",
            "album",
        ],
    )
    .trim()
    .to_string();
    let summary = tag_value(
        format_tags,
        &["description", "comment", "synopsis", "overview", "summary"],
    )
    .trim()
    .to_string();
    let date = tag_value(
        format_tags,
        &[
            "date",
            "year",
            "originaldate",
            "original_date",
            "release_date",
            "releasedate",
        ],
    );
    let season = tag_value(
        format_tags,
        &["season_number", "season", "season_sort", "part_number"],
    );
    let episode = tag_value(
        format_tags,
        &[
            "episode_sort",
            "episode_id",
            "episode_number",
            "episode",
            "track",
            "tracknumber",
        ],
    );
    let duration = format
        .get("duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value.round() as u64);
    let bitrate = format
        .get("bit_rate")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| (value / 1000.0).round() as u64);
    json!({
        "filePath": file_path,
        "container": format.get("format_name").and_then(Value::as_str).unwrap_or("").split(',').next().unwrap_or(""),
        "durationSeconds": duration,
        "bitrateKbps": bitrate,
        "videoCodec": video.and_then(|track| track.get("codec")).and_then(Value::as_str).unwrap_or(""),
        "audioCodec": audio.and_then(|track| track.get("codec")).and_then(Value::as_str).unwrap_or(""),
        "resolution": {
            "width": video.and_then(|track| track.get("width")).and_then(Value::as_i64),
            "height": video.and_then(|track| track.get("height")).and_then(Value::as_i64),
        },
        "embeddedTitle": if title.is_empty() { video_title } else { title },
        "embeddedShowTitle": if show_title.is_empty() { video_show_title } else { show_title },
        "embeddedThumbnailStreamIndex": embedded_thumbnail_stream.and_then(|stream| stream.get("index")).and_then(Value::as_i64),
        "summary": summary,
        "year": year_from_text(date),
        "season": parse_integer_tag(season),
        "episode": parse_integer_tag(episode),
        "providerIds": provider_ids_from_text(&format!("{file_path} {}", tag_value(format_tags, &["comment", "description"]))),
        "subtitleStreams": subtitle_streams,
        "tracks": tracks,
    })
}

fn local_metadata_from_probe(probe: &JsonValue) -> JsonValue {
    let tracks = probe
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let audio_tracks = tracks
        .iter()
        .filter(|track| track.get("type").and_then(Value::as_str) == Some("audio"))
        .count();
    let subtitle_tracks = tracks
        .iter()
        .filter(|track| track.get("type").and_then(Value::as_str) == Some("subtitle"))
        .count();
    json!({
        "durationSeconds": probe.get("durationSeconds").and_then(Value::as_u64),
        "width": probe.get("resolution").and_then(|value| value.get("width")).and_then(Value::as_i64),
        "height": probe.get("resolution").and_then(|value| value.get("height")).and_then(Value::as_i64),
        "videoCodec": probe.get("videoCodec").and_then(Value::as_str).unwrap_or(""),
        "videoProfile": probe.get("tracks").and_then(Value::as_array).and_then(|tracks| tracks.iter().find(|track| track.get("type").and_then(Value::as_str) == Some("video"))).and_then(|track| track.get("profile")).and_then(Value::as_str).unwrap_or(""),
        "pixelFormat": probe.get("tracks").and_then(Value::as_array).and_then(|tracks| tracks.iter().find(|track| track.get("type").and_then(Value::as_str) == Some("video"))).and_then(|track| track.get("pixelFormat")).and_then(Value::as_str).unwrap_or(""),
        "audioCodec": probe.get("audioCodec").and_then(Value::as_str).unwrap_or(""),
        "audioTracks": audio_tracks,
        "subtitleTracks": subtitle_tracks,
        "bitrateKbps": probe.get("bitrateKbps").and_then(Value::as_u64),
        "container": probe.get("container").and_then(Value::as_str).unwrap_or(""),
    })
}

fn collect_subtitle_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_subtitle_file(path))
        .collect()
}

fn immediate_video_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_video_file(path))
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn immediate_subdirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

fn has_season_dirs(dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|dir| {
        let name = parent_name(dir).to_ascii_lowercase();
        name.contains("season") || name.contains("series")
    })
}

fn normalize_folder_kind_name(folder: &Path) -> String {
    parent_name(folder)
        .to_ascii_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn detect_library_folder_kind(folder: &Path) -> Option<&'static str> {
    match normalize_folder_kind_name(folder).as_str() {
        "movie" | "movies" | "film" | "films" | "cinema" => Some("movies"),
        "tv" | "tv show" | "tv shows" | "television" | "show" | "shows" | "series" => Some("tv"),
        "anime" | "animes" | "donghua" => Some("anime"),
        _ => None,
    }
}

fn is_likely_anime_path(path: &Path) -> bool {
    let value = path.to_string_lossy().to_ascii_lowercase();
    value.contains("anime")
        || value.contains("donghua")
        || value.contains("ova")
        || value.contains("ona")
        || value.contains("subsplease")
        || value.contains("horriblesubs")
        || value.contains("erai-raws")
}

fn is_likely_tv_file(path: &Path) -> bool {
    let name = file_stem(&path.to_string_lossy()).to_ascii_lowercase();
    if name
        .as_bytes()
        .windows(2)
        .any(|window| window[0] == b's' && window[1].is_ascii_digit())
        && name.contains('e')
    {
        return true;
    }
    let bytes = name.as_bytes();
    bytes.windows(4).any(|window| {
        window[0].is_ascii_digit()
            && (window[1] == b'x' || window[1] == b'X')
            && window[2].is_ascii_digit()
            && window[3].is_ascii_digit()
    }) || name.contains("episode")
}

fn is_skipped_episode_dir(path: &Path) -> bool {
    matches!(
        normalize_folder_kind_name(path).as_str(),
        "nc" | "nced"
            | "ncop"
            | "bonus"
            | "extras"
            | "extra"
            | "special"
            | "specials"
            | "behind the scenes"
            | "featurettes"
            | "interviews"
            | "scenes"
            | "shorts"
            | "trailers"
            | "featurette"
            | "sample"
            | "samples"
            | "subs"
            | "subtitles"
    )
}

fn season_from_path(root: &Path, dir: &Path) -> Option<u64> {
    let relative = dir.strip_prefix(root).unwrap_or(dir);
    for component in relative.components().rev() {
        let part = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        for marker in ["season", "series", "s"] {
            if let Some(position) = part.find(marker) {
                let digits = part[position + marker.len()..]
                    .chars()
                    .skip_while(|value| !value.is_ascii_digit())
                    .take_while(|value| value.is_ascii_digit())
                    .collect::<String>();
                if let Ok(season) = digits.parse::<u64>() {
                    return Some(season.max(1));
                }
            }
        }
    }
    None
}

fn episode_from_name(file_name: &str, fallback_season: u64) -> Option<(u64, u64)> {
    let without_ext = file_name
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(file_name);
    let lower = without_ext.to_ascii_lowercase();
    let chars = lower.chars().collect::<Vec<_>>();

    for (index, value) in chars.iter().enumerate() {
        if *value != 's' {
            continue;
        }
        let season = chars[index + 1..]
            .iter()
            .skip_while(|value| !value.is_ascii_digit())
            .take_while(|value| value.is_ascii_digit())
            .collect::<String>();
        if season.is_empty() || season.len() > 2 {
            continue;
        }
        let season_end = index
            + 1
            + chars[index + 1..]
                .iter()
                .position(|value| value.is_ascii_digit())
                .unwrap_or(0)
            + season.len();
        let rest = chars[season_end..].iter().collect::<String>();
        if let Some(e_position) = rest.find('e') {
            let episode = rest[e_position + 1..]
                .chars()
                .skip_while(|value| !value.is_ascii_digit())
                .take_while(|value| value.is_ascii_digit())
                .collect::<String>();
            if let (Ok(season), Ok(episode)) = (season.parse::<u64>(), episode.parse::<u64>()) {
                return Some((season.max(1), episode.max(1)));
            }
        }
    }

    for marker in ["episode", "ep", "e"] {
        if let Some(position) = lower.find(marker) {
            let digits = lower[position + marker.len()..]
                .chars()
                .skip_while(|value| !value.is_ascii_digit())
                .take_while(|value| value.is_ascii_digit())
                .collect::<String>();
            if let Ok(episode) = digits.parse::<u64>() {
                return Some((fallback_season, episode.max(1)));
            }
        }
    }

    let normalized = without_ext.replace(['.', '_', '-'], " ");
    if let Some(token) = normalized.split_whitespace().last() {
        if let Ok(episode) = token.trim_start_matches('0').parse::<u64>() {
            if episode < 1900 || episode > 2099 {
                return Some((fallback_season, episode.max(1)));
            }
        }
    }

    if let Some(token) = normalized.split_whitespace().next() {
        if let Ok(episode) = token.trim_start_matches('0').parse::<u64>() {
            return Some((fallback_season, episode.max(1)));
        }
    }

    None
}

fn scan_episode_files(folder: &Path) -> Vec<PathBuf> {
    fn scan_dir(root: &Path, dir: &Path, files: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if !is_skipped_episode_dir(&path) {
                    scan_dir(root, &path, files);
                }
            } else if path.is_file() && is_video_file(&path) {
                let fallback_season = season_from_path(root, dir).unwrap_or(1);
                let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if episode_from_name(file_name, fallback_season).is_some() {
                    files.push(path);
                }
            }
        }
    }

    let mut files = Vec::new();
    scan_dir(folder, folder, &mut files);
    files.sort_by_key(|path| parse_episode_in_folder(folder, path));
    files
}

fn should_split_container_folder(folder: &Path, subdirs: &[PathBuf]) -> bool {
    let kind = detect_library_folder_kind(folder);
    kind.is_some()
        || subdirs
            .iter()
            .filter(|dir| {
                !scan_episode_files(dir).is_empty() || !immediate_video_files(dir).is_empty()
            })
            .count()
            > 1
}

fn should_treat_as_tv(folder: &Path, video_files: &[PathBuf], has_season_dirs: bool) -> bool {
    has_season_dirs
        || video_files.iter().any(|path| is_likely_tv_file(path))
        || normalize_folder_kind_name(folder).contains("season")
}

fn parse_episode_in_folder(root: &Path, path: &Path) -> (u64, u64) {
    let fallback_season = path
        .parent()
        .and_then(|parent| season_from_path(root, parent))
        .unwrap_or(1);
    path.file_name()
        .and_then(|value| value.to_str())
        .and_then(|name| episode_from_name(name, fallback_season))
        .unwrap_or((fallback_season, 1))
}

fn local_episode_title(path: &Path, episode: u64) -> String {
    let fallback = file_stem(&path.to_string_lossy())
        .replace(['.', '_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if fallback.is_empty() {
        format!("Episode {episode}")
    } else {
        fallback
    }
}

fn normalized_artwork_base_name(path: &Path) -> String {
    file_stem(&path.to_string_lossy())
        .to_ascii_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn find_local_artwork_file(folder: &Path, preferred_base_names: &[&str]) -> Option<PathBuf> {
    let preferred = preferred_base_names
        .iter()
        .map(|name| {
            name.to_ascii_lowercase()
                .chars()
                .map(|value| {
                    if value.is_ascii_alphanumeric() {
                        value
                    } else {
                        ' '
                    }
                })
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    let mut candidates = fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_image_file(path))
        .map(|path| {
            let base = normalized_artwork_base_name(&path);
            let score = preferred
                .iter()
                .position(|name| &base == name)
                .or_else(|| {
                    preferred
                        .iter()
                        .position(|name| base.starts_with(&format!("{name} ")))
                        .map(|index| index + 50)
                })
                .or_else(|| {
                    preferred
                        .iter()
                        .position(|name| base.contains(name))
                        .map(|index| index + 100)
                })
                .unwrap_or(1000);
            (score, path)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    candidates.into_iter().next().map(|(_, path)| path)
}

fn local_image_url(path: &Path) -> String {
    append_local_access_token_to_url(&format!(
        "http://127.0.0.1:{}/api/local-image?path={}",
        media_server_port(),
        percent_escape(&path.to_string_lossy())
    ))
}

fn local_thumbnail_url(path: &Path) -> String {
    append_local_access_token_to_url(&format!(
        "http://127.0.0.1:{}/api/thumbnail?path={}",
        media_server_port(),
        percent_escape(&path.to_string_lossy())
    ))
}

fn embedded_thumbnail_url(path: &Path, probe: &JsonValue) -> String {
    let Some(index) = probe
        .get("embeddedThumbnailStreamIndex")
        .and_then(Value::as_i64)
    else {
        return String::new();
    };
    append_local_access_token_to_url(&format!(
        "http://127.0.0.1:{}/api/thumbnail?path={}&stream={index}",
        media_server_port(),
        percent_escape(&path.to_string_lossy())
    ))
}

fn local_folder_artwork_url(folder: &Path, kind: &str) -> String {
    let preferred: &[&str] = if kind == "poster" {
        &[
            "poster",
            "folder",
            "cover",
            "thumbnail",
            "thumb",
            "default",
            "movie",
        ]
    } else {
        &["backdrop", "fanart", "background", "landscape", "banner"]
    };
    find_local_artwork_file(folder, preferred)
        .map(|path| local_image_url(&path))
        .unwrap_or_default()
}

fn local_movie_artwork_url(video_path: &Path, kind: &str) -> String {
    let folder = video_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = file_stem(&video_path.to_string_lossy());
    let poster_names = vec![
        stem.as_str(),
        "poster",
        "folder",
        "cover",
        "thumbnail",
        "thumb",
        "default",
        "movie",
    ];
    let backdrop_stem = format!("{stem} backdrop");
    let fanart_stem = format!("{stem} fanart");
    let backdrop_names = vec![
        backdrop_stem.as_str(),
        fanart_stem.as_str(),
        "backdrop",
        "fanart",
        "background",
        "landscape",
        "banner",
    ];
    let preferred = if kind == "poster" {
        poster_names
    } else {
        backdrop_names
    };
    find_local_artwork_file(folder, &preferred)
        .map(|path| local_image_url(&path))
        .unwrap_or_default()
}

fn subtitle_records(base: &Path, files: &[PathBuf]) -> Vec<JsonValue> {
    files
        .iter()
        .filter_map(|path| {
            let file_name = path.file_name()?.to_str()?.to_string();
            let lang = file_name
                .split('.')
                .find(|part| part.len() == 2 || part.len() == 3)
                .unwrap_or("en")
                .to_ascii_lowercase();
            let full_path = if path.is_absolute() {
                path.clone()
            } else {
                base.join(path)
            };
            Some(json!({
                "lang": lang,
                "label": lang.to_ascii_uppercase(),
                "url": format!(
                    "/subtitle?path={}&{}",
                    percent_escape(&full_path.to_string_lossy()),
                    local_access_query_pair()
                ),
            }))
        })
        .collect()
}

fn build_movie_item(file_path: &Path, forced_type: &str) -> JsonValue {
    let file_path_str = file_path.to_string_lossy().to_string();
    let probe = probe_media_details(&file_path_str);
    let metadata = local_metadata_from_probe(&probe);
    let title = clean_title(&parent_name(file_path));
    let stats = fs::metadata(file_path).ok();
    let parent = file_path.parent().unwrap_or_else(|| Path::new(""));
    let subtitles = collect_subtitle_files(parent)
        .into_iter()
        .filter(|path| file_stem(&path.to_string_lossy()).starts_with(&file_stem(&file_path_str)))
        .collect::<Vec<_>>();
    let item_type = if forced_type == "anime" {
        "anime"
    } else if forced_type == "tv" {
        "tv"
    } else {
        "movie"
    };
    let local_poster = local_movie_artwork_url(file_path, "poster");
    let local_backdrop = local_movie_artwork_url(file_path, "backdrop");
    let embedded_poster = embedded_thumbnail_url(file_path, &probe);
    let generated_thumbnail = local_thumbnail_url(file_path);
    let poster = [
        local_poster.as_str(),
        embedded_poster.as_str(),
        generated_thumbnail.as_str(),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or("")
    .to_string();
    json!({
        "id": format!("file-{}", stable_id(&file_path_str)),
        "type": item_type,
        "title": title,
        "year": 0,
        "poster": poster,
        "backdrop": local_backdrop,
        "logo": "",
        "posterCandidates": unique_strings(vec![local_poster, embedded_poster, generated_thumbnail]),
        "backdropCandidates": unique_strings(vec![local_backdrop.clone()]),
        "logoCandidates": [],
        "summary": "",
        "rating": 0,
        "genres": [],
        "cast": [],
        "filePath": file_path_str,
        "fileSize": stats.map(|value| value.len()).unwrap_or(0),
        "subtitles": subtitle_records(parent, &subtitles),
        "localMetadata": metadata,
    })
}

fn build_show_item(folder: &Path, forced_type: &str) -> Option<JsonValue> {
    let episode_paths = scan_episode_files(folder);
    if episode_paths.is_empty() {
        return None;
    }
    let folder_path = folder.to_string_lossy().to_string();
    let title = clean_title(&parent_name(folder));
    let item_type = if forced_type == "anime" {
        "anime"
    } else {
        "tv"
    };
    let mut episode_files = Vec::new();
    let mut season_counts = std::collections::BTreeMap::<u64, u64>::new();
    for video in &episode_paths {
        let video_path = video.to_string_lossy().to_string();
        let probe = probe_media_details(&video_path);
        let parsed = parse_episode_in_folder(folder, video);
        let season = probe
            .get("season")
            .and_then(Value::as_u64)
            .unwrap_or(parsed.0);
        let episode = probe
            .get("episode")
            .and_then(Value::as_u64)
            .unwrap_or(parsed.1);
        *season_counts.entry(season).or_insert(0) += 1;
        episode_files.push(json!({
            "season": season,
            "episode": episode,
            "filePath": video_path,
            "title": probe.get("embeddedTitle").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or_else(|| {
                // This fallback intentionally preserves local names until remote metadata is merged.
                ""
            }),
            "localMetadata": local_metadata_from_probe(&probe),
        }));
        if episode_files
            .last()
            .and_then(|item| item.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            if let Some(last) = episode_files.last_mut() {
                last["title"] = json!(local_episode_title(video, episode));
            }
        }
    }
    episode_files.sort_by_key(|value| {
        (
            value.get("season").and_then(Value::as_u64).unwrap_or(1),
            value.get("episode").and_then(Value::as_u64).unwrap_or(1),
        )
    });
    let seasons = season_counts
        .iter()
        .map(|(season, count)| {
            json!({
                "number": season,
                "title": format!("Season {}", format!("{season:02}")),
                "episodeCount": count,
            })
        })
        .collect::<Vec<_>>();
    let episodes = episode_files
        .iter()
        .map(|episode| {
            json!({
                "season": episode.get("season").and_then(Value::as_u64).unwrap_or(1),
                "number": episode.get("episode").and_then(Value::as_u64).unwrap_or(1),
                "title": episode.get("title").and_then(Value::as_str).unwrap_or("Episode"),
                "summary": "",
                "still": "",
                "rating": 0,
                "airDate": "",
                "localMetadata": episode.get("localMetadata").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect::<Vec<_>>();
    let first_file = episode_files
        .first()
        .and_then(|value| value.get("filePath"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let first_path = if first_file.is_empty() {
        None
    } else {
        Some(Path::new(first_file))
    };
    let local_poster = local_folder_artwork_url(folder, "poster");
    let local_backdrop = local_folder_artwork_url(folder, "backdrop");
    let generated_thumbnail = first_path.map(local_thumbnail_url).unwrap_or_default();
    let poster = [local_poster.as_str(), generated_thumbnail.as_str()]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_string();
    Some(json!({
        "id": format!("folder-{}", stable_id(&folder_path)),
        "type": item_type,
        "title": title,
        "year": 0,
        "poster": poster,
        "backdrop": local_backdrop,
        "logo": "",
        "posterCandidates": unique_strings(vec![local_poster, generated_thumbnail]),
        "backdropCandidates": unique_strings(vec![local_backdrop.clone()]),
        "logoCandidates": [],
        "summary": "",
        "rating": 0,
        "genres": [],
        "cast": [],
        "filePath": folder_path,
        "fileSize": 0,
        "subtitles": [],
        "localMetadata": episode_files.first().and_then(|value| value.get("localMetadata")).cloned().unwrap_or_else(|| json!({})),
        "seasons": seasons,
        "episodes": episodes,
        "episodeFiles": episode_files,
    }))
}

fn default_library_folder_groups() -> JsonValue {
    json!({ "movies": [], "tvShows": [], "anime": [], "others": [] })
}

fn push_unique_group(groups: &mut JsonValue, group: &str, folder: &str) {
    if groups.get(group).and_then(Value::as_array).is_none() {
        groups[group] = json!([]);
    }
    if let Some(values) = groups.get_mut(group).and_then(Value::as_array_mut) {
        if !values.iter().any(|value| value.as_str() == Some(folder)) {
            values.push(json!(folder));
        }
    }
}

fn normalize_library_folder_groups(library: &JsonValue) -> JsonValue {
    let mut groups = library
        .get("libraryFolderGroups")
        .cloned()
        .unwrap_or_else(default_library_folder_groups);
    for group in ["movies", "tvShows", "anime", "others"] {
        if groups.get(group).and_then(Value::as_array).is_none() {
            groups[group] = json!([]);
        }
    }

    for folder in library
        .get("libraryFolders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let already_present = ["movies", "tvShows", "anime", "others"]
            .iter()
            .any(|group| {
                groups
                    .get(*group)
                    .and_then(Value::as_array)
                    .map(|values| values.iter().any(|value| value.as_str() == Some(folder)))
                    .unwrap_or(false)
            });
        if already_present {
            continue;
        }
        match detect_library_folder_kind(Path::new(folder)) {
            Some("movies") => push_unique_group(&mut groups, "movies", folder),
            Some("tv") => push_unique_group(&mut groups, "tvShows", folder),
            Some("anime") => push_unique_group(&mut groups, "anime", folder),
            _ => push_unique_group(&mut groups, "others", folder),
        }
    }

    groups
}

fn scan_directory_as_item(folder: &Path, kind: &str) -> Option<JsonValue> {
    let video_files = immediate_video_files(folder);
    let subdirs = immediate_subdirs(folder);
    let has_seasons = has_season_dirs(&subdirs);
    let nested_episode_files = if video_files.is_empty() && !has_seasons {
        scan_episode_files(folder)
    } else {
        Vec::new()
    };

    if kind != "auto" && detect_library_folder_kind(folder).is_some() {
        return None;
    }
    if kind == "movies" && video_files.len() > 1 {
        return None;
    }
    if video_files.is_empty() && !has_seasons && nested_episode_files.is_empty() {
        return None;
    }
    if !nested_episode_files.is_empty() && should_split_container_folder(folder, &subdirs) {
        return None;
    }

    if kind == "movies" {
        return video_files
            .first()
            .map(|path| build_movie_item(path, "movie"));
    }

    let is_tv =
        !nested_episode_files.is_empty() || should_treat_as_tv(folder, &video_files, has_seasons);
    if (kind == "tv" || kind == "anime") && !is_tv {
        return video_files.first().map(|path| build_movie_item(path, kind));
    }
    if is_tv || kind == "tv" || kind == "anime" {
        let show_kind = if kind == "anime" || is_likely_anime_path(folder) {
            "anime"
        } else {
            "tv"
        };
        return build_show_item(folder, show_kind);
    }

    video_files
        .first()
        .map(|path| build_movie_item(path, "movie"))
}

fn scan_folder(folder: &Path, kind: &str) -> Vec<JsonValue> {
    let mut items = Vec::new();
    if !folder.exists() {
        return items;
    }

    for video in immediate_video_files(folder) {
        if kind != "movies" && is_likely_tv_file(&video) {
            continue;
        }
        let forced_type = match kind {
            "movies" => "movie",
            "anime" => "anime",
            "tv" => "tv",
            _ => "movie",
        };
        items.push(build_movie_item(&video, forced_type));
    }

    for entry in immediate_subdirs(folder) {
        let video_files = immediate_video_files(&entry);
        let subdirs = immediate_subdirs(&entry);
        let has_seasons = has_season_dirs(&subdirs);

        if video_files.is_empty() && !subdirs.is_empty() && !has_seasons {
            let nested_episode_files = scan_episode_files(&entry);
            if kind != "movies"
                && !nested_episode_files.is_empty()
                && !should_split_container_folder(&entry, &subdirs)
            {
                let show_kind = if kind == "anime" || is_likely_anime_path(&entry) {
                    "anime"
                } else {
                    "tv"
                };
                if let Some(show) = build_show_item(&entry, show_kind) {
                    items.push(show);
                }
                continue;
            }
            items.extend(scan_folder(&entry, kind));
            continue;
        }

        let is_tv = kind == "tv"
            || kind == "anime"
            || (kind != "movies" && should_treat_as_tv(&entry, &video_files, has_seasons));
        if is_tv {
            let show_kind = if kind == "anime" || is_likely_anime_path(&entry) {
                "anime"
            } else {
                "tv"
            };
            if let Some(show) = build_show_item(&entry, show_kind) {
                items.push(show);
            }
        } else if let Some(video) = video_files.first() {
            items.push(build_movie_item(
                video,
                if kind == "movies" { "movie" } else { "movie" },
            ));
        }
    }

    items
}

fn metadata_key(settings: &JsonValue, provider: &str) -> Option<String> {
    let normalized = provider.to_ascii_lowercase();
    settings
        .get("metadataApiKeys")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get(&normalized))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let legacy_key = match normalized.as_str() {
                "tmdb" => "tmdbApiKey",
                "omdb" => "omdbApiKey",
                _ => return None,
            };
            settings
                .get(legacy_key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
}

fn metadata_key_candidates(settings: &JsonValue, provider: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(key) = metadata_key(settings, provider) {
        candidates.push(key);
    }
    if let Some(keys) = settings.get("metadataApiKeys").and_then(Value::as_object) {
        for value in keys.values().filter_map(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && !candidates.iter().any(|candidate| candidate == trimmed) {
                candidates.push(trimmed.to_string());
            }
        }
    }
    candidates
}

fn http_json(url: &str, headers: &[String]) -> Option<JsonValue> {
    let mut command = Command::new("curl");
    command.args(http_json_curl_args());
    for header in headers {
        command.args(["-H", header]);
    }
    command.arg(url);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_http_json_body(&output.stdout)
}

fn http_json_curl_args() -> [&'static str; 5] {
    ["-fsSL", "--connect-timeout", "8", "--max-time", "20"]
}

fn parse_http_json_body(body: &[u8]) -> Option<JsonValue> {
    if body.starts_with(&[0x1f, 0x8b]) {
        return parse_gzip_json_body(body);
    }

    serde_json::from_slice(body).ok()
}

fn parse_gzip_json_body(body: &[u8]) -> Option<JsonValue> {
    let mut child = Command::new("gzip")
        .args(["-dc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    stdin.write_all(body).ok()?;
    drop(stdin);

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }

    serde_json::from_slice(&output.stdout).ok()
}

fn is_tmdb_read_access_token(value: &str) -> bool {
    let parts = value.trim().split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

fn tmdb_json(path: &str, credential: &str) -> Option<JsonValue> {
    let credential = credential.trim().trim_start_matches("Bearer ").trim();
    if credential.is_empty() {
        return None;
    }
    let separator = if path.contains('?') { '&' } else { '?' };
    let mut url = format!("https://api.themoviedb.org/3/{path}{separator}language=en-US");
    let mut headers = Vec::new();
    if is_tmdb_read_access_token(credential) {
        headers.push(format!("Authorization: Bearer {credential}"));
    } else {
        url.push_str("&api_key=");
        url.push_str(&percent_escape(credential));
    }
    http_json(&url, &headers)
}

fn tmdb_image(size: &str, path: Option<&str>) -> String {
    match path {
        Some(path) if !path.trim().is_empty() => {
            format!("https://image.tmdb.org/t/p/{size}{path}")
        }
        _ => String::new(),
    }
}

fn json_string(value: &JsonValue, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn json_rating(value: &JsonValue, key: &str) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .or_else(|| {
            value
                .get(key)
                .and_then(Value::as_str)
                .and_then(|raw| raw.parse::<f64>().ok())
        })
        .unwrap_or(0.0)
}

fn year_from_date(value: &str) -> u64 {
    value
        .get(0..4)
        .and_then(|year| year.parse::<u64>().ok())
        .filter(|year| (1900..=2100).contains(year))
        .unwrap_or(0)
}

fn year_from_text(value: &str) -> u64 {
    for token in value.split(|c: char| !c.is_ascii_digit()) {
        if token.len() == 4 {
            if let Ok(year) = token.parse::<u64>() {
                if (1900..=2100).contains(&year) {
                    return year;
                }
            }
        }
    }
    0
}

fn item_lookup_title(item: &JsonValue) -> String {
    let title = item.get("title").and_then(Value::as_str).unwrap_or("");
    if !title.trim().is_empty() {
        return metadata_lookup_title(title);
    }
    item.get("filePath")
        .and_then(Value::as_str)
        .map(file_name_from_path)
        .map(|value| metadata_lookup_title(&value))
        .unwrap_or_default()
}

fn item_lookup_year(item: &JsonValue) -> u64 {
    item.get("year")
        .and_then(Value::as_u64)
        .filter(|year| *year > 0)
        .unwrap_or_else(|| {
            let search_space = format!(
                "{} {}",
                item.get("title").and_then(Value::as_str).unwrap_or(""),
                item.get("filePath").and_then(Value::as_str).unwrap_or("")
            );
            year_from_text(&search_space)
        })
}

fn item_tmdb_kind(item: &JsonValue) -> &'static str {
    match item.get("type").and_then(Value::as_str) {
        Some("movie") => "movie",
        _ => "tv",
    }
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !output.iter().any(|entry| entry == trimmed) {
            output.push(trimmed.to_string());
        }
    }
    output
}

fn tmdb_logo_candidates(details: &JsonValue) -> Vec<String> {
    let logos = details
        .get("images")
        .and_then(|value| value.get("logos"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sorted = logos;
    sorted.sort_by_key(|logo| {
        let language = logo.get("iso_639_1").and_then(Value::as_str).unwrap_or("");
        match language {
            "en" => 0,
            "" => 1,
            _ => 2,
        }
    });
    unique_strings(
        sorted
            .iter()
            .filter_map(|logo| logo.get("file_path").and_then(Value::as_str))
            .map(|path| tmdb_image("w500", Some(path)))
            .collect(),
    )
}

fn fanart_logos(tmdb_kind: &str, provider_ids: &JsonValue, api_key: Option<String>) -> Vec<String> {
    let Some(api_key) = api_key else {
        return Vec::new();
    };
    let Some(provider_id) = (if tmdb_kind == "movie" {
        provider_ids.get("tmdbId").and_then(Value::as_str)
    } else {
        provider_ids.get("tvdbId").and_then(Value::as_str)
    }) else {
        return Vec::new();
    };
    if provider_id.trim().is_empty() {
        return Vec::new();
    }
    let path = if tmdb_kind == "movie" {
        format!("movies/{}", percent_escape(provider_id))
    } else {
        format!("tv/{}", percent_escape(provider_id))
    };
    let url = format!(
        "https://webservice.fanart.tv/v3/{path}?api_key={}",
        percent_escape(&api_key)
    );
    let Some(data) = http_json(&url, &[]) else {
        return Vec::new();
    };
    let keys = if tmdb_kind == "movie" {
        [
            "hdmovielogo",
            "movielogo",
            "movieclearart",
            "hdmovieclearart",
        ]
    } else {
        ["hdtvlogo", "tvlogo", "clearart", "hdclearart"]
    };
    let mut urls = Vec::new();
    for key in keys {
        if let Some(entries) = data.get(key).and_then(Value::as_array) {
            urls.extend(
                entries
                    .iter()
                    .filter_map(|entry| entry.get("url").and_then(Value::as_str))
                    .map(str::to_owned),
            );
        }
    }
    unique_strings(urls)
}

fn tmdb_search(kind: &str, title: &str, year: u64, credential: Option<&String>) -> Vec<JsonValue> {
    let Some(credential) = credential else {
        return Vec::new();
    };
    if title.trim().is_empty() {
        return Vec::new();
    }
    let year_param = if year > 0 {
        if kind == "movie" {
            format!("&year={year}")
        } else {
            format!("&first_air_date_year={year}")
        }
    } else {
        String::new()
    };
    let mut paths = vec![format!(
        "search/{kind}?query={}{}",
        percent_escape(title),
        year_param
    )];
    if year > 0 {
        paths.push(format!("search/{kind}?query={}", percent_escape(title)));
    }

    let mut results = Vec::new();
    for path in paths {
        if let Some(data) = tmdb_json(&path, credential) {
            if let Some(items) = data.get("results").and_then(Value::as_array) {
                for item in items.iter().take(6) {
                    if let Some(id) = item.get("id").and_then(Value::as_u64) {
                        if !results.iter().any(|existing: &JsonValue| {
                            existing.get("id").and_then(Value::as_u64) == Some(id)
                        }) {
                            results.push(item.clone());
                        }
                    }
                }
            }
        }
    }
    results
}

fn tmdb_details(kind: &str, id: u64, credential: &str) -> Option<JsonValue> {
    tmdb_json(
        &format!("{kind}/{id}?append_to_response=credits,images,external_ids&include_image_language=en,null"),
        credential,
    )
}

fn tmdb_best_metadata(
    kind: &str,
    title: &str,
    year: u64,
    credentials: &[String],
    fanart_key: Option<String>,
) -> Option<JsonValue> {
    for credential in credentials {
        let match_details = tmdb_search(kind, title, year, Some(credential))
            .into_iter()
            .find_map(|hit| {
                let id = hit.get("id").and_then(Value::as_u64)?;
                tmdb_details(kind, id, credential)
            });
        if let Some(details) = match_details {
            return Some(metadata_from_tmdb_details(
                &details,
                title,
                kind,
                fanart_key.clone(),
                Some(credential),
            ));
        }
    }
    None
}

fn tmdb_tv_episodes(details: &JsonValue, credential: Option<&str>) -> Vec<JsonValue> {
    let Some(credential) = credential else {
        return Vec::new();
    };
    let Some(tmdb_id) = details.get("id").and_then(Value::as_u64) else {
        return Vec::new();
    };
    details
        .get("seasons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|season| season.get("season_number").and_then(Value::as_u64))
        .filter(|season| *season > 0)
        .take(15)
        .filter_map(|season| tmdb_json(&format!("tv/{tmdb_id}/season/{season}"), credential))
        .flat_map(|season_data| {
            season_data
                .get("episodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|episode| {
            let season = episode.get("season_number").and_then(Value::as_u64)?;
            let number = episode.get("episode_number").and_then(Value::as_u64)?;
            if season == 0 || number == 0 {
                return None;
            }
            Some(json!({
                "season": season,
                "number": number,
                "title": episode.get("name").and_then(Value::as_str).unwrap_or(""),
                "summary": episode.get("overview").and_then(Value::as_str).unwrap_or(""),
                "still": tmdb_image("w300", episode.get("still_path").and_then(Value::as_str)),
                "rating": json_rating(&episode, "vote_average"),
                "airDate": episode.get("air_date").and_then(Value::as_str).unwrap_or(""),
            }))
        })
        .collect()
}

fn metadata_from_tmdb_details(
    details: &JsonValue,
    fallback_title: &str,
    kind: &str,
    fanart_key: Option<String>,
    tmdb_credential: Option<&str>,
) -> JsonValue {
    let title = if kind == "movie" {
        json_string(details, "title")
    } else {
        json_string(details, "name")
    };
    let date = if kind == "movie" {
        json_string(details, "release_date")
    } else {
        json_string(details, "first_air_date")
    };
    let poster = tmdb_image("w500", details.get("poster_path").and_then(Value::as_str));
    let backdrop = tmdb_image(
        "w1280",
        details.get("backdrop_path").and_then(Value::as_str),
    );
    let mut provider_ids = json!({
        "tmdbId": details.get("id").and_then(Value::as_u64).map(|id| id.to_string()).unwrap_or_default(),
    });
    if let Some(imdb_id) = details
        .get("imdb_id")
        .or_else(|| {
            details
                .get("external_ids")
                .and_then(|value| value.get("imdb_id"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        provider_ids["imdbId"] = json!(imdb_id);
    }
    if let Some(tvdb_id) = details
        .get("external_ids")
        .and_then(|value| value.get("tvdb_id"))
        .and_then(Value::as_i64)
    {
        provider_ids["tvdbId"] = json!(tvdb_id.to_string());
    }
    let mut logo_candidates = tmdb_logo_candidates(details);
    logo_candidates.extend(fanart_logos(kind, &provider_ids, fanart_key));
    logo_candidates = unique_strings(logo_candidates);
    let genres = details
        .get("genres")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|genre| genre.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>();
    let cast = details
        .get("credits")
        .and_then(|value| value.get("cast"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(8)
        .map(|person| {
            json!({
                "name": person.get("name").and_then(Value::as_str).unwrap_or(""),
                "character": person.get("character").and_then(Value::as_str).unwrap_or(""),
                "image": tmdb_image("w185", person.get("profile_path").and_then(Value::as_str)),
            })
        })
        .collect::<Vec<_>>();
    let seasons = details
        .get("seasons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|season| {
            season
                .get("season_number")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
        })
        .map(|season| {
            json!({
                "number": season.get("season_number").and_then(Value::as_u64).unwrap_or(1),
                "title": season.get("name").and_then(Value::as_str).unwrap_or("Season"),
                "episodeCount": season.get("episode_count").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect::<Vec<_>>();
    let episodes = if kind == "tv" {
        tmdb_tv_episodes(details, tmdb_credential)
    } else {
        Vec::new()
    };

    let mut metadata = json!({
        "id": format!("tmdb-{}-{}", kind, details.get("id").and_then(Value::as_u64).unwrap_or(0)),
        "source": "TMDB",
        "title": if title.is_empty() { fallback_title } else { &title },
        "year": year_from_date(&date),
        "thumbnail": poster,
        "cover": backdrop,
        "summary": details.get("overview").and_then(Value::as_str).unwrap_or(""),
        "rating": json_rating(details, "vote_average"),
        "posterCandidates": unique_strings(vec![poster.clone()]),
        "backdropCandidates": unique_strings(vec![backdrop.clone()]),
        "logo": logo_candidates.first().cloned().unwrap_or_default(),
        "logoCandidates": logo_candidates,
        "genres": genres,
        "cast": cast,
        "providerIds": provider_ids,
        "seasons": seasons,
    });
    if !episodes.is_empty() {
        metadata["episodes"] = json!(episodes);
    }
    metadata
}

fn omdb_metadata(title: &str, year: u64, api_key: Option<&String>) -> Option<JsonValue> {
    let api_key = api_key?;
    if title.trim().is_empty() {
        return None;
    }
    let mut url = format!(
        "https://www.omdbapi.com/?t={}&apikey={}",
        percent_escape(title),
        percent_escape(api_key)
    );
    if year > 0 {
        url.push_str("&y=");
        url.push_str(&year.to_string());
    }
    let data = http_json(&url, &[])?;
    if data.get("Response").and_then(Value::as_str) == Some("False") {
        return None;
    }
    Some(data)
}

fn metadata_from_omdb(data: &JsonValue, fallback_title: &str) -> JsonValue {
    let poster = data
        .get("Poster")
        .and_then(Value::as_str)
        .filter(|value| *value != "N/A")
        .unwrap_or("")
        .to_string();
    let rating = data
        .get("imdbRating")
        .and_then(Value::as_str)
        .filter(|value| *value != "N/A")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let genres = data
        .get("Genre")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "N/A")
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let title = data
        .get("Title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != "N/A")
        .unwrap_or(fallback_title);
    let year = data
        .get("Year")
        .and_then(Value::as_str)
        .map(year_from_text)
        .unwrap_or(0);
    json!({
        "id": format!("omdb-{}", data.get("imdbID").and_then(Value::as_str).unwrap_or(title)),
        "source": "OMDb",
        "title": title,
        "year": year,
        "thumbnail": poster,
        "cover": "",
        "summary": data.get("Plot").and_then(Value::as_str).filter(|value| *value != "N/A").unwrap_or(""),
        "rating": rating,
        "posterCandidates": unique_strings(vec![poster.clone()]),
        "backdropCandidates": [],
        "logo": "",
        "logoCandidates": [],
        "genres": genres,
        "providerIds": {
            "imdbId": data.get("imdbID").and_then(Value::as_str).unwrap_or(""),
        },
    })
}

fn strip_html(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
}

fn normalized_match_title(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn titles_match(local: &str, remote: &str) -> bool {
    let local = normalized_match_title(local);
    let remote = normalized_match_title(remote);
    !local.is_empty()
        && !remote.is_empty()
        && (local == remote || local.contains(&remote) || remote.contains(&local))
}

fn tvmaze_episode_to_meta(episode: &JsonValue) -> JsonValue {
    json!({
        "season": episode.get("season").and_then(Value::as_u64).unwrap_or(1),
        "number": episode.get("number").and_then(Value::as_u64).unwrap_or(1),
        "title": episode.get("name").and_then(Value::as_str).unwrap_or(""),
        "summary": episode.get("summary").and_then(Value::as_str).map(strip_html).unwrap_or_default(),
        "still": episode.get("image").and_then(|value| value.get("medium").or_else(|| value.get("original"))).and_then(Value::as_str).unwrap_or(""),
        "rating": episode.get("rating").and_then(|value| value.get("average")).and_then(Value::as_f64).unwrap_or(0.0),
        "airDate": episode.get("airdate").and_then(Value::as_str).unwrap_or(""),
    })
}

fn tvmaze_episodes(show_id: u64) -> Vec<JsonValue> {
    let url = format!("https://api.tvmaze.com/shows/{show_id}/episodes");
    http_json(&url, &[])
        .and_then(|data| data.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(tvmaze_episode_to_meta)
        .filter(|episode| {
            episode.get("season").and_then(Value::as_u64).unwrap_or(0) > 0
                && episode.get("number").and_then(Value::as_u64).unwrap_or(0) > 0
        })
        .collect()
}

fn metadata_from_tvmaze_show(show: &JsonValue, fallback_title: &str, year: u64) -> JsonValue {
    let show_id = show.get("id").and_then(Value::as_u64).unwrap_or(0);
    let seasons = show
        .get("_embedded")
        .and_then(|value| value.get("seasons"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|season| season.get("number").and_then(Value::as_u64).unwrap_or(0) > 0)
        .map(|season| {
            json!({
                "number": season.get("number").and_then(Value::as_u64).unwrap_or(1),
                "title": season.get("name").and_then(Value::as_str).unwrap_or("Season"),
                "episodeCount": season.get("episodeOrder").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect::<Vec<_>>();
    let cast = show
        .get("_embedded")
        .and_then(|value| value.get("cast"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(6)
        .map(|entry| {
            let person = entry.get("person").unwrap_or(&JsonValue::Null);
            let character = entry.get("character").unwrap_or(&JsonValue::Null);
            json!({
                "name": person.get("name").and_then(Value::as_str).unwrap_or(""),
                "character": character.get("name").and_then(Value::as_str).unwrap_or(""),
                "image": person.get("image").and_then(|value| value.get("medium")).and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "id": format!("tvmaze-{show_id}"),
        "source": "TVmaze",
        "title": show.get("name").and_then(Value::as_str).unwrap_or(fallback_title),
        "year": show.get("premiered").and_then(Value::as_str).map(year_from_date).filter(|value| *value > 0).unwrap_or(year),
        "thumbnail": show.get("image").and_then(|value| value.get("original").or_else(|| value.get("medium"))).and_then(Value::as_str).unwrap_or(""),
        "cover": "",
        "summary": show.get("summary").and_then(Value::as_str).map(strip_html).unwrap_or_default(),
        "rating": show.get("rating").and_then(|value| value.get("average")).and_then(Value::as_f64).unwrap_or(0.0),
        "posterCandidates": unique_strings(vec![show.get("image").and_then(|value| value.get("original").or_else(|| value.get("medium"))).and_then(Value::as_str).unwrap_or("").to_string()]),
        "backdropCandidates": [],
        "logo": "",
        "logoCandidates": [],
        "genres": show.get("genres").and_then(Value::as_array).cloned().unwrap_or_default(),
        "cast": cast,
        "providerIds": {
            "imdbId": show.get("externals").and_then(|value| value.get("imdb")).and_then(Value::as_str).unwrap_or(""),
            "tvdbId": show.get("externals").and_then(|value| value.get("thetvdb")).and_then(Value::as_u64).map(|id| id.to_string()).unwrap_or_default(),
        },
        "seasons": seasons,
        "episodes": tvmaze_episodes(show_id),
    })
}

fn tvmaze_metadata(title: &str, year: u64) -> Option<JsonValue> {
    if title.trim().is_empty() {
        return None;
    }
    let url = format!(
        "https://api.tvmaze.com/search/shows?q={}",
        percent_escape(title)
    );
    let results = http_json(&url, &[])?.as_array()?.clone();
    let show = results
        .iter()
        .filter_map(|result| result.get("show"))
        .find(|show| {
            let remote_title = show.get("name").and_then(Value::as_str).unwrap_or("");
            let remote_year = show
                .get("premiered")
                .and_then(Value::as_str)
                .map(year_from_date)
                .unwrap_or(0);
            titles_match(title, remote_title)
                && (year == 0 || remote_year == 0 || year == remote_year)
        })
        .or_else(|| results.first().and_then(|result| result.get("show")))?;
    let show_id = show.get("id").and_then(Value::as_u64)?;
    let details = http_json(
        &format!("https://api.tvmaze.com/shows/{show_id}?embed[]=seasons&embed[]=cast"),
        &[],
    )
    .unwrap_or_else(|| show.clone());
    Some(metadata_from_tvmaze_show(&details, title, year))
}

fn is_generic_episode_title(value: &str, number: u64) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.is_empty()
        || normalized == format!("episode {number}")
        || normalized == format!("ep {number}")
        || normalized == format!("episode {:02}", number)
        || normalized == format!("ep {:02}", number)
}

fn jikan_episode_title(episode: &JsonValue) -> String {
    let number = episode.get("mal_id").and_then(Value::as_u64).unwrap_or(0);
    for key in ["title", "title_romanji", "title_japanese"] {
        if let Some(value) = episode.get(key).and_then(Value::as_str) {
            if !is_generic_episode_title(value, number) {
                return value.trim().to_string();
            }
        }
    }
    format!("Episode {number}")
}

fn jikan_episodes(mal_id: u64, max_pages: u64) -> Vec<JsonValue> {
    let mut episodes = Vec::new();
    for page in 1..=max_pages {
        if page > 1 {
            thread::sleep(Duration::from_millis(350));
        }
        let Some(data) = http_json(
            &format!("https://api.jikan.moe/v4/anime/{mal_id}/episodes?page={page}"),
            &[],
        ) else {
            break;
        };
        let page_episodes = data
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        episodes.extend(page_episodes.iter().filter_map(|episode| {
            let number = episode.get("mal_id").and_then(Value::as_u64)?;
            Some(json!({
                "season": 1,
                "number": number,
                "title": jikan_episode_title(episode),
                "summary": "",
                "still": "",
                "rating": episode.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                "airDate": episode.get("aired").and_then(Value::as_str).unwrap_or("").split('T').next().unwrap_or(""),
            }))
        }));
        if data
            .get("pagination")
            .and_then(|value| value.get("has_next_page"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            break;
        }
    }
    episodes
}

fn jikan_titles(hit: &JsonValue) -> Vec<String> {
    let mut titles = Vec::new();
    for key in ["title", "title_english", "title_japanese"] {
        if let Some(value) = hit.get(key).and_then(Value::as_str) {
            titles.push(value.to_string());
        }
    }
    if let Some(values) = hit.get("title_synonyms").and_then(Value::as_array) {
        titles.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
    }
    unique_strings(titles)
}

fn metadata_from_jikan_hit(
    hit: &JsonValue,
    fallback_title: &str,
    include_episode_pages: u64,
) -> JsonValue {
    let mal_id = hit.get("mal_id").and_then(Value::as_u64).unwrap_or(0);
    let image = hit
        .get("images")
        .and_then(|value| value.get("jpg"))
        .and_then(|value| {
            value
                .get("large_image_url")
                .or_else(|| value.get("image_url"))
        })
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let genres = hit
        .get("genres")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|genre| {
            genre
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    json!({
        "id": format!("jikan-{mal_id}"),
        "source": "Jikan",
        "title": hit.get("title_english").or_else(|| hit.get("title")).and_then(Value::as_str).unwrap_or(fallback_title),
        "aliases": jikan_titles(hit),
        "year": hit.get("year").and_then(Value::as_u64).or_else(|| hit.get("aired").and_then(|value| value.get("from")).and_then(Value::as_str).map(year_from_date)).unwrap_or(0),
        "thumbnail": image,
        "cover": "",
        "summary": hit.get("synopsis").and_then(Value::as_str).unwrap_or(""),
        "rating": hit.get("score").and_then(Value::as_f64).unwrap_or(0.0),
        "posterCandidates": unique_strings(vec![image.clone()]),
        "backdropCandidates": [],
        "logo": "",
        "logoCandidates": [],
        "genres": genres,
        "cast": [],
        "providerIds": { "malId": mal_id.to_string() },
        "episodes": if mal_id > 0 { jikan_episodes(mal_id, include_episode_pages) } else { Vec::new() },
    })
}

fn jikan_metadata(title: &str) -> Option<JsonValue> {
    if title.trim().is_empty() {
        return None;
    }
    let data = http_json(
        &format!(
            "https://api.jikan.moe/v4/anime?q={}&limit=5&sfw",
            percent_escape(title)
        ),
        &[],
    )?;
    let hit = data
        .get("data")
        .and_then(Value::as_array)?
        .iter()
        .find(|hit| {
            jikan_titles(hit)
                .iter()
                .any(|remote| titles_match(title, remote))
        })
        .or_else(|| {
            data.get("data")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
        })?;
    Some(metadata_from_jikan_hit(hit, title, 3))
}

fn jikan_metadata_candidates(title: &str) -> Vec<JsonValue> {
    let Some(data) = http_json(
        &format!(
            "https://api.jikan.moe/v4/anime?q={}&limit=8&sfw",
            percent_escape(title)
        ),
        &[],
    ) else {
        return Vec::new();
    };
    data.get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|hit| {
            jikan_titles(hit)
                .iter()
                .any(|remote| titles_match(title, remote))
        })
        .map(|hit| metadata_from_jikan_hit(hit, title, 1))
        .collect()
}

fn episode_key_from_value(episode: &JsonValue) -> Option<String> {
    let season = episode.get("season").and_then(Value::as_u64).unwrap_or(1);
    let number = episode.get("number").and_then(Value::as_u64)?;
    Some(episode_key(season, number))
}

fn local_episode_metadata_for_item(item: &JsonValue) -> Vec<JsonValue> {
    item.get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn merge_episode_metadata_sources(
    local_episodes: &[JsonValue],
    remote_sources: &[Vec<JsonValue>],
) -> Vec<JsonValue> {
    if local_episodes.is_empty() {
        return remote_sources
            .iter()
            .find(|source| !source.is_empty())
            .cloned()
            .unwrap_or_default();
    }
    let remote_maps = remote_sources
        .iter()
        .filter(|source| !source.is_empty())
        .map(|source| {
            source
                .iter()
                .filter_map(|episode| {
                    episode_key_from_value(episode).map(|key| (key, episode.clone()))
                })
                .collect::<HashMap<_, _>>()
        })
        .collect::<Vec<_>>();
    if remote_maps.is_empty() {
        return local_episodes.to_vec();
    }
    local_episodes
        .iter()
        .map(|local| {
            let Some(key) = episode_key_from_value(local) else {
                return local.clone();
            };
            let remotes = remote_maps
                .iter()
                .filter_map(|source| source.get(&key))
                .collect::<Vec<_>>();
            if remotes.is_empty() {
                return local.clone();
            }
            json!({
                "season": local.get("season").cloned().unwrap_or_else(|| json!(1)),
                "number": local.get("number").cloned().unwrap_or_else(|| json!(1)),
                "title": remotes.iter().find_map(|episode| episode.get("title").and_then(Value::as_str).filter(|value| !value.trim().is_empty()))
                    .or_else(|| local.get("title").and_then(Value::as_str))
                    .unwrap_or(""),
                "summary": local.get("summary").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
                    .or_else(|| remotes.iter().find_map(|episode| episode.get("summary").and_then(Value::as_str).filter(|value| !value.trim().is_empty())))
                    .unwrap_or(""),
                "still": remotes.iter().find_map(|episode| episode.get("still").and_then(Value::as_str).filter(|value| !value.trim().is_empty()))
                    .or_else(|| local.get("still").and_then(Value::as_str))
                    .unwrap_or(""),
                "rating": local.get("rating").and_then(Value::as_f64).filter(|value| *value > 0.0)
                    .or_else(|| remotes.iter().find_map(|episode| episode.get("rating").and_then(Value::as_f64).filter(|value| *value > 0.0)))
                    .unwrap_or(0.0),
                "airDate": local.get("airDate").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
                    .or_else(|| remotes.iter().find_map(|episode| episode.get("airDate").and_then(Value::as_str).filter(|value| !value.trim().is_empty())))
                    .unwrap_or(""),
                "localMetadata": local.get("localMetadata").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect()
}

fn fetch_best_metadata_for_item(item: &JsonValue, settings: &JsonValue) -> Option<JsonValue> {
    let title = item_lookup_title(item);
    let year = item_lookup_year(item);
    let kind = item_tmdb_kind(item);
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("movie");
    let tmdb_keys = metadata_key_candidates(settings, "tmdb");
    let omdb_key = metadata_key(settings, "omdb");
    let fanart_key = metadata_key(settings, "fanart");
    let tmdb_match = tmdb_best_metadata(kind, &title, year, &tmdb_keys, fanart_key);
    let tvmaze_match = if kind == "tv" {
        tvmaze_metadata(&title, year)
    } else {
        None
    };
    let jikan_match = if item_type == "anime" {
        jikan_metadata(&title)
    } else {
        None
    };
    let omdb_match = omdb_metadata(&title, year, omdb_key.as_ref())
        .map(|data| metadata_from_omdb(&data, &title));

    let mut ordered = if item_type == "anime" {
        vec![
            jikan_match.clone(),
            tmdb_match.clone(),
            tvmaze_match.clone(),
            omdb_match.clone(),
        ]
    } else if kind == "tv" {
        vec![tmdb_match.clone(), tvmaze_match.clone(), omdb_match.clone()]
    } else {
        vec![tmdb_match.clone(), omdb_match.clone()]
    };
    let mut base = ordered.iter_mut().find_map(Option::take)?;

    for fallback in ordered.into_iter().flatten() {
        for key in ["summary", "thumbnail", "cover", "logo"] {
            let empty = base
                .get(key)
                .and_then(Value::as_str)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true);
            if empty {
                if let Some(value) = fallback
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                {
                    base[key] = json!(value);
                }
            }
        }
        for key in ["rating", "year"] {
            let empty = base.get(key).and_then(Value::as_f64).unwrap_or(0.0) <= 0.0
                && base.get(key).and_then(Value::as_u64).unwrap_or(0) == 0;
            if empty {
                if let Some(value) = fallback.get(key) {
                    base[key] = value.clone();
                }
            }
        }
        for key in [
            "genres",
            "cast",
            "posterCandidates",
            "backdropCandidates",
            "logoCandidates",
            "seasons",
        ] {
            let empty = base
                .get(key)
                .and_then(Value::as_array)
                .map(|values| values.is_empty())
                .unwrap_or(true);
            if empty {
                if let Some(values) = fallback.get(key).and_then(Value::as_array) {
                    if !values.is_empty() {
                        base[key] = json!(values);
                    }
                }
            }
        }
    }

    if kind == "tv" {
        let local = local_episode_metadata_for_item(item);
        let remote_sources = vec![
            tvmaze_match
                .as_ref()
                .and_then(|value| value.get("episodes").and_then(Value::as_array).cloned())
                .unwrap_or_default(),
            jikan_match
                .as_ref()
                .and_then(|value| value.get("episodes").and_then(Value::as_array).cloned())
                .unwrap_or_default(),
            tmdb_match
                .as_ref()
                .and_then(|value| value.get("episodes").and_then(Value::as_array).cloned())
                .unwrap_or_default(),
        ];
        let episodes = merge_episode_metadata_sources(&local, &remote_sources);
        if !episodes.is_empty() {
            base["episodes"] = json!(episodes);
        }
    }

    Some(base)
}

fn episode_key(season: u64, number: u64) -> String {
    format!("{season}-{number}")
}

fn merge_episode_metadata_for_item(
    item: &mut JsonValue,
    remote_episodes: &[JsonValue],
    source: &str,
) {
    if item.get("type").and_then(Value::as_str) == Some("movie") || remote_episodes.is_empty() {
        return;
    }
    let use_episode_number_only = source == "Jikan";
    let mut remote_by_key = HashMap::<String, JsonValue>::new();
    for episode in remote_episodes {
        let season = episode.get("season").and_then(Value::as_u64).unwrap_or(1);
        let number = episode.get("number").and_then(Value::as_u64).unwrap_or(0);
        if number == 0 {
            continue;
        }
        let key = if use_episode_number_only {
            number.to_string()
        } else {
            episode_key(season, number)
        };
        remote_by_key.entry(key).or_insert_with(|| episode.clone());
    }
    if remote_by_key.is_empty() {
        return;
    }

    let mut existing_by_key = HashMap::<String, JsonValue>::new();
    for episode in item
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let season = episode.get("season").and_then(Value::as_u64).unwrap_or(1);
        let number = episode.get("number").and_then(Value::as_u64).unwrap_or(0);
        if number > 0 {
            existing_by_key.insert(episode_key(season, number), episode);
        }
    }

    let episode_files = item
        .get("episodeFiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if episode_files.is_empty() {
        item["episodes"] = json!(remote_episodes);
        return;
    }

    let merged = episode_files
        .iter()
        .filter_map(|file| {
            let season = file.get("season").and_then(Value::as_u64).unwrap_or(1);
            let number = file.get("episode").and_then(Value::as_u64).unwrap_or(0);
            if number == 0 {
                return None;
            }
            let key = episode_key(season, number);
            let remote_key = if use_episode_number_only {
                number.to_string()
            } else {
                key.clone()
            };
            let remote = remote_by_key.get(&remote_key);
            let existing = existing_by_key.get(&key);
            Some(json!({
                "season": season,
                "number": number,
                "title": remote.and_then(|value| value.get("title")).and_then(Value::as_str)
                    .or_else(|| existing.and_then(|value| value.get("title")).and_then(Value::as_str))
                    .or_else(|| file.get("title").and_then(Value::as_str))
                    .unwrap_or(""),
                "summary": remote.and_then(|value| value.get("summary")).and_then(Value::as_str)
                    .or_else(|| existing.and_then(|value| value.get("summary")).and_then(Value::as_str))
                    .unwrap_or(""),
                "still": remote.and_then(|value| value.get("still")).and_then(Value::as_str)
                    .or_else(|| existing.and_then(|value| value.get("still")).and_then(Value::as_str))
                    .unwrap_or(""),
                "rating": remote.and_then(|value| value.get("rating")).and_then(Value::as_f64)
                    .or_else(|| existing.and_then(|value| value.get("rating")).and_then(Value::as_f64))
                    .unwrap_or(0.0),
                "airDate": remote.and_then(|value| value.get("airDate")).and_then(Value::as_str)
                    .or_else(|| existing.and_then(|value| value.get("airDate")).and_then(Value::as_str))
                    .unwrap_or(""),
                "localMetadata": file.get("localMetadata")
                    .or_else(|| existing.and_then(|value| value.get("localMetadata")))
                    .cloned(),
            }))
        })
        .collect::<Vec<_>>();
    if !merged.is_empty() {
        item["episodes"] = json!(merged);
    }
}

fn merge_metadata_into_item(item: &mut JsonValue, metadata: &JsonValue) {
    for key in [
        "title",
        "year",
        "summary",
        "rating",
        "genres",
        "cast",
        "providerIds",
    ] {
        if let Some(value) = metadata.get(key) {
            let useful = match value {
                Value::String(value) => !value.trim().is_empty(),
                Value::Number(value) => value.as_f64().unwrap_or(0.0) > 0.0,
                Value::Array(value) => !value.is_empty(),
                Value::Object(value) => !value.is_empty(),
                _ => false,
            };
            if useful {
                item[key] = value.clone();
            }
        }
    }
    if let Some(thumbnail) = metadata
        .get("thumbnail")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        item["poster"] = json!(thumbnail);
    }
    if let Some(cover) = metadata
        .get("cover")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        item["backdrop"] = json!(cover);
    }
    if let Some(logo) = metadata
        .get("logo")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        item["logo"] = json!(logo);
    }
    for (source, target) in [
        ("posterCandidates", "posterCandidates"),
        ("backdropCandidates", "backdropCandidates"),
        ("logoCandidates", "logoCandidates"),
        ("seasons", "seasons"),
    ] {
        if let Some(values) = metadata.get(source).and_then(Value::as_array) {
            if !values.is_empty() {
                item[target] = json!(values);
            }
        }
    }
    if let Some(episodes) = metadata.get("episodes").and_then(Value::as_array) {
        let source = metadata
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("refresh");
        merge_episode_metadata_for_item(item, episodes, source);
    }
}

fn enhance_scanned_items(items: &mut [JsonValue], settings: &JsonValue) {
    for item in items {
        if item
            .get("__skipMetadataRefresh")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(object) = item.as_object_mut() {
                object.remove("__skipMetadataRefresh");
            }
            continue;
        }
        if let Some(metadata) = fetch_best_metadata_for_item(item, settings) {
            merge_metadata_into_item(item, &metadata);
        }
    }
}

fn find_library_item(library: &JsonValue, media_id: &str) -> Option<JsonValue> {
    for key in ["movies", "tvShows", "animeShows"] {
        if let Some(items) = library.get(key).and_then(Value::as_array) {
            if let Some(item) = items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(media_id))
            {
                return Some(item.clone());
            }
        }
    }
    None
}

fn update_library_item(library: &mut JsonValue, media_id: &str, metadata: &JsonValue) -> bool {
    for key in ["movies", "tvShows", "animeShows"] {
        if let Some(items) = library.get_mut(key).and_then(Value::as_array_mut) {
            if let Some(item) = items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(media_id))
            {
                merge_metadata_into_item(item, metadata);
                return true;
            }
        }
    }
    false
}

fn apply_refreshed_metadata_to_library(
    library: &mut JsonValue,
    media_id: &str,
    metadata: Option<JsonValue>,
    fallback: JsonValue,
) -> JsonValue {
    let Some(metadata) = metadata else {
        return fallback;
    };
    let _ = update_library_item(library, media_id, &metadata);
    metadata
}

fn official_metadata_candidates_for_item(item: &JsonValue, settings: &JsonValue) -> Vec<JsonValue> {
    let title = item_lookup_title(item);
    let year = item_lookup_year(item);
    let kind = item_tmdb_kind(item);
    let tmdb_keys = metadata_key_candidates(settings, "tmdb");
    let omdb_key = metadata_key(settings, "omdb");
    let fanart_key = metadata_key(settings, "fanart");
    let mut candidates = Vec::new();
    for tmdb_key in &tmdb_keys {
        candidates = tmdb_search(kind, &title, year, Some(tmdb_key))
            .into_iter()
            .filter_map(|hit| {
                let id = hit.get("id").and_then(Value::as_u64)?;
                let details = tmdb_details(kind, id, tmdb_key)?;
                Some(metadata_from_tmdb_details(
                    &details,
                    &title,
                    kind,
                    fanart_key.clone(),
                    Some(tmdb_key),
                ))
            })
            .collect::<Vec<_>>();
        if !candidates.is_empty() {
            break;
        }
    }
    if kind == "tv" {
        if item.get("type").and_then(Value::as_str) == Some("anime") {
            candidates.extend(jikan_metadata_candidates(&title));
        }
        if let Some(tvmaze) = tvmaze_metadata(&title, year) {
            candidates.push(tvmaze);
        }
    }
    if let Some(omdb) = omdb_metadata(&title, year, omdb_key.as_ref()) {
        candidates.push(metadata_from_omdb(&omdb, &title));
    }
    candidates
}

fn signature_file(path: &Path) -> bool {
    is_video_file(path) || is_subtitle_file(path) || is_image_file(path)
}

fn library_folder_signature(folder: &Path) -> Option<(String, u64)> {
    if !folder.exists() {
        return None;
    }
    fn visit(root: &Path, dir: &Path, entries: &mut Vec<String>) {
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };
        let mut paths = read_dir
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                visit(root, &path, entries);
            } else if path.is_file() && signature_file(&path) {
                if let Ok(metadata) = fs::metadata(&path) {
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis())
                        .unwrap_or(0);
                    entries.push(format!(
                        "{}\0{}\0{}",
                        path.strip_prefix(root).unwrap_or(&path).to_string_lossy(),
                        metadata.len(),
                        modified
                    ));
                }
            }
        }
    }
    let mut entries = Vec::new();
    visit(folder, folder, &mut entries);
    let file_count = entries.len() as u64;
    Some((
        format!("{file_count}:{}", stable_id(&entries.join("\n"))),
        file_count,
    ))
}

fn path_starts_with(path: &str, folder: &str) -> bool {
    Path::new(path).starts_with(Path::new(folder))
}

fn item_belongs_to_folder(item: &JsonValue, folder: &str) -> bool {
    item.get("filePath")
        .and_then(Value::as_str)
        .map(|path| path_starts_with(path, folder))
        .unwrap_or(false)
        || item
            .get("episodeFiles")
            .and_then(Value::as_array)
            .map(|files| {
                files.iter().any(|file| {
                    file.get("filePath")
                        .and_then(Value::as_str)
                        .map(|path| path_starts_with(path, folder))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
}

fn item_complete_for_cache(item: &JsonValue) -> bool {
    let has_identity = item
        .get("id")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
        && item
            .get("title")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
    if !has_identity {
        return false;
    }
    match item.get("type").and_then(Value::as_str) {
        Some("tv") | Some("anime") => item
            .get("episodeFiles")
            .and_then(Value::as_array)
            .map(|files| !files.is_empty())
            .unwrap_or(false),
        _ => item
            .get("filePath")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false),
    }
}

fn cached_items_for_folder(library: &JsonValue, folder: &str, folder_kind: &str) -> Vec<JsonValue> {
    let buckets: &[&str] = match folder_kind {
        "movies" => &["movies"],
        "tv" => &["tvShows"],
        "anime" => &["animeShows"],
        _ => &["movies", "tvShows", "animeShows"],
    };
    buckets
        .iter()
        .flat_map(|bucket| {
            library
                .get(*bucket)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter(|item| item_belongs_to_folder(item, folder))
        .collect()
}

fn merge_cached_episode_files(fresh: &mut JsonValue, cached: &JsonValue) {
    let cached_files = cached
        .get("episodeFiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if cached_files.is_empty() {
        return;
    }
    let cached_by_path = cached_files
        .into_iter()
        .filter_map(|file| {
            file.get("filePath")
                .and_then(Value::as_str)
                .map(|path| (path.to_string(), file.clone()))
        })
        .collect::<HashMap<_, _>>();
    let Some(files) = fresh.get_mut("episodeFiles").and_then(Value::as_array_mut) else {
        return;
    };
    for file in files {
        let Some(path) = file.get("filePath").and_then(Value::as_str) else {
            continue;
        };
        let Some(cached_file) = cached_by_path.get(path) else {
            continue;
        };
        if let Some(title) = cached_file.get("title").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            file["title"] = json!(title);
        }
    }
}

fn merge_cached_metadata(mut fresh: JsonValue, cached: Option<&JsonValue>) -> JsonValue {
    let Some(cached) = cached else {
        return fresh;
    };
    for key in [
        "type",
        "title",
        "year",
        "poster",
        "backdrop",
        "logo",
        "posterCandidates",
        "backdropCandidates",
        "logoCandidates",
        "summary",
        "rating",
        "genres",
        "cast",
        "providerIds",
        "seasons",
        "episodes",
    ] {
        if let Some(value) = cached.get(key) {
            let useful = match value {
                Value::String(value) => !value.trim().is_empty(),
                Value::Number(value) => value.as_f64().unwrap_or(0.0) > 0.0,
                Value::Array(value) => !value.is_empty(),
                Value::Object(value) => !value.is_empty(),
                _ => false,
            };
            if useful {
                fresh[key] = value.clone();
            }
        }
    }
    merge_cached_episode_files(&mut fresh, cached);
    fresh["__skipMetadataRefresh"] = json!(true);
    fresh
}

fn scan_items_for_folder(folder_path: &Path, folder_kind: &str) -> Vec<JsonValue> {
    scan_directory_as_item(folder_path, folder_kind)
        .map(|item| vec![item])
        .unwrap_or_else(|| scan_folder(folder_path, folder_kind))
}

fn cached_or_scanned_items(
    library: &JsonValue,
    folder: &str,
    folder_kind: &str,
    mode: &str,
    force: bool,
) -> (Vec<JsonValue>, Option<JsonValue>) {
    let folder_path = Path::new(folder);
    let signature = library_folder_signature(folder_path);
    if !force {
        if let Some((signature_value, file_count)) = signature.as_ref() {
            if let Some(entry) = library
                .get("scanCache")
                .and_then(|cache| cache.get(folder))
                .and_then(Value::as_object)
            {
                let cache_fresh = mode != "metadata";
                let matches = entry.get("version").and_then(Value::as_u64)
                    == Some(SCAN_CACHE_VERSION)
                    && entry.get("folderKind").and_then(Value::as_str) == Some(folder_kind)
                    && entry.get("signature").and_then(Value::as_str) == Some(signature_value)
                    && entry.get("fileCount").and_then(Value::as_u64) == Some(*file_count)
                    && cache_fresh;
                if matches {
                    let cached = cached_items_for_folder(library, folder, folder_kind);
                    if !cached.is_empty()
                        && cached.len() as u64
                            == entry.get("itemCount").and_then(Value::as_u64).unwrap_or(0)
                        && cached.iter().all(item_complete_for_cache)
                    {
                        return (cached, Some(JsonValue::Object(entry.clone())));
                    }
                }
            }
        }
    }

    let cached_items = cached_items_for_folder(library, folder, folder_kind);
    let cached_by_id = cached_items
        .iter()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), item))
        })
        .collect::<HashMap<_, _>>();
    let items = scan_items_for_folder(folder_path, folder_kind)
        .into_iter()
        .map(|item| {
            let cached = if mode == "quick" {
                item.get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| cached_by_id.get(id).copied())
            } else {
                None
            };
            merge_cached_metadata(item, cached)
        })
        .collect::<Vec<_>>();
    let cache_entry = signature.map(|(signature, file_count)| {
        json!({
            "version": SCAN_CACHE_VERSION,
            "folderKind": folder_kind,
            "signature": signature,
            "fileCount": file_count,
            "itemCount": items.len() as u64,
            "scannedAt": now_millis(),
        })
    });
    (items, cache_entry)
}

fn emit_scan_progress(
    app: &AppHandle,
    movies: &[JsonValue],
    tv_shows: &[JsonValue],
    anime_shows: &[JsonValue],
    groups: &JsonValue,
    scan_cache: &Map<String, JsonValue>,
    scanned_folders: u64,
    total_folders: u64,
    is_complete: bool,
) {
    let library_folders = flatten_group_folders(groups);
    let data_dir = app_data_dir(app);
    let rewrite_artwork = |items: &[JsonValue]| -> Vec<JsonValue> {
        items
            .iter()
            .map(|item| {
                let mut item = item.clone();
                rewrite_item_artwork_for_renderer(&data_dir, &mut item);
                item
            })
            .collect()
    };
    let payload = json!({
        "library": {
            "movies": rewrite_artwork(movies),
            "tvShows": rewrite_artwork(tv_shows),
            "animeShows": rewrite_artwork(anime_shows),
            "libraryFolders": library_folders,
            "libraryFolderGroups": groups,
            "scanCache": JsonValue::Object(scan_cache.clone()),
        },
        "progress": {
            "isComplete": is_complete,
            "scannedFolders": scanned_folders,
            "totalFolders": total_folders,
        }
    });
    let _ = app.emit("library:scan-progress", payload);
}

fn flatten_group_folders(groups: &JsonValue) -> Vec<JsonValue> {
    ["movies", "tvShows", "anime", "others"]
        .iter()
        .flat_map(|group| {
            groups
                .get(*group)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect()
}

fn append_items_to_buckets(
    items: Vec<JsonValue>,
    folder_kind: &str,
    movies: &mut Vec<JsonValue>,
    tv_shows: &mut Vec<JsonValue>,
    anime_shows: &mut Vec<JsonValue>,
) {
    for item in items {
        match folder_kind {
            "movies" => movies.push(item),
            "tv" => tv_shows.push(item),
            "anime" => anime_shows.push(item),
            _ => match item.get("type").and_then(Value::as_str) {
                Some("anime") => anime_shows.push(item),
                Some("tv") => tv_shows.push(item),
                _ => movies.push(item),
            },
        }
    }
}

fn scan_library_data(app: &AppHandle, library: &JsonValue, mode: &str, force: bool) -> JsonValue {
    let groups = normalize_library_folder_groups(library);
    let movies_folders = groups
        .get("movies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tv_folders = groups
        .get("tvShows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let anime_folders = groups
        .get("anime")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let other_folders = groups
        .get("others")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut movies = Vec::new();
    let mut tv_shows = Vec::new();
    let mut anime_shows = Vec::new();
    let mut scan_cache = Map::new();
    let scan_groups = [
        (movies_folders, "movies"),
        (tv_folders, "tv"),
        (anime_folders, "anime"),
        (other_folders, "auto"),
    ];
    let total_folders = scan_groups
        .iter()
        .map(|(folders, _)| folders.len() as u64)
        .sum::<u64>();
    let mut scanned_folders = 0_u64;

    for (folders, folder_kind) in scan_groups {
        for folder in folders.iter().filter_map(Value::as_str) {
            let (items, cache_entry) =
                cached_or_scanned_items(library, folder, folder_kind, mode, force);
            if let Some(entry) = cache_entry {
                scan_cache.insert(folder.to_string(), entry);
            }
            append_items_to_buckets(
                items,
                folder_kind,
                &mut movies,
                &mut tv_shows,
                &mut anime_shows,
            );
            scanned_folders += 1;
            emit_scan_progress(
                app,
                &movies,
                &tv_shows,
                &anime_shows,
                &groups,
                &scan_cache,
                scanned_folders,
                total_folders,
                false,
            );
        }
    }

    let settings = load_settings(app);
    enhance_scanned_items(&mut movies, &settings);
    enhance_scanned_items(&mut tv_shows, &settings);
    enhance_scanned_items(&mut anime_shows, &settings);

    let library_folders = flatten_group_folders(&groups);
    emit_scan_progress(
        app,
        &movies,
        &tv_shows,
        &anime_shows,
        &groups,
        &scan_cache,
        scanned_folders,
        total_folders,
        true,
    );

    json!({
        "movies": movies,
        "tvShows": tv_shows,
        "animeShows": anime_shows,
        "libraryFolders": library_folders,
        "libraryFolderGroups": groups,
        "scanCache": scan_cache,
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn library_get(app: AppHandle) -> JsonValue {
    library_for_renderer(&app, load_library(&app))
}

#[tauri::command(rename_all = "snake_case")]
async fn library_scan(app: AppHandle, mode: Option<String>, force: Option<bool>) -> JsonValue {
    let mode_value = mode.as_deref().unwrap_or("quick");
    let force_value = force.unwrap_or(false);
    let mut library = scan_library_data(&app, &load_library(&app), mode_value, force_value);
    library["scanRequested"] = json!({
        "forced": force_value,
        "mode": mode,
        "at": now_millis(),
    });
    let _ = save_library(&app, &library);
    spawn_artwork_prewarm(&app);
    library_for_renderer(&app, library)
}

#[tauri::command(rename_all = "snake_case")]
async fn library_add_folder(app: AppHandle, kind: Option<String>) -> JsonValue {
    let mut library = load_library(&app);
    let target = AsyncFileDialog::new()
        .pick_folder()
        .await
        .and_then(|handle| handle.path().to_str().map(str::to_owned));

    let Some(folder_path) = target else {
        return JsonValue::Null;
    };

    let kind = kind.unwrap_or_else(|| "movies".to_string());
    let target_group = match kind.as_str() {
        "movies" | "tvShows" | "anime" | "others" => kind.as_str(),
        _ => "movies",
    };

    ensure_library_array(&mut library, "libraryFolders");
    ensure_library_group_array(&mut library, "libraryFolderGroups", "movies");
    ensure_library_group_array(&mut library, "libraryFolderGroups", "tvShows");
    ensure_library_group_array(&mut library, "libraryFolderGroups", "anime");
    ensure_library_group_array(&mut library, "libraryFolderGroups", "others");

    if let Some(folders) = library
        .get_mut("libraryFolders")
        .and_then(Value::as_array_mut)
    {
        if !folders
            .iter()
            .any(|entry| entry.as_str() == Some(&folder_path))
        {
            folders.push(json!(folder_path.clone()));
        }
    }

    if let Some(groups) = library
        .get_mut("libraryFolderGroups")
        .and_then(Value::as_object_mut)
    {
        if let Some(group_folders) = groups.get_mut(target_group).and_then(Value::as_array_mut) {
            if !group_folders
                .iter()
                .any(|entry| entry.as_str() == Some(&folder_path))
            {
                group_folders.push(json!(folder_path.clone()));
            }
        }
    }

    if !save_library(&app, &library) {
        return load_library(&app);
    }

    let scanned = scan_library_data(&app, &library, "full", true);
    let _ = save_library(&app, &scanned);
    library_for_renderer(&app, scanned)
}

fn ensure_library_array(library: &mut JsonValue, key: &str) {
    if library.get(key).and_then(Value::as_array).is_none() {
        library[key] = json!([]);
    }
}

fn ensure_library_group_array(library: &mut JsonValue, key: &str, group_key: &str) {
    if library.get(key).and_then(Value::as_object).is_none() {
        library[key] = json!({});
    }

    if library
        .get(key)
        .and_then(Value::as_object)
        .and_then(|group| group.get(group_key))
        .and_then(Value::as_array)
        .is_none()
    {
        if let Some(group) = library.get_mut(key).and_then(Value::as_object_mut) {
            group.insert(group_key.to_string(), json!([]));
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn library_remove_folder(app: AppHandle, folder_path: String) -> JsonValue {
    let mut library = load_library(&app);
    if let Some(groups) = library
        .get_mut("libraryFolderGroups")
        .and_then(Value::as_object_mut)
    {
        for value in groups.values_mut() {
            if let Some(list) = value.as_array_mut() {
                list.retain(|entry| entry.as_str() != Some(&folder_path));
            }
        }
    }

    if let Some(folders) = library
        .get_mut("libraryFolders")
        .and_then(Value::as_array_mut)
    {
        folders.retain(|entry| entry.as_str() != Some(&folder_path));
    }

    if !save_library(&app, &library) {
        return load_library(&app);
    }

    library_for_renderer(&app, library)
}

#[tauri::command(rename_all = "snake_case")]
async fn media_play(_file_path: String) -> bool {
    false
}

#[tauri::command(rename_all = "snake_case")]
async fn media_get_stream_url(file_path: String, options: Option<JsonValue>) -> JsonValue {
    let force_transcode = options
        .as_ref()
        .and_then(|value| value.get("forceTranscode"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_transcoded = should_transcode(&file_path, force_transcode);

    let mut query_parts = vec![
        format!("path={}", percent_escape(&file_path)),
        local_access_query_pair(),
    ];

    if let Some(params) = options.as_ref().and_then(Value::as_object) {
        let keys = [
            ("t", "startSeconds"),
            ("video", "videoTrackIndex"),
            ("audio", "audioTrackIndex"),
            ("subtitle", "subtitleTrackIndex"),
            ("subtitleOrdinal", "subtitleStreamOrdinal"),
            ("secondarySubtitle", "secondarySubtitleTrackIndex"),
            ("secondarySubtitleOrdinal", "secondarySubtitleStreamOrdinal"),
        ];

        for (key, option_key) in keys {
            if let Some(value) = params
                .get(option_key)
                .and_then(Value::as_f64)
                .or_else(|| {
                    params
                        .get(option_key)
                        .and_then(Value::as_i64)
                        .map(|value| value as f64)
                })
                .or_else(|| {
                    params
                        .get(option_key)
                        .and_then(Value::as_u64)
                        .map(|value| value as f64)
                })
            {
                query_parts.push(format!("{key}={}", value.floor()));
            }
        }

        if let Some(value) = params.get("subtitleCodec").and_then(Value::as_str) {
            query_parts.push(format!("subtitleCodec={}", percent_escape(value)));
        }
        if let Some(value) = params.get("secondarySubtitleCodec").and_then(Value::as_str) {
            query_parts.push(format!("secondarySubtitleCodec={}", percent_escape(value)));
        }
        if let Some(value) = params.get("preset").and_then(Value::as_str) {
            query_parts.push(format!("preset={}", percent_escape(value)));
        }
        if let Some(style) = params.get("subtitleStyle").and_then(Value::as_object) {
            if let Ok(serialized) = serde_json::to_string(style) {
                query_parts.push(format!("subtitleStyle={}", percent_escape(&serialized)));
            }
        }
        if force_transcode {
            query_parts.push("forceTranscode=1".to_string());
        }
    }
    let url = format!(
        "http://127.0.0.1:{}/stream?{}",
        media_server_port(),
        query_parts.join("&")
    );

    json!({
        "url": url,
        "contentType": if is_transcoded { "video/mp4" } else { content_type_for_path(&file_path) },
        "fileName": file_name_from_path(&file_path),
        "isTranscoded": is_transcoded,
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn media_get_thumbnail(file_path: String, time: Option<String>) -> JsonValue {
    let safe_time = time.unwrap_or_else(|| "00:00:00".to_string());
    json!({ "url": format!(
        "http://127.0.0.1:{}/api/thumbnail?path={}&t={}&{}",
        media_server_port(),
        percent_escape(&file_path),
        percent_escape(&safe_time),
        local_access_query_pair()
    ) })
}

#[tauri::command(rename_all = "snake_case")]
async fn media_get_subtitle_url(file_path: String, stream_ordinal: u32) -> JsonValue {
    json!({ "url": format!(
        "http://127.0.0.1:{}/subtitle?path={}&streamOrdinal={}&{}",
        media_server_port(),
        percent_escape(&file_path),
        stream_ordinal,
        local_access_query_pair()
    ) })
}

#[tauri::command(rename_all = "snake_case")]
async fn media_get_file_info(file_path: String) -> JsonValue {
    match fs::metadata(&file_path) {
        Ok(metadata) => json!({
            "size": metadata.len(),
            "path": file_path,
            "exists": true,
        }),
        Err(_) => json!({
            "size": 0,
            "path": file_path,
            "exists": false,
        }),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn media_get_server_port() -> u16 {
    media_server_port()
}

#[tauri::command(rename_all = "snake_case")]
async fn settings_get(app: AppHandle) -> JsonValue {
    let normalized = normalize_settings_payload(load_settings(&app));
    let _ = save_settings(&app, &normalized);
    normalized
}

#[tauri::command(rename_all = "snake_case")]
async fn settings_save(app: AppHandle, settings: JsonValue) -> bool {
    let merged = merge_settings_payload(load_settings(&app), settings);
    let ok = save_settings(&app, &merged);
    if ok {
        sync_lan_advertisement(&app_data_dir(&app));
    }
    ok
}

#[tauri::command(rename_all = "snake_case")]
async fn metadata_test_keys(keys: JsonValue) -> JsonValue {
    run_metadata_key_tests(keys)
}

fn run_metadata_key_tests(keys: JsonValue) -> JsonValue {
    if let Some(payload) = keys.as_object() {
        let results = payload
            .iter()
            .filter_map(|(provider, value)| value.as_str().map(|value| (provider, value)))
            .map(|(provider, value)| {
                let provider_id = provider.trim().to_ascii_lowercase();
                let key = value.trim();
                if key.is_empty() {
                    return json!({
                        "provider": provider_id,
                        "ok": false,
                        "message": "Missing key.",
                    });
                }
                let (ok, message) = match provider_id.as_str() {
                    "tmdb" => {
                        let ok = tmdb_json("configuration", key).is_some();
                        (
                            ok,
                            if ok {
                                "TMDB key works.".to_string()
                            } else {
                                "TMDB rejected the key or could not be reached.".to_string()
                            },
                        )
                    }
                    "omdb" => {
                        let url = format!(
                            "https://www.omdbapi.com/?i=tt0133093&apikey={}",
                            percent_escape(key)
                        );
                        let data = http_json(&url, &[]);
                        let ok = data
                            .as_ref()
                            .and_then(|value| value.get("Response"))
                            .and_then(Value::as_str)
                            != Some("False")
                            && data.is_some();
                        let message = if ok {
                            "OMDb key works.".to_string()
                        } else {
                            data.and_then(|value| {
                                value
                                    .get("Error")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .unwrap_or_else(|| {
                                "OMDb rejected the key or could not be reached.".to_string()
                            })
                        };
                        (ok, message)
                    }
                    "fanart" => {
                        let url = format!(
                            "https://webservice.fanart.tv/v3/movies/120?api_key={}",
                            percent_escape(key)
                        );
                        let ok = http_json(&url, &[]).is_some();
                        (
                            ok,
                            if ok {
                                "Fanart.tv key works.".to_string()
                            } else {
                                "Fanart.tv rejected the key or could not be reached.".to_string()
                            },
                        )
                    }
                    _ => (true, "Configured.".to_string()),
                };
                json!({
                    "provider": provider_id,
                    "ok": ok,
                    "message": message,
                })
            })
            .collect::<Vec<_>>();
        json!(results)
    } else {
        json!([])
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn network_status(app: AppHandle) -> JsonValue {
    let settings = ensure_network_settings(load_settings(&app));
    let _ = save_settings(&app, &settings);
    let port = media_server_port();
    let addresses = local_network_addresses();
    let host = addresses
        .iter()
        .find(|address| address.as_str() != "127.0.0.1")
        .cloned()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let base_url = format!("http://{host}:{port}");
    json!({
        "sharingEnabled": settings.get("localNetworkSharingEnabled").and_then(Value::as_bool).unwrap_or(false),
        "token": settings.get("localNetworkShareToken").and_then(Value::as_str).unwrap_or(""),
        "deviceId": settings.get("localNetworkDeviceId").and_then(Value::as_str).unwrap_or("loomtv-desktop"),
        "deviceName": settings.get("localNetworkDeviceName").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(local_host_name),
        "networkName": "LoomTV Local",
        "port": port,
        "addresses": addresses,
        "baseUrl": base_url.clone(),
        "libraryUrl": format!("{}/api/lan/library", base_url),
        "pairedDevices": settings.get("localNetworkPairedDevices").cloned().unwrap_or_else(|| json!([])),
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn network_discover_peers(app: AppHandle, timeout_ms: Option<u64>) -> JsonValue {
    let settings = ensure_network_settings(load_settings(&app));
    let own_device_id = settings.get("localNetworkDeviceId").and_then(Value::as_str);
    JsonValue::Array(discover_lan_peers(timeout_ms.unwrap_or(2500), own_device_id))
}

#[tauri::command(rename_all = "snake_case")]
async fn network_revoke_paired_device(app: AppHandle, device_id: String) -> JsonValue {
    let mut settings = load_settings(&app);
    if let Some(devices) = settings
        .get_mut("localNetworkPairedDevices")
        .and_then(Value::as_array_mut)
    {
        devices.retain(|device| device.get("id").and_then(Value::as_str) != Some(&device_id));
        let remaining = JsonValue::Array(devices.clone());
        let _ = save_settings(&app, &settings);
        return remaining;
    }
    json!([])
}

#[tauri::command(rename_all = "snake_case")]
async fn network_set_device_name(app: AppHandle, name: String) -> String {
    let next_name = name.trim().chars().take(80).collect::<String>();
    let next_name = if next_name.is_empty() {
        local_host_name()
    } else {
        next_name
    };
    let mut settings = load_settings(&app);
    if !settings.is_object() {
        settings = json!({});
    }
    settings["localNetworkDeviceName"] = json!(next_name.clone());
    let _ = save_settings(&app, &settings);
    sync_lan_advertisement(&app_data_dir(&app));
    next_name
}

#[tauri::command(rename_all = "snake_case")]
async fn progress_get(app: AppHandle, file_path: Option<String>) -> JsonValue {
    with_database_fallback(&app, JsonValue::Null, |data_dir| {
        database::get_progress(data_dir, file_path.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn progress_save(
    app: AppHandle,
    file_path: String,
    position: f64,
    duration: f64,
) -> JsonValue {
    with_database_fallback(&app, JsonValue::Null, |data_dir| {
        database::save_progress(data_dir, &file_path, position, duration)
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn progress_import(app: AppHandle, progress: JsonValue) -> bool {
    with_database_fallback(&app, false, |data_dir| {
        database::import_progress(data_dir, &progress)?;
        Ok(true)
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_get(app: AppHandle, media_id: String) -> JsonValue {
    artwork_for_media(&app, &media_id)
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_save(
    app: AppHandle,
    media_id: String,
    target: String,
    data_url: String,
) -> JsonValue {
    with_database_fallback(&app, json!({}), |data_dir| {
        let durable_artwork = materialize_custom_artwork_source(data_dir, &data_url)
            .map_err(rusqlite::Error::InvalidParameterName)?;
        database::save_custom_artwork(data_dir, &media_id, &target, &durable_artwork)
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_official_candidates(app: AppHandle, media_id: String) -> JsonValue {
    let library = load_library(&app);
    let settings = load_settings(&app);
    match find_library_item(&library, &media_id) {
        Some(item) => json!(official_metadata_candidates_for_item(&item, &settings)),
        None => json!([]),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_apply_official(
    app: AppHandle,
    media_id: String,
    candidate: JsonValue,
) -> JsonValue {
    if !candidate.is_object() {
        return json!({});
    }
    let mut library = load_library(&app);
    if update_library_item(&mut library, &media_id, &candidate) {
        let _ = save_library(&app, &library);
    }
    official_artwork_result(&candidate)
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_refresh_official(app: AppHandle, media_id: String) -> JsonValue {
    let mut library = load_library(&app);
    let settings = load_settings(&app);
    let metadata = find_library_item(&library, &media_id)
        .and_then(|item| fetch_best_metadata_for_item(&item, &settings));
    let result = apply_refreshed_metadata_to_library(
        &mut library,
        &media_id,
        metadata,
        artwork_for_media(&app, &media_id),
    );
    let _ = save_library(&app, &library);
    result
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_playback_logo(app: AppHandle, media_id: String) -> JsonValue {
    let artwork = artwork_for_media(&app, &media_id);
    json!({
        "logo": artwork.get("logo").cloned().unwrap_or(JsonValue::Null),
        "logoCandidates": artwork.get("logoCandidates").cloned().unwrap_or_else(|| json!([])),
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn artwork_import(app: AppHandle, entries: JsonValue) -> bool {
    with_database_fallback(&app, false, |data_dir| {
        database::import_custom_artwork(data_dir, &entries)?;
        Ok(entries.is_object())
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn database_backup(app: AppHandle) -> JsonValue {
    database::backup_database(&app_data_dir(&app))
}

#[tauri::command(rename_all = "snake_case")]
async fn database_clear(app: AppHandle) -> JsonValue {
    with_database_fallback(&app, library_default(), database::clear_database)
}

#[tauri::command(rename_all = "snake_case")]
async fn shell_open_external(url: String) -> bool {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return false;
    }
    open_with_system_target(&url)
}

#[tauri::command(rename_all = "snake_case")]
async fn ffmpeg_available() -> JsonValue {
    command_result(locate_executable("ffmpeg"))
}

fn normalize_release_version(value: &str) -> String {
    value.trim().trim_start_matches(['v', 'V']).to_string()
}

fn compare_release_versions(left: &str, right: &str) -> i8 {
    let left = normalize_release_version(left)
        .split('.')
        .map(|part| part.parse::<i64>().unwrap_or(0))
        .collect::<Vec<_>>();
    let right = normalize_release_version(right)
        .split('.')
        .map(|part| part.parse::<i64>().unwrap_or(0))
        .collect::<Vec<_>>();
    let len = left.len().max(right.len());
    for index in 0..len {
        let left_part = *left.get(index).unwrap_or(&0);
        let right_part = *right.get(index).unwrap_or(&0);
        if left_part > right_part {
            return 1;
        }
        if left_part < right_part {
            return -1;
        }
    }
    0
}

fn default_update_state() -> JsonValue {
    json!({
        "status": "idle",
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "supported": true,
        "message": "Ready to check for updates.",
    })
}

fn update_state_store() -> &'static Mutex<JsonValue> {
    UPDATE_STATE.get_or_init(|| Mutex::new(default_update_state()))
}

fn set_update_state(app: Option<&AppHandle>, patch: JsonValue) -> JsonValue {
    let mut state = update_state_store().lock().unwrap();
    let mut next = state.clone();
    if !next.is_object() {
        next = default_update_state();
    }
    if let (Some(next_obj), Some(patch_obj)) = (next.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            next_obj.insert(key.clone(), value.clone());
        }
    }
    next["currentVersion"] = json!(env!("CARGO_PKG_VERSION"));
    next["platform"] = json!(std::env::consts::OS);
    next["arch"] = json!(std::env::consts::ARCH);
    next["supported"] = json!(true);
    *state = next.clone();
    drop(state);
    if let Some(app) = app {
        let _ = app.emit("updates:state", next.clone());
    }
    next
}

#[tauri::command(rename_all = "snake_case")]
async fn updates_get_state() -> JsonValue {
    update_state_store().lock().unwrap().clone()
}

fn github_release_check_state() -> JsonValue {
    let checked_at = now_millis();
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "-H",
            "Accept: application/vnd.github+json",
            &format!("https://api.github.com/repos/{UPDATE_OWNER}/{UPDATE_REPO}/releases/latest"),
        ])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let parsed: JsonValue =
                serde_json::from_slice(&output.stdout).unwrap_or_else(|_| json!({}));
            let latest_version = parsed
                .get("tag_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_start_matches(['v', 'V'])
                .to_string();
            let has_update = !latest_version.is_empty()
                && compare_release_versions(&latest_version, env!("CARGO_PKG_VERSION")) > 0;
            json!({
                "status": if has_update { "available" } else { "not-available" },
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "supported": true,
                "latestVersion": latest_version,
                "releaseUrl": parsed.get("html_url").and_then(Value::as_str).unwrap_or(""),
                "checkedAt": checked_at.to_string(),
                "message": if has_update { "Update available. Use Update now to download and install it." } else { "LoomTV is up to date." },
            })
        }
        Ok(output) => json!({
            "status": "error",
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "supported": true,
            "checkedAt": checked_at.to_string(),
            "message": format!("Update check failed with status {}.", output.status),
        }),
        Err(error) => json!({
            "status": "error",
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "supported": true,
            "checkedAt": checked_at.to_string(),
            "message": error.to_string(),
        }),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn updates_check(app: AppHandle) -> JsonValue {
    set_update_state(
        Some(&app),
        json!({
            "status": "checking",
            "downloadPercent": JsonValue::Null,
            "message": "Checking for updates...",
        }),
    );
    let check_result = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match check_result {
        Ok(Some(update)) => set_update_state(
            Some(&app),
            json!({
                "status": "available",
                "latestVersion": update.version,
                "checkedAt": now_millis().to_string(),
                "message": "Update available. Use Update now to download and install it.",
            }),
        ),
        Ok(None) => set_update_state(
            Some(&app),
            json!({
                "status": "not-available",
                "checkedAt": now_millis().to_string(),
                "message": "LoomTV is up to date.",
            }),
        ),
        Err(error) => {
            let fallback = github_release_check_state();
            if fallback.get("status").and_then(Value::as_str) == Some("error") {
                set_update_state(
                    Some(&app),
                    json!({
                        "status": "error",
                        "checkedAt": now_millis().to_string(),
                        "message": error,
                    }),
                )
            } else {
                set_update_state(Some(&app), fallback)
            }
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn updates_install(app: AppHandle) -> JsonValue {
    set_update_state(
        Some(&app),
        json!({
            "status": "downloading",
            "downloadPercent": 0,
            "message": "Downloading update...",
        }),
    );
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return set_update_state(
                Some(&app),
                json!({
                    "status": "error",
                    "checkedAt": now_millis().to_string(),
                    "message": error.to_string(),
                }),
            );
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return set_update_state(
                Some(&app),
                json!({
                    "status": "not-available",
                    "checkedAt": now_millis().to_string(),
                    "message": "No update is available to install.",
                }),
            );
        }
        Err(error) => {
            return set_update_state(
                Some(&app),
                json!({
                    "status": "error",
                    "checkedAt": now_millis().to_string(),
                    "message": error.to_string(),
                }),
            );
        }
    };

    let app_for_progress = app.clone();
    let mut downloaded = 0_u64;
    let mut content_length = 0_u64;
    let download_result = update
        .download_and_install(
            |chunk_length, next_content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                if let Some(next_content_length) = next_content_length {
                    content_length = next_content_length;
                }
                let percent = if content_length > 0 {
                    ((downloaded as f64 / content_length as f64) * 100.0)
                        .round()
                        .clamp(0.0, 100.0) as u64
                } else {
                    0
                };
                let _ = set_update_state(
                    Some(&app_for_progress),
                    json!({
                        "status": "downloading",
                        "downloadPercent": percent,
                        "message": format!("Downloading update {percent}%"),
                    }),
                );
            },
            || {
                let _ = set_update_state(
                    Some(&app_for_progress),
                    json!({
                        "status": "downloaded",
                        "downloadPercent": 100,
                        "message": "Update downloaded. Installing...",
                    }),
                );
            },
        )
        .await;

    match download_result {
        Ok(()) => {
            let _ = set_update_state(
                Some(&app),
                json!({
                    "status": "installing",
                    "downloadPercent": 100,
                    "message": "Update installed. Restarting LoomTV...",
                }),
            );
            app.restart();
        }
        Err(error) => set_update_state(
            Some(&app),
            json!({
                "status": "error",
                "checkedAt": now_millis().to_string(),
                "message": error.to_string(),
            }),
        ),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn media_probe(file_path: String) -> JsonValue {
    probe_media_file(file_path)
}

fn probe_media_file(file_path: String) -> JsonValue {
    if !Path::new(&file_path).is_file() {
        return json!({
            "ok": false,
            "error": "File not found.",
        });
    }
    let probe = probe_media_details(&file_path);
    if probe
        .as_object()
        .map(|value| value.is_empty())
        .unwrap_or(true)
    {
        let metadata = fs::metadata(&file_path).ok();
        return json!({
            "ok": true,
            "data": {
                "filePath": file_path,
                "durationSeconds": null,
                "bitrateKbps": null,
                "videoCodec": "",
                "audioCodec": "",
                "resolution": {},
                "subtitleStreams": [],
                "tracks": [],
                "size": metadata.map(|value| value.len()).unwrap_or(0),
                "exists": true,
            }
        });
    }
    json!({ "ok": true, "data": probe })
}

#[tauri::command(rename_all = "snake_case")]
async fn media_can_direct_play(file_path: String, backend: Option<String>) -> JsonValue {
    if backend.as_deref() != Some("html5") {
        return json!({ "ok": true, "data": false });
    }
    let probe = probe_media_details(&file_path);
    if let Some(tracks) = probe.get("tracks").and_then(Value::as_array) {
        let video = tracks
            .iter()
            .find(|track| track.get("type").and_then(Value::as_str) == Some("video"));
        let video_codec = probe
            .get("videoCodec")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let audio_codec = probe
            .get("audioCodec")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let pixel_format = video
            .and_then(|track| track.get("pixelFormat"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let profile = video
            .and_then(|track| track.get("profile"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let direct = video_codec == "h264"
            && pixel_format == "yuv420p"
            && !profile.contains("10")
            && ["aac", "mp3"].contains(&audio_codec.as_str());
        return json!({ "ok": true, "data": direct });
    }
    let extension = file_extension(&file_path);
    let direct = matches!(extension.as_str(), "mp4" | "m4v" | "mov" | "webm");
    json!({ "ok": true, "data": direct })
}

#[tauri::command(rename_all = "snake_case")]
async fn media_start_transcode(
    app: AppHandle,
    file_path: String,
    options: Option<JsonValue>,
) -> JsonValue {
    let data_dir = app_data_dir(&app);
    start_hls_transcode(&data_dir, file_path, options)
}

#[tauri::command(rename_all = "snake_case")]
async fn media_stop_transcode(session_id: String) -> JsonValue {
    json!({ "ok": true, "data": stop_transcode_session(&session_id) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_merge_normalizes_and_persists_metadata_keys() {
        let existing = json!({
            "playbackSkipBackSeconds": 7,
            "metadataApiKeys": {
                "tmdb": "old-tmdb",
                "custom": "old-custom"
            }
        });
        let incoming = json!({
            "metadataApiKeys": {
                " TMDB ": "  new-tmdb  ",
                "omdb": " new-omdb ",
                "fanart": "",
                "custom": "new-custom"
            }
        });

        let merged = merge_settings_payload(existing, incoming);

        assert_eq!(merged["playbackSkipBackSeconds"], json!(7));
        assert_eq!(merged["metadataApiKeys"]["tmdb"], json!("new-tmdb"));
        assert_eq!(merged["metadataApiKeys"]["omdb"], json!("new-omdb"));
        assert_eq!(merged["metadataApiKeys"]["custom"], json!("new-custom"));
        assert!(merged["metadataApiKeys"].get("fanart").is_none());
        assert_eq!(merged["tmdbApiKey"], json!("new-tmdb"));
        assert_eq!(merged["omdbApiKey"], json!("new-omdb"));
    }

    #[test]
    fn settings_merge_preserves_keys_when_saving_unrelated_settings() {
        let existing = json!({
            "metadataApiKeys": {
                "tmdb": "saved-tmdb",
                "omdb": "saved-omdb"
            }
        });
        let incoming = json!({ "playbackSkipForwardSeconds": 21 });

        let merged = merge_settings_payload(existing, incoming);

        assert_eq!(merged["metadataApiKeys"]["tmdb"], json!("saved-tmdb"));
        assert_eq!(merged["metadataApiKeys"]["omdb"], json!("saved-omdb"));
        assert_eq!(merged["tmdbApiKey"], json!("saved-tmdb"));
        assert_eq!(merged["omdbApiKey"], json!("saved-omdb"));
        assert_eq!(merged["playbackSkipForwardSeconds"], json!(21));
    }

    #[test]
    fn hls_transcode_args_create_playlist_output() {
        let args = hls_transcode_args(
            "/tmp/movie.mkv",
            "/tmp/session/index.m3u8",
            &json!({
                "startSeconds": 42,
                "audioTrackIndex": 2,
                "videoTrackIndex": 0
            }),
        );

        assert!(args.iter().any(|value| value == "-f"));
        assert!(args.iter().any(|value| value == "hls"));
        assert!(args.iter().any(|value| value == "-hls_segment_filename"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("/tmp/session/index.m3u8")
        );
    }

    #[test]
    fn hls_playlist_is_ready_after_first_segment() {
        let dir = tempfile::tempdir().unwrap();
        let playlist = dir.path().join("index.m3u8");
        fs::write(
            &playlist,
            [
                "#EXTM3U",
                "#EXT-X-TARGETDURATION:1",
                "#EXTINF:1.0,",
                "segment-00000.ts",
                "#EXTINF:1.0,",
                "segment-00001.ts",
                "",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(dir.path().join("segment-00000.ts"), b"segment").unwrap();

        assert!(playlist_has_ready_segments(&playlist));
    }

    #[test]
    fn local_media_urls_include_local_access_token() {
        let stream = tauri::async_runtime::block_on(media_get_stream_url(
            "/tmp/movie.mp4".to_string(),
            None,
        ));
        let thumbnail = tauri::async_runtime::block_on(media_get_thumbnail(
            "/tmp/movie.mp4".to_string(),
            Some("00:01:00".to_string()),
        ));

        assert!(
            stream["url"]
                .as_str()
                .unwrap_or_default()
                .contains("loomtvToken=")
        );
        assert!(
            thumbnail["url"]
                .as_str()
                .unwrap_or_default()
                .contains("loomtvToken=")
        );
    }

    #[test]
    fn cached_artwork_rewrites_stale_loopback_urls() {
        let stale_url =
            "http://127.0.0.1:12345/api/thumbnail?path=%2Ftmp%2Fmovie.mkv&t=00%3A01%3A00&loomtvToken=old";
        let data_dir = tempfile::tempdir().unwrap();

        let rewritten = local_cached_artwork_url(data_dir.path(), stale_url);

        assert!(rewritten.starts_with(&format!(
            "http://127.0.0.1:{}/api/thumbnail?",
            DEFAULT_MEDIA_SERVER_PORT
        )));
        assert!(rewritten.contains("path=%2Ftmp%2Fmovie.mkv"));
        assert!(rewritten.contains("t=00%3A01%3A00"));
        assert!(rewritten.contains("loomtvToken="));
        assert!(!rewritten.contains("12345"));
        assert!(!rewritten.contains("old"));
    }

    #[test]
    fn cached_remote_artwork_is_routed_through_local_cache_for_renderer() {
        let data_dir = tempfile::tempdir().unwrap();
        database::initialize(data_dir.path()).unwrap();
        database::save_cached_artwork(
            data_dir.path(),
            "https://image.example/poster.jpg",
            "data:image/jpeg;base64,ZmFrZQ==",
            "image/jpeg",
            4,
        )
        .unwrap();

        let rewritten = local_cached_artwork_url(data_dir.path(), "https://image.example/poster.jpg");

        assert!(rewritten.starts_with(&format!(
            "http://127.0.0.1:{}/api/cached-artwork?",
            DEFAULT_MEDIA_SERVER_PORT
        )));
        assert!(rewritten.contains("source=https%3A%2F%2Fimage.example%2Fposter.jpg"));
        assert!(rewritten.contains("loomtvToken="));
    }

    #[test]
    fn custom_artwork_maps_are_rewritten_for_renderer() {
        let data_dir = tempfile::tempdir().unwrap();
        database::initialize(data_dir.path()).unwrap();
        database::save_cached_artwork(
            data_dir.path(),
            "https://image.example/custom-poster.jpg",
            "data:image/jpeg;base64,Y3VzdG9t",
            "image/jpeg",
            6,
        )
        .unwrap();
        let mut artwork = json!({
            "poster": "https://image.example/custom-poster.jpg",
            "cover": "data:image/png;base64,Zm9v"
        });

        rewrite_artwork_map_for_renderer(data_dir.path(), &mut artwork);

        assert!(
            artwork["poster"]
                .as_str()
                .unwrap_or_default()
                .starts_with(&format!(
                    "http://127.0.0.1:{}/api/cached-artwork?",
                    DEFAULT_MEDIA_SERVER_PORT
                ))
        );
        assert_eq!(artwork["cover"], json!("data:image/png;base64,Zm9v"));
    }

    #[test]
    fn basic_responses_do_not_use_wildcard_cors() {
        let payload = String::from_utf8(response("200 OK", "text/plain", b"ok")).unwrap();

        assert!(!payload.contains("Access-Control-Allow-Origin: *"));
        assert!(payload.contains("Vary: Origin"));
    }

    #[test]
    fn mp4_transcode_args_use_requested_hardware_encoder() {
        let args = mp4_transcode_args(
            "/tmp/movie.mkv",
            &json!({
                "preset": "nvenc",
                "audioTrackIndex": 0,
                "videoTrackIndex": 0
            }),
            "pipe:1",
        );

        assert!(args.windows(2).any(|window| window == ["-c:v", "h264_nvenc"]));
        assert!(args.windows(2).any(|window| window == ["-preset", "p4"]));
    }

    #[test]
    fn mp4_transcode_args_map_selected_audio_track() {
        let args = mp4_transcode_args(
            "/tmp/movie.mkv",
            &json!({
                "audioTrackIndex": 2,
                "videoTrackIndex": 0
            }),
            "pipe:1",
        );

        assert!(args.windows(2).any(|window| window == ["-map", "0:2?"]));
        assert!(args.windows(2).any(|window| window == ["-c:a", "aac"]));
    }

    #[test]
    fn mp4_transcode_args_can_disable_audio() {
        let args = mp4_transcode_args(
            "/tmp/movie.mkv",
            &json!({
                "audioTrackIndex": -1,
                "videoTrackIndex": 0
            }),
            "pipe:1",
        );

        assert!(args.iter().any(|value| value == "-an"));
        assert!(!args.windows(2).any(|window| window == ["-c:a", "aac"]));
    }

    #[test]
    fn mp4_transcode_args_burn_text_subtitles() {
        let args = mp4_transcode_args(
            "/tmp/show.mkv",
            &json!({
                "subtitleTrackIndex": 4,
                "subtitleStreamOrdinal": 1,
                "subtitleCodec": "subrip"
            }),
            "pipe:1",
        );

        let vf_index = args
            .iter()
            .position(|value| value == "-vf")
            .expect("text subtitles should use a video filter");
        assert!(args[vf_index + 1].contains("subtitles='/tmp/show.mkv':si=1"));
        assert!(args.iter().any(|value| value == "-sn"));
    }

    #[test]
    fn mp4_transcode_args_overlay_bitmap_subtitles() {
        let args = mp4_transcode_args(
            "/tmp/show.mkv",
            &json!({
                "subtitleTrackIndex": 5,
                "subtitleStreamOrdinal": 0,
                "subtitleCodec": "hdmv_pgs_subtitle"
            }),
            "pipe:1",
        );

        let filter_index = args
            .iter()
            .position(|value| value == "-filter_complex")
            .expect("bitmap subtitles should use a filter graph");
        assert!(args[filter_index + 1].contains("[0:v:0][0:5]overlay"));
        assert!(args.windows(2).any(|window| window == ["-map", "[vsub0]"]));
    }

    #[test]
    fn srt_to_vtt_converts_only_timing_commas() {
        let converted = srt_to_vtt("1\n00:00:01,250 --> 00:00:02,500\nHello, friend\n");

        assert!(converted.starts_with("WEBVTT\n\n"));
        assert!(converted.contains("00:00:01.250 --> 00:00:02.500"));
        assert!(converted.contains("Hello, friend"));
    }

    #[test]
    fn metadata_merge_applies_remote_episode_titles_to_scanned_files() {
        let mut item = json!({
            "type": "tv",
            "episodeFiles": [
                { "season": 1, "episode": 1, "title": "Local E01", "filePath": "/show/S01E01.mkv" },
                { "season": 1, "episode": 2, "title": "Local E02", "filePath": "/show/S01E02.mkv" }
            ],
            "episodes": [
                { "season": 1, "number": 1, "title": "Local E01", "summary": "", "still": "", "rating": 0, "airDate": "" },
                { "season": 1, "number": 2, "title": "Local E02", "summary": "", "still": "", "rating": 0, "airDate": "" }
            ]
        });
        let metadata = json!({
            "source": "TMDB",
            "episodes": [
                { "season": 1, "number": 1, "title": "Official Pilot", "summary": "First story", "still": "/still.jpg", "rating": 8.1, "airDate": "2024-01-01" }
            ]
        });

        merge_metadata_into_item(&mut item, &metadata);

        assert_eq!(item["episodes"][0]["title"], json!("Official Pilot"));
        assert_eq!(item["episodes"][0]["summary"], json!("First story"));
        assert_eq!(item["episodes"][1]["title"], json!("Local E02"));
    }

    #[test]
    fn jikan_episode_merge_matches_anime_by_episode_number() {
        let mut item = json!({
            "type": "anime",
            "episodeFiles": [
                { "season": 1, "episode": 2, "title": "Local Anime 02", "filePath": "/anime/02.mkv" }
            ],
            "episodes": [
                { "season": 1, "number": 2, "title": "Local Anime 02", "summary": "", "still": "", "rating": 0, "airDate": "" }
            ]
        });
        let metadata = json!({
            "source": "Jikan",
            "episodes": [
                { "season": 1, "number": 2, "title": "Official Anime Episode", "summary": "", "still": "", "rating": 7.4, "airDate": "" }
            ]
        });

        merge_metadata_into_item(&mut item, &metadata);

        assert_eq!(
            item["episodes"][0]["title"],
            json!("Official Anime Episode")
        );
        assert_eq!(item["episodes"][0]["rating"], json!(7.4));
    }

    #[test]
    fn http_json_body_parser_handles_gzip_payloads() {
        let gzipped = [
            0x1f, 0x8b, 0x08, 0x00, 0x30, 0x0c, 0x0d, 0x6a, 0x00, 0x03, 0xab, 0x56, 0xca, 0xcf,
            0x56, 0xb2, 0x2a, 0x29, 0x2a, 0x4d, 0xad, 0x05, 0x00, 0x90, 0x5f, 0xd4, 0xa7, 0x0b,
            0x00, 0x00, 0x00,
        ];

        let parsed = parse_http_json_body(&gzipped).expect("gzip body should parse");

        assert_eq!(parsed["ok"], json!(true));
    }

    #[test]
    fn metadata_lookup_title_removes_release_tags_after_year() {
        assert_eq!(
            metadata_lookup_title("The Godfather 1972 BrRip BOKUTOX YIFY"),
            "The Godfather"
        );
        assert_eq!(
            metadata_lookup_title("Interstellar (2014) AV1 7RIP"),
            "Interstellar"
        );
        assert_eq!(
            metadata_lookup_title("The Super Mario Bros Movie (2023) Film Review"),
            "The Super Mario Bros Movie"
        );
        assert_eq!(
            metadata_lookup_title(
                "[Anime Time] Demon Slayer - Kimetsu no Yaiba - The Movie Mugen Train"
            ),
            "Demon Slayer - Kimetsu no Yaiba - The Movie Mugen Train"
        );
    }

    #[test]
    fn refreshed_metadata_updates_library_item() {
        let mut library = json!({
            "movies": [{
                "id": "movie-1",
                "title": "Old Title",
                "summary": "",
                "rating": 0,
                "genres": [],
                "poster": "",
                "backdrop": ""
            }]
        });
        let metadata = json!({
            "title": "The Godfather",
            "summary": "A crime family story.",
            "rating": 8.7,
            "genres": ["Crime", "Drama"],
            "thumbnail": "https://image.example/poster.jpg",
            "cover": "https://image.example/backdrop.jpg"
        });

        let result = apply_refreshed_metadata_to_library(
            &mut library,
            "movie-1",
            Some(metadata),
            json!({"thumbnail": "fallback"}),
        );

        assert_eq!(result["title"], json!("The Godfather"));
        assert_eq!(library["movies"][0]["title"], json!("The Godfather"));
        assert_eq!(
            library["movies"][0]["summary"],
            json!("A crime family story.")
        );
        assert_eq!(library["movies"][0]["rating"], json!(8.7));
        assert_eq!(
            library["movies"][0]["poster"],
            json!("https://image.example/poster.jpg")
        );
        assert_eq!(
            library["movies"][0]["backdrop"],
            json!("https://image.example/backdrop.jpg")
        );
    }

    #[test]
    fn metadata_key_candidates_try_other_saved_keys_after_configured_provider() {
        let settings = json!({
            "metadataApiKeys": {
                "tmdb": "bad-tmdb-key",
                "fanart": "actual-tmdb-key",
                "omdb": "omdb-key"
            }
        });

        assert_eq!(
            metadata_key_candidates(&settings, "tmdb"),
            vec![
                "bad-tmdb-key".to_string(),
                "actual-tmdb-key".to_string(),
                "omdb-key".to_string()
            ]
        );
    }

    #[test]
    fn auto_scan_arranges_movies_and_series_like_electron() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Arrival.2016.mp4"), b"").unwrap();
        let show_dir = dir.path().join("Slow Horses");
        fs::create_dir_all(show_dir.join("Season 1")).unwrap();
        fs::write(
            show_dir.join("Season 1").join("Slow.Horses.S01E01.mkv"),
            b"",
        )
        .unwrap();

        let items = scan_folder(dir.path(), "auto");

        assert!(items.iter().any(
            |item| item.get("type").and_then(Value::as_str) == Some("movie")
                && item.get("title").and_then(Value::as_str) == Some("Arrival 2016")
        ));
        let show = items
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("tv"))
            .expect("show item");
        assert_eq!(
            show.get("title").and_then(Value::as_str),
            Some("Slow Horses")
        );
        assert_eq!(
            show.get("episodeFiles")
                .and_then(Value::as_array)
                .and_then(|files| files.first())
                .and_then(|file| file.get("episode"))
                .and_then(Value::as_u64),
            Some(1)
        );
    }

    #[test]
    fn tv_scan_treats_library_root_as_container_of_shows() {
        let dir = tempfile::tempdir().unwrap();
        for show_name in ["Severance", "Silo"] {
            let season_dir = dir.path().join(show_name).join("Season 1");
            fs::create_dir_all(&season_dir).unwrap();
            fs::write(season_dir.join(format!("{show_name}.S01E01.mkv")), b"").unwrap();
        }

        let items = scan_folder(dir.path(), "tv");
        let titles = items
            .iter()
            .filter_map(|item| item.get("title").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(items.len(), 2);
        assert!(titles.contains(&"Severance"));
        assert!(titles.contains(&"Silo"));
    }

    #[test]
    fn tv_show_structure_matches_electron_episode_shape() {
        let dir = tempfile::tempdir().unwrap();
        let show_dir = dir.path().join("The Bear");
        fs::create_dir_all(show_dir.join("Season 01")).unwrap();
        fs::create_dir_all(show_dir.join("Season 02")).unwrap();
        fs::create_dir_all(show_dir.join("Extras")).unwrap();
        fs::write(show_dir.join("Season 01").join("The.Bear.S01E02.mkv"), b"").unwrap();
        fs::write(show_dir.join("Season 01").join("The.Bear.S01E01.mkv"), b"").unwrap();
        fs::write(show_dir.join("Season 02").join("Episode 3.mp4"), b"").unwrap();
        fs::write(
            show_dir.join("Extras").join("Behind.The.Scenes.S01E99.mkv"),
            b"",
        )
        .unwrap();

        let show = build_show_item(&show_dir, "tv").expect("show item");

        assert_eq!(show["type"], json!("tv"));
        assert_eq!(
            show["seasons"],
            json!([
                { "number": 1, "title": "Season 01", "episodeCount": 2 },
                { "number": 2, "title": "Season 02", "episodeCount": 1 }
            ])
        );
        assert_eq!(show["episodeFiles"][0]["episode"], json!(1));
        assert_eq!(show["episodeFiles"][1]["episode"], json!(2));
        assert_eq!(show["episodeFiles"][2]["season"], json!(2));
        assert_eq!(show["episodeFiles"][2]["episode"], json!(3));
        assert_eq!(show["episodes"][0]["number"], json!(1));
        assert_eq!(show["episodes"][2]["season"], json!(2));
    }

    #[test]
    fn anime_structure_uses_trailing_episode_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let anime_dir = dir.path().join("Frieren Beyond Journey's End");
        fs::create_dir_all(&anime_dir).unwrap();
        fs::write(anime_dir.join("[SubsPlease] Frieren - 02.mkv"), b"").unwrap();
        fs::write(anime_dir.join("[SubsPlease] Frieren - 01.mkv"), b"").unwrap();

        let show = build_show_item(&anime_dir, "anime").expect("anime item");

        assert_eq!(show["type"], json!("anime"));
        assert_eq!(show["seasons"][0]["number"], json!(1));
        assert_eq!(show["seasons"][0]["episodeCount"], json!(2));
        assert_eq!(show["episodeFiles"][0]["episode"], json!(1));
        assert_eq!(show["episodeFiles"][1]["episode"], json!(2));
        assert_eq!(show["episodes"][0]["number"], json!(1));
    }
}

fn main() {
    Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            apply_runtime_app_icon(&app_handle);
            if let Err(error) = database::initialize(&app_data_dir(&app_handle)) {
                eprintln!("LoomTV database initialization error: {error}");
            }
            start_media_server(app_handle.clone());
            spawn_artwork_prewarm(&app_handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_get,
            library_scan,
            library_add_folder,
            library_remove_folder,
            media_play,
            media_get_stream_url,
            media_get_thumbnail,
            media_get_subtitle_url,
            media_get_file_info,
            media_get_server_port,
            settings_get,
            settings_save,
            metadata_test_keys,
            network_status,
            network_discover_peers,
            network_revoke_paired_device,
            network_set_device_name,
            progress_get,
            progress_save,
            progress_import,
            artwork_get,
            artwork_save,
            artwork_official_candidates,
            artwork_apply_official,
            artwork_refresh_official,
            artwork_playback_logo,
            artwork_import,
            database_backup,
            database_clear,
            shell_open_external,
            ffmpeg_available,
            updates_get_state,
            updates_check,
            updates_install,
            media_probe,
            media_can_direct_play,
            media_start_transcode,
            media_stop_transcode,
        ])
        .run(loomtv_context())
        .expect("error while running tauri application");
}
