# chrisManager

The desktop app is called **My Assistant**. Personal toolkit: PT Management (Green Bus Assessment), audio recording, Arabic → English transcription/translation, data analysis,
and token-usage tracking across Claude, OpenAI and DeepSeek. Also a desktop usage ball and a desktop pet
(蓝色小肥鱼, the blue-haired maid by [PC2005-cloud](https://github.com/PC2005-cloud/dsh-pet); see
[Credits and sources](#credits-and-sources)).

```
Phone / laptop app ──(Tailscale)──► always-on desktop
                                     ├─ server/  PHP API (Apache, XAMPP)
                                     │    └─ AI relay: holds API keys, logs every call's tokens
                                     ├─ MySQL / MariaDB (localhost only)
                                     └─ server/storage/recordings (audio files)
```

| Folder | What |
|---|---|
| `server/` | PHP 8.2 API: auth, AI relay, usage, recordings |
| `server/database/migrations/` | Numbered SQL files, applied by `bin/migrate.php` |
| `app/` | Tauri 2 desktop client (React + TypeScript); see `app/README.md` |

## Setting up a dev machine

Needs: XAMPP (PHP 8.2+, MariaDB), Composer, Git. In `C:\xampp\php\php.ini`, enable
`extension=zip` and `extension=intl` (intl lets `APP_TIMEZONE=system` follow the Windows timezone),
then restart Apache.

1. Clone into `htdocs`: `git clone <repo-url> C:\xampp\htdocs\chrisManager`
2. Install dependencies:
   ```
   cd C:\xampp\htdocs\chrisManager\server
   composer install
   ```
3. Create the database and a dedicated user (in phpMyAdmin's SQL tab or `mysql -u root -p`):
   ```sql
   CREATE DATABASE chrismanager_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'chrismanager'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
   GRANT ALL PRIVILEGES ON chrismanager_dev.* TO 'chrismanager'@'localhost';
   ```
4. `copy .env.example .env`, then fill in `DB_PASS` and whichever API keys you use.
5. Run the migrations and create your login:
   ```
   C:\xampp\php\php.exe bin\migrate.php
   C:\xampp\php\php.exe bin\create-user.php you@example.com
   ```
6. Check it: <http://localhost/chrisManager/server/public/health> should return `{"ok":true,...}`.

Dev machines use `chrismanager_dev` with test data. Only the always-on desktop uses the real `chrismanager` database.

## The always-on desktop (production)

1. Same steps as above, but with `DB_NAME=chrismanager`, `APP_ENV=production` and `APP_DEBUG=false`.
2. XAMPP Control Panel → tick **Service** for Apache and MySQL so they start at boot.
3. Set a MySQL root password, and keep MySQL bound to localhost (`bind-address=127.0.0.1` in `my.ini`).
4. Install [Tailscale](https://tailscale.com) on the desktop, laptop and phone. The app then reaches
   `http://<desktop-tailscale-name>/chrisManager/server/public`. Don't port-forward on the router.
5. Windows Update → set active hours. BIOS → "restore on AC power loss".
6. **Backups** (Task Scheduler, nightly):
   ```
   C:\xampp\mysql\bin\mysqldump.exe -u chrismanager -p<pass> chrismanager > D:\backups\chrismanager-%date:~0,4%%date:~5,2%%date:~8,2%.sql
   ```
   Also copy `server\storage\recordings` and keep a copy off the machine.

Deploying an update: `git pull`, then `composer install`, then `php bin\migrate.php`.

## API

Every call except `/health` and `/auth/login` needs `Authorization: Bearer <token>`.

| Method | Path | Body / query | Does |
|---|---|---|---|
| GET | `/health` | | Liveness check |
| POST | `/auth/login` | `{email, password, device}` | Returns a per-device token |
| POST | `/auth/logout` | | Revokes the current token |
| POST | `/auth/profile` | `{display_name}` | Sets your own display name (empty: show your login) |
| GET | `/auth/me` | | Current user |
| GET | `/ai/routing` | | Which provider and model handle translation, transcription and light tasks |
| POST | `/ai/translate` | `{text, model?}` | Arabic text → English (Claude), saved and token-logged |
| POST | `/live` | `{title?, recorded_at?}` | Starts a live recording; returns `recording_id`, `transcript_id` |
| POST | `/live/{id}/chunk` | multipart `audio` (short clip), `seq`, `start_ms?`, `prompt?` | Transcribes one chunk (language auto-detected) and translates it unless English; returns `text`, `language`, `english` |
| POST | `/live/{id}/finish` | multipart `audio` (whole recording), `duration_sec?` | Saves the audio and returns the assembled transcript |
| POST | `/recordings` | multipart `audio`, `title?`, `recorded_at?`, `transcribe=1?` | Stores an audio file; with `transcribe`, also transcribes it and translates non-English speech. A failed step comes back as `transcribe_error` / `translate_error`; the file is kept |
| POST | `/recordings/{id}/transcribe` | | Re-transcribes a saved recording as a whole (replaces its text and clears the translation) |
| GET | `/recordings` | | Latest 200 recordings with transcript, detected `language` and English |
| GET | `/transcripts` | | Latest 200 transcripts (`translated_text` is null when English or not yet translated) |
| POST | `/transcripts/{id}/translate` | `{model?}` | Translates a saved transcript to English (no-op if English) |
| GET | `/usage/summary` | `?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day\|month\|model&view=providers\|app` | Token totals and cost: everything the providers report (default) or this app only |
| GET | `/usage/providers` | | Sync status per provider, DeepSeek balance |
| POST | `/usage/sync` | `{from?, to?}` | Pulls usage and billed cost from Anthropic and OpenAI (default: last 31 days) |
| POST | `/usage` | `{provider, model, input_tokens, output_tokens, note?, occurred_at?}` | Manual usage entry |

**AI routing** is fixed on the server, not chosen by the app:

| Job | Provider | Setting |
|---|---|---|
| Translation (Translate page, live chunks, files) | Claude | `TRANSLATE_PROVIDER=anthropic` |
| Transcription (speech → text) | OpenAI | `OPENAI_TRANSCRIBE_MODEL` (OpenAI is the only speech-to-text integration) |
| Light tasks (e.g. language detection) | DeepSeek | `LIGHT_PROVIDER=deepseek` |

In `/usage`, `provider` is `anthropic`, `openai` or `deepseek`.

Quick test from PowerShell:
```powershell
$base = "http://localhost/chrisManager/server/public"
$login = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType "application/json" `
  -Body '{"email":"you@example.com","password":"...","device":"pc"}'
$h = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod "$base/ai/translate" -Method Post -Headers $h -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"text":"مرحبا، كيف حالك؟"}'))
Invoke-RestMethod "$base/usage/summary?group=model" -Headers $h
```

## Users and PT Management

- **User groups** (Settings → Users; people sign in with a username or email):

  | Group | General Tool | PT Management | Usage + desktop ball | Manage users |
  |---|---|---|---|---|
  | Super Admin (first account) | ✓ | everything | ✓ | everyone |
  | Admin | ✓ | everything | – | users below Admin |
  | Free User | record (audio only) + 10 Translate requests a day; no transcription | – | – | – |
  | Paid User | ✓ | – | – | – |
  | PT Big Man | as Free (unless given Paid) | all modules, full rights | – | – |
  | PT Manager | as Free (unless given Paid) | own module: add, edit, close, delete, settings | – | – |
  | PT Low Man | as Free (unless given Paid) | own module: view and add | – | – |

  PT modules: Operations, Maintenance (Repair & Maintenance), Planning (Fleet, Trials, Charging). An account has a
  General Tool plan and a PT role separately, so someone can be e.g. a Paid User and a Maintenance Manager. The free
  plan saves recordings as audio only (no transcription) and allows 10 Translate requests a day. Recordings and
  transcripts are per person.
- **Roles:** people act in one role at a time. With several (e.g. Paid User and Maintenance Manager) they pick one
  after signing in and switch from the sidebar; the Super Admin has every role, which is also a way to see exactly
  what each group sees. The server enforces the active role. `POST /auth/role` `{role}` switches; `/auth/me` lists
  `roles` and `active_role`.
- **PT Management** is the Green Bus Assessment toolkit, ported from the standalone `ptManagement`
  app. Its data stays in its own database, `gba_database` (set `GBA_DB_NAME` to change it), which
  the app reaches with the same MySQL user unless `GBA_DB_USER` / `GBA_DB_PASS` are set:
  ```sql
  GRANT ALL PRIVILEGES ON gba_database.* TO 'chrismanager'@'localhost';
  ```

PT endpoints (each needs the module's level: view to read, add to add data, manage to change, close or delete):

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/pt/status` | | Whether `gba_database` is reachable, and row counts |
| GET | `/pt/manufacturers` | | Manufacturers with their models and bus counts |
| GET | `/pt/manufacturers/{key}` | | One manufacturer: model specs, buses with trip count and last trip |
| POST | `/pt/manufacturers` | `{manufacturer, display_name?, category}` | Adds a manufacturer (key: letters, digits, `_`, `-`) |
| POST | `/pt/models` | `{manufacturer, model, model_year, bus_type, energy_source, bus_length, …specs}` | Adds a model; id is `MANUFACTURER_MODEL_YEAR` |
| POST | `/pt/buses` | `{model_id, bus_id?, plate?}` | Adds a bus (`bus_id` is the fleet number used in trip logs) |
| POST | `/pt/buses/{id}` | `{plate}` | Sets a bus's plate |
| DELETE | `/pt/buses/{id}` | | Archives the bus to `removed_bus_db` (trips are kept) |
| DELETE | `/pt/models/{id}` | | Archives a model with no buses |
| DELETE | `/pt/manufacturers/{key}` | | Archives the manufacturer with all its models and buses |
| GET | `/pt/trips/options` | | Data date range, buses, routes, exception types and thresholds |
| GET | `/pt/operations` | `?from&to&bus?&route?&energy?` | KPIs, daily trend, per bus, per route, exception counts, SOC-drop bands |
| GET | `/pt/trips` | same, plus `issue? (code or any)&limit&offset` | Trips with their issue codes, newest first |
| POST | `/pt/trips/upload` | multipart `file` (.csv/.xlsx), `action=preview\|import`, `date_order=dmy\|mdy?` | Preview or save a trip-log file |
| POST | `/pt/trips` | `{date, driver_id, bus_id, route, trips: [{start_time, end_time, start_km, end_km, start_soc, end_soc}]}` | Manual trip entry |
| GET | `/pt/trips/duplicates` | | Uploaded trips that conflict with saved ones |
| POST | `/pt/trips/duplicates/{id}` | `{action: keep\|replace}` | Resolve a conflict (admin) |

| GET | `/pt/trials` · `/pt/trial-buses` | | Trials (with trip figures) and trial buses |
| POST | `/pt/trials` | `{trial_name, trial_bus_id, route?, start_date, end_date?, load_condition?, notes?}` | New trial |
| POST | `/pt/trials/{id}` | any of `{status, end_date, route, load_condition, notes}` | Update a trial |
| POST | `/pt/trial-buses` | `{bus_id (label), model_id, notes?}` | New trial bus |
| POST | `/pt/trial-buses/{id}/promote` | `{fleet_bus_id, plate?}` | Adds the trial bus to the fleet |
| GET | `/pt/charging/assets` | | Stations → chargers → guns |
| POST | `/pt/charging/stations` · `/pt/charging/chargers` | `{station_name}` · `{station_id, charger_id, gun_count, charger_output, one_gun_output, two_gun_output?, output_type?, location?}` | Add charging assets |
| DELETE | `/pt/charging/stations/{id}` · `/pt/charging/stations/{sid}/chargers/{cid}` | | Remove (admin; a station only when empty) |
| GET | `/pt/charging/demand` | `?date=` (default: latest normal service day) | Each electric bus's energy used and last trip end that day |

| GET | `/pt/maintenance/options` | | Fleet buses with odometer, types, systems, statuses, plans, currency |
| GET | `/pt/maintenance` | `?from&to&bus?&type?&category?&status?` | Work orders (plus all open ones) and dashboard figures |
| POST | `/pt/maintenance` · `/pt/maintenance/{id}` | `{bus_id, type, category, title, reported_date, status?, priority?, completed_date?, odometer_km?, downtime_hours?, labour_hours?, parts_cost?, labour_cost?, workshop?, plan_id?, description?}` | Add / update a work order |
| GET | `/pt/maintenance/plans` | | Preventive plans and each bus's due status |
| POST | `/pt/maintenance/plans` · `/pt/maintenance/plans/{id}` | `{name, category, model_id?, interval_km?, interval_days?, notes?}` · `{active}` | Add a plan / pause or resume it |
| DELETE | `/pt/maintenance/{id}` · `/pt/maintenance/plans/{id}` | | Delete (admin; a plan only when no work order uses it) |

The Operations endpoints (`/pt/trips/options`, `/pt/operations`, `/pt/trips`, upload and manual entry) work on
trial trips with `dataset=trial` (and `trial=ID` to pick one trial).

`php bin/migrate.php` also brings the PT database's schema up to date from `database/gba-migrations/`
(fixes to the imported ptManagement schema), tracked in that database's own `schema_migrations` table.

Trip energy is kWh for battery buses and kg of hydrogen for fuel-cell buses (`energy_capacity × SOC drop`),
so the two are always reported separately. Trip files need the columns Date, Driver ID, Bus ID, Route,
Start Time, End Time, Start KM, End KM, Start SOC, End SOC (any order and spacing).

## Usage from the providers

The Usage page's **All provider usage** view shows what the providers themselves report, not just
this app's calls:

| Provider | Source | Needs |
|---|---|---|
| Anthropic | Usage & Cost Admin API: daily tokens per model, billed cost | `ANTHROPIC_ADMIN_KEY` (an `sk-ant-admin...` key; Console → Settings → Admin keys; organizations only, not individual accounts) |
| OpenAI | Usage + Costs API: tokens, transcription seconds, billed cost | `OPENAI_ADMIN_KEY` (platform.openai.com → Settings → Organization → Admin keys) |
| DeepSeek | No usage-history API: only the balance is shown; usage comes from this app | `DEEPSEEK_API_KEY` |

Sync with the **Sync** button on the Usage page, or nightly with Task Scheduler:
```
C:\xampp\php\php.exe C:\xampp\htdocs\chrisManager\server\bin\sync-usage.php 3
```
Synced rows already include this app's calls, so the two are never added together.

## Token-usage costs

Costs come from the `model_prices` table (USD per million tokens). Anthropic prices are seeded.
Add rows for the OpenAI and DeepSeek models you use. When a price changes, insert a new row with
a later `effective_from` instead of editing the old one, so past costs stay correct.

## Credits and sources

The desktop pet can show third-party characters. They are **not stored in this repository**: they're installed on
each computer in the app's data folder (`%APPDATA%\com.chris.chrismanager\pet-pack` and `pet-skin`), and their
terms apply there. This project's own code doesn't change those terms.

| What | By | Source | Terms |
|---|---|---|---|
| 蓝色小肥鱼 / Q版蓝发小女仆: character and 106 animation clips (the pet's animation pack) | [PC2005-cloud](https://github.com/PC2005-cloud) | Original: <https://github.com/PC2005-cloud/dsh-pet>; clips taken from [Refining-colors/pet-with-you](https://github.com/Refining-colors/pet-with-you) | Open-source use allowed, **no commercial use**; derivative / re-skinned works must link the original repository <https://github.com/PC2005-cloud/dsh-pet> wherever they're shown |
| 鲸鱼娘 standing art (optional "your images" pet look) | Original character 上善无形 (Bilibili); DeepSeek maid whale-girl design ZipZipPipe (Bilibili) | Via [EDMOK/blue-fish-archive](https://github.com/EDMOK/blue-fish-archive) (`原始立绘/deepseek_whale.png`), background removed and resized | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): credit, non-commercial, share adaptations alike |
| Built-in whale (the pet without any pack or images) | This project | `app/src/components/Whale.tsx` | Same as this project |

The app shows these credits and links in Settings → Desktop pet and in the pet's right-click menu. If you publish this
project or a build of it, keep this section and don't bundle the third-party clips or images without following their
terms.

## Rules

- Never commit `.env` or API keys. Keep them in a password manager.
- Never edit a migration that has already run. Add `00N_description.sql` instead.
- `git pull` before you start, `git push` when you stop.
- Record every change in `CHANGELOG.md` under **Unreleased**.
