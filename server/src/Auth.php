<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Email/username + password login that issues a per-device bearer token, plus permission checks (migration 005).
 *
 *   role super_admin: everything (Usage, AI routing, the desktop ball, all users)
 *   role admin:       manages users below Admin, and the General Tool (Paid); PT only through its own PT role
 *   role user:        general_plan  none | free (record + 10 translations a day, no transcription) | paid → General Tool
 *                     (PT users without a plan of their own get the General Tool as Free)
 *                     pt_role       none | big_man (all PT) | manager (own module, full) | staff (own module, view + add)
 *                     pt_module     operations | maintenance | planning (Fleet, Trials, Charging)
 *
 * PT checks are per module and level: view < add < manage (manage = edit, close, delete, settings).
 *
 * Sign-in: after LOCK_FAILURES failed attempts for a login (or LOCK_IP_FAILURES from one IP) within LOCK_MINUTES, that
 * login (or IP) is locked for LOCK_MINUTES. A failed sign-in takes the same time whether or not the login exists.
 *
 * Roles: an account acts in one role at a time (migration 006, kept per token). The Super Admin has every role;
 * others have the roles their groups give (a General Tool plan, a PT role; Admins just "admin"). Checks run against
 * the active role, so acting as a Free User really is a Free User. Exception: requireSuper looks at the account, so
 * the Super Admin's own Usage data (and the desktop ball) keep working in any role.
 */
final class Auth
{
    public const PT_MODULES = ['operations', 'maintenance', 'planning'];
    private const PT_LEVELS = ['none' => 0, 'view' => 1, 'add' => 2, 'manage' => 3];
    private const LOCK_FAILURES = 5;
    private const LOCK_IP_FAILURES = 20;
    private const LOCK_MINUTES = 15;
    /** A real hash to check against when the login doesn't exist, so the reply takes the same time. */
    private const DUMMY_HASH = '$2y$10$lUpzXrrK71XX8Yi7KlMpZutls3vY4LJ.rkhDoNsBSG1VBR2llwOda';

    /** The signed-in user of this request (set by requireUser / switchRole), for checks deeper in the code. */
    private static ?array $current = null;

    public static function current(): ?array
    {
        return self::$current;
    }
    private const USER_COLUMNS = 'u.id, u.email, u.username, u.display_name, u.language, u.role, u.general_plan, u.pt_role, u.pt_module';

    /** $identifier is an email address or a username. */
    public static function login(string $identifier, string $password, string $deviceName): array
    {
        $identifier = trim($identifier);
        $key = mb_substr(strtolower($identifier), 0, 190);
        $ip = Activity::ip();
        $since = date('Y-m-d H:i:s', time() - self::LOCK_MINUTES * 60);
        $byLogin = (int) Db::one('SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND created_at > ?', [$key, $since])['n'];
        $byIp = (int) Db::one('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND created_at > ?', [$ip, $since])['n'];
        if ($byLogin >= self::LOCK_FAILURES || $byIp >= self::LOCK_IP_FAILURES) {
            Activity::event('sign-in locked', null, $key, 429);
            throw new HttpException(429, 'Too many failed sign-ins. Try again in ' . self::LOCK_MINUTES . ' minutes.');
        }

        $user = Db::one(
            'SELECT ' . self::USER_COLUMNS . ', u.password_hash, u.disabled_at
               FROM users u WHERE u.email = ? OR u.username = ? LIMIT 1',
            [strtolower($identifier), $identifier],
        );
        // Always check a password hash, so a login that doesn't exist answers as slowly as a wrong password.
        $ok = password_verify($password, $user['password_hash'] ?? self::DUMMY_HASH) && $user !== null && $user['disabled_at'] === null;
        if (!$ok) {
            Db::insert('login_attempts', ['identifier' => $key, 'ip' => $ip]);
            if (random_int(1, 100) === 1) {
                Db::run('DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL 1 DAY');
            }
            Activity::event('sign-in failed', $user !== null ? (int) $user['id'] : null, $key, 401);
            usleep(random_int(200_000, 400_000)); // slow down guessing
            throw new HttpException(401, 'Invalid login or password');
        }
        Db::run('DELETE FROM login_attempts WHERE identifier = ?', [$key]);
        Activity::event('sign-in', (int) $user['id'], mb_substr($deviceName, 0, 100), 200);

        $token   = bin2hex(random_bytes(32));
        $ttlDays = (int) Env::get('TOKEN_TTL_DAYS', '90');
        $roles   = self::availableRoles($user);
        $active  = count($roles) === 1 ? $roles[0] : null; // several roles: the app asks which one first
        Db::insert('api_tokens', [
            'user_id'     => $user['id'],
            'token_hash'  => hash('sha256', $token),
            'device_name' => mb_substr($deviceName, 0, 100),
            'active_role' => $active,
            'expires_at'  => date('Y-m-d H:i:s', strtotime("+{$ttlDays} days")),
        ]);

        return ['token' => $token, 'user' => self::publicUser(self::withRole($user, $active))];
    }

    /** The roles an account can act in. */
    public static function availableRoles(array $account): array
    {
        if ($account['role'] === 'super_admin') {
            $roles = ['super_admin', 'admin', 'general:free', 'general:paid', 'pt:big_man'];
            foreach (['manager', 'staff'] as $r) {
                foreach (self::PT_MODULES as $m) {
                    $roles[] = "pt:{$r}:{$m}";
                }
            }
            return $roles;
        }
        if ($account['role'] === 'admin') {
            return ['admin'];
        }
        $roles = [];
        if ($account['general_plan'] !== 'none') {
            $roles[] = "general:{$account['general_plan']}";
        }
        if ($account['pt_role'] === 'big_man') {
            $roles[] = 'pt:big_man';
        } elseif (in_array($account['pt_role'], ['manager', 'staff'], true) && $account['pt_module'] !== null) {
            $roles[] = "pt:{$account['pt_role']}:{$account['pt_module']}";
        }
        return $roles;
    }

    public static function roleLabel(string $role): string
    {
        $modules = ['operations' => 'Operations', 'maintenance' => 'Maintenance', 'planning' => 'Planning'];
        $parts = explode(':', $role);
        return match ($parts[0]) {
            'super_admin' => 'Super Admin',
            'admin'       => 'Admin',
            'general'     => 'General User · ' . ucfirst($parts[1]),
            'pt'          => $parts[1] === 'big_man' ? 'PT · Big Man'
                : 'PT · ' . ($modules[$parts[2]] ?? $parts[2]) . ' ' . ($parts[1] === 'manager' ? 'Manager' : 'Low Man'),
            default       => $role,
        };
    }

    /**
     * The account as it acts in $role: the groups that role stands for. No role (not chosen yet) leaves the account as
     * it is (all of its groups). Keeps the real role in account_role.
     */
    public static function withRole(array $account, ?string $role): array
    {
        $u = $account + ['account_role' => $account['role']];
        $u['account_role'] = $account['account_role'] ?? $account['role'];
        foreach (['general_plan', 'pt_role', 'pt_module'] as $k) {
            $u["account_{$k}"] = array_key_exists("account_{$k}", $account) ? $account["account_{$k}"] : $account[$k];
        }
        $u['active_role'] = $role;
        if ($role === null || $role === 'super_admin') {
            return $u;
        }
        if ($role === 'admin') {
            return ['role' => 'admin'] + $u;
        }
        $parts = explode(':', $role);
        $user = ['role' => 'user', 'general_plan' => 'none', 'pt_role' => 'none', 'pt_module' => null];
        if ($parts[0] === 'general') {
            $user['general_plan'] = $parts[1];
        } elseif ($parts[0] === 'pt') {
            $user['pt_role'] = $parts[1];
            $user['pt_module'] = $parts[2] ?? null;
        }
        return $user + $u;
    }

    /** The account's own groups for a row acting in a role. */
    private static function accountFields(array $u): array
    {
        $own = fn (string $k) => array_key_exists("account_{$k}", $u) ? $u["account_{$k}"] : $u[$k];
        return ['role' => $u['account_role'], 'general_plan' => $own('general_plan'), 'pt_role' => $own('pt_role'), 'pt_module' => $own('pt_module')];
    }

    /** Switches the current sign-in to $role (one the account has); returns the account acting in it. */
    public static function switchRole(Request $req, string $role): array
    {
        $acting = self::requireUser($req);
        if (isset($acting['viewed_by'])) {
            // Viewing as another account: the app keeps the role (X-View-As-Role); nothing is stored on the token.
            $account = Db::one('SELECT ' . self::USER_COLUMNS . ' FROM users u WHERE u.id = ?', [$acting['id']]);
            if (!in_array($role, self::availableRoles($account), true)) {
                throw new HttpException(422, 'That account doesn\'t have that role');
            }
            return self::$current = $req->user = self::withRole($account, $role) + ['token_id' => $acting['token_id'], 'viewed_by' => $acting['viewed_by']];
        }
        $account = Db::one('SELECT ' . self::USER_COLUMNS . ' FROM users u WHERE u.id = ?', [$acting['id']]);
        if (!in_array($role, self::availableRoles($account), true)) {
            throw new HttpException(422, 'Your account doesn\'t have that role');
        }
        Db::run('UPDATE api_tokens SET active_role = ? WHERE id = ?', [$role, $acting['token_id']]);
        return self::$current = $req->user = self::withRole($account, $role) + ['token_id' => $acting['token_id']];
    }

    public static function requireUser(Request $req): array
    {
        $token = $req->bearerToken();
        if ($token === null) {
            throw new HttpException(401, 'Missing bearer token');
        }
        $row = Db::one(
            'SELECT t.id AS token_id, t.active_role, ' . self::USER_COLUMNS . '
               FROM api_tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ? AND t.expires_at > NOW() AND u.disabled_at IS NULL',
            [hash('sha256', $token)],
        );
        if ($row === null) {
            throw new HttpException(401, 'Invalid or expired token');
        }
        Db::run('UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?', [$row['token_id']]);
        // A role the account no longer has (groups changed) falls back to "not chosen".
        $active = $row['active_role'];
        unset($row['active_role']);

        // The Super Admin viewing the app as another account: header X-View-As (user id), with the role chosen for it in
        // X-View-As-Role. Nothing is stored; requests just act as that account (its data, its permissions), and
        // "viewed_by" says who is really there. Only the Super Admin's own sign-in can do this.
        $viewAs = $req->header('X-View-As');
        if ($viewAs !== null) {
            if ($row['role'] !== 'super_admin') {
                throw new HttpException(403, 'Only the Super Admin can view the app as another account');
            }
            $target = Db::one('SELECT ' . self::USER_COLUMNS . ' FROM users u WHERE u.id = ? AND u.disabled_at IS NULL', [(int) $viewAs]);
            if ($target === null || $target['role'] === 'super_admin') {
                throw new HttpException(404, 'That account isn\'t available to view');
            }
            $target['token_id']  = $row['token_id'];
            $target['viewed_by'] = ['id' => (int) $row['id'], 'name' => ($row['display_name'] ?? '') !== '' ? $row['display_name'] : ($row['username'] ?? $row['email'])];
            $row    = $target;
            $active = $req->header('X-View-As-Role');
        }
        $roles = self::availableRoles($row);
        if ($active !== null && !in_array($active, $roles, true)) {
            $active = null;
        }
        if ($active === null && count($roles) === 1) {
            $active = $roles[0];
        }
        return self::$current = $req->user = self::withRole($row, $active);
    }

    /** Changing your own password or name: not while the Super Admin is viewing as this account. */
    public static function requireOwnSession(array $user): array
    {
        if (isset($user['viewed_by'])) {
            throw new HttpException(403, 'You\'re viewing as another account; go back to your own to change this');
        }
        return $user;
    }

    /** Usage, AI routing and provider costs: the Super Admin only. */
    public static function requireSuper(Request $req): array
    {
        $user = self::requireUser($req);
        if (($user['account_role'] ?? $user['role']) !== 'super_admin') {
            throw new HttpException(403, 'Only the Super Admin can see this');
        }
        return $user;
    }

    /**
     * Settings → Users: Super Admin and Admins (Admins only for accounts below Admin; see canManage()). The Super Admin
     * account manages users whatever role it's acting in.
     */
    public static function requireUserAdmin(Request $req): array
    {
        $user = self::requireUser($req);
        if (($user['account_role'] ?? $user['role']) === 'super_admin') {
            return ['role' => 'super_admin'] + $user;
        }
        if (!in_array($user['role'], ['super_admin', 'admin'], true)) {
            throw new HttpException(403, 'Only administrators can manage users');
        }
        return $user;
    }

    /** Whether $actor may edit $target's account (and give it $newRole). */
    public static function canManage(array $actor, array $target, ?string $newRole = null): bool
    {
        if ((int) $actor['id'] === (int) $target['id'] || $target['role'] === 'super_admin') {
            return false; // nobody edits the Super Admin here, and your own account is under My account
        }
        if ($actor['role'] === 'super_admin') {
            return $newRole !== 'super_admin';
        }
        return $actor['role'] === 'admin' && $target['role'] === 'user' && ($newRole === null || $newRole === 'user');
    }

    /** General Tool (Recordings, Translate, Transcripts): Admins, and users on the free or paid plan. */
    public static function requireGeneral(Request $req): array
    {
        $user = self::requireUser($req);
        if (!self::hasGeneral($user)) {
            throw new HttpException(403, 'Your account doesn\'t include the General Tool');
        }
        return $user;
    }

    /** The General Tool plan in effect: Admins have everything; PT users without a plan of their own are Free. */
    public static function generalPlan(array $user): string
    {
        if ($user['role'] !== 'user') {
            return 'paid';
        }
        if ($user['general_plan'] === 'none' && $user['pt_role'] !== 'none') {
            return 'free';
        }
        return $user['general_plan'];
    }

    public static function hasGeneral(array $user): bool
    {
        return self::generalPlan($user) !== 'none';
    }

    /** Free plan: recording and limited translation, no transcription. */
    public static function isFree(array $user): bool
    {
        return self::generalPlan($user) === 'free';
    }

    /** Speech-to-text (live transcripts, transcribing recordings): not on the Free plan. */
    public static function requireTranscription(array $user): void
    {
        if (self::isFree($user)) {
            throw new HttpException(403, 'Transcription isn\'t included in the free plan. Recordings are saved as audio.');
        }
    }

    /** The user's level in one PT module: none | view | add | manage. Admins have PT only through their PT role. */
    public static function ptLevel(array $user, string $module): string
    {
        if ($user['role'] === 'super_admin' || $user['pt_role'] === 'big_man') {
            return 'manage';
        }
        if ($user['pt_module'] !== $module) {
            return 'none';
        }
        return match ($user['pt_role']) {
            'manager' => 'manage',
            'staff'   => 'add',
            default   => 'none',
        };
    }

    /** PT Management: $level or above in $module. */
    public static function requirePtModule(Request $req, string $module, string $level = 'view'): array
    {
        $user = self::requireUser($req);
        if (self::PT_LEVELS[self::ptLevel($user, $module)] < self::PT_LEVELS[$level]) {
            $what = ['view' => 'access to', 'add' => 'permission to add to', 'manage' => 'permission to change'][$level];
            throw new HttpException(403, "You don't have {$what} the PT " . ucfirst($module) . ' module');
        }
        return $user;
    }

    /** Any PT module at all (e.g. the PT status check). */
    public static function requirePt(Request $req): array
    {
        $user = self::requireUser($req);
        foreach (self::PT_MODULES as $m) {
            if (self::ptLevel($user, $m) !== 'none') {
                return $user;
            }
        }
        throw new HttpException(403, 'Your account doesn\'t include PT Management');
    }

    public static function logout(Request $req): void
    {
        $token = $req->bearerToken();
        if ($token !== null) {
            Db::run('DELETE FROM api_tokens WHERE token_hash = ?', [hash('sha256', $token)]);
        }
    }

    /** Changes your password and signs you out everywhere, this device included. */
    public static function changePassword(int $userId, string $current, string $new): void
    {
        $user = Db::one('SELECT password_hash FROM users WHERE id = ?', [$userId]);
        if ($user === null || !password_verify($current, $user['password_hash'])) {
            throw new HttpException(422, 'Current password is incorrect');
        }
        self::checkPassword($new);
        Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_DEFAULT), $userId]);
        Db::run('DELETE FROM api_tokens WHERE user_id = ?', [$userId]);
    }

    /** Where the user is signed in (one row per device sign-in), the current one marked. */
    public static function devices(array $user): array
    {
        return array_map(fn ($t) => [
            'id' => (int) $t['id'], 'device' => $t['device_name'], 'signed_in_at' => $t['created_at'],
            'last_used_at' => $t['last_used_at'], 'expires_at' => $t['expires_at'], 'current' => (int) $t['id'] === (int) $user['token_id'],
        ], Db::all(
            'SELECT id, device_name, created_at, last_used_at, expires_at FROM api_tokens
              WHERE user_id = ? AND expires_at > NOW() ORDER BY COALESCE(last_used_at, created_at) DESC',
            [$user['id']],
        ));
    }

    /** Signs one of your devices out ($tokenId), or every device except this one ($tokenId null). */
    public static function signOutDevices(array $user, ?int $tokenId): int
    {
        return $tokenId === null
            ? Db::run('DELETE FROM api_tokens WHERE user_id = ? AND id <> ?', [$user['id'], $user['token_id']])->rowCount()
            : Db::run('DELETE FROM api_tokens WHERE user_id = ? AND id = ?', [$user['id'], $tokenId])->rowCount();
    }

    public static function checkPassword(string $password): void
    {
        if (strlen($password) < 12) {
            throw new HttpException(422, 'Passwords need at least 12 characters');
        }
    }

    /** The fields clients may see, plus what the account can do (so the app shows only that). */
    public static function publicUser(array $u): array
    {
        $pt = [];
        foreach (self::PT_MODULES as $m) {
            $pt[$m] = self::ptLevel($u, $m);
        }
        $account = ['role' => $u['account_role'] ?? $u['role']] + $u;
        return [
            'id'           => (int) $u['id'],
            'roles'        => array_map(fn ($r) => ['id' => $r, 'label' => self::roleLabel($r)],
                self::availableRoles(isset($u['account_role']) ? self::accountFields($u) : $account)),
            'active_role'  => $u['active_role'] ?? null,
            'viewed_by'    => $u['viewed_by'] ?? null, // {id, name}: the Super Admin viewing as this account
            'account_role' => $account['role'],
            'email'        => $u['email'],
            'username'     => $u['username'],
            'display_name' => ($u['display_name'] ?? '') !== '' ? $u['display_name'] : ($u['username'] ?? $u['email'] ?? ''),
            'has_name'     => ($u['display_name'] ?? '') !== '',
            'language'     => ($u['language'] ?? 'en') === 'zh' ? 'zh' : 'en',
            'role'         => $u['role'],
            'general_plan' => $u['general_plan'],
            'pt_role'      => $u['pt_role'],
            'pt_module'    => $u['pt_module'],
            'access'       => [
                'general'      => self::hasGeneral($u),
                'general_plan' => self::generalPlan($u), // in effect (PT users without a plan: free)
                'transcribe'   => self::hasGeneral($u) && !self::isFree($u),
                'usage'        => $u['role'] === 'super_admin',
                'manage_users' => in_array($u['role'], ['super_admin', 'admin'], true) || $account['role'] === 'super_admin',
                'allowance'    => self::hasGeneral($u) ? Allowance::summary($u) : null, // today's translation words and transcription minutes
                'pt'           => $pt,
            ],
        ];
    }
}
