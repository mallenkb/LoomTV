use crate::{storage, Store};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("loomtv-storage-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("TEST-OWNED"), b"synthetic snapshot fixture").unwrap();
        Self(root)
    }
    fn snapshot(&self) -> PathBuf {
        let mut store = Store::open(&self.0.join("source-store")).unwrap();
        let owner: String = store
            .db
            .query_row(
                "SELECT id FROM profiles WHERE profile_type='owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        store.select_profile(&owner, None).unwrap();
        store.db.execute("INSERT INTO app_settings VALUES(1,?,1)", [json!({"tmdbApiKey":"synthetic-fixture-only","localNetworkSharingEnabled":true,"localNetworkShareToken":"111111"}).to_string()]).unwrap();
        store.db.execute("INSERT INTO custom_artwork VALUES('test-media','poster','data:image/png;base64,AA==',1)", []).unwrap();
        storage::backup(&store.db, &self.0.join("backups")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.0.join("TEST-OWNED").is_file() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn storage_rejects_electron_overlap_before_creating_paths() {
    let fixture = Fixture::new();
    let electron = fixture.0.join("LoomTV");
    let separate = fixture.0.join("com.mallenkb.loomtv.tauri");
    assert_eq!(
        storage::isolated_data_dir(&separate, None, &electron).unwrap(),
        separate
    );
    for path in [&electron, &electron.join("child"), &fixture.0] {
        assert_eq!(
            storage::isolated_data_dir(path, None, &electron)
                .unwrap_err()
                .code,
            "storage_collision"
        );
    }
    assert!(!electron.exists());
}

#[test]
fn storage_rejects_unowned_databases_without_writing() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let target = fixture.0.join("unowned");
    fs::create_dir(&target).unwrap();
    fs::copy(&snapshot, target.join("loomtv.sqlite")).unwrap();
    let before = fs::read(target.join("loomtv.sqlite")).unwrap();
    assert_eq!(
        Store::open(&target).err().unwrap().code,
        "storage_not_owned"
    );
    assert_eq!(fs::read(target.join("loomtv.sqlite")).unwrap(), before);
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
}

#[test]
fn storage_lease_prevents_second_writer_and_releases_on_close() {
    let fixture = Fixture::new();
    let target = fixture.0.join("tauri");
    let first = Store::open(&target).unwrap();
    assert_eq!(Store::open(&target).err().unwrap().code, "storage_in_use");
    drop(first);
    assert!(Store::open(&target).is_ok());
}

#[test]
fn snapshot_import_preserves_data_and_source_but_not_device_sessions() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let before = fs::read(&snapshot).unwrap();
    let target = fixture.0.join("imported");
    let report = storage::import_snapshot(&snapshot, &target).unwrap();
    assert_eq!(report["profiles"], 1);
    assert_eq!(fs::read(&snapshot).unwrap(), before);
    let mut store = Store::open(&target).unwrap();
    assert!(store.active.is_none());
    let owner: String = store
        .db
        .query_row(
            "SELECT id FROM profiles WHERE profile_type='owner'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    store.select_profile(&owner, None).unwrap();
    assert_eq!(
        store.settings().unwrap()["tmdbApiKey"],
        "synthetic-fixture-only"
    );
    assert_eq!(
        store.settings().unwrap()["localNetworkSharingEnabled"],
        false
    );
    assert!(store
        .settings()
        .unwrap()
        .get("localNetworkShareToken")
        .is_none());
    let art: String = store
        .db
        .query_row(
            "SELECT data_url FROM custom_artwork WHERE media_id='test-media'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(art, "data:image/png;base64,AA==");
    let backup = store.invoke("database:backup", &[]).unwrap();
    assert_eq!(
        storage::inspect_snapshot(std::path::Path::new(backup["path"].as_str().unwrap())).unwrap()
            ["profiles"],
        1
    );
    assert_eq!(
        storage::import_snapshot(&snapshot, &target)
            .unwrap_err()
            .code,
        "import_target_exists"
    );
}

#[test]
fn snapshot_rejects_live_damaged_and_future_databases() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let wal = PathBuf::from(format!("{}-wal", snapshot.to_str().unwrap()));
    fs::write(&wal, b"journal fixture").unwrap();
    assert_eq!(
        storage::inspect_snapshot(&snapshot).unwrap_err().code,
        "snapshot_live"
    );
    fs::remove_file(wal).unwrap();
    let db = Connection::open(&snapshot).unwrap();
    db.execute("INSERT INTO schema_migrations VALUES(15,1)", [])
        .unwrap();
    drop(db);
    assert_eq!(
        storage::inspect_snapshot(&snapshot).unwrap_err().code,
        "schema_version"
    );
    fs::write(&snapshot, b"not a SQLite database").unwrap();
    assert!(storage::import_snapshot(&snapshot, &fixture.0.join("refused")).is_err());
    assert!(!fixture.0.join("refused").exists());
}

#[test]
fn snapshot_rejects_executable_schema() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let db = Connection::open(&snapshot).unwrap();
    db.execute_batch("CREATE TRIGGER unexpected AFTER DELETE ON device_profile_selections BEGIN DELETE FROM profiles; END;").unwrap();
    drop(db);
    assert_eq!(
        storage::inspect_snapshot(&snapshot).unwrap_err().code,
        "invalid_snapshot"
    );
}

#[test]
fn future_store_rejected_before_journal_mode_change() {
    let fixture = Fixture::new();
    let target = fixture.0.join("tauri");
    let store = Store::open(&target).unwrap();
    store
        .db
        .execute("INSERT INTO schema_migrations VALUES(15,1)", [])
        .unwrap();
    drop(store);
    let before = fs::read(target.join("loomtv.sqlite")).unwrap();
    assert_eq!(Store::open(&target).err().unwrap().code, "schema_version");
    assert_eq!(fs::read(target.join("loomtv.sqlite")).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn storage_rejects_aliases_and_creates_private_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let electron = fixture.0.join("LoomTV");
    fs::create_dir(&electron).unwrap();
    let alias = fixture.0.join("alias");
    symlink(&electron, &alias).unwrap();
    assert_eq!(
        storage::isolated_data_dir(&alias, None, &electron)
            .unwrap_err()
            .code,
        "storage_collision"
    );
    let snapshot = fixture.snapshot();
    let linked = fixture.0.join("linked.sqlite");
    symlink(&snapshot, &linked).unwrap();
    assert_eq!(
        storage::inspect_snapshot(&linked).unwrap_err().code,
        "unsafe_storage_path"
    );
    assert_eq!(
        snapshot.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    let target = fixture.0.join("new-store");
    drop(Store::open(&target).unwrap());
    assert_eq!(
        target.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
}
