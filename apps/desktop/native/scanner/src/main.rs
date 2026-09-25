mod filename;
mod signature;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, BufReader, BufWriter, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, LazyLock,
    },
    time::{Duration, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolContract {
    version: u32,
    max_frame_bytes: usize,
    max_batch_entries: usize,
    max_request_id_bytes: usize,
    max_path_bytes: usize,
    max_extensions: usize,
    max_extension_bytes: usize,
    max_year: u32,
    max_sequence: u64,
    command_kinds: Vec<String>,
    command_fields: HashMap<String, Vec<String>>,
    event_kinds: Vec<String>,
    event_fields: HashMap<String, Vec<String>>,
}
static CONTRACT: LazyLock<ProtocolContract> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../protocol-contract.json")).expect("valid scanner protocol")
});
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    version: u32,
    id: String,
    kind: String,
    root: Option<String>,
    extensions: Option<Vec<String>>,
    sequence: Option<u64>,
    max_year: Option<u32>,
    expected_signature: Option<String>,
}
fn decode_command(bytes: &[u8]) -> Option<Command> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    let kind = object.get("kind")?.as_str()?;
    let fields = CONTRACT.command_fields.get(kind)?;
    if object.len() != fields.len() + 3
        || fields
            .iter()
            .any(|key| object.get(key).is_none_or(|value| value.is_null()))
        || object
            .keys()
            .any(|key| !["version", "id", "kind"].contains(&key.as_str()) && !fields.contains(key))
    {
        return None;
    }
    let command: Command = serde_json::from_value(value).ok()?;
    if command.version != CONTRACT.version
        || command.id.is_empty()
        || command.id.len() > CONTRACT.max_request_id_bytes
        || command.id.contains('\0')
        || !CONTRACT.command_kinds.contains(&command.kind)
        || command.expected_signature.as_ref().is_some_and(|value| {
            let parts: Vec<_> = value.split(':').collect();
            value.len() > 100
                || parts.len() != 3
                || parts[0] != "inventory-v1"
                || parts[1].is_empty()
                || !parts[1].bytes().all(|b| b.is_ascii_digit())
                || parts[2].len() != 64
                || !parts[2]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || command
            .sequence
            .is_some_and(|value| value > CONTRACT.max_sequence)
        || command
            .max_year
            .is_some_and(|value| value == 0 || value > CONTRACT.max_year)
        || command.root.as_ref().is_some_and(|root| {
            root.is_empty()
                || root.len() > CONTRACT.max_path_bytes
                || root.contains('\0')
                || !Path::new(root).is_absolute()
        })
        || command.extensions.as_ref().is_some_and(|extensions| {
            extensions.len() > CONTRACT.max_extensions
                || extensions.iter().any(|extension| {
                    extension.len() < 2
                        || extension.len() > CONTRACT.max_extension_bytes
                        || !extension.starts_with('.')
                        || !extension[1..]
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                })
        })
    {
        return None;
    }
    Some(command)
}
#[derive(Serialize)]
struct Entry {
    #[serde(skip_serializing_if = "Option::is_none")]
    hints: Option<filename::Hints>,
    path: String,
    kind: &'static str,
    size: String,
    mtime: String,
}
fn emit(value: serde_json::Value) -> Result<(), String> {
    if !value
        .get("kind")
        .and_then(|kind| kind.as_str())
        .is_some_and(|kind| CONTRACT.event_kinds.iter().any(|known| known == kind))
    {
        return Err("Unknown protocol event".into());
    }
    let kind = value["kind"].as_str().ok_or("Missing event kind")?;
    let fields = CONTRACT
        .event_fields
        .get(kind)
        .ok_or("Missing event schema")?;
    if value.as_object().is_none_or(|object| {
        object.len() != fields.len() + 3 || fields.iter().any(|field| !object.contains_key(field))
    }) {
        return Err("Invalid event fields".into());
    }
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if bytes.len() > CONTRACT.max_frame_bytes {
        return Err("Protocol frame exceeds limit".into());
    }
    let mut out = io::stdout().lock();
    out.write_all(&bytes)
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}
struct Scan<'a> {
    id: &'a str,
    root: &'a Path,
    signature: signature::Signature,
    extensions: Vec<String>,
    max_year: u32,
    fingerprint_only: bool,
    spool: Option<BufWriter<fs::File>>,
    commands: &'a mpsc::Receiver<Command>,
    stopped: Arc<AtomicBool>,
    batch: Vec<Entry>,
    bytes: usize,
    sequence: u64,
    directories: u64,
    stats: u64,
}
impl Scan<'_> {
    fn replay(&mut self) -> Result<(), String> {
        let Some(mut writer) = self.spool.take() else {
            return Err("Missing discovery spool".into());
        };
        writer.flush().map_err(|e| e.to_string())?;
        let mut file = writer.into_inner().map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        for line in BufReader::new(file).lines() {
            self.check()?;
            let line = line.map_err(|e| e.to_string())?;
            let (path, kind, size, mtime): (String, String, String, String) =
                serde_json::from_str(&line).map_err(|e| e.to_string())?;
            let kind = match kind.as_str() {
                "file" => "file",
                "directory" => "directory",
                "other" => "other",
                _ => return Err("Invalid spooled entry".into()),
            };
            self.push(Entry {
                path,
                kind,
                size,
                mtime,
                hints: None,
            })?;
        }
        self.flush()
    }
    fn check(&self) -> Result<(), String> {
        if self.stopped.load(Ordering::SeqCst) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
    fn flush(&mut self) -> Result<(), String> {
        if self.batch.is_empty() {
            return Ok(());
        }
        self.check()?;
        emit(
            json!({"version": CONTRACT.version, "id": self.id, "kind":"batch", "sequence": self.sequence, "entries": self.batch}),
        )?;
        self.batch.clear();
        self.bytes = 0;
        // One in-flight batch, below the protocol's maximum of two.
        loop {
            self.check()?;
            match self.commands.recv_timeout(Duration::from_millis(100)) {
                Ok(command)
                    if command.kind == "ack"
                        && command.id == self.id
                        && command.sequence == Some(self.sequence) =>
                {
                    break
                }
                Ok(_) => return Err("Unexpected command".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(_) => return Err("cancelled".into()),
            }
        }
        self.sequence += 1;
        Ok(())
    }
    fn push(&mut self, entry: Entry) -> Result<(), String> {
        let size = serde_json::to_vec(&entry).map_err(|e| e.to_string())?.len();
        if size + 1024 > CONTRACT.max_frame_bytes {
            return Err("Path exceeds protocol limit".into());
        }
        if self.bytes + size + 1024 > CONTRACT.max_frame_bytes
            || self.batch.len() == CONTRACT.max_batch_entries
        {
            self.flush()?;
        }
        self.bytes += size + 1;
        self.batch.push(entry);
        Ok(())
    }
    fn walk(&mut self, directory: &Path) -> Result<(), String> {
        self.check()?;
        self.directories += 1;
        if self.directories % 64 == 0 {
            emit(
                json!({"version":CONTRACT.version,"id":self.id,"kind":"progress","directories":self.directories,"stats":self.stats}),
            )?;
        }
        for raw in fs::read_dir(directory).map_err(|e| format!("filesystem: {e}"))? {
            self.check()?;
            let raw = raw.map_err(|e| format!("filesystem: {e}"))?;
            let name = raw
                .file_name()
                .into_string()
                .map_err(|_| "Unrepresentable UTF-8 path")?;
            if name.starts_with("._") || name == ".DS_Store" {
                continue;
            }
            let target = raw.path();
            let display = target
                .to_str()
                .ok_or("Unrepresentable UTF-8 path")?
                .to_owned();
            let is_directory = raw
                .file_type()
                .map_err(|e| format!("filesystem: {e}"))?
                .is_dir();
            let supported = target
                .extension()
                .and_then(|e| e.to_str())
                .map(|ext| {
                    self.extensions
                        .contains(&format!(".{}", ext.to_lowercase()))
                })
                .unwrap_or(false);
            if display.len() > CONTRACT.max_path_bytes {
                return Err("Path exceeds protocol limit".into());
            }
            let mut kind = "other";
            let mut size = "0".to_string();
            let mut mtime = "0".to_string();
            if is_directory {
                kind = "directory";
            } else if supported {
                let metadata = fs::metadata(&target).map_err(|e| format!("filesystem: {e}"))?;
                self.stats += 1;
                kind = "file";
                size = metadata.len().to_string();
                let modified = metadata
                    .modified()
                    .map_err(|e| format!("filesystem: {e}"))?;
                mtime = match modified.duration_since(UNIX_EPOCH) {
                    Ok(d) => d.as_millis().to_string(),
                    Err(e) => {
                        let millis = e.duration().as_millis();
                        if millis == 0 {
                            "0".to_string()
                        } else {
                            format!("-{millis}")
                        }
                    }
                };
                self.signature.add(self.root, &target, &size, &mtime)?;
            }
            // An unchanged-root check needs only the signature. Avoid filename
            // parsing, per-entry JSON, acknowledgements and a parent inventory.
            if let Some(writer) = &mut self.spool {
                serde_json::to_writer(&mut *writer, &(&display, kind, &size, &mtime))
                    .map_err(|e| e.to_string())?;
                writer.write_all(b"\n").map_err(|e| e.to_string())?;
            } else if !self.fingerprint_only {
                self.push(Entry {
                    hints: Some(filename::hints(&name, self.max_year)),
                    path: display,
                    kind,
                    size,
                    mtime,
                })?;
            }
            if is_directory {
                self.walk(&target)?;
            }
        }
        Ok(())
    }
}
fn peak_rss_bytes() -> Option<u64> {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // getrusage initializes the struct on success; failure returns no metric.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
            return None;
        }
        let rss = unsafe { usage.assume_init() }.ru_maxrss as u64;
        Some(if cfg!(target_os = "macos") {
            rss
        } else {
            rss * 1024
        })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn main() {
    let stopped = Arc::new(AtomicBool::new(false));
    let input_stop = stopped.clone();
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut request_id: Option<String> = None;
        loop {
            let mut line = Vec::new();
            // read_until would allow an unbounded allocation on malformed input.
            let mut too_large = false;
            loop {
                let buffer = match input.fill_buf() {
                    Ok(b) => b,
                    Err(_) => break,
                };
                if buffer.is_empty() {
                    break;
                }
                let count = buffer
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(buffer.len());
                if line.len() + count > CONTRACT.max_frame_bytes + 1 {
                    too_large = true;
                    break;
                }
                line.extend_from_slice(&buffer[..count]);
                input.consume(count);
                if line.last() == Some(&b'\n') {
                    break;
                }
            }
            if too_large || line.is_empty() {
                break;
            }
            let command = match decode_command(&line) {
                Some(c) => c,
                _ => break,
            };
            if let Some(id) = &request_id {
                if id != &command.id {
                    break;
                }
            } else {
                if command.kind != "hello" {
                    break;
                }
                request_id = Some(command.id.clone());
            }
            if command.kind == "cancel" || command.kind == "shutdown" {
                input_stop.store(true, Ordering::SeqCst);
                break;
            }
            if tx.send(command).is_err() {
                break;
            }
        }
        input_stop.store(true, Ordering::SeqCst);
    });
    let hello = match rx.recv() {
        Ok(c) if c.kind == "hello" => c,
        _ => return,
    };
    if emit(json!({"version":CONTRACT.version,"id":hello.id,"kind":"ready","capabilities":["discovery","cancel","ack","signature","fingerprint","inspect"]})).is_err() { return; }
    let command = match rx.recv() {
        Ok(c)
            if ["discover", "fingerprint", "inspect"].contains(&c.kind.as_str())
                && c.id == hello.id =>
        {
            c
        }
        _ => return,
    };
    let root = match command.root {
        Some(r) if Path::new(&r).is_absolute() => r,
        _ => return,
    };
    let extensions = match command.extensions {
        Some(e) if e.len() <= 128 && e.iter().all(|s| s.starts_with('.') && s.len() <= 16) => e,
        _ => return,
    };
    let spool = if command.kind == "inspect" {
        match tempfile::tempfile() {
            Ok(file) => Some(BufWriter::new(file)),
            Err(error) => {
                let _ = emit(
                    json!({"version":CONTRACT.version,"id":hello.id,"kind":"error","filesystem":false,"message":error.to_string()}),
                );
                return;
            }
        }
    } else {
        None
    };
    let mut scan = Scan {
        id: &hello.id,
        root: Path::new(&root),
        signature: if command.kind == "inspect" {
            signature::Signature::compact()
        } else {
            signature::Signature::default()
        },
        extensions,
        max_year: command.max_year.unwrap_or(9999),
        fingerprint_only: command.kind == "fingerprint",
        spool,
        commands: &rx,
        stopped,
        batch: Vec::new(),
        bytes: 0,
        sequence: 0,
        directories: 0,
        stats: 1,
    };
    let result = if Path::new(&root).is_dir() {
        scan.walk(Path::new(&root)).and_then(|_| scan.flush())
    } else {
        Err("filesystem: Root is not a directory".into())
    }.and_then(|_| {
        let stopped = scan.stopped.clone();
        let mut checked = 0;
        scan.signature.finish(|| {
            if stopped.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            checked += 1;
            if checked % 8192 == 0 {
                emit(json!({"version":CONTRACT.version,"id":hello.id,"kind":"progress","directories":scan.directories,"stats":scan.stats}))?;
            }
            Ok(())
        })
    }).and_then(|result| {
        if command.expected_signature.as_ref().is_some_and(|expected| expected != &result.0) {
            scan.replay()?;
        }
        Ok(result)
    });
    match result {
        Ok((signature, file_count)) => {
            let _ = emit(
                json!({"version":CONTRACT.version,"id":hello.id,"kind":"complete","directories":scan.directories,"stats":scan.stats,"peakRssBytes":peak_rss_bytes(),"signature":signature,"fileCount":file_count}),
            );
        }
        Err(error) if error == "cancelled" => {
            let _ = emit(json!({"version":CONTRACT.version,"id":hello.id,"kind":"cancelled"}));
        }
        Err(error) => {
            let _ = emit(
                json!({"version":CONTRACT.version,"id":hello.id,"kind":"error","filesystem":error.starts_with("filesystem:"),"message":error}),
            );
        }
    }
}
