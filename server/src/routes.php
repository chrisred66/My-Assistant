<?php

declare(strict_types=1);

/** @var ChrisManager\Router $router */

use ChrisManager\Ai\Transcriber;
use ChrisManager\Ai\Translator;
use ChrisManager\Auth;
use ChrisManager\Db;
use ChrisManager\Env;
use ChrisManager\HttpException;
use ChrisManager\Request;
use ChrisManager\Usage;

$router->get('/health', fn () => ['ok' => true, 'time' => date('c')]);

// --- Auth ---------------------------------------------------------------

$router->post('/auth/login', fn (Request $r) => Auth::login(
    (string) $r->input('email', ''),
    (string) $r->input('password', ''),
    (string) $r->input('device', 'unknown device'),
));

$router->post('/auth/logout', function (Request $r) {
    Auth::logout($r);
    return ['ok' => true];
});

$router->get('/auth/me', fn (Request $r) => Auth::requireUser($r));

// --- Translation ----------------------------------------------------------

$router->post('/ai/translate', function (Request $r) {
    Auth::requireUser($r);
    $text     = (string) $r->input('text', '');
    $provider = $r->input('provider');
    $result   = Translator::translate($r->userId(), $text, $provider, $r->input('model'));

    $id = Db::insert('transcripts', [
        'user_id'            => $r->userId(),
        'source_text'        => $text,
        'translated_text'    => $result->text,
        'translate_provider' => Translator::provider($provider)->name(),
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

// Multipart upload: field "audio" (+ optional "title", "recorded_at", "translate"=1, "provider").
$router->post('/recordings', function (Request $r) {
    Auth::requireUser($r);
    $file = $_FILES['audio'] ?? null;
    if ($file === null || $file['error'] !== UPLOAD_ERR_OK) {
        throw new HttpException(422, 'Upload an audio file in the "audio" field');
    }
    if ($file['size'] > (int) Env::get('MAX_UPLOAD_MB', '25') * 1024 * 1024) {
        throw new HttpException(413, 'File too large');
    }

    $mime    = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']) ?: '';
    $allowed = ['audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/wav' => 'wav',
                'audio/x-wav' => 'wav', 'audio/webm' => 'webm', 'video/webm' => 'webm', 'audio/ogg' => 'ogg',
                'video/mp4' => 'mp4', 'audio/flac' => 'flac'];
    if (!isset($allowed[$mime])) {
        throw new HttpException(415, "Unsupported audio type {$mime}");
    }

    $relative = sprintf('%d/%s/%s.%s', $r->userId(), date('Y/m'), bin2hex(random_bytes(8)), $allowed[$mime]);
    $absolute = dirname(__DIR__) . '/' . trim(Env::get('STORAGE_PATH', 'storage/recordings'), '/') . '/' . $relative;
    if (!is_dir(dirname($absolute)) && !mkdir(dirname($absolute), 0770, true)) {
        throw new HttpException(500, 'Cannot create storage folder');
    }
    if (!move_uploaded_file($file['tmp_name'], $absolute)) {
        throw new HttpException(500, 'Cannot save upload');
    }

    $recordingId = Db::insert('recordings', [
        'user_id'       => $r->userId(),
        'file_path'     => $relative,
        'original_name' => mb_substr((string) $file['name'], 0, 255),
        'mime_type'     => $mime,
        'size_bytes'    => (int) $file['size'],
        'title'         => mb_substr((string) $r->input('title', ''), 0, 255),
        'recorded_at'   => $r->input('recorded_at') ?: null,
    ]);

    $response = ['id' => $recordingId];
    if (filter_var($r->input('translate', false), FILTER_VALIDATE_BOOLEAN)) {
        $transcript = Transcriber::transcribe($r->userId(), $absolute, $mime);
        Db::run('UPDATE recordings SET duration_sec = ? WHERE id = ?', [$transcript['duration'], $recordingId]);

        $provider    = $r->input('provider');
        $translation = Translator::translate($r->userId(), $transcript['text'], $provider);
        $response['transcript_id'] = Db::insert('transcripts', [
            'user_id'            => $r->userId(),
            'recording_id'       => $recordingId,
            'source_text'        => $transcript['text'],
            'translated_text'    => $translation->text,
            'transcribe_model'   => $transcript['model'],
            'translate_provider' => Translator::provider($provider)->name(),
            'translate_model'    => $translation->model,
        ]);
        $response['arabic']  = $transcript['text'];
        $response['english'] = $translation->text;
    }
    return $response;
});

$router->get('/recordings', function (Request $r) {
    Auth::requireUser($r);
    return Db::all(
        'SELECT r.id, r.title, r.original_name, r.mime_type, r.size_bytes, r.duration_sec, r.recorded_at, r.created_at,
                t.id AS transcript_id, t.translated_text
           FROM recordings r LEFT JOIN transcripts t ON t.recording_id = r.id
          WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 200',
        [$r->userId()],
    );
});

$router->get('/transcripts', function (Request $r) {
    Auth::requireUser($r);
    return Db::all(
        'SELECT id, recording_id, source_text, translated_text, translate_provider, translate_model, created_at
           FROM transcripts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
        [$r->userId()],
    );
});

// --- Token usage ----------------------------------------------------------

// ?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|month|model
$router->get('/usage/summary', function (Request $r) {
    Auth::requireUser($r);
    $from = (string) $r->query('from', date('Y-m-01'));
    $to   = (string) $r->query('to', date('Y-m-d'));
    foreach ([$from, $to] as $d) {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
            throw new HttpException(422, 'Dates must be YYYY-MM-DD');
        }
    }
    return ['from' => $from, 'to' => $to, 'rows' => Usage::summary($r->userId(), $from, $to, (string) $r->query('group', 'day'))];
});

// Manual entry, e.g. usage from tools that don't go through this relay.
$router->post('/usage', function (Request $r) {
    Auth::requireUser($r);
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
