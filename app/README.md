# app (Tauri 2 client)

The **My Assistant** app for Windows and Android, built with Tauri 2 + React 19 + TypeScript. It talks to `server/`
(see the main README); everything it shows comes from there.

- **Windows**: the full app, plus the desktop extras for the Super Admin (usage ball, desktop pet, online meetings
  that record what the computer plays, Save audio…).
- **Android**: the same pages in one window, without the desktop extras (`src/lib/platform.ts` decides;
  `src-tauri/tauri.android.conf.json` keeps only the main window). Meetings there are in person (microphone).

## Toolchain (each dev machine)

- Node.js 22.12+ (Vite 8 refuses older versions)
- Rust (stable, MSVC): https://rustup.rs
- Windows: Visual Studio C++ build tools + WebView2 (preinstalled on Windows 11)
- Android: Android Studio with the SDK and NDK (`ANDROID_HOME`, `NDK_HOME`), JDK 17 (`JAVA_HOME`), and the Rust target
  `rustup target add aarch64-linux-android`

## Run it

```
cd C:\xampp\htdocs\My-Assistant\app
npm install
npm run tauri dev      # dev window with hot reload
```

The default server address is set at build time in `app/.env.local` (git-ignored), e.g.
`VITE_DEFAULT_SERVER_URL=https://<your-tunnel-domain>`; without it, the app defaults to the local address
`http://localhost/My-Assistant/server/public`, which is also the quicker choice on the server PC itself.

## Build a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and date the
   CHANGELOG section.
2. **Windows installers** (setup `.exe` and `.msi`, unsigned for now: Windows shows "unknown publisher" until a
   code-signing certificate is added):
   ```
   npm run tauri build
   ```
   Output: `src-tauri\target\release\bundle\nsis\*-setup.exe` and `bundle\msi\*.msi`.
3. **Android APK** (64-bit ARM, which covers nearly every phone since about 2017):
   ```
   npx tauri android build --apk --target aarch64
   ```
   Output: `src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk`.

   Release builds are signed with the key in `C:\Users\User\.android-keys` (`my-assistant.jks`, alias `my-assistant`),
   named in `src-tauri\gen\android\keystore.properties`, which git ignores:
   ```
   storeFile=C:/Users/User/.android-keys/my-assistant.jks
   keyAlias=my-assistant
   passwordFile=C:/Users/User/.android-keys/my-assistant.password.txt
   ```
   Without the password file, set `MYASSISTANT_KEY_PASSWORD` instead. A copy of the key and its password is in
   Bitwarden ("My Assistant Android signing key"). **Never make a new key**: Android only installs an update signed
   with the same one, so a new key would force everyone to uninstall the app and lose its data.
4. Attach the installers and the APK to a GitHub release for the version's tag.

## How it talks to the server

- API calls go through `@tauri-apps/plugin-http` (Rust side), so the PHP server needs no CORS headers. The allowed
  URLs are in `src-tauri/capabilities/default.json`.
- The login token is stored in Windows Credential Manager (`token_*` commands in `src-tauri/src/lib.rs`); Android
  falls back to the app's `settings.json` store.
- All API types and calls are in `src/lib/api.ts`. Numeric columns from MySQL (sums, costs) arrive as strings and
  are converted there.
