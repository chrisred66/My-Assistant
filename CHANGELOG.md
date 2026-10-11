# Changelog

All notable changes to chrisManager. Newest first.
Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

When you change something, add a line under **Unreleased** in the right group
(Added / Changed / Fixed / Removed / Security). When you cut a release, rename
Unreleased to the version and date, and bump the app version in
`app/package.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/tauri.conf.json`.

## [Unreleased]

### Added
- `ANTHROPIC_WORKSPACE_ID` setting: when set, Anthropic requests carry the `anthropic-workspace-id`
  header. Needed for API keys that aren't scoped to a workspace (Anthropic returns 400 without it).
- **Live transcription while recording.** The app cuts the microphone audio into short chunks at
  natural pauses (3–12 s, silence skipped) and sends each one as it's recorded; the server transcribes
  it with OpenAI (language auto-detected) and, unless it's English, translates it with the chosen
  provider at low effort, so text appears a few seconds behind speech. On Stop the full recording
  (compressed WebM/Opus) is saved automatically with the assembled transcript and translation.
  - Server: `POST /live`, `POST /live/{id}/chunk`, `POST /live/{id}/finish`; migration
    `002_live_segments.sql` (`transcript_segments` table; `transcripts.source_lang` widened).
  - App: live panel with mic level meter, side-by-side original/English rows, per-chunk retry.
- Any-language → English translation (`Translator::toEnglish`), used for recordings and files; the
  Translate page stays Arabic → English.
- Uploaded audio files are transcribed and translated in one step; saved recordings can be
  re-transcribed or re-translated from the list (`POST /recordings/{id}/transcribe`,
  `POST /transcripts/{id}/translate`).
- Recordings and transcripts carry the detected `language`.
- **AI routing by job**, fixed on the server (`Ai\Routing`): translation → Claude (`TRANSLATE_PROVIDER`),
  transcription → OpenAI, light tasks → DeepSeek (new `LIGHT_PROVIDER`). The first light task is
  language detection (`Ai\Light`), used when the transcriber doesn't report a language, so English
  text never costs a translation call. `GET /ai/routing` reports the table; Settings shows it.

- **Usage from the providers.** Syncs daily usage and billed cost from Anthropic (Usage & Cost Admin
  API, `ANTHROPIC_ADMIN_KEY`) and OpenAI (Usage + Costs API, `OPENAI_ADMIN_KEY`) into `token_usage`
  (`source = 'sync'`), replacing a range on each re-sync. DeepSeek has no usage-history API, so its
  balance is shown and its usage comes from this app.
  - Server: `GET /usage/providers`, `POST /usage/sync`, `bin/sync-usage.php [days]` for a nightly task;
    `/usage/summary?view=providers|app`; migration `003_provider_usage_sync.sql` (`token_usage.cost_usd`,
    `token_usage.request_count`, `usage_sync` table).
  - App: Usage page "All provider usage / This app only" switch and a Sources panel (sync status,
    Sync button, DeepSeek balance).
  - Reported costs are used as billed; the `model_prices` estimate only fills in where none is reported.

- **Multiple users and roles** (migration `004_user_roles.sql`). `owner` (the existing account) has
  everything; `member` accounts only see PT Management at their `pt_access` level
  (`none` < `view` < `edit` < `admin`). Sign-in accepts an email or a username. New endpoints:
  `POST /auth/password`, `GET/POST /users`, `POST /users/{id}` (owner). Disabling a user or resetting
  their password signs them out everywhere. Settings: change password; owner manages users.
- **PT Management tab** (foundation for porting the standalone GBA Toolkit / ptManagement app):
  separate connection to `gba_database` (`GBA_DB_NAME`, `GBA_DB_USER`, `GBA_DB_PASS`), `GET /pt/status`,
  and Fleet / Operations / Trials / Charging sections with an import guide while the database is missing.

### Changed
- The AI, recordings, transcripts and usage endpoints are owner-only (members get 403).

### Removed
- Provider choice for translation: the "Translate with" / "Provider" pickers in the app and the
  `provider` parameter on translation, upload and live-chunk requests (the server ignores it).

- `APP_TIMEZONE=system` (new default): the server follows the operating system's timezone
  (Windows via `tzutil` + PHP `intl`; Linux via `/etc/timezone`), re-checked hourly. An IANA name
  like `Asia/Dubai` still overrides it. Requires the PHP `intl` extension on Windows.

### Changed
- Uploading no longer fails as a whole when transcription or translation fails: the file (and the
  transcript, if transcription worked) is kept, and the error comes back as `transcribe_error` /
  `translate_error` so the step can be retried on its own.

### Fixed
- Transcribing an uploaded chunk failed with "Invalid file format": PHP's temp upload files have
  no extension, and OpenAI detects the format from the file name.
- Whisper turned silence into text (1 s of silence came back as "you"); segments it scores as
  probably-not-speech are now dropped.
- MySQL ran on the PC's timezone (Asia/Dubai) while PHP used `APP_TIMEZONE` (UTC), so database
  timestamps (`created_at`, token expiry checks) were 4 hours off from PHP-written ones. Each
  connection now uses PHP's timezone. Rows created before this fix keep their Dubai-time `created_at`.
- `.env` loader read an inline comment as the value when the value itself was empty
  (e.g. `KEY=   # note` returned `# note` instead of nothing).

## [0.2.0] - 2026-10-11

First desktop client.

### Added
- `app/`: Tauri 2 desktop client (React 19 + TypeScript + Vite 8), app version 0.1.0.
  - **Login** with server address, "Test connection", and a per-device name.
  - **Translate**: Arabic text → English, with provider and model overrides.
  - **Recordings**: record from the microphone or upload an audio file; optional
    transcribe + translate; list of saved recordings.
  - **Transcripts**: searchable history of the latest 200 translations, with copy buttons.
  - **Usage**: total cost, requests and tokens; stacked chart by day/month or bars by model;
    full table; manual usage entry.
  - **Settings**: connection check and sign out (revokes the device token on the server).
- API calls go through the Tauri HTTP plugin (Rust side), so the PHP server needs no CORS headers.
- Login token stored in Windows Credential Manager (falls back to the app's store file elsewhere).
- `CHANGELOG.md` (this file).

### Changed
- `README.md` and `app/README.md`: describe the client and how to run and build it.
- `.gitignore`: ignore `*.bak` files, so backups of `.env` can't be committed by accident.

### Known limitations
- Transcription needs `OPENAI_API_KEY` in `server/.env`; uploading without transcription works without it.
- No data-analysis screen yet: the `datasets` table exists, but the server has no endpoints for it.
- Recorded audio can't be played back from the server (no download endpoint).
- Android/iOS targets not set up yet.

## [0.1.0] - 2026-10-11

Initial server scaffold.

### Added
- `server/`: PHP 8.2 JSON API for XAMPP/Apache.
  - Auth: email + password login issuing per-device bearer tokens; logout; `/auth/me`.
  - `/ai/translate`: Arabic → English through Anthropic, OpenAI or DeepSeek, saved as a transcript.
  - `/recordings`: multipart audio upload, optional OpenAI transcription + translation.
  - `/transcripts`, `/recordings` listings.
  - `/usage/summary` (by day, month or model, with cost from `model_prices`) and manual `/usage` entries.
  - Every AI call's tokens logged to `token_usage`.
- Database migration `001_init.sql`, `bin/migrate.php`, `bin/create-user.php`.
- Anthropic model prices seeded.
- Setup, production and API documentation in `README.md`.
