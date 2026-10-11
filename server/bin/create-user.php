<?php

declare(strict_types=1);

// Creates (or resets the password of) the login account.  Usage: php bin/create-user.php you@example.com
// There is deliberately no sign-up endpoint: accounts only exist if made here.

use ChrisManager\Db;

require dirname(__DIR__) . '/src/bootstrap.php';

$email = strtolower(trim($argv[1] ?? ''));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "Usage: php bin/create-user.php you@example.com\n");
    exit(1);
}

echo 'Password (min 12 chars): ';
$password = trim((string) fgets(STDIN));
if (strlen($password) < 12) {
    fwrite(STDERR, "Password too short.\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_DEFAULT);
Db::run(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
    [$email, $hash],
);
echo "Saved user {$email}.\n";
