<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Email/username + password login that issues a per-device bearer token, plus role checks.
 *
 *   owner:  everything
 *   member: only PT Management, at their pt_access level (view < edit < admin)
 */
final class Auth
{
    private const PT_LEVELS = ['none' => 0, 'view' => 1, 'edit' => 2, 'admin' => 3];

    /** $identifier is an email address or a username. */
    public static function login(string $identifier, string $password, string $deviceName): array
    {
        $identifier = trim($identifier);
        $user = Db::one(
            'SELECT id, email, username, display_name, role, pt_access, password_hash, disabled_at
               FROM users WHERE email = ? OR username = ? LIMIT 1',
            [strtolower($identifier), $identifier],
        );
        if ($user === null || $user['disabled_at'] !== null || !password_verify($password, $user['password_hash'])) {
            usleep(random_int(300_000, 700_000)); // slow down guessing
            throw new HttpException(401, 'Invalid login or password');
        }

        $token   = bin2hex(random_bytes(32));
        $ttlDays = (int) Env::get('TOKEN_TTL_DAYS', '90');
        Db::insert('api_tokens', [
            'user_id'     => $user['id'],
            'token_hash'  => hash('sha256', $token),
            'device_name' => mb_substr($deviceName, 0, 100),
            'expires_at'  => date('Y-m-d H:i:s', strtotime("+{$ttlDays} days")),
        ]);

        return ['token' => $token, 'user' => self::publicUser($user)];
    }

    public static function requireUser(Request $req): array
    {
        $token = $req->bearerToken();
        if ($token === null) {
            throw new HttpException(401, 'Missing bearer token');
        }
        $row = Db::one(
            'SELECT t.id AS token_id, u.id, u.email, u.username, u.display_name, u.role, u.pt_access
               FROM api_tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ? AND t.expires_at > NOW() AND u.disabled_at IS NULL',
            [hash('sha256', $token)],
        );
        if ($row === null) {
            throw new HttpException(401, 'Invalid or expired token');
        }
        Db::run('UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?', [$row['token_id']]);
        return $req->user = $row;
    }

    /** The owner's own tools: AI, recordings, transcripts, usage, user management. */
    public static function requireOwner(Request $req): array
    {
        $user = self::requireUser($req);
        if ($user['role'] !== 'owner') {
            throw new HttpException(403, 'Only the owner can use this');
        }
        return $user;
    }

    /** PT Management at the given level or above; the owner always passes. */
    public static function requirePt(Request $req, string $level = 'view'): array
    {
        $user = self::requireUser($req);
        if ($user['role'] !== 'owner' && self::PT_LEVELS[$user['pt_access']] < self::PT_LEVELS[$level]) {
            throw new HttpException(403, "PT Management needs {$level} access");
        }
        return $user;
    }

    public static function logout(Request $req): void
    {
        $token = $req->bearerToken();
        if ($token !== null) {
            Db::run('DELETE FROM api_tokens WHERE token_hash = ?', [hash('sha256', $token)]);
        }
    }

    public static function changePassword(int $userId, string $current, string $new): void
    {
        $user = Db::one('SELECT password_hash FROM users WHERE id = ?', [$userId]);
        if ($user === null || !password_verify($current, $user['password_hash'])) {
            throw new HttpException(422, 'Current password is incorrect');
        }
        self::checkPassword($new);
        Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_DEFAULT), $userId]);
    }

    public static function checkPassword(string $password): void
    {
        if (strlen($password) < 12) {
            throw new HttpException(422, 'Passwords need at least 12 characters');
        }
    }

    /** The fields clients may see. */
    public static function publicUser(array $u): array
    {
        return [
            'id'           => (int) $u['id'],
            'email'        => $u['email'],
            'username'     => $u['username'],
            'display_name' => $u['display_name'] !== '' ? $u['display_name'] : ($u['username'] ?? $u['email'] ?? ''),
            'role'         => $u['role'],
            'pt_access'    => $u['role'] === 'owner' ? 'admin' : $u['pt_access'],
        ];
    }
}
