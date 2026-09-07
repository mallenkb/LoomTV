use crate::{now, Error, Result, Store};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

impl Store {
    pub fn restrictions(&self, id: &str) -> Result<Value> {
        let mut value=self.db.query_row("SELECT country,maximum_age,allow_unrated,revision FROM profile_restrictions WHERE profile_id=?",[id],|row|Ok(json!({"country":row.get::<_,String>(0)?,"maximumAge":row.get::<_,Option<i64>>(1)?,"allowUnrated":row.get::<_,bool>(2)?,"revision":row.get::<_,i64>(3)?}))).optional()?.unwrap_or(json!({"country":"US","maximumAge":null,"allowUnrated":false,"revision":0}));
        let mut statement=self.db.prepare("SELECT folder_path FROM profile_library_access WHERE profile_id=? ORDER BY folder_path")?;
        value["allowedFolders"] = json!(statement
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?);
        Ok(value)
    }
    pub fn save_restrictions(&mut self, id: &str, input: &Value) -> Result<Value> {
        self.require_owner()?;
        let kind: String = self.db.query_row(
            "SELECT profile_type FROM profiles WHERE id=?",
            [id],
            |row| row.get(0),
        )?;
        let country = input["country"]
            .as_str()
            .filter(|c| ["US", "GB", "CA", "AU"].contains(c))
            .ok_or_else(|| Error::new("invalid_country", "Choose a supported ratings country."))?;
        let age = if input["maximumAge"].is_null() {
            None
        } else {
            Some(
                input["maximumAge"]
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| Error::new("invalid_age", "Choose a valid maximum age."))?
                    .round()
                    .clamp(0., 18.) as i64,
            )
        };
        if kind == "kid" && age.is_none() {
            return Err(Error::new(
                "invalid_age",
                "Choose a maximum age for a child profile.",
            ));
        }
        let unrated = input["allowUnrated"].as_bool().ok_or_else(|| {
            Error::new(
                "invalid_restrictions",
                "Choose whether unrated content is allowed.",
            )
        })?;
        let folders = input["allowedFolders"]
            .as_array()
            .filter(|folders| folders.len() <= 256)
            .ok_or_else(|| Error::new("invalid_folders", "Choose valid library folders."))?;
        let mut allowed = Vec::new();
        for folder in folders {
            let folder = folder
                .as_str()
                .ok_or_else(|| Error::new("invalid_folders", "Choose valid library folders."))?;
            let exists: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_folders WHERE path=?)",
                [folder],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(Error::new(
                    "invalid_folders",
                    "Folder access must use a current library root.",
                ));
            }
            if !allowed.contains(&folder) {
                allowed.push(folder);
            }
        }
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO profile_restrictions (profile_id,country,maximum_age,allow_unrated,revision,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(profile_id) DO UPDATE SET country=excluded.country,maximum_age=excluded.maximum_age,allow_unrated=excluded.allow_unrated,revision=profile_restrictions.revision+1,updated_at=excluded.updated_at",params![id,country,age,unrated,now()])?;
        tx.execute(
            "DELETE FROM profile_library_access WHERE profile_id=?",
            [id],
        )?;
        for folder in allowed {
            tx.execute(
                "INSERT INTO profile_library_access (profile_id,folder_path) VALUES (?,?)",
                params![id, folder],
            )?;
        }
        tx.commit()?;
        self.bump_selection()?;
        self.restrictions(id)
    }
    pub(crate) fn can_access_item(&self, id: &str) -> Result<bool> {
        let active = self.require_active(None)?;
        let child: bool = self.db.query_row(
            "SELECT profile_type='kid' FROM profiles WHERE id=?",
            [active.as_str()],
            |row| row.get(0),
        )?;
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT file_path,content_ratings_json FROM media_items WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((path, ratings)) = row else {
            return Ok(false);
        };
        let mut roots = self.db.prepare("SELECT path FROM library_folders")?;
        let rooted = roots
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .any(|root| Path::new(&path).starts_with(root));
        if !rooted {
            return Ok(false);
        }
        if !child {
            return Ok(true);
        }
        let restrictions = self.restrictions(&active)?;
        let Some(maximum) = restrictions["maximumAge"].as_i64() else {
            return Ok(false);
        };
        let folders = restrictions["allowedFolders"].as_array().ok_or_else(|| {
            Error::new(
                "invalid_restrictions",
                "The profile restrictions are invalid.",
            )
        })?;
        if !folders.is_empty()
            && !folders
                .iter()
                .filter_map(Value::as_str)
                .any(|root| Path::new(&path).starts_with(root))
        {
            return Ok(false);
        }
        let ratings: Value = serde_json::from_str(&ratings)?;
        let country = restrictions["country"].as_str().unwrap_or("US");
        Ok(
            match crate::content_ratings::stored_minimum_age(country, &ratings[country]) {
                Some(age) => age <= maximum,
                None => restrictions["allowUnrated"] == true,
            },
        )
    }
    pub fn authorize_subtitle(&self, media: &str, subtitle: &str) -> Result<()> {
        self.authorize_media(media)?;
        self.authorize_media(subtitle)?;
        let mut statement=self.db.prepare("SELECT subtitles_json FROM episode_files WHERE file_path=?1 UNION ALL SELECT subtitles_json FROM media_items WHERE file_path=?1 AND NOT EXISTS(SELECT 1 FROM episode_files WHERE media_id=media_items.id)")?;
        let rows = statement.query_map([media], |row| row.get::<_, String>(0))?;
        for row in rows {
            let rows: Value = serde_json::from_str(&row?)?;
            if rows.as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    row["url"].as_str().is_some_and(|value| {
                        url::Url::parse("http://localhost")
                            .ok()
                            .and_then(|base| base.join(value).ok())
                            .is_some_and(|url| {
                                url.query_pairs()
                                    .any(|(key, value)| key == "path" && value == subtitle)
                            })
                    })
                })
            }) {
                return Ok(());
            }
        }
        Err(Error::new(
            "subtitle_restricted",
            "This subtitle is unavailable for the selected media.",
        ))
    }
    pub(crate) fn subtitle_delivery(&self, subtitles: &mut Value) -> Result<()> {
        let profile = self.require_active(None)?;
        if let Some(rows) = subtitles.as_array_mut() {
            for subtitle in rows {
                let Some(source) = subtitle["url"].as_str() else {
                    continue;
                };
                let Some(mut url) = url::Url::parse("loomtv://localhost")
                    .ok()
                    .and_then(|base| base.join(source).ok())
                else {
                    continue;
                };
                if url.host_str() != Some("localhost") || url.path() != "/subtitle" {
                    continue;
                }
                url.query_pairs_mut()
                    .append_pair("profile", &profile)
                    .append_pair("revision", &self.revision.to_string());
                subtitle["url"] = json!(url.to_string());
            }
        }
        Ok(())
    }
    pub(crate) fn authorize_content_path(&self, source: &str) -> Result<()> {
        let mut stmt=self.db.prepare("SELECT id,file_path,subtitles_json FROM media_items UNION ALL SELECT media_id,file_path,subtitles_json FROM episode_files")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, path, subtitles) = row?;
            let matches = Path::new(source) == Path::new(&path) || {
                let subtitles: Value = serde_json::from_str(&subtitles)?;
                subtitles.as_array().is_some_and(|rows| {
                    rows.iter().any(|subtitle| {
                        let Some(value) = subtitle["url"].as_str() else {
                            return false;
                        };
                        if value == source {
                            return true;
                        }
                        url::Url::parse("http://localhost")
                            .ok()
                            .and_then(|base| base.join(value).ok())
                            .is_some_and(|url| {
                                url.path() == "/subtitle"
                                    && url
                                        .query_pairs()
                                        .any(|(key, value)| key == "path" && value == source)
                            })
                    })
                })
            };
            if matches && self.can_access_item(&id)? {
                return Ok(());
            }
        }
        Err(Error::new(
            "content_restricted",
            "This content is unavailable for the selected profile.",
        ))
    }
}
