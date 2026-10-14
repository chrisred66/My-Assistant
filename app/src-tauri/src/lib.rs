// The API login token lives in the OS credential store (Windows Credential Manager).
// On platforms without one wired up, these commands return an error and the frontend
// falls back to the app's store file.

#[cfg(windows)]
mod token {
    const SERVICE: &str = "com.chris.chrismanager";
    const ACCOUNT: &str = "api-token";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }

    pub fn get() -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(token: &str) -> Result<(), String> {
        entry()?.set_password(token).map_err(|e| e.to_string())
    }

    pub fn delete() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(windows))]
mod token {
    const UNSUPPORTED: &str = "secure token storage is not available on this platform";

    pub fn get() -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set(_token: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
fn token_get() -> Result<Option<String>, String> {
    token::get()
}

#[tauri::command]
fn token_set(token: String) -> Result<(), String> {
    token::set(&token)
}

#[tauri::command]
fn token_delete() -> Result<(), String> {
    token::delete()
}

use tauri::Manager;

mod claude_code;

/// Claude Code token usage from its local session logs (see claude_code.rs), for the desktop ball.
#[tauri::command]
async fn claude_code_usage(days: Option<u64>) -> Result<Vec<claude_code::Entry>, String> {
    let days = days.unwrap_or(40).min(400);
    tauri::async_runtime::spawn_blocking(move || claude_code::usage(days))
        .await
        .map_err(|e| e.to_string())
}

mod fullscreen;
mod signals;

/// The git repositories whose commits and reverts the desktop pet reacts to.
#[tauri::command]
fn pet_watch_repos(state: tauri::State<signals::GitRepos>, repos: Vec<String>) {
    *state.0.lock().unwrap() = repos.into_iter().map(std::path::PathBuf::from).collect();
}

/// The app in front (exe, and whether it's a web browser), for the pet.
#[tauri::command]
fn foreground_app() -> fullscreen::Foreground {
    fullscreen::foreground()
}
mod pet_skin;

/// The desktop pet's images, mood -> data URL (empty: the built-in whale).
#[tauri::command]
fn pet_skin_list(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, String>, String> {
    pet_skin::list(&app)
}

/// Saves one mood's image (base64).
#[tauri::command]
fn pet_skin_save(app: tauri::AppHandle, mood: String, ext: String, data: String) -> Result<(), String> {
    pet_skin::save(&app, &mood, &ext, &data)
}

/// The credit line shown with the pet's images (artists, licence).
#[tauri::command]
fn pet_skin_credit(app: tauri::AppHandle) -> Result<String, String> {
    pet_skin::credit(&app)
}

#[tauri::command]
fn pet_skin_set_credit(app: tauri::AppHandle, text: String) -> Result<(), String> {
    pet_skin::set_credit(&app, &text)
}

/// Removes one mood's image, or all of them when `mood` is null.
#[tauri::command]
fn pet_skin_clear(app: tauri::AppHandle, mood: Option<String>) -> Result<(), String> {
    pet_skin::clear(&app, mood.as_deref())
}

mod system_audio;

/// Meeting mode: start sending what an output device plays (16 kHz mono PCM blocks) to `on_audio`. Returns the rate.
#[tauri::command]
fn system_audio_start(
    state: tauri::State<system_audio::SystemAudio>,
    on_audio: tauri::ipc::Channel,
    device: Option<String>,
) -> Result<u32, String> {
    system_audio::start(&state, on_audio, device)
}

/// Output devices meeting mode can capture.
#[tauri::command]
fn system_audio_devices() -> Result<Vec<system_audio::OutputDevice>, String> {
    system_audio::devices()
}

#[tauri::command]
fn system_audio_stop(state: tauri::State<system_audio::SystemAudio>) {
    system_audio::stop(&state);
}

/// Saves a downloaded file (e.g. a recording's audio) where the person chose in the save dialog.
#[tauri::command]
fn save_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save the file: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(system_audio::SystemAudio::default())
        .setup(|app| {
            let repos = signals::GitRepos::default();
            // The ball and pet's watchers (full screen, keyboard / mouse activity, git) only matter on the desktop; on a
            // phone they'd just poll for nothing.
            #[cfg(desktop)]
            {
                fullscreen::watch(app.handle().clone());
                signals::watch(app.handle().clone(), repos.0.clone());
            }
            app.manage(repos);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            token_get,
            token_set,
            token_delete,
            claude_code_usage,
            system_audio_start,
            system_audio_stop,
            system_audio_devices,
            pet_skin_list,
            pet_skin_save,
            pet_skin_clear,
            pet_skin_credit,
            pet_skin_set_credit,
            foreground_app,
            pet_watch_repos,
            save_file
        ])
        // Closing the main window quits the app, including the desktop usage ball (otherwise the hidden or floating
        // ball window would keep the app running with no way back to the main window).
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
