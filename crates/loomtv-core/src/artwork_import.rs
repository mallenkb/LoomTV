use crate::{now, Error, Result, Store};
use rusqlite::params;
use serde_json::{json, Value};

const MAX_IMPORT_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS: usize = 10_000;

struct ImportedArtwork<'a> {
    media_id: &'a str,
    target: &'a str,
    data_url: &'a str,
}

impl Store {
    /// Import the renderer's legacy `{ mediaId: { target: dataUrl } }` map.
    pub fn import_custom_artwork(&mut self, args: &[Value]) -> Result<Value> {
        self.require_owner()?;
        if args.len() != 1 {
            return Err(invalid("Artwork import expects one entries object."));
        }
        let entries = args[0]
            .as_object()
            .ok_or_else(|| invalid("Imported artwork must be an object."))?;
        if serde_json::to_vec(entries)?.len() > MAX_IMPORT_BYTES {
            return Err(Error::new(
                "payload_too_large",
                "The artwork import is too large.",
            ));
        }

        let mut rows = Vec::new();
        let mut supplied_rows = 0usize;
        for (media_id, targets) in entries {
            let targets = targets.as_object().ok_or_else(|| {
                invalid("Each imported media entry must contain an artwork object.")
            })?;
            supplied_rows = supplied_rows
                .checked_add(targets.len())
                .ok_or_else(import_limit)?;
            if supplied_rows > MAX_IMPORT_ROWS {
                return Err(import_limit());
            }
            for (target, data_url) in targets {
                let data_url = data_url
                    .as_str()
                    .ok_or_else(|| invalid("Each imported artwork value must be a string."))?;
                if !data_url.is_empty() {
                    rows.push(ImportedArtwork {
                        media_id,
                        target,
                        data_url,
                    });
                }
            }
        }

        let transaction = self.db.transaction()?;
        {
            let mut upsert = transaction.prepare_cached(
                "INSERT OR REPLACE INTO custom_artwork \
                 (media_id,target,data_url,updated_at) VALUES (?,?,?,?)",
            )?;
            for row in rows {
                upsert.execute(params![row.media_id, row.target, row.data_url, now()])?;
            }
        }
        transaction.commit()?;
        Ok(json!(true))
    }
}

fn invalid(message: &str) -> Error {
    Error::new("invalid_artwork_import", message)
}

fn import_limit() -> Error {
    Error::new(
        "payload_too_large",
        "The artwork import contains too many entries.",
    )
}
