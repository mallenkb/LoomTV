use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fs::File,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
struct Record(String, String, String);

/// Sort bounded runs in app-owned temporary storage, never in a library root.
/// Native relative-path ordering matches SQLite BINARY on the parent platform.
#[derive(Default)]
pub struct Signature {
    records: Vec<Record>,
    bytes: usize,
    count: u64,
    temporary: Option<tempfile::TempDir>,
    chunks: Vec<PathBuf>,
    record_limit: usize,
}

impl Signature {
    pub fn compact() -> Self {
        Self {
            record_limit: 2048,
            ..Self::default()
        }
    }
    pub fn add(&mut self, root: &Path, file: &Path, size: &str, mtime: &str) -> Result<(), String> {
        let relative = file
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("Unrepresentable UTF-8 path")?
            .to_owned();
        self.bytes += relative.len() + size.len() + mtime.len();
        self.records
            .push(Record(relative, size.to_owned(), mtime.to_owned()));
        self.count += 1;
        let limit = if self.record_limit == 0 {
            8192
        } else {
            self.record_limit
        };
        if self.records.len() >= limit || self.bytes >= 4 * 1024 * 1024 {
            self.spill()?;
        }
        Ok(())
    }

    fn spill(&mut self) -> Result<(), String> {
        if self.records.is_empty() {
            return Ok(());
        }
        self.records.sort_unstable();
        if self.temporary.is_none() {
            self.temporary = Some(
                tempfile::Builder::new()
                    .prefix(&format!("loom-scan-{}-", std::process::id()))
                    .tempdir()
                    .map_err(|e| e.to_string())?,
            );
        }
        let directory = self
            .temporary
            .as_ref()
            .ok_or("Missing signature staging directory")?;
        let file = directory
            .path()
            .join(format!("{}.jsonl", self.chunks.len()));
        let mut writer = BufWriter::new(File::create(&file).map_err(|e| e.to_string())?);
        for record in self.records.drain(..) {
            serde_json::to_writer(&mut writer, &record).map_err(|e| e.to_string())?;
            writer.write_all(b"\n").map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())?;
        self.chunks.push(file);
        self.bytes = 0;
        Ok(())
    }

    pub fn finish(
        &mut self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(String, u64), String> {
        if !self.chunks.is_empty() {
            self.spill()?;
        }
        let mut pass = 0;
        while self.chunks.len() > 32 {
            let directory = self
                .temporary
                .as_ref()
                .ok_or("Missing signature staging directory")?;
            let mut merged = Vec::new();
            for (index, group) in self.chunks.chunks(32).enumerate() {
                let output = directory.path().join(format!("merge-{pass}-{index}.jsonl"));
                let mut writer = BufWriter::new(File::create(&output).map_err(|e| e.to_string())?);
                merge_records(group, |record| {
                    check()?;
                    serde_json::to_writer(&mut writer, &record).map_err(|e| e.to_string())?;
                    writer.write_all(b"\n").map_err(|e| e.to_string())
                })?;
                writer.flush().map_err(|e| e.to_string())?;
                for input in group {
                    std::fs::remove_file(input).map_err(|e| e.to_string())?;
                }
                merged.push(output);
            }
            self.chunks = merged;
            pass += 1;
        }
        let mut hash = Sha256::new();
        let mut append = |record: Record| -> Result<(), String> {
            check()?;
            let relative = if cfg!(windows) {
                record.0.replace('\\', "/")
            } else {
                record.0
            };
            hash.update(
                serde_json::to_vec(&(relative, record.1, record.2)).map_err(|e| e.to_string())?,
            );
            hash.update(b"\n");
            Ok(())
        };
        if self.chunks.is_empty() {
            self.records.sort_unstable();
            for record in self.records.drain(..) {
                append(record)?;
            }
        } else {
            merge_records(&self.chunks, append)?;
        }
        Ok((
            format!("inventory-v1:{}:{:x}", self.count, hash.finalize()),
            self.count,
        ))
    }
}

fn merge_records(
    paths: &[PathBuf],
    mut append: impl FnMut(Record) -> Result<(), String>,
) -> Result<(), String> {
    let mut readers = paths
        .iter()
        .map(|file| {
            File::open(file)
                .map(BufReader::new)
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut pending = BinaryHeap::new();
    for (index, reader) in readers.iter_mut().enumerate() {
        if let Some(record) = read_record(reader)? {
            pending.push(Reverse((record, index)));
        }
    }
    while let Some(Reverse((record, index))) = pending.pop() {
        append(record)?;
        if let Some(next) = read_record(&mut readers[index])? {
            pending.push(Reverse((next, index)));
        }
    }
    Ok(())
}

fn read_record(reader: &mut BufReader<File>) -> Result<Option<Record>, String> {
    let mut line = String::new();
    if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
        return Ok(None);
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_merge_matches_direct_utf8_ordering() {
        let root = std::env::temp_dir().join("signature-fixture");
        let mut signature = Signature::default();
        let mut expected = Vec::new();
        for index in (0..350).rev() {
            let name = format!("folder-{index:04}/日本語-\u{e000}-\u{10000}.mp4");
            let file = root.join(&name);
            signature
                .add(&root, &file, "9007199254740993", "-1500")
                .unwrap();
            expected.push(name);
            // More than 32 runs exercise the bounded multi-pass merge.
            if index % 3 == 0 {
                signature.spill().unwrap();
            }
        }
        expected.sort();
        let mut hash = Sha256::new();
        for name in expected {
            hash.update(serde_json::to_vec(&(name, "9007199254740993", "-1500")).unwrap());
            hash.update(b"\n");
        }
        assert_eq!(
            signature.finish(|| Ok(())).unwrap(),
            (format!("inventory-v1:350:{:x}", hash.finalize()), 350)
        );
    }

    #[test]
    fn signature_merge_observes_cancellation() {
        let root = std::env::temp_dir().join("signature-fixture");
        let mut signature = Signature::default();
        for index in 0..100 {
            signature
                .add(&root, &root.join(format!("{index}.mp4")), "1", "0")
                .unwrap();
            signature.spill().unwrap();
        }
        assert_eq!(
            signature.finish(|| Err("cancelled".into())).unwrap_err(),
            "cancelled"
        );
    }
}
