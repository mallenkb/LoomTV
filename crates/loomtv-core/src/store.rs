use crate::{now, string, Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Store {
    pub(crate) db: Connection,
    pub data_dir: PathBuf,
    pub(crate) active: Option<String>,
    pub(crate) revision: i64,
    pub(crate) unlocked_until: i64,
    pub(crate) failures: HashMap<String, (u32, i64)>,
    _lease: crate::storage::StorageLease,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self> {
        Self::open_mode(data_dir, false)
    }

    pub fn open_shared(data_dir: &Path) -> Result<Self> {
        Self::open_mode(data_dir, true)
    }

    fn open_mode(data_dir: &Path, shared: bool) -> Result<Self> {
        let lease = if shared {
            crate::storage::StorageLease::acquire_shared(data_dir)?
        } else {
            crate::storage::StorageLease::acquire(data_dir)?
        };
        let db_path = data_dir.join("loomtv.sqlite");
        let fresh = !db_path.exists();
        if fresh {
            crate::storage::create_private(&db_path)?;
        }
        let mut db = crate::storage::connection(&db_path, false)?;
        if !fresh {
            crate::storage::validate_version(&db)?;
        }
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "foreign_keys", true)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        if fresh {
            let tx = db.transaction()?;
            tx.execute_batch(include_str!("desktop-schema.sql"))?;
            for version in 1..=14 {
                tx.execute(
                    "INSERT INTO schema_migrations VALUES (?, ?)",
                    params![version, now()],
                )?;
            }
            tx.execute("INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at) VALUES (?, 'Owner', 'glyph-01', 'ember', 'owner', ?, ?)", params![uuid::Uuid::new_v4().to_string(), now(), now()])?;
            tx.commit()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600))?;
        }
        if !shared {
            db.execute(
                "DELETE FROM profiles WHERE is_guest=1 AND guest_device_id='desktop-primary'",
                [],
            )?;
        }
        let revision = db.query_row("SELECT revision FROM device_profile_selection_revisions WHERE device_id = 'desktop-primary'", [], |r| r.get(0)).optional()?.unwrap_or(0);
        let active = db.query_row("SELECT s.profile_id FROM device_profile_selections s JOIN profiles p ON p.id=s.profile_id WHERE s.device_id='desktop-primary' AND s.automatic_sign_in=1 AND p.pin_hash IS NULL", [], |r| r.get(0)).optional()?;
        Ok(Self {
            db,
            data_dir: data_dir.into(),
            active,
            revision,
            unlocked_until: now() + 14_400_000,
            failures: HashMap::new(),
            _lease: lease,
        })
    }

    pub fn invoke(&mut self, channel: &str, args: &[Value]) -> Result<Value> {
        let payload_limit = if channel == "artwork:save" {
            26 * 1024 * 1024
        } else {
            2 * 1024 * 1024
        };
        if args.len() > 8 || serde_json::to_vec(args)?.len() > payload_limit {
            return Err(Error::new(
                "payload_too_large",
                "The desktop request is too large.",
            ));
        }
        match channel {
            channel if channel.starts_with("plugins:stremio:") => {
                Ok(self.invoke_stremio_store(channel, args))
            }
            channel
                if channel.starts_with("playback:segments:")
                    || channel.starts_with("playback:analysis:") =>
            {
                self.segments_invoke(channel, args)
            }
            "database:clear" => self.clear_database(),
            "media:play" => Ok(json!(false)),
            "artwork:playback-logo" => {
                let item = self.library_item(string(args, 0)?)?;
                Ok(
                    json!({"logo":item["item"]["logo"].as_str().unwrap_or(""),"logoCandidates":item["item"]["logoCandidates"].as_array().cloned().unwrap_or_default()}),
                )
            }
            "artwork:import" => self.import_custom_artwork(args),
            "artwork:get" => self.custom_artwork(string(args, 0)?),
            "artwork:save" => self.save_custom_artwork(
                string(args, 0)?,
                string(args, 1)?,
                args.get(2)
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::new("invalid_artwork", "Choose valid artwork."))?,
            ),
            "settings:get" => self.settings_for_renderer(),
            "settings:save" => self.save_settings(args.first().unwrap_or(&Value::Null)),
            "library:get" => self.library(false),
            "library:get-index" => self.library(true),
            "library:get-item" => self.library_item(string(args, 0)?),
            "library:add-folder-path" => {
                self.require_owner()?;
                self.add_folder(string(args, 0)?, string(args, 1)?)?;
                self.library(true)
            }
            "library:remove-folder" => {
                self.require_owner()?;
                self.db.execute(
                    "DELETE FROM library_folders WHERE path=?",
                    [string(args, 0)?],
                )?;
                self.library(true)
            }
            "library:update-folder" => {
                self.require_owner()?;
                let tx = self.db.transaction()?;
                let path = Path::new(string(args, 1)?).canonicalize()?;
                let kind = string(args, 2)?;
                if !["movies", "tvShows", "anime", "others"].contains(&kind) {
                    return Err(Error::new(
                        "invalid_kind",
                        "Choose a supported library type.",
                    ));
                }
                tx.execute(
                    "UPDATE library_folders SET path=?,kind=? WHERE path=?",
                    params![path.to_string_lossy(), kind, string(args, 0)?],
                )?;
                tx.commit()?;
                self.library(true)
            }
            "library:scan" => {
                self.require_owner()?;
                Err(Error::unsupported(channel))
            }
            "media:get-file-info" => {
                let path = self.authorize_media(string(args, 0)?)?;
                let metadata = path.metadata()?;
                Ok(json!({"size":metadata.len(),"path":path,"exists":true}))
            }
            "profiles:list" => self.profiles(),
            "profiles:get-active" => self.active_state(),
            "profiles:select" => {
                self.select_profile(string(args, 0)?, args.get(1).and_then(Value::as_str))
            }
            "profiles:lock" => self.lock_profile(),
            "profiles:select-guest" => self.guest_profile(),
            "profiles:reorder" => self.reorder_profiles(args.first().unwrap_or(&Value::Null)),
            "profiles:reset-owner" => self.reset_owner(string(args, 0)?),
            "profile-restrictions:get" => {
                self.require_owner()?;
                self.restrictions(string(args, 0)?)
            }
            "profile-restrictions:save" => {
                self.save_restrictions(string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            "profiles:create" => self.create_profile(args.first().unwrap_or(&Value::Null)),
            "profiles:update" => {
                self.update_profile(string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            "profiles:delete" => {
                self.require_owner()?;
                self.db.execute(
                    "DELETE FROM profiles WHERE id=? AND profile_type!='owner'",
                    [string(args, 0)?],
                )?;
                self.profiles()
            }
            "profiles:pin" => self.set_pin(string(args, 0)?, args.get(1).and_then(Value::as_str)),
            "profiles:set-auto-sign-in" => {
                let id = self.require_active(None)?;
                let enabled = args
                    .first()
                    .and_then(Value::as_bool)
                    .ok_or_else(|| Error::new("invalid_argument", "Expected a boolean."))?;
                let allowed: bool = self.db.query_row(
                    "SELECT pin_hash IS NULL AND is_guest=0 FROM profiles WHERE id=?",
                    [&id],
                    |r| r.get(0),
                )?;
                if enabled && !allowed {
                    return Err(Error::new(
                        "automatic_sign_in_forbidden",
                        "Automatic sign-in requires a permanent profile without a PIN.",
                    ));
                }
                self.db.execute("UPDATE device_profile_selections SET automatic_sign_in=? WHERE device_id='desktop-primary' AND profile_id=?", params![enabled,id])?;
                self.active_state()
            }
            "profile-preferences:get" => self.preferences(),
            "profile-preferences:save" => self.save_preferences(args),
            "profile-lists:get" => self.lists(args.first().and_then(Value::as_str)),
            "profile-lists:set" => self.set_list(args),
            "progress:import" => self.import_progress_data(args),
            "progress:get" => self.progress(args.first().and_then(Value::as_str)),
            "progress:save" => self.save_progress(args),
            "playback-track-preferences:get" => {
                self.track_preferences(args.first().and_then(Value::as_str))
            }
            "playback-track-preferences:save" => self.save_track_preferences(args),
            "database:backup" => {
                self.require_owner()?;
                let path = crate::storage::backup(&self.db, &self.data_dir.join("backups"))?;
                Ok(json!({"ok":true,"path":path}))
            }
            _ => Err(Error::unsupported(channel)),
        }
    }

    pub fn settings(&self) -> Result<Value> {
        let value: Option<String> = self
            .db
            .query_row("SELECT data_json FROM app_settings WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(match value {
            Some(value) => serde_json::from_str(&value)?,
            None => {
                json!({"metadataOfflineMode":false,"autoSyncIntervalHours":72,"playbackSkipBackSeconds":10,"playbackSkipForwardSeconds":15,"playbackDisplaySleepTimeoutMinutes":0,"appThemeMode":"dark","appThemeColor":"yellow","appDarkTheme":"black","appLoaderStyle":"play-mark"})
            }
        })
    }

    pub fn authorize_media(&self, source: &str) -> Result<PathBuf> {
        self.require_active(None)?;
        self.authorize_content_path(source)?;
        let path = Path::new(source).canonicalize()?;
        if !path.is_file() {
            return Err(Error::new(
                "invalid_media",
                "The media source must be a file.",
            ));
        }
        let mut roots = self.db.prepare("SELECT path FROM library_folders")?;
        let paths = roots.query_map([], |r| r.get::<_, String>(0))?;
        for root in paths {
            if let Ok(root) = Path::new(&root?).canonicalize() {
                if path.starts_with(root) {
                    return Ok(path);
                }
            }
        }
        Err(Error::new(
            "path_forbidden",
            "The source is outside the approved library folders.",
        ))
    }
}
