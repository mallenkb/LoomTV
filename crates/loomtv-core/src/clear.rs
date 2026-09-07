use crate::{now, Result, Store};
use rusqlite::params;
use serde_json::Value;

impl Store {
    pub fn clear_database(&mut self) -> Result<Value> {
        self.require_owner()?;
        let owner = uuid::Uuid::new_v4().to_string();
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("clear-desktop.sql"))?;
        tx.execute("INSERT INTO profiles (id,name,avatar_key,color_key,profile_type,created_at,updated_at,sort_order) VALUES (?,'Owner','glyph-01','ember','owner',?,?,0)",params![owner,now(),now()])?;
        tx.commit()?;
        self.active = None;
        self.unlocked_until = 0;
        self.failures.clear();
        self.select_profile(&owner, None)?;
        for name in ["library.json", "settings.json"] {
            let _ = std::fs::remove_file(self.data_dir.join(name));
        }
        for name in ["artwork-cache", "plugin-artwork-cache"] {
            let _ = std::fs::remove_dir_all(self.data_dir.join(name));
        }
        self.library(true)
    }
}
