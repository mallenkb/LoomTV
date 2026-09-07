use loomtv_core::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow};

const COMMANDS: &[&str] = &[
    "play",
    "pause",
    "toggle",
    "stop",
    "seekRelative",
    "seekAbsolute",
    "previousItem",
    "nextItem",
    "setRate",
];
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    session_id: String,
    state: String,
    position_seconds: f64,
    duration_seconds: f64,
    rate: f64,
    supported_commands: Vec<String>,
    skip_forward_seconds: f64,
    skip_back_seconds: f64,
    title: String,
    series_title: Option<String>,
    season: Option<f64>,
    episode: Option<f64>,
    queue_index: f64,
    queue_count: f64,
    engine: String,
    engine_session_id: Option<String>,
    artwork_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    session_id: String,
    state: String,
    position_seconds: f64,
    duration_seconds: f64,
    rate: f64,
    supported_commands: Vec<String>,
    skip_forward_seconds: f64,
    skip_back_seconds: f64,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    series_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    season: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episode: Option<u64>,
    queue_index: u64,
    queue_count: u64,
    engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artwork_url: Option<String>,
}

struct ControllerState {
    owner: Option<String>,
    published: Option<Snapshot>,
    awaiting_play_to_reclaim: bool,
    adapter_active: bool,
    failure_reason: Option<String>,
}

pub(crate) struct MediaControl {
    app: AppHandle,
    state: Arc<Mutex<ControllerState>>,
}

impl MediaControl {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            state: Arc::new(Mutex::new(ControllerState {
                owner: None,
                published: None,
                awaiting_play_to_reclaim: false,
                adapter_active: false,
                failure_reason: None,
            })),
        }
    }

    pub(crate) async fn handle(
        &self,
        window: &WebviewWindow,
        channel: &str,
        args: &[Value],
    ) -> Result<Value> {
        match channel {
            "media-control:publish" => {
                if args.len() != 1 {
                    return Err(invalid("Media control publish expects one snapshot."));
                }
                self.publish(window, &args[0]).await
            }
            "media-control:release" => {
                if !args.is_empty() {
                    return Err(invalid("Media control release does not accept arguments."));
                }
                self.release(window.label()).await.map(Value::Bool)
            }
            _ => Err(Error::new(
                "port_not_implemented",
                format!("The Rust port has not implemented {channel} yet."),
            )),
        }
    }

    pub(crate) async fn publish(&self, window: &WebviewWindow, value: &Value) -> Result<Value> {
        let snapshot = normalize_snapshot(value)?;
        let owner = window.label().to_owned();

        if snapshot.state == "stopped" {
            let should_release = {
                let mut state = self.lock_state()?;
                let should_release = state
                    .owner
                    .as_deref()
                    .is_none_or(|current| current == owner);
                if should_release {
                    release_state(&mut state);
                }
                should_release
            };
            if should_release {
                self.clear_native().await?;
            }
            return self.diagnostics();
        }

        let should_publish = {
            let mut state = self.lock_state()?;
            if state.awaiting_play_to_reclaim && snapshot.state != "playing" {
                return diagnostics_for(&state);
            }
            let owner_changed = state.owner.as_deref() != Some(&owner);
            let discontinuity = is_discontinuity(state.published.as_ref(), &snapshot);
            let should_publish = owner_changed || discontinuity || !state.adapter_active;
            state.owner = Some(owner);
            state.awaiting_play_to_reclaim = false;
            state.published = Some(snapshot.clone());
            should_publish
        };

        if should_publish {
            match self.publish_native(snapshot).await {
                Ok(()) => {
                    let mut state = self.lock_state()?;
                    state.adapter_active = true;
                    state.failure_reason = None;
                }
                Err(error) => {
                    let mut state = self.lock_state()?;
                    state.adapter_active = false;
                    state.failure_reason = Some(error.message);
                }
            }
        }
        self.diagnostics()
    }

    pub(crate) async fn release(&self, owner: &str) -> Result<bool> {
        let released = {
            let mut state = self.lock_state()?;
            if state.owner.as_deref() != Some(owner) {
                false
            } else {
                release_state(&mut state);
                true
            }
        };
        if released {
            self.clear_native().await?;
        }
        Ok(released)
    }

    pub(crate) async fn release_all(&self) -> Result<()> {
        {
            let mut state = self.lock_state()?;
            release_state(&mut state);
        }
        self.clear_native().await
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        self.release_all().await
    }

    pub(crate) fn diagnostics(&self) -> Result<Value> {
        let state = self.lock_state()?;
        diagnostics_for(&state)
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ControllerState>> {
        self.state.lock().map_err(|_| unavailable())
    }

    #[cfg(target_os = "macos")]
    async fn publish_native(&self, snapshot: Snapshot) -> Result<()> {
        let dispatch = self.state.clone();
        let app = self.app.clone();
        self.run_on_main(move || {
            NATIVE_STATE.with(|slot| {
                let mut state = slot.borrow_mut();
                if state.is_none() {
                    *state = Some(NativeState::start(app, dispatch)?);
                }
                state
                    .as_mut()
                    .expect("native state initialized")
                    .publish(&snapshot)
            })
        })
        .await
    }

    #[cfg(not(target_os = "macos"))]
    async fn publish_native(&self, _snapshot: Snapshot) -> Result<()> {
        Err(Error::new(
            "media_control_unavailable",
            "System media controls are unavailable on this platform.",
        ))
    }

    #[cfg(target_os = "macos")]
    async fn clear_native(&self) -> Result<()> {
        self.run_on_main(|| {
            NATIVE_STATE.with(|slot| {
                if let Some(mut state) = slot.borrow_mut().take() {
                    state.clear();
                }
            });
            Ok(())
        })
        .await
    }

    #[cfg(not(target_os = "macos"))]
    async fn clear_native(&self) -> Result<()> {
        Ok(())
    }

    #[cfg(target_os = "macos")]
    async fn run_on_main<F>(&self, operation: F) -> Result<()>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                let result = operation();
                let _ = reply.send(result);
            })
            .map_err(|_| unavailable())?;
        tokio::time::timeout(RESPONSE_TIMEOUT, response)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?
    }
}

fn release_state(state: &mut ControllerState) {
    state.owner = None;
    state.published = None;
    state.awaiting_play_to_reclaim = true;
    state.adapter_active = false;
    state.failure_reason = None;
}

fn diagnostics_for(state: &ControllerState) -> Result<Value> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    };
    let adapter = if state.adapter_active {
        "macos-mediaplayer"
    } else {
        "unsupported"
    };
    let mut value = json!({
        "platform": platform,
        "adapter": adapter,
        "active": state.adapter_active,
    });
    if let Some(reason) = &state.failure_reason {
        value["reason"] = Value::String(reason.clone());
    }
    Ok(value)
}

fn normalize_snapshot(value: &Value) -> Result<Snapshot> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("The media control snapshot is invalid."))?;
    if [
        "seriesTitle",
        "season",
        "episode",
        "engineSessionId",
        "artworkUrl",
    ]
    .iter()
    .any(|key| object.get(*key).is_some_and(Value::is_null))
    {
        return Err(invalid("The media control snapshot is invalid."));
    }
    let raw: SnapshotInput = serde_json::from_value(value.clone())
        .map_err(|_| invalid("The media control snapshot is invalid."))?;
    validate_input(&raw)?;
    let duration_seconds = raw.duration_seconds.min(86_400.0);
    let position_seconds = raw
        .position_seconds
        .min(86_400.0)
        .min(if duration_seconds > 0.0 {
            duration_seconds
        } else {
            86_400.0
        });
    let supported_commands = COMMANDS
        .iter()
        .filter(|command| {
            raw.supported_commands
                .iter()
                .any(|value| value == **command)
        })
        .map(|value| (*value).to_owned())
        .collect();
    Ok(Snapshot {
        session_id: normalize_text(&raw.session_id, "loomtv-player"),
        state: raw.state,
        position_seconds,
        duration_seconds,
        rate: raw.rate.clamp(0.05, 16.0),
        supported_commands,
        skip_forward_seconds: raw.skip_forward_seconds.min(600.0),
        skip_back_seconds: raw.skip_back_seconds.min(600.0),
        title: normalize_text(&raw.title, "LoomTV"),
        series_title: normalize_optional_text(raw.series_title.as_deref()),
        season: normalize_optional_index(raw.season),
        episode: normalize_optional_index(raw.episode),
        queue_index: normalize_count(raw.queue_index),
        queue_count: normalize_count(raw.queue_count),
        engine: raw.engine,
        engine_session_id: normalize_optional_text(raw.engine_session_id.as_deref()),
        artwork_url: raw.artwork_url.filter(|value| !value.is_empty()),
    })
}

fn validate_input(raw: &SnapshotInput) -> Result<()> {
    if raw.session_id.len() > 200
        || raw.title.len() > 400
        || raw
            .series_title
            .as_ref()
            .is_some_and(|value| value.len() > 400)
        || raw
            .engine_session_id
            .as_ref()
            .is_some_and(|value| value.len() > 200)
        || raw
            .artwork_url
            .as_ref()
            .is_some_and(|value| value.len() > 2048)
        || raw.supported_commands.len() > 16
        || !["playing", "paused", "stopped"].contains(&raw.state.as_str())
        || !["libvlc", "mpv", "chromium"].contains(&raw.engine.as_str())
        || raw
            .supported_commands
            .iter()
            .any(|value| !COMMANDS.contains(&value.as_str()))
        || !finite_nonnegative(raw.position_seconds)
        || !finite_nonnegative(raw.duration_seconds)
        || !finite_positive(raw.rate)
        || !finite_positive(raw.skip_forward_seconds)
        || !finite_positive(raw.skip_back_seconds)
        || !finite_nonnegative(raw.queue_index)
        || !finite_nonnegative(raw.queue_count)
        || raw.season.is_some_and(|value| !finite_nonnegative(value))
        || raw.episode.is_some_and(|value| !finite_nonnegative(value))
    {
        return Err(invalid("The media control snapshot is invalid."));
    }
    Ok(())
}

fn finite_nonnegative(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn normalize_text(value: &str, fallback: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = if text.is_empty() { fallback } else { &text };
    text.chars().take(240).collect()
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(|value| normalize_text(value, ""))
        .filter(|value| !value.is_empty())
}

fn normalize_optional_index(value: Option<f64>) -> Option<u64> {
    value
        .filter(|value| *value > 0.0)
        .map(|value| value.floor() as u64)
}

fn normalize_count(value: f64) -> u64 {
    value.floor().min(100_000.0) as u64
}

fn is_discontinuity(previous: Option<&Snapshot>, next: &Snapshot) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.session_id != next.session_id
        || previous.state != next.state
        || previous.rate != next.rate
        || previous.duration_seconds != next.duration_seconds
        || previous.title != next.title
        || previous.series_title != next.series_title
        || previous.season != next.season
        || previous.episode != next.episode
        || previous.artwork_url != next.artwork_url
        || previous.queue_index != next.queue_index
        || previous.queue_count != next.queue_count
        || previous.skip_forward_seconds != next.skip_forward_seconds
        || previous.skip_back_seconds != next.skip_back_seconds
        || previous.supported_commands != next.supported_commands
    {
        return true;
    }
    if next.state != "playing" {
        previous.position_seconds != next.position_seconds
    } else {
        (next.position_seconds - previous.position_seconds).abs() > 2.0
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new("invalid_argument", message)
}

fn unavailable() -> Error {
    Error::new(
        "media_control_unavailable",
        "The system media control service is unavailable.",
    )
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{ControllerState, Snapshot};
    use block2::RcBlock;
    use loomtv_core::{Error, Result};
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::{NSArray, NSMutableDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPChangePlaybackPositionCommandEvent, MPChangePlaybackRateCommandEvent,
        MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist,
        MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
        MPNowPlayingInfoPropertyDefaultPlaybackRate, MPNowPlayingInfoPropertyElapsedPlaybackTime,
        MPNowPlayingInfoPropertyMediaType, MPNowPlayingInfoPropertyPlaybackQueueCount,
        MPNowPlayingInfoPropertyPlaybackQueueIndex, MPNowPlayingInfoPropertyPlaybackRate,
        MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
        MPRemoteCommandHandlerStatus, MPSkipIntervalCommandEvent,
    };
    use serde_json::{json, Value};
    use std::{
        cell::RefCell,
        ptr::NonNull,
        sync::{Arc, Mutex},
    };
    use tauri::{AppHandle, Emitter};

    thread_local! {
        pub(super) static NATIVE_STATE: RefCell<Option<NativeState>> = const { RefCell::new(None) };
    }

    #[derive(Clone, Copy)]
    enum CommandKind {
        Play,
        Pause,
        Toggle,
        Stop,
        Previous,
        Next,
        SkipBack,
        SkipForward,
        SeekAbsolute,
        SetRate,
    }

    struct InstalledTarget {
        name: &'static str,
        command: Retained<MPRemoteCommand>,
        target: Retained<AnyObject>,
    }

    pub(super) struct NativeState {
        command_center: Retained<MPRemoteCommandCenter>,
        info_center: Retained<MPNowPlayingInfoCenter>,
        targets: Vec<InstalledTarget>,
    }

    impl NativeState {
        pub(super) fn start(app: AppHandle, dispatch: Arc<Mutex<ControllerState>>) -> Result<Self> {
            MainThreadMarker::new().ok_or_else(native_unavailable)?;
            let command_center = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };
            let info_center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
            let mut state = Self {
                command_center,
                info_center,
                targets: Vec::with_capacity(10),
            };
            let bindings = unsafe {
                [
                    (
                        "play",
                        state.command_center.playCommand(),
                        CommandKind::Play,
                    ),
                    (
                        "pause",
                        state.command_center.pauseCommand(),
                        CommandKind::Pause,
                    ),
                    (
                        "toggle",
                        state.command_center.togglePlayPauseCommand(),
                        CommandKind::Toggle,
                    ),
                    (
                        "stop",
                        state.command_center.stopCommand(),
                        CommandKind::Stop,
                    ),
                    (
                        "previousItem",
                        state.command_center.previousTrackCommand(),
                        CommandKind::Previous,
                    ),
                    (
                        "nextItem",
                        state.command_center.nextTrackCommand(),
                        CommandKind::Next,
                    ),
                    (
                        "seekRelative",
                        state.command_center.skipBackwardCommand().into_super(),
                        CommandKind::SkipBack,
                    ),
                    (
                        "seekRelative",
                        state.command_center.skipForwardCommand().into_super(),
                        CommandKind::SkipForward,
                    ),
                    (
                        "seekAbsolute",
                        state
                            .command_center
                            .changePlaybackPositionCommand()
                            .into_super(),
                        CommandKind::SeekAbsolute,
                    ),
                    (
                        "setRate",
                        state
                            .command_center
                            .changePlaybackRateCommand()
                            .into_super(),
                        CommandKind::SetRate,
                    ),
                ]
            };
            for (name, command, kind) in bindings {
                state.install(name, command, kind, app.clone(), dispatch.clone());
            }
            Ok(state)
        }

        fn install(
            &mut self,
            name: &'static str,
            command: Retained<MPRemoteCommand>,
            kind: CommandKind,
            app: AppHandle,
            dispatch: Arc<Mutex<ControllerState>>,
        ) {
            unsafe { command.setEnabled(false) };
            let handler = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    route_command(&app, &dispatch, kind, event)
                }))
                .unwrap_or(MPRemoteCommandHandlerStatus::CommandFailed)
            });
            let target = unsafe { command.addTargetWithHandler(&handler) };
            self.targets.push(InstalledTarget {
                name,
                command,
                target,
            });
        }

        pub(super) fn publish(&mut self, snapshot: &Snapshot) -> Result<()> {
            for target in &self.targets {
                let enabled = snapshot
                    .supported_commands
                    .iter()
                    .any(|value| value == target.name);
                unsafe { target.command.setEnabled(enabled) };
            }
            let back = NSArray::from_slice(&[&*NSNumber::new_f64(snapshot.skip_back_seconds)]);
            let forward =
                NSArray::from_slice(&[&*NSNumber::new_f64(snapshot.skip_forward_seconds)]);
            unsafe {
                self.command_center
                    .skipBackwardCommand()
                    .setPreferredIntervals(&back);
                self.command_center
                    .skipForwardCommand()
                    .setPreferredIntervals(&forward);
            }
            let info = NSMutableDictionary::<NSString, AnyObject>::new();
            unsafe { insert_string(&info, MPMediaItemPropertyTitle, &snapshot.title) };
            let episode_line = match (snapshot.season, snapshot.episode) {
                (Some(season), Some(episode)) => {
                    Some(format!("Season {season}, Episode {episode}"))
                }
                _ => snapshot.series_title.clone(),
            };
            if let Some(line) = episode_line {
                unsafe { insert_string(&info, MPMediaItemPropertyArtist, &line) };
            }
            if let Some(series) = &snapshot.series_title {
                unsafe { insert_string(&info, MPMediaItemPropertyAlbumTitle, series) };
            }
            if snapshot.duration_seconds > 0.0 {
                unsafe {
                    insert_number(
                        &info,
                        MPMediaItemPropertyPlaybackDuration,
                        snapshot.duration_seconds,
                    )
                };
            }
            unsafe {
                insert_number(
                    &info,
                    MPNowPlayingInfoPropertyElapsedPlaybackTime,
                    snapshot.position_seconds,
                )
            };
            unsafe {
                insert_number(
                    &info,
                    MPNowPlayingInfoPropertyPlaybackRate,
                    if snapshot.state == "playing" {
                        snapshot.rate
                    } else {
                        0.0
                    },
                )
            };
            unsafe {
                insert_number(
                    &info,
                    MPNowPlayingInfoPropertyDefaultPlaybackRate,
                    snapshot.rate,
                )
            };
            unsafe { insert_number(&info, MPNowPlayingInfoPropertyMediaType, 2.0) };
            if snapshot.queue_count > 0 {
                unsafe {
                    insert_number(
                        &info,
                        MPNowPlayingInfoPropertyPlaybackQueueCount,
                        snapshot.queue_count as f64,
                    )
                };
                unsafe {
                    insert_number(
                        &info,
                        MPNowPlayingInfoPropertyPlaybackQueueIndex,
                        snapshot.queue_index as f64,
                    )
                };
            }
            unsafe {
                self.info_center.setNowPlayingInfo(Some(&info));
                self.info_center
                    .setPlaybackState(if snapshot.state == "playing" {
                        MPNowPlayingPlaybackState::Playing
                    } else {
                        MPNowPlayingPlaybackState::Paused
                    });
            }
            Ok(())
        }

        pub(super) fn clear(&mut self) {
            for target in self.targets.drain(..) {
                unsafe {
                    target.command.setEnabled(false);
                    target.command.removeTarget(Some(&target.target));
                }
            }
            unsafe {
                self.info_center.setNowPlayingInfo(None);
                self.info_center
                    .setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            }
        }
    }

    impl Drop for NativeState {
        fn drop(&mut self) {
            self.clear();
        }
    }

    fn route_command(
        app: &AppHandle,
        dispatch: &Arc<Mutex<ControllerState>>,
        kind: CommandKind,
        event: NonNull<MPRemoteCommandEvent>,
    ) -> MPRemoteCommandHandlerStatus {
        let (owner, snapshot) = match dispatch.lock() {
            Ok(state) => match (&state.owner, &state.published) {
                (Some(owner), Some(snapshot)) => (owner.clone(), snapshot.clone()),
                _ => return MPRemoteCommandHandlerStatus::NoActionableNowPlayingItem,
            },
            Err(_) => return MPRemoteCommandHandlerStatus::CommandFailed,
        };
        let Some(command) = command_payload(kind, event, &snapshot) else {
            return MPRemoteCommandHandlerStatus::NoActionableNowPlayingItem;
        };
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !snapshot
            .supported_commands
            .iter()
            .any(|value| value == command_type)
        {
            return MPRemoteCommandHandlerStatus::NoActionableNowPlayingItem;
        }
        if app
            .emit_to(
                owner,
                "loomtv:media-control:command",
                [command, json!(false)],
            )
            .is_err()
        {
            return MPRemoteCommandHandlerStatus::CommandFailed;
        }
        MPRemoteCommandHandlerStatus::Success
    }

    fn command_payload(
        kind: CommandKind,
        event: NonNull<MPRemoteCommandEvent>,
        snapshot: &Snapshot,
    ) -> Option<Value> {
        Some(match kind {
            CommandKind::Play => json!({"type":"play"}),
            CommandKind::Pause => json!({"type":"pause"}),
            CommandKind::Toggle => json!({"type":"toggle"}),
            CommandKind::Stop => json!({"type":"stop"}),
            CommandKind::Previous => json!({"type":"previousItem"}),
            CommandKind::Next => json!({"type":"nextItem"}),
            CommandKind::SkipBack | CommandKind::SkipForward => {
                let event = unsafe { event.as_ref() };
                let interval = event
                    .downcast_ref::<MPSkipIntervalCommandEvent>()
                    .map(|event| unsafe { event.interval() })
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .unwrap_or(if matches!(kind, CommandKind::SkipBack) {
                        snapshot.skip_back_seconds
                    } else {
                        snapshot.skip_forward_seconds
                    });
                let offset = if matches!(kind, CommandKind::SkipBack) {
                    -interval
                } else {
                    interval
                };
                json!({"type":"seekRelative","offsetSeconds":offset})
            }
            CommandKind::SeekAbsolute => {
                let event = unsafe { event.as_ref() };
                let position = unsafe {
                    event
                        .downcast_ref::<MPChangePlaybackPositionCommandEvent>()?
                        .positionTime()
                };
                if !position.is_finite() || position < 0.0 {
                    return None;
                }
                json!({"type":"seekAbsolute","positionSeconds":position})
            }
            CommandKind::SetRate => {
                let event = unsafe { event.as_ref() };
                let rate = unsafe {
                    event
                        .downcast_ref::<MPChangePlaybackRateCommandEvent>()?
                        .playbackRate()
                } as f64;
                if !rate.is_finite() || rate <= 0.0 {
                    return None;
                }
                json!({"type":"setRate","rate":rate})
            }
        })
    }

    fn insert_string(
        dictionary: &NSMutableDictionary<NSString, AnyObject>,
        key: &NSString,
        value: &str,
    ) {
        let value = NSString::from_str(value);
        dictionary.insert(key, &value);
    }

    fn insert_number(
        dictionary: &NSMutableDictionary<NSString, AnyObject>,
        key: &NSString,
        value: f64,
    ) {
        let value = NSNumber::new_f64(value);
        dictionary.insert(key, &value);
    }

    fn native_unavailable() -> Error {
        Error::new(
            "media_control_unavailable",
            "The macOS MediaPlayer service is unavailable.",
        )
    }
}

#[cfg(target_os = "macos")]
use macos::{NativeState, NATIVE_STATE};
