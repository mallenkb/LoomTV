use super::{native_error, Viewport};
use loomtv_core::{Error, Result};
use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::cell::RefCell;
use tauri::WebviewWindow;

struct Host {
    view: Retained<NSView>,
    viewport: Viewport,
}
thread_local! {
    // AppKit ownership is confined to the main thread. No Send or Sync assertion is needed.
    static HOST:RefCell<Option<Host>>=const{RefCell::new(None)};
    static VIEWPORT:RefCell<Viewport>=RefCell::new(Viewport::default());
}
fn frame(parent: &NSView, viewport: Viewport) -> NSRect {
    let y = if parent.isFlipped() {
        viewport.y
    } else {
        parent.bounds().size.height - viewport.y - viewport.height
    };
    NSRect::new(
        NSPoint::new(viewport.x, y),
        NSSize::new(viewport.width.max(1.), viewport.height.max(1.)),
    )
}
pub async fn ensure(window: &WebviewWindow) -> Result<usize> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or_else(|| {
                    Error::new("ui_thread", "Native views require the main thread.")
                })?;
                // Tauri's with_webview supplies a live WKWebView on this thread. NSView is its superclass.
                let renderer = unsafe { &*webview.inner().cast::<NSView>() };
                let native_window = unsafe { &*webview.ns_window().cast::<NSWindow>() };
                native_window.setBackgroundColor(Some(&NSColor::blackColor()));
                native_window.setOpaque(true);
                let parent = unsafe { renderer.superview() }.ok_or_else(|| {
                    Error::new("native_parent", "The WebView parent is unavailable.")
                })?;
                HOST.with_borrow_mut(|host| {
                    let viewport = VIEWPORT.with_borrow(|v| *v);
                    let owned = host.get_or_insert_with(|| Host {
                        view: NSView::initWithFrame(NSView::alloc(mtm), frame(&parent, viewport)),
                        viewport,
                    });
                    owned.viewport = viewport;
                    parent.addSubview_positioned_relativeTo(
                        &owned.view,
                        NSWindowOrderingMode::Below,
                        Some(renderer),
                    );
                    owned.view.setFrame(frame(&parent, viewport));
                    owned.view.setHidden(false);
                    Ok(Retained::as_ptr(&owned.view) as usize)
                })
            })();
            let _ = tx.send(result);
        })
        .map_err(native_error)?;
    rx.await.map_err(native_error)?
}
pub async fn set_viewport(window: &WebviewWindow, viewport: Viewport) -> Result<()> {
    let viewport = viewport.validate()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            VIEWPORT.with_borrow_mut(|v| *v = viewport);
            HOST.with_borrow_mut(|host| {
                if let Some(host) = host {
                    host.viewport = viewport;
                    if let Some(parent) = unsafe { host.view.superview() } {
                        host.view.setFrame(frame(&parent, viewport));
                    }
                }
            });
            let _ = tx.send(());
        })
        .map_err(native_error)?;
    rx.await.map_err(native_error)
}
pub async fn hide(window: &WebviewWindow) -> Result<()> {
    // Called only after the playback worker has stopped using the drawable.
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            HOST.with_borrow_mut(|host| {
                if let Some(host) = host {
                    host.view.setHidden(true);
                }
            });
            let _ = tx.send(());
        })
        .map_err(native_error)?;
    rx.await.map_err(native_error)
}

pub async fn set_chrome_visible(window: &WebviewWindow, visible: bool) -> Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let native_window = unsafe { &*webview.ns_window().cast::<NSWindow>() };
            for kind in [
                objc2_app_kit::NSWindowButton::CloseButton,
                objc2_app_kit::NSWindowButton::MiniaturizeButton,
                objc2_app_kit::NSWindowButton::ZoomButton,
            ] {
                if let Some(button) = native_window.standardWindowButton(kind) {
                    button.setHidden(!visible);
                }
            }
            let _ = tx.send(());
        })
        .map_err(native_error)?;
    rx.await.map_err(native_error)
}

/// The reference mpv backend uses an owned external window below the React controls.
/// The caller enables this only after mpv IPC startup, and restores the backdrop on exit.
pub async fn external_backdrop(window: &WebviewWindow, active: bool) -> Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            // with_webview confines AppKit access to the main thread and supplies a live NSWindow.
            let native = unsafe { &*webview.ns_window().cast::<NSWindow>() };
            native.setOpaque(!active);
            let color = if active {
                NSColor::clearColor()
            } else {
                NSColor::blackColor()
            };
            native.setBackgroundColor(Some(&color));
            let _ = tx.send(());
        })
        .map_err(native_error)?;
    rx.await.map_err(native_error)
}
