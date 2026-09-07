use crate::{Error, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const TRANSCODE_READY_SEGMENTS: usize = 1;
pub const HLS_SEGMENT_SECONDS: f64 = 2.0;
pub const HLS_WINDOW_SEGMENTS: usize = 45;
pub const LOCAL_HLS_SEGMENT_SECONDS: f64 = 1.0;
pub const LOCAL_HLS_WINDOW_SEGMENTS: usize = 30;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HlsSegmentProfile {
    LocalInteractive,
    LanStable,
}

impl HlsSegmentProfile {
    pub fn segment_seconds(self) -> f64 {
        match self {
            Self::LocalInteractive => LOCAL_HLS_SEGMENT_SECONDS,
            Self::LanStable => HLS_SEGMENT_SECONDS,
        }
    }

    pub fn window_segments(self) -> usize {
        match self {
            Self::LocalInteractive => LOCAL_HLS_WINDOW_SEGMENTS,
            Self::LanStable => HLS_WINDOW_SEGMENTS,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Codec {
    H264,
    Hevc,
    Av1,
}

impl Codec {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("hevc") => Self::Hevc,
            Some("av1") => Self::Av1,
            _ => Self::H264,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Preset {
    Software,
    Videotoolbox,
    Nvenc,
    Qsv,
    Vaapi,
    Amf,
    Rkmpp,
}

impl Preset {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "software" => Ok(Self::Software),
            "videotoolbox" => Ok(Self::Videotoolbox),
            "nvenc" => Ok(Self::Nvenc),
            "qsv" => Ok(Self::Qsv),
            "vaapi" => Ok(Self::Vaapi),
            "amf" => Ok(Self::Amf),
            "rkmpp" => Ok(Self::Rkmpp),
            _ => Err(Error::new(
                "invalid_transcode_preset",
                "Choose a supported FFmpeg encoder preset.",
            )),
        }
    }

    fn suffix(self) -> Option<&'static str> {
        match self {
            Self::Software => None,
            Self::Videotoolbox => Some("videotoolbox"),
            Self::Nvenc => Some("nvenc"),
            Self::Qsv => Some("qsv"),
            Self::Vaapi => Some("vaapi"),
            Self::Amf => Some("amf"),
            Self::Rkmpp => Some("rkmpp"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NormalizedPlaybackProfile {
    pub codec: String,
    pub max_width: i64,
    pub max_height: i64,
    pub video_bitrate_kbps: i64,
    pub audio_bitrate_kbps: i64,
    pub tone_map: bool,
}

#[derive(Clone, Debug)]
struct SubtitleStyle {
    position: f64,
    scale: f64,
    font_size: f64,
    font_color: String,
    border_color: String,
    border_width: f64,
    background_color: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Placement {
    Primary,
    Secondary,
}

#[derive(Clone, Debug)]
struct SubtitleSelection {
    track_index: i64,
    stream_ordinal: i64,
    codec: String,
    file_path: Option<String>,
    placement: Placement,
}

pub fn hls_segment_profile_for_scope(scope: Option<&str>) -> HlsSegmentProfile {
    if scope.is_some_and(|value| value.starts_with("lan:")) {
        HlsSegmentProfile::LanStable
    } else {
        HlsSegmentProfile::LocalInteractive
    }
}

pub fn normalize_playback_profile(options: &Value) -> NormalizedPlaybackProfile {
    let codec = Codec::parse(
        options
            .get("codec")
            .or_else(|| options.get("targetVideoCodec"))
            .and_then(Value::as_str),
    );
    NormalizedPlaybackProfile {
        codec: codec.as_str().to_owned(),
        max_width: bounded_integer(options.get("maxWidth"), 0, 0, 8_192),
        max_height: bounded_integer(options.get("maxHeight"), 0, 0, 8_192),
        video_bitrate_kbps: bounded_integer(options.get("videoBitrateKbps"), 0, 0, 100_000),
        audio_bitrate_kbps: bounded_integer(options.get("audioBitrateKbps"), 160, 32, 1_024),
        tone_map: option_truthy_bool(options.get("toneMap"))
            || options.get("toneMap").and_then(Value::as_i64) == Some(1),
    }
}

pub fn build_embedded_subtitle_vtt_args(file_path: &Path, stream_ordinal: f64) -> Vec<String> {
    let ordinal = if stream_ordinal.is_finite() && stream_ordinal > 0.0 {
        stream_ordinal.floor() as i64
    } else {
        0
    };
    vec![
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        path_text(file_path),
        "-map".into(),
        format!("0:s:{ordinal}"),
        "-f".into(),
        "webvtt".into(),
        "pipe:1".into(),
    ]
}

pub fn frame_aligned_segment_seconds(segment_seconds: f64, frame_rate: Option<f64>) -> f64 {
    if !segment_seconds.is_finite() || segment_seconds <= 0.0 {
        return HLS_SEGMENT_SECONDS;
    }
    let Some(frame_rate) = frame_rate.filter(|value| value.is_finite() && *value > 0.0) else {
        return segment_seconds;
    };
    let frames = (segment_seconds * frame_rate).round();
    if frames <= 0.0 {
        segment_seconds
    } else {
        frames / frame_rate
    }
}

pub fn transcode_segment_name(index: i64) -> String {
    format!("segment-{:05}.ts", index.max(0))
}

pub fn transcode_segment_count(duration_seconds: f64, segment_seconds: f64) -> usize {
    if !duration_seconds.is_finite()
        || !segment_seconds.is_finite()
        || duration_seconds <= 0.0
        || segment_seconds <= 0.0
    {
        return 0;
    }
    ((duration_seconds / segment_seconds).ceil() as usize).max(1)
}

pub fn build_vod_playlist(duration_seconds: f64, segment_seconds: f64) -> String {
    let count = transcode_segment_count(duration_seconds, segment_seconds);
    let mut lines = vec![
        "#EXTM3U".to_owned(),
        "#EXT-X-VERSION:3".to_owned(),
        format!(
            "#EXT-X-TARGETDURATION:{}",
            segment_seconds.ceil().max(1.0) as i64
        ),
        "#EXT-X-MEDIA-SEQUENCE:0".to_owned(),
        "#EXT-X-PLAYLIST-TYPE:VOD".to_owned(),
    ];
    for index in 0..count {
        let remaining = duration_seconds - index as f64 * segment_seconds;
        let duration = segment_seconds.min(remaining).max(0.001);
        lines.push(format!("#EXTINF:{duration:.6},"));
        lines.push(transcode_segment_name(index as i64));
    }
    lines.push("#EXT-X-ENDLIST".to_owned());
    format!("{}\n", lines.join("\n"))
}

pub fn should_reposition_encoder(
    requested_index: i64,
    window_start_index: i64,
    last_requested_index: i64,
    segment_on_disk: bool,
    process_alive: bool,
    contiguity_tolerance: i64,
) -> bool {
    if segment_on_disk {
        false
    } else if !process_alive || requested_index < window_start_index {
        true
    } else {
        requested_index > last_requested_index.saturating_add(contiguity_tolerance)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_hls_args(
    file_path: &Path,
    output_path: &Path,
    options: &Value,
    preset: &str,
    media_info: Option<&Value>,
    seekable: bool,
    start_number: i64,
    segment_seconds: f64,
    window_segments: i64,
    vaapi_device: Option<&str>,
) -> Result<Vec<String>> {
    let preset = Preset::parse(preset)?;
    let profile = normalize_playback_profile(options);
    let codec = Codec::parse(Some(&profile.codec));
    let has_audio = integer(options.get("audioTrackIndex")) != Some(-1);
    let selections = subtitle_selections(options);
    let has_subtitle = !selections.is_empty();
    let bitmap_subtitle = selections
        .iter()
        .any(|selection| is_bitmap_subtitle_codec(&selection.codec));
    let profile_video = option_truthy_number(options.get("maxWidth"))
        || option_truthy_number(options.get("maxHeight"))
        || option_truthy_number(options.get("videoBitrateKbps"))
        || option_truthy_bool(options.get("toneMap"));
    let copy_video = !seekable
        && !profile_video
        && codec == Codec::H264
        && !has_subtitle
        && copy_safe_video(media_info);
    let copy_audio = !seekable
        && options.get("audioBitrateKbps").is_none()
        && has_audio
        && copy_safe_audio(media_info);
    let segment_seconds = if segment_seconds.is_finite() && segment_seconds > 0.0 {
        segment_seconds
    } else {
        HLS_SEGMENT_SECONDS
    };
    let explicit_tone_map = option_truthy_bool(options.get("toneMap"));
    let tone_map_disabled = options.get("toneMap") == Some(&Value::Bool(false));
    let tone_map =
        !copy_video && !tone_map_disabled && (explicit_tone_map || needs_tone_mapping(media_info));
    let scaling = if copy_video {
        None
    } else {
        scale_filter(&profile)
    };
    let start_seconds = number(options.get("startSeconds")).unwrap_or(0.0);

    let mut args = Vec::new();
    if start_seconds > 0.0 {
        push_pair(&mut args, "-ss", ffmpeg_seconds(start_seconds));
    }

    let hardware_decode = !copy_video
        && !has_subtitle
        && !bitmap_subtitle
        && !tone_map
        && scaling.is_none()
        && matches!(
            preset,
            Preset::Videotoolbox | Preset::Nvenc | Preset::Qsv | Preset::Vaapi
        );
    match preset {
        Preset::Nvenc if hardware_decode => {
            push_pair(&mut args, "-hwaccel", "cuda");
            push_pair(&mut args, "-hwaccel_output_format", "cuda");
        }
        Preset::Qsv if hardware_decode => {
            push_pair(&mut args, "-init_hw_device", "qsv=hw");
            push_pair(&mut args, "-hwaccel", "qsv");
            push_pair(&mut args, "-hwaccel_output_format", "qsv");
        }
        Preset::Videotoolbox if hardware_decode => {
            push_pair(&mut args, "-hwaccel", "videotoolbox");
            push_pair(&mut args, "-hwaccel_output_format", "videotoolbox_vld");
        }
        Preset::Vaapi => {
            push_pair(
                &mut args,
                "-vaapi_device",
                vaapi_device.unwrap_or("/dev/dri/renderD128"),
            );
            if hardware_decode {
                push_pair(&mut args, "-hwaccel", "vaapi");
                push_pair(&mut args, "-hwaccel_output_format", "vaapi");
            }
        }
        _ => {}
    }

    push_pair(&mut args, "-i", path_text(file_path));
    if seekable && window_segments > 0 {
        push_pair(
            &mut args,
            "-t",
            ffmpeg_seconds(segment_seconds * window_segments as f64),
        );
    }

    if bitmap_subtitle {
        let (filter, output) = subtitle_filter_complex(file_path, options, &selections);
        let post_filter = preset == Preset::Vaapi || tone_map || scaling.is_some();
        let final_output = if post_filter {
            format!("{output}processed")
        } else {
            output.clone()
        };
        let graph = if post_filter {
            let mut filters = vec![if tone_map {
                tone_mapping_filter(preset, true)
            } else {
                "format=yuv420p".to_owned()
            }];
            if let Some(scale) = &scaling {
                filters.push(scale.clone());
            }
            let mut suffix = filters.join(",");
            if preset == Preset::Vaapi {
                suffix.push_str(",format=nv12,hwupload");
            }
            format!("{filter};[{output}]{suffix}[{final_output}]")
        } else {
            filter
        };
        push_pair(&mut args, "-filter_complex", graph);
        push_pair(&mut args, "-map", format!("[{final_output}]"));
    } else {
        push_pair(
            &mut args,
            "-map",
            stream_map('v', integer(options.get("videoTrackIndex")), false),
        );
    }
    if has_audio {
        push_pair(
            &mut args,
            "-map",
            stream_map('a', integer(options.get("audioTrackIndex")), true),
        );
    }
    args.extend(["-sn".to_owned(), "-dn".to_owned()]);

    if has_subtitle && !bitmap_subtitle {
        let primary = selections
            .iter()
            .find(|selection| selection.placement == Placement::Primary)
            .or_else(|| selections.first());
        let secondary = selections
            .iter()
            .find(|selection| primary.is_none_or(|primary| !std::ptr::eq(*selection, primary)));
        let subtitle_filter = text_subtitle_filter(
            file_path,
            primary.map(|value| value.stream_ordinal).unwrap_or(0),
            subtitle_style(options.get("subtitleStyle")),
            start_seconds,
            secondary.map(|value| value.stream_ordinal),
            primary.and_then(|value| value.file_path.as_deref()),
            secondary.and_then(|value| value.file_path.as_deref()),
        );
        let filtered = if tone_map {
            format!(
                "{},{subtitle_filter}{}",
                tone_mapping_filter(preset, false),
                if preset == Preset::Vaapi {
                    ",format=nv12,hwupload"
                } else {
                    ""
                }
            )
        } else if preset == Preset::Vaapi {
            format!("{subtitle_filter},format=nv12,hwupload")
        } else {
            subtitle_filter
        };
        let mut filters = vec![filtered];
        if let Some(scale) = scaling {
            filters.push(scale);
        }
        push_pair(&mut args, "-vf", filters.join(","));
    } else if !copy_video && !bitmap_subtitle && !hardware_decode {
        let mut filters = vec![if tone_map {
            tone_mapping_filter(preset, false)
        } else {
            "format=yuv420p".to_owned()
        }];
        if let Some(scale) = scaling {
            filters.push(scale);
        }
        if preset == Preset::Vaapi {
            filters.push("format=nv12".to_owned());
            filters.push("hwupload".to_owned());
        }
        push_pair(&mut args, "-vf", filters.join(","));
    }

    if copy_video {
        push_pair(&mut args, "-c:v", "copy");
    } else if let Some(suffix) = preset.suffix() {
        let encoder = format!("{}_{}", codec.as_str(), suffix);
        push_pair(&mut args, "-c:v", &encoder);
        append_hardware_encoder_options(&mut args, &encoder);
        append_video_bitrate(&mut args, profile.video_bitrate_kbps);
    } else {
        let encoder = software_encoder(codec, options.get("softwareVideoEncoder"));
        push_pair(&mut args, "-c:v", encoder);
        match codec {
            Codec::H264 => args.extend(strings(&[
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "main",
            ])),
            Codec::Hevc => args.extend(strings(&[
                "-preset", "medium", "-crf", "28", "-pix_fmt", "yuv420p",
            ])),
            Codec::Av1 => args.extend(strings(&[
                "-preset", "8", "-crf", "32", "-pix_fmt", "yuv420p",
            ])),
        }
        append_video_bitrate(&mut args, profile.video_bitrate_kbps);
    }

    if !has_audio {
        args.push("-an".to_owned());
    } else if copy_audio {
        push_pair(&mut args, "-c:a", "copy");
    } else {
        args.extend(strings(&[
            "-c:a",
            "aac",
            "-af",
            "aresample=async=1:first_pts=0",
            "-b:a",
            &format!("{}k", profile.audio_bitrate_kbps),
            "-ac",
            "2",
        ]));
    }

    push_pair(&mut args, "-fflags", "+genpts");
    if seekable {
        push_pair(&mut args, "-avoid_negative_ts", "disabled");
        push_pair(
            &mut args,
            "-output_ts_offset",
            ffmpeg_seconds(start_seconds),
        );
    } else {
        push_pair(&mut args, "-avoid_negative_ts", "make_zero");
    }
    args.extend(strings(&[
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-f",
        "hls",
        "-hls_time",
        &js_number(segment_seconds),
        "-hls_list_size",
        if seekable { "0" } else { "12" },
    ]));
    if seekable {
        push_pair(&mut args, "-hls_playlist_type", "event");
    }
    push_pair(
        &mut args,
        "-hls_flags",
        if seekable {
            "independent_segments"
        } else {
            "append_list+delete_segments+independent_segments"
        },
    );
    let segment_path = output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("segment-%05d.ts");
    push_pair(&mut args, "-hls_segment_filename", path_text(&segment_path));
    if seekable {
        push_pair(&mut args, "-start_number", start_number.max(0).to_string());
    }
    if !copy_video {
        push_pair(
            &mut args,
            "-force_key_frames",
            format!("expr:gte(t,n_forced*{})", js_number(segment_seconds)),
        );
    }
    args.push(path_text(output_path));
    Ok(args)
}

fn subtitle_selections(options: &Value) -> Vec<SubtitleSelection> {
    let mut values = Vec::new();
    let primary_file = nonempty_string(options.get("subtitleFilePath"));
    if let Some(file_path) = primary_file.clone() {
        values.push(SubtitleSelection {
            track_index: -1,
            stream_ordinal: 0,
            codec: text(options.get("subtitleCodec")),
            file_path: Some(file_path),
            placement: Placement::Primary,
        });
    } else if let Some(track_index) = integer(options.get("subtitleTrackIndex")).filter(|v| *v >= 0)
    {
        values.push(SubtitleSelection {
            track_index,
            stream_ordinal: integer(options.get("subtitleStreamOrdinal")).unwrap_or(0),
            codec: text(options.get("subtitleCodec")),
            file_path: None,
            placement: Placement::Primary,
        });
    }
    let secondary_file = nonempty_string(options.get("secondarySubtitleFilePath"));
    if secondary_file.is_some() && secondary_file != primary_file {
        values.push(SubtitleSelection {
            track_index: -1,
            stream_ordinal: 0,
            codec: text(options.get("secondarySubtitleCodec")),
            file_path: secondary_file,
            placement: Placement::Secondary,
        });
    } else if let Some(track_index) = integer(options.get("secondarySubtitleTrackIndex"))
        .filter(|value| *value >= 0 && Some(*value) != integer(options.get("subtitleTrackIndex")))
    {
        values.push(SubtitleSelection {
            track_index,
            stream_ordinal: integer(options.get("secondarySubtitleStreamOrdinal")).unwrap_or(0),
            codec: text(options.get("secondarySubtitleCodec")),
            file_path: None,
            placement: Placement::Secondary,
        });
    }
    values
}

fn subtitle_filter_complex(
    file_path: &Path,
    options: &Value,
    selections: &[SubtitleSelection],
) -> (String, String) {
    let mut current = filter_stream(integer(options.get("videoTrackIndex")));
    let mut filters = Vec::new();
    let seek = number(options.get("startSeconds"))
        .filter(|value| *value > 0.0)
        .unwrap_or(0.0)
        .floor() as i64;
    if seek > 0 {
        filters.push(format!("[{current}]setpts=PTS+{seek}/TB[vseekin]"));
        current = "vseekin".to_owned();
    }
    let style = subtitle_style(options.get("subtitleStyle"));
    for (index, selection) in selections.iter().enumerate() {
        let output = format!("vsub{index}");
        if is_bitmap_subtitle_codec(&selection.codec) && selection.file_path.is_none() {
            filters.push(format!(
                "[{current}][0:{}]overlay,format=yuv420p[{output}]",
                selection.track_index
            ));
        } else {
            let source = selection
                .file_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| file_path.to_owned());
            filters.push(format!(
                "[{current}]{},format=yuv420p[{output}]",
                subtitle_filter_segment(
                    &source,
                    selection.stream_ordinal,
                    style.as_ref(),
                    selection.placement
                )
            ));
        }
        current = output;
    }
    if seek > 0 {
        filters.push(format!(
            "[{current}]setpts=PTS-{seek}/TB,format=yuv420p[vseekout]"
        ));
        current = "vseekout".to_owned();
    }
    (filters.join(";"), current)
}

#[allow(clippy::too_many_arguments)]
fn text_subtitle_filter(
    file_path: &Path,
    ordinal: i64,
    style: Option<SubtitleStyle>,
    start_seconds: f64,
    secondary_ordinal: Option<i64>,
    subtitle_file: Option<&str>,
    secondary_file: Option<&str>,
) -> String {
    let primary_path = subtitle_file
        .map(PathBuf::from)
        .unwrap_or_else(|| file_path.to_owned());
    let mut filters = vec![subtitle_filter_segment(
        &primary_path,
        ordinal,
        style.as_ref(),
        Placement::Primary,
    )];
    if let Some(secondary_ordinal) = secondary_ordinal.filter(|value| *value >= 0) {
        let secondary_path = secondary_file
            .map(PathBuf::from)
            .unwrap_or_else(|| file_path.to_owned());
        filters.push(subtitle_filter_segment(
            &secondary_path,
            secondary_ordinal,
            style.as_ref(),
            Placement::Secondary,
        ));
    }
    let filters = filters.join(",");
    let seek = if start_seconds.is_finite() && start_seconds > 0.0 {
        start_seconds.floor() as i64
    } else {
        0
    };
    if seek > 0 {
        format!("setpts=PTS+{seek}/TB,{filters},setpts=PTS-{seek}/TB,format=yuv420p")
    } else {
        format!("{filters},format=yuv420p")
    }
}

fn subtitle_filter_segment(
    file_path: &Path,
    ordinal: i64,
    style: Option<&SubtitleStyle>,
    placement: Placement,
) -> String {
    format!(
        "subtitles=filename={}\\:si={}:force_style='{}'",
        escape_filter_path(&path_text(file_path)),
        ordinal,
        subtitle_force_style(style, placement)
    )
}

fn subtitle_force_style(style: Option<&SubtitleStyle>, placement: Placement) -> String {
    let font_size = clamp(
        style.map(|value| value.font_size).unwrap_or(32.0),
        24.0,
        96.0,
    ) * clamp(style.map(|value| value.scale).unwrap_or(1.0), 0.5, 2.0);
    let position = if placement == Placement::Secondary {
        8.0
    } else {
        clamp(
            style.map(|value| value.position).unwrap_or(96.0),
            0.0,
            100.0,
        )
    };
    let margin = if placement == Placement::Secondary {
        (position * 6.0).round() as i64
    } else {
        ((100.0 - position) * 6.0).round() as i64
    };
    let border = clamp(
        style.map(|value| value.border_width).unwrap_or(3.0),
        0.0,
        10.0,
    );
    let font_color = style.map(|v| v.font_color.as_str()).unwrap_or("#ffffff");
    let border_color = style.map(|v| v.border_color.as_str()).unwrap_or("#000000");
    let background = style
        .map(|v| v.background_color.as_str())
        .unwrap_or("#000000");
    [
        format!("Fontsize={}", font_size.round() as i64),
        format!("PrimaryColour={}", ass_color(font_color, "#ffffff")),
        format!("OutlineColour={}", ass_color(border_color, "#000000")),
        format!("BackColour={}", ass_color(background, "#000000")),
        format!("Outline={}", js_number(border)),
        "Shadow=0".to_owned(),
        format!(
            "Alignment={}",
            if placement == Placement::Secondary {
                8
            } else {
                2
            }
        ),
        format!("MarginV={margin}"),
    ]
    .join(",")
}

fn subtitle_style(value: Option<&Value>) -> Option<SubtitleStyle> {
    let value = value?.as_object()?;
    Some(SubtitleStyle {
        position: finite(value.get("position")).unwrap_or(96.0),
        scale: finite(value.get("scale")).unwrap_or(1.0),
        font_size: finite(value.get("fontSize")).unwrap_or(32.0),
        font_color: value
            .get("fontColor")
            .and_then(Value::as_str)
            .unwrap_or("#ffffff")
            .to_owned(),
        border_color: value
            .get("borderColor")
            .and_then(Value::as_str)
            .unwrap_or("#000000")
            .to_owned(),
        border_width: finite(value.get("borderWidth")).unwrap_or(3.0),
        background_color: value
            .get("backgroundColor")
            .and_then(Value::as_str)
            .unwrap_or("#000000")
            .to_owned(),
    })
}

fn escape_filter_path(file_path: &str) -> String {
    let mut result = String::new();
    for character in file_path.chars() {
        if character == '\\' {
            result.push_str("\\\\\\\\\\\\");
        } else if ":'[],;".contains(character) {
            result.push_str("\\\\\\");
            result.push(character);
        } else {
            result.push(character);
        }
    }
    result
}

fn append_hardware_encoder_options(args: &mut Vec<String>, encoder: &str) {
    if encoder == "h264_videotoolbox" {
        args.extend(strings(&[
            "-allow_sw",
            "1",
            "-realtime",
            "1",
            "-b:v",
            "6500k",
            "-maxrate",
            "8500k",
            "-bufsize",
            "12000k",
            "-profile:v",
            "main",
        ]));
    } else if encoder.ends_with("_nvenc") {
        args.extend(strings(&["-preset", "p4", "-cq", "23", "-b:v", "0"]));
    } else if encoder.ends_with("_qsv") {
        args.extend(strings(&["-global_quality", "23", "-look_ahead", "0"]));
    } else if encoder.ends_with("_vaapi") {
        args.extend(strings(&["-qp", "23"]));
    } else if encoder.ends_with("_amf") {
        args.extend(strings(&[
            "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23",
        ]));
    } else if encoder.ends_with("_rkmpp") {
        args.extend(strings(&["-qp_init", "23"]));
    } else {
        args.extend(strings(&[
            "-allow_sw",
            "1",
            "-realtime",
            "1",
            "-b:v",
            "6500k",
            "-maxrate",
            "8500k",
            "-bufsize",
            "12000k",
        ]));
    }
}

fn append_video_bitrate(args: &mut Vec<String>, bitrate: i64) {
    if bitrate > 0 {
        let bitrate = bitrate.max(128);
        args.extend(strings(&[
            "-b:v",
            &format!("{bitrate}k"),
            "-maxrate",
            &format!("{bitrate}k"),
            "-bufsize",
            &format!("{}k", bitrate * 2),
        ]));
    }
}

fn software_encoder(codec: Codec, requested: Option<&Value>) -> &'static str {
    match codec {
        Codec::H264 => "libx264",
        Codec::Hevc => "libx265",
        Codec::Av1 if requested.and_then(Value::as_str) == Some("libaom-av1") => "libaom-av1",
        Codec::Av1 => "libsvtav1",
    }
}

fn tone_mapping_filter(preset: Preset, upload: bool) -> String {
    let format = if preset == Preset::Vaapi && upload {
        "nv12,hwupload"
    } else {
        "yuv420p"
    };
    format!("zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format={format}")
}

fn needs_tone_mapping(media_info: Option<&Value>) -> bool {
    let transfer = info_text(media_info, "colorTransfer");
    let primaries = info_text(media_info, "colorPrimaries");
    let pixel_format = info_text(media_info, "pixelFormat");
    transfer.contains("smpte2084")
        || transfer.contains("arib-std-b67")
        || transfer.contains("hlg")
        || (primaries.contains("bt2020")
            && (pixel_format.contains('1')
                && (pixel_format.contains("10") || pixel_format.contains("12"))))
}

fn copy_safe_video(media_info: Option<&Value>) -> bool {
    info_text(media_info, "videoCodec") == "h264"
        && info_text(media_info, "pixelFormat") == "yuv420p"
        && !info_text(media_info, "videoProfile").contains("10")
}

fn copy_safe_audio(media_info: Option<&Value>) -> bool {
    matches!(info_text(media_info, "audioCodec").as_str(), "aac" | "mp3")
}

fn scale_filter(profile: &NormalizedPlaybackProfile) -> Option<String> {
    if profile.max_width == 0 && profile.max_height == 0 {
        None
    } else {
        Some(format!(
            "scale={}:{}:force_original_aspect_ratio=decrease",
            if profile.max_width > 0 {
                profile.max_width
            } else {
                -2
            },
            if profile.max_height > 0 {
                profile.max_height
            } else {
                -2
            }
        ))
    }
}

fn stream_map(kind: char, selected: Option<i64>, optional: bool) -> String {
    let suffix = if optional { "?" } else { "" };
    selected
        .filter(|value| *value >= 0)
        .map(|value| format!("0:{value}{suffix}"))
        .unwrap_or_else(|| format!("0:{kind}:0{suffix}"))
}

fn filter_stream(selected: Option<i64>) -> String {
    selected
        .filter(|value| *value >= 0)
        .map(|value| format!("0:{value}"))
        .unwrap_or_else(|| "0:v:0".to_owned())
}

fn ass_color(value: &str, fallback: &str) -> String {
    let value = if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        value
    } else {
        fallback
    };
    format!("&H00{}{}{}", &value[5..7], &value[3..5], &value[1..3]).to_ascii_uppercase()
}

fn is_bitmap_subtitle_codec(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("pgs") || value.contains("dvd") || value.contains("dvb")
}

fn bounded_integer(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    finite(value)
        .map(|value| value.round() as i64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| *value as i64)
        })
    })
}

fn number(value: Option<&Value>) -> Option<f64> {
    finite(value)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| value.is_finite())
}

fn option_truthy_number(value: Option<&Value>) -> bool {
    finite(value).is_some_and(|value| value != 0.0)
}

fn option_truthy_bool(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true)) || value.and_then(Value::as_str) == Some("1")
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}

fn nonempty_string(value: Option<&Value>) -> Option<String> {
    let value = text(value);
    (!value.trim().is_empty()).then_some(value)
}

fn info_text(media_info: Option<&Value>, key: &str) -> String {
    media_info
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        min
    }
}

fn ffmpeg_seconds(value: f64) -> String {
    format!(
        "{:.6}",
        if value.is_finite() {
            value.max(0.0)
        } else {
            0.0
        }
    )
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn path_text(value: &Path) -> String {
    value.to_string_lossy().into_owned()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn push_pair(args: &mut Vec<String>, key: &str, value: impl Into<String>) {
    args.push(key.to_owned());
    args.push(value.into());
}
