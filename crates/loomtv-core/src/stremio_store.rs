use crate::{now, Error, Result, Store};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use url::Url;

const MAX_ADDONS: usize = 64;
const MAX_ADDON_ID_CHARS: usize = 240;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
const MAX_AUDIT_LIMIT: usize = 500;
const PEER_WARNING: &str =
    "Peer-to-peer and torrent sources are visible for review but are not playable in LoomTV.";

struct StoredAddon {
    addon_id: String,
    record: Map<String, Value>,
    state: String,
    trusted: bool,
    secure: bool,
    manifest_origin: String,
    manifest_url_redacted: String,
}

struct ProfileRecord {
    id: String,
    kind: String,
    is_guest: bool,
}

impl Store {
    /// Handle the bounded, storage-only Stremio command set using the same
    /// `{ ok, data | error }` envelope as Electron's Stremio IPC handlers.
    pub fn invoke_stremio_store(&mut self, channel: &str, args: &[Value]) -> Value {
        if let Err(error) = validate_request_shape(channel, args) {
            return stremio_wire_result(Err(error));
        }
        let result = match channel {
            "plugins:stremio:list" => self.stremio_list_managed(),
            "plugins:stremio:available" => self.stremio_list_available(),
            "plugins:stremio:official" => Ok(official_addons()),
            "plugins:stremio:review-installed" => required_string(args, 0, MAX_ADDON_ID_CHARS)
                .and_then(|addon_id| self.stremio_review_installed(addon_id)),
            "plugins:stremio:disable" => required_string(args, 0, MAX_ADDON_ID_CHARS)
                .and_then(|addon_id| self.stremio_disable(addon_id)),
            "plugins:stremio:remove" => required_string(args, 0, MAX_ADDON_ID_CHARS)
                .and_then(|addon_id| self.stremio_remove(addon_id)),
            "plugins:stremio:profile-access" => required_string(args, 0, 240)
                .and_then(|profile_id| self.stremio_profile_access(profile_id)),
            "plugins:stremio:set-profile-access" => {
                let mut operation = || -> Result<Value> {
                    let profile_id = required_string(args, 0, 240)?;
                    let addon_id = required_string(args, 1, MAX_ADDON_ID_CHARS)?;
                    let enabled = args.get(2).and_then(Value::as_bool).ok_or_else(|| {
                        stremio_error(
                            "STREMIO_PLUGIN_INVALID_REQUEST",
                            "Choose whether this profile can use the add-on.",
                        )
                    })?;
                    self.stremio_set_profile_access(profile_id, addon_id, enabled)
                };
                operation()
            }
            "plugins:stremio:configuration" => required_string(args, 0, MAX_ADDON_ID_CHARS)
                .and_then(|addon_id| self.stremio_configuration(addon_id)),
            "plugins:stremio:save-configuration" => required_string(args, 0, MAX_ADDON_ID_CHARS)
                .and_then(|addon_id| self.stremio_configuration_write_unsupported(addon_id)),
            "plugins:stremio:audit" => {
                let operation = || -> Result<Value> {
                    let addon_id = required_string(args, 0, MAX_ADDON_ID_CHARS)?;
                    let limit = audit_limit(args.get(1))?;
                    self.stremio_audit(addon_id, limit)
                };
                operation()
            }
            _ => Err(stremio_error(
                "STREMIO_PLUGIN_NOT_IMPLEMENTED",
                "This Stremio add-on operation is not available in the desktop port yet.",
            )),
        };
        stremio_wire_result(result)
    }

    fn stremio_list_managed(&self) -> Result<Value> {
        self.stremio_owner()?;
        Ok(Value::Array(
            load_addons(self)?
                .iter()
                .map(|addon| addon_summary(self, addon))
                .collect::<Result<Vec<_>>>()?,
        ))
    }

    fn stremio_list_available(&self) -> Result<Value> {
        let profile = self.stremio_active_profile()?;
        if profile.is_guest || matches!(profile.kind.as_str(), "guest" | "kid") {
            return Ok(json!([]));
        }
        let grants = if profile.kind == "owner" {
            None
        } else {
            Some(profile_grants(self, &profile.id)?)
        };
        let addons = load_addons(self)?;
        let mut summaries = Vec::new();
        for addon in &addons {
            if addon.state != "enabled"
                || !addon.trusted
                || grants
                    .as_ref()
                    .is_some_and(|grants| !grants.contains(&addon.addon_id))
                || !addon_is_requestable(self, addon)?
            {
                continue;
            }
            summaries.push(addon_summary(self, addon)?);
        }
        Ok(Value::Array(summaries))
    }

    fn stremio_review_installed(&self, addon_id: &str) -> Result<Value> {
        self.stremio_owner()?;
        let addons = load_addons(self)?;
        find_addon(&addons, addon_id)?;
        Err(stremio_error(
            "STREMIO_PLUGIN_PROVIDER_GATEWAY_REQUIRED",
            "Reviewing an installed add-on requires a fresh protected manifest request, which is not available in this desktop port yet.",
        ))
    }

    fn stremio_disable(&mut self, addon_id: &str) -> Result<Value> {
        let actor = self.stremio_owner()?.id;
        let addons = load_addons(self)?;
        let addon = find_addon(&addons, addon_id)?;
        if addon.secure {
            return Err(stremio_error(
                "STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED",
                "This add-on uses Electron-protected state. Open LoomTV Electron to disable it until the desktop port can sign compatible records.",
            ));
        }

        let timestamp = now();
        let mut record = addon.record.clone();
        record.insert("state".into(), Value::String("disabled".into()));
        record.insert("trusted".into(), Value::Bool(false));
        record.insert("failureCount".into(), json!(0));
        record.insert("disabledAt".into(), json!(timestamp));
        record.remove("lastFailureAt");
        record.remove("nextRetryAt");
        let record_json = serde_json::to_string(&record)?;
        if record_json.len() > MAX_RECORD_BYTES {
            return Err(storage_error());
        }

        let transaction = self.db.transaction()?;
        transaction.execute(
            "UPDATE stremio_addons SET record_json=?,state='disabled',trust_state='disabled',updated_at=? WHERE addon_id=?",
            params![record_json, timestamp, addon_id],
        )?;
        transaction.execute(
            "DELETE FROM profile_stremio_access WHERE addon_id=?",
            [addon_id],
        )?;
        let (prior_revision, new_revision) = bump_state_revision(&transaction, timestamp)?;
        insert_audit(
            &transaction,
            addon_id,
            "addon_disabled",
            &format!("profile:{actor}"),
            prior_revision,
            new_revision,
            timestamp,
        )?;
        transaction.commit()?;
        let addons = load_addons(self)?;
        addon_summary(self, find_addon(&addons, addon_id)?)
    }

    fn stremio_remove(&mut self, addon_id: &str) -> Result<Value> {
        let actor = self.stremio_owner()?.id;
        validate_addon_id(addon_id)?;
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM stremio_addons WHERE addon_id=?)",
            [addon_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(Value::Bool(false));
        }
        let timestamp = now();
        let transaction = self.db.transaction()?;
        transaction.execute(
            "DELETE FROM profile_stremio_access WHERE addon_id=?",
            [addon_id],
        )?;
        transaction.execute("DELETE FROM plugin_secrets WHERE addon_id=?", [addon_id])?;
        transaction.execute("DELETE FROM stremio_addons WHERE addon_id=?", [addon_id])?;
        let (prior_revision, new_revision) = bump_state_revision(&transaction, timestamp)?;
        insert_audit(
            &transaction,
            addon_id,
            "addon_removed",
            &format!("profile:{actor}"),
            prior_revision,
            new_revision,
            timestamp,
        )?;
        transaction.commit()?;
        Ok(Value::Bool(true))
    }

    fn stremio_profile_access(&self, profile_id: &str) -> Result<Value> {
        self.stremio_owner()?;
        let profile = profile_record(self, profile_id)?;
        if profile.is_guest || matches!(profile.kind.as_str(), "guest" | "kid") {
            return Ok(json!([]));
        }
        let addons = load_addons(self)?;
        let mut ids = Vec::new();
        if profile.kind == "owner" {
            for addon in &addons {
                if addon.state == "enabled" && addon.trusted && addon_is_requestable(self, addon)? {
                    ids.push(addon.addon_id.clone());
                }
            }
        } else {
            let grants = profile_grants(self, &profile.id)?;
            for addon in &addons {
                if grants.contains(&addon.addon_id) && addon_is_requestable(self, addon)? {
                    ids.push(addon.addon_id.clone());
                }
            }
        }
        Ok(json!(ids))
    }

    fn stremio_set_profile_access(
        &mut self,
        profile_id: &str,
        addon_id: &str,
        enabled: bool,
    ) -> Result<Value> {
        self.stremio_owner()?;
        let profile = profile_record(self, profile_id)?;
        let addons = load_addons(self)?;
        let addon = addons.iter().find(|addon| addon.addon_id == addon_id);
        if profile.kind == "owner" {
            if !enabled {
                return Err(stremio_error(
                    "STREMIO_PLUGIN_PROFILE_NOT_ALLOWED",
                    "The Owner profile always has access to enabled host add-ons.",
                ));
            }
            let addon = addon.ok_or_else(addon_not_found)?;
            if addon.secure {
                return Err(stremio_error(
                    "STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED",
                    "This add-on uses Electron-protected state. Its integrity must be verified before profile access can be confirmed.",
                ));
            }
            require_requestable(self, addon)?;
            return Ok(Value::Bool(true));
        }
        if profile.is_guest || matches!(profile.kind.as_str(), "guest" | "kid") {
            if enabled {
                return Err(stremio_error(
                    "STREMIO_PLUGIN_PROFILE_NOT_ALLOWED",
                    "Stremio add-ons are not available to Guest or Kids profiles.",
                ));
            }
            self.db.execute(
                "DELETE FROM profile_stremio_access WHERE profile_id=? AND addon_id=?",
                params![profile.id, addon_id],
            )?;
            return Ok(Value::Bool(false));
        }
        if enabled {
            let addon = addon.ok_or_else(addon_not_found)?;
            if addon.secure {
                return Err(stremio_error(
                    "STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED",
                    "This add-on uses Electron-protected state. Its integrity must be verified before granting new profile access.",
                ));
            }
            require_requestable(self, addon)?;
            let timestamp = now();
            self.db.execute(
                "INSERT INTO profile_stremio_access (profile_id,addon_id,granted_at,updated_at) \
                 VALUES (?,?,?,?) ON CONFLICT(profile_id,addon_id) DO UPDATE SET updated_at=excluded.updated_at",
                params![profile.id, addon_id, timestamp, timestamp],
            )?;
            Ok(Value::Bool(true))
        } else {
            if addon.is_none() {
                return Ok(Value::Bool(false));
            }
            self.db.execute(
                "DELETE FROM profile_stremio_access WHERE profile_id=? AND addon_id=?",
                params![profile.id, addon_id],
            )?;
            Ok(Value::Bool(false))
        }
    }

    fn stremio_configuration(&self, addon_id: &str) -> Result<Value> {
        self.stremio_owner()?;
        let addons = load_addons(self)?;
        let addon = addons
            .iter()
            .find(|addon| addon.addon_id == addon_id)
            .ok_or_else(|| {
                stremio_error(
                    "STREMIO_PLUGIN_ACCESS_DENIED",
                    "The Stremio add-on is not installed.",
                )
            })?;
        configuration_state(self, addon)
    }

    fn stremio_configuration_write_unsupported(&self, addon_id: &str) -> Result<Value> {
        self.stremio_owner()?;
        let addons = load_addons(self)?;
        find_addon(&addons, addon_id)?;
        Err(stremio_error(
            "STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED",
            "Stremio configuration remains protected by Electron safeStorage and cannot be changed from this desktop port yet.",
        ))
    }

    fn stremio_audit(&self, addon_id: &str, limit: usize) -> Result<Value> {
        self.stremio_owner()?;
        validate_addon_id(addon_id)?;
        let mut statement = self.db.prepare(
            "SELECT id,addon_id,event_type,actor,prior_revision,new_revision,outcome,detail_json,created_at \
             FROM stremio_plugin_audit WHERE addon_id=? ORDER BY id DESC LIMIT ?",
        )?;
        let rows = statement.query_map(params![addon_id, limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?;
        let mut entries = Vec::new();
        for row in rows {
            let (id, addon_id, event_type, actor, prior, new, outcome, detail, created_at) = row?;
            if !matches!(outcome.as_str(), "success" | "failure") || detail.len() > 16_384 {
                continue;
            }
            let Ok(detail) = serde_json::from_str::<Value>(&detail) else {
                continue;
            };
            if !detail.is_object() {
                continue;
            }
            let mut entry = json!({
                "id": id,
                "addonId": addon_id,
                "eventType": event_type,
                "actor": actor,
                "outcome": outcome,
                "detail": detail,
                "createdAt": created_at,
            });
            if let Some(prior) = prior {
                entry["priorRevision"] = json!(prior);
            }
            if let Some(new) = new {
                entry["newRevision"] = json!(new);
            }
            entries.push(entry);
        }
        Ok(Value::Array(entries))
    }

    fn stremio_active_profile(&self) -> Result<ProfileRecord> {
        let id = self.require_active(None).map_err(profile_error)?;
        profile_record(self, &id)
    }

    fn stremio_owner(&self) -> Result<ProfileRecord> {
        let profile = self.stremio_active_profile()?;
        if profile.kind != "owner" {
            return Err(stremio_error(
                "STREMIO_PLUGIN_ACCESS_DENIED",
                "An owner profile is required to manage Stremio add-ons.",
            ));
        }
        Ok(profile)
    }
}

fn load_addons(store: &Store) -> Result<Vec<StoredAddon>> {
    let mut statement = store.db.prepare(
        "SELECT addon_id,record_json,state,record_revision,integrity_mac,manifest_secret_ref,\
         manifest_url_redacted,trust_state FROM stremio_addons ORDER BY addon_id COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_ADDONS {
        return Err(storage_error());
    }
    let mut addons = Vec::with_capacity(rows.len());
    for (addon_id, record_json, row_state, revision, mac, secret_ref, redacted, trust_state) in rows
    {
        validate_addon_id(&addon_id)?;
        if record_json.len() > MAX_RECORD_BYTES {
            return Err(storage_error());
        }
        let parsed: Value = serde_json::from_str(&record_json).map_err(|_| storage_error())?;
        let secure = parsed["persistenceVersion"] == 2;
        let record = if secure {
            if revision < 1
                || secret_ref.as_deref().unwrap_or("").is_empty()
                || mac.len() != 64
                || !mac.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(storage_error());
            }
            parsed["record"]
                .as_object()
                .cloned()
                .ok_or_else(storage_error)?
        } else {
            parsed.as_object().cloned().ok_or_else(storage_error)?
        };
        if required_record_string(&record, "addonId", MAX_ADDON_ID_CHARS)? != addon_id {
            return Err(storage_error());
        }
        validate_record_lifecycle(&record)?;
        let state = required_record_string(&record, "state", 32)?;
        let trusted = record
            .get("trusted")
            .and_then(Value::as_bool)
            .ok_or_else(storage_error)?;
        validate_trust(&state, trusted, &row_state, &trust_state)?;
        required_record_string(&record, "reviewToken", 128)?;
        let manifest = record
            .get("manifest")
            .and_then(Value::as_object)
            .ok_or_else(storage_error)?;
        if required_record_string(manifest, "id", MAX_ADDON_ID_CHARS)? != addon_id {
            return Err(storage_error());
        }
        let public_location = if secure {
            let reference_exists: bool = store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM plugin_secrets WHERE ref=? AND addon_id=? AND field_key='loomtvHost_manifestUrl')",
                params![secret_ref.as_deref().unwrap_or(""), addon_id],
                |row| row.get(0),
            )?;
            if !reference_exists {
                return Err(storage_error());
            }
            public_manifest_location(&redacted)?
        } else {
            let manifest_url = required_record_string(&record, "manifestUrl", 8_192)?;
            public_manifest_location(&manifest_url)?
        };
        addons.push(StoredAddon {
            addon_id,
            record,
            state,
            trusted,
            secure,
            manifest_origin: public_location.0,
            manifest_url_redacted: if redacted.is_empty() {
                public_location.1
            } else {
                redacted
            },
        });
    }
    Ok(addons)
}

fn validate_trust(state: &str, trusted: bool, row_state: &str, trust_state: &str) -> Result<()> {
    let valid = match state {
        "enabled" => trusted && row_state == "enabled" && trust_state == "trusted",
        "disabled" => !trusted && row_state == "disabled" && trust_state == "disabled",
        "broken" => !trusted && row_state == "disabled" && trust_state == "broken",
        "pending-review" => {
            !trusted
                && row_state == "pending-review"
                && matches!(trust_state, "review-required" | "update-review-required")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(storage_error())
    }
}

fn addon_summary(store: &Store, addon: &StoredAddon) -> Result<Value> {
    let manifest = addon
        .record
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(storage_error)?;
    let configuration = configuration_fields(manifest)?;
    let configuration_required = manifest
        .get("behaviorHints")
        .and_then(Value::as_object)
        .and_then(|hints| hints.get("configurationRequired"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || configuration.iter().any(|field| field["required"] == true);
    let configuration_state = configuration_state_parts(store, addon, configuration_required)?;
    let types = string_array(manifest.get("types"), 32, 64)?;
    if types.is_empty() {
        return Err(storage_error());
    }
    let mut summary = json!({
        "addonId": addon.addon_id,
        "name": required_record_string(manifest, "name", 160)?,
        "version": required_record_string(manifest, "version", 64)?,
        "description": required_record_string(manifest, "description", 1_000)?,
        "manifestOrigin": addon.manifest_origin,
        "manifestUrlRedacted": addon.manifest_url_redacted,
        "state": addon.state,
        "trusted": addon.trusted,
        "configurationRequired": configuration_required,
        "configuration": configuration_state["fields"],
        "configured": configuration_state["configured"],
        "configurationRevision": configuration_state["revision"],
        "resources": resource_names(manifest)?,
        "types": types,
        "catalogs": catalog_definitions(manifest)?,
        "warnings": manifest_warnings(manifest, &addon.record)?,
        "reviewedAt": nonnegative_integer(&addon.record, "reviewedAt", true)?.unwrap_or(0),
        "failureCount": nonnegative_integer(&addon.record, "failureCount", false)?.unwrap_or(0),
    });
    for (source, target) in [
        ("approvedAt", "approvedAt"),
        ("lastFailureAt", "lastFailureAt"),
        ("nextRetryAt", "nextRetryAt"),
    ] {
        if let Some(value) = nonnegative_integer(&addon.record, source, false)? {
            summary[target] = json!(value);
        }
    }
    Ok(summary)
}

fn configuration_state(store: &Store, addon: &StoredAddon) -> Result<Value> {
    let manifest = addon
        .record
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(storage_error)?;
    let fields = configuration_fields(manifest)?;
    let required = manifest
        .get("behaviorHints")
        .and_then(Value::as_object)
        .and_then(|hints| hints.get("configurationRequired"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || fields.iter().any(|field| field["required"] == true);
    let mut state = configuration_state_parts(store, addon, required)?;
    state["fields"] = Value::Array(fields);
    Ok(state)
}

fn configuration_state_parts(
    store: &Store,
    addon: &StoredAddon,
    requires_configuration: bool,
) -> Result<Value> {
    let manifest = addon
        .record
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(storage_error)?;
    let fields = configuration_fields(manifest)?;
    let field_keys = fields
        .iter()
        .filter_map(|field| field["key"].as_str())
        .collect::<HashSet<_>>();
    let mut statement = store.db.prepare(
        "SELECT field_key FROM plugin_secrets WHERE addon_id=? ORDER BY field_key COLLATE NOCASE",
    )?;
    let references = statement
        .query_map([&addon.addon_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let configured_fields = references
        .into_iter()
        .filter(|field| field_keys.contains(field.as_str()))
        .collect::<Vec<_>>();
    let revision: i64 = store
        .db
        .query_row(
            "SELECT revision FROM plugin_secret_revisions WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(json!({
        "fields": fields,
        // Presence can be reported without decrypting. Required values cannot
        // be claimed as valid until the Electron safeStorage codec is shared.
        "configured": !requires_configuration,
        "configuredFields": configured_fields,
        "revision": revision.max(0),
    }))
}

fn addon_is_requestable(store: &Store, addon: &StoredAddon) -> Result<bool> {
    let state = configuration_state(store, addon)?;
    Ok(state["configured"] == true)
}

fn require_requestable(store: &Store, addon: &StoredAddon) -> Result<()> {
    if addon.state != "enabled" || !addon.trusted {
        return Err(stremio_error(
            "STREMIO_PLUGIN_ACCESS_DENIED",
            "The selected Stremio add-on is not approved and enabled.",
        ));
    }
    if nonnegative_integer(&addon.record, "nextRetryAt", false)?
        .is_some_and(|retry_at| retry_at > now())
    {
        return Err(Error {
            code: "ADDON_BACKOFF".into(),
            message: "This Stremio add-on is temporarily backing off after provider failures."
                .into(),
            retryable: true,
        });
    }
    if !addon_is_requestable(store, addon)? {
        return Err(stremio_error(
            "STREMIO_PLUGIN_CONFIGURATION_REQUIRED",
            "This Stremio add-on requires configuration that the desktop port cannot verify yet.",
        ));
    }
    Ok(())
}

fn configuration_fields(manifest: &Map<String, Value>) -> Result<Vec<Value>> {
    let Some(fields) = manifest.get("config") else {
        return Ok(Vec::new());
    };
    let fields = fields.as_array().ok_or_else(storage_error)?;
    if fields.len() > 32 {
        return Err(storage_error());
    }
    let mut output = Vec::with_capacity(fields.len());
    let mut keys = HashSet::new();
    for field in fields {
        let field = field.as_object().ok_or_else(storage_error)?;
        let key = required_record_string(field, "key", 64)?;
        if !keys.insert(key.clone()) {
            return Err(storage_error());
        }
        let field_type = required_record_string(field, "type", 32)?;
        if ![
            "text", "number", "password", "checkbox", "boolean", "select", "string",
        ]
        .contains(&field_type.as_str())
        {
            return Err(storage_error());
        }
        let required = field
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut value = json!({"key":key,"type":field_type,"required":required});
        if let Some(title) = optional_record_string(field, "title", 160)? {
            value["title"] = Value::String(title);
        }
        if let Some(options) = field.get("options") {
            value["options"] = json!(string_array(Some(options), 256, 128)?);
        }
        output.push(value);
    }
    Ok(output)
}

fn resource_names(manifest: &Map<String, Value>) -> Result<Vec<String>> {
    let resources = manifest
        .get("resources")
        .and_then(Value::as_array)
        .ok_or_else(storage_error)?;
    if resources.is_empty() || resources.len() > 16 {
        return Err(storage_error());
    }
    let mut names = Vec::new();
    for resource in resources {
        let name = if let Some(name) = resource.as_str() {
            bounded_text(name, 32)?
        } else {
            required_record_string(resource.as_object().ok_or_else(storage_error)?, "name", 32)?
        };
        if matches!(name.as_str(), "catalog" | "meta" | "stream" | "subtitles")
            && !names.contains(&name)
        {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(storage_error());
    }
    Ok(names)
}

fn catalog_definitions(manifest: &Map<String, Value>) -> Result<Vec<Value>> {
    let Some(catalogs) = manifest.get("catalogs") else {
        return Ok(Vec::new());
    };
    let catalogs = catalogs.as_array().ok_or_else(storage_error)?;
    if catalogs.len() > 200 {
        return Err(storage_error());
    }
    let mut output = Vec::new();
    for catalog in catalogs {
        let catalog = catalog.as_object().ok_or_else(storage_error)?;
        let mut extras = Vec::new();
        if let Some(values) = catalog.get("extra") {
            let values = values.as_array().ok_or_else(storage_error)?;
            if values.len() > 32 {
                return Err(storage_error());
            }
            for extra in values {
                let extra = extra.as_object().ok_or_else(storage_error)?;
                let mut value = json!({
                    "name": required_record_string(extra,"name",64)?,
                    "isRequired": extra.get("isRequired").and_then(Value::as_bool).unwrap_or(false),
                });
                if let Some(options) = extra.get("options") {
                    value["options"] = json!(string_array(Some(options), 256, 128)?);
                }
                if let Some(limit) = extra.get("optionsLimit").and_then(Value::as_u64) {
                    if !(1..=100).contains(&limit) {
                        return Err(storage_error());
                    }
                    value["optionsLimit"] = json!(limit);
                }
                extras.push(value);
            }
        }
        output.push(json!({
            "type": required_record_string(catalog,"type",128)?,
            "id": required_record_string(catalog,"id",128)?,
            "name": required_record_string(catalog,"name",160)?,
            "extra": extras,
        }));
    }
    Ok(output)
}

fn manifest_warnings(
    manifest: &Map<String, Value>,
    record: &Map<String, Value>,
) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    for source in [
        manifest.get("compatibilityWarnings"),
        record.get("reviewWarnings"),
    ] {
        let Some(source) = source else { continue };
        let rows = source.as_array().ok_or_else(storage_error)?;
        for row in rows.iter().take(64) {
            let message = row
                .as_str()
                .map(|value| bounded_text(value, 1_000))
                .or_else(|| {
                    row.as_object()
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str)
                        .map(|value| bounded_text(value, 1_000))
                })
                .transpose()?;
            if let Some(message) = message {
                if !warnings.contains(&message) {
                    warnings.push(message);
                }
            }
        }
    }
    if let Some(resources) = manifest.get("resources").and_then(Value::as_array) {
        for resource in resources {
            let name = resource
                .as_str()
                .or_else(|| resource.as_object()?.get("name")?.as_str());
            if let Some(name) =
                name.filter(|name| !matches!(*name, "catalog" | "meta" | "stream" | "subtitles"))
            {
                let warning = format!(
                    "The {name} resource is declared by the add-on but is not used by LoomTV."
                );
                if !warnings.contains(&warning) {
                    warnings.push(warning);
                }
            }
        }
    }
    let peer_declared = manifest
        .get("peerToPeerDeclared")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || manifest
            .get("behaviorHints")
            .and_then(Value::as_object)
            .and_then(|hints| hints.get("p2p"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if peer_declared && !warnings.iter().any(|warning| warning == PEER_WARNING) {
        warnings.push(PEER_WARNING.into());
    }
    Ok(warnings)
}

fn string_array(value: Option<&Value>, max_items: usize, max_chars: usize) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(storage_error)?;
    if values.len() > max_items {
        return Err(storage_error());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(storage_error)
                .and_then(|value| bounded_text(value, max_chars))
        })
        .collect()
}

fn profile_record(store: &Store, profile_id: &str) -> Result<ProfileRecord> {
    if profile_id.trim().is_empty() || profile_id.chars().count() > 240 || has_control(profile_id) {
        return Err(stremio_error(
            "STREMIO_PLUGIN_PROFILE_NOT_FOUND",
            "The selected profile no longer exists.",
        ));
    }
    store
        .db
        .query_row(
            "SELECT id,profile_type,is_guest FROM profiles WHERE id=?",
            [profile_id],
            |row| {
                Ok(ProfileRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    is_guest: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            stremio_error(
                "STREMIO_PLUGIN_PROFILE_NOT_FOUND",
                "The selected profile no longer exists.",
            )
        })
}

fn profile_grants(store: &Store, profile_id: &str) -> Result<HashSet<String>> {
    let mut statement = store.db.prepare(
        "SELECT addon_id FROM profile_stremio_access WHERE profile_id=? ORDER BY addon_id COLLATE NOCASE",
    )?;
    let grants = statement
        .query_map([profile_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    Ok(grants)
}

fn find_addon<'a>(addons: &'a [StoredAddon], addon_id: &str) -> Result<&'a StoredAddon> {
    validate_addon_id(addon_id)?;
    addons
        .iter()
        .find(|addon| addon.addon_id == addon_id)
        .ok_or_else(addon_not_found)
}

fn validate_addon_id(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.chars().count() > MAX_ADDON_ID_CHARS
        || has_control(value)
    {
        return Err(stremio_error(
            "STREMIO_PLUGIN_INVALID_REQUEST",
            "A valid Stremio add-on ID is required.",
        ));
    }
    Ok(())
}

fn validate_request_shape(channel: &str, args: &[Value]) -> Result<()> {
    let valid = match channel {
        "plugins:stremio:list" | "plugins:stremio:available" | "plugins:stremio:official" => {
            args.is_empty()
        }
        "plugins:stremio:review-installed"
        | "plugins:stremio:disable"
        | "plugins:stremio:remove"
        | "plugins:stremio:profile-access"
        | "plugins:stremio:configuration" => args.len() == 1,
        "plugins:stremio:set-profile-access" => args.len() == 3,
        "plugins:stremio:save-configuration" => {
            args.len() == 2 && args.get(1).is_some_and(Value::is_object)
        }
        "plugins:stremio:audit" => matches!(args.len(), 1 | 2),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(stremio_error(
            "STREMIO_PLUGIN_INVALID_REQUEST",
            "The Stremio add-on request is invalid.",
        ))
    }
}

fn required_string(args: &[Value], index: usize, max_chars: usize) -> Result<&str> {
    let value = args
        .get(index)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.chars().count() <= max_chars && !has_control(value)
        })
        .ok_or_else(|| {
            stremio_error(
                "STREMIO_PLUGIN_INVALID_REQUEST",
                "The Stremio add-on request is invalid.",
            )
        })?;
    Ok(value)
}

fn required_record_string(
    record: &Map<String, Value>,
    key: &str,
    max_chars: usize,
) -> Result<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.chars().count() <= max_chars && !has_control(value)
        })
        .map(str::to_owned)
        .ok_or_else(storage_error)
}

fn optional_record_string(
    record: &Map<String, Value>,
    key: &str,
    max_chars: usize,
) -> Result<Option<String>> {
    match record.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => bounded_text(value, max_chars).map(Some),
        Some(_) => Err(storage_error()),
    }
}

fn bounded_text(value: &str, max_chars: usize) -> Result<String> {
    if value.chars().count() > max_chars || has_control(value) {
        Err(storage_error())
    } else {
        Ok(value.to_owned())
    }
}

fn nonnegative_integer(
    record: &Map<String, Value>,
    key: &str,
    required: bool,
) -> Result<Option<i64>> {
    match record.get(key) {
        Some(value) => value
            .as_i64()
            .filter(|value| *value >= 0)
            .map(Some)
            .ok_or_else(storage_error),
        None if required => Err(storage_error()),
        None => Ok(None),
    }
}

fn validate_record_lifecycle(record: &Map<String, Value>) -> Result<()> {
    if record.get("installStateVersion").and_then(Value::as_i64) != Some(1) {
        return Err(storage_error());
    }
    nonnegative_integer(record, "installedAt", true)?;
    nonnegative_integer(record, "reviewedAt", true)?;
    let state = required_record_string(record, "state", 32)?;
    let approved = nonnegative_integer(record, "approvedAt", false)?;
    let disabled = nonnegative_integer(record, "disabledAt", false)?;
    let failure_count = nonnegative_integer(record, "failureCount", false)?.unwrap_or(0);
    if failure_count > 1_000 {
        return Err(storage_error());
    }
    let last_failure = nonnegative_integer(record, "lastFailureAt", false)?;
    let next_retry = nonnegative_integer(record, "nextRetryAt", false)?;
    let lifecycle_valid = match state.as_str() {
        "enabled" => approved.is_some() && disabled.is_none(),
        "pending-review" => approved.is_none() && disabled.is_none(),
        "disabled" => disabled.is_some(),
        "broken" => true,
        _ => false,
    };
    if !lifecycle_valid
        || matches!(state.as_str(), "pending-review" | "disabled")
            && (last_failure.is_some() || next_retry.is_some())
    {
        return Err(storage_error());
    }
    Ok(())
}

fn public_manifest_location(value: &str) -> Result<(String, String)> {
    let url = Url::parse(value).map_err(|_| storage_error())?;
    if url.scheme() != "https" || url.host().is_none() {
        return Err(storage_error());
    }
    let origin = url.origin().ascii_serialization();
    let redacted = if url.path() == "/manifest.json" {
        format!("{origin}/manifest.json")
    } else if url.path().ends_with("/manifest.json") {
        format!("{origin}/\u{2026}/manifest.json")
    } else {
        format!("{origin}/\u{2026}")
    };
    Ok((origin, redacted))
}

fn bump_state_revision(transaction: &Transaction<'_>, timestamp: i64) -> Result<(i64, i64)> {
    let prior: i64 = transaction
        .query_row(
            "SELECT revision FROM stremio_plugin_state_metadata WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let next = prior.saturating_add(1);
    transaction.execute(
        "INSERT INTO stremio_plugin_state_metadata (id,state_version,revision,updated_at) VALUES (1,2,?,?) \
         ON CONFLICT(id) DO UPDATE SET state_version=2,revision=excluded.revision,updated_at=excluded.updated_at",
        params![next, timestamp],
    )?;
    Ok((prior.max(0), next.max(0)))
}

fn insert_audit(
    transaction: &Transaction<'_>,
    addon_id: &str,
    event_type: &str,
    actor: &str,
    prior_revision: i64,
    new_revision: i64,
    timestamp: i64,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO stremio_plugin_audit \
         (addon_id,event_type,actor,prior_revision,new_revision,outcome,detail_json,created_at) \
         VALUES (?,?,?,?,?,'success','{}',?)",
        params![
            addon_id,
            event_type,
            actor,
            prior_revision,
            new_revision,
            timestamp
        ],
    )?;
    Ok(())
}

fn audit_limit(value: Option<&Value>) -> Result<usize> {
    match value {
        None => Ok(100),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0 && *value <= 1_000)
            .map(|value| (value as usize).min(MAX_AUDIT_LIMIT))
            .ok_or_else(|| {
                stremio_error(
                    "STREMIO_PLUGIN_INVALID_REQUEST",
                    "Choose a valid Stremio audit limit.",
                )
            }),
    }
}

fn official_addons() -> Value {
    json!([
        {
            "id":"cinemeta",
            "addonId":"com.linvo.cinemeta",
            "name":"Cinemeta",
            "description":"Stremio’s official movie and series catalogs and metadata.",
            "capability":"catalog"
        }
    ])
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn addon_not_found() -> Error {
    stremio_error(
        "STREMIO_PLUGIN_NOT_FOUND",
        "The Stremio add-on is not installed.",
    )
}

fn profile_error(_: Error) -> Error {
    stremio_error(
        "STREMIO_PLUGIN_ACCESS_DENIED",
        "Choose and unlock a profile to use Stremio add-ons.",
    )
}

fn storage_error() -> Error {
    stremio_error(
        "STREMIO_PLUGIN_STORAGE_UNAVAILABLE",
        "The installed add-on state could not be loaded or saved safely.",
    )
}

fn stremio_error(code: &str, message: impl Into<String>) -> Error {
    Error::new(code, message)
}

fn stremio_wire_result(result: Result<Value>) -> Value {
    match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(error) => {
            let valid_code = error.code.len() >= 3
                && error.code.len() <= 80
                && error
                    .code
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_uppercase())
                && error
                    .code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
            let code = if valid_code {
                error.code.clone()
            } else {
                "STREMIO_PLUGIN_STORAGE_UNAVAILABLE".into()
            };
            let storage_unavailable = code == "STREMIO_PLUGIN_STORAGE_UNAVAILABLE";
            let message = if storage_unavailable {
                "The installed add-on state could not be loaded or saved safely."
            } else {
                error.message.as_str()
            };
            json!({
                "ok":false,
                "error":{
                    "code":code,
                    "message": message,
                    "retryable":error.retryable,
                }
            })
        }
    }
}
