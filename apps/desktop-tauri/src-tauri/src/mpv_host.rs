use super::{failed, media_error, Runtime};
use loomtv_core::{Error, Result};
use loomtv_playback::mpv::{Candidate, WindowState};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn disabled() -> bool {
    std::env::var("LOOMTV_DISABLE_MPV")
        .ok()
        .is_some_and(|v| ["1", "true", "yes"].contains(&v.to_ascii_lowercase().as_str()))
}
async fn candidates(state: &Runtime) -> Result<Vec<Candidate>> {
    let mut result = Vec::new();
    if let Some(value) = std::env::var_os("LOOMTV_MPV_PATH").filter(|v| !v.is_empty()) {
        result.push(Candidate {
            path: value.into(),
            source: "environment",
        });
    }
    if let Some(value) = state.store.lock().await.settings()?["mpvExecutablePath"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        result.push(Candidate {
            path: value.into(),
            source: "user-selected",
        });
    }
    for path in &state.mpv_candidates {
        result.push(Candidate {
            path: path.clone(),
            source: "bundled",
        });
    }
    #[cfg(target_os = "macos")]
    let fixed = vec![
        PathBuf::from("/opt/homebrew/bin/mpv"),
        PathBuf::from("/usr/local/bin/mpv"),
        PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv"),
    ];
    #[cfg(target_os = "linux")]
    let fixed = vec![
        PathBuf::from("/usr/bin/mpv"),
        PathBuf::from("/usr/local/bin/mpv"),
        PathBuf::from("/snap/bin/mpv"),
    ];
    #[cfg(windows)]
    let fixed = vec![
        PathBuf::from(
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()),
        )
        .join("mpv/mpv.exe"),
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
            .join("Programs/mpv/mpv.exe"),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let fixed: Vec<PathBuf> = Vec::new();
    for path in fixed {
        if path.is_absolute() {
            result.push(Candidate {
                path,
                source: "system",
            });
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path)
            .filter(|p| p.is_absolute())
            .take(24)
        {
            let path = directory.join(if cfg!(windows) { "mpv.exe" } else { "mpv" });
            if !result.iter().any(|c| c.path == path) {
                result.push(Candidate {
                    path,
                    source: "system",
                });
            }
        }
    }
    result.truncate(64);
    Ok(result)
}
pub(super) async fn availability(state: &Runtime) -> Result<Value> {
    state
        .mpv_resolver
        .availability(candidates(state).await?, disabled())
        .await
        .map_err(media_error)
}
pub(super) async fn executable(state: &Runtime) -> Result<PathBuf> {
    if disabled() {
        return Err(Error::new(
            "mpv_disabled",
            "mpv is disabled by LOOMTV_DISABLE_MPV.",
        ));
    }
    state
        .mpv_resolver
        .resolve(candidates(state).await?)
        .await
        .map_err(media_error)?
        .map(|r| r.path)
        .ok_or_else(|| {
            Error::new(
                "mpv_unavailable",
                "Select a working mpv executable in Settings.",
            )
        })
}
pub(super) async fn handle(
    window: &WebviewWindow,
    state: &Runtime,
    channel: &str,
) -> Result<Value> {
    if channel == "mpv:refresh-availability" {
        state.mpv_resolver.invalidate().await;
        return availability(state).await;
    }
    if channel == "mpv:availability" {
        return availability(state).await;
    }
    let (owner, revision) = {
        let store = state.store.lock().await;
        (store.require_owner()?, store.selection_revision())
    };
    if channel == "mpv:reset-executable" {
        state.store.lock().await.set_mpv_executable(None)?;
        state.mpv_resolver.invalidate().await;
        return availability(state).await;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let picker = window.dialog().file().set_title("Choose mpv executable");
    #[cfg(windows)]
    let picker = picker.add_filter("mpv executable", &["exe"]);
    picker.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(failed)? else {
        return availability(state).await;
    };
    let path = path.into_path().map_err(failed)?;
    {
        let store = state.store.lock().await;
        store.require_active(Some(&owner))?;
        store.require_owner()?;
        if store.selection_revision() != revision {
            return Err(Error::new("stale_profile", "The active profile changed."));
        }
    }
    let (path, _) = loomtv_playback::mpv::validate_executable(&path)
        .await
        .map_err(media_error)?;
    {
        let mut store = state.store.lock().await;
        store.require_active(Some(&owner))?;
        if store.selection_revision() != revision {
            return Err(Error::new("stale_profile", "The active profile changed."));
        }
        store.set_mpv_executable(Some(path.to_str().ok_or_else(|| {
            Error::new("invalid_path", "The executable path is not valid Unicode.")
        })?))?;
    }
    state.mpv_resolver.invalidate().await;
    availability(state).await
}
pub(super) fn window_state(window: &WebviewWindow) -> Result<WindowState> {
    let scale = window.scale_factor().map_err(failed)?;
    let size = window
        .inner_size()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let position = window
        .inner_position()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    #[cfg(target_os = "macos")]
    let y = if let Some(monitor) = window.current_monitor().map_err(failed)? {
        let origin = monitor.position().to_logical::<f64>(scale);
        let display = monitor.size().to_logical::<f64>(scale);
        origin.y + display.height - position.y - size.height
    } else {
        position.y
    };
    #[cfg(not(target_os = "macos"))]
    let y = position.y;
    Ok(WindowState {
        geometry: Some(format!(
            "{}x{}+{}+{}",
            size.width.round().clamp(1., 32768.) as i32,
            size.height.round().clamp(1., 32768.) as i32,
            position.x.round() as i32,
            y.round() as i32
        )),
        minimized: !window.is_visible().map_err(failed)?
            || window.is_minimized().map_err(failed)?,
    })
}
pub(super) fn sync(app: &tauri::AppHandle) {
    if let (Some(window), Some(state)) =
        (app.get_webview_window("main"), app.try_state::<Runtime>())
    {
        if let Ok(value) = window_state(&window) {
            state.mpv.set_window(value);
        }
    }
}

pub(super) fn packaged_candidates(root: &std::path::Path) -> Vec<PathBuf> {
    let platforms: &[&str] = if cfg!(target_os = "macos") {
        &["mac", "macos", "darwin"]
    } else if cfg!(windows) {
        &["win", "windows"]
    } else {
        &["linux"]
    };
    let architectures: &[&str] = if cfg!(target_arch = "aarch64") {
        &["arm64", "aarch64"]
    } else if cfg!(target_arch = "x86_64") {
        &["x64", "amd64"]
    } else {
        &[std::env::consts::ARCH]
    };
    let name = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    let root = root.join("mpv");
    let mut paths = vec![root.join(name), root.join("bin").join(name)];
    for platform in platforms {
        for arch in architectures {
            let path = root.join(platform).join(arch);
            paths.extend([
                path.join(name),
                path.join("bin").join(name),
                path.join("mpv.app/Contents/MacOS/mpv"),
            ]);
        }
        paths.push(root.join(platform).join(name));
    }
    paths
}
