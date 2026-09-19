//! Native LibVLC decoder evidence collector for the Electron player.
//! One probe belongs to one LibVLC instance and must detach before release.

use libloading::Library;
use std::{
    ffi::{c_char, c_int, c_void, CStr},
    path::Path,
    sync::Mutex,
};

#[cfg(any(target_os = "linux", test))]
mod x11_guard;

extern "C" {
    fn loom_vlc_probe_log_callback(
        probe: *mut c_void,
        level: c_int,
        context: *const c_void,
        format: *const c_char,
        args: *mut c_void,
    );
}

type LogSet = unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void);
type LogUnset = unsafe extern "C" fn(*mut c_void);

#[derive(Default)]
struct Evidence {
    hardware: bool,
    decoder: String,
}

struct Probe {
    // Keep the module loaded while its callback is installed.
    _library: Library,
    instance: *mut c_void,
    unset: LogUnset,
    evidence: Mutex<Evidence>,
}

#[no_mangle]
pub extern "C" fn loom_vlc_probe_version() -> u32 { 1 }

/// Returns NULL when the bridge cannot safely observe decoder selection.
#[no_mangle]
pub unsafe extern "C" fn loom_vlc_probe_attach(
    library_path: *const c_char,
    instance: *mut c_void,
) -> *mut c_void {
    if library_path.is_null() || instance.is_null() { return std::ptr::null_mut(); }
    let Ok(path) = CStr::from_ptr(library_path).to_str() else { return std::ptr::null_mut(); };
    let Ok(library) = Library::new(Path::new(path)) else { return std::ptr::null_mut(); };
    let (set, unset) = {
        let Ok(set) = library.get::<LogSet>(b"libvlc_log_set\0") else { return std::ptr::null_mut(); };
        let Ok(unset) = library.get::<LogUnset>(b"libvlc_log_unset\0") else { return std::ptr::null_mut(); };
        (*set, *unset)
    };
    let probe = Box::into_raw(Box::new(Probe {
        _library: library,
        instance,
        unset,
        evidence: Mutex::new(Evidence::default()),
    }));
    set(instance, loom_vlc_probe_log_callback as *const c_void, probe.cast());
    probe.cast()
}

#[no_mangle]
pub unsafe extern "C" fn loom_vlc_probe_detach(pointer: *mut c_void) {
    if pointer.is_null() { return; }
    let probe = Box::from_raw(pointer.cast::<Probe>());
    // The public LibVLC contract waits for callbacks already in flight.
    (probe.unset)(probe.instance);
}

/// 1 means a decoder explicitly selected hardware. Zero means unproven.
#[no_mangle]
pub unsafe extern "C" fn loom_vlc_probe_hardware(pointer: *const c_void) -> c_int {
    let Some(probe) = pointer.cast::<Probe>().as_ref() else { return 0; };
    probe.evidence.lock().map(|e| e.hardware as c_int).unwrap_or(0)
}

/// Copies the selected decoder name into the caller's buffer, if known.
#[no_mangle]
pub unsafe extern "C" fn loom_vlc_probe_decoder(
    pointer: *const c_void,
    output: *mut c_char,
    capacity: usize,
) -> usize {
    let Some(probe) = pointer.cast::<Probe>().as_ref() else { return 0; };
    if output.is_null() || capacity == 0 { return 0; }
    let Ok(evidence) = probe.evidence.lock() else { return 0; };
    let bytes = evidence.decoder.as_bytes();
    let count = bytes.len().min(capacity - 1);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), output.cast(), count);
    *output.add(count) = 0;
    count
}

#[no_mangle]
pub unsafe extern "C" fn loom_vlc_probe_record(pointer: *mut c_void, message: *const c_char) {
    let Some(probe) = pointer.cast::<Probe>().as_ref() else { return; };
    if message.is_null() { return; }
    let line = CStr::from_ptr(message).to_string_lossy();
    let Ok(mut evidence) = probe.evidence.lock() else { return; };
    classify(&mut evidence, &line);
}

fn classify(evidence: &mut Evidence, line: &str) {
    let line = line.to_ascii_lowercase();
    if line.contains("looking for video decoder module") {
        evidence.hardware = false;
        evidence.decoder.clear();
    }
    if line.contains("hardware decoding failed") || line.contains("failed hardware decoding") {
        evidence.hardware = false;
        evidence.decoder.clear();
    }
    if line.contains("using video decoder module") && line.contains("videotoolbox") {
        evidence.hardware = true;
        evidence.decoder = "videotoolbox".into();
    } else if line.contains("using") && line.contains("for hardware decoding") {
        for decoder in ["d3d11va", "dxva2", "vaapi", "vdpau", "nvdec", "cuda", "v4l2"] {
            if line.contains(decoder) {
                evidence.hardware = true;
                evidence.decoder = decoder.into();
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proves_decoder_selection_without_confusing_video_output_with_decoding() {
        let mut evidence = Evidence::default();
        classify(&mut evidence, "direct3d11 vout display: using d3d11 for rendering");
        assert!(!evidence.hardware);
        classify(&mut evidence, "avcodec decoder: Using D3D11VA for hardware decoding");
        assert!(evidence.hardware);
        assert_eq!(evidence.decoder, "d3d11va");
        classify(&mut evidence, "main decoder: using video decoder module \"avcodec\"");
        assert!(evidence.hardware);
        classify(&mut evidence, "main decoder: looking for video decoder module matching \"any\"");
        assert!(!evidence.hardware);
    }

    #[test]
    fn videotoolbox_selection_proves_hardware_on_macos() {
        let mut evidence = Evidence::default();
        classify(&mut evidence, "main decoder: using video decoder module \"videotoolbox\"");
        assert!(evidence.hardware);
        assert_eq!(evidence.decoder, "videotoolbox");
    }
}
