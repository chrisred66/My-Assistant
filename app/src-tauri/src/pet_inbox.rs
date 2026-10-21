// The pet's inbox: other programs on this PC leave the pet messages as files in
// %APPDATA%\com.chris.chrismanager\pet-inbox (made on first use). A .txt file is the message itself; a .json file is
// {"text": "...", "from": "..."} ("from" optional, shown above the text). The pet takes them about once a second while
// it's showing, oldest first, and deletes each; while it's put away they wait.
// Write the file in one go (or write elsewhere and move it in): files are read once they're half a second old, so a
// half-written one isn't picked up. A file that isn't a message is renamed to .bad and left there.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

const MAX_TEXT: usize = 500; // characters; longer text is cut
const MAX_FROM: usize = 40;
const MAX_BYTES: u64 = 64 * 1024;
const SETTLE: Duration = Duration::from_millis(500);

#[derive(Clone, serde::Serialize)]
pub struct Message {
    text: String,
    from: Option<String>,
}

#[derive(serde::Deserialize)]
struct JsonMessage {
    text: String,
    from: Option<String>,
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("pet-inbox"))
}

/// Takes the waiting messages (oldest first), deleting their files.
pub fn take(app: &AppHandle) -> Result<Vec<Message>, String> {
    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            if ext != "txt" && ext != "json" {
                return None;
            }
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            // Still being written (or the clock moved back): next time.
            (now.duration_since(modified).ok()? >= SETTLE).then_some((modified, path))
        })
        .collect();
    files.sort();

    let mut out = Vec::new();
    for (_, path) in files {
        match read(&path) {
            Some(message) => {
                let _ = std::fs::remove_file(&path);
                out.push(message);
            }
            None => {
                let _ = std::fs::rename(&path, path.with_extension("bad"));
            }
        }
    }
    Ok(out)
}

fn read(path: &Path) -> Option<Message> {
    if std::fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let raw = std::fs::read(path).ok()?;
    // Windows tools often write UTF-8 with a byte-order mark; PowerShell 5's Out-File / > write UTF-16.
    let content = decode(&raw)?;
    let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
    let (text, from) = if is_json {
        let m: JsonMessage = serde_json::from_str(&content).ok()?;
        (m.text, m.from)
    } else {
        (content, None)
    };
    let text = clip(text.trim(), MAX_TEXT);
    if text.is_empty() {
        return None;
    }
    let from = from.map(|f| clip(f.trim(), MAX_FROM)).filter(|f| !f.is_empty());
    Some(Message { text, from })
}

fn decode(raw: &[u8]) -> Option<String> {
    if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).ok();
    }
    if let Some(rest) = raw.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16(&units).ok();
    }
    String::from_utf8(raw.to_vec()).ok()
}

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}
