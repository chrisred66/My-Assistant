// The app's language for the WebView itself (built-in date pickers, spell check, default fonts): passed as --lang when
// the windows are created, so a change shows from the next start. The frontend saves the account's language here
// (ui-language.txt in the app's config folder) whenever it's applied.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("ui-language.txt"))
}

/// The WebView locale for the saved language: zh-CN for Chinese, else British English (as before).
pub fn browser_locale(app: &AppHandle) -> &'static str {
    match file(app).and_then(|f| std::fs::read_to_string(f).ok()).as_deref().map(str::trim) {
        Some("zh") => "zh-CN",
        _ => "en-GB",
    }
}

/// Remembers the language ("en" or "zh") for the next start.
#[tauri::command]
pub fn set_ui_language(app: AppHandle, lang: String) -> Result<(), String> {
    if lang != "en" && lang != "zh" {
        return Err("language must be en or zh".into());
    }
    let f = file(&app).ok_or("no config folder")?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(f, lang).map_err(|e| e.to_string())
}
