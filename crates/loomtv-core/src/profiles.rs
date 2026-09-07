use crate::{now, number, string, Error, Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

impl Store {
    pub fn sync_desktop_selection(&mut self) -> Result<()> {
        let saved: Option<(String, i64, bool, bool)> = self.db.query_row(
            "SELECT s.profile_id,s.selection_revision,s.automatic_sign_in,p.pin_hash IS NOT NULL FROM device_profile_selections s JOIN profiles p ON p.id=s.profile_id WHERE s.device_id='desktop-primary'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        match saved {
            Some((id, revision, automatic, has_pin)) if revision != self.revision || self.active.as_deref() != Some(&id) => {
                self.revision = revision;
                self.active = if automatic && !has_pin { Some(id) } else { None };
                self.unlocked_until = 0;
            }
            None => { self.active = None; self.unlocked_until = 0; }
            _ => {},
        }
        Ok(())
    }

    pub fn selection_revision(&self) -> i64 {
        self.revision
    }

    pub fn require_active(&self, expected: Option<&str>) -> Result<String> {
        let id = self
            .active
            .as_ref()
            .ok_or_else(|| Error::new("profile_required", "Choose a profile to continue."))?;
        if expected.is_some_and(|expected| expected != id) {
            return Err(Error::new(
                "stale_profile_selection",
                "The active profile changed.",
            ));
        }
        let selected: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM device_profile_selections WHERE device_id='desktop-primary' AND profile_id=? AND selection_revision=?)",
            params![id, self.revision], |row| row.get(0),
        )?;
        if !selected {
            return Err(Error::new("stale_profile_selection", "The active profile changed."));
        }
        let (_kind, has_pin): (String, bool) = self.db.query_row(
            "SELECT profile_type,pin_hash IS NOT NULL FROM profiles WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if has_pin && now() >= self.unlocked_until {
            return Err(Error::new(
                "profile_locked",
                "Unlock the active profile to continue.",
            ));
        }
        Ok(id.clone())
    }
    pub fn require_owner(&self) -> Result<String> {
        let id = self.require_active(None)?;
        let owner: bool = self.db.query_row(
            "SELECT profile_type='owner' FROM profiles WHERE id=?",
            [&id],
            |r| r.get(0),
        )?;
        if !owner {
            return Err(Error::new(
                "owner_required",
                "An owner profile is required.",
            ));
        }
        Ok(id)
    }
    pub(crate) fn bump_selection(&mut self) -> Result<()> {
        self.revision = self.db.query_row(
            "INSERT INTO device_profile_selection_revisions VALUES ('desktop-primary',1) ON CONFLICT(device_id) DO UPDATE SET revision=revision+1 RETURNING revision",
            [], |row| row.get(0),
        )?;
        Ok(())
    }
    pub fn profiles(&self) -> Result<Value> {
        let mut stmt=self.db.prepare("SELECT id,name,avatar_key,color_key,profile_type,pin_hash IS NOT NULL,is_guest,sort_order,last_used_at FROM profiles ORDER BY sort_order,created_at,id")?;
        let rows=stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"avatarKey":r.get::<_,String>(2)?,"colorKey":r.get::<_,String>(3)?,"type":r.get::<_,String>(4)?,"hasPin":r.get::<_,bool>(5)?,"isGuest":r.get::<_,bool>(6)?,"sortOrder":r.get::<_,i64>(7)?,"lastUsedAt":r.get::<_,Option<i64>>(8)?.unwrap_or(0)})))?;
        Ok(Value::Array(
            rows.collect::<std::result::Result<Vec<_>, _>>()?,
        ))
    }
    pub fn active_state(&self) -> Result<Value> {
        let automatic: bool=self.db.query_row("SELECT automatic_sign_in FROM device_profile_selections WHERE device_id='desktop-primary'",[],|r|r.get(0)).optional()?.unwrap_or(false);
        Ok(
            json!({"profileId":self.active,"selectionRequired":self.active.is_none(),"selectionRevision":self.revision,"automaticSignIn":automatic}),
        )
    }
    pub fn select_profile(&mut self, id: &str, pin: Option<&str>) -> Result<Value> {
        self.failures
            .retain(|_, (_, until)| *until + 14_400_000 > now());
        if self
            .failures
            .get(id)
            .is_some_and(|(_, until)| *until > now())
        {
            return Err(Error::new(
                "profile_locked",
                "Wait before trying this PIN again.",
            ));
        }
        let credentials: Option<(Option<String>, Option<String>)> = self
            .db
            .query_row(
                "SELECT pin_hash,pin_salt FROM profiles WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (hash, salt) = credentials
            .ok_or_else(|| Error::new("profile_not_found", "This profile no longer exists."))?;
        let has_pin = hash.is_some();
        if let Some(hash) = hash {
            let expected = STANDARD
                .decode(hash)
                .map_err(|_| Error::new("invalid_credentials", "The stored PIN is invalid."))?;
            let salt = STANDARD
                .decode(salt.unwrap_or_default())
                .map_err(|_| Error::new("invalid_credentials", "The stored PIN is invalid."))?;
            let mut actual = [0; 32];
            let pin = pin.unwrap_or("");
            let valid = pin.len() == 4 && pin.bytes().all(|c| c.is_ascii_digit());
            if valid {
                scrypt::scrypt(
                    pin.as_bytes(),
                    &salt,
                    &scrypt::Params::new(14, 8, 1, 32)
                        .map_err(|_| Error::new("crypto_error", "PIN hashing failed."))?,
                    &mut actual,
                )
                .map_err(|_| Error::new("crypto_error", "PIN hashing failed."))?;
            }
            if !valid || expected.len() != 32 || !bool::from(actual.as_slice().ct_eq(&expected)) {
                let count = self
                    .failures
                    .get(id)
                    .map(|(count, _)| count + 1)
                    .unwrap_or(1);
                self.failures.insert(
                    id.into(),
                    (
                        count,
                        now() + ((1_i64 << count.min(10)) * 1000).min(900_000),
                    ),
                );
                return Err(Error::new("profile_locked", "The PIN is incorrect."));
            }
        }
        self.failures.remove(id);
        let guest: bool =
            self.db
                .query_row("SELECT is_guest FROM profiles WHERE id=?", [id], |row| {
                    row.get(0)
                })?;
        let automatic = !has_pin && !guest;
        if self.active.as_deref() != Some(id) {
            self.db.execute("DELETE FROM profiles WHERE is_guest=1 AND guest_device_id='desktop-primary' AND id!=?",[id])?;
        }
        self.bump_selection()?;
        self.db.execute("INSERT INTO device_profile_selections (device_id,profile_id,selected_at,selection_revision,automatic_sign_in) VALUES ('desktop-primary',?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET automatic_sign_in=CASE WHEN device_profile_selections.profile_id=excluded.profile_id THEN device_profile_selections.automatic_sign_in ELSE excluded.automatic_sign_in END,profile_id=excluded.profile_id,selected_at=excluded.selected_at,selection_revision=excluded.selection_revision", params![id,now(),self.revision,automatic])?;
        self.db.execute(
            "UPDATE profiles SET last_used_at=? WHERE id=?",
            params![now(), id],
        )?;
        self.active = Some(id.into());
        self.unlocked_until = now() + 14_400_000;
        self.profiles()?
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == id))
            .cloned()
            .ok_or_else(|| Error::new("profile_not_found", "This profile no longer exists."))
    }
    pub fn create_profile(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM profiles WHERE is_guest=0",
            [],
            |row| row.get(0),
        )?;
        if count >= 10 {
            return Err(Error::new(
                "profile_limit",
                "LoomTV supports up to 10 profiles.",
            ));
        }
        let name = input["name"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && v.len() <= 80)
            .ok_or_else(|| {
                Error::new(
                    "invalid_profile",
                    "Enter a profile name of at most 80 characters.",
                )
            })?;
        let kind = input["type"].as_str().unwrap_or("standard");
        if !["standard", "kid"].contains(&kind) {
            return Err(Error::new(
                "invalid_profile",
                "Choose a standard or child profile.",
            ));
        }
        self.db.execute("INSERT INTO profiles (id,name,avatar_key,color_key,profile_type,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM profiles))", params![uuid::Uuid::new_v4().to_string(),name,input["avatarKey"].as_str().unwrap_or("glyph-01"),input["colorKey"].as_str().unwrap_or("ember"),kind,now(),now()])?;
        self.profiles()
    }
    pub fn update_profile(&mut self, id: &str, patch: &Value) -> Result<Value> {
        self.require_owner()?;
        let old = self
            .profiles()?
            .as_array()
            .and_then(|v| v.iter().find(|p| p["id"] == id))
            .cloned()
            .ok_or_else(|| Error::new("profile_not_found", "This profile no longer exists."))?;
        if old["isGuest"] == true {
            return Err(Error::new(
                "guest_profile",
                "Guest profiles cannot be edited.",
            ));
        }
        let kind = if old["type"] == "owner" {
            "owner"
        } else {
            patch["type"]
                .as_str()
                .unwrap_or(old["type"].as_str().unwrap_or("standard"))
        };
        if !["owner", "standard", "kid"].contains(&kind) {
            return Err(Error::new(
                "invalid_profile",
                "Choose a standard or child profile.",
            ));
        }
        let name = patch["name"]
            .as_str()
            .unwrap_or(old["name"].as_str().unwrap_or(""));
        if name.trim().is_empty() || name.len() > 80 {
            return Err(Error::new(
                "invalid_profile",
                "Enter a profile name of at most 80 characters.",
            ));
        }
        self.db.execute(
            "UPDATE profiles SET name=?,avatar_key=?,color_key=?,profile_type=?,updated_at=? WHERE id=?",
            params![
                name.trim(),
                patch["avatarKey"].as_str().or(old["avatarKey"].as_str()),
                patch["colorKey"].as_str().or(old["colorKey"].as_str()),
                kind,
                now(),
                id
            ],
        )?;
        self.profiles()
    }
    pub fn set_pin(&mut self, id: &str, pin: Option<&str>) -> Result<Value> {
        let active = self.require_active(None)?;
        if active != id {
            self.require_owner()?;
        }
        let guest: bool =
            self.db
                .query_row("SELECT is_guest FROM profiles WHERE id=?", [id], |row| {
                    row.get(0)
                })?;
        if guest {
            return Err(Error::new(
                "guest_profile",
                "Guest profiles cannot use a PIN.",
            ));
        }
        let (hash, salt) = if let Some(pin) = pin {
            if pin.len() != 4 || !pin.bytes().all(|c| c.is_ascii_digit()) {
                return Err(Error::new(
                    "invalid_pin",
                    "PINs must contain exactly four digits.",
                ));
            }
            let salt = uuid::Uuid::new_v4();
            let mut hash = [0; 32];
            scrypt::scrypt(
                pin.as_bytes(),
                salt.as_bytes(),
                &scrypt::Params::new(14, 8, 1, 32)
                    .map_err(|_| Error::new("crypto_error", "PIN hashing failed."))?,
                &mut hash,
            )
            .map_err(|_| Error::new("crypto_error", "PIN hashing failed."))?;
            (
                Some(STANDARD.encode(hash)),
                Some(STANDARD.encode(salt.as_bytes())),
            )
        } else {
            (None, None)
        };
        self.db.execute(
            "UPDATE profiles SET pin_hash=?,pin_salt=?,updated_at=? WHERE id=?",
            params![hash, salt, now(), id],
        )?;
        if pin.is_some() {
            self.db.execute(
                "UPDATE device_profile_selections SET automatic_sign_in=0 WHERE profile_id=?",
                [id],
            )?;
        }
        if active == id {
            self.unlocked_until = now() + 14_400_000;
        }
        self.profiles()?
            .as_array()
            .and_then(|v| v.iter().find(|p| p["id"] == id))
            .cloned()
            .ok_or_else(|| Error::new("profile_not_found", "This profile no longer exists."))
    }
    pub fn lock_profile(&mut self) -> Result<Value> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM device_profile_selections WHERE device_id='desktop-primary'",
            [],
        )?;
        tx.execute(
            "DELETE FROM profiles WHERE is_guest=1 AND guest_device_id='desktop-primary'",
            [],
        )?;
        tx.commit()?;
        self.active = None;
        self.unlocked_until = 0;
        self.bump_selection()?;
        self.active_state()
    }
    pub fn guest_profile(&mut self) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM profiles WHERE is_guest=1 AND guest_device_id='desktop-primary'",
            [],
        )?;
        tx.execute("INSERT INTO profiles (id,name,avatar_key,color_key,profile_type,created_at,updated_at,sort_order,is_guest,guest_device_id) VALUES (?,'Guest','glyph-12','slate','guest',?,?,9999,1,'desktop-primary')",params![id,now(),now()])?;
        tx.commit()?;
        self.select_profile(&id, None)
    }
    pub fn reorder_profiles(&mut self, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let requested = input
            .as_array()
            .filter(|rows| rows.len() <= 10)
            .ok_or_else(|| Error::new("invalid_profiles", "Choose a valid profile order."))?;
        let existing = self.profiles()?;
        let existing = existing
            .as_array()
            .ok_or_else(|| Error::new("invalid_profiles", "The profile list is invalid."))?;
        let permanent = existing
            .iter()
            .filter(|p| p["isGuest"] != true)
            .filter_map(|p| p["id"].as_str())
            .collect::<Vec<_>>();
        let mut order = Vec::new();
        for id in requested
            .iter()
            .filter_map(Value::as_str)
            .chain(permanent.iter().copied())
        {
            if permanent.contains(&id) && !order.contains(&id) {
                order.push(id);
            }
        }
        let tx = self.db.transaction()?;
        for (index, id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE profiles SET sort_order=?,updated_at=? WHERE id=?",
                params![index as i64, now(), id],
            )?;
        }
        tx.commit()?;
        self.profiles()
    }
    pub fn reset_owner(&mut self, confirmation: &str) -> Result<Value> {
        if confirmation != "RESET" {
            return Err(Error::new(
                "confirmation_required",
                "Enter RESET to confirm.",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM profiles WHERE profile_type='owner'", [])?;
        tx.execute("INSERT INTO profiles (id,name,avatar_key,color_key,profile_type,created_at,updated_at,sort_order) VALUES (?,'Owner','glyph-01','ember','owner',?,?,0)",params![id,now(),now()])?;
        tx.commit()?;
        self.active = None;
        self.unlocked_until = 0;
        self.failures.clear();
        self.select_profile(&id, None)
    }
    pub fn preferences(&self) -> Result<Value> {
        let id = self.require_active(None)?;
        let text: Option<String> = self
            .db
            .query_row(
                "SELECT preferences_json FROM profile_preferences WHERE profile_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(serde_json::from_str(text.as_deref().unwrap_or("{}"))?)
    }
    pub fn save_preferences(&mut self, args: &[Value]) -> Result<Value> {
        let id = self.require_active(args.get(1).and_then(Value::as_str))?;
        let mut result = self.preferences()?;
        let patch = args
            .first()
            .and_then(Value::as_object)
            .ok_or_else(|| Error::new("invalid_preferences", "Preferences must be an object."))?;
        crate::settings::validate(
            &Value::Object(patch.clone()),
            include_str!("../schemas/preferences.json"),
        )?;
        for (key, value) in patch {
            result[key] = value.clone();
        }
        self.db.execute("INSERT INTO profile_preferences VALUES (?,?,1,?) ON CONFLICT(profile_id) DO UPDATE SET preferences_json=excluded.preferences_json,revision=revision+1,updated_at=excluded.updated_at",params![id,result.to_string(),now()])?;
        Ok(result)
    }
    pub fn lists(&self, kind: Option<&str>) -> Result<Value> {
        let id = self.require_active(None)?;
        let mut stmt=self.db.prepare("SELECT media_id,list_kind,created_at FROM profile_media_lists WHERE profile_id=? AND (? IS NULL OR list_kind=?) ORDER BY created_at DESC")?;
        let rows=stmt.query_map(params![id,kind,kind],|r|Ok(json!({"mediaId":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?})))?;
        Ok(Value::Array(
            rows.collect::<std::result::Result<Vec<_>, _>>()?,
        ))
    }
    pub fn set_list(&mut self, args: &[Value]) -> Result<Value> {
        let id = self.require_active(args.get(3).and_then(Value::as_str))?;
        let media = string(args, 0)?;
        let kind = string(args, 1)?;
        let present = args
            .get(2)
            .and_then(Value::as_bool)
            .ok_or_else(|| Error::new("invalid_argument", "Expected a boolean."))?;
        if !["watchlist", "favorite", "watched"].contains(&kind) {
            return Err(Error::new(
                "invalid_list",
                "Choose a supported profile list.",
            ));
        }
        if present {
            self.db.execute(
                "INSERT OR IGNORE INTO profile_media_lists VALUES (?,?,?,?)",
                params![id, media, kind, now()],
            )?;
        } else {
            self.db.execute(
                "DELETE FROM profile_media_lists WHERE profile_id=? AND media_id=? AND list_kind=?",
                params![id, media, kind],
            )?;
        }
        self.lists(None)
    }
    pub fn progress(&self, path: Option<&str>) -> Result<Value> {
        let id = self.require_active(None)?;
        let mut stmt=self.db.prepare("SELECT file_path,position,duration,updated_at,watched FROM playback_progress WHERE profile_id=? AND (? IS NULL OR file_path=?)")?;
        let rows=stmt.query_map(params![id,path,path],|r|Ok((r.get::<_,String>(0)?,json!({"position":r.get::<_,f64>(1)?,"duration":r.get::<_,f64>(2)?,"updatedAt":r.get::<_,i64>(3)?,"watched":r.get::<_,bool>(4)?}))))?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (key, value) = row?;
            map.insert(key, value);
        }
        Ok(match path {
            Some(path) => map.remove(path).unwrap_or(Value::Null),
            None => Value::Object(map),
        })
    }
    pub fn save_progress(&mut self, args: &[Value]) -> Result<Value> {
        let id = self.require_active(args.get(3).and_then(Value::as_str))?;
        let path = string(args, 0)?;
        let position = number(args, 1)?.max(0.);
        let duration = number(args, 2)?.max(0.);
        self.db.execute(
            "INSERT OR REPLACE INTO playback_progress VALUES (?,?,?,?,?,?)",
            params![
                id,
                path,
                position,
                duration,
                now(),
                duration > 0. && position / duration >= 0.9
            ],
        )?;
        self.progress(Some(path))
    }
    pub fn track_preferences(&self, scope: Option<&str>) -> Result<Value> {
        let id = self.require_active(None)?;
        let mut stmt=self.db.prepare("SELECT scope,preferences_json FROM playback_track_preferences WHERE profile_id=? AND (? IS NULL OR scope=?)")?;
        let rows = stmt.query_map(params![id, scope, scope], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (key, text) = row?;
            map.insert(key, serde_json::from_str(&text)?);
        }
        Ok(match scope {
            Some(scope) => map.remove(scope).unwrap_or(json!({})),
            None => Value::Object(map),
        })
    }
    pub fn save_track_preferences(&mut self, args: &[Value]) -> Result<Value> {
        let id = self.require_active(args.get(2).and_then(Value::as_str))?;
        let scope = string(args, 0)?;
        let value = args.get(1).filter(|v| v.is_object()).ok_or_else(|| {
            Error::new(
                "invalid_preferences",
                "Track preferences must be an object.",
            )
        })?;
        self.db.execute(
            "INSERT OR REPLACE INTO playback_track_preferences VALUES (?,?,?,?)",
            params![id, scope, value.to_string(), now()],
        )?;
        self.track_preferences(Some(scope))
    }
}
