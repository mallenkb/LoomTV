use crate::{now, Error, Result, Store};
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use walkdir::WalkDir;

pub struct ScanRequest {
    pub profile: String,
    pub revision: i64,
    pub roots: Vec<(String, String)>,
}
impl Store {
    pub fn scan_request(&self) -> Result<ScanRequest> {
        let profile = self.require_owner()?;
        let mut stmt = self
            .db
            .prepare("SELECT path,kind FROM library_folders ORDER BY added_at,path")?;
        let roots = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ScanRequest {
            profile,
            revision: self.revision,
            roots,
        })
    }
}
struct FileItem {
    id: String,
    kind: String,
    title: String,
    year: i64,
    path: String,
    catalog_path: String,
    format: String,
    subtitles: Value,
    size: u64,
    episode: Option<(i64, i64, String)>,
}
fn media_id(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))[..32].into()
}
fn regex(pattern: &str) -> Result<Regex> {
    Regex::new(pattern).map_err(|_| {
        Error::new(
            "classifier_error",
            "The filename classifier could not be loaded.",
        )
    })
}

pub fn scan(
    store: Arc<Mutex<Store>>,
    request: ScanRequest,
    cancelled: Arc<AtomicBool>,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
) -> Result<Value> {
    let episode_pattern = regex(r"(?i)[s]\s*0*(\d{1,2})[._ -]*[e]\s*0*(\d{1,3})")?;
    let season_pattern = regex(r"(?i)^(?:season|series|s)[ ._:-]*0*(\d{1,2})(?:$|[ ._:\[(-])")?;
    let alternate_episode = regex(r"(?i)\b(\d{1,2})x(\d{1,3})\b")?;
    let named_episode = regex(r"(?i)(?:episode|ep|e)\s*0*(\d{1,3})\b")?;
    let trailing_episode = regex(r"[-_\s]+0*(\d{1,3})\s*$")?;
    let year_pattern = regex(r"\b(19\d{2}|20\d{2})\b")?;
    let release_tags = regex(
        r"(?i)\b(?:2160p|1080p|720p|480p|bluray|blu ray|brrip|bdrip|webrip|web dl|hdtv|x264|x265|h264|h265|hevc|aac|dts|ac3|proper|repack)\b",
    )?;
    let separators = regex(r"[._-]+")?;
    let spaces = regex(r"\s+")?;
    store.blocking_lock().db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS tauri_scan_seen (path TEXT PRIMARY KEY); DELETE FROM tauri_scan_seen;")?;
    let mut completed = 0;
    let mut available = 0;
    let mut batch = Vec::with_capacity(64);
    let check_cancelled = || -> Result<()> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::new(
                "scan_cancelled",
                "The library scan was cancelled.",
            ));
        }
        Ok(())
    };
    for (root, group) in &request.roots {
        check_cancelled()?;
        // Unreadable roots retain their existing catalog. They never count as an empty scan.
        if !Path::new(root).is_dir() {
            completed += 1;
            continue;
        }
        available += 1;
        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_open(8)
            .max_depth(64)
        {
            check_cancelled()?;
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    return Err(Error::new(
                        "scan_unreadable",
                        format!(
                            "The scan could not read a library entry: {}",
                            error
                                .io_error()
                                .map(|e| e.kind().to_string())
                                .unwrap_or_else(|| "directory traversal failed".into())
                        ),
                    ))
                }
            };
            if !entry.file_type().is_file() || entry.file_name().to_string_lossy().starts_with("._")
            {
                continue;
            }
            let extension = entry
                .path()
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ![
                "3gp", "avi", "divx", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg",
                "mts", "mxf", "ogm", "ogv", "ts", "vob", "webm", "wmv",
            ]
            .contains(&extension.as_str())
            {
                continue;
            }
            let path = entry.path();
            let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            let parent = path.parent().unwrap_or(Path::new(root));
            let parent_name = parent.file_name().and_then(|v| v.to_str()).unwrap_or("");
            let season_dir = if parent_name.eq_ignore_ascii_case("specials") {
                Some(0)
            } else {
                season_pattern
                    .captures(parent_name)
                    .and_then(|c| c[1].parse::<i64>().ok())
            };
            let parsed = episode_pattern
                .captures(stem)
                .and_then(|c| Some((c[1].parse::<i64>().ok()?, c[2].parse::<i64>().ok()?)))
                .or_else(|| {
                    alternate_episode
                        .captures(stem)
                        .and_then(|c| Some((c[1].parse::<i64>().ok()?, c[2].parse::<i64>().ok()?)))
                })
                .or_else(|| {
                    named_episode
                        .captures(stem)
                        .and_then(|c| Some((season_dir.unwrap_or(1), c[1].parse::<i64>().ok()?)))
                })
                .or_else(|| {
                    season_dir.and_then(|season| {
                        trailing_episode
                            .captures(stem)
                            .and_then(|c| Some((season, c[1].parse::<i64>().ok()?)))
                    })
                });
            // Existing episode identities come from the shared Electron catalog. Reuse them
            // even when a filename needs a classifier rule that has not been ported yet.
            let existing = if group == "movies" {
                None
            } else {
                let store = store.blocking_lock();
                store.db.query_row("SELECT e.media_id,e.season,e.episode,m.file_path FROM episode_files e JOIN media_items m ON m.id=e.media_id WHERE e.file_path=? LIMIT 1",[path.to_string_lossy().as_ref()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?))).optional()?
            };
            let episode = if group == "movies" {
                None
            } else {
                existing.as_ref().map(|row| (row.1, row.2)).or(parsed)
            };
            let series_dir = if season_dir.is_some() {
                parent.parent().unwrap_or(parent)
            } else {
                parent
            };
            let name = if episode.is_some() {
                series_dir
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or(stem)
            } else {
                stem
            };
            let year_match = year_pattern.find(name);
            let year = year_match
                .as_ref()
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0);
            let name = year_match
                .filter(|m| m.start() > 0)
                .map(|m| &name[..m.start()])
                .unwrap_or(name);
            let separated = separators.replace_all(name, " ");
            let cleaned = release_tags.replace_all(&separated, " ");
            let title = spaces.replace_all(&cleaned, " ").trim().to_owned();
            let kind = if group == "anime" {
                "anime"
            } else if episode.is_some() || group == "tvShows" {
                "tv"
            } else {
                "movie"
            };
            let id = existing
                .as_ref()
                .map(|row| row.0.clone())
                .unwrap_or_else(|| media_id(if episode.is_some() { series_dir } else { path }));
            batch.push(FileItem {
                id,
                kind: kind.into(),
                title,
                year,
                path: path.to_string_lossy().into_owned(),
                catalog_path: existing
                    .as_ref()
                    .map(|row| row.3.clone())
                    .unwrap_or_else(|| {
                        if episode.is_some() { series_dir } else { path }
                            .to_string_lossy()
                            .into_owned()
                    }),
                format: extension.to_uppercase(),
                subtitles: sidecars(path)?,
                size: entry
                    .metadata()
                    .map_err(|_| Error::new("scan_unreadable", "A media file became unavailable."))?
                    .len(),
                episode: episode.map(|(s, e)| (s, e, stem.to_owned())),
            });
            if batch.len() >= 64 {
                save_batch(&store, &request, &mut batch)?;
            }
        }
        check_cancelled()?;
        save_batch(&store, &request, &mut batch)?;
        check_cancelled()?;
        reconcile_root(&store, &request, root)?;
        completed += 1;
        emit(
            json!({"isComplete":false,"scannedFolders":completed,"totalFolders":request.roots.len()}),
        );
    }
    if !request.roots.is_empty() && available == 0 {
        return Err(Error::new(
            "library_unavailable",
            "The library folders are unavailable. Reconnect them and scan again.",
        ));
    }
    emit(json!({"isComplete":true,"scannedFolders":completed,"totalFolders":request.roots.len()}));
    store.blocking_lock().library(true)
}
fn save_batch(
    store: &Arc<Mutex<Store>>,
    request: &ScanRequest,
    batch: &mut Vec<FileItem>,
) -> Result<()> {
    let mut store = store.blocking_lock();
    store.require_active(Some(&request.profile))?;
    if store.revision != request.revision {
        return Err(Error::new(
            "scan_cancelled",
            "The profile changed during the scan.",
        ));
    }
    let tx = store.db.transaction()?;
    for item in batch.drain(..) {
        // Existing provider metadata and user overrides survive a filesystem scan.
        tx.execute("INSERT INTO media_items (id,type,title,year,file_path,file_size,format,subtitles_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,type=excluded.type,file_size=excluded.file_size,format=excluded.format,subtitles_json=excluded.subtitles_json,updated_at=excluded.updated_at",params![item.id,item.kind,item.title,item.year,item.catalog_path,item.size,item.format,item.subtitles.to_string(),now()])?;
        tx.execute(
            "INSERT OR IGNORE INTO tauri_scan_seen VALUES (?)",
            [&item.path],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO tauri_scan_seen VALUES (?)",
            [&item.catalog_path],
        )?;
        if let Some((season, episode, title)) = item.episode {
            tx.execute("INSERT INTO episode_files (media_id,season,episode,file_path,title,subtitles_json) VALUES (?,?,?,?,?,?) ON CONFLICT(media_id,season,episode,file_path) DO UPDATE SET title=CASE WHEN episode_files.title IS NULL OR episode_files.title='' THEN excluded.title ELSE episode_files.title END,subtitles_json=excluded.subtitles_json",params![item.id,season,episode,item.path,title,item.subtitles.to_string()])?;
            tx.execute("INSERT INTO seasons (media_id,number,title,episode_count) VALUES (?,?,?,1) ON CONFLICT(media_id,number) DO UPDATE SET episode_count=MAX(seasons.episode_count,(SELECT COUNT(DISTINCT episode) FROM episode_files WHERE media_id=excluded.media_id AND season=excluded.number))",params![item.id,season,if season==0{"Specials".into()}else{format!("Season {season}")}])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn reconcile_root(store: &Arc<Mutex<Store>>, request: &ScanRequest, root: &str) -> Result<()> {
    let mut store = store.blocking_lock();
    store.require_active(Some(&request.profile))?;
    if store.revision != request.revision {
        return Err(Error::new(
            "scan_cancelled",
            "The profile changed during the scan.",
        ));
    }
    let prefix = format!(
        "{}{}",
        root.trim_end_matches(std::path::MAIN_SEPARATOR),
        std::path::MAIN_SEPARATOR
    );
    let tx = store.db.transaction()?;
    tx.execute("DELETE FROM episode_files WHERE substr(file_path,1,length(?1))=?1 AND file_path NOT IN (SELECT path FROM tauri_scan_seen)",[&prefix])?;
    tx.execute("DELETE FROM media_items WHERE (file_path=?1 OR substr(file_path,1,length(?2))=?2) AND file_path NOT IN (SELECT path FROM tauri_scan_seen) AND NOT EXISTS (SELECT 1 FROM episode_files WHERE media_id=media_items.id)",params![root,prefix])?;
    // Provider season records can describe episodes that are not stored locally.
    // Preserve them and update only items belonging to the completed root.
    tx.execute("UPDATE seasons SET episode_count=MAX(episode_count,(SELECT COUNT(DISTINCT episode) FROM episode_files WHERE media_id=seasons.media_id AND season=seasons.number)) WHERE media_id IN (SELECT id FROM media_items WHERE file_path=?1 OR substr(file_path,1,length(?2))=?2)",params![root,prefix])?;
    tx.execute("UPDATE media_items SET season_count=MAX(season_count,(SELECT COUNT(*) FROM seasons WHERE media_id=media_items.id)),episode_count=MAX(episode_count,(SELECT COUNT(*) FROM episode_files WHERE media_id=media_items.id)) WHERE type IN ('tv','anime') AND (file_path=?1 OR substr(file_path,1,length(?2))=?2)",params![root,prefix])?;
    tx.commit()?;
    Ok(())
}

fn sidecars(video: &Path) -> Result<Value> {
    let Some(parent) = video.parent() else {
        return Ok(json!([]));
    };
    let stem = video
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut result = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !entry.file_type()?.is_file() || name.starts_with("._") || !name.starts_with(&stem) {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !["srt", "vtt", "ass", "ssa"].contains(&ext.as_str()) {
            continue;
        }
        if result.len() >= 32 {
            break;
        }
        let suffix = &name[stem.len()..];
        let language = suffix
            .split(['.', '[', ']', '_', '-'])
            .find(|part| {
                (part.len() == 2 || part.len() == 3)
                    && part.bytes().all(|c| c.is_ascii_alphabetic())
                    && !["srt", "vtt", "ass", "ssa"].contains(part)
            })
            .unwrap_or("en");
        let mut url = url::Url::parse("http://localhost/subtitle")
            .map_err(|_| Error::new("subtitle_url", "The subtitle URL could not be created."))?;
        url.query_pairs_mut()
            .append_pair("path", &path.to_string_lossy());
        result.push(json!({"lang":language,"label":language.to_uppercase(),"url":format!("/subtitle?{}",url.query().unwrap_or("")),"source":if name.contains(".opensubtitles."){"opensubtitles"}else{"sidecar"},"format":ext}));
    }
    result.sort_by(|a, b| a["url"].as_str().cmp(&b["url"].as_str()));
    Ok(json!(result))
}
