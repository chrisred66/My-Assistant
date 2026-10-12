// Signals for the desktop pet's animation rules, polled natively:
// - "user-activity" (every second): how long since the last keyboard/mouse input, and whether you're typing. Typing is
//   input while the cursor stays put (GetLastInputInfo changed, GetCursorPos didn't), seen a few times in 4 s.
// - "git-activity": in the watched repositories, a commit starting ("committing": COMMIT_EDITMSG written), a commit
//   made ("committed": a new commit entry in .git/logs/HEAD), or work undone ("reverted": a revert or reset entry).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

/// The repositories watched for git activity (set from the app, shared with the watcher thread).
#[derive(Default)]
pub struct GitRepos(pub std::sync::Arc<Mutex<Vec<PathBuf>>>);

#[derive(Clone, serde::Serialize)]
struct UserActivity {
    idle_ms: u64,
    typing: bool,
}

#[derive(Clone, serde::Serialize)]
struct GitActivity {
    repo: String,
    action: &'static str, // committing | committed | reverted
}

pub fn watch(app: AppHandle, repos: std::sync::Arc<Mutex<Vec<PathBuf>>>) {
    std::thread::spawn(move || {
        let mut last_input: u32 = 0;
        let mut last_cursor = (i32::MIN, i32::MIN);
        let mut keys: VecDeque<Instant> = VecDeque::new();
        let mut last_emit = Instant::now() - Duration::from_secs(2);
        // Per repo: size of logs/HEAD and mtime of COMMIT_EDITMSG last seen.
        let mut heads: HashMap<PathBuf, u64> = HashMap::new();
        let mut msgs: HashMap<PathBuf, SystemTime> = HashMap::new();
        let mut last_git = Instant::now() - Duration::from_secs(2);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = Instant::now();

            // Keyboard: the last-input time moved but the cursor didn't.
            if let Some((tick, cursor, idle_ms)) = input_state() {
                if tick != last_input {
                    if cursor == last_cursor && last_input != 0 {
                        keys.push_back(now);
                    }
                    last_input = tick;
                }
                last_cursor = cursor;
                while keys.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(4)) {
                    keys.pop_front();
                }
                if now.duration_since(last_emit) >= Duration::from_secs(1) {
                    last_emit = now;
                    let _ = app.emit("user-activity", UserActivity { idle_ms, typing: keys.len() >= 3 });
                }
            }

            if now.duration_since(last_git) < Duration::from_secs(1) {
                continue;
            }
            last_git = now;
            let list = repos.lock().unwrap().clone();
            for repo in list {
                let git = repo.join(".git");
                let name = repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if let Ok(mtime) = std::fs::metadata(git.join("COMMIT_EDITMSG")).and_then(|m| m.modified()) {
                    if msgs.get(&repo).is_some_and(|seen| *seen != mtime) {
                        let _ = app.emit("git-activity", GitActivity { repo: name.clone(), action: "committing" });
                    }
                    msgs.insert(repo.clone(), mtime);
                }
                let log = git.join("logs").join("HEAD");
                let Ok(len) = std::fs::metadata(&log).map(|m| m.len()) else { continue };
                let seen = heads.insert(repo.clone(), len);
                let Some(seen) = seen else { continue }; // first look: just remember where the log ends
                if len <= seen {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&log) else { continue };
                let new = String::from_utf8_lossy(&bytes[seen as usize..]).to_string();
                for line in new.lines() {
                    // "<old> <new> <who> <time> <tz>\t<message>"
                    let message = line.split_once('\t').map(|(_, m)| m).unwrap_or("");
                    let action = if message.starts_with("reset:") || message.starts_with("revert") || message.contains(": Revert \"") {
                        Some("reverted")
                    } else if message.starts_with("commit") {
                        Some("committed")
                    } else {
                        None
                    };
                    if let Some(action) = action {
                        let _ = app.emit("git-activity", GitActivity { repo: name.clone(), action });
                    }
                }
            }
        }
    });
}

/// (last input tick, cursor position, milliseconds since the last input).
#[cfg(windows)]
fn input_state() -> Option<(u32, (i32, i32), u64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p);
        let idle = GetTickCount().wrapping_sub(info.dwTime) as u64;
        Some((info.dwTime, (p.x, p.y), idle))
    }
}

#[cfg(not(windows))]
fn input_state() -> Option<(u32, (i32, i32), u64)> {
    None
}
