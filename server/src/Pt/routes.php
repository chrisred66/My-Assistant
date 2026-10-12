<?php

declare(strict_types=1);

/** PT Management (GBA Toolkit) endpoints, under /pt. Access per module and level: Auth::requirePtModule. */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

// Whether the GBA database is reachable, and what's in it.
$router->get('/pt/status', function (Request $r) {
    Auth::requirePt($r);
    return GbaDb::status();
});

require __DIR__ . '/fleet.php';
require __DIR__ . '/operations.php';
require __DIR__ . '/trials.php';
require __DIR__ . '/charging.php';
require __DIR__ . '/maintenance.php';
