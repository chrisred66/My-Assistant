# app (Tauri 2 client)

Desktop client for `server/`, built with Tauri 2 + React + TypeScript. Android/iOS come later.

Screens: **Translate** (Arabic text → English), **Recordings** (live transcription while you speak,
any language, translated to English unless already English; saved automatically on Stop; or upload a
file), **Transcripts** (searchable history), **Usage** (tokens and cost by day / month / model, plus
manual entries), **Settings** (server, sign out).

Live recording (`src/lib/liveRecorder.ts`) records the whole session as WebM/Opus and, in parallel,
cuts 16 kHz WAV chunks at pauses (3–12 s, silent chunks skipped) that are sent to `/live/{id}/chunk`
as they're made, two at a time.

## Toolchain (each dev machine)

- Node.js 22.12+ (Vite 8 refuses older versions)
- Rust (stable, MSVC): https://rustup.rs
- Windows: Visual Studio C++ build tools + WebView2 (preinstalled on Windows 11)
- Android, later: Android Studio, SDK, NDK (`NDK_HOME`), JDK 17 (`JAVA_HOME`)

## Run it

```
cd C:\xampp\htdocs\chrisManager\app
npm install
npm run tauri dev      # dev window with hot reload
npm run tauri build    # installer in src-tauri\target\release\bundle\
```

On first launch, sign in with the account made by `server\bin\create-user.php`. The server address
defaults to `http://localhost/chrisManager/server/public`; from another device use the desktop's
Tailscale name instead.

## How it talks to the server

- API calls go through `@tauri-apps/plugin-http` (Rust side), so the PHP server needs no CORS headers.
  The allowed URLs are in `src-tauri/capabilities/default.json`.
- The login token is stored in Windows Credential Manager (`token_*` commands in `src-tauri/src/lib.rs`).
  Other platforms fall back to the app's `settings.json` store.
- All API types and calls are in `src/lib/api.ts`. Numeric columns from MySQL (sums, costs) arrive as
  strings and are converted there.

## Notes

- Transcribing recordings uses OpenAI on the server, so it needs `OPENAI_API_KEY` in `server/.env`.
  Uploading without transcription works without it.
- The usage chart colors are fixed per provider (Anthropic blue, OpenAI orange, DeepSeek aqua), validated
  for colorblind separation in light and dark mode. The table under the chart has every value.
