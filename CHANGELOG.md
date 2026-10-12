# Changelog

All notable changes to chrisManager. Newest first.
Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

When you change something, add a line under **Unreleased** in the right group
(Added / Changed / Fixed / Removed / Security). When you cut a release, rename
Unreleased to the version and date, and bump the app version in
`app/package.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/tauri.conf.json`.

## [Unreleased]

### Added
- **Animation-pack pet** (`components/PackPet.tsx`). The pet can play an installed pack of transparent WebM clips
  (`pet-pack/pack.json` + clips in the app data folder, served over Tauri's asset protocol, scoped to that folder):
  idle loop with a weighted random routine (festival clips only in their months), run/drag/sleep/work loops, and
  one-off clips for clicks, petting, 吃Token / 吃白饭 when tokens are used, meals at meal times, and a token-tier clip
  when clicked. Settings → Desktop pet → Character picks the pack, your images or the whale. Installed locally (not in
  the repo): 蓝色小肥鱼 by PC2005-cloud (https://github.com/PC2005-cloud/dsh-pet; non-commercial, link required),
  via Refining-colors/pet-with-you. Pet window now 250 x 262.
- **Your own pet character.** Settings → Desktop pet → Look: an image per mood (idle, swimming, eating, happy, sleepy,
  hungry, busy, being dragged; PNG/GIF/WebP, animated GIFs work), stored in the app data folder (`pet-skin/`, Rust
  `pet_skin.rs`). Missing moods borrow from related ones; the rice bowl, Zzz, hearts and thought bubble are drawn
  around the image, which is animated (bob, hop, chew, dangle) and mirrored to match the swimming direction.
- **Ball and pet hide during full screen** (`fullscreen.rs`): while another app is full screen, in a borderless window
  covering its monitor, or Windows reports a full-screen game or presentation, and come back afterwards.
- **Desktop pet** (Super Admin; Settings → Desktop pet; window `pet`, `DesktopPet.tsx`, `components/Whale.tsx`). An original
  chubby blue whale (drawn in SVG) that swims freely around the screen. It eats a bowl of white rice (吃大白饭) whenever
  tokens are used (an AI job in the app finishing, or the day's total going up, checked every 30 s including Claude
  Code) and gets rounder as the day's tokens grow; wears headphones while recording or in a meeting and shows other
  jobs in a thought bubble; sleeps 23:00–06:00 and gets hungry at meal times. Click: today's tokens per provider (in
  / out). Stroke it: hearts. Double-click: open My Assistant. Drag: move it. Right-click: Stay here / Swim around, or
  put it away.
- **Meetings** (paid plan; migration `008_meetings.sql`, `Meeting`, `pages/MeetingPanel.tsx`). Recordings → Meeting records
  an online meeting (what the computer plays, captured natively with WASAPI loopback in `src-tauri/src/system_audio.rs`,
  from a chosen output device, mixed with your microphone) or an in-person one (microphone), with live text labelled
  by speaker. Short chunks (3.5–8 s) go to OpenAI's diarization model (`OPENAI_DIARIZE_MODEL`, default
  `gpt-4o-transcribe-diarize`); each speaker's voice sample (`meeting_speakers`) is sent with later chunks so labels
  stay the same, and English arrives from a separate call (`POST /meetings/{id}/translate`) so text shows first.
  Speakers can be named during or after the meeting; the saved transcript reads "Name: …" per turn. "Transcribe
  again" re-labels the whole meeting. Also new: `POST /meetings`, `/meetings/{id}/chunk`, `/meetings/{id}/speakers`;
  recordings have a `kind`; live transcripts and meetings share `Meeting::rebuild`.
- **View as another account** (Super Admin). A button next to your name in the sidebar lists accounts; choosing one
  shows the app exactly as that account sees it (its pages, data, plan and roles) until "Back to my account". Nothing
  is signed in or stored: requests carry `X-View-As` / `X-View-As-Role`, honoured only for the Super Admin's own
  sign-in (`Auth::requireUser`), and `viewed_by` in the user says who is really there. Their password and name can't
  be changed while viewing (`Auth::requireOwnSession`); disabled accounts and the Super Admin can't be viewed. Anything
  done while viewing is done as that account.
- **Learning from transcript edits** (migration `007_transcript_habits.sql`, `Ai\Habits`). Correcting the original text
  of a recording's transcript keeps the before/after (`transcript_corrections`); the app then learns from it in the
  background (`POST /transcripts/learn`), turning the changed passages into a short rule guide per language group
  (`transcript_habits`): Chinese through DeepSeek, every other language through OpenAI (`OPENAI_CHAT_MODEL`). New
  transcripts (whole recordings and live chunks) pass through the guide before they're saved. Transcripts → "Learned
  from your edits" lists the rules, removes one or forgets a language, and learns edits still waiting. Paid plan only.
- **Your own items.** Edit and delete transcripts and translations (`POST`/`DELETE /transcripts/{id}`), rename and
  delete recordings with their audio (`POST`/`DELETE /recordings/{id}`). The Translate page lists your translations.
- **Input and output apart.** On the Usage page, Tokens (default) draws input and output as separate bars side by side
  in every chart (output striped, with an In / Out key and both in the tooltips); Cost is unchanged. The ball shows today's input
  (green down arrow) and output (red up arrow) with the month's total below, and the provider's name as a ribbon
  across the top of the disc (ball window now 128 x 138).

- **Claude Code on the Usage page.** "All provider usage" now includes Claude Code, read from this computer's Claude Code
  logs (`claude_code_usage` returns per-message model and token detail; `app/src/lib/claudeCode.ts` groups it by day,
  month or model). Tokens only (input + cache writes + output; subscription, so no cost), in a lighter orange than
  Anthropic (`--series-claude_code`). The desktop ball uses the same helper and its Claude Code ring is now that
  lighter orange instead of violet.
- **Back to top.** A floating button in the content area appears once a page is scrolled down and scrolls back to the
  top (`components/BackToTop.tsx`).
- **Roles.** An account acts in one role at a time (migration `006_active_role.sql`, `api_tokens.active_role`, kept per
  sign-in). The Super Admin has every role (Super Admin, Admin, General Tool Free / Paid, PT Big Man, and Manager and Low
  Man for each PT module); others have the roles their groups give (a PT role includes the General Tool as Free).
  Accounts with several roles choose one in a picker after sign-in, before the main window, and switch from the
  sidebar ("Acting as"). The server applies the active role (`Auth::availableRoles`, `Auth::withRole`,
  `POST /auth/role`), so acting as e.g. a Free User really is one; the Super Admin's Usage data and desktop ball keep
  working in any role.
- **User groups** (migration `005_user_groups.sql`): `role` super_admin | admin | user, `general_plan` none | free | paid,
  `pt_role` none | big_man | manager | staff ("Low Man") and `pt_module` operations | maintenance | planning replace
  `owner`/`member` and `pt_access`. Super Admin: everything; Admin: everything except Usage/AI costs, manages users below
  Admin; Free / Paid: General Tool (free: 10 translations a day, `translation_quota` table, `Quota` class; each
  Translate request or translated recording counts once); PT roles per module at view / add / manage
  (`Auth::requirePtModule`; Planning = Fleet, Trials, Charging). `/auth/me` returns `access` (what the account can
  do); the app shows only those pages and PT sections, and Settings → Users edits role, plan, PT role and module.
  `bin/create-user.php` makes the first account the Super Admin.
- Desktop ball: **Claude Code** is the 4th item (violet), tokens today and this month read from Claude Code's local
  session logs (`~/.claude/projects/**/*.jsonl`) by a Rust command (`src-tauri/src/claude_code.rs`); messages are
  de-duplicated, and tokens are input + cache writes + output (cache reads left out).
- **New look and a theme switch.** `src/theme.css` restyles the app on top of the existing layout: dark "deep space" (navy
  black, faint cyan/violet glows and grid, frosted-glass sidebar, cards and tables, electric-cyan accent, gradient primary
  buttons, glowing focus rings and active nav item) and a matching cool-white light theme; Space Grotesk (bundled,
  `@fontsource-variable/space-grotesk`, OFL) for headings, the brand and large numbers; pill tab bars; uppercase field and
  table labels; thin scrollbars. Theme switch (System / Light / Dark) in the sidebar and Settings → Appearance,
  remembered per device and applied before the first render (`lib/theme.ts`). Chart colours unchanged (re-checked on the
  new backgrounds).
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
- **PT Fleet section**: manufacturers → models → buses, ported from ptManagement's manufacturer pages.
  Overview tiles and manufacturer list; per-manufacturer model specs and buses with trip count and last
  trip date. Edit access adds manufacturers, models (model id `MANUFACTURER_MODEL_YEAR`, as before) and
  buses (with a chosen fleet number, since trip logs refer to buses by number) and sets plates; admin access
  removes buses, empty models or a whole manufacturer, copying rows to the `removed_*` tables first.
  Endpoints: `GET/POST /pt/manufacturers`, `GET/DELETE /pt/manufacturers/{key}`, `POST /pt/models`,
  `DELETE /pt/models/{id}`, `POST /pt/buses`, `POST/DELETE /pt/buses/{id}`.
- **PT Operations section** (ported from ptManagement's operation monitoring and trip-log upload):
  - Dashboard for a date range / bus / route / energy type: KPI tiles, distance by day (by month for long
    ranges), electric and hydrogen consumption trends with the high-consumption line, consumption by bus,
    exceptions by type (click to list them), distance by route, SOC-drop distribution, per-bus table and a
    paged trip list with issue badges.
  - Upload `.csv` or `.xlsx` trip logs with a preview (new / already there / conflicting, skipped rows and
    why, buses not in the fleet, day/month date order) before saving; extra columns are kept in `extra_data`.
    `.xlsx` is read by a small built-in reader (`Pt\Xlsx`; PhpSpreadsheet would need the gd extension).
  - Manual entry of a driver's trips; conflicting duplicates shown side by side, resolved by admins
    (keep the saved trip or use the uploaded one).
  - Endpoints: `GET /pt/trips/options`, `GET /pt/operations`, `GET /pt/trips`, `POST /pt/trips/upload`,
    `POST /pt/trips`, `GET /pt/trips/duplicates`, `POST /pt/trips/duplicates/{id}`.
- PT Fleet list: each manufacturer row has **Add model…** (edit) and **Remove…** (admin), and every model
  shows how many buses it has. The add-manufacturer form explains the short ID (what it's for, that it
  starts every model ID, and that it can't be changed) and fills it in from the name.
- PT Operations:
  - Trend charts (distance, electric and hydrogen consumption) can be zoomed: drag across a chart, or set
    From/To; grouping is automatic (day up to ~3 months, then week, then month) or chosen by hand.
  - Hovering an exception type lists the buses it comes from, with their trip counts
    (`exception_buses` in `GET /pt/operations`).
  - New "Energy consumption by route" chart (electric kWh/100 km and hydrogen kg/100 km).
  - The Trips list is folded by default and loads when opened; clicking an exception type opens it.
- **PT Trials section**: trial buses (a label plus a model from Fleet), trials (one trial bus on a route for a
  period, with status), adding a trial bus to the fleet, and the same dashboard as Operations over trial trips
  only — with a trial picker and a **fleet average (same days)** line on the consumption charts. Trial trip
  logs are uploaded or entered against a trial; the Bus ID column is optional (rows naming another bus are
  skipped). Endpoints: `GET/POST /pt/trials`, `POST /pt/trials/{id}`, `GET/POST /pt/trial-buses`,
  `POST /pt/trial-buses/{id}/promote`; the Operations endpoints take `dataset=trial` (and `trial=ID`).
- **PT Charging section** (ported from ptManagement's charging simulation):
  - Charging assets: stations, chargers and their guns; add (edit) and remove (admin; a station only when empty).
  - Overnight simulation for an operating day: one lane per gun on a 19:00→19:00 timeline, an automatic first
    schedule, drag to move a session (also to another gun) or drag its edges to resize, 10-minute snapping.
    Delivered energy follows how the charger's power is shared (one gun alone vs both guns).
    Tiles for energy needed / delivered / short, buses not fully charged and peak power; a site power-draw
    chart; per-bus schedule table; station and gun picker.
  - **Typical day** basis: plan from each electric bus's last 14–90 days of trips (all days, Mon–Fri or Sat–Sun),
    with its average, 85th-percentile or highest daily energy and its usual last-trip end and first departure
    (`GET /pt/charging/history`).
  - **AI schedule (DeepSeek)**: for what the simulation shows (day or typical day, selected guns, reserve, efficiency,
    ad-hoc parameters), DeepSeek chooses each bus's gun, the order on each gun and any hold-back time for a chosen
    goal (charge everyone, lowest peak, night tariff, fewest guns) plus free-text instructions; the server works out
    the exact times so every session covers the bus's full energy (`POST /pt/charging/ai-schedule`, edit access,
    logged under Usage as `charging_schedule`). The result loads into the timeline, stays draggable and responds to
    parameter changes; a table compares it with the schedule it replaced, and it can be undone.
  - **Adjust parameters…**: what-if values for one simulation only (never saved): each charger's one-gun and
    two-gun output, each bus's maximum intake, the plug-in delay after the last trip and the gap between sessions.
    Adjusted values recompute delivery at once; "Auto-schedule again" re-plans with them; "Back to saved values" resets.
  - Endpoints: `GET /pt/charging/assets`, `POST /pt/charging/stations`, `DELETE /pt/charging/stations/{id}`,
    `POST /pt/charging/chargers`, `DELETE /pt/charging/stations/{sid}/chargers/{cid}`, `GET /pt/charging/demand`.
- **PT Repair & Maintenance section** (new; the original app had none). Migration `gba-migrations/002_maintenance.sql`
  adds `maintenance_db` (work orders) and `maintenance_plan_db` (preventive plans) to the PT database.
  - Work orders per fleet bus: type (preventive, repair, breakdown, inspection, accident, warranty), system,
    priority, status, reported/completed dates, odometer, downtime, labour hours, parts and labour cost, workshop;
    open ones always listed; inline status changes; edit (edit access) and delete (admin).
  - Preventive plans every N km and/or N days, for all buses or one model; a due list (overdue / due soon /
    no service recorded yet) from the last completed work order for the plan and each bus's latest odometer in
    the trip logs; "Log service…" pre-fills the work order. Plans can be paused; deleted only when unused.
  - Dashboard: open work orders, fleet availability (bus-hours not lost to downtime), cost (and per km), failures
    (and per 10,000 km), cost by month (parts / labour), work orders by system and by type, downtime by bus,
    repeat failures (same bus and system failing more than once).
  - Work orders have two steps: **create** (bus, type, category, work, priority, open status, reported date, workshop,
    odometer, plan, details) and **close** when the workshop reports back (closing date, completed or cancelled, and
    optionally downtime, labour and costs, plus a closing note). Closed work orders can be reopened. The workshop is
    chosen from the manufacturers (defaulting to the bus's own). Open work orders are listed first; closed ones are
    folded. Migration `gba-migrations/003_maintenance_closing.sql` adds `closing_note`.
    Endpoints: `POST /pt/maintenance/{id}/close`, `POST /pt/maintenance/{id}/reopen`.
  - "Work by category" chart: each category's share of work orders, cost or downtime. The "System" field is now
    called Category.
  - **Import from Access** (`POST /pt/maintenance/import`, .xlsx or .csv export): columns are mapped to fields
    (guessed from common names) and the export's wording for type, category, status, priority and workshop is mapped
    to the app's values (guessed from keywords); both are remembered per file layout (`maintenance_import_map_db`).
    Rows are matched by work-order number (`source` + `external_ref`, migration `gba-migrations/004_maintenance_import.sql`),
    so a newer export updates existing work orders, e.g. adding closing dates and costs. Preview shows new / updated /
    unchanged rows and skipped ones with the reason (buses are matched by fleet number or plate).
  - Preventive maintenance moved to the bottom of the page, folded.
  - `PT_CURRENCY` (default AED) labels costs. Endpoints: `GET /pt/maintenance/options`, `GET/POST /pt/maintenance`,
    `POST/DELETE /pt/maintenance/{id}`, `GET/POST /pt/maintenance/plans`, `POST/DELETE /pt/maintenance/plans/{id}`.
- `.env.example`: the PT settings (`GBA_DB_NAME`, `GBA_DB_USER`, `GBA_DB_PASS`, `PT_CURRENCY`) were missing.
- `bin/migrate.php` also applies `database/gba-migrations/*.sql` to the PT database (tracked in its own
  `schema_migrations`). First one, `001_trial_fixes.sql`: `trial_fleet_db.model_id` INT → VARCHAR(50) (model
  IDs are text, so a trial bus could never be linked to its model) and a unique key on
  `trial_triplog_db.entry_key`. The trial tables were empty.
- **Your name** in Settings (`POST /auth/profile`): the sidebar shows it instead of your login.
- **Charts** for PT and Usage (`components/charts.tsx`: columns, lines with crosshair, bars; fixed colour
  slots and status colours, light and dark): fleet by manufacturer and by model; Usage cost/tokens by
  provider and a running total.
- **Desktop usage ball** (owner): a small always-on-top, frameless, transparent window (`ball` in `tauri.conf.json`,
  `src/UsageBall.tsx`) showing tokens used today and this month, one provider at a time, switching every 6 seconds and
  refreshing every 2 minutes. Drag it anywhere (position remembered); double-click to bring up the main window. Switch
  it on in Settings → Desktop usage ball. Closing the main window now quits the app (and the ball).
  While the main window is busy, the ball splits: the top half shows the activity with an icon and a timer (recording
  with a pulsing red mic; transcribing, translating, uploading, trip and work-order imports, usage sync, AI planning),
  the bottom half keeps the rotating usage. The main window reports activities over Tauri events (`lib/activity.ts`).

### Changed
- The Super Admin account manages users (create, change groups) whatever role it is acting in.
- The user category "General Tool" is now "General User" (role labels "General User · Free / Paid", the role picker,
  Settings → Users). The General Tool page keeps its name.
- Free plan: record (audio only) and 10 Translate requests a day; no transcription (live chunks, transcribe on upload
  and re-transcribing are refused, `Auth::requireTranscription`; the app records without sending chunks and hides the
  transcribe/translate buttons). PT users without a General plan of their own get the General Tool as Free
  (`Auth::generalPlan`); `/auth/me` reports `access.general_plan` and `access.transcribe`.
- Usage, AI routing and the desktop ball are Super Admin only; the General Tool needs a General plan (or Admin);
  PT endpoints check the module and level instead of one PT access level.
- The Usage page opens showing tokens (the Cost / Tokens switch now starts on Tokens).
- Provider colours (Usage page and desktop ball): Anthropic orange, OpenAI black (white in dark mode and on the ball),
  DeepSeek blue.
- Dates, times and numbers are always in English (British style: "15 May 2025", "11 Oct 2026, 20:37", 24-hour
  clock, "125k", "### Changed
.0044"), whatever the Windows display language (`LOCALE` in `lib/format.ts`). The desktop windows
  also start WebView2 in English (`--lang=en-GB`), so date pickers and other browser-drawn text are English too.
- AI providers are named only on the Usage page. Elsewhere the app says "AI" (Translate, Recordings, the charging AI
  schedule), and server errors from AI calls are generic ("The AI service rejected the server's API key…"), with the
  provider details written to the server error log. The AI routing card moved from Settings to Usage, with a row for
  the PT charging schedule.
- Page headers stay at the top while scrolling: title, description and section tabs on PT Management and General Tool
  (the tools' own headers moved up into it), and the header on Usage and Settings.
- The AI, recordings, transcripts and usage endpoints are owner-only (members get 403).
- The app is now called **My Assistant** (window title, sidebar, sign-in screen, installer name). The
  bundle identifier is unchanged, so saved settings and the stored login carry over.
- Navigation: PT Management first; Translate, Recordings and Transcripts grouped under one **General Tool**
  tab (a live recording keeps running while you look at the other two).
- PT Operations vs. the original app:
  - Electric (kWh) and hydrogen (kg) energy are reported separately; the original added them together.
  - Consumption is total energy ÷ total distance; the original summed per-trip ratios
    (`avg_efficiency`), and its KPI "energy used" summed consumption figures instead of energy.
  - Trips with an impossible distance (≤ 0 or over 500 km) are left out of distance and energy totals
    and listed as exceptions.
  - High consumption uses 140 kWh/100 km (electric) and 14 kg/100 km (hydrogen); the original compared
    per-100-km values to 1.4, flagging almost every trip.
- Usage chart: the y-axis margin fits its labels (large and small dollar amounts were cut off).
- PT Fleet vs. the original app: energy source and manufacturer category are picked from a list
  (Electric, Hydrogen, Hybrid, Diesel) instead of free text; duplicate models and manufacturers return 409;
  removal and adding now check access levels (the original app never enforced `access_level`).

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
- Dev mode: the main window could go blank after code changes that added a new Tauri import (the dev server re-bundled
  dependencies while it was open). The Tauri modules are now pre-bundled (`optimizeDeps.include` in `vite.config.ts`).
- Charging simulation: a bus whose last trip ends between 12:00 and 19:00 was placed at the end of the 19:00→19:00
  window (e.g. a session the next afternoon); it's now available from 19:00.
- The native file picker showed inside the "Choose file" buttons on the trip-log and maintenance uploads.
- The sidebar showed `null`-name accounts' login only by accident of an empty string; a missing name now
  always falls back to the username or email.
- PT Trials and Charging (bugs in the original app, fixed in the port): trial analysis queried a misspelled
  table with unset variables, and the trial list joined trials to buses on the wrong column; adding a charging
  station always failed (`station_id` has no auto-increment) and so did adding a charger (the required
  location was never sent); the charging simulation scheduled hydrogen buses, reading kg of hydrogen as kWh.
- PT (bugs in the original app's logic, fixed in the port): "charged during the trip" was flagged when SOC
  went *down* (every normal trip); manual trip entry wrote to a `triplog_duplicates` column that doesn't
  exist, so any conflict failed the whole entry.
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
