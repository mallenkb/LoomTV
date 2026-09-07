//! Explicit offline transfer tool. No Tauri, renderer, credentials or media access.
use loomtv_core::{storage, Error, Result};
use std::path::PathBuf;

fn run() -> Result<serde_json::Value> {
    let mut args = std::env::args_os().skip(1);
    let operation = args.next().ok_or_else(usage)?;
    let mut source = None;
    let mut target = None;
    let mut confirmed = false;
    while let Some(flag) = args.next() {
        match flag.to_str() {
            Some("--from") if source.is_none() => {
                source = Some(PathBuf::from(args.next().ok_or_else(usage)?))
            }
            Some("--to") if target.is_none() => {
                target = Some(PathBuf::from(args.next().ok_or_else(usage)?))
            }
            Some("--confirm") if !confirmed => {
                confirmed = args.next().is_some_and(|value| value == "IMPORT")
            }
            _ => return Err(usage()),
        }
    }
    let source = source.ok_or_else(usage)?;
    match operation.to_str() {
        Some("inspect") if target.is_none() && !confirmed => storage::inspect_snapshot(&source),
        Some("import") if confirmed => {
            storage::import_snapshot(&source, &target.ok_or_else(usage)?)
        }
        _ => Err(usage()),
    }
}

fn usage() -> Error {
    Error::new("usage", "Use: loomtv-storage inspect --from /closed/backup.sqlite OR loomtv-storage import --from /closed/backup.sqlite --to /new/tauri-directory --confirm IMPORT. Remote sessions and protected add-on credentials require reauthentication; external caches are not copied.")
}

fn main() {
    match run() {
        Ok(report) => println!("{report}"),
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            std::process::exit(1);
        }
    }
}
