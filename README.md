# My Assistant

A personal toolkit. The desktop app is called **My Assistant**.

- **PT Management**: the Green Bus Assessment toolkit for an electric and hydrogen bus fleet: fleet, operations,
  drivers, trials, charging, and repair & maintenance.
- **Daily Feed**: the top verified news of the past 24 hours on your topics, built every morning at 8:00, with an
  optional Chinese-language feed.
- **General Tool**: translation, recording with live transcription and translation, meetings with speaker labels,
  and transcripts that learn from your corrections.
- **Usage**: tokens and cost across Claude, OpenAI, DeepSeek and Claude Code, with provider sync and balances.
- **English or 简体中文**: each account picks its language; the server's messages follow it.
- **Desktop companions**: an always-on-top usage ball, and a desktop pet (蓝色小肥鱼 by
  [PC2005-cloud](https://github.com/PC2005-cloud/dsh-pet); see [Credits and sources](#credits-and-sources)).

```
Apps ──HTTPS──► Cloudflare ──(tunnel, no open ports)──► always-on desktop
                https://<your-tunnel-domain>             ├─ Apache site 127.0.0.1:8090: server/public only
You (admin) ──(Tailscale)────────────────────────────────►├─ server/  PHP API (Apache, XAMPP)
                                     │    └─ AI relay: holds the API keys, logs every call's tokens
                                     ├─ MariaDB (localhost only): chrismanager + gba_database (PT data)
                                     └─ server/storage/ (recordings, caches)
```

| Folder | What |
|---|---|
| `server/` | PHP 8.2 JSON API: auth, AI relay, usage, recordings, Daily Feed, PT Management |
| `server/database/migrations/` | App database schema, numbered SQL files applied by `bin/migrate.php` |
| `server/database/gba-migrations/` | Fixes and additions to the PT database's schema (also applied by `bin/migrate.php`) |
| `server/bin/` | Command-line scripts (below) |
| `app/` | Tauri 2 desktop client (React 19 + TypeScript); see [app/README.md](app/README.md) |

## Setting up a dev machine

Needs XAMPP (PHP 8.2+, MariaDB), Composer and Git. In `C:\xampp\php\php.ini`, enable `extension=zip` and
`extension=intl` (intl lets `APP_TIMEZONE=system` follow the Windows timezone), then restart Apache.

1. Clone into `htdocs`: `git clone https://github.com/chrisred66/My-Assistant.git C:\xampp\htdocs\My-Assistant`
2. Install dependencies:
   ```
   cd C:\xampp\htdocs\My-Assistant\server
   composer install
   ```
3. Create the database and a dedicated user (phpMyAdmin's SQL tab, or `mysql -u root -p`):
   ```sql
   CREATE DATABASE chrismanager_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'chrismanager'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
   GRANT ALL PRIVILEGES ON chrismanager_dev.* TO 'chrismanager'@'localhost';
   GRANT ALL PRIVILEGES ON gba_database.* TO 'chrismanager'@'localhost';
   ```
4. `copy .env.example .env`, then fill in `DB_PASS` and the API keys you use (each setting is explained in the file).
5. Run the migrations and create your login (the first account is the Super Admin):
   ```
   C:\xampp\php\php.exe bin\migrate.php
   C:\xampp\php\php.exe bin\create-user.php you@example.com
   ```
6. Check it: <http://localhost/My-Assistant/server/public/health> should return `{"ok":true,...}`.

Dev machines use `chrismanager_dev` with test data. Only the always-on desktop uses the real `chrismanager` database.
For PT Management, import `gba_database` from an export of the ptManagement machine (the app shows a guide while it's
missing).

## The always-on desktop (production)

1. Same steps as above, with `DB_NAME=chrismanager`, `APP_ENV=production` and `APP_DEBUG=false`.
2. XAMPP Control Panel → tick **Service** for Apache and MySQL so they start at boot.
3. Set a MySQL root password and keep MySQL on localhost (`bind-address=127.0.0.1` in `my.ini`).
4. **Public address (Cloudflare Tunnel)**: people reach the server at `https://<your-tunnel-domain>`, with no
   ports opened on the router. Pieces:
   - `C:\xampp\apache\conf\extra\httpd-my-assistant.conf` (included from `httpd-vhosts.conf`): an Apache site on
     `127.0.0.1:8090` that serves `server/public` only and sends *every* request to the API, so XAMPP's server-wide
     aliases (`/phpmyadmin`, `/webalizer`, `/cgi-bin`, …), which only check "from this machine" (as tunnel traffic is),
     can't be reached.
   - Tunnel `my-assistant`: config and credentials in `C:\ProgramData\cloudflared` (SYSTEM, Administrators, owner),
     run by the **Cloudflared** Windows service with `tunnel --config … run`. Set up (and repaired) by
     `server\bin\setup-tunnel-service.ps1` in an administrator PowerShell; it refuses to start the tunnel if anything
     but the API answers on the site.
   - Cloudflare: SSL/TLS → Edge Certificates → **Always Use HTTPS** on. `TRUSTED_PROXY_HEADER=CF-Connecting-IP` in
     `.env` gives the sign-in lockout and activity log the real visitor IP (trusted only for requests from the tunnel).
   - [Tailscale](https://tailscale.com) stays for your own admin access to the desktop.
5. Windows Update → set active hours. BIOS → "restore on AC power loss". A UPS with its USB cable connected lets
   Windows shut down cleanly in a long power cut.

Deploying an update: `git pull`, `composer install`, then `php bin\migrate.php`.

### Scheduled tasks (Task Scheduler)

| When | Command | Does |
|---|---|---|
| Daily 08:00 ("My Assistant Daily Feed") | `C:\xampp\php\php-win.exe C:\xampp\htdocs\My-Assistant\server\bin\daily-feed.php` | Builds everyone's Daily Feed (skips feeds already built) |
| Nightly | `C:\xampp\php\php.exe C:\xampp\htdocs\My-Assistant\server\bin\sync-usage.php 3` | Pulls the last 3 days of usage and billed cost from Anthropic and OpenAI |
| Daily 02:30 ("My Assistant Backup") | `C:\xampp\php\php-win.exe C:\xampp\htdocs\My-Assistant\server\bin\backup.php` | Both databases (compressed dumps, kept `BACKUP_KEEP_DAYS`, default 14) and a mirror of the recordings to `BACKUP_DIR` (default `D:\backups\my-assistant`, a separate drive); log in `backup.log` there |

The backups are on this PC's second drive, which covers a failed system drive, a corrupted database or a mistake; copy
`D:\backups\my-assistant` somewhere off the machine now and then (a USB drive kept elsewhere, or a cloud folder).

### Other scripts

| Script | Does |
|---|---|
| `bin/migrate.php` | Applies new migrations to both databases |
| `bin/create-user.php <email>` | Creates an account (the first one is the Super Admin) |
| `bin/backfill-deepseek-cost.php [--reprice]` | Prices DeepSeek calls logged without a cost (`--reprice`: all of them again) |
| `bin/backup.php` | Runs the backup now |
| `bin/setup-tunnel-service.ps1` | (Re)sets up the tunnel service; administrator PowerShell |

## Users and roles

People sign in with a username or email. Settings → Users manages accounts.

| Group | General Tool | PT Management | Daily Feed | Usage, ball, pet | Manages users |
|---|---|---|---|---|---|
| Super Admin (first account) | ✓, no daily limits | everything | one feed per topic | ✓ | everyone |
| Admin | as Paid | only with a PT role of its own | one feed per topic | – | users below Admin |
| Paid User | ✓ incl. meetings and learning from edits; 3,000 words of translation and 60 minutes of transcription a day | – | one feed per topic, earlier days | – | – |
| Free User | record (audio only), 300 words of translation a day | – | one combined feed, today only | – | – |
| PT Big Man | as Free, unless given Paid | all modules, full rights | as their plan | – | – |
| PT Manager | as Free, unless given Paid | own module: add, edit, close, delete, settings | as their plan | – | – |
| PT Low Man | as Free, unless given Paid | own module: view and add | as their plan | – | – |

- PT modules: **Operations** (Operations, Drivers), **Maintenance** (Repair & Maintenance) and **Planning** (Fleet,
  Trials, Charging). The General Tool plan and the PT role are set separately, so someone can be a Paid User and a
  Maintenance Manager.
- People act in **one role at a time**. With several roles they pick one after signing in and switch from the sidebar
  ("Acting as"); the server enforces the active role. The Super Admin has every role, which also shows exactly what
  each group sees.
- The Super Admin can **view as** another account (button next to their name): the app shows that account's pages and
  data, without signing in as it.
- **Daily allowances** (reset at midnight): translation counts the words of the original text (Chinese and Japanese:
  two characters per word; text already in the target language is never translated); transcription counts minutes
  of audio, live recordings, transcribed recordings and meetings together. **Storage**: 125 MB of audio per person; when a new recording goes over,
  the oldest recordings' audio is removed (their transcripts stay), and "Save audio…" keeps a copy on your own device.
- **Security**: 5 wrong passwords for a login (or 20 from one network) within 15 minutes lock it for 15 minutes.
  Changing your password signs you out everywhere; Settings → Your devices lists your sign-ins and signs any out.
  Settings → **Activity** (Super Admin, and Admins for accounts below Admin) shows every change and sign-in, kept for a
  year; only the action is logged, never what was typed or recorded. Only the Super Admin can choose a different AI
  model for a request.

## AI providers

The server holds the API keys; the app never chooses a provider. Every call's tokens are logged to `token_usage`.

| Job | Provider | Setting |
|---|---|---|
| Translation | DeepSeek (`anthropic` for Claude) | `TRANSLATE_PROVIDER`, `DEEPSEEK_MODEL` |
| Transcription (speech → text) | OpenAI | `OPENAI_TRANSCRIBE_MODEL` |
| Meetings (speaker labels) | OpenAI | `OPENAI_DIARIZE_MODEL` |
| Light tasks (e.g. language detection) | DeepSeek | `LIGHT_PROVIDER`, `DEEPSEEK_MODEL` |
| Learning from transcript edits | DeepSeek for Chinese, OpenAI for other languages | `OPENAI_CHAT_MODEL` |
| Daily Feed: searches, ranking | DeepSeek | |
| Daily Feed: summaries | DeepSeek for Chinese stories, OpenAI for the rest | `OPENAI_CHAT_MODEL` |
| PT charging schedule | DeepSeek | |

The Usage page shows this table too (Super Admin).

### Usage and costs

The Usage page's **All provider usage** view shows what the providers report, not just this app's calls:

| Provider | Usage comes from | Balance | Needs |
|---|---|---|---|
| Anthropic | Usage & Cost Admin API (daily tokens per model, billed cost) | no API: link to the billing page | `ANTHROPIC_ADMIN_KEY` (`sk-ant-admin…`; Console → Settings → Admin keys; organizations only) |
| OpenAI | Usage + Costs API (tokens, transcription seconds, billed cost) | no API: link to the billing page | `OPENAI_ADMIN_KEY` (platform.openai.com → Settings → Organization → Admin keys) |
| DeepSeek | No usage API: this app's own calls | live from DeepSeek's API | `DEEPSEEK_API_KEY` |
| Claude Code | This computer's Claude Code logs (tokens only; subscription, no cost) | – | – |

Sync with the **Sync** button on the Usage page or the nightly task. Synced rows already include this app's calls, so
the two are never added together. Billed costs are used as reported; elsewhere cost is estimated from `model_prices`
(USD per million tokens). Anthropic and DeepSeek prices are seeded; add rows for the OpenAI models you use. When a price
changes, insert a row with a later `effective_from` instead of editing the old one, so past costs stay correct.

DeepSeek charges half outside peak hours (peak = 01:00–04:00 and 06:00–10:00 UTC on weekdays, except mainland China's
public holidays). `model_prices` holds the peak rates, and each DeepSeek call is priced for its time when it's logged.
Holiday dates come from the open [holiday-cn](https://github.com/NateScarlet/holiday-cn) dataset (built from the State
Council's notices), cached in `server/storage/cn-holidays/`.

## PT Management notes

- The PT data lives in its own database, `gba_database` (`GBA_DB_NAME`; `GBA_DB_USER` / `GBA_DB_PASS` if it needs a
  different MySQL user). `bin/migrate.php` keeps its schema up to date from `database/gba-migrations/`, tracked in that
  database's own `schema_migrations` table.
- Trip energy is kWh for battery buses and kg of hydrogen for fuel-cell buses, so the two are always reported
  separately. Consumption is total energy ÷ total distance; trips with an impossible distance (≤ 0 or over 500 km) are
  left out and listed as exceptions.
- Consumption is also split by season: hot (June–September, the Abu Dhabi summer, heavy air-conditioning load) and
  mild (October–May).
- **Shifts** aren't recorded, so each bus's day is split into Shift A (morning) and Shift B (evening) at the change of
  driver nearest mid-day; with no change, its trips are split in half; a bus with a single trip goes by start time.
- Trip files (.csv or .xlsx) need the columns Date, Driver ID, Bus ID, Route, Start Time, End Time, Start KM, End KM,
  Start SOC, End SOC (any order and spacing). Costs are labelled in `PT_CURRENCY` (default AED).

## API

Base address: `https://<your-tunnel-domain>` (on the server PC itself also `http://localhost/My-Assistant/server/public`). Every call except `/health` and `/auth/login` needs
`Authorization: Bearer <token>`. Responses are JSON.

**Accounts**

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/auth/login` | `{email (or username), password, device}` → a per-device token |
| POST | `/auth/logout` | Revokes the current token |
| GET | `/auth/me` | Current user, `roles`, `active_role` and `access` (what the account can do) |
| POST | `/auth/role` | `{role}`: switches the active role |
| POST | `/auth/profile` · `/auth/password` | Sets your display name and/or language (`en` · `zh`) · changes your password (signs out every device) |
| GET · DELETE | `/auth/devices` · `/auth/devices/{id}` | Your sign-ins · signs one out |
| POST | `/auth/devices/sign-out-others` | Signs out every device but this one |
| GET | `/activity` | `?user&from&to&limit&offset`: the activity log (Super Admin; Admins for accounts below Admin) |
| GET · POST | `/users` · `/users/{id}` | Lists, creates and edits accounts (Super Admin and Admin) |

**General Tool**

| Method | Path | Does |
|---|---|---|
| POST | `/ai/translate` | `{text, target?}`: any language → `target` (default the account's language), saved as a transcript (counts against the word allowance) |
| POST | `/live`, `/live/{id}/chunk`, `/live/{id}/finish` | Live recording: start, transcribe and translate each short chunk, save the audio |
| POST | `/recordings` | Multipart `audio`, `title?`, `transcribe=1?`: stores a recording, optionally transcribed and translated |
| GET | `/recordings` | Your latest 200 recordings with transcript and translation (`target_lang`) |
| GET | `/recordings/storage` · `/recordings/{id}/audio` | Your storage used of 125 MB · a recording's audio file, to save locally |
| POST · DELETE | `/recordings/{id}` | Renames · deletes a recording and its audio |
| POST | `/recordings/{id}/transcribe` | Transcribes a saved recording again |
| GET | `/transcripts` | Your latest 200 transcripts |
| POST · DELETE | `/transcripts/{id}` | Edits · deletes a transcript |
| POST | `/transcripts/{id}/translate` | `{target?}`: translates a transcript (default the account's language) |
| POST | `/transcripts/learn` | Learns from your corrections (paid) |
| GET · POST | `/transcripts/habits` | The learned rules; remove one or forget a language |
| POST | `/meetings`, `/meetings/{id}/chunk`, `/meetings/{id}/translate` | Meeting recording with speaker labels (paid) |
| GET · POST | `/meetings/{id}/speakers` | Speakers and their names |

**Daily Feed**

| Method | Path | Does |
|---|---|---|
| GET | `/feed` | `?date=`: that day's feeds (earlier days on the paid plan) |
| GET · POST | `/feed/topics` | Your topics · adds one (starts with tomorrow's feed) |
| POST · DELETE | `/feed/topics/{id}` | `{include_zh}`: Chinese news on or off · stops following |
| GET | `/feed/status` | Whether today's feed is ready |
| POST | `/feed/generate` | Builds today's feed now (`force` rebuilds it; Super Admin) |

**Usage** (Super Admin)

| Method | Path | Does |
|---|---|---|
| GET | `/ai/routing` | Which provider and model does each job |
| GET | `/usage/summary` | `?from&to&group=day\|month\|model&view=providers\|app`: tokens and cost |
| GET | `/usage/providers` | Sync status per provider and DeepSeek's balance |
| POST | `/usage/sync` | `{from?, to?}`: pulls usage and billed cost from Anthropic and OpenAI |
| POST | `/usage` | `{provider, model, input_tokens, output_tokens, note?, occurred_at?}`: manual entry |

**PT Management** (each needs the module's level: view to read, add to add, manage to change, close or delete)

| Method | Path | Does |
|---|---|---|
| GET | `/pt/status` | Whether `gba_database` is reachable, with row counts |
| GET · POST | `/pt/manufacturers` | Manufacturers with models and bus counts · adds one |
| GET · DELETE | `/pt/manufacturers/{key}` | One manufacturer's models and buses · archives it with its models and buses |
| POST · DELETE | `/pt/models` · `/pt/models/{id}` | Adds a model (id `MANUFACTURER_MODEL_YEAR`) · archives one with no buses |
| POST | `/pt/buses` | `{model_id, bus_id?, plate?}`: adds a bus (`bus_id` is the fleet number in trip logs) |
| POST · DELETE | `/pt/buses/{id}` | Sets the plate · archives the bus (trips are kept) |
| GET | `/pt/trips/options` | Data date range, buses, routes, exception types and thresholds |
| GET | `/pt/operations` | `?from&to&bus?&route?&energy?`: KPIs, trends, per bus and route (with hot / mild season), exceptions |
| GET | `/pt/trips` | Same filters plus `issue?&limit&offset`: trips with their issue codes |
| POST | `/pt/trips/upload` | Multipart `file`, `action=preview\|import`, `date_order=dmy\|mdy?`: trip-log upload |
| POST | `/pt/trips` | Manual trip entry |
| GET · POST | `/pt/trips/duplicates` · `/pt/trips/duplicates/{id}` | Conflicting uploaded trips · `{action: keep\|replace}` |
| GET | `/pt/drivers` | `?from&to`: each driver per bus (trips, shifts, consumption by season) and per driver |
| GET · POST | `/pt/trials` · `/pt/trials/{id}` | Trials with trip figures · adds or updates one |
| GET · POST | `/pt/trial-buses` | Trial buses · adds one |
| POST | `/pt/trial-buses/{id}/promote` | `{fleet_bus_id, plate?}`: adds the trial bus to the fleet |
| GET | `/pt/charging/assets` | Stations → chargers → guns |
| POST | `/pt/charging/stations` · `/pt/charging/chargers` | Adds a station · a charger |
| DELETE | `/pt/charging/stations/{id}` · `/pt/charging/stations/{sid}/chargers/{cid}` | Removes one (a station only when empty) |
| GET | `/pt/charging/demand` · `/pt/charging/history` | One day's energy per electric bus · a typical day from recent trips |
| POST | `/pt/charging/ai-schedule` | DeepSeek charging schedule for the simulation |
| GET | `/pt/maintenance/options` | Buses with odometer, types, categories, statuses, plans, currency |
| GET · POST | `/pt/maintenance` | `?from&to&bus?&type?&category?&status?`: work orders and dashboard · adds one |
| POST · DELETE | `/pt/maintenance/{id}` | Updates · deletes a work order |
| POST | `/pt/maintenance/{id}/close` · `/reopen` | Closes a work order when the workshop reports back · reopens it |
| POST | `/pt/maintenance/import` | Work orders from an Access export (.xlsx or .csv), with preview |
| GET · POST | `/pt/maintenance/plans` · `/pt/maintenance/plans/{id}` | Preventive plans and what's due · adds one, pauses or resumes it |
| DELETE | `/pt/maintenance/plans/{id}` | Deletes a plan no work order uses |

The Operations endpoints work on trial trips with `dataset=trial` (and `trial=ID` for one trial).

Quick test from PowerShell:
```powershell
$base = "http://localhost/My-Assistant/server/public"
$login = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType "application/json" `
  -Body '{"email":"you@example.com","password":"...","device":"pc"}'
$h = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod "$base/usage/summary?group=model" -Headers $h
```

## Credits and sources

The desktop pet can show third-party characters. They are **not stored in this repository**: they're installed on
each computer in the app's data folder (`%APPDATA%\com.chris.chrismanager\pet-pack` and `pet-skin`), and their
terms apply there. This project's own code doesn't change those terms.

| What | By | Source | Terms |
|---|---|---|---|
| 蓝色小肥鱼 / Q版蓝发小女仆: character and 106 animation clips (the pet's animation pack) | [PC2005-cloud](https://github.com/PC2005-cloud) | Original: <https://github.com/PC2005-cloud/dsh-pet>; clips taken from [Refining-colors/pet-with-you](https://github.com/Refining-colors/pet-with-you) | Open-source use allowed, **no commercial use**; derivative / re-skinned works must link the original repository <https://github.com/PC2005-cloud/dsh-pet> wherever they're shown |
| 鲸鱼娘 standing art (optional "your images" pet look) | Original character 上善无形 (Bilibili); DeepSeek maid whale-girl design ZipZipPipe (Bilibili) | Via [EDMOK/blue-fish-archive](https://github.com/EDMOK/blue-fish-archive) (`原始立绘/deepseek_whale.png`), background removed and resized | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): credit, non-commercial, share adaptations alike |
| Built-in whale (the pet without any pack or images) | This project | `app/src/components/Whale.tsx` | Same as this project |
| Chinese public holiday dates (DeepSeek off-peak pricing) | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) | Downloaded at run time, cached in `server/storage/cn-holidays/` | The project's MIT licence; the dates are from the State Council's notices |

The app shows the pet credits and links in Settings → Desktop pet and in the pet's right-click menu. If you publish
this project or a build of it, keep this section and don't bundle the third-party clips or images without following
their terms.

## Releasing

The desktop app updates itself from GitHub releases (Settings → Updates: automatic, or ask first). Updates must be
signed with the updater key, so build releases with:

```
cd app
npm run release -- "What's new (shown in the update prompt)"
```

It builds the signed installer and writes `app/release/`: the setup .exe and its `.sig`, the .msi, `latest.json` (what
the app checks, at `releases/latest/download/latest.json`) and `SHA256SUMS.txt`. Add the Android APK and upload
everything to the release `v<version>`. The key is read from `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) or from
`%USERPROFILE%\.android-keys\my-assistant-updater.key`; a plain `npm run tauri build` fails without it. The phone app
can't install updates itself: it shows a link to the new release.

## Licence

No licence is granted yet: you may read this code, but not copy, modify or redistribute it. The third-party pet
assets above have their own terms and aren't in this repository.

## Rules

- Never commit `.env` or API keys. Keep them in a password manager.
- Never commit or replace the signing keys (Android keystore, updater key). Losing the updater key means installed apps
  can't be updated any more.
- Never commit the pet's animation pack or images (`pet-pack/`, `pet-skin/`).
- Never edit a migration that has already run. Add `00N_description.sql` instead.
- `git pull` before you start, `git push` when you stop.
- Record every change in `CHANGELOG.md` under **Unreleased**.
