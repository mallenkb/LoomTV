use super::{failed, Runtime};
use loomtv_core::{Error, Result};
use serde_json::{json, Value};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;

const MAX_PROFILE_FILE_BYTES: u64 = 25 * 1024 * 1024;

fn transfer_failure(message: impl Into<String>) -> Value {
    json!({"ok": false, "error": message.into()})
}

fn export_file_name(profile_name: &str) -> String {
    let mut stem = String::new();
    let mut replacing = false;
    for character in profile_name.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            stem.push(character);
            replacing = false;
        } else if !replacing {
            stem.push('-');
            replacing = true;
        }
    }
    if stem.is_empty() {
        stem.push_str("profile");
    }
    format!("{stem}.loomprofile.json")
}

pub(super) async fn export_profile(
    window: &WebviewWindow,
    runtime: &Runtime,
    profile_id: &str,
) -> Result<Value> {
    let bundle = {
        let store = runtime.store.lock().await;
        store.require_owner()?;
        match store.export_profile_data(profile_id) {
            Ok(bundle) => bundle,
            Err(error) => return Ok(transfer_failure(error.message)),
        }
    };
    let profile_name = bundle["profile"]["name"].as_str().unwrap_or("profile");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Export LoomTV profile")
        .set_file_name(export_file_name(profile_name))
        .add_filter("LoomTV Profile", &["loomprofile.json", "json"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(failed)? else {
        return Ok(json!({"ok": false}));
    };
    let path = path.into_path().map_err(failed)?;
    let bytes = match serde_json::to_vec(&bundle) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(transfer_failure("Profile export failed.")),
    };
    if let Err(error) = tokio::fs::write(&path, bytes).await {
        return Ok(transfer_failure(format!(
            "The profile file could not be written: {error}"
        )));
    }
    Ok(json!({"ok": true, "path": path.to_string_lossy()}))
}

pub(super) async fn import_profile(window: &WebviewWindow, runtime: &Runtime) -> Result<Value> {
    runtime.store.lock().await.require_owner()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Import LoomTV profile")
        .add_filter("LoomTV Profile", &["json"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(failed)? else {
        return Ok(json!({"ok": false}));
    };
    let path = path.into_path().map_err(failed)?;
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            return Ok(transfer_failure(format!(
                "The profile file could not be read: {error}"
            )))
        }
    };
    if metadata.len() > MAX_PROFILE_FILE_BYTES {
        return Ok(transfer_failure("The profile file is larger than 25 MB."));
    }
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(error) => {
            return Ok(transfer_failure(format!(
                "The profile file could not be read: {error}"
            )))
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file
        .take(MAX_PROFILE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
    {
        return Ok(transfer_failure(format!(
            "The profile file could not be read: {error}"
        )));
    }
    if bytes.len() as u64 > MAX_PROFILE_FILE_BYTES {
        return Ok(transfer_failure("The profile file is larger than 25 MB."));
    }
    let bundle: Value = match serde_json::from_slice(&bytes) {
        Ok(bundle) => bundle,
        Err(_) => return Ok(transfer_failure("Profile import contains invalid JSON.")),
    };
    let imported = match runtime.store.lock().await.import_profile_data(&bundle) {
        Ok(imported) => imported,
        Err(Error { message, .. }) => return Ok(transfer_failure(message)),
    };
    Ok(json!({
        "ok": true,
        "profile": imported["profile"],
        "importedProgress": imported["importedProgress"],
        "skippedProgress": imported["skippedProgress"],
        "importedLists": imported["importedLists"],
        "skippedLists": imported["skippedLists"],
    }))
}
