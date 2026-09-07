use crate::{now, Error, Result, Store};
use rusqlite::params;
use serde_json::{json, Map, Value};

const MAX_IMPORT_ENTRIES: usize = 10_000;
const MAX_IMPORT_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 16_384;
const MAX_PROFILE_ID_BYTES: usize = 16_384;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

struct ImportedProgressRow {
    file_path: String,
    position: f64,
    duration: f64,
    updated_at: i64,
    watched: bool,
}

impl Store {
    pub fn import_progress_data(&mut self, args: &[Value]) -> Result<Value> {
        let expected_profile = expected_profile_id(args.get(1))?;
        let profile_id = self.require_active(expected_profile)?;
        let input = args
            .first()
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("Imported progress must be an object."))?;
        if input.len() > MAX_IMPORT_ENTRIES {
            return Err(Error::new(
                "payload_too_large",
                "The progress import contains too many entries.",
            ));
        }
        if serde_json::to_vec(input)?.len() > MAX_IMPORT_BYTES {
            return Err(Error::new(
                "payload_too_large",
                "The progress import is too large.",
            ));
        }

        let rows = input
            .iter()
            .map(|(file_path, value)| normalize_row(file_path, value, now()))
            .collect::<Result<Vec<_>>>()?;

        let transaction = self.db.transaction()?;
        {
            let mut upsert = transaction.prepare_cached(
                "INSERT INTO playback_progress \
                 (profile_id,file_path,position,duration,updated_at,watched) \
                 VALUES (?,?,?,?,?,?) \
                 ON CONFLICT(profile_id,file_path) DO UPDATE SET \
                 position=excluded.position,duration=excluded.duration,\
                 updated_at=excluded.updated_at,watched=excluded.watched \
                 WHERE excluded.updated_at > playback_progress.updated_at",
            )?;
            for row in rows {
                upsert.execute(params![
                    profile_id,
                    row.file_path,
                    row.position,
                    row.duration,
                    row.updated_at,
                    row.watched,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(json!(true))
    }
}

fn expected_profile_id(value: Option<&Value>) -> Result<Option<&str>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if value.len() <= MAX_PROFILE_ID_BYTES && !value.contains('\0') =>
        {
            Ok(Some(value))
        }
        Some(_) => Err(invalid("The expected profile ID must be a string.")),
    }
}

fn normalize_row(file_path: &str, value: &Value, imported_at: i64) -> Result<ImportedProgressRow> {
    if file_path.len() > MAX_PATH_BYTES || file_path.contains('\0') {
        return Err(invalid("An imported progress path is invalid."));
    }

    let (position, duration, updated_at) = match value {
        Value::Number(_) => (progress_number(value)?, 0.0, imported_at),
        Value::Object(fields) => normalize_fields(fields, imported_at)?,
        _ => {
            return Err(invalid(
                "Each progress value must be a number or progress object.",
            ))
        }
    };
    let watched = duration > 0.0 && position / duration >= 0.9;
    Ok(ImportedProgressRow {
        file_path: file_path.to_owned(),
        position: if watched { duration } else { position },
        duration,
        updated_at,
        watched,
    })
}

fn normalize_fields(fields: &Map<String, Value>, imported_at: i64) -> Result<(f64, f64, i64)> {
    let position = optional_progress_number(fields, "position")?.unwrap_or(0.0);
    let duration = optional_progress_number(fields, "duration")?.unwrap_or(0.0);
    let updated_at = match fields.get("updatedAt") {
        None => imported_at,
        Some(value) => {
            let value = progress_number(value)?;
            if value == 0.0 {
                imported_at
            } else {
                value.trunc() as i64
            }
        }
    };
    Ok((position, duration, updated_at))
}

fn optional_progress_number(fields: &Map<String, Value>, key: &str) -> Result<Option<f64>> {
    fields.get(key).map(progress_number).transpose()
}

fn progress_number(value: &Value) -> Result<f64> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite() && value.abs() <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("Progress values must be finite safe numbers."))?;
    Ok(value)
}

fn invalid(message: &str) -> Error {
    Error::new("invalid_argument", message)
}
