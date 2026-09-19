//! Xlib's default handler exits the process on BadWindow. Our own display
//! connection may receive that error when Electron closes or replaces its
//! parent XID. Forward errors on every other Display to the prior handler.

use libloading::Library;
use std::{
    collections::HashMap,
    ffi::{c_int, c_void},
    sync::{Mutex, OnceLock},
};

#[repr(C)]
struct XErrorEvent {
    kind: c_int,
    display: *mut c_void,
    resource_id: usize,
    serial: usize,
    error_code: u8,
    request_code: u8,
    minor_code: u8,
}

type Handler = unsafe extern "C" fn(*mut c_void, *mut XErrorEvent) -> c_int;
type SetHandler = unsafe extern "C" fn(Option<Handler>) -> Option<Handler>;

#[derive(Default)]
struct State {
    library: Option<Library>,
    set_handler: Option<SetHandler>,
    previous: Option<Handler>,
    displays: HashMap<usize, u32>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> &'static Mutex<State> { STATE.get_or_init(|| Mutex::new(State::default())) }

unsafe extern "C" fn on_error(display: *mut c_void, event: *mut XErrorEvent) -> c_int {
    let Ok(mut guard) = state().lock() else { return 0; };
    if let Some(count) = guard.displays.get_mut(&(display as usize)) {
        *count = count.saturating_add(1);
        return 0;
    }
    let previous = guard.previous;
    drop(guard);
    if let Some(previous) = previous { previous(display, event) } else { std::process::abort() }
}

#[no_mangle]
pub unsafe extern "C" fn loom_x11_guard_register(display: *mut c_void) -> c_int {
    if display.is_null() { return 0; }
    let Ok(mut guard) = state().lock() else { return 0; };
    if guard.displays.contains_key(&(display as usize)) { return 1; }
    if guard.library.is_none() {
        let Ok(library) = Library::new("libX11.so.6") else { return 0; };
        let set = match library.get::<SetHandler>(b"XSetErrorHandler\0") {
            Ok(set) => *set,
            Err(_) => return 0,
        };
        guard.previous = set(Some(on_error));
        guard.set_handler = Some(set);
        guard.library = Some(library);
    }
    guard.displays.insert(display as usize, 0);
    1
}

#[no_mangle]
pub unsafe extern "C" fn loom_x11_guard_errors(display: *mut c_void) -> u32 {
    state().lock().ok().and_then(|guard| guard.displays.get(&(display as usize)).copied()).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn loom_x11_guard_unregister(display: *mut c_void) {
    let Ok(mut guard) = state().lock() else { return; };
    guard.displays.remove(&(display as usize));
    if guard.displays.is_empty() {
        if let Some(set) = guard.set_handler.take() { set(guard.previous.take()); }
        guard.library = None;
    }
}
