<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * The activity log: who did what, for everyone. Recorded from public/index.php after each request: every change
 * (any request that isn't a GET), and while the Super Admin views as someone else, everything they open too. Sign-in
 * attempts are recorded by Auth::login. Entries are kept for a year.
 *
 * Only the action (method and path), the person, their role, the status, IP and device are kept: never request bodies,
 * so passwords and transcript text don't end up in the log.
 */
final class Activity
{
    private const KEEP_DAYS = 365;

    /** One request, after it ran (or failed). */
    public static function request(Request $req, int $status): void
    {
        $user = $req->user;
        $viewing = isset($user['viewed_by']);
        if ($req->method === 'GET' && !$viewing) {
            return; // reading your own things isn't logged
        }
        if ($req->path === '/auth/login' || $req->path === '/health') {
            return; // sign-ins are logged by Auth::login, with the login name
        }
        self::write([
            'user_id'   => $user['id'] ?? null,
            'viewed_by' => $user['viewed_by']['id'] ?? null,
            'role'      => $user['active_role'] ?? ($user !== null ? $user['role'] : null),
            'action'    => mb_substr($req->method . ' ' . $req->path, 0, 60),
            'target'    => isset($req->params['id']) ? mb_substr((string) $req->params['id'], 0, 190) : null,
            'status'    => $status,
        ]);
    }

    /** A named event, e.g. a sign-in. */
    public static function event(string $action, ?int $userId, ?string $target = null, ?int $status = null): void
    {
        self::write(['user_id' => $userId, 'action' => $action, 'target' => $target !== null ? mb_substr($target, 0, 190) : null, 'status' => $status]);
    }

    private static function write(array $row): void
    {
        try {
            Db::insert('activity_log', $row + [
                'ip'     => self::ip(),
                'device' => mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 100) ?: null,
            ]);
            if (random_int(1, 200) === 1) {
                Db::run('DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL ' . self::KEEP_DAYS . ' DAY');
            }
        } catch (\Throwable $e) {
            error_log('Activity log: ' . $e->getMessage()); // never fail a request because of the log
        }
    }

    /**
     * The caller's IP. Behind a tunnel or proxy, set TRUSTED_PROXY_HEADER (e.g. CF-Connecting-IP for Cloudflare): it's
     * believed only for requests that arrive from this machine (where the tunnel connects from), so devices on the
     * home network or Tailscale can't fake it to dodge the sign-in lockout.
     */
    public static function ip(): string
    {
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $header = Env::get('TRUSTED_PROXY_HEADER', '');
        if ($header !== '' && in_array($remote, ['127.0.0.1', '::1'], true)) {
            $v = $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $header))] ?? '';
            if ($v !== '') {
                return mb_substr(trim(explode(',', $v)[0]), 0, 45);
            }
        }
        return mb_substr($remote, 0, 45);
    }

    /**
     * Entries for Settings → Activity, newest first. The Super Admin sees everyone; Admins see accounts below Admin.
     * Filters: user id, from / to dates, limit / offset.
     */
    public static function list(array $viewer, ?int $userId, ?string $from, ?string $to, int $limit, int $offset): array
    {
        $where = ['1 = 1'];
        $params = [];
        if (($viewer['account_role'] ?? $viewer['role']) !== 'super_admin') {
            $where[] = "(u.role = 'user' OR a.user_id IS NULL)";
        }
        if ($userId !== null) {
            $where[] = 'a.user_id = ?';
            $params[] = $userId;
        }
        if ($from !== null) {
            $where[] = 'a.created_at >= ?';
            $params[] = $from;
        }
        if ($to !== null) {
            $where[] = 'a.created_at < DATE_ADD(?, INTERVAL 1 DAY)';
            $params[] = $to;
        }
        $sql = 'FROM activity_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users v ON v.id = a.viewed_by WHERE ' . implode(' AND ', $where);
        $total = (int) Db::one("SELECT COUNT(*) AS n {$sql}", $params)['n'];
        $rows = Db::all(
            "SELECT a.id, a.created_at, a.action, a.target, a.status, a.role, a.ip, a.device, a.user_id,
                    COALESCE(NULLIF(u.display_name, ''), u.username, u.email) AS user_name,
                    COALESCE(NULLIF(v.display_name, ''), v.username, v.email) AS viewed_by_name
             {$sql} ORDER BY a.id DESC LIMIT " . max(1, min(500, $limit)) . ' OFFSET ' . max(0, $offset),
            $params,
        );
        return ['total' => $total, 'rows' => $rows];
    }
}
