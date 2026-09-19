//! The existing PlaybackCommand/PlaybackState contract, not a generic mpv command bridge.
use serde_json::{json, Value};
use std::collections::HashMap;

type Result<T> = std::result::Result<T, String>;
fn number(value: &Value, name: &str, min: f64, max: f64) -> Result<f64> {
    value[name]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(min, max))
        .ok_or_else(|| format!("The {name} value must be a finite number."))
}
fn boolean(value: &Value, name: &str) -> Result<bool> {
    value[name]
        .as_bool()
        .ok_or_else(|| format!("The {name} value must be a boolean."))
}
fn text(value: &Value, max: usize) -> Result<&str> {
    value
        .as_str()
        .filter(|s| s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| "The playback text value is invalid.".into())
}
fn track(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(json!("no"));
    }
    value
        .as_i64()
        .filter(|n| *n >= 0 && *n <= i32::MAX as i64)
        .map(|n| json!(n))
        .ok_or_else(|| "The playback track ID is invalid.".into())
}
fn property(name: &str, value: Value) -> Value {
    json!(["set_property", name, value])
}

pub fn commands(value: &Value) -> Result<Vec<Value>> {
    let (property_name, property_value) = match value["type"].as_str() {
        Some("seek") => {
            return Ok(vec![json!([
                "seek",
                number(value, "position", 0., 86_400_000.)?,
                "absolute+exact"
            ])])
        }
        Some("set-paused") => ("pause", json!(boolean(value, "paused")?)),
        Some("set-volume") => ("volume", json!(100. * number(value, "volume", 0., 1.)?)),
        Some("set-muted") => ("mute", json!(boolean(value, "muted")?)),
        Some("set-speed") => ("speed", json!(number(value, "speed", 0.25, 3.)?)),
        Some("set-video-track") => (
            "vid",
            track(value.get("trackId").ok_or("The track ID is missing.")?)?,
        ),
        Some("set-audio-track") => (
            "aid",
            track(value.get("trackId").ok_or("The track ID is missing.")?)?,
        ),
        Some("set-subtitle-track") => (
            "sid",
            track(value.get("trackId").ok_or("The track ID is missing.")?)?,
        ),
        Some("set-secondary-subtitle-track") => (
            "secondary-sid",
            track(value.get("trackId").ok_or("The track ID is missing.")?)?,
        ),
        Some("set-subtitle-delay") => (
            "sub-delay",
            json!(number(value, "seconds", -86_400., 86_400.)?),
        ),
        Some("set-audio-delay") => (
            "audio-delay",
            json!(number(value, "seconds", -86_400., 86_400.)?),
        ),
        Some("set-video-rotation") => ("video-rotate", json!(number(value, "degrees", 0., 360.)?)),
        Some("set-video-aspect") => (
            "video-aspect-override",
            if value["aspect"].is_null() {
                json!("-1")
            } else {
                json!(text(&value["aspect"], 64)?)
            },
        ),
        Some("set-video-crop") => (
            "video-crop",
            if value["crop"].is_null() {
                json!("no")
            } else {
                json!(text(&value["crop"], 64)?)
            },
        ),
        Some("set-subtitle-style") => {
            return Ok(vec![
                property("sub-font-size", json!(number(value, "fontSize", 1., 200.)?)),
                property("sub-color", json!(text(&value["color"], 64)?)),
                property("sub-border-color", json!(text(&value["borderColor"], 64)?)),
                property(
                    "sub-border-size",
                    json!(number(value, "borderWidth", 0., 20.)?),
                ),
                property(
                    "sub-back-color",
                    json!(text(&value["backgroundColor"], 64)?),
                ),
                property("sub-pos", json!(number(value, "position", 0., 100.)?)),
            ])
        }
        _ => return Err("This playback command is unsupported.".into()),
    };
    Ok(vec![property(property_name, property_value)])
}

pub fn start_commands(options: &Value) -> Result<Vec<Value>> {
    if !options.is_object() {
        return Err("Playback options must be an object.".into());
    }
    let mut result = vec![
        property(
            "volume",
            json!(
                options
                    .get("volume")
                    .map(|_| number(options, "volume", 0., 1.))
                    .transpose()?
                    .unwrap_or(1.)
                    * 100.
            ),
        ),
        property(
            "mute",
            json!(options
                .get("muted")
                .map(|_| boolean(options, "muted"))
                .transpose()?
                .unwrap_or(false)),
        ),
        property(
            "speed",
            json!(options
                .get("speed")
                .map(|_| number(options, "speed", 0.25, 3.))
                .transpose()?
                .unwrap_or(1.)),
        ),
    ];
    for (input, output) in [
        ("audioDelay", "audio-delay"),
        ("subtitleDelay", "sub-delay"),
    ] {
        if options.get(input).is_some() {
            result.push(property(
                output,
                json!(number(options, input, -86_400., 86_400.)?),
            ));
        }
    }
    if let Some(language) = options.get("audioLanguage") {
        result.push(property("alang", json!(text(language, 32)?)));
    } else if let Some(id) = options.get("audioTrackId") {
        result.push(property("aid", track(id)?));
    }
    if let Some(style) = options.get("subtitleStyle") {
        let mut style = style.clone();
        if !style.is_object() {
            return Err("The subtitle style is invalid.".into());
        }
        style["type"] = json!("set-subtitle-style");
        result.extend(commands(&style)?);
    }
    if options["nativeSubtitles"] == false {
        result.push(property("sid", json!("no")));
    }
    if options.get("startSeconds").is_some() {
        number(options, "startSeconds", 0., 86_400_000.)?;
    }
    if let Some(files) = options.get("subtitleFiles") {
        let files = files
            .as_array()
            .filter(|rows| rows.len() <= 32)
            .ok_or("Too many external subtitle files.")?;
        for file in files {
            text(&file["path"], 32_768)?;
            if !["sidecar", "opensubtitles"].contains(&file["source"].as_str().unwrap_or("")) {
                return Err("The subtitle source is invalid.".into());
            }
        }
    }
    Ok(result)
}

pub(super) fn tracks(value: &Value, sources: &HashMap<String, String>) -> Value {
    json!(value.as_array().map(|rows|rows.iter().take(1024).filter_map(|track| {
        let id = track["id"].as_i64().filter(|n|*n>=0 && *n<=i32::MAX as i64)?;
        let kind = match track["type"].as_str()? {"video"=>"video","audio"=>"audio","sub"=>"subtitle",_=>return None};
        let source = track["external-filename"].as_str().map(|path|sources.get(path).map(String::as_str).unwrap_or("sidecar")).unwrap_or("embedded");
        let mut result = json!({"id":id,"type":kind,"source":source,"selected":track["selected"]==true,"default":track["default"]==true,"forced":track["forced"]==true,"external":track["external"]==true});
        for (key,target) in [("codec","codec"),("lang","language"),("title","title")] {
            if let Some(value) = track[key].as_str() { result[target]=json!(value.chars().take(512).collect::<String>()); }
        }
        for (key,target) in [("demux-channel-count","channels"),("ff-index","streamIndex")] {
            if let Some(value) = track[key].as_u64().filter(|n|*n<=i32::MAX as u64) { result[target]=json!(value); }
        }
        Some(result)
    }).collect::<Vec<_>>()).unwrap_or_default())
}

pub struct State {
    pub value: Value,
    pub dirty: bool,
    pub tracks_dirty: bool,
    pub ended: bool,
    sources: HashMap<String, String>,
}
impl State {
    pub fn new(id: &str, options: &Value) -> Self {
        let sources = options["subtitleFiles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v["path"].as_str()?.into(), v["source"].as_str()?.into())))
            .collect();
        Self {
            value: json!({"sessionId":id,"status":"starting","paused":false,"volume":options["volume"].as_f64().unwrap_or(1.),"muted":options["muted"]==true,"speed":options["speed"].as_f64().unwrap_or(1.),"diagnostics":{}}),
            dirty: true,
            tracks_dirty: false,
            ended: false,
            sources,
        }
    }
    pub fn event(&mut self, message: &Value) {
        match message["event"].as_str() {
            Some("start-file") => {
                self.value["status"] = json!("loading");
                self.ended = false;
            }
            Some("file-loaded") | Some("playback-restart") => {
                self.value["status"] = json!("ready");
                self.ended = false;
            }
            Some("end-file") => match message["reason"].as_str() {
                Some("eof") => {
                    self.ended = true;
                    self.value["status"] = json!("ended");
                    self.value["paused"] = json!(true);
                }
                Some("stop" | "quit" | "redirect") => return,
                _ => {
                    self.value["status"] = json!("error");
                    self.value["error"] = json!("mpv could not play this source.");
                    self.value["paused"] = json!(true);
                }
            },
            Some("property-change") => {
                let data = &message["data"];
                match message["name"].as_str() {
                    Some("eof-reached") if data == true => {
                        self.ended = true;
                        self.value["status"] = json!("ended");
                        self.value["paused"] = json!(true);
                    }
                    Some("time-pos" | "duration" | "volume" | "speed") => {
                        if let Some(number) = data.as_f64().filter(|v| v.is_finite() && *v >= 0.) {
                            let key = match message["name"].as_str() {
                                Some("time-pos") => "position",
                                Some("duration") => "duration",
                                Some("volume") => "volume",
                                _ => "speed",
                            };
                            self.value[key] = json!(if key == "volume" {
                                number / 100.
                            } else {
                                number
                            });
                        } else {
                            return;
                        }
                    }
                    Some("pause") if data.is_boolean() => self.value["paused"] = data.clone(),
                    Some("mute") if data.is_boolean() => self.value["muted"] = data.clone(),
                    Some("track-list") => {
                        let value = tracks(data, &self.sources);
                        if self.value["tracks"] == value {
                            return;
                        }
                        self.value["tracks"] = value;
                        self.tracks_dirty = true;
                    }
                    Some("video-params") => {
                        for (key, target) in [("w", "videoWidth"), ("h", "videoHeight")] {
                            if let Some(n) = data[key].as_u64().filter(|n| *n <= 65536) {
                                self.value[target] = json!(n);
                            }
                        }
                    }
                    Some("hwdec-current") if data.is_string() => {
                        self.value["diagnostics"]["hardwareDecoder"] = json!(data
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(128)
                            .collect::<String>());
                        self.value["diagnostics"]["hardwareDecode"] =
                            json!(data != "no" && data != "");
                    }
                    Some("paused-for-cache") if data.is_boolean() => {
                        self.value["diagnostics"]["buffering"] = data.clone()
                    }
                    Some("video-codec") if data.is_string() => {
                        self.value["diagnostics"]["videoCodec"] = json!(data
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(128)
                            .collect::<String>())
                    }
                    Some(
                        "frame-drop-count"
                        | "decoder-frame-drop-count"
                        | "demuxer-cache-duration"
                        | "estimated-vf-fps",
                    ) if data
                        .as_f64()
                        .is_some_and(|n| (0. ..=9_007_199_254_740_991.).contains(&n)) =>
                    {
                        let key = match message["name"].as_str() {
                            Some("frame-drop-count") => "frameDrops",
                            Some("decoder-frame-drop-count") => "decoderFrameDrops",
                            Some("demuxer-cache-duration") => "bufferSeconds",
                            _ => "estimatedFps",
                        };
                        self.value["diagnostics"][key] = data.clone();
                    }
                    _ => return,
                }
            }
            _ => return,
        }
        self.dirty = true;
    }
    pub fn take_update(&mut self) -> Option<Value> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let mut value = self.value.clone();
        if !self.tracks_dirty {
            value.as_object_mut()?.remove("tracks");
        }
        self.tracks_dirty = false;
        Some(value)
    }
}
