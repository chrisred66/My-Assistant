# Changelog

All notable changes to My Assistant (formerly chrisManager). Newest first.
Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

When you change something, add a line under **Unreleased** in the right group
(Added / Changed / Fixed / Removed / Security; Added is split by area). If it changes something
already listed under Unreleased, update that entry instead of adding another. When you cut a release, rename
Unreleased to the version and date, and bump the app version in
`app/package.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/tauri.conf.json`.

## [Unreleased]

## [0.4.2] - 2026-10-19

The app in English or Chinese, translation into any language, and automatic updates.

### Added
- **English / 简体中文** (`lib/i18n.ts`, `lib/i18n/zh.ts`; server `I18n`, `src/i18n/zh.php`; migration
  `014_user_language.sql`): the whole app, including the server's messages, switches between English and Simplified
  Chinese. Switches on the sign-in screen, in the sidebar under the theme switch, and under Settings → Appearance; the
  choice is saved with the account, so it follows the person to every device. Dates and numbers follow the language,
  including the plain dates in PT tables; pages reload when it changes, so text from the server switches too. The
  desktop app's built-in controls (date pickers) follow it from the next start (windows are created by the app with
  the saved language, `ui_language.rs`). Anything untranslated stays English.
- **Translate into any language** (`Translator`, `lib/targetLanguage.ts`, migration `016_translation_target.sql`):
  Translate, recordings, meetings and transcripts translate into the account's language by default, or into another
  one picked under **Translate into** (English, 简体中文, Arabic, French, German, Spanish, Russian, Japanese, Korean,
  Hindi, Urdu), remembered on the device, separately for Translate and for transcription. The source language is
  detected, so the Translate page takes any language, not only Arabic. Translations show which language they're in;
  text already in that language isn't translated or counted.
- **Updates** (`lib/updates.ts`, Tauri updater and process plugins): the desktop app checks GitHub releases at start
  and every 6 hours. With **Update automatically** on (Settings → Updates; the default, per device) a new version
  downloads in the background and the app asks to restart; off, it asks before downloading. Settings shows the
  version and has **Check for updates**; the phone app shows a download link instead. Releases are signed and built
  with `npm run release` (README → Releasing). The first version with updates has to be installed by hand.
- **Version in the title bar**: "My Assistant (ver. 0.4.2)", the release the build is published as. The dev version
  shows "(dev. ver. …)" with the version its changes will be released as (the newest GitHub release plus one).
- **Daily Feed**:
  - Topics in the reader's language (migration `015_feed_topic_names.sql`): each topic gets an English and a Chinese
    name from the light AI model when it's added (older topics the first time they're listed), used for the topic
    chips, feed tabs and titles.
  - A calendar: when the day buttons don't all fit, the ones that do are shown with a 📅 button that opens a month
    view of every day with a feed (up to a year back).

### Fixed
- **Phones**: the page header (title, description, tabs) scrolled while staying pinned, so the page slid underneath
  it. It now scrolls away with the page; only the slim top bar stays.

## [0.4.1] - 2026-10-15

Phone layout fixes, and the repository is public.

### Changed
- **Phones and narrow windows**: navigation is a drawer that slides in from the right (☰ in a slim top bar showing
  the page's name), closed by choosing a page or tapping the page behind it; it holds the role switcher, theme switch
  and account as on the desktop. The page never scrolls sideways: wide tables and tab rows scroll in their own box
  (table cells no longer wrap there, so columns keep their width).

## [0.4.0] - 2026-10-14

Ready for other users: daily allowances, storage limits, an activity log, a public HTTPS address, DeepSeek
translation, and the Android app.

### Added
- **Android app** (`src-tauri/gen/android`, `tauri.android.conf.json`): one window and no desktop extras (usage
  ball, desktop pet, online meetings, Save audio), microphone and notification permissions, release builds signed
  with the key in `C:\Users\User\.android-keys` (named in the git-ignored `gen/android/keystore.properties`).
- **Phone layout**: the app keeps clear of the status bar and gesture bar (edge-to-edge Android), and on narrow
  screens the top bar shows only the pages (plus the role switcher for accounts with several roles); the theme switch
  and account are in Settings. The narrow-screen rules had been overridden by the theme, so the brand and footer
  crowded the bar.
- **Daily allowances** (`Allowance`, migration `013_access_guards.sql`): translation words per day (Free 300, Paid
  3,000; the original text's words, Chinese and Japanese two characters per word) across the Translate page,
  recordings, live text and meetings, and 60 minutes of transcription a day on the Paid plan (live, recordings and
  meetings together, from the usage log). They replace the Free plan's 10 Translate requests a day (`Quota` removed).
  The General Tool shows today's use; the Super Admin isn't limited.
- **Audio storage allowance** (`Storage`): 125 MB per person, recordings and meetings together. A new recording that
  goes over removes the oldest recordings' audio (transcripts stay, marked "audio removed"), and the app says which.
  Recordings shows the storage used and has **Save audio…** (`GET /recordings/{id}/audio`, Tauri dialog plugin and a
  `save_file` command) to keep a copy on your own device.
- **Activity log** (`Activity`): every change, every sign-in attempt, and everything opened while the Super Admin views
  as someone, with role, result, IP and device (never request bodies); kept a year. Settings → Activity for the Super
  Admin, and for Admins (accounts below Admin). `TRUSTED_PROXY_HEADER` reads the real IP behind a tunnel.
- **Your devices** (Settings): where you're signed in; sign out one device or all others (`/auth/devices`).
- **Public address** `https://<your-tunnel-domain>` through a Cloudflare Tunnel (no router ports): an
  API-only Apache site on `127.0.0.1:8090` that routes every request to the API, so XAMPP's `/phpmyadmin` and other
  server-wide aliases can't be reached through it (they trust "from this machine", which tunnel traffic is); the
  `Cloudflared` service set up by `bin/setup-tunnel-service.ps1`; HTTPS forced at Cloudflare. The app's default server
  address is now the public one (set at build time in `app/.env.local`).
- **Nightly backups** (`bin/backup.php`, Task Scheduler "My Assistant Backup", 02:30): both databases as compressed
  dumps (kept 14 days) and a mirror of the recordings, on the second drive (`D:\backups\my-assistant`).
- **Sign-in lockout**: 5 failed attempts for a login (or 20 from one IP) in 15 minutes lock it for 15 minutes; a login
  that doesn't exist now takes as long to refuse as a wrong password.

### Fixed
- Daily Feed: the 8:00 job and the app's catch-up could build the same feed at once (paying twice; the second
  failed on a duplicate entry). Builds now take a per-user lock (`GET_LOCK`); a second caller returns at once.

### Changed
- **Translation goes to DeepSeek** (`TRANSLATE_PROVIDER=deepseek`; about a fortieth of Claude Opus's cost per word).
  Only the Super Admin can choose another model for a request (a `claude-`, `gpt-` or `deepseek-` model goes to its own
  provider; `Routing::translatorFor`); anyone else's `model` is ignored.
- **Changing your password signs you out everywhere**, this device included.
- `TRUSTED_PROXY_HEADER` is believed only for requests from this machine (the tunnel), so devices on the home network
  or Tailscale can't fake an IP to get round the sign-in lockout.
- **Admin** no longer has every PT module: Admins manage accounts below Admin and use the General Tool as Paid, and
  see PT only with a PT role of their own (which can now be set for Admins in Settings → Users).

## [0.3.0] - 2026-10-13

PT Management modules, Daily Feed, meetings, user groups and roles, provider usage and balances, the usage ball and
the desktop pet.

### Added

#### Accounts
- **User groups** (migration `005_user_groups.sql`, replacing `004_user_roles.sql`'s owner / member): Super Admin, Admin,
  General User (Free or Paid) and PT roles (Big Man, Manager, Low Man) per PT module (Operations, Maintenance,
  Planning) at view / add / manage (`Auth::requirePtModule`). `/auth/me` returns `access`, and the app shows only the
  pages and PT sections an account can use. Free plan: record (audio only) and 10 Translate requests a day
  (`translation_quota`, `Quota`). `bin/create-user.php` makes the first account the Super Admin. Sign-in accepts an
  email or a username; `POST /auth/password`, `GET/POST /users`, `POST /users/{id}`.
- **Roles** (migration `006_active_role.sql`): an account acts in one role at a time, picked after sign-in and switched
  from the sidebar ("Acting as"); the server applies it (`POST /auth/role`). The Super Admin has every role.
- **View as another account** (Super Admin): shows the app exactly as that account sees it, without signing in
  (`X-View-As` / `X-View-As-Role` headers, honoured only for the Super Admin's own sign-in; `viewed_by` says who is
  really there). Disabled accounts and the Super Admin can't be viewed.
- **Your name** (`POST /auth/profile`): the sidebar shows it instead of your login.

#### PT Management (ported from the standalone ptManagement app; data in its own `gba_database`)
- **Fleet**: manufacturers → models → buses, with specs, trip counts and last trip; add (edit access) and archive to
  the `removed_*` tables (admin).
- **Operations**: KPI tiles, zoomable trends (day / week / month), consumption by bus and by route, exceptions by type
  (hover for the buses, click to list the trips), SOC-drop distribution, per-bus table and a trip list. Upload .csv or
  .xlsx trip logs with a preview (`Pt\Xlsx`, a small built-in reader), manual entry, and duplicate resolution.
- **Seasonal consumption**: hot season (June–September, the Abu Dhabi summer) and mild season (October–May) side by side
  in the consumption tiles and the by-bus and by-route charts (`PairedBarList`, with the summer change in %).
  `/pt/operations` returns `consumption_hot` / `consumption_mild`; `PT_HOT_MONTHS` defines the season.
- **Drivers** (`GET /pt/drivers`, Operations module): which driver drove which bus (collapsed rows that expand), drivers
  by bus model, drivers who drive more than one model (flagging battery + hydrogen), Shift A / Shift B per driver, and
  energy performance: each driver's consumption on each bus against the model average, hot and mild season
  separately, their own consumption across all their models, and an overall score. Shifts aren't recorded, so each
  bus's day is split at the change of driver nearest mid-day (in half with no change; a single trip by start time).
- **Trials**: trial buses, trials with status, the Operations dashboard over trial trips with a fleet-average line,
  and promoting a trial bus to the fleet. Operations endpoints take `dataset=trial`.
- **Charging**: stations, chargers and guns; an overnight simulation (one lane per gun, drag to move or resize, power
  shared between guns), a "typical day" basis from recent trips, what-if parameters, and an **AI schedule** (DeepSeek
  picks guns, order and hold-backs for a goal; the server works out exact times).
- **Repair & Maintenance** (new; `gba-migrations/002`–`004`): work orders that are created and later closed when the
  workshop reports back, preventive plans with a due list, a dashboard (availability, cost per km, failures per
  10,000 km, work by category, downtime, repeat failures) and import from Access exports, matched by work-order number
  so newer exports update existing orders. `PT_CURRENCY` labels costs.
- `bin/migrate.php` also applies `database/gba-migrations/` to the PT database (`001_trial_fixes.sql`: trial model IDs
  are text, unique trial trip keys).

#### General Tool
- **Live transcription while recording** (migration `002_live_segments.sql`): audio is cut into chunks at pauses and
  each is transcribed (OpenAI, language auto-detected) and translated unless English, a few seconds behind speech.
  The full recording is saved on Stop. `POST /live`, `/live/{id}/chunk`, `/live/{id}/finish`.
- **Meetings** (paid; migration `008_meetings.sql`): records an online meeting (what the computer plays, via WASAPI
  loopback from a chosen output device, mixed with the microphone) or an in-person one, with live text labelled by
  speaker (`OPENAI_DIARIZE_MODEL`, default `gpt-4o-transcribe-diarize`). Speakers keep their labels across chunks and
  can be named during or after.
- **Learning from transcript edits** (paid; migration `007_transcript_habits.sql`, `Ai\Habits`): corrections become a
  short rule guide per language (Chinese through DeepSeek, others through OpenAI) applied to new transcripts.
- **Your own items**: edit and delete transcripts and translations; rename and delete recordings with their audio.
- Any-language → English translation for recordings and files (the Translate page stays Arabic → English); uploads
  are transcribed and translated in one step; saved recordings can be transcribed or translated again; recordings
  and transcripts carry the detected language.

#### Daily Feed (tab between PT Management and General Tool; migrations `009`–`011`, `Feed`, `pages/DailyFeed.tsx`)
- Users follow topics (new ones start the next day). Every morning at 8:00 (`bin/daily-feed.php`, Task Scheduler) the
  server builds the top stories of the past 24 hours from Google News and Bing News. A story counts only when at least
  two different outlets reported it (press-release wires excluded); DeepSeek picks the most important ones and drops
  duplicates of one event across a user's feeds.
- Each story's article is fetched and summarised in its own language (a paragraph and key points; Chinese stories by
  DeepSeek, others by OpenAI). Stories with nothing beyond the headline get no summary.
- **Chinese news**: a 中文 switch per topic. DeepSeek writes Chinese searches, run on Baidu News (newest first, further
  pages while still inside the 24 hours; searches spaced, stopped if Baidu asks for verification) and Google News'
  Chinese edition. On the paid plan they get their own tab of up to 15 stories, built first so they get first pick;
  Chinese stories aren't translated.
- Free plan: one combined feed, topics weighted equally, today only. Paid: one feed per topic and earlier days. Feed
  tabs sit in the sticky header. The Super Admin gets a desktop notification at 8:00 and the pet announces the feed;
  a missed run is built when the app next checks.

#### Usage
- **Usage from the providers** (migration `003_provider_usage_sync.sql`): syncs daily usage and billed cost from
  Anthropic (Usage & Cost Admin API) and OpenAI (Usage + Costs API); `GET /usage/providers`, `POST /usage/sync`,
  `bin/sync-usage.php [days]`. "All provider usage / This app only" switch.
- **Claude Code** usage from this computer's logs (tokens only; lighter orange than Anthropic).
- **Tokens with input and output apart**: Tokens (the default) draws input and output as side-by-side bars (output
  striped); Cost is unchanged.
- **Balances in the Sources panel**: DeepSeek's live from its API (granted credit vs topped up; a warning when too low);
  Anthropic and OpenAI have no balance API, so their rows link to their billing pages.
- **DeepSeek pricing** (migration `012_deepseek_prices.sql`): `deepseek-flash` (and the retired `deepseek-v4-flash`) and
  `deepseek-v4-pro` at peak rates. DeepSeek charges half off-peak (peak = 01:00–04:00 and 06:00–10:00 UTC on weekdays,
  except mainland China's public holidays), so each call is priced for its time when it's logged
  (`Usage::deepSeekCost`). Holidays come from the holiday-cn dataset (`ChinaHolidays`, cached in
  `storage/cn-holidays/`). `bin/backfill-deepseek-cost.php [--reprice]` prices earlier calls.
- **AI routing by job**, fixed on the server (`Ai\Routing`): translation → Claude, transcription and meetings → OpenAI,
  light tasks (e.g. language detection, so English never costs a translation) → DeepSeek. Shown on the Usage page.
- `ANTHROPIC_WORKSPACE_ID`: sent as `anthropic-workspace-id` for keys not scoped to a workspace.

#### Desktop
- **Usage ball** (Super Admin): a small always-on-top window with tokens today (green ↓ input, red ↑ output) and this
  month, one provider at a time with its name as a ribbon, including Claude Code. While the app is busy, the top half
  shows the job (recording, transcribing, uploading, imports, sync, AI planning) with a timer.
- **Desktop pet** (Super Admin; Settings → Desktop pet): plays an installed animation pack (蓝色小肥鱼 by PC2005-cloud,
  installed locally, not in the repo; see the README's credits), your own images per mood, or a built-in whale. Rules
  from the "Pet animation triggers" sheet (`lib/petRules.ts`): idle clips while you're away, wake-up clips when you
  return, typing, eating while tokens are used, git activity in watched repositories, seasonal clips, and sleep at
  night. While a browser is in front and no tokens are used, it pushes the ball around, away from the cursor.
  Click-through except over the pet.
- **Ball and pet hide during full screen** (another app full screen, borderless over its monitor, or a game or
  presentation).
- **Back to top** button on scrolled pages.
- **New look**: dark "deep space" and light themes (System / Light / Dark in the sidebar and Settings), Space Grotesk
  headings, and shared charts (`components/charts.tsx`) for PT and Usage.

### Changed
- The app is called **My Assistant** (the bundle identifier is unchanged, so settings and the stored login carry over).
- Navigation: PT Management, Daily Feed, General Tool (Translate, Recordings and Transcripts; a live recording keeps
  running while you look at the others), Usage, Settings.
- Page headers stay at the top while scrolling (frosted so content doesn't read through), and pages use the full
  window width.
- Transcripts read line by line, each original line with its English underneath (`components/LinePairs.tsx`); when the
  line counts differ, lines are aligned by length.
- AI providers are named only on the Usage page; elsewhere the app says "AI", and AI errors are generic (details go to
  the server log).
- Dates, times and numbers are always in English (British style: "15 May 2025", 24-hour clock, "125k", "$0.0044"),
  whatever the Windows display language; WebView2 starts in English too.
- Uploading no longer fails as a whole when transcription or translation fails: the file is kept and the error comes
  back as `transcribe_error` / `translate_error`.
- `APP_TIMEZONE=system` (the new default) follows the operating system's timezone; an IANA name still overrides it.
  Needs PHP's `intl` extension on Windows.
- PT figures vs. the original app: battery (kWh) and hydrogen (kg) energy are reported separately (the original added
  them); consumption is total energy ÷ total distance (the original summed per-trip ratios); high consumption is over
  140 kWh/100 km or 14 kg/100 km (the original flagged almost every trip); energy source and category are picked from
  lists; duplicates return 409; access levels are enforced.
- `.env.example` lists the PT settings and suggests `DEEPSEEK_MODEL=deepseek-flash`.

### Removed
- The provider choice for translation (pickers in the app and the `provider` parameter): the server decides.

### Fixed
- Bugs in the original PT app, fixed in the port: trial analysis queried a misspelled table and joined trials on the
  wrong column; adding a charging station or charger always failed; the charging simulation treated hydrogen buses'
  kg as kWh; "charged during the trip" was flagged on every normal trip; a manual-entry conflict failed the whole entry.
- Charging simulation: a bus whose last trip ends between 12:00 and 19:00 was scheduled the next afternoon.
- Daily Feed: Baidu stories dated "前天" / "7天前" (or undated) slipped past the 24-hour filter.
- Transcribing a chunk failed with "Invalid file format" (PHP's temp files have no extension); Whisper turned silence
  into text ("you"), now dropped.
- MySQL and PHP ran on different timezones, so timestamps were 4 hours apart; each connection now uses PHP's timezone.
- The `.env` loader read an inline comment as the value when the value was empty.
- Dev mode: the window could go blank after code changes that added a Tauri import (Tauri modules are pre-bundled).
- The native file picker showed inside the "Choose file" buttons; accounts without a name now always show their login.

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
