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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![token_get, token_set, token_delete])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
