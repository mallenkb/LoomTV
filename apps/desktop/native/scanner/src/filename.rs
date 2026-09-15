use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Serialize)]
pub struct Hints {
    title: String,
    year: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episode: Option<u32>,
    #[serde(rename = "subtitleKeys", skip_serializing_if = "Option::is_none")]
    subtitle_keys: Option<Vec<String>>,
}
static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
    r"(?i)\.(3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv|vtt|srt|ass|ssa)$",
    r"\b(19[0-9]{2}|20[0-9]{2})\b",
    r"[\s(\[._-]+$",
    r"\[.*?\]|\(.*?\)",
    r"[._-]+",
    r"(?i)\b(480p|720p|1080p|2160p|4k|uhd|hdr10|hdr|dv|dolby|vision|bluray|blu-ray|brrip|webrip|web-rip|web-dl|webdl|hdtv|remux|proper|repack|extended|directors?|cut|imax|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|dts|truehd|atmos)\b",
    r"(?i)\b(yts|rarbg|ettv|eztv|tgx|galaxyrg|psa|pahe|ntb|successfulcrab)\b",
    r"\s+[Ss][0-9]{1,2}[Ee][0-9]{1,3}.*$",
    r"\s+[Ss][0-9]{1,2}\s*$",
    r"(?i)\s+season\s+[0-9]{1,2}\s*$",
    r"\s+",
    r"\.[^.]+$",
    r"[Ss]\s*0*([0-9]{1,2})\s*[._ -]*[Ee]\s*0*([0-9]{1,3})",
    r"(?i)(?:episode|ep|e)\s*0*([0-9]{1,3})\b",
    r"[-–_\s]+0*([0-9]{1,3})\s*$",
    r"^\s*0*([0-9]{1,3})(?:[^0-9]|$)",
].iter().map(|pattern| Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).expect("valid filename pattern")).collect()
});

pub fn hints(name: &str, max_year: u32) -> Hints {
    let p = &*PATTERNS;
    let without_ext = p[0].replace(name, "");
    let years: Vec<_> = p[1]
        .captures_iter(&without_ext)
        .filter(|c| c[1].parse::<u32>().unwrap_or(0) <= max_year)
        .collect();
    let year = years
        .iter()
        .find(|c| c.get(0).unwrap().start() > 0)
        .or_else(|| years.first());
    let mut title = if let Some(capture) = year.filter(|c| c.get(0).unwrap().start() > 0) {
        p[2].replace(&without_ext[..capture.get(0).unwrap().start()], " ")
            .into_owned()
    } else {
        without_ext.to_string()
    };
    for index in [3, 4, 5, 6, 1, 7, 8, 9, 10] {
        title = p[index]
            .replace_all(&title, if [7, 8, 9].contains(&index) { "" } else { " " })
            .into_owned();
    }
    title = title.trim().to_string();
    if title.is_empty() {
        title = without_ext.trim().to_string();
    }
    if title.is_empty() {
        title = name.to_string();
    }
    let episode_name = p[11].replace(name, "");
    let explicit = p[12].captures(&episode_name);
    let (season, episode) = if let Some(capture) = explicit {
        (capture[1].parse().ok(), capture[2].parse().ok())
    } else {
        (
            None,
            [13, 14, 15].iter().find_map(|index| {
                p[*index]
                    .captures(&episode_name)
                    .and_then(|c| c[1].parse().ok())
            }),
        )
    };
    Hints {
        title,
        year: year.map(|c| c[1].parse().unwrap_or(0)).unwrap_or(0),
        season,
        episode,
        subtitle_keys: subtitle_keys(name),
    }
}

fn subtitle_keys(name: &str) -> Option<Vec<String>> {
    let (stem, extension) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    if !["srt", "vtt", "ass", "ssa"].contains(&extension.to_lowercase().as_str()) {
        return None;
    }
    let stem = stem.to_lowercase();
    let mut keys = vec![stem.clone()];
    for (index, character) in stem.char_indices() {
        if index > 0 && ['.', ' ', '_', '-', '[', '('].contains(&character) {
            keys.push(stem[..index].to_owned());
        }
    }
    Some(keys)
}
