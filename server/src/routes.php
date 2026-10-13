<?php

declare(strict_types=1);

/** @var ChrisManager\Router $router */

use ChrisManager\Ai\Habits;
use ChrisManager\Ai\Language;
use ChrisManager\Ai\Routing;
use ChrisManager\Ai\Transcriber;
use ChrisManager\Ai\Translator;
use ChrisManager\Auth;
use ChrisManager\Db;
use ChrisManager\Env;
use ChrisManager\Feed;
use ChrisManager\HttpException;
use ChrisManager\Meeting;
use ChrisManager\ProviderUsage;
use ChrisManager\Quota;
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

// Body: {role}. Act in another of your roles (see Auth::availableRoles) on this sign-in; returns the user in that role.
$router->post('/auth/role', fn (Request $r) => Auth::publicUser(Auth::switchRole($r, (string) $r->input('role', ''))));

// Body: {current, new}. Any signed-in user, for their own account.
$router->post('/auth/password', function (Request $r) {
    Auth::requireOwnSession(Auth::requireUser($r));
    Auth::changePassword($r->userId(), (string) $r->input('current', ''), (string) $r->input('new', ''));
    return ['ok' => true];
});

// Body: {display_name}. Any signed-in user, for their own account; empty clears it (the login is shown instead).
$router->post('/auth/profile', function (Request $r) {
    $user = Auth::requireOwnSession(Auth::requireUser($r));
    Db::run('UPDATE users SET display_name = ? WHERE id = ?', [mb_substr(trim((string) $r->input('display_name', '')), 0, 100), $user['id']]);
    return Auth::publicUser(Auth::requireUser($r));
});

// --- Users (Super Admin and Admins) ---------------------------------------------
// Groups (see Auth): role super_admin | admin | user; general_plan none | free | paid; pt_role none | big_man |
// manager | staff with pt_module operations | maintenance | planning. Admins manage only role "user" accounts.

/** Validated group fields from the body; $partial allows leaving fields out (updates). */
$groupFields = function (Request $r, bool $partial): array {
    $f = [];
    $enum = function (string $key, array $allowed) use ($r, $partial, &$f): void {
        $v = $r->input($key);
        if ($v === null && $partial) {
            return;
        }
        $v = (string) ($v ?? $allowed[0]);
        if (!in_array($v, $allowed, true)) {
            throw new HttpException(422, "{$key} must be one of: " . implode(', ', $allowed));
        }
        $f[$key] = $v;
    };
    $enum('role', ['user', 'admin']);
    $enum('general_plan', ['none', 'free', 'paid']);
    $enum('pt_role', ['none', 'big_man', 'manager', 'staff']);
    if ($r->input('pt_module') !== null || !$partial) {
        $m = (string) ($r->input('pt_module') ?? '');
        $f['pt_module'] = in_array($m, Auth::PT_MODULES, true) ? $m : null;
    }
    // Managers and Low Man belong to one module; others have none.
    if (isset($f['pt_role'])) {
        if (in_array($f['pt_role'], ['manager', 'staff'], true) && empty($f['pt_module'])) {
            throw new HttpException(422, 'Choose the PT module for a Manager or Low Man');
        }
        if (!in_array($f['pt_role'], ['manager', 'staff'], true)) {
            $f['pt_module'] = null;
        }
    }
    return $f;
};

$router->get('/users', function (Request $r) {
    $me = Auth::requireUserAdmin($r);
    return array_map(fn ($u) => Auth::publicUser($u) + [
        'disabled' => $u['disabled_at'] !== null, 'created_at' => $u['created_at'], 'editable' => Auth::canManage($me, $u),
    ], Db::all(
        "SELECT id, email, username, display_name, role, general_plan, pt_role, pt_module, disabled_at, created_at FROM users
          ORDER BY FIELD(role, 'super_admin', 'admin', 'user'), display_name, username, email",
    ));
});

// Body: {username?, email?, display_name?, role?, general_plan, pt_role, pt_module?, password}.
$router->post('/users', function (Request $r) use ($groupFields) {
    $me = Auth::requireUserAdmin($r);
    $username = trim((string) $r->input('username', '')) ?: null;
    $email    = strtolower(trim((string) $r->input('email', ''))) ?: null;
    if ($username === null && $email === null) {
        throw new HttpException(422, 'Give a username or an email');
    }
    if ($email !== null && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new HttpException(422, 'That email address is not valid');
    }
    $groups = $groupFields($r, false);
    if (!Auth::canManage($me, ['id' => 0, 'role' => 'user'], $groups['role'])) {
        throw new HttpException(403, 'Only the Super Admin can create Admins');
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
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
    ] + $groups);
    return ['id' => $id];
});

// Body: any of {display_name, role, general_plan, pt_role, pt_module, disabled (bool), password}.
$router->post('/users/{id}', function (Request $r) use ($groupFields) {
    $me = Auth::requireUserAdmin($r);
    $user = Db::one('SELECT id, role, pt_role, pt_module FROM users WHERE id = ?', [(int) $r->params['id']]);
    if ($user === null) {
        throw new HttpException(404, 'User not found');
    }
    $set = $groupFields($r, true);
    if (!Auth::canManage($me, $user, $set['role'] ?? null)) {
        throw new HttpException(403, $user['role'] === 'super_admin' ? "The Super Admin account can't be edited here"
            : ((int) $user['id'] === (int) $me['id'] ? 'Change your own details under My account' : 'Only the Super Admin can change Admins'));
    }
    // A module change alone keeps the PT role; a role needing a module must end up with one.
    if (isset($set['pt_module']) && !isset($set['pt_role']) && !in_array($user['pt_role'], ['manager', 'staff'], true)) {
        $set['pt_module'] = null;
    }
    if (isset($set['pt_role']) && in_array($set['pt_role'], ['manager', 'staff'], true) && empty($set['pt_module'] ?? $user['pt_module'])) {
        throw new HttpException(422, 'Choose the PT module for a Manager or Low Man');
    }
    if ($r->input('display_name') !== null) {
        $set['display_name'] = mb_substr(trim((string) $r->input('display_name')), 0, 100);
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
    if (array_key_exists('disabled_at', $set) && $set['disabled_at'] !== null || isset($set['password_hash'])) {
        Db::run('DELETE FROM api_tokens WHERE user_id = ?', [$user['id']]); // sign them out everywhere
    }
    return ['ok' => true];
});

// --- AI routing -----------------------------------------------------------
// Providers are fixed per job on the server (see Ai\Routing); clients can't pick one.

$router->get('/ai/routing', function (Request $r) {
    Auth::requireSuper($r);
    return Routing::describe();
});

// --- Translation ----------------------------------------------------------

// Body: {text, model?}. Arabic -> English through the translation provider (Claude).
$router->post('/ai/translate', function (Request $r) {
    $user = Auth::requireGeneral($r);
    $text   = (string) $r->input('text', '');
    // Free plan: a new Translate request needs a slot today (each request is its own item).
    if (!Quota::allows($user, 'translate:new')) {
        throw new HttpException(429, Quota::message());
    }
    $result = Translator::translate($r->userId(), $text, $r->input('model') ?: null);

    $id = Db::insert('transcripts', [
        'user_id'            => $r->userId(),
        'source_text'        => $text,
        'translated_text'    => $result->text,
        'translate_provider' => Routing::translator()->name(),
        'translate_model'    => $result->model,
    ]);
    Quota::consume($user, "translate:{$id}");

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
$rebuildTranscript = fn (int $transcriptId): array => Meeting::rebuild($transcriptId);

/** Translates a transcript to English (skipped when it is English) and stores the result. */
$translateTranscript = function (Request $r, int $transcriptId, string $text, ?string $language): array {
    $rec = Db::one('SELECT recording_id FROM transcripts WHERE id = ?', [$transcriptId]);
    $ref = $rec !== null && $rec['recording_id'] !== null ? "recording:{$rec['recording_id']}" : "translate:{$transcriptId}";
    Quota::check($r->user, $ref);
    $lined = Language::sentenceLines($text);
    if ($lined !== trim($text) && Db::one('SELECT 1 FROM transcript_segments WHERE transcript_id = ? LIMIT 1', [$transcriptId]) === null) {
        Db::run('UPDATE transcripts SET source_text = ? WHERE id = ?', [$lined, $transcriptId]);
        $text = $lined;
    }
    $t = Translator::toEnglish($r->userId(), $text, $language, $r->input('model') ?: null);
    if ($t['model'] !== null) {
        Quota::consume($r->user, $ref); // only when something was actually translated (English is skipped)
    }
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
    if (($rec['kind'] ?? 'recording') === 'meeting') {
        $t  = Db::one('SELECT id FROM transcripts WHERE recording_id = ? ORDER BY id DESC LIMIT 1', [$rec['id']]);
        $id = $t !== null ? (int) $t['id'] : Db::insert('transcripts', ['user_id' => $r->userId(), 'recording_id' => $rec['id'], 'source_text' => '']);
        $out = Meeting::transcribeFile($r->userId(), $rec, $id, $recordingFile($rec), $rec['mime_type']);
        return ['transcript_id' => $id, 'text' => $out['text'], 'language' => $out['language']];
    }
    set_time_limit(300);
    $heard = Transcriber::transcribe($r->userId(), $recordingFile($rec), $rec['mime_type']);
    $heard['text'] = Habits::apply($r->userId(), $heard['text'], $heard['language']); // the user's learned corrections
    $heard['text'] = Language::sentenceLines($heard['text']); // one sentence per line, translated line by line
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
    Auth::requireGeneral($r);
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
    if (Auth::isFree($r->user)) {
        return $response + ['transcribe_error' => 'Transcription isn\'t included in the free plan; the audio is saved.'];
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
    Auth::requireTranscription(Auth::requireGeneral($r));
    return $transcribeRecording($r, $ownRecording($r, (int) $r->params['id']));
});

// Body: {title}. Renames one of your recordings.
$router->post('/recordings/{id}', function (Request $r) use ($ownRecording) {
    Auth::requireGeneral($r);
    $rec = $ownRecording($r, (int) $r->params['id']);
    Db::run('UPDATE recordings SET title = ? WHERE id = ?', [mb_substr(trim((string) $r->input('title', '')), 0, 255), $rec['id']]);
    return ['ok' => true];
});

// Deletes one of your recordings: the audio file, its transcripts and the recording.
$router->delete('/recordings/{id}', function (Request $r) use ($ownRecording, $recordingFile) {
    Auth::requireGeneral($r);
    $rec = $ownRecording($r, (int) $r->params['id']);
    if ($rec['file_path'] !== '') {
        @unlink($recordingFile($rec));
    }
    Meeting::deleteSamples((int) $rec['id']);
    Db::run('DELETE FROM transcripts WHERE recording_id = ? AND user_id = ?', [$rec['id'], $r->userId()]);
    Db::run('DELETE FROM recordings WHERE id = ?', [$rec['id']]);
    return ['ok' => true];
});

$router->get('/recordings', function (Request $r) {
    Auth::requireGeneral($r);
    return Db::all(
        'SELECT r.id, r.kind, r.title, r.original_name, r.mime_type, r.size_bytes, r.duration_sec, r.recorded_at, r.created_at,
                t.id AS transcript_id, t.source_lang AS language, t.source_text, t.translated_text
           FROM recordings r
           LEFT JOIN transcripts t ON t.id = (SELECT MAX(t2.id) FROM transcripts t2 WHERE t2.recording_id = r.id)
          WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 200',
        [$r->userId()],
    );
});

$router->get('/transcripts', function (Request $r) {
    Auth::requireGeneral($r);
    return Db::all(
        "SELECT id, recording_id, source_lang AS language, source_text, translated_text, translate_provider, translate_model, created_at
           FROM transcripts WHERE user_id = ? AND source_text <> '' ORDER BY created_at DESC LIMIT 200",
        [$r->userId()],
    );
});

// What's been learned from your transcript edits, per language group (zh = Chinese, other), and edits not yet learned.
$router->get('/transcripts/habits', function (Request $r) {
    Auth::requireGeneral($r);
    return ['rules' => Habits::rules($r->userId()), 'pending' => Habits::pending($r->userId())];
});

// Body: {group: zh|other, rules: string[]}. Replaces a group's rules (removing one, or [] to forget them all).
$router->post('/transcripts/habits', function (Request $r) {
    Auth::requireGeneral($r);
    $group = (string) $r->input('group', '');
    if (!in_array($group, Habits::GROUPS, true)) {
        throw new HttpException(422, 'group must be zh or other');
    }
    Habits::setRules($r->userId(), $group, (array) $r->input('rules', []));
    return ['rules' => Habits::rules($r->userId()), 'pending' => Habits::pending($r->userId())];
});

// Learns from your pending edits (the app calls this after saving an edit). Transcription users only.
$router->post('/transcripts/learn', function (Request $r) {
    Auth::requireTranscription(Auth::requireGeneral($r));
    set_time_limit(180);
    return Habits::learn($r->userId()) + ['pending' => Habits::pending($r->userId())];
});

// Body: {source_text?, translated_text?}. Edits one of your transcripts (or translations). A changed original of a
// transcribed recording is kept to learn from; "learn" says there's something to learn.
$router->post('/transcripts/{id}', function (Request $r) {
    $user = Auth::requireGeneral($r);
    $t = Db::one('SELECT id, recording_id, source_lang, source_text FROM transcripts WHERE id = ? AND user_id = ?', [(int) $r->params['id'], $r->userId()]);
    if ($t === null) {
        throw new HttpException(404, 'Transcript not found');
    }
    $set = [];
    $source = $r->input('source_text');
    if ($source !== null) {
        $source = trim((string) $source);
        if ($source === '') {
            throw new HttpException(422, 'The original text can\'t be empty; delete the transcript instead');
        }
        $set['source_text'] = $source;
    }
    if ($r->input('translated_text') !== null) {
        $set['translated_text'] = trim((string) $r->input('translated_text')) ?: null;
    }
    if ($set === []) {
        return ['ok' => true, 'learn' => false];
    }
    Db::run('UPDATE transcripts SET ' . implode(', ', array_map(fn ($k) => "{$k} = ?", array_keys($set))) . ' WHERE id = ?',
        [...array_values($set), $t['id']]);
    $learn = false;
    if (isset($set['source_text']) && $set['source_text'] !== $t['source_text']) {
        // The edited text is now the transcript; live segments would otherwise rebuild over it.
        Db::run('DELETE FROM transcript_segments WHERE transcript_id = ?', [$t['id']]);
        if ($t['recording_id'] !== null && !Auth::isFree($user)) {
            $learn = Habits::record($r->userId(), (int) $t['id'], $t['source_lang'], $t['source_text'], $set['source_text']);
        }
    }
    return ['ok' => true, 'learn' => $learn];
});

// Deletes one of your transcripts or translations (a recording's audio stays; it can be transcribed again).
$router->delete('/transcripts/{id}', function (Request $r) {
    Auth::requireGeneral($r);
    $n = Db::run('DELETE FROM transcripts WHERE id = ? AND user_id = ?', [(int) $r->params['id'], $r->userId()])->rowCount();
    if ($n === 0) {
        throw new HttpException(404, 'Transcript not found');
    }
    return ['ok' => true];
});

// Translate a saved transcript to English (skipped if it is English). Body: {model?}.
$router->post('/transcripts/{id}/translate', function (Request $r) use ($translateTranscript) {
    Auth::requireGeneral($r);
    $t = Db::one(
        'SELECT t.id, t.source_text, t.source_lang, r.kind FROM transcripts t LEFT JOIN recordings r ON r.id = t.recording_id
          WHERE t.id = ? AND t.user_id = ?',
        [(int) $r->params['id'], $r->userId()],
    );
    if ($t === null) {
        throw new HttpException(404, 'Transcript not found');
    }
    if ($t['kind'] === 'meeting' && Db::one('SELECT 1 FROM transcript_segments WHERE transcript_id = ? LIMIT 1', [$t['id']]) !== null) {
        set_time_limit(600);
        $out = Meeting::translate($r->userId(), (int) $t['id'], null);
        $now = Db::one('SELECT translated_text FROM transcripts WHERE id = ?', [$t['id']]);
        return ['transcript_id' => (int) $t['id'], 'language' => $out['language'], 'english' => $now['translated_text']];
    }
    return $translateTranscript($r, (int) $t['id'], $t['source_text'], $t['source_lang']);
});

// --- Live recording ---------------------------------------------------------
// The app records continuously and sends short, self-contained chunks (cut at pauses) while it records.
// Each chunk is transcribed (language auto-detected) and, if not English, translated; the text comes
// straight back. On stop, the app uploads the whole recording to /finish.

// Body: {title?, recorded_at?}. Returns the ids the chunks and /finish refer to.
$router->post('/live', function (Request $r) {
    Auth::requireGeneral($r);
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
    Auth::requireTranscription(Auth::requireGeneral($r));
    $rec          = $ownRecording($r, (int) $r->params['id']);
    $transcriptId = $liveTranscriptId($r, $rec);
    $audio        = $uploadedAudio('audio');
    $seq          = max(0, (int) $r->input('seq', 0));

    $heard = Transcriber::transcribe($r->userId(), $audio['tmp'], $audio['mime'], null, $r->input('prompt') ?: null, 'live_transcribe');
    if ($heard['text'] === '') {
        return ['seq' => $seq, 'text' => '', 'language' => null, 'english' => null];
    }
    $heard['text'] = Habits::apply($r->userId(), $heard['text'], $heard['language'], 'live_apply_habits');

    $language = $heard['language'];
    $english  = null;
    $error    = null;
    try {
        $quotaRef = "recording:{$rec['id']}";
        if (!Quota::allows($r->user, $quotaRef)) {
            throw new HttpException(429, Quota::message());
        }
        // Low effort keeps each chunk's translation quick enough to feel live.
        $t        = Translator::toEnglish($r->userId(), $heard['text'], $language, null, 'low', 'live_translate');
        $language = $t['language'];
        $english  = $t['english'];
        if ($t['model'] !== null) {
            Quota::consume($r->user, $quotaRef);
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
    Auth::requireGeneral($r);
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

// --- Meetings (paid plan) ----------------------------------------------------
// Like live recording, but each chunk is transcribed with speaker labels (Meeting), and translation is a separate call
// so the text shows first. The app sends short WAV chunks; the whole recording is uploaded to /live/{id}/finish.

$ownMeeting = function (Request $r) use ($ownRecording): array {
    $rec = $ownRecording($r, (int) $r->params['id']);
    if ($rec['kind'] !== 'meeting') {
        throw new HttpException(404, 'Meeting not found');
    }
    return $rec;
};
$meetingTranscriptId = function (array $rec): int {
    $t = Db::one('SELECT id FROM transcripts WHERE recording_id = ? ORDER BY id DESC LIMIT 1', [$rec['id']]);
    if ($t === null) {
        throw new HttpException(404, 'This meeting has no transcript');
    }
    return (int) $t['id'];
};

// Body: {title?, recorded_at?}.
$router->post('/meetings', function (Request $r) {
    Auth::requireTranscription(Auth::requireGeneral($r));
    $recordingId = Db::insert('recordings', [
        'user_id'     => $r->userId(),
        'kind'        => 'meeting',
        'file_path'   => '',
        'title'       => mb_substr((string) $r->input('title', ''), 0, 255),
        'recorded_at' => $r->input('recorded_at') ?: date('Y-m-d H:i:s'),
    ]);
    $transcriptId = Db::insert('transcripts', [
        'user_id' => $r->userId(), 'recording_id' => $recordingId, 'source_text' => '', 'transcribe_model' => Meeting::model(),
    ]);
    return ['recording_id' => $recordingId, 'transcript_id' => $transcriptId];
});

// Multipart: "audio" (WAV chunk), "seq", "start_ms". Returns the chunk's speaker turns and the meeting's speakers.
$router->post('/meetings/{id}/chunk', function (Request $r) use ($ownMeeting, $meetingTranscriptId, $uploadedAudio) {
    Auth::requireTranscription(Auth::requireGeneral($r));
    $rec   = $ownMeeting($r);
    $audio = $uploadedAudio('audio');
    if (!in_array($audio['mime'], ['audio/wav', 'audio/x-wav'], true)) {
        throw new HttpException(415, 'Meeting chunks must be WAV');
    }
    $seq   = max(0, (int) $r->input('seq', 0));
    $turns = Meeting::transcribeChunk($r->userId(), $rec, $meetingTranscriptId($rec), $audio['tmp'], $seq, max(0, (int) $r->input('start_ms', 0)));
    return ['seq' => $seq, 'turns' => $turns, 'speakers' => Meeting::speakers((int) $rec['id'])];
});

// Body: {seq?}. English for one chunk's turns (or all untranslated ones).
$router->post('/meetings/{id}/translate', function (Request $r) use ($ownMeeting, $meetingTranscriptId) {
    Auth::requireTranscription(Auth::requireGeneral($r));
    $rec = $ownMeeting($r);
    $seq = $r->input('seq');
    return Meeting::translate($r->userId(), $meetingTranscriptId($rec), $seq === null ? null : (int) $seq);
});

$router->get('/meetings/{id}/speakers', function (Request $r) use ($ownMeeting) {
    Auth::requireGeneral($r);
    return Meeting::speakers((int) $ownMeeting($r)['id']);
});

// Body: {label, name}. Names a speaker ("Speaker 2" -> "Ahmed"); empty goes back to the label.
$router->post('/meetings/{id}/speakers', function (Request $r) use ($ownMeeting) {
    Auth::requireGeneral($r);
    $rec = $ownMeeting($r);
    Meeting::renameSpeaker((int) $rec['id'], (string) $r->input('label', ''), (string) $r->input('name', ''));
    return Meeting::speakers((int) $rec['id']);
});

// --- Daily Feed -----------------------------------------------------------------
// Topics of interest and the daily feeds of verified top stories (see Feed). Same access as the General Tool.

$router->get('/feed/topics', function (Request $r) {
    Auth::requireGeneral($r);
    return Feed::topics($r->userId());
});

// Body: {topic}. Starts with tomorrow's feed.
$router->post('/feed/topics', function (Request $r) {
    Auth::requireGeneral($r);
    Feed::addTopic($r->userId(), (string) $r->input('topic', ''));
    return Feed::topics($r->userId());
});

// Body: {include_zh: bool}. Chinese-language news for this topic (from the next feed built).
$router->post('/feed/topics/{id}', function (Request $r) {
    Auth::requireGeneral($r);
    Feed::setChinese($r->userId(), (int) $r->params['id'], filter_var($r->input('include_zh', false), FILTER_VALIDATE_BOOLEAN));
    return Feed::topics($r->userId());
});

$router->delete('/feed/topics/{id}', function (Request $r) {
    Auth::requireGeneral($r);
    Feed::removeTopic($r->userId(), (int) $r->params['id']);
    return Feed::topics($r->userId());
});

// Today's feeds (or ?date=YYYY-MM-DD), the dates with feeds, and whether you have topics.
$router->get('/feed', function (Request $r) {
    $user = Auth::requireGeneral($r);
    $date = (string) $r->query('date', date('Y-m-d'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        throw new HttpException(422, 'date must be YYYY-MM-DD');
    }
    // Earlier days are on the paid plan; the free plan sees today's feed.
    $free = Auth::isFree($user);
    if ($free && $date !== date('Y-m-d')) {
        throw new HttpException(403, 'Earlier days\' feeds are on the paid plan');
    }
    return [
        'date'        => $date,
        'today'       => date('Y-m-d'),
        'plan'        => $free ? 'combined' : 'per_topic',
        'can_go_back' => !$free,
        'feeds'       => Feed::forDate($r->userId(), $date),
        'dates'       => $free ? [] : Feed::dates($r->userId()),
        'topics'      => Feed::topics($r->userId()),
    ];
});

// For the desktop notification: is today's feed ready?
$router->get('/feed/status', function (Request $r) {
    Auth::requireGeneral($r);
    $today = date('Y-m-d');
    $n = (int) Db::one("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ? AND feed_date = ? AND status = 'ready'", [$r->userId(), $today])['n'];
    $due = (int) Db::one('SELECT COUNT(*) AS n FROM feed_topics WHERE user_id = ? AND removed_at IS NULL AND effective_from <= ?', [$r->userId(), $today])['n'];
    return ['date' => $today, 'ready' => $n, 'topics_due' => $due, 'after_8' => (int) date('G') >= 8];
});

// Builds today's feeds now if they're missing (after 8:00, e.g. the scheduled run was missed); the Super Admin can
// rebuild them ({force: true}).
$router->post('/feed/generate', function (Request $r) {
    $user = Auth::requireGeneral($r);
    $force = filter_var($r->input('force', false), FILTER_VALIDATE_BOOLEAN) && ($user['account_role'] ?? $user['role']) === 'super_admin';
    if (!$force && (int) date('G') < 8) {
        throw new HttpException(409, 'Today\'s feed is built at 8:00');
    }
    return ['built' => Feed::generate($user, null, $force)];
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
    Auth::requireSuper($r);
    $from = (string) $r->query('from', date('Y-m-01'));
    $to   = (string) $r->query('to', date('Y-m-d'));
    $dateRange($from, $to);
    $view = (string) $r->query('view', 'providers');
    return ['from' => $from, 'to' => $to, 'view' => $view,
            'rows' => Usage::summary($r->userId(), $from, $to, (string) $r->query('group', 'day'), $view)];
});

// Sync state per provider and DeepSeek's balance.
$router->get('/usage/providers', function (Request $r) {
    Auth::requireSuper($r);
    return ProviderUsage::status();
});

// Pull usage and billed cost from Anthropic and OpenAI for a range (default: the last 31 days).
// Body: {from?, to?}. Ranges are capped at 366 days.
$router->post('/usage/sync', function (Request $r) use ($dateRange) {
    Auth::requireSuper($r);
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
    Auth::requireSuper($r);
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
