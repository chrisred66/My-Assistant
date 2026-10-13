<?php

declare(strict_types=1);

// Works out the cost of DeepSeek calls logged before the app priced them (cost_usd still empty), with DeepSeek's
// peak / off-peak rates at the time of each call. Safe to run again: rows that already have a cost are left alone,
// unless --reprice is given (e.g. after a pricing rule changed), which works them all out again.
//   php bin/backfill-deepseek-cost.php [--reprice]

use ChrisManager\Db;
use ChrisManager\Usage;

require __DIR__ . '/../src/bootstrap.php';

$reprice = in_array('--reprice', $argv, true);
$rows = Db::all("SELECT id, model, input_tokens, cache_read_tokens, output_tokens, occurred_at FROM token_usage
                  WHERE provider = 'deepseek' AND source = 'relay'" . ($reprice ? '' : ' AND cost_usd IS NULL'));
$priced = 0;
$total = 0.0;
$peak = 0;
foreach ($rows as $r) {
    $at = new DateTimeImmutable($r['occurred_at']); // stored in the app's timezone
    $cost = Usage::deepSeekCost($r['model'], (int) $r['input_tokens'], (int) $r['cache_read_tokens'], (int) $r['output_tokens'], $at);
    if ($cost === null) {
        continue;
    }
    Db::run('UPDATE token_usage SET cost_usd = ? WHERE id = ?', [$cost, $r['id']]);
    $priced++;
    $total += $cost;
    $peak += Usage::deepSeekPeak($at) ? 1 : 0;
}
printf("%d of %d DeepSeek call(s) priced (%d at peak rates), \$%.4f in all\n", $priced, count($rows), $peak, $total);
