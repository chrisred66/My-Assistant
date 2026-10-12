// Claude Code usage for the desktop ball, read from Claude Code's own session logs on this computer
// (~/.claude/projects/**/*.jsonl, or $CLAUDE_CONFIG_DIR/projects). Each assistant message there carries its token
// usage; a message can be written more than once, so entries are de-duplicated by message id + request id.
// Tokens counted: new input + cache writes + output. Cache reads are left out: they re-read the whole conversation on
// every turn and would swamp the figure.

use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Serialize)]
pub struct Entry {
    /// ISO timestamp (UTC) of the message.
    ts: String,
    model: String,
    input: u64,
    cache_write: u64,
    cache_read: u64,
    output: u64,
    /// What the ball and Usage page count: input + cache writes + output.
    tokens: u64,
}

fn projects_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(custom) = std::env::var("CLAUDE_CONFIG_DIR") {
        for part in custom.split(',') {
            dirs.push(PathBuf::from(part.trim()).join("projects"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".claude").join("projects"));
        dirs.push(home.join(".config").join("claude").join("projects"));
    }
    dirs
}

fn jsonl_files(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            jsonl_files(&path, since, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            // Only files touched in the period (older sessions can't have messages in it).
            let recent = entry.metadata().and_then(|m| m.modified()).map(|t| t >= since).unwrap_or(true);
            if recent {
                out.push(path);
            }
        }
    }
}

/// Messages from files modified in the last `days` days. The ball totals them per local day/month.
pub fn usage(days: u64) -> Vec<Entry> {
    let since = SystemTime::now() - Duration::from_secs(days * 86_400);
    let mut files = Vec::new();
    for dir in projects_dirs() {
        jsonl_files(&dir, since, &mut files);
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for file in files {
        let Ok(f) = File::open(&file) else { continue };
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            // Cheap filter before parsing: most lines are tool output.
            if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let msg = &v["message"];
            let usage = &msg["usage"];
            if !usage.is_object() {
                continue;
            }
            let key = format!("{}:{}", msg["id"].as_str().unwrap_or(""), v["requestId"].as_str().unwrap_or(""));
            if key != ":" && !seen.insert(key) {
                continue;
            }
            let n = |k: &str| usage[k].as_u64().unwrap_or(0);
            let (input, cache_write, cache_read, output) =
                (n("input_tokens"), n("cache_creation_input_tokens"), n("cache_read_input_tokens"), n("output_tokens"));
            if let Some(ts) = v["timestamp"].as_str() {
                out.push(Entry {
                    ts: ts.to_string(),
                    model: msg["model"].as_str().unwrap_or("unknown").to_string(),
                    input,
                    cache_write,
                    cache_read,
                    output,
                    tokens: input + cache_write + output,
                });
            }
        }
    }
    out
}
