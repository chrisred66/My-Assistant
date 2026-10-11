<?php

declare(strict_types=1);

/** PT Management (GBA Toolkit) endpoints, under /pt. Access: Auth::requirePt (owner always passes). */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

// Whether the GBA database is reachable, and what's in it.
$router->get('/pt/status', function (Request $r) {
    Auth::requirePt($r, 'view');
    return GbaDb::status();
});
