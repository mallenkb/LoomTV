# FFmpeg HLS planner

`crates/loomtv-core/src/transcode_plan.rs` ports the pure planning code used by Electron's `transcodePlan.ts` and `transcodeFilters.ts`. It does not start FFmpeg or manage playback sessions.

The main entry point is `build_hls_args`. It accepts authorized input and output paths, the renderer's transcode options, the preset selected after capability checks, optional probe data, seekable window settings, and an optional VA-API device. It returns the ordered FFmpeg argument vector. The caller remains responsible for path authorization, binary discovery, hardware capability checks, process limits, session cleanup, HLS credentials, and HTTP delivery.

The planner includes these Electron behaviors:

- `normalize_playback_profile` applies media-core's codec and bitrate bounds.
- Local playback uses one-second segments in 30-segment windows. LAN playback uses two-second segments in 45-segment windows.
- `frame_aligned_segment_seconds` snaps the segment grid to a whole number of source frames.
- Seekable windows re-encode audio and video, number segments on the global timeline, set `-output_ts_offset`, avoid `append_list`, and force keyframes on the same segment grid.
- Non-seekable H.264 and AAC or MP3 streams use stream copy only when the probe fields match Electron's safe cases and no requested filter changes the video.
- Software H.264, HEVC, and AV1 settings match Electron. VideoToolbox, NVENC, QSV, VA-API, AMF, and RKMPP encoder names and preset arguments also match.
- HDR probe fields trigger the same zscale and Mobius tone-map chain unless the caller explicitly disables tone mapping.
- Text, bitmap, external, embedded, and dual subtitles use the same stream selection, libass style, seek timestamp adjustment, filtergraph labels, and filter-path escaping as Electron.

Supporting helpers build the full-duration VOD playlist, segment count and names, embedded WebVTT extraction arguments, segment profile selection, and reposition decisions. The full-duration playlist declares the frame-aligned durations with six decimal places and ends with `#EXT-X-ENDLIST`.

The planner deliberately does not read `LOOMTV_VAAPI_DEVICE` or `VAAPI_DEVICE`. The process layer passes the chosen device through `vaapi_device`; omitting it uses `/dev/dri/renderD128`. This keeps environment and host policy outside the pure planner.

No FFmpeg process, provider request, media file, runtime, or real user database was opened during this work. Only formatting and Cargo's static compiler check are permitted for this module.
