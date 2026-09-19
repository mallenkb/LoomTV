//! Windows and X11 libmpv child-window bridge. The Electron host owns the parent
//! window and serializes calls to each engine. No player process is spawned.

use libloading::Library;
use serde_json::{Map, Number, Value};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::ptr;

const MAX_COMMAND: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 2 * 1024 * 1024;
const MAX_ARGUMENT: usize = 65_536;
const MPV_FORMAT_NODE: c_int = 6;
const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_QUEUE_OVERFLOW: c_int = 24;

#[repr(C)]
#[derive(Clone, Copy)]
union MpvNodeData {
    string: *const c_char,
    flag: c_int,
    integer: i64,
    double: f64,
    list: *const MpvNodeList,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MpvNode {
    data: MpvNodeData,
    format: c_int,
}

#[repr(C)]
struct MpvNodeList {
    count: c_int,
    values: *const MpvNode,
    keys: *const *const c_char,
}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

struct Api {
    client_api_version: unsafe extern "C" fn() -> std::ffi::c_ulong,
    create: unsafe extern "C" fn() -> *mut c_void,
    initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    set_option: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    set_property: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    command_async: unsafe extern "C" fn(*mut c_void, u64, *const *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent,
    event_to_node: unsafe extern "C" fn(*mut MpvNode, *mut MpvEvent) -> c_int,
    free_node: unsafe extern "C" fn(*mut MpvNode),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    terminate_destroy: unsafe extern "C" fn(*mut c_void),
}

impl Api {
    unsafe fn load(library: &Library) -> Result<Self, String> {
        macro_rules! symbol {
            ($name:literal) => {
                *library
                    .get(concat!($name, "\0").as_bytes())
                    .map_err(|_| concat!("Missing libmpv symbol: ", $name).to_owned())?
            };
        }
        Ok(Self {
            client_api_version: symbol!("mpv_client_api_version"),
            create: symbol!("mpv_create"),
            initialize: symbol!("mpv_initialize"),
            set_option: symbol!("mpv_set_option_string"),
            set_property: symbol!("mpv_set_property_string"),
            command_async: symbol!("mpv_command_async"),
            observe_property: symbol!("mpv_observe_property"),
            wait_event: symbol!("mpv_wait_event"),
            event_to_node: symbol!("mpv_event_to_node"),
            free_node: symbol!("mpv_free_node_contents"),
            error_string: symbol!("mpv_error_string"),
            terminate_destroy: symbol!("mpv_terminate_destroy"),
        })
    }

    fn error(&self, code: c_int) -> String {
        // libmpv owns the returned static string for the lifetime of the library.
        let pointer = unsafe { (self.error_string)(code) };
        if pointer.is_null() {
            format!("libmpv error {code}")
        } else {
            unsafe { CStr::from_ptr(pointer) }
                .to_string_lossy()
                .into_owned()
        }
    }
}

struct Engine {
    // Drop order is explicit: mpv must terminate before the library unloads.
    player: *mut c_void,
    api: Api,
    _library: Library,
    attached: bool,
    pending_events: Option<Vec<u8>>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.player.is_null() {
            unsafe { (self.api.terminate_destroy)(self.player) };
            self.player = ptr::null_mut();
        }
    }
}

impl Engine {
    fn set_option(&self, key: &str, value: &str) -> Result<(), String> {
        let key_c = CString::new(key).map_err(|_| "Invalid libmpv option name.")?;
        let value_c = CString::new(value).map_err(|_| "Invalid libmpv option value.")?;
        let code = unsafe { (self.api.set_option)(self.player, key_c.as_ptr(), value_c.as_ptr()) };
        if code < 0 {
            Err(format!("libmpv option {key}: {}", self.api.error(code)))
        } else {
            Ok(())
        }
    }

    fn observe(&self) -> Result<(), String> {
        for (index, name) in [
            "time-pos",
            "duration",
            "pause",
            "volume",
            "mute",
            "speed",
            "track-list",
            "video-params",
            "hwdec-current",
            "frame-drop-count",
            "decoder-frame-drop-count",
            "demuxer-cache-duration",
            "paused-for-cache",
            "video-codec",
            "estimated-vf-fps",
            "eof-reached",
        ]
        .into_iter()
        .enumerate()
        {
            let name_c = CString::new(name).expect("static property name");
            let code = unsafe {
                (self.api.observe_property)(
                    self.player,
                    index as u64 + 1,
                    name_c.as_ptr(),
                    MPV_FORMAT_NODE,
                )
            };
            if code < 0 {
                return Err(format!("libmpv property {name}: {}", self.api.error(code)));
            }
        }
        Ok(())
    }
}

fn write_error(output: *mut c_char, capacity: usize, message: &str) {
    if output.is_null() || capacity == 0 {
        return;
    }
    let bytes = message.as_bytes();
    let length = bytes.len().min(capacity - 1);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), output.cast::<u8>(), length);
        *output.add(length) = 0;
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_wid(parent: usize) -> u64 {
    (parent as u32) as u64
}

fn create_engine(path: *const c_char) -> Result<Engine, String> {
    if path.is_null() {
        return Err("libmpv requires an absolute library path.".into());
    }
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    if !Path::new(path.as_ref()).is_absolute() {
        return Err("libmpv requires an absolute library path.".into());
    }
    #[cfg(target_os = "windows")]
    let library: Library = unsafe {
        use libloading::os::windows::{
            Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        };
        WindowsLibrary::load_with_flags(
            Path::new(&*path),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
        .map(Into::into)
    }
    .map_err(|error| format!("Could not load libmpv: {error}"))?;
    #[cfg(not(target_os = "windows"))]
    let library = unsafe { Library::new(path.as_ref()) }
        .map_err(|error| format!("Could not load libmpv: {error}"))?;
    let api = unsafe { Api::load(&library) }?;
    if unsafe { (api.client_api_version)() } >> 16 != 2 {
        return Err("This bridge requires libmpv client API major version 2.".into());
    }
    let player = unsafe { (api.create)() };
    if player.is_null() {
        return Err("libmpv could not allocate a playback core.".into());
    }
    let engine = Engine {
        player,
        api,
        _library: library,
        attached: false,
        pending_events: None,
    };
    for (name, value) in [
        ("vo", "gpu"),
        ("config", "no"),
        ("load-scripts", "no"),
        ("osc", "no"),
        ("ytdl", "no"),
        ("terminal", "no"),
        ("input-terminal", "no"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("input-media-keys", "no"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("force-window", "no"),
        ("osd-level", "0"),
        ("audio-display", "no"),
        ("hwdec", "auto-safe"),
        ("sub-auto", "no"),
        ("audio-file-auto", "no"),
        ("cover-art-auto", "no"),
        ("stop-screensaver", "no"),
        ("video-timing-offset", "0"),
    ] {
        engine.set_option(name, value)?;
    }
    #[cfg(target_os = "windows")]
    {
        engine.set_option("gpu-context", "d3d11")?;
    }
    #[cfg(target_os = "linux")]
    {
        engine.set_option("gpu-context", "x11egl,x11")?;
    }
    Ok(engine)
}

#[no_mangle]
pub extern "C" fn loom_mpv_bridge_version() -> u32 {
    1
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_create(
    path: *const c_char,
    error: *mut c_char,
    capacity: usize,
) -> *mut c_void {
    write_error(error, capacity, "");
    match create_engine(path) {
        Ok(engine) => Box::into_raw(Box::new(engine)).cast(),
        Err(message) => {
            write_error(error, capacity, &message);
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_attach(
    opaque: *mut c_void,
    parent: *mut c_void,
    error: *mut c_char,
    capacity: usize,
) -> c_int {
    write_error(error, capacity, "");
    if opaque.is_null() || parent.is_null() {
        write_error(error, capacity, "The native video parent is missing.");
        return -1;
    }
    let engine = &mut *opaque.cast::<Engine>();
    if engine.attached {
        write_error(error, capacity, "This engine already owns a renderer.");
        return -1;
    }
    // Windows HWNDs are 32-bit values even in a 64-bit process. X11 Window is
    // unsigned long on Linux. mpv's wid option expects the decimal numeric ID.
    #[cfg(target_os = "windows")]
    let window_id = windows_wid(parent as usize);
    #[cfg(target_os = "linux")]
    let window_id = parent as usize as u64;
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let window_id = parent as usize as u64;
    if window_id == 0 {
        write_error(error, capacity, "The native video parent is invalid.");
        return -1;
    }
    let setup = (|| {
        engine.set_option("wid", &window_id.to_string())?;
        let code = (engine.api.initialize)(engine.player);
        if code < 0 {
            return Err(format!("libmpv initialization: {}", engine.api.error(code)));
        }
        engine.observe()?;
        Ok::<(), String>(())
    })();
    match setup {
        Ok(()) => {
            engine.attached = true;
            0
        }
        Err(message) => {
            write_error(error, capacity, &message);
            -1
        }
    }
}

unsafe fn bounded_bytes<'a>(text: *const c_char, limit: usize) -> Option<&'a [u8]> {
    if text.is_null() {
        return None;
    }
    for length in 0..=limit {
        if *text.add(length) == 0 {
            return Some(std::slice::from_raw_parts(text.cast::<u8>(), length));
        }
    }
    None
}

fn command_arguments(json: &[u8]) -> Result<Vec<CString>, String> {
    let value: Value =
        serde_json::from_slice(json).map_err(|_| "Invalid playback command JSON.")?;
    let array = value
        .as_array()
        .ok_or("Playback command must be an array.")?;
    if array.is_empty() || array.len() > 32 {
        return Err("Invalid playback command length.".into());
    }
    let verb = array[0]
        .as_str()
        .ok_or("Playback command verb must be a string.")?;
    if !matches!(
        verb,
        "set_property" | "seek" | "loadfile" | "sub-add" | "stop"
    ) {
        return Err("Unsupported playback command.".into());
    }
    array
        .iter()
        .map(|argument| {
            let text = match argument {
                Value::String(text) => text.clone(),
                Value::Bool(flag) => {
                    if *flag {
                        "yes".into()
                    } else {
                        "no".into()
                    }
                }
                Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
                    number.to_string()
                }
                _ => return Err("Playback commands accept only strings and finite numbers.".into()),
            };
            if text.len() > MAX_ARGUMENT {
                return Err("Playback command argument is too long.".into());
            }
            CString::new(text).map_err(|_| "Playback command argument contains a null byte.".into())
        })
        .collect()
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_command(
    opaque: *mut c_void,
    request: u64,
    json: *const c_char,
    error: *mut c_char,
    capacity: usize,
) -> c_int {
    write_error(error, capacity, "");
    if opaque.is_null() {
        write_error(error, capacity, "The libmpv engine is missing.");
        return -1;
    }
    let Some(bytes) = bounded_bytes(json, MAX_COMMAND) else {
        write_error(error, capacity, "Invalid playback command.");
        return -1;
    };
    let engine = &mut *opaque.cast::<Engine>();
    let arguments = match command_arguments(bytes) {
        Ok(arguments) => arguments,
        Err(message) => {
            write_error(error, capacity, &message);
            return -1;
        }
    };
    let verb = arguments[0].to_bytes();
    if verb == b"loadfile" && !engine.attached {
        write_error(
            error,
            capacity,
            "The native renderer must attach before loading media.",
        );
        return -1;
    }
    let code = if verb == b"set_property" {
        if arguments.len() != 3 {
            -4
        } else {
            (engine.api.set_property)(engine.player, arguments[1].as_ptr(), arguments[2].as_ptr())
        }
    } else {
        let mut pointers: Vec<*const c_char> =
            arguments.iter().map(|argument| argument.as_ptr()).collect();
        pointers.push(ptr::null());
        (engine.api.command_async)(engine.player, request, pointers.as_ptr())
    };
    if code < 0 {
        write_error(error, capacity, &engine.api.error(code));
    }
    code
}

unsafe fn node_value(node: *const MpvNode, depth: usize, budget: &mut usize) -> Value {
    if node.is_null() || depth > 24 || *budget == 0 {
        return Value::Null;
    }
    *budget -= 1;
    match (*node).format {
        1 | 2 => bounded_bytes((*node).data.string, MAX_ARGUMENT)
            .map(|bytes| Value::String(String::from_utf8_lossy(bytes).into_owned()))
            .unwrap_or(Value::Null),
        3 => Value::Bool((*node).data.flag != 0),
        4 => Value::Number(Number::from((*node).data.integer)),
        5 => Number::from_f64((*node).data.double)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        7 | 8 => {
            let list = (*node).data.list;
            if list.is_null() || (*list).count < 0 || (*list).count > 4096 {
                return Value::Null;
            }
            let count = (*list).count as usize;
            if count > 0 && (*list).values.is_null() {
                return Value::Null;
            }
            if (*node).format == 7 {
                Value::Array(
                    (0..count)
                        .take(*budget)
                        .map(|index| node_value((*list).values.add(index), depth + 1, budget))
                        .collect(),
                )
            } else {
                if count > 0 && (*list).keys.is_null() {
                    return Value::Null;
                }
                let mut map = Map::new();
                for index in 0..count {
                    if *budget == 0 {
                        break;
                    }
                    let key = *(*list).keys.add(index);
                    let Some(bytes) = bounded_bytes(key, 512) else {
                        continue;
                    };
                    let key = String::from_utf8_lossy(bytes).into_owned();
                    map.insert(
                        key,
                        node_value((*list).values.add(index), depth + 1, budget),
                    );
                }
                Value::Object(map)
            }
        }
        _ => Value::Null,
    }
}

unsafe fn collect_events(engine: &Engine) -> Option<Vec<u8>> {
    let mut events = Vec::new();
    for _ in 0..128 {
        let event = (engine.api.wait_event)(engine.player, 0.0);
        if event.is_null() || (*event).event_id == MPV_EVENT_NONE {
            break;
        }
        if (*event).event_id == MPV_EVENT_QUEUE_OVERFLOW {
            events.push(serde_json::json!({"event":"bridge-error","error":"libmpv's event queue overflowed."}));
            continue;
        }
        let mut node = MpvNode {
            data: MpvNodeData { integer: 0 },
            format: 0,
        };
        if (engine.api.event_to_node)(&mut node, event) < 0 {
            continue;
        }
        let mut budget = 8192;
        let converted = node_value(&node, 0, &mut budget);
        (engine.api.free_node)(&mut node);
        if let Value::Object(mut row) = converted {
            if (*event).reply_userdata != 0 {
                row.insert(
                    "request_id".into(),
                    Value::Number(Number::from((*event).reply_userdata)),
                );
            }
            if (*event).error < 0 {
                row.insert(
                    "error".into(),
                    Value::String(engine.api.error((*event).error)),
                );
            }
            events.push(Value::Object(row));
        }
    }
    if events.is_empty() {
        return None;
    }
    let serialized = serde_json::to_vec(&events).ok()?;
    if serialized.len() <= MAX_EVENTS {
        Some(serialized)
    } else {
        Some(br#"[{"event":"bridge-error","error":"Native playback events exceeded the size limit."}]"#.to_vec())
    }
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_poll(opaque: *mut c_void) -> *mut c_char {
    if opaque.is_null() {
        return ptr::null_mut();
    }
    let engine = &mut *opaque.cast::<Engine>();
    engine
        .pending_events
        .take()
        .or_else(|| collect_events(engine))
        .and_then(|events| CString::new(events).ok())
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_free(allocation: *mut c_char) {
    if !allocation.is_null() {
        drop(CString::from_raw(allocation));
    }
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_poll_into(
    opaque: *mut c_void,
    output: *mut c_char,
    capacity: usize,
) -> c_int {
    if output.is_null() || capacity < 2 {
        return -1;
    }
    *output = 0;
    if opaque.is_null() {
        return 0;
    }
    let engine = &mut *opaque.cast::<Engine>();
    if engine.pending_events.is_none() {
        engine.pending_events = collect_events(engine);
    }
    let Some(events) = engine.pending_events.as_ref() else {
        return 0;
    };
    if events.len() + 1 > capacity {
        return -1;
    }
    ptr::copy_nonoverlapping(events.as_ptr(), output.cast::<u8>(), events.len());
    *output.add(events.len()) = 0;
    let length = events.len() as c_int;
    engine.pending_events = None;
    length
}

#[no_mangle]
pub unsafe extern "C" fn loom_mpv_destroy(opaque: *mut c_void) {
    if !opaque.is_null() {
        drop(Box::from_raw(opaque.cast::<Engine>()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_handle_is_unsigned_32_bit_wid() {
        assert_eq!(windows_wid(0xffff_ffff_8000_0001), 0x8000_0001);
        assert_eq!(windows_wid(0x1234), 0x1234);
    }

    #[cfg(unix)]
    #[test]
    fn fake_libmpv_obeys_attach_commands_and_retains_events() {
        use std::process::Command;

        let directory = std::env::temp_dir().join(format!(
            "loomtv-mpv-bridge-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("abi")
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let extension = if cfg!(target_os = "macos") {
            "dylib"
        } else {
            "so"
        };
        let library = directory.join(format!("libfake_mpv.{extension}"));
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake_mpv.c");
        let mut compile = Command::new("cc");
        if cfg!(target_os = "macos") {
            compile.arg("-dynamiclib");
        } else {
            compile.args(["-shared", "-fPIC"]);
        }
        let status = compile
            .arg(source)
            .args(["-o"])
            .arg(&library)
            .status()
            .unwrap();
        assert!(status.success(), "the fake libmpv did not compile");

        let path = CString::new(library.to_str().unwrap()).unwrap();
        let mut error = [0i8; 256];
        unsafe {
            let engine = loom_mpv_create(path.as_ptr(), error.as_mut_ptr(), error.len());
            assert!(
                !engine.is_null(),
                "{}",
                CStr::from_ptr(error.as_ptr()).to_string_lossy()
            );
            let load = CString::new("[\"loadfile\",\"sample.mp4\",\"replace\"]").unwrap();
            assert_eq!(
                loom_mpv_command(engine, 1, load.as_ptr(), error.as_mut_ptr(), error.len()),
                -1
            );
            assert_eq!(
                loom_mpv_attach(
                    engine,
                    0x1234usize as *mut c_void,
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );

            let bad = CString::new("[\"set_property\",\"hwdec\",\"bad\"]").unwrap();
            assert_eq!(
                loom_mpv_command(engine, 2, bad.as_ptr(), error.as_mut_ptr(), error.len()),
                -5
            );
            assert_eq!(CStr::from_ptr(error.as_ptr()).to_bytes(), b"mock error");
            let good = CString::new("[\"set_property\",\"hwdec\",\"d3d11va\"]").unwrap();
            assert_eq!(
                loom_mpv_command(engine, 3, good.as_ptr(), error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(
                loom_mpv_command(engine, 4, load.as_ptr(), error.as_mut_ptr(), error.len()),
                0
            );

            let mut too_small = [0i8; 8];
            assert_eq!(
                loom_mpv_poll_into(engine, too_small.as_mut_ptr(), too_small.len()),
                -1
            );
            let mut output = [0i8; 4096];
            let length = loom_mpv_poll_into(engine, output.as_mut_ptr(), output.len());
            assert!(length > 0);
            let bytes = std::slice::from_raw_parts(output.as_ptr().cast::<u8>(), length as usize);
            let events: Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(events[0]["event"], "property-change");
            assert_eq!(events[0]["name"], "hwdec-current");
            assert_eq!(events[0]["data"], "d3d11va");
            assert_eq!(events[1]["event"], "command-reply");
            assert_eq!(events[1]["request_id"], 42);
            assert_eq!(events[1]["error"], "mock error");
            assert_eq!(
                loom_mpv_poll_into(engine, output.as_mut_ptr(), output.len()),
                0
            );
            loom_mpv_destroy(engine);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
