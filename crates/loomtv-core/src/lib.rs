mod artwork;
mod artwork_import;
mod catalog;
mod clear;
mod content_policy;
pub mod discovery;
pub mod hls;
pub mod iptv;
pub mod iptv_proxy;
pub mod transcode_plan;
pub mod media_tools;
pub mod metadata;
pub mod metadata_scan;
pub mod official_artwork;
mod profile_transfer;
mod profiles;
pub mod progress_import;
pub mod remote;
pub mod probe;
pub mod scanner;
mod segments;
mod settings;
mod store;
pub mod stremio_store;
pub mod streaming;

use serde::Serialize;
use serde_json::Value;
pub use store::Store;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
    pub fn unsupported(channel: &str) -> Self {
        Self::new(
            "port_not_implemented",
            format!("The Rust port has not implemented {channel} yet."),
        )
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::new("storage_error", "The local database operation failed.")
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new("filesystem_error", "The local file operation failed.")
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new("invalid_data", "The stored or supplied data is invalid.")
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
pub fn string(args: &[Value], index: usize) -> Result<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 16_384 && !s.contains('\0'))
        .ok_or_else(|| {
            Error::new(
                "invalid_argument",
                format!("Argument {index} must be a nonempty string."),
            )
        })
}
pub fn number(args: &[Value], index: usize) -> Result<f64> {
    args.get(index)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| {
            Error::new(
                "invalid_argument",
                format!("Argument {index} must be a finite number."),
            )
        })
}
