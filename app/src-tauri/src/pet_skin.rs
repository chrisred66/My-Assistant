// The desktop pet's look: images the user supplies, one per mood (idle, swim, eating, happy, sleepy, hungry, busy,
// held), kept in the app's data folder (pet-skin/<mood>.<ext>). Missing moods fall back to others in the app; with no
// images at all the pet is the built-in whale.

use base64::Engine;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MOODS: [&str; 8] = ["idle", "swim", "eating", "happy", "sleepy", "hungry", "busy", "held"];
const TYPES: [(&str, &str); 6] = [
    ("png", "image/png"),
    ("apng", "image/apng"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
];
const MAX_BYTES: usize = 8 * 1024 * 1024;

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("pet-skin"))
}

fn files_for(dir: &PathBuf, mood: &str) -> Vec<PathBuf> {
    TYPES.iter().map(|(ext, _)| dir.join(format!("{mood}.{ext}"))).filter(|p| p.exists()).collect()
}

/// Mood -> data URL of its image.
pub fn list(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let dir = dir(app)?;
    let mut out = HashMap::new();
    for mood in MOODS {
        if let Some(path) = files_for(&dir, mood).first() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
            let mime = TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).unwrap_or("image/png");
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            out.insert(mood.to_string(), format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
        }
    }
    Ok(out)
}

/// Saves `data` (base64) as the image for `mood`, replacing any earlier one.
pub fn save(app: &AppHandle, mood: &str, ext: &str, data: &str) -> Result<(), String> {
    if !MOODS.contains(&mood) {
        return Err(format!("Unknown mood {mood}"));
    }
    let ext = ext.to_lowercase();
    if !TYPES.iter().any(|(e, _)| *e == ext) {
        return Err("Use a PNG, GIF, WebP or JPEG image".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("That image is over 8 MB".into());
    }
    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for old in files_for(&dir, mood) {
        let _ = std::fs::remove_file(old);
    }
    std::fs::write(dir.join(format!("{mood}.{ext}")), bytes).map_err(|e| e.to_string())
}

/// The credit line for the images (pet-skin/credit.txt), e.g. the artists and licence; empty when none.
pub fn credit(app: &AppHandle) -> Result<String, String> {
    Ok(std::fs::read_to_string(dir(app)?.join("credit.txt")).unwrap_or_default())
}

pub fn set_credit(app: &AppHandle, text: &str) -> Result<(), String> {
    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("credit.txt"), text.trim()).map_err(|e| e.to_string())
}

/// Removes one mood's image, or all of them (back to the built-in whale).
pub fn clear(app: &AppHandle, mood: Option<&str>) -> Result<(), String> {
    let dir = dir(app)?;
    for m in MOODS.iter().filter(|m| mood.map_or(true, |x| x == **m)) {
        for f in files_for(&dir, m) {
            std::fs::remove_file(f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
