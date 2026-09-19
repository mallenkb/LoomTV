//! Isolated decoder check. Does not open a window or touch a media library.
//! rustc --edition=2021 verify-videotoolbox.rs -o /tmp/verify-videotoolbox
//! /tmp/verify-videotoolbox /absolute/VLC.app /absolute/video.mkv [seconds]
use std::{
    ffi::{c_char, c_void, CString},
    path::PathBuf,
    thread,
    time::Duration,
};

extern "C" {
    fn dlopen(path: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(library: *mut c_void, name: *const c_char) -> *mut c_void;
}

unsafe fn symbol<T: Copy>(library: *mut c_void, name: &str) -> T {
    let name = CString::new(name).unwrap();
    let pointer = dlsym(library, name.as_ptr());
    assert!(!pointer.is_null(), "Missing LibVLC symbol: {name:?}");
    std::mem::transmute_copy(&pointer)
}

// libvlc_media_stats_t from the pinned LibVLC 3 public header.
#[repr(C)]
#[derive(Default)]
struct Stats {
    read_bytes: i32,
    input_bitrate: f32,
    demux_bytes: i32,
    demux_bitrate: f32,
    corrupt: i32,
    discontinuities: i32,
    decoded_video: i32,
    decoded_audio: i32,
    displayed: i32,
    lost: i32,
    played_audio: i32,
    lost_audio: i32,
    sent_packets: i32,
    sent_bytes: i32,
    sent_bitrate: f32,
}

fn main() {
    assert!(cfg!(target_os = "macos"), "This probe requires macOS.");
    let args: Vec<_> = std::env::args().collect();
    assert!(
        args.len() >= 3,
        "Expected VLC.app, media path, and optional duration."
    );
    let root = PathBuf::from(&args[1]).join("Contents/MacOS");
    let seconds = args.get(3).map(|s| s.parse::<u64>().unwrap()).unwrap_or(30);
    std::env::set_var("VLC_PLUGIN_PATH", root.join("plugins"));
    unsafe {
        let load = |name| {
            let path = CString::new(root.join("lib").join(name).to_str().unwrap()).unwrap();
            let library = dlopen(path.as_ptr(), 2 | 8); // RTLD_NOW | RTLD_GLOBAL
            assert!(!library.is_null(), "Cannot load {path:?}");
            library
        };
        let _core = load("libvlccore.dylib");
        let library = load("libvlc.dylib");
        let new: unsafe extern "C" fn(i32, *const *const c_char) -> *mut c_void =
            symbol(library, "libvlc_new");
        let options: Vec<_> = [
            "--ignore-config",
            "--no-plugins-cache",
            "--verbose=2",
            "--vout=dummy",
            "--no-audio",
            "--videotoolbox-hw-decoder-only",
            "--codec=videotoolbox,none",
        ]
        .map(|s| CString::new(s).unwrap())
        .into();
        let pointers: Vec<_> = options.iter().map(|s| s.as_ptr()).collect();
        let instance = new(pointers.len() as i32, pointers.as_ptr());
        assert!(!instance.is_null());
        let media_new: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void =
            symbol(library, "libvlc_media_new_path");
        let player_new: unsafe extern "C" fn(*mut c_void) -> *mut c_void =
            symbol(library, "libvlc_media_player_new_from_media");
        let play: unsafe extern "C" fn(*mut c_void) -> i32 =
            symbol(library, "libvlc_media_player_play");
        let stop: unsafe extern "C" fn(*mut c_void) = symbol(library, "libvlc_media_player_stop");
        let stats: unsafe extern "C" fn(*mut c_void, *mut Stats) -> i32 =
            symbol(library, "libvlc_media_get_stats");
        let media = media_new(instance, CString::new(args[2].as_str()).unwrap().as_ptr());
        assert!(!media.is_null());
        let player = player_new(media);
        assert!(!player.is_null());
        assert_eq!(play(player), 0);
        let mut latest = Stats::default();
        for second in 1..=seconds {
            thread::sleep(Duration::from_secs(1));
            assert_ne!(stats(media, &mut latest), 0);
            println!(
                "second={second} decoded={} displayed={} lost={}",
                latest.decoded_video, latest.displayed, latest.lost
            );
        }
        stop(player);
        for (name, pointer) in [
            ("libvlc_media_player_release", player),
            ("libvlc_media_release", media),
            ("libvlc_release", instance),
        ] {
            let release: unsafe extern "C" fn(*mut c_void) = symbol(library, name);
            release(pointer);
        }
        assert!(
            latest.displayed > 0,
            "No hardware-decoded pictures reached the output."
        );
    }
}
