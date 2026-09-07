use crate::{now, Error, Result, Store};
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const MAX_PROFILE_FILE_BYTES: usize = 25 * 1024 * 1024;
const MAX_TRANSFER_ENTRIES: usize = 100_000;

fn invalid(code: &str, message: &str) -> Error {
    Error::new(code, message)
}

fn object<'a>(value: &'a Value, code: &str, message: &str) -> Result<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| invalid(code, message))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value.as_f64().and_then(|number| {
            (number.is_finite()
                && number.fract() == 0.0
                && number >= i64::MIN as f64
                && number <= i64::MAX as f64)
                .then_some(number as i64)
        })
    })
}

fn valid_timestamp(value: &Value) -> bool {
    integer(value).is_some_and(|timestamp| timestamp >= 0 && timestamp <= now() + 86_400_000)
}

fn valid_avatar(value: &str) -> bool {
    let built_in = value
        .strip_prefix("glyph-")
        .and_then(|suffix| suffix.parse::<u8>().ok())
        .is_some_and(|number| (1..=12).contains(&number) && value == format!("glyph-{number:02}"))
        || value
            .strip_prefix("weave-0")
            .and_then(|suffix| suffix.parse::<u8>().ok())
            .is_some_and(|number| (1..=8).contains(&number));
    built_in
        || (value.len() <= 512 * 1024
            && Regex::new(r"(?i)^data:image/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$")
                .is_ok_and(|pattern| pattern.is_match(value)))
}

fn normalize_track_preference(value: &Value) -> Result<Value> {
    let preference = object(
        value,
        "invalid_profile_transfer",
        "The track preferences are invalid.",
    )?;
    let enabled = preference
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The track preferences are invalid.",
            )
        })?;
    let mut normalized = Map::from_iter([("enabled".into(), json!(enabled))]);
    if let Some(index) = preference.get("index") {
        let index = index
            .as_f64()
            .filter(|number| number.is_finite())
            .ok_or_else(|| {
                invalid(
                    "invalid_profile_transfer",
                    "The track preferences are invalid.",
                )
            })?;
        normalized.insert("index".into(), json!(index));
    }
    for key in ["language", "title", "codec"] {
        if let Some(value) = preference.get(key) {
            let text = value.as_str().ok_or_else(|| {
                invalid(
                    "invalid_profile_transfer",
                    "The track preferences are invalid.",
                )
            })?;
            normalized.insert(key.into(), json!(text.trim().to_lowercase()));
        }
    }
    if let Some(forced) = preference.get("forced") {
        normalized.insert(
            "forced".into(),
            json!(forced.as_bool().ok_or_else(|| {
                invalid(
                    "invalid_profile_transfer",
                    "The track preferences are invalid.",
                )
            })?),
        );
    }
    Ok(Value::Object(normalized))
}

fn normalize_track_preferences(value: &Value) -> Result<Value> {
    let preferences = object(
        value,
        "invalid_profile_transfer",
        "The track preferences are invalid.",
    )?;
    let mut normalized = Map::new();
    for key in ["audio", "subtitle"] {
        if let Some(preference) = preferences.get(key) {
            normalized.insert(key.into(), normalize_track_preference(preference)?);
        }
    }
    Ok(Value::Object(normalized))
}

fn normalize_preferences(value: &Value) -> Result<Value> {
    let preferences = object(
        value,
        "invalid_profile_transfer",
        "The profile preferences are invalid.",
    )?;
    let enums = [
        ("appThemeMode", &["dark", "light"][..]),
        (
            "appThemeColor",
            &["orange", "yellow", "red", "blue", "twitch"][..],
        ),
        ("appDarkTheme", &["black"][..]),
        (
            "appLoaderStyle",
            &["play-mark", "logo-mark", "horizontal-logo"][..],
        ),
        ("appHomeStyle", &["default", "modern"][..]),
        ("appModernHeroMode", &["continue-watching", "featured"][..]),
    ];
    let mut normalized = Map::new();
    for (key, allowed) in enums {
        if let Some(value) = preferences.get(key) {
            let value = value
                .as_str()
                .filter(|value| allowed.contains(value))
                .ok_or_else(|| {
                    invalid(
                        "invalid_profile_transfer",
                        "The profile preferences are invalid.",
                    )
                })?;
            normalized.insert(key.into(), json!(value));
        }
    }
    for key in ["showProviderRatingBadges", "autoplayNextEnabled"] {
        if let Some(value) = preferences.get(key) {
            normalized.insert(
                key.into(),
                json!(value.as_bool().ok_or_else(|| {
                    invalid(
                        "invalid_profile_transfer",
                        "The profile preferences are invalid.",
                    )
                })?),
            );
        }
    }
    if let Some(order) = preferences.get("sidebarNavOrder") {
        let order = order
            .as_array()
            .filter(|order| order.len() <= 256)
            .ok_or_else(|| {
                invalid(
                    "invalid_profile_transfer",
                    "The profile navigation order is invalid.",
                )
            })?;
        let mut seen = HashSet::new();
        let mut clean = Vec::new();
        for entry in order {
            let entry = entry.as_str().ok_or_else(|| {
                invalid(
                    "invalid_profile_transfer",
                    "The profile navigation order is invalid.",
                )
            })?;
            let entry = entry.trim();
            if !entry.is_empty() && seen.insert(entry.to_owned()) {
                clean.push(entry);
            }
        }
        normalized.insert("sidebarNavOrder".into(), json!(clean));
    }
    for key in ["playbackSkipBackSeconds", "playbackSkipForwardSeconds"] {
        if let Some(value) = preferences.get(key) {
            let seconds = value
                .as_f64()
                .filter(|seconds| seconds.is_finite() && (1.0..=120.0).contains(seconds))
                .ok_or_else(|| {
                    invalid(
                        "invalid_profile_transfer",
                        "The profile preferences are invalid.",
                    )
                })?;
            normalized.insert(key.into(), json!(seconds.round()));
        }
    }
    Ok(Value::Object(normalized))
}

fn validate_bundle(bundle: &Value) -> Result<(Value, Value)> {
    if serde_json::to_vec(bundle)?.len() > MAX_PROFILE_FILE_BYTES {
        return Err(invalid(
            "profile_transfer_too_large",
            "The profile file is larger than 25 MB.",
        ));
    }
    let root = object(
        bundle,
        "invalid_profile_transfer",
        "This is not a supported LoomTV profile file.",
    )?;
    if root.get("format").and_then(Value::as_str) != Some("loomtv.profile.v1")
        || !root.get("exportedAt").is_some_and(valid_timestamp)
    {
        return Err(invalid(
            "invalid_profile_transfer",
            "This is not a supported LoomTV profile file.",
        ));
    }
    let profile = root
        .get("profile")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile metadata is invalid.",
            )
        })?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && utf16_len(name) <= 30)
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile metadata is invalid.",
            )
        })?;
    let avatar = profile
        .get("avatarKey")
        .and_then(Value::as_str)
        .filter(|avatar| valid_avatar(avatar))
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile metadata is invalid.",
            )
        })?;
    let color = profile
        .get("colorKey")
        .and_then(Value::as_str)
        .filter(|color| {
            [
                "ember", "gold", "crimson", "ocean", "violet", "teal", "rose", "slate",
            ]
            .contains(color)
        })
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile metadata is invalid.",
            )
        })?;
    let profile_type = profile
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| ["owner", "standard", "kid"].contains(kind))
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile metadata is invalid.",
            )
        })?;

    let progress = root
        .get("progress")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("invalid_profile_transfer", "The profile data is malformed."))?;
    let tracks = root
        .get("trackPreferences")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("invalid_profile_transfer", "The profile data is malformed."))?;
    let lists = root
        .get("lists")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("invalid_profile_transfer", "The profile data is malformed."))?;
    if progress.len() > MAX_TRANSFER_ENTRIES
        || tracks.len() > MAX_TRANSFER_ENTRIES
        || lists.len() > MAX_TRANSFER_ENTRIES
    {
        return Err(invalid(
            "profile_transfer_too_large",
            "The profile contains too many entries.",
        ));
    }
    for (path, entry) in progress {
        let entry = entry.as_object().ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile progress data is invalid.",
            )
        })?;
        let position = entry.get("position").and_then(Value::as_f64);
        let duration = entry.get("duration").and_then(Value::as_f64);
        if path.is_empty()
            || utf16_len(path) > 4_096
            || !position.is_some_and(|number| number.is_finite() && number >= 0.0)
            || !duration.is_some_and(|number| number.is_finite() && number >= 0.0)
            || !entry.get("updatedAt").is_some_and(valid_timestamp)
            || !entry.get("watched").is_some_and(Value::is_boolean)
        {
            return Err(invalid(
                "invalid_profile_transfer",
                "The profile progress data is invalid.",
            ));
        }
    }
    let mut normalized_tracks = Map::new();
    for (scope, preferences) in tracks {
        if scope.is_empty() || utf16_len(scope) > 500 {
            return Err(invalid(
                "invalid_profile_transfer",
                "The track preferences are invalid.",
            ));
        }
        normalized_tracks.insert(scope.clone(), normalize_track_preferences(preferences)?);
    }
    let normalized_preferences =
        normalize_preferences(root.get("preferences").ok_or_else(|| {
            invalid("invalid_profile_transfer", "The profile data is malformed.")
        })?)?;
    let restrictions = root
        .get("restrictions")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            invalid(
                "invalid_profile_transfer",
                "The profile restrictions are invalid.",
            )
        })?;
    let country = restrictions.get("country").and_then(Value::as_str);
    let maximum_age = restrictions.get("maximumAge");
    let valid_age = maximum_age.is_some_and(|age| {
        age.is_null() || integer(age).is_some_and(|age| (0..=18).contains(&age))
    });
    let folders = restrictions.get("allowedFolders").and_then(Value::as_array);
    let revision = restrictions.get("revision").and_then(Value::as_f64);
    if !country.is_some_and(|country| ["US", "GB", "CA", "AU"].contains(&country))
        || !valid_age
        || !restrictions
            .get("allowUnrated")
            .is_some_and(Value::is_boolean)
        || !folders.is_some_and(|folders| {
            folders.len() <= 1_000
                && folders.iter().all(|folder| {
                    folder
                        .as_str()
                        .is_some_and(|folder| utf16_len(folder) <= 4_096)
                })
        })
        || !revision.is_some_and(|revision| revision.is_finite() && revision >= 0.0)
    {
        return Err(invalid(
            "invalid_profile_transfer",
            "The profile restrictions are invalid.",
        ));
    }
    for entry in lists {
        let entry = entry
            .as_object()
            .ok_or_else(|| invalid("invalid_profile_transfer", "The profile lists are invalid."))?;
        let media_id = entry.get("mediaId").and_then(Value::as_str);
        let kind = entry.get("kind").and_then(Value::as_str);
        if !media_id.is_some_and(|id| !id.is_empty() && utf16_len(id) <= 240)
            || !kind.is_some_and(|kind| ["watchlist", "favorite", "watched"].contains(&kind))
            || !entry.get("createdAt").is_some_and(valid_timestamp)
        {
            return Err(invalid(
                "invalid_profile_transfer",
                "The profile lists are invalid.",
            ));
        }
    }

    Ok((
        json!({
            "name": name,
            "avatarKey": avatar,
            "colorKey": color,
            "type": if profile_type == "kid" { "kid" } else { "standard" },
        }),
        json!({
            "tracks": normalized_tracks,
            "preferences": normalized_preferences,
        }),
    ))
}

impl Store {
    pub fn export_profile_data(&self, profile_id: &str) -> Result<Value> {
        self.require_owner()?;
        let profile: Option<(String, String, String, String, bool)> = self
            .db
            .query_row(
                "SELECT name,avatar_key,color_key,profile_type,is_guest FROM profiles WHERE id=?",
                [profile_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let (name, avatar, color, profile_type, guest) = profile
            .ok_or_else(|| invalid("profile_not_found", "That profile no longer exists."))?;
        if guest || profile_type == "guest" {
            return Err(invalid("guest_profile", "That profile cannot be exported."));
        }

        let mut progress = Map::new();
        {
            let mut statement = self.db.prepare("SELECT file_path,position,duration,updated_at,watched FROM playback_progress WHERE profile_id=?")?;
            let rows = statement.query_map([profile_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    json!({
                        "position": row.get::<_, f64>(1)?,
                        "duration": row.get::<_, f64>(2)?,
                        "updatedAt": row.get::<_, i64>(3)?,
                        "watched": row.get::<_, bool>(4)?,
                    }),
                ))
            })?;
            for row in rows {
                let (path, value) = row?;
                progress.insert(path, value);
            }
        }
        let mut tracks = Map::new();
        {
            let mut statement = self.db.prepare(
                "SELECT scope,preferences_json FROM playback_track_preferences WHERE profile_id=?",
            )?;
            let rows = statement.query_map([profile_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (scope, text) = row?;
                tracks.insert(scope, serde_json::from_str(&text)?);
            }
        }
        let preferences: Option<String> = self
            .db
            .query_row(
                "SELECT preferences_json FROM profile_preferences WHERE profile_id=?",
                [profile_id],
                |row| row.get(0),
            )
            .optional()?;
        let preferences: Value = serde_json::from_str(preferences.as_deref().unwrap_or("{}"))?;
        let restrictions = self.restrictions(profile_id)?;
        let mut statement = self.db.prepare("SELECT media_id,list_kind,created_at FROM profile_media_lists WHERE profile_id=? ORDER BY created_at DESC")?;
        let lists = statement
            .query_map([profile_id], |row| {
                Ok(json!({
                    "mediaId": row.get::<_, String>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "createdAt": row.get::<_, i64>(2)?,
                }))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(json!({
            "format": "loomtv.profile.v1",
            "exportedAt": now(),
            "profile": {
                "name": name,
                "avatarKey": avatar,
                "colorKey": color,
                "type": profile_type,
            },
            "progress": progress,
            "trackPreferences": tracks,
            "preferences": preferences,
            "restrictions": restrictions,
            "lists": lists,
        }))
    }

    pub fn import_profile_data(&mut self, bundle: &Value) -> Result<Value> {
        self.require_owner()?;
        let (profile, normalized) = validate_bundle(bundle)?;
        let progress = bundle["progress"].as_object().expect("validated progress");
        let lists = bundle["lists"].as_array().expect("validated lists");
        let restrictions = bundle["restrictions"]
            .as_object()
            .expect("validated restrictions");
        let tracks = normalized["tracks"].as_object().expect("normalized tracks");
        let preferences = &normalized["preferences"];
        let created_at = now();
        let profile_id = uuid::Uuid::new_v4().to_string();
        let tx = self.db.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM profiles WHERE is_guest=0",
            [],
            |row| row.get(0),
        )?;
        if count >= 10 {
            return Err(invalid(
                "profile_limit",
                "LoomTV supports up to 10 profiles.",
            ));
        }
        let sort_order: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order),0)+1 FROM profiles",
            [],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO profiles (id,name,avatar_key,color_key,profile_type,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)",
            params![
                profile_id,
                profile["name"].as_str(),
                profile["avatarKey"].as_str(),
                profile["colorKey"].as_str(),
                profile["type"].as_str(),
                created_at,
                created_at,
                sort_order,
            ],
        )?;

        let valid_paths = {
            let mut statement = tx.prepare(
                "SELECT file_path FROM media_items WHERE file_path<>'' UNION SELECT file_path FROM episode_files WHERE file_path<>''",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<HashSet<_>, _>>()?;
            rows
        };
        let valid_media_ids = {
            let mut statement = tx.prepare("SELECT id FROM media_items")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<HashSet<_>, _>>()?;
            rows
        };
        let mut imported_progress = 0_u64;
        let mut skipped_progress = 0_u64;
        for (path, entry) in progress {
            if !valid_paths.contains(path) {
                skipped_progress += 1;
                continue;
            }
            let position = entry["position"].as_f64().expect("validated position");
            let duration = entry["duration"].as_f64().expect("validated duration");
            let watched = duration > 0.0 && position / duration >= 0.9;
            tx.execute(
                "INSERT OR REPLACE INTO playback_progress VALUES (?,?,?,?,?,?)",
                params![
                    profile_id,
                    path,
                    if watched { duration } else { position },
                    duration,
                    created_at,
                    watched,
                ],
            )?;
            imported_progress += 1;
        }
        for (scope, preference) in tracks {
            tx.execute(
                "INSERT OR REPLACE INTO playback_track_preferences VALUES (?,?,?,?)",
                params![profile_id, scope, preference.to_string(), created_at],
            )?;
        }
        tx.execute(
            "INSERT INTO profile_preferences (profile_id,preferences_json,revision,updated_at) VALUES (?,?,1,?)",
            params![profile_id, preferences.to_string(), created_at],
        )?;

        let profile_type = profile["type"].as_str().expect("normalized profile type");
        let maximum_age = integer(&restrictions["maximumAge"]);
        let maximum_age = if profile_type == "kid" {
            Some(maximum_age.unwrap_or(13))
        } else {
            maximum_age
        };
        tx.execute(
            "INSERT INTO profile_restrictions (profile_id,country,maximum_age,allow_unrated,revision,updated_at) VALUES (?,?,?,?,1,?)",
            params![
                profile_id,
                restrictions["country"].as_str(),
                maximum_age,
                restrictions["allowUnrated"].as_bool(),
                created_at,
            ],
        )?;
        let available_folders = {
            let mut statement = tx.prepare("SELECT path FROM library_folders")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<HashSet<_>, _>>()?;
            rows
        };
        let mut imported_folders = HashSet::new();
        for folder in restrictions["allowedFolders"]
            .as_array()
            .expect("validated folders")
            .iter()
            .map(|folder| folder.as_str().expect("validated folder"))
        {
            let folder = folder.trim();
            if folder.is_empty() {
                continue;
            }
            if !available_folders.contains(folder) {
                return Err(invalid(
                    "invalid_folders",
                    "Folder access must use a current library root.",
                ));
            }
            if imported_folders.insert(folder) {
                tx.execute(
                    "INSERT INTO profile_library_access (profile_id,folder_path) VALUES (?,?)",
                    params![profile_id, folder],
                )?;
            }
        }

        let mut imported_lists = 0_u64;
        let mut skipped_lists = 0_u64;
        for entry in lists {
            let media_id = entry["mediaId"].as_str().expect("validated media id");
            let kind = entry["kind"].as_str().expect("validated list kind");
            let discover_watched = kind == "watched" && media_id.starts_with("discover:");
            if !valid_media_ids.contains(media_id) && !discover_watched {
                skipped_lists += 1;
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO profile_media_lists VALUES (?,?,?,?)",
                params![profile_id, media_id, kind, created_at],
            )?;
            imported_lists += 1;
        }
        tx.commit()?;

        Ok(json!({
            "profile": {
                "id": profile_id,
                "name": profile["name"],
                "avatarKey": profile["avatarKey"],
                "colorKey": profile["colorKey"],
                "type": profile["type"],
                "hasPin": false,
                "isGuest": false,
                "sortOrder": sort_order,
            },
            "importedProgress": imported_progress,
            "skippedProgress": skipped_progress,
            "importedLists": imported_lists,
            "skippedLists": skipped_lists,
        }))
    }
}
