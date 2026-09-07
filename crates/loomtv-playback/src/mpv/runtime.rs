use super::{Result, ACK_TIMEOUT};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::Mutex,
    time::{timeout, Instant},
};
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: &'static str,
}
#[derive(Clone)]
pub struct ResolvedRuntime {
    pub path: PathBuf,
    pub source: &'static str,
    pub version: String,
}
struct Cached {
    candidates: Vec<Candidate>,
    expires: Instant,
    runtime: Option<ResolvedRuntime>,
    signature: Option<(u64, SystemTime)>,
}
#[derive(Default)]
pub struct RuntimeResolver {
    cache: Mutex<Option<Cached>>,
}
impl RuntimeResolver {
    pub async fn invalidate(&self) {
        *self.cache.lock().await = None;
    }
    pub async fn resolve(&self, candidates: Vec<Candidate>) -> Result<Option<ResolvedRuntime>> {
        if candidates.len() > 64 {
            return Err("Too many mpv runtime candidates.".into());
        }
        let mut cache = self.cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached.candidates == candidates
                && cached.expires > Instant::now()
                && cached.runtime.as_ref().and_then(|r| signature(&r.path)) == cached.signature
            {
                return Ok(cached.runtime.clone());
            }
        }
        let mut resolved = None;
        for candidate in &candidates {
            if let Ok((path, version)) = validate(&candidate.path).await {
                resolved = Some(ResolvedRuntime {
                    path,
                    version,
                    source: candidate.source,
                });
                break;
            }
        }
        *cache = Some(Cached {
            signature: resolved.as_ref().and_then(|r| signature(&r.path)),
            candidates,
            expires: Instant::now() + Duration::from_secs(if resolved.is_some() { 60 } else { 5 }),
            runtime: resolved.clone(),
        });
        Ok(resolved)
    }
    pub async fn availability(&self, candidates: Vec<Candidate>, disabled: bool) -> Result<Value> {
        if disabled {
            return Ok(
                json!({"available":false,"reason":"mpv is disabled by LOOMTV_DISABLE_MPV."}),
            );
        }
        Ok(match self.resolve(candidates).await? {
            Some(runtime) => {
                json!({"available":true,"executablePath":runtime.path,"runtimeSource":runtime.source,"version":runtime.version})
            }
            None => {
                json!({"available":false,"reason":"No working mpv executable was found. Select an installed mpv executable in Settings."})
            }
        })
    }
}
fn signature(path: &Path) -> Option<(u64, SystemTime)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}
pub async fn validate(candidate: &Path) -> Result<(PathBuf, String)> {
    if !candidate.is_absolute() {
        return Err("The mpv executable must use an absolute path.".into());
    }
    #[cfg(target_os = "macos")]
    let path = if candidate
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("app"))
    {
        candidate.join("Contents/MacOS/mpv")
    } else {
        candidate.to_path_buf()
    };
    #[cfg(not(target_os = "macos"))]
    let path = candidate.to_path_buf();
    let path = std::fs::canonicalize(path).map_err(|_| "The mpv executable is unavailable.")?;
    if !path.is_file() {
        return Err("The selected mpv executable is not a file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&path)
            .map_err(|_| "The mpv executable is unavailable.")?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("The selected file is not executable.".into());
        }
    }
    let mut command = Command::new(&path);
    command
        .args(["--no-config", "--load-scripts=no", "--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "The mpv version check failed.")?;
    let output = child
        .stdout
        .take()
        .ok_or("The mpv version output is unavailable.")?;
    let result = timeout(ACK_TIMEOUT, async {
        let mut bytes = Vec::new();
        output
            .take(4097)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "The mpv version output could not be read.")?;
        if bytes.len() > 4096 {
            return Err("The mpv version output exceeds its limit.".into());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "The mpv version check could not finish.")?;
        if !status.success() {
            return Err("The selected file is not a working mpv executable.".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| "The mpv version output is invalid.")?;
        let version = text
            .lines()
            .find(|line| line.starts_with("mpv "))
            .filter(|line| line.len() <= 512)
            .ok_or("The selected file did not identify itself as mpv.")?;
        Ok::<_, String>(version.to_owned())
    })
    .await;
    match result {
        Ok(Ok(version)) => Ok((path, version)),
        Ok(Err(error)) => {
            let _ = child.kill().await;
            Err(error)
        }
        Err(_) => {
            let _ = child.kill().await;
            Err("The mpv version check timed out.".into())
        }
    }
}
