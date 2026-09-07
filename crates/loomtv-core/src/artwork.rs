use crate::{now, Error, Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
fn inline_image(value: &str) -> Result<(Vec<u8>, String)> {
    if value.len() > 25 * 1024 * 1024 {
        return Err(Error::new(
            "artwork_too_large",
            "The artwork image is too large.",
        ));
    }
    let (header, body) = value
        .split_once(',')
        .ok_or_else(|| Error::new("invalid_artwork", "Choose a valid artwork image."))?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .filter(|v| {
            [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "image/avif",
            ]
            .contains(v)
        })
        .ok_or_else(|| {
            Error::new(
                "invalid_artwork",
                "Choose a PNG, JPEG, WebP, GIF, or AVIF image.",
            )
        })?;
    let bytes = STANDARD
        .decode(body)
        .map_err(|_| Error::new("invalid_artwork", "The artwork image is invalid."))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::new(
            "artwork_too_large",
            "The artwork image is too large.",
        ));
    }
    Ok((bytes, mime.into()))
}
impl Store {
    pub fn custom_artwork_resource(
        &self,
        media: &str,
        target: &str,
        profile: &str,
        revision: i64,
    ) -> Result<(Vec<u8>, String)> {
        self.require_active(Some(profile))?;
        if self.revision != revision || !self.can_access_item(media)? {
            return Err(Error::new(
                "artwork_restricted",
                "This artwork is unavailable for the selected profile.",
            ));
        }
        let value:Option<String>=self.db.query_row("SELECT data_url FROM custom_artwork WHERE media_id=? AND target=? AND length(data_url)<=?",params![media,target,25*1024*1024],|row|row.get(0)).optional()?;
        let value = value
            .ok_or_else(|| Error::new("artwork_missing", "The saved artwork is unavailable."))?;
        inline_image(&value)
    }
    pub fn custom_artwork(&self, media: &str) -> Result<Value> {
        let profile = self.require_active(None)?;
        if !self.can_access_item(media)? {
            return Err(Error::new(
                "artwork_restricted",
                "This artwork is unavailable for the selected profile.",
            ));
        }
        let mut statement = self
            .db
            .prepare("SELECT target,data_url,updated_at FROM custom_artwork WHERE media_id=?")?;
        let rows = statement.query_map([media], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut values = json!({});
        for row in rows {
            let (target, value, version) = row?;
            if let Ok(url) = url::Url::parse(&value) {
                if url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
                {
                    values[&target] = json!(value);
                    continue;
                }
            }
            let mut url = url::Url::parse("loomtv://localhost/api/custom-artwork")
                .map_err(|_| Error::new("artwork_url", "The artwork URL could not be created."))?;
            url.query_pairs_mut()
                .append_pair("mediaId", media)
                .append_pair("target", &target)
                .append_pair("profile", &profile)
                .append_pair("revision", &self.revision.to_string())
                .append_pair("v", &version.to_string());
            values[&target] = json!(url.to_string());
        }
        Ok(values)
    }
    pub fn save_custom_artwork(&mut self, media: &str, target: &str, value: &str) -> Result<Value> {
        self.require_owner()?;
        if !self.can_access_item(media)? {
            return Err(Error::new(
                "artwork_missing",
                "This media item is unavailable.",
            ));
        }
        if target.is_empty() || target.len() > 128 || target.chars().any(char::is_control) {
            return Err(Error::new(
                "invalid_artwork_target",
                "Choose a valid artwork target.",
            ));
        }
        if !value.is_empty() {
            let external = url::Url::parse(value).ok().is_some_and(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            });
            if !external {
                inline_image(value)?;
            }
            self.db.execute(
                "INSERT OR REPLACE INTO custom_artwork VALUES (?,?,?,?)",
                params![media, target, value, now()],
            )?;
        } else {
            self.db.execute(
                "DELETE FROM custom_artwork WHERE media_id=? AND target=?",
                params![media, target],
            )?;
        }
        self.custom_artwork(media)
    }
}
