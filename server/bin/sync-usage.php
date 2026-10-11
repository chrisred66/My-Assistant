<?php

declare(strict_types=1);

// Pulls usage and billed cost from Anthropic and OpenAI into token_usage.
// Usage: php bin/sync-usage.php [days]   (default 3: re-syncs the last few days, since today is partial)
// Meant for a nightly Windows Task Scheduler job; the Usage page has a "Sync" button for ad-hoc runs.

use ChrisManager\ProviderUsage;

require dirname(__DIR__) . '/src/bootstrap.php';

$days = max(1, min(366, (int) ($argv[1] ?? 3)));
$to   = date('Y-m-d');
$from = date('Y-m-d', strtotime("-" . ($days - 1) . ' days'));

$failed = false;
foreach (ProviderUsage::syncAll($from, $to) as $provider => $result) {
    $line = match (true) {
        $result['ok']             => "{$result['rows']} rows",
        isset($result['skipped']) => "skipped: {$result['skipped']}",
        default                   => "FAILED: {$result['error']}",
    };
    $failed = $failed || (!$result['ok'] && !isset($result['skipped']));
    echo date('Y-m-d H:i:s'), " {$provider} {$from}..{$to}: {$line}\n";
}
exit($failed ? 1 : 0);
