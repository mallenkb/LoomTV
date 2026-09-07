use crate::{Error, Result};
use regex::Regex;
use std::sync::OnceLock;

pub const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_REFERENCES: usize = 20_000;

/// Rewrite media lines and URI attributes, including keys, maps, renditions and parts.
/// The caller authorizes and signs each resolved reference before returning a URL.
pub fn rewrite(playlist: &str, resolve: &mut impl FnMut(&str) -> Result<String>) -> Result<String> {
    if playlist.len() > MAX_PLAYLIST_BYTES
        || !playlist
            .trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with("#EXTM3U")
    {
        return Err(Error::new(
            "invalid_playlist",
            "The HLS playlist is invalid or too large.",
        ));
    }
    static ATTRIBUTES: OnceLock<Regex> = OnceLock::new();
    let attributes = ATTRIBUTES.get_or_init(|| {
        Regex::new(r#"\bURI=(?:"([^"]*)"|([^,\s]+))"#).expect("fixed HLS URI pattern")
    });
    let mut output = String::with_capacity(playlist.len());
    let mut references = 0usize;
    let mut resolve = |reference: &str| -> Result<String> {
        references += 1;
        if references > MAX_REFERENCES || reference.is_empty() || reference.len() > 16_384 {
            return Err(Error::new(
                "playlist_limit",
                "The HLS playlist contains too many or invalid resources.",
            ));
        }
        resolve(reference)
    };
    for line in playlist.lines() {
        let trimmed = line.trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            output.push('\n');
            continue;
        }
        if !trimmed.starts_with('#') {
            output.push_str(&resolve(trimmed)?);
        } else {
            let mut end = 0;
            for capture in attributes.captures_iter(line) {
                let matched = capture.get(0).expect("complete URI match");
                let reference = capture
                    .get(1)
                    .or_else(|| capture.get(2))
                    .expect("URI alternative");
                output.push_str(&line[end..matched.start()]);
                output.push_str("URI=\"");
                output.push_str(&resolve(reference.as_str())?);
                output.push('"');
                end = matched.end();
            }
            output.push_str(&line[end..]);
        }
        output.push('\n');
        if output.len() > 32 * 1024 * 1024 {
            return Err(Error::new(
                "playlist_limit",
                "The rewritten HLS playlist is too large.",
            ));
        }
    }
    Ok(output)
}

pub fn is_playlist(path: &str, content_type: Option<&str>) -> bool {
    path.split('?')
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase()
        .ends_with(".m3u8")
        || content_type.is_some_and(|value| {
            matches!(
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "application/vnd.apple.mpegurl"
                    | "application/x-mpegurl"
                    | "audio/mpegurl"
                    | "audio/x-mpegurl"
            )
        })
}
