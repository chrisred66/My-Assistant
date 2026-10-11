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
| `app/` | Tauri 2 client (desktop + mobile), coming in the next phase |

## Setting up a dev machine

Needs: XAMPP (PHP 8.2+, MariaDB), Composer, Git.

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
| POST | `/ai/translate` | `{text, provider?, model?}` | Arabic text → English, saved and token-logged |
| POST | `/recordings` | multipart `audio`, `title?`, `recorded_at?`, `translate=1?`, `provider?` | Stores audio; optionally transcribes and translates it |
| GET | `/recordings` | | Latest 200 recordings with their translations |
| GET | `/transcripts` | | Latest 200 transcripts |
| GET | `/usage/summary` | `?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day\|month\|model` | Token totals and cost |
| POST | `/usage` | `{provider, model, input_tokens, output_tokens, note?, occurred_at?}` | Manual usage entry |

`provider` is `anthropic`, `openai` or `deepseek` (default: `TRANSLATE_PROVIDER`).

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

## Token-usage costs

Costs come from the `model_prices` table (USD per million tokens). Anthropic prices are seeded.
Add rows for the OpenAI and DeepSeek models you use. When a price changes, insert a new row with
a later `effective_from` instead of editing the old one, so past costs stay correct.

## Rules

- Never commit `.env` or API keys. Keep them in a password manager.
- Never edit a migration that has already run. Add `00N_description.sql` instead.
- `git pull` before you start, `git push` when you stop.
