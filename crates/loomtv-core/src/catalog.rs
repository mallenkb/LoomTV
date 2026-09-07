use crate::{now, Error, Result, Store};
use rusqlite::{params, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, path::Path};
use url::Url;

struct MediaRow {
    id: String,
    kind: String,
    format: String,
    title: String,
    year: i64,
    poster: String,
    backdrop: String,
    logo: String,
    summary: String,
    rating: f64,
    content_rating: String,
    trailer_url: String,
    runtime: String,
    season_count: Option<i64>,
    episode_count: Option<i64>,
    provider_ratings: Option<String>,
    file_path: String,
    file_size: Option<i64>,
    genres: Option<String>,
    cast: Option<String>,
    subtitles: Option<String>,
    local_metadata: Option<String>,
    provider_ids: Option<String>,
    streaming_providers: Option<String>,
    origin_platform: Option<String>,
    poster_candidates: Option<String>,
    backdrop_candidates: Option<String>,
    logo_candidates: Option<String>,
    content_ratings: Option<String>,
}

impl MediaRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            kind: row.get(1)?,
            format: row.get(2)?,
            title: row.get(3)?,
            year: row.get(4)?,
            poster: row.get(5)?,
            backdrop: row.get(6)?,
            logo: row.get(7)?,
            summary: row.get(8)?,
            rating: row.get(9)?,
            content_rating: row.get(10)?,
            trailer_url: row.get(11)?,
            runtime: row.get(12)?,
            season_count: row.get(13)?,
            episode_count: row.get(14)?,
            provider_ratings: row.get(15)?,
            file_path: row.get(16)?,
            file_size: row.get(17)?,
            genres: row.get(18)?,
            cast: row.get(19)?,
            subtitles: row.get(20)?,
            local_metadata: row.get(21)?,
            provider_ids: row.get(22)?,
            streaming_providers: row.get(23)?,
            origin_platform: row.get(24)?,
            poster_candidates: row.get(25)?,
            backdrop_candidates: row.get(26)?,
            logo_candidates: row.get(27)?,
            content_ratings: row.get(28)?,
        })
    }
}

fn parse_json(text: Option<&str>, fallback: Value) -> Value {
    text.and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(fallback)
}

fn put_nonempty(map: &mut Map<String, Value>, key: &str, value: String) {
    if !value.is_empty() {
        map.insert(key.into(), json!(value));
    }
}

fn put_some<T: serde::Serialize>(map: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

fn external_https(source: &str) -> Option<String> {
    let source = source.trim();
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && host != "localhost"
        && !host.ends_with(".localhost")
        && host != "127.0.0.1"
        && host != "::1")
        .then(|| source.to_owned())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn custom_artwork_reference(source: &str) -> Option<(String, String)> {
    let url = Url::parse(source.trim()).ok()?;
    if url.scheme() != "loomtv-custom-artwork" || url.host_str() != Some("artwork") {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() != 2 {
        return None;
    }
    let media_id = percent_decode(segments[0])?;
    let target = percent_decode(segments[1])?;
    (!media_id.is_empty()
        && media_id.len() <= 512
        && !media_id.contains('\0')
        && !target.is_empty()
        && target.len() <= 128
        && !target.contains('\0'))
    .then_some((media_id, target))
}

impl Store {
    pub fn add_folder(&mut self, kind: &str, path: &str) -> Result<()> {
        if !["movies", "tvShows", "anime", "others"].contains(&kind) {
            return Err(Error::new(
                "invalid_kind",
                "Choose a supported library type.",
            ));
        }
        let path = Path::new(path).canonicalize()?;
        if !path.is_dir() {
            return Err(Error::new("invalid_folder", "Choose a directory."));
        }
        self.db.execute("INSERT INTO library_folders VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind", params![path.to_string_lossy(),kind,now()])?;
        Ok(())
    }

    fn artwork_source(&self, source: &str, profile: &str) -> String {
        if let Some((media_id, target)) = custom_artwork_reference(source) {
            return self
                .custom_artwork(&media_id)
                .ok()
                .and_then(|artwork| {
                    artwork
                        .get(&target)
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|url| {
                    external_https(url).is_some()
                        || Url::parse(url).is_ok_and(|url| {
                            url.scheme() == "loomtv"
                                && url.host_str() == Some("localhost")
                                && url.path() == "/api/custom-artwork"
                                && url
                                    .query_pairs()
                                    .any(|(key, value)| key == "profile" && value == profile)
                        })
                })
                .unwrap_or_default();
        }
        external_https(source).unwrap_or_default()
    }

    fn artwork_candidates(&self, value: Value, profile: &str) -> Vec<String> {
        let mut seen = HashSet::new();
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|source| self.artwork_source(source, profile))
            .filter(|source| !source.is_empty() && seen.insert(source.clone()))
            .collect()
    }

    fn sanitize_cast(&self, value: &mut Value, profile: &str) {
        let Some(cast) = value.as_array_mut() else {
            *value = json!([]);
            return;
        };
        cast.retain_mut(|credit| {
            let Some(credit) = credit.as_object_mut() else {
                return false;
            };
            for key in ["image", "characterImage", "voiceActorImage"] {
                if let Some(source) = credit.get(key).and_then(Value::as_str) {
                    credit.insert(key.into(), json!(self.artwork_source(source, profile)));
                }
            }
            true
        });
    }

    fn sanitize_streaming_providers(&self, value: &mut Value, profile: &str) {
        let Some(providers) = value.as_array_mut() else {
            return;
        };
        providers.retain_mut(|provider| {
            let Some(provider) = provider.as_object_mut() else {
                return false;
            };
            if let Some(source) = provider.get("logoUrl").and_then(Value::as_str) {
                provider.insert(
                    "logoUrl".into(),
                    json!(self.artwork_source(source, profile)),
                );
            }
            true
        });
    }

    fn sanitize_origin_platform(&self, value: &mut Value, profile: &str) {
        let Some(platform) = value.as_object_mut() else {
            return;
        };
        if let Some(source) = platform.get("logoUrl").and_then(Value::as_str) {
            platform.insert(
                "logoUrl".into(),
                json!(self.artwork_source(source, profile)),
            );
        }
        if let Some(site) = platform.get("officialSite").and_then(Value::as_str) {
            platform.insert(
                "officialSite".into(),
                json!(external_https(site).unwrap_or_default()),
            );
        }
    }

    fn subtitle_records(&self, text: Option<&str>) -> Result<Value> {
        let mut subtitles = parse_json(text, json!([]));
        let Some(rows) = subtitles.as_array_mut() else {
            return Ok(json!([]));
        };
        rows.retain(|subtitle| {
            let Some(source) = subtitle.get("url").and_then(Value::as_str) else {
                return false;
            };
            if external_https(source).is_some() {
                return true;
            }
            Url::parse("loomtv://localhost")
                .ok()
                .and_then(|base| base.join(source).ok())
                .is_some_and(|url| url.host_str() == Some("localhost") && url.path() == "/subtitle")
        });
        self.subtitle_delivery(&mut subtitles)?;
        Ok(subtitles)
    }

    fn media_row(&self, id: &str) -> Result<Option<MediaRow>> {
        Ok(self
            .db
            .query_row(
                "SELECT id,type,format,title,year,poster,backdrop,logo,summary,rating,content_rating,trailer_url,runtime,season_count,episode_count,provider_ratings_json,file_path,file_size,genres_json,cast_json,subtitles_json,local_metadata_json,provider_ids_json,streaming_providers_json,origin_platform_json,poster_candidates_json,backdrop_candidates_json,logo_candidates_json,content_ratings_json FROM media_items WHERE id=?",
                [id],
                MediaRow::read,
            )
            .optional()?)
    }

    fn full_item(&self, row: MediaRow, profile: &str) -> Result<Value> {
        let poster_candidates = self.artwork_candidates(
            parse_json(row.poster_candidates.as_deref(), json!([])),
            profile,
        );
        let backdrop_candidates = self.artwork_candidates(
            parse_json(row.backdrop_candidates.as_deref(), json!([])),
            profile,
        );
        let logo_candidates = self.artwork_candidates(
            parse_json(row.logo_candidates.as_deref(), json!([])),
            profile,
        );
        let poster = {
            let primary = self.artwork_source(&row.poster, profile);
            if primary.is_empty() {
                poster_candidates.first().cloned().unwrap_or_default()
            } else {
                primary
            }
        };
        let backdrop = {
            let primary = self.artwork_source(&row.backdrop, profile);
            if primary.is_empty() {
                backdrop_candidates
                    .first()
                    .cloned()
                    .unwrap_or_else(|| poster.clone())
            } else {
                primary
            }
        };
        let logo = {
            let primary = self.artwork_source(&row.logo, profile);
            if primary.is_empty() {
                logo_candidates.first().cloned().unwrap_or_default()
            } else {
                primary
            }
        };
        let mut cast = parse_json(row.cast.as_deref(), json!([]));
        self.sanitize_cast(&mut cast, profile);
        let mut streaming_providers = parse_json(row.streaming_providers.as_deref(), Value::Null);
        self.sanitize_streaming_providers(&mut streaming_providers, profile);
        let mut origin_platform = parse_json(row.origin_platform.as_deref(), Value::Null);
        self.sanitize_origin_platform(&mut origin_platform, profile);

        let mut item = json!({
            "id": row.id,
            "type": row.kind,
            "title": row.title,
            "year": row.year,
            "poster": poster,
            "backdrop": backdrop,
            "logo": logo,
            "posterCandidates": poster_candidates,
            "backdropCandidates": backdrop_candidates,
            "logoCandidates": logo_candidates,
            "summary": row.summary,
            "rating": row.rating,
            "providerRatings": parse_json(row.provider_ratings.as_deref(), json!({})),
            "contentRatings": parse_json(row.content_ratings.as_deref(), json!({})),
            "genres": parse_json(row.genres.as_deref(), json!([])),
            "cast": cast,
            "filePath": row.file_path,
            "subtitles": self.subtitle_records(row.subtitles.as_deref())?,
        });
        let map = item
            .as_object_mut()
            .ok_or_else(|| Error::new("invalid_catalog", "The catalog entry is invalid."))?;
        put_nonempty(map, "format", row.format);
        put_nonempty(map, "contentRating", row.content_rating);
        if let Some(trailer) = external_https(&row.trailer_url) {
            map.insert("trailerUrl".into(), json!(trailer));
        }
        put_nonempty(map, "runtime", row.runtime);
        put_some(
            map,
            "seasonCount",
            row.season_count.filter(|value| *value >= 0),
        );
        put_some(
            map,
            "episodeCount",
            row.episode_count.filter(|value| *value >= 0),
        );
        put_some(map, "fileSize", row.file_size.filter(|value| *value > 0));
        if !streaming_providers.is_null() {
            map.insert("streamingProviders".into(), streaming_providers);
        }
        if !origin_platform.is_null() {
            map.insert("originPlatform".into(), origin_platform);
        }
        let local_metadata = parse_json(row.local_metadata.as_deref(), Value::Null);
        if !local_metadata.is_null() {
            map.insert("localMetadata".into(), local_metadata);
        }
        let provider_ids = parse_json(row.provider_ids.as_deref(), Value::Null);
        if !provider_ids.is_null() {
            map.insert("providerIds".into(), provider_ids);
        }

        let media_id = item["id"].as_str().unwrap_or_default().to_owned();
        let mut seasons = self.db.prepare(
            "SELECT number,title,episode_count FROM seasons WHERE media_id=? ORDER BY number",
        )?;
        let seasons = seasons
            .query_map([media_id.as_str()], |row| {
                Ok(json!({
                    "number": row.get::<_, i64>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "episodeCount": row.get::<_, i64>(2)?,
                }))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if !seasons.is_empty() {
            item["seasons"] = json!(seasons);
        }

        let mut episodes = self.db.prepare("SELECT season,number,title,summary,still,rating,air_date,local_metadata_json FROM episodes WHERE media_id=? ORDER BY season,number")?;
        let rows = episodes.query_map([media_id.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut episode_metadata = Vec::new();
        for row in rows {
            let (season, number, title, summary, still, rating, air_date, local_metadata) = row?;
            let mut episode = json!({
                "season": season,
                "number": number,
                "title": title,
                "summary": summary,
                "still": self.artwork_source(&still, profile),
                "rating": rating,
                "airDate": air_date,
            });
            let local_metadata = parse_json(local_metadata.as_deref(), Value::Null);
            if !local_metadata.is_null() {
                episode["localMetadata"] = local_metadata;
            }
            episode_metadata.push(episode);
        }
        if !episode_metadata.is_empty() {
            item["episodes"] = json!(episode_metadata);
        }

        let mut files = self.db.prepare("SELECT season,episode,file_path,title,thumbnail,still,subtitles_json,local_metadata_json FROM episode_files WHERE media_id=? ORDER BY season,episode,file_path")?;
        let rows = files.query_map([media_id.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut episode_files = Vec::new();
        for row in rows {
            let (season, episode, path, title, thumbnail, still, subtitles, local_metadata) = row?;
            let mut file = json!({
                "season": season,
                "episode": episode,
                "filePath": path,
                "subtitles": self.subtitle_records(subtitles.as_deref())?,
            });
            let file_map = file
                .as_object_mut()
                .ok_or_else(|| Error::new("invalid_catalog", "The episode file is invalid."))?;
            if let Some(title) = title.filter(|value| !value.is_empty()) {
                file_map.insert("title".into(), json!(title));
            }
            if let Some(source) = thumbnail {
                let source = self.artwork_source(&source, profile);
                if !source.is_empty() {
                    file_map.insert("thumbnail".into(), json!(source));
                }
            }
            if let Some(source) = still {
                let source = self.artwork_source(&source, profile);
                if !source.is_empty() {
                    file_map.insert("still".into(), json!(source));
                }
            }
            let local_metadata = parse_json(local_metadata.as_deref(), Value::Null);
            if !local_metadata.is_null() {
                file_map.insert("localMetadata".into(), local_metadata);
            }
            episode_files.push(file);
        }
        if !episode_files.is_empty() {
            item["episodeFiles"] = json!(episode_files);
        }
        Ok(item)
    }

    fn card(item: &Value) -> Result<Value> {
        let source = item
            .as_object()
            .ok_or_else(|| Error::new("invalid_catalog", "The catalog entry is invalid."))?;
        let mut card = Map::new();
        for key in [
            "id",
            "type",
            "format",
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
            "providerRatings",
            "contentRatings",
            "contentRating",
            "streamingProviders",
            "originPlatform",
            "trailerUrl",
            "runtime",
            "seasonCount",
            "episodeCount",
            "genres",
            "lastPlayed",
            "seasons",
        ] {
            if let Some(value) = source.get(key) {
                card.insert(key.into(), value.clone());
            }
        }
        let mut references = Vec::new();
        if let Some(files) = source.get("episodeFiles").and_then(Value::as_array) {
            for file in files {
                let Some(path) = file.get("filePath").and_then(Value::as_str) else {
                    continue;
                };
                let mut reference = json!({
                    "progressKey": path,
                    "season": file["season"],
                    "episode": file["episode"],
                });
                if let Some(duration) = file["localMetadata"]["durationSeconds"]
                    .as_f64()
                    .filter(|duration| *duration > 0.0)
                {
                    reference["durationSeconds"] = json!(duration);
                }
                references.push(reference);
            }
        }
        if references.is_empty() {
            if let Some(path) = source.get("filePath").and_then(Value::as_str) {
                if !path.is_empty() {
                    let mut reference = json!({"progressKey": path});
                    if let Some(duration) = source["localMetadata"]["durationSeconds"]
                        .as_f64()
                        .filter(|duration| *duration > 0.0)
                    {
                        reference["durationSeconds"] = json!(duration);
                    }
                    references.push(reference);
                }
            }
        }
        card.insert("playbackReferences".into(), json!(references));
        Ok(Value::Object(card))
    }

    fn item_belongs_to_root(item: &Value, root: &str) -> bool {
        let belongs = |path: &str| Path::new(path).starts_with(root);
        if item["type"] == "movie" {
            return item["filePath"].as_str().is_some_and(belongs);
        }
        let episode_paths = item["episodeFiles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|file| file["filePath"].as_str())
            .collect::<Vec<_>>();
        if episode_paths.is_empty() {
            item["filePath"].as_str().is_some_and(belongs)
        } else {
            episode_paths.into_iter().any(belongs)
        }
    }

    pub fn library(&self, compact: bool) -> Result<Value> {
        let profile = self.require_active(None)?;
        let mut result = json!({
            "movies": [],
            "tvShows": [],
            "animeShows": [],
            "others": [],
            "libraryFolders": [],
            "libraryFolderGroups": {"movies": [], "tvShows": [], "anime": [], "others": []},
            "libraryFolderStatuses": [],
        });
        if compact {
            result["catalogVersion"] = json!(1);
            result["revision"] = json!(self.catalog_revision()?);
        }
        let mut statement = self
            .db
            .prepare("SELECT path,kind FROM library_folders ORDER BY added_at,path")?;
        let roots = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (path, kind) in &roots {
            result["libraryFolders"]
                .as_array_mut()
                .ok_or_else(|| Error::new("invalid_catalog", "Invalid library folders."))?
                .push(json!(path));
            result["libraryFolderGroups"][kind]
                .as_array_mut()
                .ok_or_else(|| Error::new("invalid_catalog", "Invalid library type."))?
                .push(json!(path));
            let available = Path::new(path).is_dir();
            result["libraryFolderStatuses"]
                .as_array_mut()
                .ok_or_else(|| Error::new("invalid_catalog", "Invalid library state."))?
                .push(json!({
                    "path": path,
                    "kind": kind,
                    "state": if available { "available" } else { "unavailable" },
                    "isNetworkLike": path.starts_with("//") || path.starts_with("\\\\"),
                    "checkedAt": now(),
                    "message": if available { "" } else { "The library folder is unavailable." },
                }));
        }

        let mut statement = self
            .db
            .prepare("SELECT id FROM media_items ORDER BY title COLLATE NOCASE,id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in ids {
            if !self.can_access_item(&id)? {
                continue;
            }
            let Some(row) = self.media_row(&id)? else {
                continue;
            };
            let item = self.full_item(row, &profile)?;
            if !roots
                .iter()
                .any(|(root, _)| Self::item_belongs_to_root(&item, root))
            {
                continue;
            }
            let category = if roots
                .iter()
                .any(|(root, kind)| kind == "others" && Self::item_belongs_to_root(&item, root))
            {
                "others"
            } else {
                match item["type"].as_str().unwrap_or("movie") {
                    "tv" => "tvShows",
                    "anime" => "animeShows",
                    _ => "movies",
                }
            };
            result[category]
                .as_array_mut()
                .ok_or_else(|| Error::new("invalid_catalog", "Invalid library type."))?
                .push(if compact { Self::card(&item)? } else { item });
        }
        Ok(result)
    }

    pub fn catalog_revision(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COALESCE(MAX(updated_at),0) FROM media_items",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn library_item(&self, id: &str) -> Result<Value> {
        let profile = self.require_active(None)?;
        let Some(row) = self.media_row(id)? else {
            return Ok(Value::Null);
        };
        if !self.can_access_item(id)? {
            return Err(Error::new(
                "content_restricted",
                "This content is unavailable for the selected profile.",
            ));
        }
        Ok(json!({
            "catalogVersion": 1,
            "revision": self.catalog_revision()?,
            "item": self.full_item(row, &profile)?,
        }))
    }
}
