use crate::{now, Error, Result, Store};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, collections::HashSet, path::Path};

const CANDIDATE_COLUMNS: &str = "id, media_id, season, episode, file_path, file_revision, release_key, type, start_ms, end_ms, confidence, source, status, media_duration_ms, updated_at, expires_at, analysis_metadata_json";
const SEGMENT_TYPES: &[&str] = &["intro", "recap", "outro", "credits", "preview"];
const SEGMENT_STATUSES: &[&str] = &["active", "review", "rejected"];

#[derive(Clone)]
struct Candidate {
    id: String,
    media_id: String,
    season: i64,
    episode: i64,
    file_path: String,
    file_revision: String,
    release_key: Option<String>,
    kind: String,
    start_ms: i64,
    end_ms: Option<i64>,
    confidence: f64,
    source: String,
    status: String,
    media_duration_ms: i64,
    updated_at: i64,
    expires_at: Option<i64>,
    analysis_metadata: Option<String>,
}

#[derive(Clone)]
struct SegmentRequest {
    media_id: String,
    season: Option<f64>,
    episode: Option<f64>,
}

struct SegmentContext {
    media_id: String,
    season: i64,
    episode: i64,
    file_path: String,
    file_revision: String,
    duration_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RevisionSegment<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    start_ms: i64,
    end_ms: Option<i64>,
    source: &'a str,
    media_duration_ms: i64,
}

impl Store {
    pub fn segments_invoke(&mut self, channel: &str, args: &[Value]) -> Result<Value> {
        match channel {
            "playback:segments:get" => {
                exact_args(args, 1)?;
                self.get_segments(parse_request(&args[0], false)?)
            }
            "playback:segments:save-manual" => {
                exact_args(args, 1)?;
                self.save_manual_segment(&args[0])
            }
            "playback:segments:delete-manual" => {
                exact_args(args, 1)?;
                self.delete_manual_segment(&args[0])
            }
            "playback:segments:undo-manual" => {
                exact_args(args, 1)?;
                self.undo_manual_segment(&args[0])
            }
            "playback:segments:manage-list" => {
                if args.len() > 1 {
                    return Err(invalid_argument("Expected zero or one segment filter."));
                }
                self.manage_segments(args.first())
            }
            "playback:segments:manage-update" => {
                exact_args(args, 2)?;
                self.update_managed_segment(&args[0], &args[1])
            }
            "playback:segments:manage-erase" => {
                exact_args(args, 1)?;
                self.erase_managed_segments(&args[0])
            }
            "playback:analysis:status" => {
                exact_args(args, 0)?;
                self.segment_analysis_status()
            }
            "playback:analysis:season" => {
                exact_args(args, 2)?;
                required_string(args.first(), 240, "mediaId")?;
                optional_nonnegative_number(args.get(1), "season")?
                    .ok_or_else(|| invalid_argument("season is required."))?;
                self.analysis_unavailable()
            }
            "playback:analysis:run" | "playback:analysis:cancel" => {
                if args.len() > 1
                    || args
                        .first()
                        .is_some_and(|value| !value.is_null() && !value.is_object())
                {
                    return Err(invalid_argument("Expected an optional analysis request."));
                }
                self.analysis_unavailable()
            }
            "playback:analysis:pause"
            | "playback:analysis:resume"
            | "playback:analysis:cleanup"
            | "playback:analysis:rebuild" => {
                exact_args(args, 0)?;
                self.analysis_unavailable()
            }
            _ => Err(Error::unsupported(channel)),
        }
    }

    fn get_segments(&self, request: SegmentRequest) -> Result<Value> {
        self.require_active(None)?;
        let Some(context) = self.segment_context(&request)? else {
            return segment_response(&[]);
        };
        segment_response(&resolve_candidates(load_candidates(
            &self.db,
            &context.file_revision,
            true,
        )?))
    }

    fn save_manual_segment(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let request = parse_request(input, false)?;
        let object = input
            .as_object()
            .ok_or_else(|| invalid_argument("Expected a manual segment object."))?;
        let kind = required_segment_type(object.get("type"))?;
        let start_ms = required_number(object.get("startMs"), "startMs")?.round() as i64;
        let end_ms = match object.get("endMs") {
            Some(Value::Null) => None,
            value => Some(required_number(value, "endMs")?.round() as i64),
        };
        let candidate_id = optional_string(object.get("candidateId"), 240, "candidateId")?;
        let context = self.segment_context(&request)?.ok_or_else(|| {
            Error::new(
                "segment_media_unavailable",
                "That media file is unavailable.",
            )
        })?;
        let (start_ms, end_ms) = normalize_manual(start_ms, end_ms, context.duration_ms)?;
        let generated_id = hash_parts(
            &[
                &context.file_revision,
                "manual",
                kind,
                &start_ms.to_string(),
                &end_ms.map(|value| value.to_string()).unwrap_or_default(),
            ],
            24,
        );
        let candidate = Candidate {
            id: candidate_id.clone().unwrap_or(generated_id),
            media_id: context.media_id,
            season: context.season,
            episode: context.episode,
            file_path: context.file_path,
            file_revision: context.file_revision.clone(),
            release_key: None,
            kind: kind.into(),
            start_ms,
            end_ms,
            confidence: 1.0,
            source: "manual".into(),
            status: "active".into(),
            media_duration_ms: context.duration_ms,
            updated_at: now(),
            expires_at: None,
            analysis_metadata: None,
        };

        let tx = self.db.transaction()?;
        let existing = if candidate_id.is_some() || kind == "credits" {
            load_candidates_matching(&tx, &candidate.file_revision, Some(&candidate.id), None)?
        } else {
            load_candidates_matching(&tx, &candidate.file_revision, None, Some(kind))?
        };
        for old in existing {
            save_history(&tx, &old, "replace")?;
            tx.execute("DELETE FROM media_segment_candidates WHERE id=?", [&old.id])?;
        }
        insert_candidate(&tx, &candidate)?;
        let segments = refresh_resolved(&tx, &candidate.file_revision)?;
        tx.commit()?;
        segment_response(&segments)
    }

    fn delete_manual_segment(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let (request, kind, candidate_id) = parse_manual_identity(input)?;
        let context = self.segment_context(&request)?.ok_or_else(|| {
            Error::new(
                "segment_media_unavailable",
                "That episode file is unavailable.",
            )
        })?;
        let tx = self.db.transaction()?;
        let existing = load_candidates_matching(
            &tx,
            &context.file_revision,
            candidate_id.as_deref(),
            candidate_id.is_none().then_some(kind),
        )?;
        for old in existing {
            save_history(&tx, &old, "delete")?;
            tx.execute("DELETE FROM media_segment_candidates WHERE id=?", [&old.id])?;
        }
        let segments = refresh_resolved(&tx, &context.file_revision)?;
        tx.commit()?;
        segment_response(&segments)
    }

    fn undo_manual_segment(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let (request, kind, candidate_id) = parse_manual_identity(input)?;
        let context = self.segment_context(&request)?.ok_or_else(|| {
            Error::new(
                "segment_media_unavailable",
                "That episode file is unavailable.",
            )
        })?;
        let tx = self.db.transaction()?;
        let history = {
            let mut statement = tx.prepare(
                "SELECT history_id,snapshot_json FROM segment_manual_history WHERE snapshot_json IS NOT NULL ORDER BY changed_at DESC,history_id DESC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut matched = None;
        for (history_id, snapshot) in history {
            let Ok(value) = serde_json::from_str::<Value>(&snapshot) else {
                continue;
            };
            let Ok(candidate) = candidate_from_json(&value) else {
                continue;
            };
            if candidate.file_revision == context.file_revision
                && candidate.kind == kind
                && candidate.source == "manual"
                && candidate_id.as_ref().is_none_or(|id| id == &candidate.id)
            {
                matched = Some((history_id, candidate));
                break;
            }
        }
        let segments = if let Some((history_id, mut candidate)) = matched {
            if let Some(candidate_id) = candidate_id.as_deref() {
                tx.execute("DELETE FROM media_segment_candidates WHERE file_revision=? AND id=? AND source='manual'", params![context.file_revision, candidate_id])?;
            } else {
                tx.execute("DELETE FROM media_segment_candidates WHERE file_revision=? AND type=? AND source='manual'", params![context.file_revision, kind])?;
            }
            candidate.updated_at = now();
            insert_candidate(&tx, &candidate)?;
            tx.execute(
                "DELETE FROM segment_manual_history WHERE history_id=?",
                [history_id],
            )?;
            refresh_resolved(&tx, &context.file_revision)?
        } else {
            resolve_candidates(load_candidates(&tx, &context.file_revision, true)?)
        };
        tx.commit()?;
        segment_response(&segments)
    }

    fn manage_segments(&self, input: Option<&Value>) -> Result<Value> {
        self.require_owner()?;
        let (media_id, season, episode) = parse_manage_filter(input)?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        if let Some(media_id) = media_id {
            clauses.push("media_id=?");
            values.push(SqlValue::Text(media_id));
        }
        if let Some(season) = season {
            clauses.push("season=?");
            values.push(SqlValue::Integer(season));
        }
        if let Some(episode) = episode {
            clauses.push("episode=?");
            values.push(SqlValue::Integer(episode));
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let sql = format!("SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates{where_clause} ORDER BY media_id,season,episode,start_ms LIMIT 5000");
        let candidates = query_candidates(&self.db, &sql, values)?;
        Ok(Value::Array(
            candidates
                .iter()
                .map(managed_segment_json)
                .collect::<Result<Vec<_>>>()?,
        ))
    }

    fn update_managed_segment(&mut self, id: &Value, patch: &Value) -> Result<Value> {
        self.require_owner()?;
        let id = required_string(Some(id), 240, "candidateId")?;
        let patch = patch
            .as_object()
            .ok_or_else(|| invalid_argument("Expected a segment update object."))?;
        let status = optional_enum(patch.get("status"), SEGMENT_STATUSES, "status")?;
        let kind = optional_enum(patch.get("type"), SEGMENT_TYPES, "type")?;
        if status.is_none() && kind.is_none() {
            return Ok(Value::Bool(false));
        }
        let Some(existing) = load_candidate_by_id(&self.db, id)? else {
            return Ok(Value::Bool(false));
        };
        if existing.source == "manual" {
            return Ok(Value::Bool(false));
        }
        let mut metadata = existing
            .analysis_metadata
            .as_deref()
            .and_then(|raw| valid_analysis_metadata(Some(raw)))
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut decision = metadata
            .get("userDecision")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(status) = status {
            if status == "review" {
                decision.remove("status");
            } else {
                decision.insert("status".into(), Value::String(status.into()));
            }
        }
        if let Some(kind) = kind {
            decision.insert("type".into(), Value::String(kind.into()));
        }
        metadata.insert("userDecision".into(), Value::Object(decision));
        let metadata = serde_json::to_string(&Value::Object(metadata))?;

        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE media_segment_candidates SET status=COALESCE(?1,status),type=COALESCE(?2,type),updated_at=?3,analysis_metadata_json=?4 WHERE id=?5",
            params![status, kind, now(), metadata, id],
        )?;
        refresh_resolved(&tx, &existing.file_revision)?;
        tx.commit()?;
        Ok(Value::Bool(true))
    }

    fn erase_managed_segments(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let request = parse_request(input, false)?;
        let season = request.season.map(floor_nonnegative).transpose()?;
        let episode = request.episode.map(floor_nonnegative).transpose()?;
        let mut clauses = vec!["media_id=?", "source!='manual'"];
        let mut values = vec![SqlValue::Text(request.media_id)];
        if let Some(season) = season {
            clauses.push("season=?");
            values.push(SqlValue::Integer(season));
        }
        if let Some(episode) = episode {
            clauses.push("episode=?");
            values.push(SqlValue::Integer(episode));
        }
        let sql = format!(
            "SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates WHERE {}",
            clauses.join(" AND ")
        );
        let candidates = query_candidates(&self.db, &sql, values)?;
        if candidates.is_empty() {
            return Ok(json!({"removed": 0}));
        }
        let tx = self.db.transaction()?;
        let revisions = candidates
            .iter()
            .map(|candidate| candidate.file_revision.clone())
            .collect::<HashSet<_>>();
        for candidate in &candidates {
            tx.execute(
                "DELETE FROM media_segment_candidates WHERE id=?",
                [&candidate.id],
            )?;
        }
        for revision in revisions {
            refresh_resolved(&tx, &revision)?;
        }
        tx.commit()?;
        Ok(json!({"removed": candidates.len()}))
    }

    fn segment_analysis_status(&self) -> Result<Value> {
        self.require_owner()?;
        let settings = self.settings()?;
        let enabled = settings
            .get("localSkipAnalysisEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            && settings
                .pointer("/skipAnalysis/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        Ok(if enabled {
            json!({
                "enabled": true,
                "available": false,
                "helperPath": null,
                "state": "unavailable",
                "message": "Local segment analysis is unavailable in this desktop build."
            })
        } else {
            json!({"enabled": false, "available": false, "helperPath": null, "state": "disabled"})
        })
    }

    fn analysis_unavailable(&self) -> Result<Value> {
        self.require_owner()?;
        Err(Error::new(
            "segment_analysis_unavailable",
            "Local segment analysis is unavailable in this desktop build.",
        ))
    }

    fn segment_context(&self, request: &SegmentRequest) -> Result<Option<SegmentContext>> {
        if !self.can_access_item(&request.media_id)? {
            return Ok(None);
        }
        let item: Option<(String, String, Option<String>)> = self
            .db
            .query_row(
                "SELECT type,file_path,local_metadata_json FROM media_items WHERE id=?",
                [&request.media_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((media_type, mut file_path, mut local_metadata)) = item else {
            return Ok(None);
        };
        let (season, episode) = if media_type == "movie" {
            (0, 0)
        } else {
            let mut clauses = vec!["media_id=?"];
            let mut values = vec![SqlValue::Text(request.media_id.clone())];
            if let Some(season) = request.season {
                clauses.push("season=?");
                values.push(SqlValue::Real(season));
            }
            if let Some(episode) = request.episode {
                clauses.push("episode=?");
                values.push(SqlValue::Real(episode));
            }
            let sql = format!("SELECT season,episode,file_path,local_metadata_json FROM episode_files WHERE {} ORDER BY season,episode LIMIT 1", clauses.join(" AND "));
            let episode_row: Option<(i64, i64, String, Option<String>)> = self
                .db
                .query_row(&sql, params_from_iter(values.iter()), |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            let Some((season, episode, episode_path, episode_metadata)) = episode_row else {
                return Ok(None);
            };
            file_path = episode_path;
            local_metadata = episode_metadata;
            (season, episode)
        };
        if !Path::new(&file_path).is_file() {
            return Ok(None);
        }
        self.authorize_media(&file_path)?;
        let metadata = local_metadata
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(segment_probe_required)?;
        let duration_seconds = metadata
            .get("durationSeconds")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(segment_probe_required)?;
        let duration_ms = (duration_seconds * 1000.0).round() as i64;
        if duration_ms <= 0 {
            return Err(segment_probe_required());
        }
        let audio_track = default_audio_track(&metadata);
        let file_metadata = std::fs::metadata(&file_path)?;
        let known_identity = metadata
            .get("fileSize")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .zip(
                metadata
                    .get("modifiedAtMs")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite()),
            );
        let file_size = known_identity
            .map(|(size, _)| size.round() as u64)
            .unwrap_or(file_metadata.len());
        let modified_at_ms = known_identity
            .map(|(_, modified)| modified.round())
            .unwrap_or_else(|| {
                file_metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| (duration.as_secs_f64() * 1000.0).round())
                    .unwrap_or(0.0)
            });
        let resolved_path = if Path::new(&file_path).is_absolute() {
            file_path.clone()
        } else {
            std::env::current_dir()?
                .join(&file_path)
                .to_string_lossy()
                .into_owned()
        };
        let file_revision = hash_parts(
            &[
                &resolved_path,
                &file_size.to_string(),
                &format!("{modified_at_ms:.0}"),
                &duration_ms.to_string(),
                &audio_track.to_string(),
            ],
            24,
        );
        Ok(Some(SegmentContext {
            media_id: request.media_id.clone(),
            season,
            episode,
            file_path,
            file_revision,
            duration_ms,
        }))
    }
}

fn exact_args(args: &[Value], expected: usize) -> Result<()> {
    if args.len() == expected {
        Ok(())
    } else {
        Err(invalid_argument(format!(
            "Expected {expected} argument(s)."
        )))
    }
}

fn parse_request(value: &Value, partial: bool) -> Result<SegmentRequest> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument("Expected a media segment request."))?;
    let media_id = if partial {
        optional_string(object.get("mediaId"), 240, "mediaId")?.unwrap_or_default()
    } else {
        required_string(object.get("mediaId"), 240, "mediaId")?.into()
    };
    Ok(SegmentRequest {
        media_id,
        season: optional_nonnegative_number(object.get("season"), "season")?,
        episode: optional_nonnegative_number(object.get("episode"), "episode")?,
    })
}

fn parse_manual_identity(value: &Value) -> Result<(SegmentRequest, &str, Option<String>)> {
    let request = parse_request(value, false)?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument("Expected a manual segment object."))?;
    Ok((
        request,
        required_segment_type(object.get("type"))?,
        optional_string(object.get("candidateId"), 16_384, "candidateId")?,
    ))
}

fn parse_manage_filter(
    value: Option<&Value>,
) -> Result<(Option<String>, Option<i64>, Option<i64>)> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok((None, None, None));
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument("Expected a segment filter object."))?;
    let media_id = optional_string(object.get("mediaId"), 240, "mediaId")?;
    let season = optional_nonnegative_number(object.get("season"), "season")?
        .map(floor_nonnegative)
        .transpose()?;
    let episode = optional_nonnegative_number(object.get("episode"), "episode")?
        .map(floor_nonnegative)
        .transpose()?;
    Ok((media_id, season, episode))
}

fn normalize_manual(
    start_ms: i64,
    end_ms: Option<i64>,
    duration_ms: i64,
) -> Result<(i64, Option<i64>)> {
    let tolerance = 30_000_f64.max(duration_ms as f64 * 0.02);
    if duration_ms <= 0
        || start_ms < 0
        || start_ms >= duration_ms
        || end_ms.is_some_and(|end| end <= start_ms || end as f64 > duration_ms as f64 + tolerance)
    {
        return Err(Error::new(
            "invalid_segment_timestamps",
            "The manual marker timestamps are invalid.",
        ));
    }
    let end_ms = end_ms.map(|end| end.min(duration_ms));
    if end_ms.is_some_and(|end| end - start_ms < 1000) {
        return Err(Error::new(
            "invalid_segment_timestamps",
            "The manual marker timestamps are invalid.",
        ));
    }
    Ok((start_ms, end_ms))
}

fn load_candidates(db: &Connection, revision: &str, current_only: bool) -> Result<Vec<Candidate>> {
    let sql = if current_only {
        format!("SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates WHERE file_revision=? AND (expires_at IS NULL OR expires_at>?)")
    } else {
        format!("SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates WHERE file_revision=?")
    };
    let values = if current_only {
        vec![SqlValue::Text(revision.into()), SqlValue::Integer(now())]
    } else {
        vec![SqlValue::Text(revision.into())]
    };
    query_candidates(db, &sql, values)
}

fn load_candidates_matching(
    db: &Connection,
    revision: &str,
    id: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Candidate>> {
    let (extra, value) = if let Some(id) = id {
        ("id=?", id)
    } else {
        ("type=?", kind.unwrap_or_default())
    };
    let sql = format!("SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates WHERE file_revision=? AND {extra} AND source='manual'");
    query_candidates(
        db,
        &sql,
        vec![
            SqlValue::Text(revision.into()),
            SqlValue::Text(value.into()),
        ],
    )
}

fn load_candidate_by_id(db: &Connection, id: &str) -> Result<Option<Candidate>> {
    let sql = format!("SELECT {CANDIDATE_COLUMNS} FROM media_segment_candidates WHERE id=?");
    Ok(query_candidates(db, &sql, vec![SqlValue::Text(id.into())])?
        .into_iter()
        .next())
}

fn query_candidates(db: &Connection, sql: &str, values: Vec<SqlValue>) -> Result<Vec<Candidate>> {
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map(params_from_iter(values.iter()), candidate_from_row)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn candidate_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: row.get(0)?,
        media_id: row.get(1)?,
        season: row.get(2)?,
        episode: row.get(3)?,
        file_path: row.get(4)?,
        file_revision: row.get(5)?,
        release_key: row.get(6)?,
        kind: row.get(7)?,
        start_ms: row.get(8)?,
        end_ms: row.get(9)?,
        confidence: row.get(10)?,
        source: row.get(11)?,
        status: row.get(12)?,
        media_duration_ms: row.get(13)?,
        updated_at: row.get(14)?,
        expires_at: row.get(15)?,
        analysis_metadata: row.get(16)?,
    })
}

fn insert_candidate(db: &Connection, candidate: &Candidate) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO media_segment_candidates (id,media_id,season,episode,file_path,file_revision,release_key,type,start_ms,end_ms,confidence,source,status,media_duration_ms,updated_at,expires_at,analysis_metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![candidate.id,candidate.media_id,candidate.season,candidate.episode,candidate.file_path,candidate.file_revision,candidate.release_key,candidate.kind,candidate.start_ms,candidate.end_ms,candidate.confidence,candidate.source,candidate.status,candidate.media_duration_ms,candidate.updated_at,candidate.expires_at,candidate.analysis_metadata],
    )?;
    Ok(())
}

fn save_history(db: &Connection, candidate: &Candidate, action: &str) -> Result<()> {
    db.execute(
        "INSERT INTO segment_manual_history (candidate_id,action,snapshot_json,changed_at) VALUES (?,?,?,?)",
        params![candidate.id, action, candidate_json(candidate)?.to_string(), now()],
    )?;
    Ok(())
}

fn refresh_resolved(db: &Connection, revision: &str) -> Result<Vec<Candidate>> {
    let segments = resolve_candidates(load_candidates(db, revision, true)?);
    db.execute(
        "DELETE FROM media_segments WHERE file_revision=?",
        [revision],
    )?;
    for segment in &segments {
        db.execute(
            "INSERT INTO media_segments (file_revision,type,id,start_ms,end_ms,confidence,source,media_duration_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            params![revision,segment.kind,segment.id,segment.start_ms,segment.end_ms,segment.confidence,segment.source,segment.media_duration_ms,segment.updated_at],
        )?;
    }
    Ok(segments)
}

fn resolve_candidates(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.retain(|candidate| candidate.status == "active");
    candidates.sort_by(candidate_rank);
    let mut winners = Vec::new();
    for kind in SEGMENT_TYPES {
        let values = candidates
            .iter()
            .filter(|candidate| candidate.kind == *kind)
            .collect::<Vec<_>>();
        let Some(winner) = values.first() else {
            continue;
        };
        if *kind == "credits" {
            let winning_source = winner.source.clone();
            winners.extend(
                values
                    .into_iter()
                    .filter(|candidate| candidate.source == winning_source)
                    .cloned(),
            );
        } else {
            winners.push((*winner).clone());
        }
    }
    winners.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| type_order(&left.kind).cmp(&type_order(&right.kind)))
    });
    winners
}

fn candidate_rank(left: &Candidate, right: &Candidate) -> Ordering {
    source_order(&left.source)
        .cmp(&source_order(&right.source))
        .then_with(|| {
            if left.source == "aniskip" && right.source == "theintrodb" {
                Ordering::Less
            } else if left.source == "theintrodb" && right.source == "aniskip" {
                Ordering::Greater
            } else {
                right.updated_at.cmp(&left.updated_at)
            }
        })
}

fn source_order(source: &str) -> u8 {
    match source {
        "manual" => 0,
        "chapter" => 1,
        "aniskip" | "theintrodb" => 2,
        "chromaprint" => 3,
        _ => 255,
    }
}

fn type_order(kind: &str) -> u8 {
    match kind {
        "recap" => 0,
        "intro" => 1,
        "outro" => 2,
        "credits" => 3,
        "preview" => 4,
        _ => 255,
    }
}

fn segment_response(segments: &[Candidate]) -> Result<Value> {
    Ok(json!({
        "segments": segments.iter().map(segment_json).collect::<Result<Vec<_>>>()?,
        "revision": segment_revision(segments)?,
    }))
}

fn segment_json(candidate: &Candidate) -> Result<Value> {
    let mut object = Map::new();
    object.insert("id".into(), json!(candidate.id));
    object.insert("type".into(), json!(candidate.kind));
    object.insert("startMs".into(), json!(candidate.start_ms));
    object.insert("endMs".into(), json!(candidate.end_ms));
    object.insert("confidence".into(), json!(candidate.confidence));
    object.insert("source".into(), json!(candidate.source));
    object.insert("mediaDurationMs".into(), json!(candidate.media_duration_ms));
    object.insert(
        "updatedAt".into(),
        json!(iso_timestamp(candidate.updated_at)?),
    );
    if let Some(metadata) = valid_analysis_metadata(candidate.analysis_metadata.as_deref()) {
        object.insert("analysisMetadata".into(), metadata);
    }
    Ok(Value::Object(object))
}

fn managed_segment_json(candidate: &Candidate) -> Result<Value> {
    let mut object = segment_json(candidate)?
        .as_object()
        .cloned()
        .expect("segment JSON is an object");
    object.insert("mediaId".into(), json!(candidate.media_id));
    object.insert("season".into(), json!(candidate.season));
    object.insert("episode".into(), json!(candidate.episode));
    object.insert("status".into(), json!(candidate.status));
    Ok(Value::Object(object))
}

fn candidate_json(candidate: &Candidate) -> Result<Value> {
    let mut object = managed_segment_json(candidate)?
        .as_object()
        .cloned()
        .expect("managed segment JSON is an object");
    object.insert("filePath".into(), json!(candidate.file_path));
    object.insert("fileRevision".into(), json!(candidate.file_revision));
    if let Some(release_key) = &candidate.release_key {
        object.insert("releaseKey".into(), json!(release_key));
    }
    if let Some(expires_at) = candidate.expires_at {
        object.insert("expiresAt".into(), json!(expires_at));
    }
    Ok(Value::Object(object))
}

fn candidate_from_json(value: &Value) -> Result<Candidate> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument("Invalid segment history."))?;
    let kind = required_segment_type(object.get("type"))?;
    let source = required_enum(
        object.get("source"),
        &["manual", "chapter", "theintrodb", "aniskip", "chromaprint"],
        "source",
    )?;
    let status = required_enum(object.get("status"), SEGMENT_STATUSES, "status")?;
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .ok_or_else(|| invalid_argument("Invalid segment history timestamp."))?;
    Ok(Candidate {
        id: required_string(object.get("id"), 16_384, "id")?.into(),
        media_id: required_string(object.get("mediaId"), 16_384, "mediaId")?.into(),
        season: required_i64(object.get("season"), "season")?,
        episode: required_i64(object.get("episode"), "episode")?,
        file_path: required_string(object.get("filePath"), 16_384, "filePath")?.into(),
        file_revision: required_string(object.get("fileRevision"), 16_384, "fileRevision")?.into(),
        release_key: optional_string(object.get("releaseKey"), 16_384, "releaseKey")?,
        kind: kind.into(),
        start_ms: required_i64(object.get("startMs"), "startMs")?,
        end_ms: optional_i64(object.get("endMs"), "endMs")?,
        confidence: required_number(object.get("confidence"), "confidence")?,
        source: source.into(),
        status: status.into(),
        media_duration_ms: required_i64(object.get("mediaDurationMs"), "mediaDurationMs")?,
        updated_at,
        expires_at: optional_i64(object.get("expiresAt"), "expiresAt")?,
        analysis_metadata: object.get("analysisMetadata").map(Value::to_string),
    })
}

fn segment_revision(segments: &[Candidate]) -> Result<String> {
    let canonical = segments
        .iter()
        .map(|segment| RevisionSegment {
            kind: &segment.kind,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            source: &segment.source,
            media_duration_ms: segment.media_duration_ms,
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&canonical)?;
    Ok(hex_prefix(Sha256::digest(encoded).as_slice(), 16))
}

fn valid_analysis_metadata(raw: Option<&str>) -> Option<Value> {
    let value = raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())?;
    let source = value.as_object()?;
    let mut clean = Map::new();

    if let Some(value) = source.get("detector") {
        let detector = value.as_str()?;
        if !["chromaprint", "blackframe", "chapter"].contains(&detector) {
            return None;
        }
        clean.insert("detector".into(), value.clone());
    }
    for key in ["peerSupport", "originalStartMs"] {
        if let Some(value) = source.get(key) {
            value.as_f64()?;
            clean.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = source.get("originalEndMs") {
        if !value.is_null() {
            value.as_f64()?;
        }
        clean.insert("originalEndMs".into(), value.clone());
    }
    for key in ["startSnap", "endSnap"] {
        if let Some(value) = source.get(key) {
            let snap = value.as_str()?;
            if !["chapter", "silence", "keyframe", "media-edge", "original"].contains(&snap) {
                return None;
            }
            clean.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = source.get("confidenceComponents") {
        let components = value.as_object()?;
        if components.values().any(|value| value.as_f64().is_none()) {
            return None;
        }
        clean.insert("confidenceComponents".into(), value.clone());
    }
    if let Some(value) = source.get("userDecision") {
        let decision = value.as_object()?;
        let mut normalized = Map::new();
        if let Some(status) = decision.get("status") {
            let status_value = status.as_str()?;
            if !["active", "rejected"].contains(&status_value) {
                return None;
            }
            normalized.insert("status".into(), status.clone());
        }
        if let Some(kind) = decision.get("type") {
            let kind_value = kind.as_str()?;
            if !SEGMENT_TYPES.contains(&kind_value) {
                return None;
            }
            normalized.insert("type".into(), kind.clone());
        }
        clean.insert("userDecision".into(), Value::Object(normalized));
    }
    Some(Value::Object(clean))
}

fn default_audio_track(metadata: &Map<String, Value>) -> i64 {
    let tracks = metadata.get("tracks").and_then(Value::as_array);
    let audio = tracks.and_then(|tracks| {
        tracks
            .iter()
            .find(|track| {
                track.get("type").and_then(Value::as_str) == Some("audio")
                    && track.get("default").and_then(Value::as_bool) == Some(true)
            })
            .or_else(|| {
                tracks
                    .iter()
                    .find(|track| track.get("type").and_then(Value::as_str) == Some("audio"))
            })
    });
    audio
        .and_then(|track| track.get("index"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn hash_parts(parts: &[&str], hex_length: usize) -> String {
    let digest = Sha256::digest(parts.join("|").as_bytes());
    hex_prefix(digest.as_slice(), hex_length)
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    bytes
        .iter()
        .flat_map(|byte| format!("{byte:02x}").chars().collect::<Vec<_>>())
        .take(length)
        .collect()
}

fn iso_timestamp(timestamp: i64) -> Result<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| Error::new("invalid_data", "A stored segment timestamp is invalid."))
}

fn required_segment_type(value: Option<&Value>) -> Result<&str> {
    required_enum(value, SEGMENT_TYPES, "type")
}

fn required_enum<'a>(value: Option<&'a Value>, allowed: &[&str], name: &str) -> Result<&'a str> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .ok_or_else(|| invalid_argument(format!("{name} is invalid.")))?;
    Ok(value)
}

fn optional_enum<'a>(
    value: Option<&'a Value>,
    allowed: &[&str],
    name: &str,
) -> Result<Option<&'a str>> {
    value
        .map(|value| required_enum(Some(value), allowed, name))
        .transpose()
}

fn required_string<'a>(value: Option<&'a Value>, max: usize, name: &str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max && !value.contains('\0'))
        .ok_or_else(|| invalid_argument(format!("{name} must be a nonempty string.")))
}

fn optional_string(value: Option<&Value>, max: usize, name: &str) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value
        .as_str()
        .filter(|value| value.len() <= max && !value.contains('\0'))
        .ok_or_else(|| invalid_argument(format!("{name} must be a string.")))?;
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn required_number(value: Option<&Value>, name: &str) -> Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid_argument(format!("{name} must be a finite number.")))
}

fn optional_nonnegative_number(value: Option<&Value>, name: &str) -> Result<Option<f64>> {
    value
        .map(|value| {
            required_number(Some(value), name).and_then(|number| {
                if number >= 0.0 {
                    Ok(number)
                } else {
                    Err(invalid_argument(format!("{name} cannot be negative.")))
                }
            })
        })
        .transpose()
}

fn floor_nonnegative(value: f64) -> Result<i64> {
    let value = value.floor();
    if value <= i64::MAX as f64 {
        Ok(value as i64)
    } else {
        Err(invalid_argument("The segment index is too large."))
    }
}

fn required_i64(value: Option<&Value>, name: &str) -> Result<i64> {
    value
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_argument(format!("{name} must be an integer.")))
}

fn optional_i64(value: Option<&Value>, name: &str) -> Result<Option<i64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        value => required_i64(value, name).map(Some),
    }
}

fn invalid_argument(message: impl Into<String>) -> Error {
    Error::new("invalid_argument", message)
}

fn segment_probe_required() -> Error {
    Error::new(
        "segment_probe_required",
        "This media file needs duration metadata before segments can be resolved.",
    )
}
