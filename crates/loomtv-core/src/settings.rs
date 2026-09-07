use crate::{now, Error, Result, Store};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn validate(value: &Value, schema: &str) -> Result<()> {
    let schema: Value = serde_json::from_str(schema)?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|_| Error::new("schema_error", "The validation schema could not be loaded."))?;
    if !validator.is_valid(value) {
        return Err(Error::new(
            "invalid_argument",
            "The supplied values do not match the desktop contract.",
        ));
    }
    Ok(())
}
impl Store {
    pub fn settings_for_renderer(&self) -> Result<Value> {
        let mut settings = self.settings()?;
        if let Some(settings) = settings.as_object_mut() {
            settings.remove("__secretRef");
            for key in [
                "localNetworkHmacSecret",
                "localNetworkPairedDevices",
                "localNetworkShareToken",
                "localNetworkAccessToken",
            ] {
                settings.remove(key);
            }
            if self.require_owner().is_err() {
                for key in [
                    "omdbApiKey",
                    "tmdbApiKey",
                    "metadataApiKeys",
                    "openSubtitlesUsername",
                    "openSubtitlesPassword",
                ] {
                    settings.remove(key);
                }
            }
        }
        Ok(settings)
    }
    pub fn metadata_settings(&self) -> Result<Value> {
        self.require_active(None)?;
        self.settings()
    }
    pub fn save_settings(&mut self, patch: &Value) -> Result<Value> {
        self.require_owner()?;
        validate(patch, include_str!("../schemas/settings.json"))?;
        let patch = patch
            .as_object()
            .ok_or_else(|| Error::new("invalid_settings", "Settings must be an object."))?;
        // Match Electron's app_settings record so both desktop shells read the same API keys.
        // Unexposed host fields survive a renderer patch.
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row("SELECT data_json FROM app_settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let mut merged: Value = serde_json::from_str(current.as_deref().unwrap_or("{}"))?;
        for (key, value) in patch {
            merged[key] = value.clone();
        }
        if let Some(settings) = merged.as_object_mut() {
            settings.remove("__secretRef");
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings VALUES (1,?,?)",
            params![merged.to_string(), now()],
        )?;
        tx.commit()?;
        Ok(json!(true))
    }
}

impl Store {
    /// Native picker only. This machine-specific executable selection is not a generic renderer setting.
    pub fn set_mpv_executable(&mut self, path: Option<&str>) -> Result<()> {
        self.require_owner()?;
        if let Some(path) = path {
            if !std::path::Path::new(path).is_absolute()
                || path.len() > 32_768
                || path.contains('\0')
            {
                return Err(Error::new(
                    "invalid_path",
                    "Choose an absolute mpv executable path.",
                ));
            }
        }
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row("SELECT data_json FROM app_settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let mut settings: Value = serde_json::from_str(current.as_deref().unwrap_or("{}"))?;
        let object = settings
            .as_object_mut()
            .ok_or_else(|| Error::new("invalid_settings", "Stored settings are not an object."))?;
        match path {
            Some(path) => {
                object.insert("mpvExecutablePath".into(), json!(path));
            }
            None => {
                object.remove("mpvExecutablePath");
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings VALUES (1,?,?)",
            params![settings.to_string(), now()],
        )?;
        tx.commit()?;
        Ok(())
    }
}
