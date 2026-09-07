use loomtv_core::{Error, Result};
use serde::Deserialize;
#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindow;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Viewport {
    pub fn validate(self) -> Result<Self> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 100_000.)
            || self.width < 0.
            || self.height < 0.
        {
            return Err(Error::new(
                "invalid_viewport",
                "The video viewport is invalid.",
            ));
        }
        Ok(self)
    }
}
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{ensure, hide, set_chrome_visible, set_viewport};

#[cfg(not(target_os = "macos"))]
pub async fn ensure(_: &WebviewWindow) -> Result<usize> {
    Err(Error::new(
        "native_host_pending",
        "The native video host has not been implemented for this platform.",
    ))
}
#[cfg(not(target_os = "macos"))]
pub async fn set_viewport(_: &WebviewWindow, _: Viewport) -> Result<()> {
    Err(Error::new(
        "native_host_pending",
        "The native video host has not been implemented for this platform.",
    ))
}
#[cfg(not(target_os = "macos"))]
pub async fn hide(_: &WebviewWindow) -> Result<()> {
    Ok(())
}

pub fn native_error(_: impl std::fmt::Display) -> Error {
    Error::new(
        "native_window_error",
        "The native video view could not be updated.",
    )
}

#[cfg(not(target_os = "macos"))]
pub async fn set_chrome_visible(_: &tauri::WebviewWindow, _: bool) -> Result<()> {
    Ok(())
}
