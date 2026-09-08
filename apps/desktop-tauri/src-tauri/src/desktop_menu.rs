use std::sync::{
    atomic::{AtomicI32, Ordering},
    Arc,
};
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, Submenu},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // Retain native Edit, Window, Services, Hide and Quit actions and their
    // platform accelerators, then add Electron's application shortcuts.
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.first() {
        first.insert(
            &MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
            1,
        )?;
        first.insert(
            &MenuItem::with_id(app, "check-updates", "Check for Updates...", true, None::<&str>)?,
            2,
        )?;
    }
    let view = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("View") => {
            Some(submenu)
        }
        _ => None,
    });
    let view = match view {
        Some(view) => view,
        None => {
            let view = Submenu::new(app, "View", true)?;
            menu.append(&view)?;
            view
        }
    };
    for (id, label, accelerator) in [
        ("reload", "Reload", "CmdOrCtrl+R"),
        ("force-reload", "Force Reload", "CmdOrCtrl+Shift+R"),
        ("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
        ("zoom-in", "Zoom In", "CmdOrCtrl+Plus"),
        ("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
    ] {
        view.append(&MenuItem::with_id(app, id, label, true, Some(accelerator))?)?;
    }
    #[cfg(not(target_os = "macos"))]
    view.append(&MenuItem::with_id(
        app,
        "fullscreen",
        "Toggle Full Screen",
        true,
        Some("F11"),
    )?)?;
    #[cfg(debug_assertions)]
    view.append(&MenuItem::with_id(
        app,
        "devtools",
        "Toggle Developer Tools",
        true,
        Some(if cfg!(target_os = "macos") {
            "Cmd+Alt+I"
        } else {
            "Ctrl+Shift+I"
        }),
    )?)?;
    app.set_menu(menu)?;
    let zoom = Arc::new(AtomicI32::new(0));
    app.on_menu_event(move |app, event| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let result = match event.id().as_ref() {
            "check-updates" => {
                let handle = app.clone();
                app.dialog()
                    .message(format!(
                        "You are running LoomTV Tauri {}.\n\nAutomatic updates are not configured for Tauri. Open the release page to check for a newer Tauri build. Electron downloads cannot update this app.",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .title("Check for Updates")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Open Releases".into(),
                        "Cancel".into(),
                    ))
                    .show(move |confirmed| {
                        if confirmed {
                            if let Err(error) = handle.opener().open_url(
                                "https://github.com/mallenkb/LoomTV/releases",
                                None::<&str>,
                            ) {
                                handle.dialog()
                                    .message(format!("Could not open the release page: {error}"))
                                    .title("Update check failed")
                                    .show(|_| {});
                            }
                        }
                    });
                Ok(())
            }
            "settings" => window.eval("window.location.hash = '/settings';"),
            "reload" | "force-reload" => window.reload(),
            "zoom-reset" | "zoom-in" | "zoom-out" => {
                let previous = zoom.load(Ordering::Relaxed);
                let next = match event.id().as_ref() {
                    "zoom-in" => previous + 1,
                    "zoom-out" => previous - 1,
                    _ => 0,
                }
                .clamp(-5, 8);
                let result = window.set_zoom(1.2_f64.powi(next));
                if result.is_ok() {
                    zoom.store(next, Ordering::Relaxed);
                }
                result
            }
            "fullscreen" => window
                .is_fullscreen()
                .and_then(|value| window.set_fullscreen(!value)),
            #[cfg(debug_assertions)]
            "devtools" => {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
                Ok(())
            }
            _ => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("Desktop menu action failed: {error}");
        }
    });
    Ok(())
}
