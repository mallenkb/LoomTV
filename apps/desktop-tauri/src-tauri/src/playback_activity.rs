use loomtv_core::{Error, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const COMMAND_CAPACITY: usize = 32;
const MAX_LEASES: usize = 64;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

type Reply = oneshot::Sender<Result<()>>;

enum Command {
    Set {
        key: String,
        active: bool,
        timeout_minutes: u16,
        reply: Reply,
    },
    RefreshTimeout {
        timeout_minutes: u16,
        reply: Reply,
    },
    ReleaseAll {
        reply: Reply,
    },
    Shutdown {
        reply: Option<Reply>,
    },
}

pub(crate) struct PlaybackActivity {
    sender: SyncSender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
    closing: AtomicBool,
}

impl PlaybackActivity {
    pub(crate) fn new() -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(COMMAND_CAPACITY);
        let thread = thread::Builder::new()
            .name("loomtv-playback-activity".into())
            .spawn(move || worker_loop(receiver))
            .map_err(|_| {
                Error::new(
                    "playback_activity_unavailable",
                    "The playback sleep inhibitor could not start.",
                )
            })?;
        Ok(Self {
            sender,
            thread: Mutex::new(Some(thread)),
            closing: AtomicBool::new(false),
        })
    }

    /// Handle the existing `[key, active, label?]` desktop bridge contract.
    pub(crate) async fn handle(&self, args: &[Value], timeout_minutes: u16) -> Result<Value> {
        if !(2..=3).contains(&args.len()) {
            return Err(Error::new(
                "invalid_argument",
                "Playback activity expects a key, an active flag, and an optional label.",
            ));
        }
        let raw_key = args[0]
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or_else(|| {
                Error::new(
                    "invalid_argument",
                    "Playback activity requires a nonempty key.",
                )
            })?;
        if raw_key.len() > 16_384 || raw_key.contains('\0') {
            return Err(Error::new(
                "invalid_argument",
                "The playback activity key is invalid.",
            ));
        }
        let active = args[1].as_bool().ok_or_else(|| {
            Error::new(
                "invalid_argument",
                "Playback activity requires a Boolean active flag.",
            )
        })?;
        // JavaScript's optional `label` becomes JSON null when the shared
        // bridge serializes a call that omitted it. Treat that the same as an
        // absent argument, matching Electron's IPC behavior during teardown.
        if let Some(label) = args.get(2).filter(|value| !value.is_null()) {
            if !label.is_string() {
                return Err(Error::new(
                    "invalid_argument",
                    "The playback activity label must be a string.",
                ));
            }
        }

        // Electron accepts a nonempty string at the IPC boundary and then ignores
        // a key that contains only whitespace.
        let key = raw_key.trim();
        if key.is_empty() {
            return Ok(json!(true));
        }

        self.ensure_open()?;
        let (reply, response) = oneshot::channel();
        self.try_send(Command::Set {
            key: key.to_owned(),
            active,
            timeout_minutes: timeout_minutes.min(480),
            reply,
        })?;
        wait_for_response(response).await?;
        Ok(json!(true))
    }

    /// Restart active lease timers after the display-sleep setting changes.
    pub(crate) async fn refresh_timeout(&self, timeout_minutes: u16) -> Result<()> {
        self.ensure_open()?;
        let (reply, response) = oneshot::channel();
        self.try_send(Command::RefreshTimeout {
            timeout_minutes: timeout_minutes.min(480),
            reply,
        })?;
        wait_for_response(response).await
    }

    /// Release the operating-system activity and forget all renderer leases.
    pub(crate) async fn release_all(&self) -> Result<()> {
        self.ensure_open()?;
        let (reply, response) = oneshot::channel();
        self.try_send(Command::ReleaseAll { reply })?;
        wait_for_response(response).await
    }

    /// Release every lease and stop the owner thread. Calls after the first are harmless.
    pub(crate) async fn shutdown(&self) -> Result<()> {
        if self.closing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let (reply, response) = oneshot::channel();
        let sender = self.sender.clone();
        tokio::task::spawn_blocking(move || sender.send(Command::Shutdown { reply: Some(reply) }))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        let response_result = wait_for_response(response).await;

        let thread = self.thread.lock().map_err(|_| unavailable())?.take();
        let join_result = match thread {
            Some(thread) => tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable()),
            None => Ok(()),
        };

        response_result.and(join_result)
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closing.load(Ordering::SeqCst) {
            Err(Error::new(
                "playback_activity_unavailable",
                "The playback sleep inhibitor is shutting down.",
            ))
        } else {
            Ok(())
        }
    }

    fn try_send(&self, command: Command) -> Result<()> {
        self.sender.try_send(command).map_err(|error| match error {
            TrySendError::Full(_) => Error::new(
                "playback_activity_busy",
                "The playback sleep inhibitor is busy.",
            ),
            TrySendError::Disconnected(_) => unavailable(),
        })
    }
}

impl Drop for PlaybackActivity {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.sender.send(Command::Shutdown { reply: None });
        if let Ok(thread) = self.thread.get_mut() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Match Electron's `Number`, finite check, rounding, and 0 through 480 clamp
/// for values that can survive the normalized settings store.
pub(crate) fn configured_timeout_minutes(settings: &Value) -> u16 {
    let value = &settings["playbackDisplaySleepTimeoutMinutes"];
    let number = match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(u8::from(*value) as f64),
        Value::Number(value) => value.as_f64(),
        Value::String(value) if value.trim().is_empty() => Some(0.0),
        Value::String(value) => value.trim().parse::<f64>().ok(),
        _ => None,
    };
    number
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .round()
        .clamp(0.0, 480.0) as u16
}

async fn wait_for_response(response: oneshot::Receiver<Result<()>>) -> Result<()> {
    tokio::time::timeout(RESPONSE_TIMEOUT, response)
        .await
        .map_err(|_| {
            Error::new(
                "playback_activity_timeout",
                "The playback sleep inhibitor did not respond.",
            )
        })?
        .map_err(|_| unavailable())?
}

fn unavailable() -> Error {
    Error::new(
        "playback_activity_unavailable",
        "The playback sleep inhibitor is unavailable.",
    )
}

struct Lease {
    timeout_minutes: u16,
    expires_at: Option<Instant>,
    expired: bool,
}

impl Lease {
    fn new(timeout_minutes: u16, now: Instant) -> Self {
        let mut lease = Self {
            timeout_minutes,
            expires_at: None,
            expired: false,
        };
        lease.reset(timeout_minutes, now);
        lease
    }

    fn reset(&mut self, timeout_minutes: u16, now: Instant) {
        self.timeout_minutes = timeout_minutes;
        self.expired = false;
        self.expires_at = (timeout_minutes > 0)
            .then(|| now + Duration::from_secs(u64::from(timeout_minutes) * 60));
    }
}

struct Worker {
    leases: HashMap<String, Lease>,
    owner: platform::ActivityOwner,
}

impl Worker {
    fn new() -> Self {
        Self {
            leases: HashMap::new(),
            owner: platform::ActivityOwner::new(),
        }
    }

    fn set(&mut self, key: String, active: bool, timeout_minutes: u16) -> Result<()> {
        platform::ensure_supported()?;
        let now = Instant::now();
        self.refresh_changed_timeouts(timeout_minutes, now);

        if active {
            if !self.leases.contains_key(&key) && self.leases.len() >= MAX_LEASES {
                return Err(Error::new(
                    "playback_activity_limit",
                    "Too many playback activity leases are registered.",
                ));
            }
            self.leases
                .entry(key)
                .or_insert_with(|| Lease::new(timeout_minutes, now));
        } else {
            self.leases.remove(&key);
        }
        self.reconcile()
    }

    fn refresh_timeout(&mut self, timeout_minutes: u16) -> Result<()> {
        platform::ensure_supported()?;
        self.refresh_changed_timeouts(timeout_minutes, Instant::now());
        self.reconcile()
    }

    fn refresh_changed_timeouts(&mut self, timeout_minutes: u16, now: Instant) {
        for lease in self.leases.values_mut() {
            if lease.timeout_minutes != timeout_minutes {
                lease.reset(timeout_minutes, now);
            }
        }
    }

    fn expire_due_leases(&mut self) -> Result<()> {
        let now = Instant::now();
        for lease in self.leases.values_mut() {
            if !lease.expired && lease.expires_at.is_some_and(|deadline| deadline <= now) {
                lease.expired = true;
                lease.expires_at = None;
            }
        }
        self.reconcile()
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.leases
            .values()
            .filter(|lease| !lease.expired)
            .filter_map(|lease| lease.expires_at)
            .min()
    }

    fn release_all(&mut self) -> Result<()> {
        self.leases.clear();
        self.reconcile()
    }

    fn reconcile(&mut self) -> Result<()> {
        self.owner
            .set_enabled(self.leases.values().any(|lease| !lease.expired))
    }
}

fn worker_loop(receiver: Receiver<Command>) {
    let mut worker = Worker::new();
    loop {
        let command = match worker.next_deadline() {
            Some(deadline) => {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => {
                        let _ = worker.expire_due_leases();
                        None
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match receiver.recv() {
                Ok(command) => Some(command),
                Err(_) => break,
            },
        };
        let Some(command) = command else {
            continue;
        };

        match command {
            Command::Set {
                key,
                active,
                timeout_minutes,
                reply,
            } => {
                if !reply.is_closed() {
                    let _ = reply.send(worker.set(key, active, timeout_minutes));
                }
            }
            Command::RefreshTimeout {
                timeout_minutes,
                reply,
            } => {
                if !reply.is_closed() {
                    let _ = reply.send(worker.refresh_timeout(timeout_minutes));
                }
            }
            Command::ReleaseAll { reply } => {
                if !reply.is_closed() {
                    let _ = reply.send(worker.release_all());
                }
            }
            Command::Shutdown { reply } => {
                let result = worker.release_all();
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
                return;
            }
        }
    }
    let _ = worker.release_all();
}

#[cfg(target_os = "macos")]
mod platform {
    use loomtv_core::Result;
    use objc2::{rc::Retained, runtime::NSObjectProtocol, runtime::ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    type ActivityToken = Retained<ProtocolObject<dyn NSObjectProtocol>>;

    pub(super) struct ActivityOwner {
        process_info: Retained<NSProcessInfo>,
        token: Option<ActivityToken>,
    }

    impl ActivityOwner {
        pub(super) fn new() -> Self {
            Self {
                process_info: NSProcessInfo::processInfo(),
                token: None,
            }
        }

        pub(super) fn set_enabled(&mut self, enabled: bool) -> Result<()> {
            if enabled && self.token.is_none() {
                let reason = NSString::from_str("LoomTV video playback");
                self.token = Some(self.process_info.beginActivityWithOptions_reason(
                    NSActivityOptions::IdleDisplaySleepDisabled,
                    &reason,
                ));
            } else if !enabled {
                self.release();
            }
            Ok(())
        }

        fn release(&mut self) {
            if let Some(token) = self.token.take() {
                // This is the exact token returned by beginActivityWithOptions:reason:.
                unsafe { self.process_info.endActivity(&token) };
            }
        }
    }

    impl Drop for ActivityOwner {
        fn drop(&mut self) {
            self.release();
        }
    }

    pub(super) fn ensure_supported() -> Result<()> {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use loomtv_core::{Error, Result};

    pub(super) struct ActivityOwner;

    impl ActivityOwner {
        pub(super) fn new() -> Self {
            Self
        }

        pub(super) fn set_enabled(&mut self, _enabled: bool) -> Result<()> {
            ensure_supported()
        }
    }

    pub(super) fn ensure_supported() -> Result<()> {
        Err(Error::new(
            "unsupported_platform",
            "Playback sleep inhibition is currently available only on macOS.",
        ))
    }
}
