use std::{io::Cursor, path::PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{imageops::FilterType, ImageFormat, ImageReader, Limits};
use loomtv_core::{string, Error, Result};
use serde_json::{json, Value};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncReadExt;

use super::{failed, Runtime};

const MAX_AVATAR_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_BYTES: usize = 512 * 1024;
const MAX_DECODED_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 32_768;

pub(super) async fn handle(
    window: &WebviewWindow,
    runtime: &Runtime,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "profiles:choose-avatar" => choose_profile_avatar(window, runtime, args).await,
        "shell:open-folder-path" | "shell:show-item" => {
            open_folder_path(window, runtime, args).await
        }
        _ => Err(Error::unsupported(channel)),
    }
}

async fn choose_profile_avatar(
    window: &WebviewWindow,
    runtime: &Runtime,
    args: &[Value],
) -> Result<Value> {
    require_arg_count(args, 0)?;
    runtime.store.lock().await.require_owner()?;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Choose profile image")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(failed)? else {
        return Ok(Value::Null);
    };
    let path = path.into_path().map_err(failed)?;

    let metadata = tokio::fs::metadata(&path).await.map_err(failed)?;
    if !metadata.is_file() {
        return Err(avatar_error("That image could not be opened."));
    }
    if metadata.len() > MAX_AVATAR_SOURCE_BYTES {
        return Err(avatar_error("Choose an image smaller than 10 MB."));
    }

    let file = tokio::fs::File::open(&path).await.map_err(failed)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_AVATAR_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(failed)?;
    if bytes.len() as u64 > MAX_AVATAR_SOURCE_BYTES {
        return Err(avatar_error("Choose an image smaller than 10 MB."));
    }

    runtime.store.lock().await.require_owner()?;
    let avatar = tokio::task::spawn_blocking(move || normalize_avatar(bytes))
        .await
        .map_err(|_| avatar_error("That image could not be opened."))??;
    Ok(json!(avatar))
}

fn normalize_avatar(bytes: Vec<u8>) -> Result<String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| avatar_error("That image could not be opened."))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(avatar_error("That image could not be opened."));
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODED_IMAGE_BYTES);
    reader.limits(limits);
    let source = reader
        .decode()
        .map_err(|_| avatar_error("That image could not be opened."))?;
    let side = source.width().min(source.height());
    if side == 0 {
        return Err(avatar_error("That image could not be opened."));
    }

    let square = source.crop_imm(
        (source.width() - side) / 2,
        (source.height() - side) / 2,
        side,
        side,
    );
    let resized = square.resize_exact(256, 256, FilterType::Lanczos3);
    let mut png = Cursor::new(Vec::new());
    resized
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| avatar_error("That image could not be opened."))?;

    let avatar = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    );
    if avatar.len() > MAX_AVATAR_DATA_URL_BYTES {
        return Err(avatar_error(
            "That image is too complex. Try a smaller image.",
        ));
    }
    Ok(avatar)
}

async fn open_folder_path(
    window: &WebviewWindow,
    runtime: &Runtime,
    args: &[Value],
) -> Result<Value> {
    require_arg_count(args, 1)?;
    let target = string(args, 0)?.trim();
    if target.is_empty() {
        return Err(Error::new("invalid_argument", "A local path is required."));
    }
    if has_url_scheme(target) {
        return Err(Error::new(
            "path_forbidden",
            "Only local paths can be opened in the file manager.",
        ));
    }

    let resolved = std::path::absolute(target).map_err(failed)?;
    let (existing, metadata) = nearest_existing_target(resolved.clone()).await?;
    let reveal_file = existing == resolved && metadata.is_file();
    let authorized = if reveal_file {
        runtime
            .store
            .lock()
            .await
            .authorize_media(&resolved.to_string_lossy())?
    } else {
        runtime.store.lock().await.require_owner()?;
        tokio::fs::canonicalize(&existing).await.map_err(failed)?
    };

    if reveal_file {
        window
            .opener()
            .reveal_item_in_dir(&authorized)
            .map_err(failed)?;
    } else {
        window
            .opener()
            .open_path(authorized.to_string_lossy(), None::<&str>)
            .map_err(failed)?;
    }
    Ok(json!(true))
}

async fn nearest_existing_target(path: PathBuf) -> Result<(PathBuf, std::fs::Metadata)> {
    let root = path
        .ancestors()
        .last()
        .ok_or_else(missing_local_path)?
        .to_path_buf();
    let mut candidate = path;
    loop {
        if let Ok(metadata) = tokio::fs::metadata(&candidate).await {
            return Ok((candidate, metadata));
        }
        let parent = candidate.parent().ok_or_else(missing_local_path)?;
        if parent == candidate || parent == root {
            return Err(missing_local_path());
        }
        candidate = parent.to_path_buf();
    }
}

fn has_url_scheme(value: &str) -> bool {
    let Some(separator) = value.find("://") else {
        return false;
    };
    separator > 0
        && value[..separator]
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic())
}

fn require_arg_count(args: &[Value], expected: usize) -> Result<()> {
    if args.len() == expected {
        Ok(())
    } else {
        Err(Error::new(
            "invalid_argument",
            format!("Expected {expected} argument(s)."),
        ))
    }
}

fn missing_local_path() -> Error {
    Error::new(
        "path_unavailable",
        "That file or folder is no longer available.",
    )
}

fn avatar_error(message: &str) -> Error {
    Error::new("invalid_avatar", message)
}
