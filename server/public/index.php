<?php

declare(strict_types=1);

use ChrisManager\Env;
use ChrisManager\HttpException;
use ChrisManager\Request;
use ChrisManager\Router;

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
ini_set('display_errors', '0'); // errors go to the log and a JSON body, never raw HTML

try {
    require dirname(__DIR__) . '/src/bootstrap.php';

    $router = new Router();
    require dirname(__DIR__) . '/src/routes.php';
    require dirname(__DIR__) . '/src/Pt/routes.php';

    $result = $router->dispatch(Request::fromGlobals());
    echo json_encode($result ?? ['ok' => true], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (HttpException $e) {
    http_response_code($e->status);
    echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    error_log((string) $e);
    http_response_code(500);
    $debug   = class_exists(Env::class, false) && Env::bool('APP_DEBUG');
    $message = $debug ? get_class($e) . ': ' . $e->getMessage() : 'Server error';
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
}
