use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub type JsonValue = Value;

#[derive(Clone, Debug)]
struct StoredProgress {
    position: f64,
    duration: f64,
    updated_at: u64,
    watched: bool,
}

pub fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join("loomtv.sqlite")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

fn json_string(value: &JsonValue) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn json_parse(value: Option<String>, fallback: JsonValue) -> JsonValue {
    value
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(fallback)
}

fn durable_artwork_source(source: Option<&str>) -> String {
    source
        .map(str::trim)
        .filter(|value| !value.to_ascii_lowercase().starts_with("data:"))
        .unwrap_or("")
        .to_string()
}

fn durable_artwork_sources(value: Option<&JsonValue>) -> JsonValue {
    let mut sources = Vec::new();
    if let Some(values) = value.and_then(Value::as_array) {
        for source in values.iter().filter_map(Value::as_str) {
            let durable = durable_artwork_source(Some(source));
            if !durable.is_empty()
                && !sources
                    .iter()
                    .any(|entry: &JsonValue| entry.as_str() == Some(&durable))
            {
                sources.push(json!(durable));
            }
        }
    }
    json!(sources)
}

pub fn library_default() -> JsonValue {
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

fn open(data_dir: &Path) -> rusqlite::Result<Connection> {
    let _ = fs::create_dir_all(data_dir);
    let conn = Connection::open(database_path(data_dir))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS library_folders (
          path TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime', 'others')),
          added_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('movie', 'tv', 'anime')),
          title TEXT NOT NULL,
          year INTEGER NOT NULL DEFAULT 0,
          poster TEXT NOT NULL DEFAULT '',
          backdrop TEXT NOT NULL DEFAULT '',
          logo TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          rating REAL NOT NULL DEFAULT 0,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          last_played INTEGER,
          genres_json TEXT NOT NULL DEFAULT '[]',
          cast_json TEXT NOT NULL DEFAULT '[]',
          subtitles_json TEXT NOT NULL DEFAULT '[]',
          local_metadata_json TEXT,
          provider_ids_json TEXT,
          poster_candidates_json TEXT NOT NULL DEFAULT '[]',
          backdrop_candidates_json TEXT NOT NULL DEFAULT '[]',
          logo_candidates_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);
        CREATE INDEX IF NOT EXISTS idx_media_items_file_path ON media_items(file_path);

        CREATE TABLE IF NOT EXISTS seasons (
          media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          episode_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (media_id, number)
        );

        CREATE TABLE IF NOT EXISTS episodes (
          media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
          season INTEGER NOT NULL,
          number INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          still TEXT NOT NULL DEFAULT '',
          rating REAL NOT NULL DEFAULT 0,
          air_date TEXT NOT NULL DEFAULT '',
          local_metadata_json TEXT,
          PRIMARY KEY (media_id, season, number)
        );

        CREATE TABLE IF NOT EXISTS episode_files (
          media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
          season INTEGER NOT NULL,
          episode INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          title TEXT,
          local_metadata_json TEXT,
          PRIMARY KEY (media_id, season, episode, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_episode_files_file_path ON episode_files(file_path);

        CREATE TABLE IF NOT EXISTS scan_cache (
          folder_path TEXT PRIMARY KEY,
          version INTEGER,
          folder_kind TEXT NOT NULL,
          signature TEXT NOT NULL,
          file_count INTEGER NOT NULL DEFAULT 0,
          item_count INTEGER NOT NULL DEFAULT 0,
          scanned_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playback_progress (
          file_path TEXT PRIMARY KEY,
          position REAL NOT NULL DEFAULT 0,
          duration REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          watched INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS custom_artwork (
          media_id TEXT NOT NULL,
          target TEXT NOT NULL,
          data_url TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (media_id, target)
        );

        CREATE TABLE IF NOT EXISTS artwork_cache (
          source_url TEXT PRIMARY KEY,
          data_url TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )?;
    Ok(())
}

pub fn initialize(data_dir: &Path) -> rusqlite::Result<()> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    Ok(())
}

fn read_json(path: &Path, fallback: JsonValue) -> JsonValue {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or(fallback)
}

fn has_library_data(conn: &Connection) -> rusqlite::Result<bool> {
    let media_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM media_items", [], |row| row.get(0))?;
    let folder_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM library_folders", [], |row| row.get(0))?;
    Ok(media_count > 0 || folder_count > 0)
}

fn migrate_json_if_needed(data_dir: &Path, conn: &Connection) -> rusqlite::Result<()> {
    if !has_library_data(conn)? {
        let path = data_dir.join("library.json");
        if path.exists() {
            save_library_with_connection(conn, &read_json(&path, library_default()))?;
        }
    }
    let settings_exists: Option<i64> = conn
        .query_row("SELECT id FROM app_settings WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()?;
    if settings_exists.is_none() {
        let path = data_dir.join("settings.json");
        if path.exists() {
            save_settings_with_connection(conn, &read_json(&path, json!({})))?;
        }
    }
    let progress_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM playback_progress", [], |row| {
            row.get(0)
        })?;
    if progress_count == 0 {
        let path = data_dir.join("progress.json");
        if path.exists() {
            import_progress_with_connection(conn, &read_json(&path, json!({})))?;
        }
    }
    let artwork_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM custom_artwork", [], |row| row.get(0))?;
    if artwork_count == 0 {
        let path = data_dir.join("artwork.json");
        if path.exists() {
            import_custom_artwork_with_connection(conn, &read_json(&path, json!({})))?;
        }
    }
    Ok(())
}

fn folder_groups(library: &JsonValue) -> JsonValue {
    library
        .get("libraryFolderGroups")
        .cloned()
        .unwrap_or_else(|| {
            let mut groups = Map::new();
            let folders = library
                .get("libraryFolders")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            groups.insert("movies".to_string(), JsonValue::Array(folders));
            groups.insert("tvShows".to_string(), json!([]));
            groups.insert("anime".to_string(), json!([]));
            groups.insert("others".to_string(), json!([]));
            JsonValue::Object(groups)
        })
}

fn folder_groups_from_rows(rows: Vec<(String, String)>) -> (JsonValue, JsonValue) {
    let mut groups = Map::new();
    groups.insert("movies".to_string(), json!([]));
    groups.insert("tvShows".to_string(), json!([]));
    groups.insert("anime".to_string(), json!([]));
    groups.insert("others".to_string(), json!([]));

    for (path, kind) in rows {
        let key = match kind.as_str() {
            "tvShows" => "tvShows",
            "anime" => "anime",
            "others" => "others",
            _ => "movies",
        };
        groups
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .unwrap()
            .push(json!(path));
    }

    let folders = ["movies", "tvShows", "anime", "others"]
        .iter()
        .flat_map(|key| {
            groups
                .get(*key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();

    (JsonValue::Array(folders), JsonValue::Object(groups))
}

fn all_progress(conn: &Connection) -> rusqlite::Result<HashMap<String, StoredProgress>> {
    let mut stmt = conn.prepare(
        "SELECT file_path, position, duration, updated_at, watched FROM playback_progress",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            StoredProgress {
                position: row.get(1)?,
                duration: row.get(2)?,
                updated_at: row.get::<_, i64>(3)? as u64,
                watched: row.get::<_, i64>(4)? != 0,
            },
        ))
    })?;
    rows.collect()
}

#[derive(Clone)]
struct CustomArtworkEntry {
    data_url: String,
    updated_at: u64,
}

fn custom_artwork_map(
    conn: &Connection,
) -> rusqlite::Result<HashMap<String, HashMap<String, CustomArtworkEntry>>> {
    let mut stmt = conn.prepare("SELECT media_id, target, data_url, updated_at FROM custom_artwork")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    let mut result: HashMap<String, HashMap<String, CustomArtworkEntry>> = HashMap::new();
    for row in rows {
        let (media_id, target, data_url, updated_at) = row?;
        result.entry(media_id).or_default().insert(
            target,
            CustomArtworkEntry {
                data_url,
                updated_at: updated_at.max(0) as u64,
            },
        );
    }
    Ok(result)
}

fn latest_custom_artwork<'a>(
    entries: impl IntoIterator<Item = Option<&'a CustomArtworkEntry>>,
) -> Option<&'a str> {
    entries
        .into_iter()
        .flatten()
        .filter(|entry| !entry.data_url.is_empty())
        .max_by_key(|entry| entry.updated_at)
        .map(|entry| entry.data_url.as_str())
}

fn apply_durable_state(
    item: &mut JsonValue,
    progress: &HashMap<String, StoredProgress>,
    custom: &HashMap<String, HashMap<String, CustomArtworkEntry>>,
) {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let file_path = item.get("filePath").and_then(Value::as_str).unwrap_or("");
    let mut last_played = item.get("lastPlayed").and_then(Value::as_u64).unwrap_or(0);
    if let Some(record) = progress.get(file_path) {
        last_played = last_played.max(record.updated_at);
    }
    if let Some(files) = item.get("episodeFiles").and_then(Value::as_array) {
        for file in files {
            if let Some(record) = file
                .get("filePath")
                .and_then(Value::as_str)
                .and_then(|path| progress.get(path))
            {
                last_played = last_played.max(record.updated_at);
            }
        }
    }
    if last_played > 0 {
        item["lastPlayed"] = json!(last_played);
    }
    if let Some(item_custom) = custom.get(&id) {
        if let Some(cover) = latest_custom_artwork([
            item_custom.get("cover"),
            item_custom.get("backdrop"),
        ]) {
            item["backdrop"] = json!(cover);
            prepend_candidate(item, "backdropCandidates", cover);
        }
        if let Some(primary) = latest_custom_artwork([
            item_custom.get("thumbnail"),
            item_custom.get("poster"),
        ]) {
            item["poster"] = json!(primary);
            prepend_candidate(item, "posterCandidates", primary);
        }
        if let Some(logo) = latest_custom_artwork([item_custom.get("logo")]) {
            item["logo"] = json!(logo);
            prepend_candidate(item, "logoCandidates", logo);
        }
    }
}

fn prepend_candidate(item: &mut JsonValue, key: &str, source: &str) {
    let mut values = item
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    values.retain(|value| value.as_str() != Some(source));
    values.insert(0, json!(source));
    item[key] = JsonValue::Array(values);
}

pub fn load_library(data_dir: &Path) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    if !has_library_data(&conn)? {
        return Ok(library_default());
    }

    let folder_rows = {
        let mut stmt =
            conn.prepare("SELECT path, kind FROM library_folders ORDER BY added_at ASC")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let (library_folders, library_folder_groups) = folder_groups_from_rows(folder_rows);
    let progress = all_progress(&conn)?;
    let custom = custom_artwork_map(&conn)?;

    let mut seasons: HashMap<String, Vec<JsonValue>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT media_id, number, title, episode_count FROM seasons ORDER BY number ASC",
    )?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, json!({ "number": row.get::<_, i64>(1)?, "title": row.get::<_, String>(2)?, "episodeCount": row.get::<_, i64>(3)? }))) )? {
        let (media_id, season) = row?;
        seasons.entry(media_id).or_default().push(season);
    }

    let mut episodes: HashMap<String, Vec<JsonValue>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT media_id, season, number, title, summary, still, rating, air_date, local_metadata_json FROM episodes ORDER BY season ASC, number ASC")?;
    for row in stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            json!({
                "season": row.get::<_, i64>(1)?,
                "number": row.get::<_, i64>(2)?,
                "title": row.get::<_, String>(3)?,
                "summary": row.get::<_, String>(4)?,
                "still": row.get::<_, String>(5)?,
                "rating": row.get::<_, f64>(6)?,
                "airDate": row.get::<_, String>(7)?,
                "localMetadata": json_parse(row.get::<_, Option<String>>(8)?, JsonValue::Null),
            }),
        ))
    })? {
        let (media_id, episode) = row?;
        episodes.entry(media_id).or_default().push(episode);
    }

    let mut episode_files: HashMap<String, Vec<JsonValue>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT media_id, season, episode, file_path, title, local_metadata_json FROM episode_files ORDER BY season ASC, episode ASC")?;
    for row in stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            json!({
                "season": row.get::<_, i64>(1)?,
                "episode": row.get::<_, i64>(2)?,
                "filePath": row.get::<_, String>(3)?,
                "title": row.get::<_, Option<String>>(4)?,
                "localMetadata": json_parse(row.get::<_, Option<String>>(5)?, JsonValue::Null),
            }),
        ))
    })? {
        let (media_id, file) = row?;
        episode_files.entry(media_id).or_default().push(file);
    }

    let mut scan_cache = Map::new();
    let mut stmt = conn.prepare("SELECT folder_path, version, folder_kind, signature, file_count, item_count, scanned_at FROM scan_cache")?;
    for row in stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            json!({
                "version": row.get::<_, Option<i64>>(1)?,
                "folderKind": row.get::<_, String>(2)?,
                "signature": row.get::<_, String>(3)?,
                "fileCount": row.get::<_, i64>(4)?,
                "itemCount": row.get::<_, i64>(5)?,
                "scannedAt": row.get::<_, i64>(6)?,
            }),
        ))
    })? {
        let (folder, entry) = row?;
        scan_cache.insert(folder, entry);
    }

    let mut library = library_default();
    library["libraryFolders"] = library_folders;
    library["libraryFolderGroups"] = library_folder_groups;
    library["scanCache"] = JsonValue::Object(scan_cache);

    let mut stmt = conn.prepare(
        "SELECT id, type, title, year, poster, backdrop, logo, summary, rating, file_path, file_size, last_played, genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json FROM media_items ORDER BY title COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "type": row.get::<_, String>(1)?,
            "title": row.get::<_, String>(2)?,
            "year": row.get::<_, i64>(3)?,
            "poster": row.get::<_, String>(4)?,
            "backdrop": row.get::<_, String>(5)?,
            "logo": row.get::<_, String>(6)?,
            "summary": row.get::<_, String>(7)?,
            "rating": row.get::<_, f64>(8)?,
            "filePath": row.get::<_, String>(9)?,
            "fileSize": row.get::<_, Option<i64>>(10)?,
            "lastPlayed": row.get::<_, Option<i64>>(11)?,
            "genres": json_parse(row.get::<_, Option<String>>(12)?, json!([])),
            "cast": json_parse(row.get::<_, Option<String>>(13)?, json!([])),
            "subtitles": json_parse(row.get::<_, Option<String>>(14)?, json!([])),
            "localMetadata": json_parse(row.get::<_, Option<String>>(15)?, JsonValue::Null),
            "providerIds": json_parse(row.get::<_, Option<String>>(16)?, JsonValue::Null),
            "posterCandidates": json_parse(row.get::<_, Option<String>>(17)?, json!([])),
            "backdropCandidates": json_parse(row.get::<_, Option<String>>(18)?, json!([])),
            "logoCandidates": json_parse(row.get::<_, Option<String>>(19)?, json!([])),
        }))
    })?;

    for row in rows {
        let mut item = row?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(value) = seasons.remove(&id) {
            item["seasons"] = JsonValue::Array(value);
        }
        if let Some(value) = episodes.remove(&id) {
            item["episodes"] = JsonValue::Array(value);
        }
        if let Some(value) = episode_files.remove(&id) {
            item["episodeFiles"] = JsonValue::Array(value);
        }
        apply_durable_state(&mut item, &progress, &custom);
        match item.get("type").and_then(Value::as_str) {
            Some("anime") => library["animeShows"].as_array_mut().unwrap().push(item),
            Some("tv") => library["tvShows"].as_array_mut().unwrap().push(item),
            _ => library["movies"].as_array_mut().unwrap().push(item),
        }
    }

    Ok(library)
}

pub fn save_library(data_dir: &Path, library: &JsonValue) -> rusqlite::Result<()> {
    let mut conn = open(data_dir)?;
    let tx = conn.transaction()?;
    save_library_with_connection(&tx, library)?;
    tx.commit()
}

fn save_library_with_connection(conn: &Connection, library: &JsonValue) -> rusqlite::Result<()> {
    let now = now_millis() as i64;
    conn.execute_batch("DELETE FROM episode_files; DELETE FROM episodes; DELETE FROM seasons; DELETE FROM media_items; DELETE FROM library_folders; DELETE FROM scan_cache;")?;
    let groups = folder_groups(library);
    for key in ["movies", "tvShows", "anime", "others"] {
        for folder in groups
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            conn.execute(
                "INSERT OR REPLACE INTO library_folders (path, kind, added_at) VALUES (?1, ?2, ?3)",
                params![folder, key, now],
            )?;
        }
    }

    for bucket in ["movies", "tvShows", "animeShows"] {
        for item in library
            .get(bucket)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let item_type =
                item.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(if bucket == "movies" {
                        "movie"
                    } else if bucket == "animeShows" {
                        "anime"
                    } else {
                        "tv"
                    });
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            conn.execute(
                r#"INSERT OR REPLACE INTO media_items (
                id, type, title, year, poster, backdrop, logo, summary, rating, file_path, file_size, last_played,
                genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)"#,
                params![
                    id,
                    item_type,
                    item.get("title").and_then(Value::as_str).unwrap_or(""),
                    item.get("year").and_then(Value::as_i64).unwrap_or(0),
                    durable_artwork_source(item.get("poster").and_then(Value::as_str)),
                    durable_artwork_source(item.get("backdrop").and_then(Value::as_str)),
                    durable_artwork_source(item.get("logo").and_then(Value::as_str)),
                    item.get("summary").and_then(Value::as_str).unwrap_or(""),
                    item.get("rating").and_then(Value::as_f64).unwrap_or(0.0),
                    item.get("filePath").and_then(Value::as_str).unwrap_or(""),
                    item.get("fileSize").and_then(Value::as_i64),
                    item.get("lastPlayed").and_then(Value::as_i64),
                    json_string(item.get("genres").unwrap_or(&json!([]))),
                    json_string(item.get("cast").unwrap_or(&json!([]))),
                    json_string(item.get("subtitles").unwrap_or(&json!([]))),
                    item.get("localMetadata").filter(|value| !value.is_null()).map(json_string),
                    item.get("providerIds").filter(|value| !value.is_null()).map(json_string),
                    json_string(&durable_artwork_sources(item.get("posterCandidates"))),
                    json_string(&durable_artwork_sources(item.get("backdropCandidates"))),
                    json_string(&durable_artwork_sources(item.get("logoCandidates"))),
                    now,
                ],
            )?;

            for season in item
                .get("seasons")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                conn.execute("INSERT OR REPLACE INTO seasons (media_id, number, title, episode_count) VALUES (?1, ?2, ?3, ?4)", params![id, season.get("number").and_then(Value::as_i64).unwrap_or(0), season.get("title").and_then(Value::as_str).unwrap_or(""), season.get("episodeCount").and_then(Value::as_i64).unwrap_or(0)])?;
            }
            for episode in item
                .get("episodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                conn.execute("INSERT OR REPLACE INTO episodes (media_id, season, number, title, summary, still, rating, air_date, local_metadata_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![id, episode.get("season").and_then(Value::as_i64).unwrap_or(0), episode.get("number").and_then(Value::as_i64).unwrap_or(0), episode.get("title").and_then(Value::as_str).unwrap_or(""), episode.get("summary").and_then(Value::as_str).unwrap_or(""), durable_artwork_source(episode.get("still").and_then(Value::as_str)), episode.get("rating").and_then(Value::as_f64).unwrap_or(0.0), episode.get("airDate").and_then(Value::as_str).unwrap_or(""), episode.get("localMetadata").filter(|value| !value.is_null()).map(json_string)])?;
            }
            for episode_file in item
                .get("episodeFiles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                conn.execute("INSERT OR REPLACE INTO episode_files (media_id, season, episode, file_path, title, local_metadata_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![id, episode_file.get("season").and_then(Value::as_i64).unwrap_or(0), episode_file.get("episode").and_then(Value::as_i64).unwrap_or(0), episode_file.get("filePath").and_then(Value::as_str).unwrap_or(""), episode_file.get("title").and_then(Value::as_str), episode_file.get("localMetadata").filter(|value| !value.is_null()).map(json_string)])?;
            }
        }
    }

    if let Some(cache) = library.get("scanCache").and_then(Value::as_object) {
        for (folder, entry) in cache {
            conn.execute("INSERT OR REPLACE INTO scan_cache (folder_path, version, folder_kind, signature, file_count, item_count, scanned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![folder, entry.get("version").and_then(Value::as_i64), entry.get("folderKind").and_then(Value::as_str).unwrap_or(""), entry.get("signature").and_then(Value::as_str).unwrap_or(""), entry.get("fileCount").and_then(Value::as_i64).unwrap_or(0), entry.get("itemCount").and_then(Value::as_i64).unwrap_or(0), entry.get("scannedAt").and_then(Value::as_i64).unwrap_or(now)])?;
        }
    }
    Ok(())
}

pub fn load_settings(data_dir: &Path) -> rusqlite::Result<Option<JsonValue>> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    conn.query_row(
        "SELECT data_json FROM app_settings WHERE id = 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|value| value.map(|raw| serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))))
}

pub fn save_settings(data_dir: &Path, settings: &JsonValue) -> rusqlite::Result<()> {
    let conn = open(data_dir)?;
    save_settings_with_connection(&conn, settings)
}

fn save_settings_with_connection(conn: &Connection, settings: &JsonValue) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (id, data_json, updated_at) VALUES (1, ?1, ?2)",
        params![json_string(settings), now_millis() as i64],
    )?;
    Ok(())
}

pub fn get_progress(data_dir: &Path, file_path: Option<&str>) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    if let Some(path) = file_path {
        let row = conn.query_row("SELECT position, duration, updated_at, watched FROM playback_progress WHERE file_path = ?1", params![path], |row| {
            Ok(json!({ "position": row.get::<_, f64>(0)?, "duration": row.get::<_, f64>(1)?, "updatedAt": row.get::<_, i64>(2)?, "watched": row.get::<_, i64>(3)? != 0 }))
        }).optional()?;
        return Ok(row.unwrap_or(JsonValue::Null));
    }
    let mut result = Map::new();
    for (path, record) in all_progress(&conn)? {
        result.insert(path, json!({ "position": record.position, "duration": record.duration, "updatedAt": record.updated_at, "watched": record.watched }));
    }
    Ok(JsonValue::Object(result))
}

pub fn save_progress(
    data_dir: &Path,
    file_path: &str,
    position: f64,
    duration: f64,
) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    let safe_position = if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    };
    let safe_duration = if duration.is_finite() {
        duration.max(0.0)
    } else {
        0.0
    };
    let watched = safe_duration > 0.0 && safe_position / safe_duration >= 0.9;
    let stored_position = if watched {
        safe_duration
    } else {
        safe_position
    };
    let updated_at = now_millis() as i64;
    conn.execute("INSERT OR REPLACE INTO playback_progress (file_path, position, duration, updated_at, watched) VALUES (?1, ?2, ?3, ?4, ?5)", params![file_path, stored_position, safe_duration, updated_at, if watched { 1 } else { 0 }])?;
    Ok(
        json!({ "position": stored_position, "duration": safe_duration, "updatedAt": updated_at, "watched": watched }),
    )
}

pub fn import_progress(data_dir: &Path, progress: &JsonValue) -> rusqlite::Result<()> {
    let mut conn = open(data_dir)?;
    let tx = conn.transaction()?;
    import_progress_with_connection(&tx, progress)?;
    tx.commit()
}

fn import_progress_with_connection(
    conn: &Connection,
    progress: &JsonValue,
) -> rusqlite::Result<()> {
    let Some(entries) = progress.as_object() else {
        return Ok(());
    };
    for (file_path, value) in entries {
        let position = value
            .as_f64()
            .or_else(|| value.get("position").and_then(Value::as_f64))
            .unwrap_or(0.0);
        let duration = value.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let updated_at = value
            .get("updatedAt")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| now_millis() as i64);
        let watched = duration > 0.0 && position / duration >= 0.9;
        conn.execute("INSERT OR REPLACE INTO playback_progress (file_path, position, duration, updated_at, watched) VALUES (?1, ?2, ?3, ?4, ?5)", params![file_path, if watched { duration } else { position.max(0.0) }, duration.max(0.0), updated_at, if watched { 1 } else { 0 }])?;
    }
    Ok(())
}

pub fn get_custom_artwork(data_dir: &Path, media_id: &str) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    let mut result = Map::new();
    let mut stmt =
        conn.prepare("SELECT target, data_url FROM custom_artwork WHERE media_id = ?1")?;
    for row in stmt.query_map(params![media_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (target, data_url) = row?;
        result.insert(target, json!(data_url));
    }
    Ok(JsonValue::Object(result))
}

pub fn save_custom_artwork(
    data_dir: &Path,
    media_id: &str,
    target: &str,
    data_url: &str,
) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    conn.execute("INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at) VALUES (?1, ?2, ?3, ?4)", params![media_id, target, data_url, now_millis() as i64])?;
    if target == "thumbnail" {
        conn.execute("INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at) VALUES (?1, 'poster', ?2, ?3)", params![media_id, data_url, now_millis() as i64])?;
    }
    if target == "cover" {
        conn.execute("INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at) VALUES (?1, 'backdrop', ?2, ?3)", params![media_id, data_url, now_millis() as i64])?;
    }
    get_custom_artwork(data_dir, media_id)
}

pub fn import_custom_artwork(data_dir: &Path, entries: &JsonValue) -> rusqlite::Result<()> {
    let mut conn = open(data_dir)?;
    let tx = conn.transaction()?;
    import_custom_artwork_with_connection(&tx, entries)?;
    tx.commit()
}

fn import_custom_artwork_with_connection(
    conn: &Connection,
    entries: &JsonValue,
) -> rusqlite::Result<()> {
    let Some(items) = entries.as_object() else {
        return Ok(());
    };
    for (media_id, targets) in items {
        if let Some(targets) = targets.as_object() {
            for (target, data_url) in targets {
                if let Some(data_url) = data_url.as_str().filter(|value| !value.is_empty()) {
                    conn.execute("INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at) VALUES (?1, ?2, ?3, ?4)", params![media_id, target, data_url, now_millis() as i64])?;
                }
            }
        }
    }
    Ok(())
}

pub fn get_cached_artwork(
    data_dir: &Path,
    source_url: &str,
) -> rusqlite::Result<Option<JsonValue>> {
    let conn = open(data_dir)?;
    migrate_json_if_needed(data_dir, &conn)?;
    conn.query_row(
        "SELECT data_url, mime_type, byte_length FROM artwork_cache WHERE source_url = ?1",
        params![source_url],
        |row| {
            Ok(json!({
                "dataUrl": row.get::<_, String>(0)?,
                "mimeType": row.get::<_, String>(1)?,
                "byteLength": row.get::<_, i64>(2)?,
            }))
        },
    )
    .optional()
}

pub fn save_cached_artwork(
    data_dir: &Path,
    source_url: &str,
    data_url: &str,
    mime_type: &str,
    byte_length: usize,
) -> rusqlite::Result<()> {
    let conn = open(data_dir)?;
    conn.execute(
        "INSERT OR REPLACE INTO artwork_cache (source_url, data_url, mime_type, byte_length, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![source_url, data_url, mime_type, byte_length as i64, now_millis() as i64],
    )?;
    Ok(())
}

pub fn backup_database(data_dir: &Path) -> JsonValue {
    let source = database_path(data_dir);
    if let Err(error) = initialize(data_dir) {
        return json!({ "ok": false, "error": error.to_string() });
    }
    let backup_dir = data_dir.join("backups");
    let _ = fs::create_dir_all(&backup_dir);
    let target = backup_dir.join(format!("loomtv-backup-{}.sqlite", now_millis()));
    match fs::copy(&source, &target) {
        Ok(_) => json!({ "ok": true, "path": target.to_string_lossy() }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

pub fn clear_database(data_dir: &Path) -> rusqlite::Result<JsonValue> {
    let conn = open(data_dir)?;
    conn.execute_batch(
        r#"
        DELETE FROM artwork_cache;
        DELETE FROM custom_artwork;
        DELETE FROM playback_progress;
        DELETE FROM episode_files;
        DELETE FROM episodes;
        DELETE FROM seasons;
        DELETE FROM media_items;
        DELETE FROM library_folders;
        DELETE FROM scan_cache;
        DELETE FROM app_settings;
        PRAGMA wal_checkpoint(TRUNCATE);
        VACUUM;
        "#,
    )?;
    Ok(library_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn saves_and_loads_library_with_tv_episode_details() {
        let dir = tempdir().unwrap();
        let library = json!({
            "movies": [{
                "id": "movie-1",
                "type": "movie",
                "title": "Movie One",
                "year": 2026,
                "poster": "https://img/poster.jpg",
                "backdrop": "data:image/png;base64,inline",
                "logo": "https://img/logo.png",
                "summary": "A movie.",
                "rating": 8.5,
                "filePath": "/media/movie.mp4",
                "fileSize": 10,
                "genres": ["Drama"],
                "posterCandidates": ["https://img/poster.jpg", "data:image/png;base64,skip"]
            }],
            "tvShows": [{
                "id": "show-1",
                "type": "tv",
                "title": "Show One",
                "filePath": "/media/show",
                "seasons": [{ "number": 1, "title": "Season 1", "episodeCount": 1 }],
                "episodes": [{ "season": 1, "number": 1, "title": "Pilot", "still": "https://img/still.jpg" }],
                "episodeFiles": [{ "season": 1, "episode": 1, "filePath": "/media/show/s01e01.mkv", "title": "Pilot" }]
            }],
            "animeShows": [],
            "libraryFolders": ["/media/movies", "/media/shows"],
            "libraryFolderGroups": { "movies": ["/media/movies"], "tvShows": ["/media/shows"], "anime": [], "others": [] },
            "scanCache": { "/media/movies": { "version": 1, "folderKind": "movies", "signature": "abc", "fileCount": 1, "itemCount": 1, "scannedAt": 123 } }
        });

        save_library(dir.path(), &library).unwrap();
        let loaded = load_library(dir.path()).unwrap();

        assert_eq!(
            loaded["libraryFolderGroups"]["movies"][0],
            json!("/media/movies")
        );
        assert_eq!(loaded["movies"][0]["title"], json!("Movie One"));
        assert_eq!(loaded["movies"][0]["backdrop"], json!(""));
        assert_eq!(
            loaded["movies"][0]["posterCandidates"],
            json!(["https://img/poster.jpg"])
        );
        assert_eq!(loaded["tvShows"][0]["episodes"][0]["title"], json!("Pilot"));
        assert_eq!(
            loaded["scanCache"]["/media/movies"]["signature"],
            json!("abc")
        );
    }

    #[test]
    fn progress_and_custom_artwork_are_applied_to_loaded_library() {
        let dir = tempdir().unwrap();
        let library = json!({
            "movies": [{ "id": "movie-1", "type": "movie", "title": "Movie One", "filePath": "/media/movie.mp4", "posterCandidates": [] }],
            "tvShows": [],
            "animeShows": [],
            "libraryFolderGroups": { "movies": ["/media"], "tvShows": [], "anime": [], "others": [] }
        });

        save_library(dir.path(), &library).unwrap();
        let progress = save_progress(dir.path(), "/media/movie.mp4", 95.0, 100.0).unwrap();
        let artwork = save_custom_artwork(
            dir.path(),
            "movie-1",
            "thumbnail",
            "data:image/png;base64,poster",
        )
        .unwrap();
        let loaded = load_library(dir.path()).unwrap();

        assert_eq!(progress["watched"], json!(true));
        assert_eq!(progress["position"], json!(100.0));
        assert_eq!(artwork["poster"], json!("data:image/png;base64,poster"));
        assert_eq!(
            loaded["movies"][0]["poster"],
            json!("data:image/png;base64,poster")
        );
        assert!(loaded["movies"][0]["lastPlayed"].as_u64().unwrap() > 0);
    }

    #[test]
    fn migrates_existing_json_files_once() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"metadataApiKeys":{"tmdb":"key"}}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("progress.json"),
            r#"{"/a.mp4":{"position":12,"duration":120,"updatedAt":99}}"#,
        )
        .unwrap();

        initialize(dir.path()).unwrap();

        assert_eq!(
            load_settings(dir.path()).unwrap().unwrap()["metadataApiKeys"]["tmdb"],
            json!("key")
        );
        assert_eq!(
            get_progress(dir.path(), Some("/a.mp4")).unwrap()["position"],
            json!(12.0)
        );
    }

    #[test]
    fn backup_and_clear_database() {
        let dir = tempdir().unwrap();
        save_settings(dir.path(), &json!({"theme":"dark"})).unwrap();

        let backup = backup_database(dir.path());
        assert_eq!(backup["ok"], json!(true));
        assert!(Path::new(backup["path"].as_str().unwrap()).exists());

        let cleared = clear_database(dir.path()).unwrap();
        assert_eq!(cleared, library_default());
        assert!(load_settings(dir.path()).unwrap().is_none());
    }

    #[test]
    fn saves_and_loads_cached_artwork() {
        let dir = tempdir().unwrap();

        save_cached_artwork(
            dir.path(),
            "https://image.example/poster.jpg",
            "data:image/jpeg;base64,abc",
            "image/jpeg",
            3,
        )
        .unwrap();

        let cached = get_cached_artwork(dir.path(), "https://image.example/poster.jpg")
            .unwrap()
            .expect("cached artwork");
        assert_eq!(cached["dataUrl"], json!("data:image/jpeg;base64,abc"));
        assert_eq!(cached["mimeType"], json!("image/jpeg"));
        assert_eq!(cached["byteLength"], json!(3));
    }
}
