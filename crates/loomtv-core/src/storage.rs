//! Shared desktop storage, isolated ownership, and offline snapshot transfer.
//! Shared access validates the Electron schema before opening it for writes.
use crate::{Error, Result};
use rusqlite::{backup::StepResult, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const MARKER: &str = ".loomtv-tauri-storage-v1";
const IDENTITY: &[u8] = b"com.mallenkb.loomtv.tauri\nstorage=1\n";
const LEGACY_MARKER: &str = "tauri-storage-v1";
const LEGACY_IDENTITY: &[u8] = b"LoomTV Tauri storage version 1\n";
const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The file remains open until the SQLite connection and its users are dropped.
/// Never unlink this lock file: doing so would let another process lock a new inode.
pub(crate) struct StorageLease {
    _file: File,
}

pub fn isolated_data_dir(
    default: &Path,
    selected: Option<&str>,
    electron: &Path,
) -> Result<PathBuf> {
    let target = selected
        .filter(|value| !value.trim().is_empty())
        .map_or_else(
            || default.to_path_buf(),
            |value| PathBuf::from(value.trim()),
        );
    let target = resolve_path(&target)?;
    let electron = resolve_path(electron)?;
    if paths_overlap(&target, &electron) {
        return Err(Error::new(
            "storage_collision",
            "Tauri storage must be separate from Electron. Import a closed backup into a new Tauri directory.",
        ));
    }
    Ok(target)
}

fn resolve_path(path: &Path) -> Result<PathBuf> {
    if path.components().any(|part| part == Component::ParentDir) {
        return Err(Error::new(
            "invalid_data_directory",
            "Use a path without parent-directory components.",
        ));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut tail = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut resolved = ancestor.canonicalize()?;
                for component in tail.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| {
                            Error::new(
                                "invalid_data_directory",
                                "The directory cannot be resolved.",
                            )
                        })?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().ok_or_else(|| {
                    Error::new(
                        "invalid_data_directory",
                        "The directory cannot be resolved.",
                    )
                })?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn paths_overlap(a: &Path, b: &Path) -> bool {
    // Windows filesystem paths are normally case-insensitive. Canonicalization
    // alone does not normalize the spelling of nonexistent path components.
    #[cfg(windows)]
    {
        let a = PathBuf::from(a.to_string_lossy().to_lowercase());
        let b = PathBuf::from(b.to_string_lossy().to_lowercase());
        a.starts_with(&b) || b.starts_with(&a)
    }
    #[cfg(not(windows))]
    {
        a.starts_with(b) || b.starts_with(a)
    }
}

pub(crate) fn regular_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(Error::new(
            "unsafe_storage_path",
            "Storage files must be regular files, not links or devices.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(Error::new(
                "unsafe_storage_path",
                "A storage file must not be shared through a hard link.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(Error::new(
            "unsafe_storage_path",
            "A storage directory cannot be a symbolic link.",
        ));
    }
    Ok(())
}

pub(crate) fn create_private(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

impl StorageLease {
    pub(crate) fn acquire(directory: &Path) -> Result<Self> {
        Self::acquire_mode(directory, false)
    }

    pub(crate) fn acquire_shared(directory: &Path) -> Result<Self> {
        Self::acquire_mode(directory, true)
    }

    fn acquire_mode(directory: &Path, shared: bool) -> Result<Self> {
        let database = directory.join("loomtv.sqlite");
        let marker = directory.join(MARKER);
        let legacy_marker = directory.join(LEGACY_MARKER);
        let legacy_owned = if !marker.exists() && legacy_marker.exists() {
            regular_file(&legacy_marker)?;
            let mut value = Vec::new();
            File::open(&legacy_marker)?.take(128).read_to_end(&mut value)?;
            value == LEGACY_IDENTITY
        } else {
            false
        };
        // Check before creating a lock or changing permissions in an existing store.
        if fs::symlink_metadata(&database).is_ok() && !marker.is_file() && !legacy_owned && !shared {
            return Err(Error::new("storage_not_owned", "This database is not Tauri-owned. Import a closed backup into a new directory instead."));
        }
        private_directory(directory)?;
        if marker.exists() {
            regular_file(&marker)?;
            let mut value = Vec::new();
            File::open(&marker)?.take(128).read_to_end(&mut value)?;
            if value != IDENTITY {
                return Err(Error::new(
                    "storage_not_owned",
                    "The storage owner or version does not match this app.",
                ));
            }
        }
        let path = directory.join(".loomtv-tauri.lock");
        let file = match create_private(&path) {
            Ok(file) => file,
            Err(_) => {
                regular_file(&path)?;
                OpenOptions::new().read(true).write(true).open(&path)?
            }
        };
        regular_file(&path)?;
        file.try_lock().map_err(|_| Error::new("storage_in_use", "Another Tauri process is using this directory. Close it before importing or launching again."))?;
        if !marker.exists() && database.exists() && !legacy_owned && !shared {
            return Err(Error::new(
                "storage_not_owned",
                "Import the existing database into a new Tauri directory.",
            ));
        }
        if shared {
            if database.exists() {
                let source = connection(&database, true)?;
                validate_snapshot(&source)?;
            }
        } else if !marker.exists() {
            if legacy_owned && database.exists() {
                // Earlier Tauri builds used a different ownership marker.
                // Keep their data and caches, and preserve a consistent SQLite
                // backup including any committed WAL pages before upgrading.
                let source = connection(&database, true)?;
                source.execute_batch("BEGIN")?;
                validate_snapshot(&source)?;
                backup(&source, &directory.join("backups"))?;
            }
            let mut marker = create_private(&marker)?;
            marker.write_all(IDENTITY)?;
            marker.sync_all()?;
        }
        Ok(Self { _file: file })
    }
}

pub(crate) fn connection(path: &Path, readonly: bool) -> Result<Connection> {
    regular_file(path)?;
    let flags = if readonly {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let connection = Connection::open_with_flags(
        path,
        flags | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(3))?;
    connection.pragma_update(None, "trusted_schema", false)?;
    Ok(connection)
}

pub(crate) fn validate_version(db: &Connection) -> Result<()> {
    let version: i64 = db.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if version != 14 {
        return Err(Error::new(
            "schema_version",
            "Only desktop schema version 14 is supported. No migration was applied.",
        ));
    }
    Ok(())
}

fn validate_snapshot(db: &Connection) -> Result<()> {
    validate_version(db)?;
    let bytes: u64 = db.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |row| row.get(0),
    )?;
    if bytes > MAX_SNAPSHOT_BYTES {
        return Err(Error::new(
            "snapshot_too_large",
            "The snapshot exceeds the 2 GiB import limit.",
        ));
    }
    let integrity: String = db.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    let foreign_keys: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |row| row.get(0),
    )?;
    let executable_schema: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view'))",
        [],
        |row| row.get(0),
    )?;
    if integrity != "ok" || foreign_keys || executable_schema {
        return Err(Error::new(
            "invalid_snapshot",
            "The snapshot failed integrity, foreign-key or schema safety checks.",
        ));
    }
    // Migration histories can produce different column orders. Compare by name.
    // Electron removes the old unscoped playback tables after profile migration.
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("desktop-schema.sql"))?;
    let tables = expected
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for table in tables {
        let columns = |database: &Connection| -> Result<Vec<(String, String, bool, i64)>> {
            Ok(database
                .prepare("SELECT name,type,\"notnull\",pk FROM pragma_table_info(?) ORDER BY name")?
                .query_map([&table], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        };
        let actual = columns(db)?;
        if actual.is_empty()
            && matches!(table.as_str(), "playback_progress_legacy" | "playback_track_preferences_legacy")
        {
            continue;
        }
        if actual != columns(&expected)? {
            return Err(Error::new(
                "invalid_snapshot_schema",
                format!("Desktop table '{table}' does not match the supported schema."),
            ));
        }
    }
    Ok(())
}

fn open_snapshot(path: &Path) -> Result<Connection> {
    regular_file(path)?;
    if path.metadata()?.len() > MAX_SNAPSHOT_BYTES {
        return Err(Error::new(
            "snapshot_too_large",
            "The snapshot exceeds the 2 GiB import limit.",
        ));
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        if fs::symlink_metadata(PathBuf::from(sidecar)).is_ok() {
            return Err(Error::new(
                "snapshot_live",
                "Choose a closed SQLite backup, not a live database with journal files.",
            ));
        }
    }
    let source = connection(path, true)?;
    source.execute_batch("BEGIN")?;
    validate_snapshot(&source)?;
    Ok(source)
}

pub fn inspect_snapshot(source: &Path) -> Result<Value> {
    let db = open_snapshot(source)?;
    let profiles: i64 = db.query_row(
        "SELECT COUNT(*) FROM profiles WHERE is_guest=0",
        [],
        |row| row.get(0),
    )?;
    let items: i64 = db.query_row("SELECT COUNT(*) FROM media_items", [], |row| row.get(0))?;
    Ok(
        json!({"schemaVersion":14,"profiles":profiles,"mediaItems":items,"sourceUnchanged":true,"reauthenticationRequired":["remote-session","encrypted-add-on-credentials"],"externalCachesCopied":false}),
    )
}

fn copy_database(source: &Connection, target: &mut Connection) -> Result<()> {
    let backup = rusqlite::backup::Backup::new(source, target)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if Instant::now() >= deadline {
            return Err(Error::new(
                "snapshot_timeout",
                "The SQLite snapshot did not finish within the import deadline.",
            ));
        }
        match backup.step(128)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// Import into a NEW Tauri store. Existing stores are never overwritten or merged.
/// The caller must obtain explicit user consent; the CLI requires `--confirm IMPORT`.
pub fn import_snapshot(source: &Path, directory: &Path) -> Result<Value> {
    let report = inspect_snapshot(source)?;
    let source = open_snapshot(source)?;
    if directory.join("loomtv.sqlite").exists() {
        return Err(Error::new(
            "import_target_exists",
            "Import requires a new target directory. Existing data was not replaced.",
        ));
    }
    let _lease = StorageLease::acquire(directory)?;
    let destination = directory.join("loomtv.sqlite");
    if destination.exists() {
        return Err(Error::new(
            "import_target_exists",
            "The target database already exists.",
        ));
    }
    let stage = directory.join(format!(".import-{}.sqlite", uuid::Uuid::new_v4()));
    let stage_file = create_private(&stage)?;
    let imported = (|| -> Result<()> {
        let mut target = connection(&stage, false)?;
        copy_database(&source, &mut target)?;
        target.pragma_update(None, "journal_mode", "DELETE")?;
        target.pragma_update(None, "foreign_keys", true)?;
        let transaction = target.transaction()?;
        transaction.execute_batch("DELETE FROM device_profile_selections; DELETE FROM device_profile_selection_revisions; DELETE FROM profiles WHERE is_guest=1;")?;
        // A copied pairing/device identity must never silently start a second host.
        let settings: Option<String> = transaction
            .query_row("SELECT data_json FROM app_settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if let Some(settings) = settings {
            let mut settings: Value = serde_json::from_str(&settings)?;
            let map = settings.as_object_mut().ok_or_else(|| {
                Error::new("invalid_snapshot", "Snapshot settings must be an object.")
            })?;
            for field in [
                "mpvExecutablePath",
                "localNetworkHmacSecret",
                "localNetworkPairedDevices",
                "localNetworkShareToken",
                "localNetworkAccessToken",
                "localNetworkDeviceId",
                "__secretRef",
            ] {
                map.remove(field);
            }
            map.insert("localNetworkSharingEnabled".into(), json!(false));
            transaction.execute(
                "UPDATE app_settings SET data_json=? WHERE id=1",
                [settings.to_string()],
            )?;
        }
        // External disk caches belong to the source installation. Inline custom art is durable and retained.
        transaction.execute_batch("DELETE FROM artwork_cache; DELETE FROM plugin_artwork_references; DELETE FROM plugin_artwork_objects;")?;
        transaction.commit()?;
        validate_snapshot(&target)?;
        drop(target);
        stage_file.sync_all()?;
        // A same-directory hard link publishes atomically without replacing a concurrent target.
        fs::hard_link(&stage, &destination)?;
        Ok(())
    })();
    drop(stage_file);
    let removed = fs::remove_file(&stage);
    imported?;
    removed?;
    sync_directory(directory)?;
    Ok(report)
}

pub(crate) fn backup(source: &Connection, directory: &Path) -> Result<PathBuf> {
    private_directory(directory)?;
    let path = directory.join(format!(
        "loomtv-{}-{}.sqlite",
        crate::now(),
        uuid::Uuid::new_v4()
    ));
    let file = create_private(&path)?;
    let result = (|| -> Result<()> {
        let mut target = connection(&path, false)?;
        copy_database(source, &mut target)?;
        target.pragma_update(None, "journal_mode", "DELETE")?;
        validate_snapshot(&target)?;
        drop(target);
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    sync_directory(directory)?;
    Ok(path)
}

fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

use rusqlite::OptionalExtension;
