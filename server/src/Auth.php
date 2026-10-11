<?php

declare(strict_types=1);

namespace ChrisManager;

/** Email + password login that issues a per-device bearer token. */
final class Auth
{
    public static function login(string $email, string $password, string $deviceName): array
    {
        $user = Db::one('SELECT id, email, password_hash FROM users WHERE email = ?', [strtolower(trim($email))]);
        if ($user === null || !password_verify($password, $user['password_hash'])) {
            usleep(random_int(300_000, 700_000)); // slow down guessing
            throw new HttpException(401, 'Invalid email or password');
        }

        $token   = bin2hex(random_bytes(32));
        $ttlDays = (int) Env::get('TOKEN_TTL_DAYS', '90');
        Db::insert('api_tokens', [
            'user_id'     => $user['id'],
            'token_hash'  => hash('sha256', $token),
            'device_name' => mb_substr($deviceName, 0, 100),
            'expires_at'  => date('Y-m-d H:i:s', strtotime("+{$ttlDays} days")),
        ]);

        return ['token' => $token, 'user' => ['id' => (int) $user['id'], 'email' => $user['email']]];
    }

    public static function requireUser(Request $req): array
    {
        $token = $req->bearerToken();
        if ($token === null) {
            throw new HttpException(401, 'Missing bearer token');
        }
        $row = Db::one(
            'SELECT t.id AS token_id, u.id, u.email
               FROM api_tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ? AND t.expires_at > NOW()',
            [hash('sha256', $token)],
        );
        if ($row === null) {
            throw new HttpException(401, 'Invalid or expired token');
        }
        Db::run('UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?', [$row['token_id']]);
        return $req->user = $row;
    }

    public static function logout(Request $req): void
    {
        $token = $req->bearerToken();
        if ($token !== null) {
            Db::run('DELETE FROM api_tokens WHERE token_hash = ?', [hash('sha256', $token)]);
        }
    }
}
