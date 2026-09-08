#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop_os;
mod desktop_menu;
mod media_control;
mod media_protocol;
mod libmpv_host;
mod playback_activity;
mod profile_transfer;
mod window_host;

use loomtv_core::{string, Error, Result, Store};
use loomtv_playback::PlaybackService;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

enum PlaybackScope {
    Local { profile: String, revision: i64 },
    Remote(u64),
}

struct Runtime {
    store: Arc<Mutex<Store>>,
    media: loomtv_core::streaming::MediaServer,
    remote: Arc<loomtv_core::remote::RemoteClient>,
    native_scope: Mutex<Option<PlaybackScope>>,
    drained: AtomicBool,
    media_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    player: PlaybackService,
    libmpv: libmpv_host::LibMpvService,
    playback_activity: playback_activity::PlaybackActivity,
    media_control: media_control::MediaControl,
    metadata: loomtv_core::metadata::MetadataProviderGateway,
    iptv: loomtv_core::iptv::IptvService,
    playback_gate: Mutex<()>,
    scan_gate: Arc<tokio::sync::Semaphore>,
    ffmpeg: Option<PathBuf>,
    closing: Arc<AtomicBool>,
}
fn failed(error: impl std::fmt::Display) -> Error {
    Error::new("desktop_error", error.to_string())
}
fn media_error(error: String) -> Error {
    Error::new("playback_error", error)
}

fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    } else {
        Ok(app.path().resource_dir().map_err(failed)?.join("runtimes"))
    }
}
fn runtime_file(root: &std::path::Path, paths: &[&str]) -> Option<PathBuf> {
    paths
        .iter()
        .map(|path| root.join(path))
        .find(|path| path.is_file())
}

#[tauri::command]
async fn desktop_invoke(
    window: WebviewWindow,
    state: tauri::State<'_, Runtime>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value> {
    let url = window.url().map_err(failed)?;
    let trusted = trusted_ui_url(&url);
    if window.label() != "main" || !trusted || state.closing.load(Ordering::SeqCst) {
        return Err(Error::new(
            "unauthorized_window",
            "This window cannot invoke desktop operations.",
        ));
    }
    let payload_limit = if channel == "artwork:save" {
        26 * 1024 * 1024
    } else {
        2 * 1024 * 1024
    };
    if args.len() > 8 || serde_json::to_vec(&args)?.len() > payload_limit {
        return Err(Error::new(
            "payload_too_large",
            "The desktop request is too large.",
        ));
    }
    state.store.lock().await.sync_desktop_selection()?;
    match channel.as_str() {
        "profiles:choose-avatar" | "shell:open-folder-path" | "shell:show-item" => {
            desktop_os::handle(&window, &state, &channel, &args).await
        }
        "profiles:export" => {
            profile_transfer::export_profile(&window, &state, string(&args, 0)?).await
        }
        "profiles:import" => {
            let result = profile_transfer::import_profile(&window, &state).await?;
            if result["ok"] == true {
                let store = state.store.lock().await;
                window.emit("loomtv:profiles:changed",[json!({"profiles":store.profiles()?,"selectionRevision":store.selection_revision()})]).map_err(failed)?;
            }
            Ok(result)
        }
        "network:discover-peers" => {
            let timeout = match args.first() {
                None | Some(Value::Null) => 2500,
                Some(value) => value.as_u64().ok_or_else(|| {
                    Error::new("invalid_timeout", "Choose a valid discovery timeout.")
                })?,
            };
            loomtv_core::discovery::discover(timeout).await
        }
        "iptv:list-sources" => state.iptv.list_sources().await,
        "iptv:add-source" => {
            state
                .iptv
                .add_source(args.first().unwrap_or(&Value::Null))
                .await
        }
        "iptv:update-source" => {
            state
                .iptv
                .update_source(string(&args, 0)?, args.get(1).unwrap_or(&Value::Null))
                .await
        }
        "iptv:remove-source" => state.iptv.remove_source(string(&args, 0)?).await,
        "iptv:refresh-source" => state.iptv.refresh_source(string(&args, 0)?).await,
        "iptv:list-channels" => {
            state
                .iptv
                .list_channels(args.first().unwrap_or(&Value::Null))
                .await
        }
        "metadata:refresh-incomplete" | "metadata:streaming-providers" => {
            let (profile, revision) = {
                let store = state.store.lock().await;
                let profile = if channel == "metadata:refresh-incomplete" {
                    store.require_owner()?
                } else {
                    store.require_active(None)?
                };
                (profile, store.selection_revision())
            };
            if channel == "metadata:refresh-incomplete" {
                let _permit = state.scan_gate.acquire().await.map_err(failed)?;
                Ok(json!(
                    loomtv_core::metadata_scan::refresh_incomplete_metadata(
                        state.store.clone(),
                        &state.metadata,
                        &profile,
                        revision,
                        string(&args, 0)?,
                        state.closing.clone()
                    )
                    .await?
                ))
            } else {
                loomtv_core::metadata_scan::streaming_providers(
                    state.store.clone(),
                    &state.metadata,
                    &profile,
                    revision,
                    string(&args, 0)?,
                    state.closing.clone(),
                )
                .await
            }
        }
        "metadata:provider-request" => {
            let store = state.store.clone();
            let settings =
                tokio::task::spawn_blocking(move || store.blocking_lock().metadata_settings())
                    .await
                    .map_err(failed)??;
            state
                .metadata
                .request_metadata_provider(args.first().unwrap_or(&Value::Null), &settings)
                .await
        }
        "metadata:test-keys" => {
            let offline = {
                let store = state.store.lock().await;
                store.require_owner()?;
                store.settings()?["metadataOfflineMode"] == true
            };
            Ok(serde_json::to_value(
                state
                    .metadata
                    .test_metadata_keys(args.first().unwrap_or(&Value::Null), offline)
                    .await?,
            )?)
        }
        "media-control:publish" | "media-control:release" => {
            let _gate = state.playback_gate.lock().await;
            state.media_control.handle(&window, &channel, &args).await
        }
        "playback:activity" => {
            let timeout_minutes = {
                let store = state.store.lock().await;
                playback_activity::configured_timeout_minutes(&store.settings()?)
            };
            state.playback_activity.handle(&args, timeout_minutes).await
        }
        "network:remote-session" => state.remote.session().await,
        "network:remote-connect" => {
            let _gate = state.playback_gate.lock().await;
            let connection = state
                .remote
                .connect(
                    string(&args, 0)?,
                    string(&args, 1)?,
                    args.get(2).and_then(Value::as_str),
                    "LoomTV Tauri desktop",
                )
                .await?;
            state.player.stop(None).await.map_err(media_error)?;
            state.libmpv.stop(None).await?;
            state.playback_activity.release_all().await?;
            state.media_control.release_all().await?;
            *state.native_scope.lock().await = None;
            state.media.revoke_all().await;
            window_host::hide(&window).await?;
            window_host::external_backdrop(&window, false).await?;
            Ok(connection)
        }
        "network:remote-disconnect" => {
            let _gate = state.playback_gate.lock().await;
            let result = state
                .remote
                .disconnect(args.first().and_then(Value::as_bool).unwrap_or(false))
                .await?;
            state.player.stop(None).await.map_err(media_error)?;
            state.libmpv.stop(None).await?;
            state.playback_activity.release_all().await?;
            state.media_control.release_all().await?;
            *state.native_scope.lock().await = None;
            state.media.revoke_all().await;
            window_host::hide(&window).await?;
            window_host::external_backdrop(&window, false).await?;
            Ok(result)
        }
        "network:remote-request" => {
            let path = string(&args, 0)?;
            let profile_change = ["/api/v2/profiles/select", "/api/v2/profiles/lock"]
                .contains(&path.split('?').next().unwrap_or(""));
            let _gate = if profile_change {
                Some(state.playback_gate.lock().await)
            } else {
                None
            };
            let epoch = state.remote.epoch();
            let result = state
                .remote
                .request(path, args.get(1).cloned().unwrap_or(json!({})))
                .await?;
            let session_changed = state.remote.epoch() != epoch;
            if session_changed {
                state.player.stop(None).await.map_err(media_error)?;
                state.libmpv.stop(None).await?;
                state.playback_activity.release_all().await?;
                state.media_control.release_all().await?;
                *state.native_scope.lock().await = None;
                state.media.revoke_all().await;
                window_host::hide(&window).await?;
                window_host::external_backdrop(&window, false).await?;
            } else if profile_change {
                state.playback_activity.release_all().await?;
                state.media_control.release_all().await?;
            }
            Ok(result)
        }
        "window:set-fullscreen" => {
            let enabled = args
                .first()
                .and_then(Value::as_bool)
                .ok_or_else(|| Error::new("invalid_argument", "Expected a boolean."))?;
            window.set_fullscreen(enabled).map_err(failed)?;
            window
                .emit("loomtv:window:fullscreen-changed", [enabled])
                .map_err(failed)?;
            Ok(json!(enabled))
        }
        "window:set-chrome-visible" => {
            let visible = args
                .first()
                .and_then(Value::as_bool)
                .ok_or_else(|| Error::new("invalid_argument", "Expected a boolean."))?;
            window_host::set_chrome_visible(&window, visible).await?;
            Ok(json!(visible))
        }
        "library:pick-folder" | "library:add-folder" => {
            state.store.lock().await.require_owner()?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            window
                .dialog()
                .file()
                .set_title("Choose a library folder")
                .pick_folder(move |path| {
                    let _ = tx.send(path);
                });
            let Some(path) = rx.await.map_err(failed)? else {
                return Ok(Value::Null);
            };
            let path = path.into_path().map_err(failed)?;
            if channel == "library:pick-folder" {
                return Ok(json!(path));
            }
            let permit = state
                .scan_gate
                .clone()
                .acquire_owned()
                .await
                .map_err(failed)?;
            {
                let mut store = state.store.lock().await;
                store.require_owner()?;
                store.add_folder(
                    args.first().and_then(Value::as_str).unwrap_or("movies"),
                    &path.to_string_lossy(),
                )?;
            }
            scan_library(&window, &state, permit, "quick").await
        }
        "library:add-folder-path" | "library:update-folder" | "library:remove-folder" => {
            let permit = state
                .scan_gate
                .clone()
                .acquire_owned()
                .await
                .map_err(failed)?;
            let store = state.store.clone();
            let command = channel.clone();
            let result =
                tokio::task::spawn_blocking(move || store.blocking_lock().invoke(&command, &args))
                    .await
                    .map_err(failed)??;
            if channel == "library:remove-folder" {
                Ok(result)
            } else {
                scan_library(&window, &state, permit, "quick").await
            }
        }
        "library:scan" => {
            let mode = args
                .first()
                .and_then(|v| v["mode"].as_str())
                .unwrap_or("quick");
            if !["quick", "full", "metadata"].contains(&mode) {
                return Err(Error::new(
                    "invalid_scan_mode",
                    "Choose a supported library scan mode.",
                ));
            }
            let permit = state
                .scan_gate
                .clone()
                .acquire_owned()
                .await
                .map_err(failed)?;
            scan_library(&window, &state, permit, mode).await
        }
        "renderer:session" => {
            Ok(json!({"port":state.media.port,"localAccessToken":state.media.token}))
        }
        "media:get-subtitle-url" => {
            let ordinal =
                match args.get(1) {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(value.as_u64().filter(|v| *v <= 1024).ok_or_else(|| {
                        Error::new("invalid_track", "Choose a valid subtitle track.")
                    })? as u32),
                };
            let url = state
                .media
                .grant_resource(
                    string(&args, 0)?,
                    loomtv_core::media_tools::Transform::Subtitle(ordinal),
                )
                .await?;
            Ok(json!({"url":url}))
        }
        "media:get-thumbnail" => {
            let time = args.get(1).and_then(Value::as_str).unwrap_or("00:00:01");
            let url = state
                .media
                .grant_resource(
                    string(&args, 0)?,
                    loomtv_core::media_tools::Transform::Thumbnail(time.into()),
                )
                .await?;
            Ok(json!({"url":url}))
        }
        "media:get-server-port" => Ok(json!(state.media.port)),
        "media:get-stream-url" => {
            if args
                .get(1)
                .is_some_and(|options| options["forceTranscode"] == true)
            {
                let session = state
                    .media
                    .transcodes
                    .start(string(&args, 0)?, args.get(1).unwrap_or(&Value::Null))
                    .await?;
                return Ok(
                    json!({"url":session["playlistUrl"],"contentType":"application/vnd.apple.mpegurl","fileName":"index.m3u8","isTranscoded":true,"isRemuxed":false,"playbackMode":"transcode","decisionReason":"The player requested an HLS fallback."}),
                );
            }
            let url = state.media.grant(string(&args, 0)?).await?;
            let input = string(&args, 0)?;
            if input.starts_with("iptv:") {
                let direct = tauri::Url::parse(input).ok().is_some_and(|url| {
                    url.query_pairs()
                        .any(|(key, value)| key == "format" && value == "direct")
                });
                return Ok(
                    json!({"url":url,"contentType":if direct{"application/octet-stream"}else{"application/vnd.apple.mpegurl"},"fileName":"live-tv","isTranscoded":false,"isRemuxed":false,"playbackMode":"direct"}),
                );
            }
            let source = std::path::Path::new(input);
            Ok(
                json!({"url":url,"contentType":loomtv_core::streaming::content_type(source),"fileName":source.file_name().and_then(|v|v.to_str()).unwrap_or("media"),"isTranscoded":false,"isRemuxed":false,"playbackMode":"direct"}),
            )
        }
        "media:ffmpeg-available" => {
            Ok(json!({"available":state.ffmpeg.is_some(),"path":state.ffmpeg}))
        }
        "media:probe" => Ok(api_result(
            state
                .media
                .probe
                .probe(state.store.clone(), string(&args, 0)?)
                .await,
        )),
        "media:can-direct-play" => {
            let result = async {
                let probe = state
                    .media
                    .probe
                    .probe(state.store.clone(), string(&args, 0)?)
                    .await?;
                loomtv_core::probe::can_direct_play(
                    &probe,
                    args.get(1).and_then(Value::as_str).unwrap_or("html5"),
                )
                .map(|value| json!(value))
            }
            .await;
            Ok(api_result(result))
        }
        "media:start-transcode" => Ok(api_result(
            state
                .media
                .transcodes
                .start(string(&args, 0)?, args.get(1).unwrap_or(&Value::Null))
                .await,
        )),
        "media:stop-transcode" => Ok(api_result(
            state
                .media
                .transcodes
                .stop(string(&args, 0)?)
                .await
                .map(|value| json!(value)),
        )),
        "libvlc:availability" | "libvlc:refresh-availability" => {
            if !cfg!(target_os = "macos") {
                return Ok(json!({"available":false,"enabled":true,"surface":"unavailable","warning":"The native video host is unavailable on this platform."}));
            }
            state.player.availability().await.map_err(media_error)
        }
        "libvlc:start" | "mpv:start" => {
            let _gate = state.playback_gate.lock().await;
            let input = string(&args, 0)?;
            let (source, scope) = if input.starts_with("iptv:") {
                let url = state.media.grant(input).await?;
                let store = state.store.lock().await;
                (
                    url,
                    PlaybackScope::Local {
                        profile: store.require_active(None)?,
                        revision: store.selection_revision(),
                    },
                )
            } else if input.starts_with("loomtv:") || input.starts_with("plexserver:") {
                (
                    state.media.grant(input).await?,
                    PlaybackScope::Remote(state.remote.epoch()),
                )
            } else {
                let store = state.store.lock().await;
                (
                    store.authorize_media(input)?.to_string_lossy().into_owned(),
                    PlaybackScope::Local {
                        profile: store.require_active(None)?,
                        revision: store.selection_revision(),
                    },
                )
            };
            let options = args.get(1).cloned().unwrap_or(json!({}));
            if let Some(subtitles) = options["subtitleFiles"].as_array() {
                if subtitles.len() > 32 {
                    return Err(Error::new(
                        "subtitle_limit",
                        "Too many external subtitle files.",
                    ));
                }
                for subtitle in subtitles {
                    state.store.lock().await.authorize_subtitle(
                        input,
                        subtitle["path"].as_str().ok_or_else(|| {
                            Error::new("invalid_subtitle", "The subtitle path is missing.")
                        })?,
                    )?;
                }
            }
            state.player.stop(None).await.map_err(media_error)?;
            state.libmpv.stop(None).await?;
            *state.native_scope.lock().await = None;
            let result = if channel == "mpv:start" {
                let drawable = window_host::ensure(&window).await?;
                state.libmpv.start(source, options, drawable).await?
            } else {
                let drawable = window_host::ensure(&window).await?;
                state
                    .player
                    .start(source, options, drawable)
                    .await
                    .map_err(media_error)?
            };
            *state.native_scope.lock().await = Some(scope);
            Ok(result)
        }
        "libvlc:command" | "mpv:command" => {
            let _gate = state.playback_gate.lock().await;
            match state.native_scope.lock().await.as_ref() {
                Some(PlaybackScope::Remote(epoch)) if *epoch == state.remote.epoch() => {}
                Some(PlaybackScope::Local { profile, revision }) => {
                    let store = state.store.lock().await;
                    store.require_active(Some(profile))?;
                    if store.selection_revision() != *revision {
                        return Err(Error::new("stale_profile", "The active profile changed."));
                    }
                }
                _ => {
                    return Err(Error::new(
                        "stale_playback",
                        "The playback session is no longer active.",
                    ))
                }
            }
            let session = string(&args, 0)?.to_owned();
            let command = args
                .get(1)
                .cloned()
                .ok_or_else(|| Error::new("invalid_command", "The playback command is missing."))?;
            if channel == "mpv:command" {
                state.libmpv.command(session, command).await
            } else {
                state
                    .player
                    .command(session, command)
                    .await
                    .map_err(media_error)
            }
        }

        "libvlc:stop" | "mpv:stop" => {
            let _gate = state.playback_gate.lock().await;
            let session = Some(string(&args, 0)?.to_owned());
            let result = if channel == "mpv:stop" {
                state.libmpv.stop(session).await?
            } else {
                state.player.stop(session).await.map_err(media_error)?
            };
            if result == true {
                state.playback_activity.release_all().await?;
                state.media_control.release_all().await?;
                *state.native_scope.lock().await = None;
                window_host::hide(&window).await?;
                window_host::external_backdrop(&window, false).await?;
            }
            Ok(result)
        }
        "libvlc:set-viewport" => {
            window_host::set_viewport(
                &window,
                serde_json::from_value(args.first().cloned().unwrap_or(Value::Null))?,
            )
            .await?;
            Ok(json!(true))
        }
        "libvlc:sync-surface" => {
            window_host::ensure(&window).await?;
            Ok(json!(true))
        }
        "libvlc:set-fullscreen-transition" => {
            if args.first() == Some(&json!(false)) {
                window_host::ensure(&window).await?;
            }
            Ok(json!(true))
        }
        "shell:open-external" => {
            let url = tauri::Url::parse(string(&args, 0)?).map_err(failed)?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err(Error::new(
                    "url_forbidden",
                    "Only HTTP and HTTPS links can open externally.",
                ));
            }
            window
                .opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(failed)?;
            Ok(Value::Null)
        }
        "mpv:availability" | "mpv:refresh-availability" => {
            Ok(state.libmpv.availability().await)
        }
        "mpv:choose-executable" | "mpv:reset-executable" => {
            Ok(state.libmpv.availability().await)
        }
        "updates:get-state" => Ok(
            json!({"status":"disabled","currentVersion":env!("CARGO_PKG_VERSION"),"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(windows){"win32"}else{"linux"},"arch":std::env::consts::ARCH,"supported":false,"message":"The Tauri update feed has not been configured."}),
        ),
        _ => {
            let profile_change = [
                "database:clear",
                "profiles:select",
                "profiles:lock",
                "profiles:delete",
                "profiles:pin",
                "profiles:select-guest",
                "profiles:reset-owner",
                "profile-restrictions:save",
            ]
            .contains(&channel.as_str());
            let _gate = if profile_change {
                Some(state.playback_gate.lock().await)
            } else {
                None
            };
            let store = state.store.clone();
            let command = channel.clone();
            let result =
                tokio::task::spawn_blocking(move || store.blocking_lock().invoke(&command, &args))
                    .await
                    .map_err(failed)??;
            if profile_change {
                state.player.stop(None).await.map_err(media_error)?;
                state.libmpv.stop(None).await?;
                state.playback_activity.release_all().await?;
                state.media_control.release_all().await?;
                *state.native_scope.lock().await = None;
                state.media.revoke_all().await;
                window_host::hide(&window).await?;
                window_host::external_backdrop(&window, false).await?;
                let state = state.store.lock().await.active_state()?;
                window
                    .emit("loomtv:profile:active-changed", [state])
                    .map_err(failed)?;
            }
            #[cfg(target_os = "macos")]
            if channel == "settings:save" {
                let timeout_minutes = {
                    let store = state.store.lock().await;
                    playback_activity::configured_timeout_minutes(&store.settings()?)
                };
                state
                    .playback_activity
                    .refresh_timeout(timeout_minutes)
                    .await?;
            }
            if (channel.starts_with("profiles:") || channel == "database:clear")
                && !["profiles:list", "profiles:get-active"].contains(&channel.as_str())
            {
                let store = state.store.lock().await;
                window.emit("loomtv:profiles:changed",[json!({"profiles":store.profiles()?,"selectionRevision":store.active_state()?["selectionRevision"]})]).map_err(failed)?;
            }
            Ok(result)
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("loomtv", media_protocol::handle)
        .register_asynchronous_uri_scheme_protocol("plexserver", media_protocol::handle)
        .invoke_handler(tauri::generate_handler![desktop_invoke])
        .setup(|app| {
            // Tauri panics if setup returns an error from the native launch callback.
            // Handle recoverable startup failures before crossing that boundary.
            let initialized = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
            desktop_menu::install(app.handle())?;
            // Match Electron's USER_DATA_DIR, including its shared override.
            let data_dir = std::env::var("LOOMTV_DATA_DIR").ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| PathBuf::from(value.trim()))
                .unwrap_or(app.path().config_dir()?.join("LoomTV"));
            let store = Arc::new(Mutex::new(Store::open_shared(&data_dir)?));
            let root = runtime_root(app.handle())?;
            let libvlc_disabled = std::env::var("LOOMTV_DISABLE_LIBVLC")
                .ok()
                .is_some_and(|value| ["1", "true", "yes"].contains(&value.to_ascii_lowercase().as_str()));
            let vlc_path = if libvlc_disabled {
                None
            } else {
                runtime_file(&root, &["libvlc/lib/libvlc.dylib", "libvlc/libvlc.dll"])
            };
            let ffmpeg = runtime_file(&root, &["ffmpeg/ffmpeg", "ffmpeg/ffmpeg.exe"]);
            let ffprobe = runtime_file(&root, &["ffmpeg/ffprobe", "ffmpeg/ffprobe.exe"]);
            let handle = app.handle().clone();
            let player = PlaybackService::new(
                vlc_path,
                Some(root.join("libvlc/plugins")),
                Arc::new(move |value| {
                    let _ = handle.emit_to("main", "loomtv:libvlc:state", [value]);
                }),
            )?;
            let handle = app.handle().clone();
            let libmpv = libmpv_host::LibMpvService::new(
                runtime_file(&root, &["mpv/lib/libloomtv_mpv_bridge.dylib"]).as_deref(),
                runtime_file(
                    &root,
                    &["mpv/lib/libmpv.dylib", "mpv/mpv.dll", "mpv/lib/libmpv.so"],
                )
                .as_deref(),
                Arc::new(move |value| {
                    let _ = handle.emit_to("main", "loomtv:mpv:state", [value]);
                }),
            );
            let remote = Arc::new(loomtv_core::remote::RemoteClient::default());
            let (media, stop) =
                tauri::async_runtime::block_on(loomtv_core::streaming::MediaServer::start(
                    store.clone(),
                    remote.clone(),
                    ffmpeg.clone(),
                    ffprobe,
                ))?;
            app.manage(Runtime {
                iptv: loomtv_core::iptv::IptvService::new(store.clone()),
                store,
                media,
                remote,
                native_scope: Mutex::new(None),
                drained: AtomicBool::new(false),
                media_stop: Mutex::new(Some(stop)),
                player,
                libmpv,
                playback_activity: playback_activity::PlaybackActivity::new()?,
                media_control: media_control::MediaControl::new(app.handle().clone()),
                metadata: loomtv_core::metadata::MetadataProviderGateway::new()?,
                playback_gate: Mutex::new(()),
                scan_gate: Arc::new(tokio::sync::Semaphore::new(1)),
                ffmpeg,
                closing: Arc::new(AtomicBool::new(false)),
            });
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("The main window configuration is missing.")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(trusted_ui_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            start_playback_scope_monitor(app.handle());
            Ok(())
            })();
            if let Err(error) = initialized {
                eprintln!("LoomTV Tauri could not start: {error}");
                app.dialog()
                    .message(error.to_string())
                    .title("LoomTV could not start")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .show(|_| std::process::exit(1));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                begin_shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if handle.try_state::<Runtime>().is_some_and(|state| !state.drained.load(Ordering::SeqCst)) {
                    api.prevent_exit();
                    begin_shutdown(handle);
                }
            }
        }),
        Err(error) => {
            eprintln!("LoomTV Tauri could not start: {error}");
            std::process::exit(1);
        }
    }
}

fn begin_shutdown(handle: &tauri::AppHandle) {
    let Some(state) = handle.try_state::<Runtime>() else {
        handle.exit(1);
        return;
    };
    if state.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Runtime>();
        let cleanup = async {
            let _gate = state.playback_gate.lock().await;
            let _ = state.player.shutdown().await;
            let _ = state.libmpv.shutdown().await;
            let _ = state.playback_activity.shutdown().await;
            let _ = state.media_control.shutdown().await;
            state.media.shutdown().await;
            if let Some(stop) = state.media_stop.lock().await.take() {
                let _ = stop.send(());
            }
            // A cancelled scan finishes its current atomic SQLite batch before process exit.
            let _scan = state.scan_gate.acquire().await;
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), cleanup).await;
        state.drained.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

async fn scan_library(
    window: &WebviewWindow,
    state: &Runtime,
    permit: tokio::sync::OwnedSemaphorePermit,
    mode: &str,
) -> Result<Value> {
    let _permit = permit;
    let request = state.store.lock().await.scan_request()?;
    let profile = request.profile.clone();
    let revision = request.revision;
    let total_folders = request.roots.len();
    if mode != "metadata" {
        let store = state.store.clone();
        let target = window.clone();
        let cancelled = state.closing.clone();
        tokio::task::spawn_blocking(move || {
            loomtv_core::scanner::scan(
                store,
                request,
                cancelled,
                Arc::new(move |mut value| {
                    value["isComplete"] = json!(false);
                    let _ = target.emit("loomtv:library:scan-progress", [value]);
                }),
            )
        })
        .await
        .map_err(failed)??;
    }
    let target = window.clone();
    let metadata = loomtv_core::metadata_scan::enrich_library_metadata(
        state.store.clone(),
        &state.metadata,
        &profile,
        revision,
        mode,
        Arc::new(move |mut value| {
            value["isComplete"] = json!(false);
            value["scannedFolders"] = json!(total_folders);
            value["totalFolders"] = json!(total_folders);
            let _ = target.emit("loomtv:library:scan-progress", [value]);
        }),
        state.closing.clone(),
    )
    .await?;
    if mode == "metadata"
        && metadata["attemptedItems"].as_u64().unwrap_or(0) > 0
        && metadata["failedItems"] == metadata["attemptedItems"]
    {
        return Err(Error::new(
            "metadata_refresh_failed",
            "Metadata could not be refreshed. Check the saved API keys and network connection.",
        ));
    }
    let store = state.store.lock().await;
    store.require_active(Some(&profile))?;
    if store.selection_revision() != revision {
        return Err(Error::new(
            "scan_cancelled",
            "The profile changed during the scan.",
        ));
    }
    let mut result = store.library(true)?;
    result["metadataRefresh"] = metadata;
    window.emit("loomtv:library:scan-progress", [json!({"isComplete":true,"scannedFolders":total_folders,"totalFolders":total_folders})]).map_err(failed)?;
    Ok(result)
}

fn trusted_ui_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(5197))
}

fn api_result(result: Result<Value>) -> Value {
    match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(error) => {
            json!({"ok":false,"error":error.message,"code":error.code,"retryable":error.retryable})
        }
    }
}

/// Native direct file access must stop even when the renderer sends no more commands.
fn start_playback_scope_monitor(handle: &tauri::AppHandle) {
    let app = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(250));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let state = app.state::<Runtime>();
            if state.closing.load(Ordering::SeqCst) {
                break;
            }
            let _gate = state.playback_gate.lock().await;
            let valid = match state.native_scope.lock().await.as_ref() {
                None => true,
                Some(PlaybackScope::Remote(epoch)) => *epoch == state.remote.epoch(),
                Some(PlaybackScope::Local { profile, revision }) => {
                    let store = state.store.lock().await;
                    store.require_active(Some(profile)).is_ok()
                        && store.selection_revision() == *revision
                }
            };
            if !valid {
                let _ = state.player.stop(None).await;
                let _ = state.libmpv.stop(None).await;
                let _ = state.playback_activity.release_all().await;
                let _ = state.media_control.release_all().await;
                *state.native_scope.lock().await = None;
                state.media.revoke_all().await;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window_host::hide(&window).await;
                    let _ = window_host::external_backdrop(&window, false).await;
                }
            }
        }
    });
}
