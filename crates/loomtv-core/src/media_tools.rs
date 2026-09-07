use crate::{Error, Result};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{io::AsyncReadExt, sync::Semaphore};

#[derive(Clone)]
pub enum Transform {
    Subtitle(Option<u32>),
    Thumbnail(String),
}
#[derive(Clone)]
pub struct MediaTools {
    ffmpeg: Option<PathBuf>,
    gate: Arc<Semaphore>,
    shutdown: tokio::sync::watch::Sender<bool>,
}
impl MediaTools {
    pub fn ffmpeg_path(&self) -> Option<std::path::PathBuf> {
        self.ffmpeg.clone()
    }

    pub fn new(ffmpeg: Option<PathBuf>) -> Self {
        Self {
            ffmpeg,
            gate: Arc::new(Semaphore::new(2)),
            shutdown: tokio::sync::watch::channel(false).0,
        }
    }
    pub async fn shutdown(&self) {
        self.shutdown.send_replace(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.gate.acquire_many(2)).await;
    }
    pub async fn convert(
        &self,
        path: &Path,
        transform: &Transform,
    ) -> Result<(Vec<u8>, &'static str)> {
        let mut stopped = self.shutdown.subscribe();
        if *stopped.borrow() {
            return Err(Error::new("media_closed", "Media preparation has stopped."));
        }
        let _permit = tokio::time::timeout(Duration::from_secs(15), self.gate.acquire())
            .await
            .map_err(|_| Error::new("media_busy", "Media preparation is busy. Try again."))?
            .map_err(|_| Error::new("media_closed", "Media preparation has stopped."))?;
        let binary = self.ffmpeg.as_ref().ok_or_else(|| {
            Error::new("ffmpeg_missing", "The packaged FFmpeg runtime is missing.")
        })?;
        let mut command = tokio::process::Command::new(binary);
        command.args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
        ]);
        if let Transform::Thumbnail(time) = transform {
            if !valid_time(time) {
                return Err(Error::new("invalid_time", "Choose a valid thumbnail time."));
            }
            command.args(["-ss", time]);
        }
        command.arg("-i").arg(path);
        let content_type = match transform {
            Transform::Subtitle(ordinal) => {
                if ordinal.is_some_and(|v| v > 1024) {
                    return Err(Error::new(
                        "invalid_track",
                        "The subtitle track is invalid.",
                    ));
                }
                let map = ordinal
                    .map(|index| format!("0:s:{index}"))
                    .unwrap_or_else(|| "0:0".into());
                command.args([
                    "-map", &map, "-vn", "-an", "-c:s", "webvtt", "-f", "webvtt", "pipe:1",
                ]);
                "text/vtt; charset=utf-8"
            }
            Transform::Thumbnail(_) => {
                command.args([
                    "-map",
                    "0:v:0",
                    "-frames:v",
                    "1",
                    "-an",
                    "-sn",
                    "-vf",
                    "scale=640:-2",
                    "-q:v",
                    "4",
                    "-f",
                    "image2pipe",
                    "-c:v",
                    "mjpeg",
                    "pipe:1",
                ]);
                "image/jpeg"
            }
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("media_failed", "Media preparation did not start."))?;
        let work = tokio::time::timeout(Duration::from_secs(30), async {
            const LIMIT: usize = 8 * 1024 * 1024;
            let mut bytes = Vec::new();
            output
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > LIMIT {
                return Err(Error::new(
                    "media_too_large",
                    "The generated media resource is too large.",
                ));
            }
            if !child.wait().await?.success() || bytes.is_empty() {
                return Err(Error::new(
                    "media_failed",
                    "The media resource could not be generated.",
                ));
            }
            Ok(bytes)
        });
        let bytes = tokio::select! {
            _ = stopped.changed() => return Err(Error::new("media_closed", "Media preparation has stopped.")),
            result = work => result.map_err(|_| Error::new("media_timeout", "Media preparation timed out."))??,
        };
        Ok((bytes, content_type))
    }
}
fn valid_time(value: &str) -> bool {
    let parts = value.split(':').collect::<Vec<_>>();
    !parts.is_empty()
        && parts.len() <= 3
        && value.len() <= 24
        && parts
            .iter()
            .all(|part| part.parse::<f64>().is_ok_and(|v| v.is_finite() && v >= 0.))
}
