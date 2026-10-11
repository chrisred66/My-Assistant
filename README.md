# chrisManager

Personal toolkit: audio recording, Arabic → English transcription/translation, data analysis,
and token-usage tracking across Claude, OpenAI and DeepSeek.

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

- **Roles:** the first account is the `owner` (everything). Other people get `member` accounts,
  created in Settings → Users, that only see **PT Management** at their access level: `view`,
  `edit` (add, upload) or `admin` (also remove). They sign in with a username or email.
- **PT Management** is the Green Bus Assessment toolkit, ported from the standalone `ptManagement`
  app. Its data stays in its own database, `gba_database` (set `GBA_DB_NAME` to change it), which
  the app reaches with the same MySQL user unless `GBA_DB_USER` / `GBA_DB_PASS` are set:
  ```sql
  GRANT ALL PRIVILEGES ON gba_database.* TO 'chrismanager'@'localhost';
  ```

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

## Rules

- Never commit `.env` or API keys. Keep them in a password manager.
- Never edit a migration that has already run. Add `00N_description.sql` instead.
- `git pull` before you start, `git push` when you stop.
- Record every change in `CHANGELOG.md` under **Unreleased**.
