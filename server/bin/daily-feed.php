<?php
// The Daily Feed run: builds today's feeds for everyone with topics (Windows Task Scheduler runs this at 8:00).
//   php bin/daily-feed.php            today's feeds (users who already have them are skipped)
declare(strict_types=1);

require __DIR__ . '/../src/bootstrap.php';

use ChrisManager\Feed;

$started = microtime(true);
$done = Feed::generateAll();
$line = sprintf("[%s] Daily Feed: %d user(s), %d feed(s) built in %.0fs\n", date('Y-m-d H:i:s'), count($done), array_sum($done), microtime(true) - $started);
echo $line;
@file_put_contents(dirname(__DIR__) . '/storage/daily-feed.log', $line, FILE_APPEND);
