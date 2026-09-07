use crate::{now, Error, Result, Store};
use chrono::{FixedOffset, Local, NaiveDate, TimeZone};
use flate2::read::GzDecoder;
use regex::Regex;
use reqwest::{header::HeaderValue, Client, Method, Response, StatusCode};
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    collections::{hash_map::Entry, BTreeMap, HashMap, HashSet},
    io::Read,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{oneshot, Mutex, Semaphore};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use url::{Host, Url};

const MAX_IPTV_SOURCES: i64 = 12;
const MAX_CHANNEL_PAGE: usize = 200;
const MAX_PLAYLIST_CHANNELS: usize = 20_000;
const MAX_GUIDE_PROGRAMMES: usize = 200_000;
const MAX_FIELD_CHARS: usize = 400;
const MAX_TITLE_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 1_000;
const MAX_URL_CHARS: usize = 2_048;
const MAX_SOURCE_NAME_CHARS: usize = 60;
const MAX_SOURCE_ID_CHARS: usize = 120;
const MAX_SEARCH_CHARS: usize = 200;
const MAX_SEARCH_TERMS: usize = 8;
const PLAYLIST_MAX_BYTES: usize = 24 * 1024 * 1024;
const GUIDE_MAX_BYTES: usize = 64 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const FETCH_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_CONCURRENCY: usize = 4;
const MAX_REDIRECTS: usize = 2;

const ICON_IDS: &[&str] = &[
    "general",
    "entertainment",
    "news",
    "sports",
    "movies",
    "series",
    "music",
    "kids",
    "documentary",
    "education",
    "lifestyle",
    "travel",
    "cooking",
    "science",
    "religious",
    "weather",
];

type RefreshWaiters = HashMap<String, Vec<oneshot::Sender<Result<Value>>>>;

#[derive(Clone)]
pub struct IptvService {
    store: Arc<Mutex<Store>>,
    fetch_permits: Arc<Semaphore>,
    refresh_waiters: Arc<Mutex<RefreshWaiters>>,
}

#[derive(Clone)]
struct SourceRecord {
    id: String,
    name: String,
    icon_id: String,
    playlist_url: String,
    epg_url: String,
    channel_count: i64,
    programme_count: i64,
    skipped_insecure: i64,
    skipped_malformed: i64,
    refreshed_at: i64,
    refresh_error: String,
}

struct ParsedPlaylist {
    epg_url: String,
    channels: Vec<ParsedChannel>,
    skipped_insecure: usize,
    skipped_malformed: usize,
    skipped_duplicate: usize,
}

struct ParsedChannel {
    channel_id: String,
    name: String,
    tvg_id: String,
    tvg_name: String,
    logo_url: String,
    group_title: String,
    is_geo_blocked: bool,
    stream_url: String,
    search_text: String,
}

struct ParsedProgramme {
    tvg_id: String,
    start_ms: i64,
    end_ms: i64,
    title: String,
    description: String,
}

struct ChannelRequest {
    source_id: String,
    query: String,
    group: String,
    subcategory: String,
    geo_filter: String,
    sort: String,
    limit: usize,
    offset: usize,
}

struct ChannelFilter {
    clause: String,
    values: Vec<rusqlite::types::Value>,
}

impl IptvService {
    pub fn new(store: Arc<Mutex<Store>>) -> Self {
        Self {
            store,
            fetch_permits: Arc::new(Semaphore::new(FETCH_CONCURRENCY)),
            refresh_waiters: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn list_sources(&self) -> Result<Value> {
        let store = self.store.lock().await;
        store.require_active(None)?;
        list_source_summaries(&store)
    }

    pub async fn add_source(&self, input: &Value) -> Result<Value> {
        let input = input
            .as_object()
            .ok_or_else(|| invalid("Live TV source settings must be an object."))?;
        let name = truncate(required_text(input, "name", 120)?, MAX_SOURCE_NAME_CHARS);
        let playlist_url = normalize_iptv_url(
            required_text(input, "playlistUrl", MAX_URL_CHARS)?,
            "playlist",
        )?;
        let epg_url = match optional_text(input, "epgUrl", MAX_URL_CHARS)? {
            Some(value) if !value.trim().is_empty() => normalize_iptv_url(value, "guide")?,
            _ => String::new(),
        };
        let icon_id = optional_icon(input)?.unwrap_or("general");
        let source_id = uuid::Uuid::new_v4().to_string();

        {
            let store = self.store.lock().await;
            store.require_owner()?;
            let count: i64 =
                store
                    .db
                    .query_row("SELECT COUNT(*) FROM iptv_sources", [], |row| row.get(0))?;
            if count >= MAX_IPTV_SOURCES {
                return Err(iptv_error(format!(
                    "You can add up to {MAX_IPTV_SOURCES} live TV sources."
                )));
            }
            if source_by_playlist_url(&store, &playlist_url)?.is_some() {
                return Err(iptv_error("That playlist has already been added."));
            }
            let created_at = now();
            store.db.execute(
                "INSERT INTO iptv_sources \
                 (id,name,icon_id,playlist_url,epg_url,sort_order,created_at,updated_at) \
                 VALUES (?,?,?,?,?,?,?,?)",
                params![
                    source_id,
                    name,
                    icon_id,
                    playlist_url,
                    epg_url,
                    count,
                    created_at,
                    created_at,
                ],
            )?;
        }

        if let Err(error) = self.queue_refresh(source_id).await {
            if !error.code.starts_with("iptv_") {
                return Err(error);
            }
        }
        self.list_sources().await
    }

    pub async fn update_source(&self, source_id: &str, patch: &Value) -> Result<Value> {
        let source_id = validate_source_id(source_id)?;
        let patch = patch
            .as_object()
            .ok_or_else(|| invalid("Live TV source changes must be an object."))?;
        let store = self.store.lock().await;
        store.require_owner()?;
        let existing = source_by_id(&store, source_id)?
            .ok_or_else(|| iptv_error("That live TV source no longer exists."))?;

        let name = match optional_text(patch, "name", 120)? {
            Some(value) if !value.trim().is_empty() => {
                truncate(value.trim(), MAX_SOURCE_NAME_CHARS)
            }
            _ => existing.name.clone(),
        };
        let playlist_url = match optional_text(patch, "playlistUrl", MAX_URL_CHARS)? {
            Some(value) => normalize_iptv_url(value, "playlist")?,
            None => existing.playlist_url.clone(),
        };
        if playlist_url != existing.playlist_url {
            if source_by_playlist_url(&store, &playlist_url)?
                .is_some_and(|source| source.id != source_id)
            {
                return Err(iptv_error("That playlist has already been added."));
            }
        }
        let epg_url = match optional_text(patch, "epgUrl", MAX_URL_CHARS)? {
            Some(value) if value.trim().is_empty() => String::new(),
            Some(value) => normalize_iptv_url(value, "guide")?,
            None => existing.epg_url,
        };
        let icon_id = optional_icon(patch)?
            .map(str::to_owned)
            .unwrap_or(existing.icon_id);
        store.db.execute(
            "UPDATE iptv_sources SET name=?,playlist_url=?,epg_url=?,icon_id=?,updated_at=? WHERE id=?",
            params![name, playlist_url, epg_url, icon_id, now(), source_id],
        )?;
        list_source_summaries(&store)
    }

    pub async fn remove_source(&self, source_id: &str) -> Result<Value> {
        let source_id = validate_source_id(source_id)?;
        let mut store = self.store.lock().await;
        store.require_owner()?;
        let transaction = store.db.transaction()?;
        transaction.execute("DELETE FROM iptv_programmes WHERE source_id=?", [source_id])?;
        transaction.execute("DELETE FROM iptv_channels WHERE source_id=?", [source_id])?;
        transaction.execute("DELETE FROM iptv_sources WHERE id=?", [source_id])?;
        transaction.commit()?;
        list_source_summaries(&store)
    }

    pub async fn refresh_source(&self, source_id: &str) -> Result<Value> {
        let source_id = validate_source_id(source_id)?.to_owned();
        {
            let store = self.store.lock().await;
            store.require_owner()?;
            if source_by_id(&store, &source_id)?.is_none() {
                return Err(iptv_error("That live TV source no longer exists."));
            }
        }
        self.queue_refresh(source_id).await?;
        self.list_sources().await
    }

    pub async fn list_channels(&self, request: &Value) -> Result<Value> {
        let request = parse_channel_request(request)?;
        let store = self.store.lock().await;
        store.require_active(None)?;
        let source = source_by_id(&store, &request.source_id)?
            .ok_or_else(|| iptv_error("That live TV source no longer exists."))?;
        channel_page(&store, &source, &request)
    }

    pub async fn channel_stream_url(
        &self,
        source_id: &str,
        channel_id: &str,
    ) -> Result<Option<String>> {
        let source_id = validate_source_id(source_id)?;
        let channel_id = validate_channel_id(channel_id)?;
        let store = self.store.lock().await;
        store.require_active(None)?;
        Ok(store
            .db
            .query_row(
                "SELECT stream_url FROM iptv_channels WHERE source_id=? AND channel_id=?",
                params![source_id, channel_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    async fn queue_refresh(&self, source_id: String) -> Result<Value> {
        let (sender, receiver) = oneshot::channel();
        let start = {
            let mut waiting = self.refresh_waiters.lock().await;
            match waiting.entry(source_id.clone()) {
                Entry::Occupied(mut entry) => {
                    entry.get_mut().push(sender);
                    false
                }
                Entry::Vacant(entry) => {
                    entry.insert(vec![sender]);
                    true
                }
            }
        };
        if start {
            let service = self.clone();
            tokio::spawn(async move {
                let result = service.refresh_job(&source_id).await;
                let waiters = service
                    .refresh_waiters
                    .lock()
                    .await
                    .remove(&source_id)
                    .unwrap_or_default();
                for waiter in waiters {
                    let _ = waiter.send(result.clone());
                }
            });
        }
        receiver.await.map_err(|_| {
            Error::new(
                "iptv_refresh_failed",
                "The live TV refresh stopped before it completed.",
            )
        })?
    }

    async fn refresh_job(&self, source_id: &str) -> Result<Value> {
        let result = self.refresh_inner(source_id).await;
        if let Err(error) = &result {
            let store = self.store.lock().await;
            let message = truncate(&error.message, 300);
            if source_by_id(&store, source_id)?.is_some() {
                store.db.execute(
                    "UPDATE iptv_sources SET refresh_error=?,updated_at=? WHERE id=?",
                    params![message, now(), source_id],
                )?;
            }
        }
        result
    }

    async fn refresh_inner(&self, source_id: &str) -> Result<Value> {
        let source = {
            let store = self.store.lock().await;
            source_by_id(&store, source_id)?
                .ok_or_else(|| iptv_error("That live TV source no longer exists."))?
        };

        let playlist_text = self
            .fetch_text(&source.playlist_url, PLAYLIST_MAX_BYTES)
            .await?;
        let playlist = tokio::task::spawn_blocking(move || parse_m3u_playlist(&playlist_text))
            .await
            .map_err(|_| iptv_error("The playlist could not be parsed."))?;
        if playlist.channels.is_empty() {
            return Err(if playlist.skipped_insecure > 0 {
                iptv_error(format!(
                    "Every channel in this playlist streams over plain HTTP, which LoomTV cannot open ({} skipped).",
                    playlist.skipped_insecure
                ))
            } else {
                iptv_error("That playlist contains no channels.")
            });
        }

        let known_channel_ids = playlist
            .channels
            .iter()
            .filter(|channel| !channel.tvg_id.is_empty())
            .map(|channel| channel.tvg_id.clone())
            .collect::<HashSet<_>>();
        let guide_url = if source.epg_url.is_empty() {
            playlist.epg_url.clone()
        } else {
            source.epg_url.clone()
        };
        {
            let mut store = self.store.lock().await;
            replace_channels(&mut store, source_id, &playlist.channels)?;
        }

        let programmes = if guide_url.is_empty() {
            Vec::new()
        } else {
            let guide_text = self.fetch_text(&guide_url, GUIDE_MAX_BYTES).await?;
            tokio::task::spawn_blocking(move || parse_xmltv_guide(&guide_text, &known_channel_ids))
                .await
                .map_err(|_| iptv_error("The programme guide could not be parsed."))?
        };
        let summary = {
            let mut store = self.store.lock().await;
            replace_programmes_and_record(
                &mut store,
                source_id,
                &programmes,
                &playlist,
                &guide_url,
            )?
        };
        Ok(summary)
    }

    async fn fetch_text(&self, url: &str, max_bytes: usize) -> Result<String> {
        let permit =
            tokio::time::timeout(FETCH_TIMEOUT, self.fetch_permits.clone().acquire_owned())
                .await
                .map_err(|_| iptv_error("Too many live TV downloads are in progress."))?
                .map_err(|_| iptv_error("The live TV download service is unavailable."))?;
        let url = parse_fetch_url(url)?;
        let bytes = tokio::time::timeout(
            FETCH_OPERATION_TIMEOUT,
            fetch_bytes_with_retry(url, max_bytes),
        )
        .await
        .map_err(|_| iptv_error("The live TV provider took too long to respond."))??;
        drop(permit);
        tokio::task::spawn_blocking(move || decode_provider_text(bytes, max_bytes))
            .await
            .map_err(|_| iptv_error("The live TV response could not be decoded."))?
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new("invalid_argument", message)
}

fn iptv_error(message: impl Into<String>) -> Error {
    Error::new("iptv_source_error", message)
}

fn required_text<'a>(input: &'a Map<String, Value>, key: &str, max: usize) -> Result<&'a str> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= max && !value.contains('\0'))
        .ok_or_else(|| invalid(format!("Live TV field {key} is invalid.")))?;
    Ok(value)
}

fn optional_text<'a>(
    input: &'a Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Option<&'a str>> {
    match input.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if value.chars().count() <= max && !value.contains('\0') => {
            Ok(Some(value))
        }
        Some(_) => Err(invalid(format!("Live TV field {key} is invalid."))),
    }
}

fn optional_icon(input: &Map<String, Value>) -> Result<Option<&str>> {
    match input.get("iconId") {
        None => Ok(None),
        Some(Value::String(value)) if ICON_IDS.contains(&value.as_str()) => Ok(Some(value)),
        Some(_) => Err(invalid("Choose a supported live TV source icon.")),
    }
}

fn validate_source_id(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_SOURCE_ID_CHARS || value.contains('\0') {
        return Err(invalid("The live TV source ID is invalid."));
    }
    Ok(value)
}

fn validate_channel_id(value: &str) -> Result<&str> {
    if value.is_empty() || value.chars().count() > MAX_URL_CHARS || value.contains('\0') {
        return Err(invalid("The live TV channel ID is invalid."));
    }
    Ok(value)
}

fn normalize_iptv_url(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(iptv_error(format!("Enter a {label} URL.")));
    }
    let url = Url::parse(value)
        .map_err(|_| iptv_error(format!("That {label} URL is not a valid address.")))?;
    if url.scheme() != "https" {
        return Err(iptv_error(format!(
            "{label} URLs must use https. LoomTV does not open plain-HTTP providers."
        )));
    }
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(iptv_error(format!(
            "That {label} URL is not a valid address."
        )));
    }
    Ok(url.to_string())
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn source_by_id(store: &Store, source_id: &str) -> Result<Option<SourceRecord>> {
    store
        .db
        .query_row(
            "SELECT id,name,icon_id,playlist_url,epg_url,channel_count,programme_count,\
             skipped_insecure,skipped_malformed,refreshed_at,refresh_error \
             FROM iptv_sources WHERE id=?",
            [source_id],
            source_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn source_by_playlist_url(store: &Store, url: &str) -> Result<Option<SourceRecord>> {
    store
        .db
        .query_row(
            "SELECT id,name,icon_id,playlist_url,epg_url,channel_count,programme_count,\
             skipped_insecure,skipped_malformed,refreshed_at,refresh_error \
             FROM iptv_sources WHERE playlist_url=?",
            [url],
            source_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRecord> {
    Ok(SourceRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        icon_id: row.get(2)?,
        playlist_url: row.get(3)?,
        epg_url: row.get(4)?,
        channel_count: row.get(5)?,
        programme_count: row.get(6)?,
        skipped_insecure: row.get(7)?,
        skipped_malformed: row.get(8)?,
        refreshed_at: row.get(9)?,
        refresh_error: row.get(10)?,
    })
}

fn list_source_summaries(store: &Store) -> Result<Value> {
    let mut statement = store.db.prepare(
        "SELECT id,name,icon_id,playlist_url,epg_url,channel_count,programme_count,\
         skipped_insecure,skipped_malformed,refreshed_at,refresh_error \
         FROM iptv_sources ORDER BY sort_order ASC,created_at ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "name": row.get::<_, String>(1)?,
            "iconId": row.get::<_, String>(2)?,
            "playlistUrl": row.get::<_, String>(3)?,
            "epgUrl": row.get::<_, String>(4)?,
            "channelCount": row.get::<_, i64>(5)?,
            "programmeCount": row.get::<_, i64>(6)?,
            "skippedInsecure": row.get::<_, i64>(7)?,
            "skippedMalformed": row.get::<_, i64>(8)?,
            "refreshedAt": row.get::<_, i64>(9)?,
            "refreshError": row.get::<_, String>(10)?,
        }))
    })?;
    Ok(Value::Array(
        rows.collect::<std::result::Result<Vec<_>, _>>()?,
    ))
}

fn source_summary(source: &SourceRecord) -> Value {
    json!({
        "id": source.id,
        "name": source.name,
        "iconId": source.icon_id,
        "playlistUrl": source.playlist_url,
        "epgUrl": source.epg_url,
        "channelCount": source.channel_count,
        "programmeCount": source.programme_count,
        "skippedInsecure": source.skipped_insecure,
        "skippedMalformed": source.skipped_malformed,
        "refreshedAt": source.refreshed_at,
        "refreshError": source.refresh_error,
    })
}

fn replace_channels(store: &mut Store, source_id: &str, channels: &[ParsedChannel]) -> Result<()> {
    if source_by_id(store, source_id)?.is_none() {
        return Err(iptv_error("That live TV source no longer exists."));
    }
    let transaction = store.db.transaction()?;
    transaction.execute("DELETE FROM iptv_channels WHERE source_id=?", [source_id])?;
    {
        let mut insert = transaction.prepare_cached(
            "INSERT INTO iptv_channels \
             (source_id,channel_id,position,name,tvg_id,tvg_name,logo_url,group_title,\
              is_geo_blocked,stream_url,search_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )?;
        for (position, channel) in channels.iter().enumerate() {
            insert.execute(params![
                source_id,
                channel.channel_id,
                position as i64,
                channel.name,
                channel.tvg_id,
                channel.tvg_name,
                channel.logo_url,
                channel.group_title,
                channel.is_geo_blocked,
                channel.stream_url,
                channel.search_text,
            ])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn replace_programmes_and_record(
    store: &mut Store,
    source_id: &str,
    programmes: &[ParsedProgramme],
    playlist: &ParsedPlaylist,
    guide_url: &str,
) -> Result<Value> {
    if source_by_id(store, source_id)?.is_none() {
        return Err(iptv_error("That live TV source no longer exists."));
    }
    let refreshed_at = now();
    let transaction = store.db.transaction()?;
    transaction.execute("DELETE FROM iptv_programmes WHERE source_id=?", [source_id])?;
    {
        let mut insert = transaction.prepare_cached(
            "INSERT OR REPLACE INTO iptv_programmes \
             (source_id,tvg_id,start_ms,end_ms,title,description) VALUES (?,?,?,?,?,?)",
        )?;
        for programme in programmes {
            insert.execute(params![
                source_id,
                programme.tvg_id,
                programme.start_ms,
                programme.end_ms,
                programme.title,
                programme.description,
            ])?;
        }
    }
    transaction.execute(
        "UPDATE iptv_sources SET channel_count=?,programme_count=?,skipped_insecure=?,\
         skipped_malformed=?,epg_url=?,refreshed_at=?,refresh_error='',updated_at=? WHERE id=?",
        params![
            playlist.channels.len() as i64,
            programmes.len() as i64,
            playlist.skipped_insecure as i64,
            (playlist.skipped_malformed + playlist.skipped_duplicate) as i64,
            guide_url,
            refreshed_at,
            refreshed_at,
            source_id,
        ],
    )?;
    transaction.commit()?;
    let source = source_by_id(store, source_id)?
        .ok_or_else(|| iptv_error("That live TV source no longer exists."))?;
    Ok(source_summary(&source))
}

fn parse_channel_request(value: &Value) -> Result<ChannelRequest> {
    let input = value
        .as_object()
        .ok_or_else(|| invalid("The live TV channel request must be an object."))?;
    let source_id =
        validate_source_id(required_text(input, "sourceId", MAX_SOURCE_ID_CHARS)?)?.to_owned();
    let query = optional_text(input, "query", MAX_SEARCH_CHARS)?
        .unwrap_or("")
        .to_owned();
    let group = optional_text(input, "group", MAX_FIELD_CHARS)?
        .unwrap_or("")
        .trim()
        .to_owned();
    let subcategory = optional_text(input, "subcategory", MAX_FIELD_CHARS)?
        .unwrap_or("")
        .trim()
        .to_owned();
    let geo_filter = enum_field(input, "geoFilter", &["all", "exclude", "only"], "all")?;
    let sort = enum_field(
        input,
        "sort",
        &["name-asc", "name-desc", "category"],
        "name-asc",
    )?;
    let limit = bounded_number(
        input,
        "limit",
        1.0,
        MAX_CHANNEL_PAGE as f64,
        MAX_CHANNEL_PAGE,
    )?;
    let offset = bounded_number(input, "offset", 0.0, 1_000_000.0, 0)?;
    Ok(ChannelRequest {
        source_id,
        query,
        group,
        subcategory,
        geo_filter,
        sort,
        limit,
        offset,
    })
}

fn enum_field(
    input: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
    default: &str,
) -> Result<String> {
    match input.get(key) {
        None => Ok(default.to_owned()),
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(value.clone()),
        Some(_) => Err(invalid(format!("Live TV field {key} is invalid."))),
    }
}

fn bounded_number(
    input: &Map<String, Value>,
    key: &str,
    minimum: f64,
    maximum: f64,
    default: usize,
) -> Result<usize> {
    match input.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite() && *value >= minimum && *value <= maximum)
            .map(|value| value.trunc() as usize)
            .ok_or_else(|| invalid(format!("Live TV field {key} is invalid."))),
    }
}

fn channel_filter(request: &ChannelRequest, first_parameter: usize) -> ChannelFilter {
    let mut values = vec![rusqlite::types::Value::Text(request.source_id.clone())];
    let mut clauses = vec![format!("c.source_id=?{first_parameter}")];
    let mut next = first_parameter + 1;
    for value in [&request.group, &request.subcategory] {
        if !value.is_empty() {
            clauses.push(format!(
                "instr(';'||lower(replace(c.group_title,' ',''))||';',';'||?{next}||';')>0"
            ));
            values.push(rusqlite::types::Value::Text(remove_whitespace(value)));
            next += 1;
        }
    }
    match request.geo_filter.as_str() {
        "exclude" => clauses.push("c.is_geo_blocked=0".to_owned()),
        "only" => clauses.push("c.is_geo_blocked=1".to_owned()),
        _ => {}
    }
    for term in search_terms(&request.query) {
        clauses.push(format!("c.search_text LIKE ?{next} ESCAPE '\\'"));
        values.push(rusqlite::types::Value::Text(format!(
            "%{}%",
            escape_like(&term)
        )));
        next += 1;
    }
    ChannelFilter {
        clause: clauses.join(" AND "),
        values,
    }
}

fn channel_page(store: &Store, source: &SourceRecord, request: &ChannelRequest) -> Result<Value> {
    let count_filter = channel_filter(request, 1);
    let total: i64 = store.db.query_row(
        &format!(
            "SELECT COUNT(*) FROM iptv_channels c WHERE {}",
            count_filter.clause
        ),
        params_from_iter(count_filter.values.iter()),
        |row| row.get(0),
    )?;

    let filter = channel_filter(request, 2);
    let limit_index = filter.values.len() + 2;
    let offset_index = limit_index + 1;
    let order = match request.sort.as_str() {
        "name-desc" => "c.name COLLATE NOCASE DESC,c.position ASC",
        "category" => "CASE WHEN c.group_title='' THEN 1 ELSE 0 END,c.group_title COLLATE NOCASE ASC,c.name COLLATE NOCASE ASC,c.position ASC",
        _ => "c.position ASC",
    };
    let sql = format!(
        "SELECT c.channel_id,c.name,c.logo_url,c.group_title,c.stream_url,\
         now_p.title,now_p.start_ms,now_p.end_ms,next_p.title,next_p.start_ms \
         FROM iptv_channels c \
         LEFT JOIN iptv_programmes now_p ON now_p.rowid=(SELECT p.rowid FROM iptv_programmes p \
           WHERE p.source_id=c.source_id AND p.tvg_id=c.tvg_id AND p.start_ms<=?1 AND p.end_ms>?1 \
           ORDER BY p.start_ms DESC LIMIT 1) \
         LEFT JOIN iptv_programmes next_p ON next_p.rowid=(SELECT p.rowid FROM iptv_programmes p \
           WHERE p.source_id=c.source_id AND p.tvg_id=c.tvg_id AND p.start_ms>?1 \
           ORDER BY p.start_ms ASC LIMIT 1) \
         WHERE {} ORDER BY {order} LIMIT ?{limit_index} OFFSET ?{offset_index}",
        filter.clause
    );
    let mut values = vec![rusqlite::types::Value::Integer(now())];
    values.extend(filter.values);
    values.push(rusqlite::types::Value::Integer(request.limit as i64));
    values.push(rusqlite::types::Value::Integer(request.offset as i64));
    let mut statement = store.db.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values.iter()), |row| {
        Ok(json!({
            "channelId": row.get::<_, String>(0)?,
            "name": row.get::<_, String>(1)?,
            "logoUrl": row.get::<_, String>(2)?,
            "groupTitle": row.get::<_, String>(3)?,
            "streamUrl": row.get::<_, String>(4)?,
            "nowTitle": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "nowStartMs": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            "nowEndMs": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            "nextTitle": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            "nextStartMs": row.get::<_, Option<i64>>(9)?.unwrap_or(0),
        }))
    })?;
    let channels = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(json!({
        "sourceId": source.id,
        "sourceName": source.name,
        "channels": channels,
        "total": total,
        "offset": request.offset,
        "groups": grouped_tags(store, &source.id, None)?,
        "subcategories": if request.group.is_empty() { Vec::<Value>::new() } else { grouped_tags(store, &source.id, Some(&request.group))? },
        "refreshedAt": source.refreshed_at,
        "refreshError": source.refresh_error,
    }))
}

fn grouped_tags(
    store: &Store,
    source_id: &str,
    selected_group: Option<&str>,
) -> Result<Vec<Value>> {
    let mut statement = store.db.prepare(
        "SELECT group_title,COUNT(*) FROM iptv_channels \
         WHERE source_id=? AND group_title<>'' GROUP BY group_title ORDER BY group_title COLLATE NOCASE",
    )?;
    let rows = statement.query_map([source_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let selected_key = selected_group.map(remove_whitespace);
    let mut groups: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for row in rows {
        let (title, count) = row?;
        let names = title
            .split(';')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>();
        if let Some(selected) = &selected_key {
            if !names
                .iter()
                .any(|name| remove_whitespace(name) == *selected)
            {
                continue;
            }
        }
        for name in names {
            let key = if selected_key.is_some() {
                remove_whitespace(name)
            } else {
                name.to_lowercase()
            };
            if selected_key.as_ref() == Some(&key) {
                continue;
            }
            groups
                .entry(key)
                .and_modify(|entry| entry.1 += count)
                .or_insert_with(|| (name.to_owned(), count));
        }
    }
    let mut values = groups
        .into_values()
        .map(|(name, count)| json!({"name":name,"channelCount":count}))
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&right["name"].as_str().unwrap_or("").to_lowercase())
    });
    Ok(values)
}

fn remove_whitespace(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn normalize_search_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut space = true;
    for character in value
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
    {
        for character in character.to_lowercase() {
            if character.is_ascii_alphanumeric() {
                normalized.push(character);
                space = false;
            } else if !space {
                normalized.push(' ');
                space = true;
            }
        }
    }
    normalized.trim().to_owned()
}

fn search_terms(query: &str) -> Vec<String> {
    let query = truncate(query, MAX_SEARCH_CHARS);
    let mut seen = HashSet::new();
    normalize_search_text(&query)
        .split_whitespace()
        .filter(|term| seen.insert((*term).to_owned()))
        .take(MAX_SEARCH_TERMS)
        .map(str::to_owned)
        .collect()
}

fn parse_m3u_playlist(text: &str) -> ParsedPlaylist {
    let mut playlist = ParsedPlaylist {
        epg_url: String::new(),
        channels: Vec::new(),
        skipped_insecure: 0,
        skipped_malformed: 0,
        skipped_duplicate: 0,
    };
    let mut seen_urls = HashSet::new();
    let mut used_ids = HashSet::new();
    let mut pending: Option<(HashMap<String, String>, String)> = None;
    let mut current_group = String::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXTM3U") {
            let attributes = parse_attributes(line);
            let declared = attributes
                .get("x-tvg-url")
                .or_else(|| attributes.get("url-tvg"))
                .map(String::as_str)
                .unwrap_or("");
            if let Some(first) = declared.split(',').next().map(str::trim) {
                if is_https_url(first) {
                    playlist.epg_url = Url::parse(first)
                        .map(|url| url.to_string())
                        .unwrap_or_default();
                }
            }
            continue;
        }
        if line.starts_with("#EXTINF") {
            if pending.is_some() {
                playlist.skipped_malformed += 1;
            }
            let (header, title) = split_extinf(line);
            pending = Some((parse_attributes(header), trim_field(title)));
            continue;
        }
        if line.starts_with("#EXTGRP") {
            current_group = trim_field(line.split_once(':').map(|(_, value)| value).unwrap_or(""));
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((attributes, title)) = pending.take() else {
            continue;
        };
        if playlist.channels.len() >= MAX_PLAYLIST_CHANNELS {
            break;
        }
        let stream_url = truncate(line, MAX_URL_CHARS + 1);
        if !is_https_url(&stream_url) {
            if Url::parse(&stream_url).is_ok_and(|url| url.scheme() == "http") {
                playlist.skipped_insecure += 1;
            } else {
                playlist.skipped_malformed += 1;
            }
            continue;
        }
        if !seen_urls.insert(stream_url.clone()) {
            playlist.skipped_duplicate += 1;
            continue;
        }
        let tvg_id = trim_field(attributes.get("tvg-id").map(String::as_str).unwrap_or(""));
        let tvg_name = trim_field(attributes.get("tvg-name").map(String::as_str).unwrap_or(""));
        let group_title = {
            let value = trim_field(
                attributes
                    .get("group-title")
                    .map(String::as_str)
                    .unwrap_or(""),
            );
            if value.is_empty() {
                current_group.clone()
            } else {
                value
            }
        };
        let name = if !title.is_empty() {
            title
        } else if !tvg_name.is_empty() {
            tvg_name.clone()
        } else if !tvg_id.is_empty() {
            tvg_id.clone()
        } else {
            "Untitled channel".to_owned()
        };
        let base_id = if tvg_id.is_empty() {
            format!("url:{stream_url}")
        } else {
            tvg_id.clone()
        };
        let channel_id = unique_channel_id(&base_id, &mut used_ids);
        let logo_url = attributes
            .get("tvg-logo")
            .filter(|value| is_https_url(value))
            .map(|value| truncate(value, MAX_URL_CHARS))
            .unwrap_or_default();
        let declared_geo = attributes
            .get("geo-blocked")
            .or_else(|| attributes.get("geoblocked"))
            .or_else(|| attributes.get("label"))
            .map(String::as_str)
            .unwrap_or("");
        let is_geo_blocked = geo_title_pattern().is_match(&name)
            || matches!(
                declared_geo.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "geo-blocked" | "geo blocked"
            );
        let search_text =
            normalize_search_text(&format!("{name} {group_title} {tvg_name} {tvg_id}"));
        playlist.channels.push(ParsedChannel {
            channel_id,
            name,
            tvg_id,
            tvg_name,
            logo_url,
            group_title,
            is_geo_blocked,
            stream_url,
            search_text,
        });
    }
    if pending.is_some() {
        playlist.skipped_malformed += 1;
    }
    playlist
}

fn attribute_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r#"([A-Za-z0-9_-]+)\s*=\s*"([^"]*)""#).unwrap())
}

fn geo_title_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)\[\s*geo[- ]blocked\s*\]").unwrap())
}

fn parse_attributes(value: &str) -> HashMap<String, String> {
    attribute_pattern()
        .captures_iter(value)
        .map(|capture| (capture[1].to_ascii_lowercase(), capture[2].to_owned()))
        .collect()
}

fn split_extinf(line: &str) -> (&str, &str) {
    let mut quoted = false;
    for (index, character) in line.char_indices() {
        if character == '"' {
            quoted = !quoted;
        } else if character == ',' && !quoted {
            return (&line[..index], &line[index + 1..]);
        }
    }
    (line, "")
}

fn trim_field(value: &str) -> String {
    truncate(value.trim(), MAX_FIELD_CHARS)
}

fn unique_channel_id(base: &str, used: &mut HashSet<String>) -> String {
    let base = truncate(base, MAX_URL_CHARS);
    if used.insert(base.clone()) {
        return base;
    }
    for suffix in 2..=MAX_PLAYLIST_CHANNELS + 1 {
        let suffix = format!("#{suffix}");
        let prefix = truncate(&base, MAX_URL_CHARS.saturating_sub(suffix.chars().count()));
        let candidate = format!("{prefix}{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    String::new()
}

fn is_https_url(value: &str) -> bool {
    value.chars().count() <= MAX_URL_CHARS
        && Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn parse_xmltv_guide(text: &str, known_ids: &HashSet<String>) -> Vec<ParsedProgramme> {
    let mut programmes = Vec::new();
    for capture in programme_pattern().captures_iter(text) {
        if programmes.len() >= MAX_GUIDE_PROGRAMMES {
            break;
        }
        let attributes = parse_attributes(&capture[1]);
        let tvg_id = attributes
            .get("channel")
            .map(|value| decode_xml(value).trim().to_owned())
            .unwrap_or_default();
        if tvg_id.is_empty() || !known_ids.contains(&tvg_id) {
            continue;
        }
        let Some(start_ms) = attributes
            .get("start")
            .and_then(|value| parse_xmltv_timestamp(value))
        else {
            continue;
        };
        let Some(end_ms) = attributes
            .get("stop")
            .and_then(|value| parse_xmltv_timestamp(value))
        else {
            continue;
        };
        let body = &capture[2];
        let title = truncate(&child_text(body, title_pattern()), MAX_TITLE_CHARS);
        if end_ms <= start_ms || title.is_empty() {
            continue;
        }
        programmes.push(ParsedProgramme {
            tvg_id,
            start_ms,
            end_ms,
            title,
            description: truncate(
                &child_text(body, description_pattern()),
                MAX_DESCRIPTION_CHARS,
            ),
        });
    }
    programmes
}

fn programme_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?is)<programme\b([^>]*)>(.*?)</programme>").unwrap())
}

fn title_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?is)<title(?:\s[^>]*)?>(.*?)</title>").unwrap())
}

fn description_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?is)<desc(?:\s[^>]*)?>(.*?)</desc>").unwrap())
}

fn tag_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?s)<[^>]*>").unwrap())
}

fn entity_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);").unwrap())
}

fn child_text(body: &str, pattern: &Regex) -> String {
    let Some(capture) = pattern.captures(body) else {
        return String::new();
    };
    let without_tags = tag_pattern().replace_all(&capture[1], "");
    decode_xml(&without_tags)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_xml(value: &str) -> String {
    entity_pattern()
        .replace_all(value, |capture: &regex::Captures<'_>| {
            let entity = &capture[1];
            let decoded = if entity.starts_with("#x") || entity.starts_with("#X") {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            } else if let Some(decimal) = entity.strip_prefix('#') {
                decimal.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match entity.to_ascii_lowercase().as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ => None,
                }
            };
            decoded
                .filter(|character| *character != '\0')
                .map(|character| character.to_string())
                .unwrap_or_else(|| capture[0].to_owned())
        })
        .into_owned()
}

fn timestamp_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$").unwrap()
    })
}

fn parse_xmltv_timestamp(value: &str) -> Option<i64> {
    let capture = timestamp_pattern().captures(value.trim())?;
    let number = |index: usize| capture.get(index)?.as_str().parse::<u32>().ok();
    let date = NaiveDate::from_ymd_opt(number(1)? as i32, number(2)?, number(3)?)?;
    let datetime = date.and_hms_opt(number(4)?, number(5)?, number(6).unwrap_or(0))?;
    match capture.get(7).map(|value| value.as_str()) {
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let hours = offset[1..3].parse::<i32>().ok()?;
            let minutes = offset[3..5].parse::<i32>().ok()?;
            if minutes > 59 {
                return None;
            }
            let zone = FixedOffset::east_opt(sign * (hours * 3_600 + minutes * 60))?;
            zone.from_local_datetime(&datetime)
                .single()
                .map(|value| value.timestamp_millis())
        }
        None => Local
            .from_local_datetime(&datetime)
            .earliest()
            .map(|value| value.timestamp_millis()),
    }
}

async fn fetch_bytes_with_retry(url: Url, max_bytes: usize) -> Result<Vec<u8>> {
    for attempt in 0..=1 {
        let (status, bytes) = fetch_attempt(url.clone(), max_bytes).await?;
        if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt == 0 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        if !status.is_success() {
            return Err(iptv_error(format!(
                "The provider answered {}.",
                status.as_u16()
            )));
        }
        return Ok(bytes);
    }
    Err(iptv_error("The live TV provider request failed."))
}

async fn fetch_attempt(mut url: Url, max_bytes: usize) -> Result<(StatusCode, Vec<u8>)> {
    for redirects in 0..=MAX_REDIRECTS {
        let response = pinned_get(url.clone()).await?;
        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(iptv_error(
                    "The live TV provider redirected too many times.",
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| iptv_error("The live TV provider returned an invalid redirect."))?;
            url = parse_fetch_url(
                url.join(location)
                    .map_err(|_| iptv_error("The live TV provider returned an invalid redirect."))?
                    .as_str(),
            )?;
            continue;
        }
        let status = response.status();
        let bytes = read_bounded(response, max_bytes).await?;
        return Ok((status, bytes));
    }
    Err(iptv_error(
        "The live TV provider redirected too many times.",
    ))
}

async fn pinned_get(url: Url) -> Result<Response> {
    pinned_request(url, Method::GET, None, FETCH_TIMEOUT, Some(FETCH_TIMEOUT)).await
}

pub(crate) async fn pinned_request(
    url: Url,
    method: Method,
    range: Option<HeaderValue>,
    io_timeout: Duration,
    request_deadline: Option<Duration>,
) -> Result<Response> {
    let hostname = url
        .host_str()
        .ok_or_else(|| iptv_error("The live TV provider address is invalid."))?;
    let addresses = resolve_public_addresses(&url, io_timeout).await?;
    let mut client = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(io_timeout)
        .read_timeout(io_timeout)
        .pool_max_idle_per_host(0)
        .resolve_to_addrs(hostname, &addresses);
    if let Some(deadline) = request_deadline {
        client = client.timeout(deadline);
    }
    let client = client
        .build()
        .map_err(|_| iptv_error("The live TV provider request failed."))?;
    let mut request = client
        .request(method, url)
        .header(reqwest::header::ACCEPT, "*/*");
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    request
        .send()
        .await
        .map_err(|_| iptv_error("The live TV provider request failed."))
}

pub(crate) fn parse_fetch_url(value: &str) -> Result<Url> {
    if value.chars().count() > MAX_URL_CHARS {
        return Err(iptv_error("The live TV provider address is too long."));
    }
    let url =
        Url::parse(value).map_err(|_| iptv_error("The live TV provider address is invalid."))?;
    if url.scheme() != "https"
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(iptv_error("The live TV provider address is not allowed."));
    }
    Ok(url)
}

async fn resolve_public_addresses(url: &Url, timeout: Duration) -> Result<Vec<SocketAddr>> {
    let port = url.port_or_known_default().unwrap_or(443);
    let mut addresses = match url.host() {
        Some(Host::Ipv4(address)) => vec![SocketAddr::new(IpAddr::V4(address), port)],
        Some(Host::Ipv6(address)) => vec![SocketAddr::new(IpAddr::V6(address), port)],
        Some(Host::Domain(hostname)) => {
            tokio::time::timeout(timeout, tokio::net::lookup_host((hostname, port)))
                .await
                .map_err(|_| iptv_error("The live TV provider address could not be resolved."))?
                .map_err(|_| iptv_error("The live TV provider address could not be resolved."))?
                .collect()
        }
        None => Vec::new(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| !is_public(address.ip())) {
        return Err(iptv_error(
            "The live TV provider resolved to a private or reserved address.",
        ));
    }
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
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
        IpAddr::V6(address) => {
            ipv6_prefix(address, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && !ipv6_prefix(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
                && !ipv6_prefix(address, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
                && !ipv6_prefix(address, Ipv6Addr::new(0x3ffe, 0, 0, 0, 0, 0, 0, 0), 16)
        }
    }
}

fn ipv6_prefix(address: Ipv6Addr, network: Ipv6Addr, bits: u32) -> bool {
    let shift = 128 - bits;
    (u128::from(address) >> shift) == (u128::from(network) >> shift)
}

pub(crate) async fn read_bounded(mut response: Response, max_bytes: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(iptv_error("The live TV provider response is too large."));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| iptv_error("The live TV provider request failed."))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(iptv_error("The live TV provider response is too large."));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn decode_provider_text(bytes: Vec<u8>, max_bytes: usize) -> Result<String> {
    let decoded = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes.as_slice()).take(max_bytes as u64 + 1);
        let mut output = Vec::new();
        decoder
            .read_to_end(&mut output)
            .map_err(|_| iptv_error("The compressed live TV response is invalid."))?;
        if output.len() > max_bytes {
            return Err(iptv_error(
                "The decompressed live TV response is too large.",
            ));
        }
        output
    } else {
        bytes
    };
    Ok(String::from_utf8_lossy(&decoded).into_owned())
}
