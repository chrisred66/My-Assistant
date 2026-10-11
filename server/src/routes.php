<?php

declare(strict_types=1);

/** @var ChrisManager\Router $router */

use ChrisManager\Ai\Routing;
use ChrisManager\Ai\Transcriber;
use ChrisManager\Ai\Translator;
use ChrisManager\Auth;
use ChrisManager\Db;
use ChrisManager\Env;
use ChrisManager\HttpException;
use ChrisManager\ProviderUsage;
use ChrisManager\Request;
use ChrisManager\Usage;

$router->get('/health', fn () => ['ok' => true, 'time' => date('c')]);

// --- Auth ---------------------------------------------------------------

// Body: {login (email or username), password, device}. "email" is accepted for older clients.
$router->post('/auth/login', fn (Request $r) => Auth::login(
    (string) ($r->input('login') ?? $r->input('email', '')),
    (string) $r->input('password', ''),
    (string) $r->input('device', 'unknown device'),
));

$router->post('/auth/logout', function (Request $r) {
    Auth::logout($r);
    return ['ok' => true];
});

$router->get('/auth/me', fn (Request $r) => Auth::publicUser(Auth::requireUser($r)));

// Body: {current, new}. Any signed-in user, for their own account.
$router->post('/auth/password', function (Request $r) {
    Auth::requireUser($r);
    Auth::changePassword($r->userId(), (string) $r->input('current', ''), (string) $r->input('new', ''));
    return ['ok' => true];
});

// --- Users (owner only) -------------------------------------------------------

$router->get('/users', function (Request $r) {
    Auth::requireOwner($r);
    return array_map(fn ($u) => Auth::publicUser($u) + ['disabled' => $u['disabled_at'] !== null, 'created_at' => $u['created_at']],
        Db::all('SELECT id, email, username, display_name, role, pt_access, disabled_at, created_at FROM users ORDER BY role, display_name, username, email'));
});

// Body: {username?, email?, display_name?, pt_access, password}. New accounts are members.
$router->post('/users', function (Request $r) {
    Auth::requireOwner($r);
    $username = trim((string) $r->input('username', '')) ?: null;
    $email    = strtolower(trim((string) $r->input('email', ''))) ?: null;
    if ($username === null && $email === null) {
        throw new HttpException(422, 'Give a username or an email');
    }
    if ($email !== null && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new HttpException(422, 'That email address is not valid');
    }
    $access = (string) $r->input('pt_access', 'view');
    if (!in_array($access, ['none', 'view', 'edit', 'admin'], true)) {
        throw new HttpException(422, 'pt_access must be none, view, edit or admin');
    }
    $password = (string) $r->input('password', '');
    Auth::checkPassword($password);
    if (Db::one('SELECT 1 FROM users WHERE username = ? OR email = ?', [$username ?? '', $email ?? '']) !== null) {
        throw new HttpException(409, 'That username or email is already used');
    }
    $id = Db::insert('users', [
        'email'         => $email,
        'username'      => $username,
        'display_name'  => mb_substr(trim((string) $r->input('display_name', '')), 0, 100),
        'role'          => 'member',
        'pt_access'     => $access,
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
    ]);
    return ['id' => $id];
});

// Body: any of {display_name, pt_access, disabled (bool), password}. The owner account itself can't be changed here.
$router->post('/users/{id}', function (Request $r) {
    Auth::requireOwner($r);
    $user = Db::one('SELECT id, role FROM users WHERE id = ?', [(int) $r->params['id']]);
    if ($user === null) {
        throw new HttpException(404, 'User not found');
    }
    if ($user['role'] === 'owner') {
        throw new HttpException(422, "The owner account can't be edited here");
    }
    $set = [];
    if ($r->input('display_name') !== null) {
        $set['display_name'] = mb_substr(trim((string) $r->input('display_name')), 0, 100);
    }
    if ($r->input('pt_access') !== null) {
        if (!in_array($r->input('pt_access'), ['none', 'view', 'edit', 'admin'], true)) {
            throw new HttpException(422, 'pt_access must be none, view, edit or admin');
        }
        $set['pt_access'] = $r->input('pt_access');
    }
    if ($r->input('disabled') !== null) {
        $set['disabled_at'] = filter_var($r->input('disabled'), FILTER_VALIDATE_BOOLEAN) ? date('Y-m-d H:i:s') : null;
    }
    if ((string) $r->input('password', '') !== '') {
        Auth::checkPassword((string) $r->input('password'));
        $set['password_hash'] = password_hash((string) $r->input('password'), PASSWORD_DEFAULT);
    }
    if ($set) {
        Db::run('UPDATE users SET ' . implode(', ', array_map(fn ($k) => "{$k} = ?", array_keys($set))) . ' WHERE id = ?',
            [...array_values($set), $user['id']]);
    }
    if (isset($set['disabled_at']) || isset($set['password_hash'])) {
        Db::run('DELETE FROM api_tokens WHERE user_id = ?', [$user['id']]); // sign them out everywhere
    }
    return ['ok' => true];
});

// --- AI routing -----------------------------------------------------------
// Providers are fixed per job on the server (see Ai\Routing); clients can't pick one.

$router->get('/ai/routing', function (Request $r) {
    Auth::requireOwner($r);
    return Routing::describe();
});

// --- Translation ----------------------------------------------------------

// Body: {text, model?}. Arabic -> English through the translation provider (Claude).
$router->post('/ai/translate', function (Request $r) {
    Auth::requireOwner($r);
    $text   = (string) $r->input('text', '');
    $result = Translator::translate($r->userId(), $text, $r->input('model') ?: null);

    $id = Db::insert('transcripts', [
        'user_id'            => $r->userId(),
        'source_text'        => $text,
        'translated_text'    => $result->text,
        'translate_provider' => Routing::translator()->name(),
        'translate_model'    => $result->model,
    ]);

    return [
        'id'          => $id,
        'translation' => $result->text,
        'model'       => $result->model,
        'usage'       => ['input_tokens' => $result->inputTokens, 'output_tokens' => $result->outputTokens],
    ];
});

// --- Recordings -----------------------------------------------------------

$audioTypes = ['audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/wav' => 'wav',
               'audio/x-wav' => 'wav', 'audio/webm' => 'webm', 'video/webm' => 'webm', 'audio/ogg' => 'ogg',
               'video/mp4' => 'mp4', 'audio/flac' => 'flac'];

$recordingFile = fn (array $rec): string =>
    dirname(__DIR__) . '/' . trim(Env::get('STORAGE_PATH', 'storage/recordings'), '/') . '/' . $rec['file_path'];

$ownRecording = function (Request $r, int $id): array {
    $rec = Db::one('SELECT * FROM recordings WHERE id = ? AND user_id = ?', [$id, $r->userId()]);
    if ($rec === null) {
        throw new HttpException(404, 'Recording not found');
    }
    return $rec;
};

/** Validates an uploaded audio field. @return array{tmp: string, mime: string, ext: string, size: int, name: string} */
$uploadedAudio = function (string $field) use ($audioTypes): array {
    $file = $_FILES[$field] ?? null;
    if ($file === null || $file['error'] !== UPLOAD_ERR_OK) {
        throw new HttpException(422, "Upload an audio file in the \"{$field}\" field");
    }
    if ($file['size'] > (int) Env::get('MAX_UPLOAD_MB', '25') * 1024 * 1024) {
        throw new HttpException(413, 'File too large');
    }
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']) ?: '';
    if (!isset($audioTypes[$mime])) {
        throw new HttpException(415, "Unsupported audio type {$mime}");
    }
    return ['tmp' => $file['tmp_name'], 'mime' => $mime, 'ext' => $audioTypes[$mime], 'size' => (int) $file['size'],
            'name' => mb_substr((string) $file['name'], 0, 255)];
};

/** Moves an uploaded file into storage and returns its path relative to STORAGE_PATH. */
$storeAudio = function (Request $r, array $audio) use ($recordingFile): string {
    $relative = sprintf('%d/%s/%s.%s', $r->userId(), date('Y/m'), bin2hex(random_bytes(8)), $audio['ext']);
    $absolute = $recordingFile(['file_path' => $relative]);
    if (!is_dir(dirname($absolute)) && !mkdir(dirname($absolute), 0770, true)) {
        throw new HttpException(500, 'Cannot create storage folder');
    }
    if (!move_uploaded_file($audio['tmp'], $absolute)) {
        throw new HttpException(500, 'Cannot save upload');
    }
    return $relative;
};

/** Sets a live transcript's text from its segments, in order. English is the translation, or the original where a segment was English. */
$rebuildTranscript = function (int $transcriptId): array {
    $segments = Db::all(
        'SELECT language, source_text, english_text FROM transcript_segments WHERE transcript_id = ? ORDER BY seq',
        [$transcriptId],
    );
    $source     = implode("\n", array_column($segments, 'source_text'));
    $translated = array_filter($segments, fn ($s) => $s['english_text'] !== null);
    $english    = $translated ? implode("\n", array_map(fn ($s) => $s['english_text'] ?? $s['source_text'], $segments)) : null;
    $languages  = array_count_values(array_filter(array_column($segments, 'language')));
    arsort($languages);
    $language   = array_key_first($languages);

    Db::run(
        'UPDATE transcripts SET source_text = ?, translated_text = ?, source_lang = COALESCE(?, source_lang) WHERE id = ?',
        [$source, $english, $language, $transcriptId],
    );
    return ['text' => $source, 'english' => $english, 'language' => $language];
};

/** Translates a transcript to English (skipped when it is English) and stores the result. */
$translateTranscript = function (Request $r, int $transcriptId, string $text, ?string $language): array {
    $t = Translator::toEnglish($r->userId(), $text, $language, $r->input('model') ?: null);
    Db::run(
        'UPDATE transcripts SET translated_text = ?, translate_provider = ?, translate_model = ?,
                source_lang = COALESCE(?, source_lang) WHERE id = ?',
        [$t['english'], $t['provider'], $t['model'], $t['language'], $transcriptId],
    );
    return ['transcript_id' => $transcriptId, 'language' => $t['language'], 'english' => $t['english']];
};

// Whole-file speech-to-text. One transcript per recording: re-transcribing replaces the text
// (and any live segments) and clears the old translation.
$transcribeRecording = function (Request $r, array $rec) use ($recordingFile): array {
    if ($rec['file_path'] === '') {
        throw new HttpException(409, 'This recording has no saved audio');
    }
    set_time_limit(300);
    $heard = Transcriber::transcribe($r->userId(), $recordingFile($rec), $rec['mime_type']);
    Db::run('UPDATE recordings SET duration_sec = COALESCE(?, duration_sec) WHERE id = ?', [$heard['duration'], $rec['id']]);

    $existing = Db::one('SELECT id FROM transcripts WHERE recording_id = ? ORDER BY id DESC LIMIT 1', [$rec['id']]);
    if ($existing !== null) {
        $id = (int) $existing['id'];
        Db::run('DELETE FROM transcript_segments WHERE transcript_id = ?', [$id]);
        Db::run(
            'UPDATE transcripts SET source_text = ?, source_lang = COALESCE(?, source_lang), transcribe_model = ?,
                    translated_text = NULL, translate_provider = NULL, translate_model = NULL WHERE id = ?',
            [$heard['text'], $heard['language'], $heard['model'], $id],
        );
    } else {
        $id = Db::insert('transcripts', array_filter([
            'user_id'          => $r->userId(),
            'recording_id'     => $rec['id'],
            'source_lang'      => $heard['language'],
            'source_text'      => $heard['text'],
            'transcribe_model' => $heard['model'],
        ], fn ($v) => $v !== null));
    }
    return ['transcript_id' => $id, 'text' => $heard['text'], 'language' => $heard['language']];
};

// Upload a finished audio file. Field "audio" (+ optional "title", "recorded_at", "transcribe"=1).
// "transcribe" also translates to English when the speech isn't English ("translate"=1 is accepted as an alias).
// Once the file is saved the upload succeeds; a failed step comes back as "transcribe_error" /
// "translate_error" so it can be retried on its own.
$router->post('/recordings', function (Request $r) use ($uploadedAudio, $storeAudio, $ownRecording, $transcribeRecording, $translateTranscript) {
    Auth::requireOwner($r);
    $audio       = $uploadedAudio('audio');
    $recordingId = Db::insert('recordings', [
        'user_id'       => $r->userId(),
        'file_path'     => $storeAudio($r, $audio),
        'original_name' => $audio['name'],
        'mime_type'     => $audio['mime'],
        'size_bytes'    => $audio['size'],
        'title'         => mb_substr((string) $r->input('title', ''), 0, 255),
        'recorded_at'   => $r->input('recorded_at') ?: null,
    ]);

    $response = ['id' => $recordingId];
    $wanted   = filter_var($r->input('transcribe', false), FILTER_VALIDATE_BOOLEAN)
             || filter_var($r->input('translate', false), FILTER_VALIDATE_BOOLEAN);
    if (!$wanted) {
        return $response;
    }
    try {
        $response += $transcribeRecording($r, $ownRecording($r, $recordingId));
    } catch (HttpException $e) {
        return $response + ['transcribe_error' => $e->getMessage()];
    }
    try {
        $t = $translateTranscript($r, $response['transcript_id'], $response['text'], $response['language']);
        $response['language'] = $t['language'];
        $response['english']  = $t['english'];
    } catch (HttpException $e) {
        $response['translate_error'] = $e->getMessage();
    }
    return $response;
});

$router->post('/recordings/{id}/transcribe', function (Request $r) use ($ownRecording, $transcribeRecording) {
    Auth::requireOwner($r);
    return $transcribeRecording($r, $ownRecording($r, (int) $r->params['id']));
});

$router->get('/recordings', function (Request $r) {
    Auth::requireOwner($r);
    return Db::all(
        'SELECT r.id, r.title, r.original_name, r.mime_type, r.size_bytes, r.duration_sec, r.recorded_at, r.created_at,
                t.id AS transcript_id, t.source_lang AS language, t.source_text, t.translated_text
           FROM recordings r
           LEFT JOIN transcripts t ON t.id = (SELECT MAX(t2.id) FROM transcripts t2 WHERE t2.recording_id = r.id)
          WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 200',
        [$r->userId()],
    );
});

$router->get('/transcripts', function (Request $r) {
    Auth::requireOwner($r);
    return Db::all(
        "SELECT id, recording_id, source_lang AS language, source_text, translated_text, translate_provider, translate_model, created_at
           FROM transcripts WHERE user_id = ? AND source_text <> '' ORDER BY created_at DESC LIMIT 200",
        [$r->userId()],
    );
});

// Translate a saved transcript to English (skipped if it is English). Body: {model?}.
$router->post('/transcripts/{id}/translate', function (Request $r) use ($translateTranscript) {
    Auth::requireOwner($r);
    $t = Db::one('SELECT id, source_text, source_lang FROM transcripts WHERE id = ? AND user_id = ?', [(int) $r->params['id'], $r->userId()]);
    if ($t === null) {
        throw new HttpException(404, 'Transcript not found');
    }
    return $translateTranscript($r, (int) $t['id'], $t['source_text'], $t['source_lang']);
});

// --- Live recording ---------------------------------------------------------
// The app records continuously and sends short, self-contained chunks (cut at pauses) while it records.
// Each chunk is transcribed (language auto-detected) and, if not English, translated; the text comes
// straight back. On stop, the app uploads the whole recording to /finish.

// Body: {title?, recorded_at?}. Returns the ids the chunks and /finish refer to.
$router->post('/live', function (Request $r) {
    Auth::requireOwner($r);
    $recordingId = Db::insert('recordings', [
        'user_id'     => $r->userId(),
        'file_path'   => '',
        'title'       => mb_substr((string) $r->input('title', ''), 0, 255),
        'recorded_at' => $r->input('recorded_at') ?: date('Y-m-d H:i:s'),
    ]);
    $transcriptId = Db::insert('transcripts', [
        'user_id'          => $r->userId(),
        'recording_id'     => $recordingId,
        'source_text'      => '',
        'transcribe_model' => Env::get('OPENAI_TRANSCRIBE_MODEL', 'whisper-1'),
    ]);
    return ['recording_id' => $recordingId, 'transcript_id' => $transcriptId];
});

$liveTranscriptId = function (Request $r, array $rec): int {
    $t = Db::one('SELECT id FROM transcripts WHERE recording_id = ? ORDER BY id DESC LIMIT 1', [$rec['id']]);
    if ($t === null) {
        throw new HttpException(404, 'This recording has no live transcript');
    }
    return (int) $t['id'];
};

// Multipart: "audio" (one chunk), "seq" (0, 1, 2, ...), optional "start_ms", "prompt" (preceding text).
$router->post('/live/{id}/chunk', function (Request $r) use ($ownRecording, $liveTranscriptId, $uploadedAudio, $rebuildTranscript) {
    Auth::requireOwner($r);
    $rec          = $ownRecording($r, (int) $r->params['id']);
    $transcriptId = $liveTranscriptId($r, $rec);
    $audio        = $uploadedAudio('audio');
    $seq          = max(0, (int) $r->input('seq', 0));

    $heard = Transcriber::transcribe($r->userId(), $audio['tmp'], $audio['mime'], null, $r->input('prompt') ?: null, 'live_transcribe');
    if ($heard['text'] === '') {
        return ['seq' => $seq, 'text' => '', 'language' => null, 'english' => null];
    }

    $language = $heard['language'];
    $english  = null;
    $error    = null;
    try {
        // Low effort keeps each chunk's translation quick enough to feel live.
        $t        = Translator::toEnglish($r->userId(), $heard['text'], $language, null, 'low', 'live_translate');
        $language = $t['language'];
        $english  = $t['english'];
        if ($t['model'] !== null) {
            Db::run('UPDATE transcripts SET translate_provider = ?, translate_model = ? WHERE id = ?',
                [$t['provider'], $t['model'], $transcriptId]);
        }
    } catch (HttpException $e) {
        $error = $e->getMessage();
    }

    Db::run(
        'INSERT INTO transcript_segments (transcript_id, seq, start_ms, language, source_text, english_text)
              VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE start_ms = VALUES(start_ms), language = VALUES(language),
                                 source_text = VALUES(source_text), english_text = VALUES(english_text)',
        [$transcriptId, $seq, $r->input('start_ms') !== null ? max(0, (int) $r->input('start_ms')) : null,
         $language, $heard['text'], $english],
    );
    $rebuildTranscript($transcriptId);

    return ['seq' => $seq, 'text' => $heard['text'], 'language' => $language, 'english' => $english]
        + ($error !== null ? ['translate_error' => $error] : []);
});

// Multipart: "audio" (the whole recording), optional "duration_sec".
$router->post('/live/{id}/finish', function (Request $r) use ($ownRecording, $liveTranscriptId, $uploadedAudio, $storeAudio, $recordingFile, $rebuildTranscript) {
    Auth::requireOwner($r);
    $rec          = $ownRecording($r, (int) $r->params['id']);
    $transcriptId = $liveTranscriptId($r, $rec);
    $audio        = $uploadedAudio('audio');

    $relative = $storeAudio($r, $audio);
    if ($rec['file_path'] !== '') {
        @unlink($recordingFile($rec)); // finished twice: keep only the latest upload
    }
    $duration = $r->input('duration_sec');
    Db::run(
        'UPDATE recordings SET file_path = ?, original_name = ?, mime_type = ?, size_bytes = ?, duration_sec = ? WHERE id = ?',
        [$relative, $audio['name'], $audio['mime'], $audio['size'], is_numeric($duration) ? round((float) $duration, 2) : null, $rec['id']],
    );
    return ['id' => (int) $rec['id'], 'transcript_id' => $transcriptId] + $rebuildTranscript($transcriptId);
});

// --- Token usage ----------------------------------------------------------

$dateRange = function (string $from, string $to): void {
    foreach ([$from, $to] as $d) {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) || strtotime($d) === false) {
            throw new HttpException(422, 'Dates must be YYYY-MM-DD');
        }
    }
    if ($from > $to) {
        throw new HttpException(422, '"from" must not be after "to"');
    }
};

// ?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|month|model&view=providers|app
$router->get('/usage/summary', function (Request $r) use ($dateRange) {
    Auth::requireOwner($r);
    $from = (string) $r->query('from', date('Y-m-01'));
    $to   = (string) $r->query('to', date('Y-m-d'));
    $dateRange($from, $to);
    $view = (string) $r->query('view', 'providers');
    return ['from' => $from, 'to' => $to, 'view' => $view,
            'rows' => Usage::summary($r->userId(), $from, $to, (string) $r->query('group', 'day'), $view)];
});

// Sync state per provider and DeepSeek's balance.
$router->get('/usage/providers', function (Request $r) {
    Auth::requireOwner($r);
    return ProviderUsage::status();
});

// Pull usage and billed cost from Anthropic and OpenAI for a range (default: the last 31 days).
// Body: {from?, to?}. Ranges are capped at 366 days.
$router->post('/usage/sync', function (Request $r) use ($dateRange) {
    Auth::requireOwner($r);
    $to   = (string) ($r->input('to') ?: date('Y-m-d'));
    $from = (string) ($r->input('from') ?: date('Y-m-d', strtotime("{$to} -30 days")));
    $dateRange($from, $to);
    if ((strtotime($to) - strtotime($from)) / 86400 > 366) {
        throw new HttpException(422, 'Sync at most 366 days at a time');
    }
    set_time_limit(300);
    return ['from' => $from, 'to' => $to, 'results' => ProviderUsage::syncAll($from, $to)];
});

// Manual entry, e.g. usage from tools that don't go through this relay.
$router->post('/usage', function (Request $r) {
    Auth::requireOwner($r);
    $provider = (string) $r->input('provider', '');
    if (!in_array($provider, ['anthropic', 'openai', 'deepseek'], true)) {
        throw new HttpException(422, 'provider must be anthropic, openai or deepseek');
    }
    Usage::log([
        'user_id'       => $r->userId(),
        'provider'      => $provider,
        'model'         => (string) $r->input('model', 'unknown'),
        'feature'       => (string) $r->input('feature', 'manual'),
        'input_tokens'  => max(0, (int) $r->input('input_tokens', 0)),
        'output_tokens' => max(0, (int) $r->input('output_tokens', 0)),
        'source'        => 'manual',
        'note'          => mb_substr((string) $r->input('note', ''), 0, 255),
        'occurred_at'   => $r->input('occurred_at') ?: date('Y-m-d H:i:s'),
    ]);
    return ['ok' => true];
});
