import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../components/common";
import { api, PROVIDER_LABELS, type AiRoute, type AiRouting, type ManagedUser, type PtAccess, type User } from "../lib/api";
import { errorMessage, formatDateTime } from "../lib/format";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  user: User;
  onLogout: () => void;
}

const PT_ACCESS_LABELS: Record<PtAccess, string> = {
  none: "No access",
  view: "View",
  edit: "Edit (add, upload)",
  admin: "Admin (also remove)",
};

export default function SettingsPage({ settings, user, onLogout }: Props) {
  const owner = user.role === "owner";
  const [check, setCheck] = useState<string | null>(null);

  async function testConnection() {
    setCheck("Checking…");
    try {
      const h = await api.health(settings.serverUrl);
      setCheck(h.ok ? `Reachable · server time ${h.time}` : "Server answered, but not OK.");
    } catch (e) {
      setCheck(errorMessage(e));
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <div className="card stack">
        <dl className="kv">
          <dt>Signed in as</dt>
          <dd>
            {user.display_name}
            {user.email && user.email !== user.display_name ? ` (${user.email})` : ""}
            {owner ? " · owner" : ` · PT ${PT_ACCESS_LABELS[user.pt_access].toLowerCase()}`}
          </dd>
          <dt>Server</dt>
          <dd className="mono">{settings.serverUrl}</dd>
          <dt>This device</dt>
          <dd>{settings.deviceName}</dd>
        </dl>
        <div className="row wrap">
          <button onClick={() => void testConnection()}>Test connection</button>
          {check && <span className="muted small">{check}</span>}
        </div>
      </div>

      <ChangePassword />
      {owner && <Users />}
      {owner && <Routing />}

      <div className="card stack">
        <h2>Sign out</h2>
        <p className="muted small">
          Revokes this device's token on the server. To switch servers (for example to your desktop's Tailscale address), sign out and
          sign in again with the new address.
        </p>
        <div>
          <button className="danger" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>Change password</h2>
      <div className="row wrap">
        <label className="field inline grow">
          <span>Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="field inline grow">
          <span>New password (12+ characters)</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} autoComplete="new-password" />
        </label>
        <label className="field inline grow">
          <span>Confirm new password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Change"}
        </button>
      </div>
      <ErrorText message={error} />
      {done && <p className="small">Password changed.</p>}
    </form>
  );
}

/** Owner: accounts for other people (PT Management members). */
function Users() {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await api.users());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(u: ManagedUser, patch: Parameters<typeof api.updateUser>[1]) {
    setError(null);
    try {
      await api.updateUser(u.id, patch);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function resetPassword(u: ManagedUser) {
    const password = window.prompt(`New password for ${u.display_name} (12+ characters). They'll be signed out everywhere.`);
    if (password) await update(u, { password });
  }

  return (
    <div className="card stack">
      <div className="row space-between">
        <h2>Users</h2>
        <button className="small-btn" onClick={() => setShowAdd((s) => !s)} aria-expanded={showAdd}>
          {showAdd ? "Cancel" : "Add user…"}
        </button>
      </div>
      <p className="muted small">Other people only see PT Management, at the access level you give them.</p>
      {showAdd && (
        <AddUser
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
      <ErrorText message={error} />
      {users && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Login</th>
              <th>PT access</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? "muted" : undefined}>
                <td>
                  {u.display_name}
                  {u.disabled && " (disabled)"}
                </td>
                <td className="mono">{u.username ?? u.email}</td>
                <td>
                  {u.role === "owner" ? (
                    "Owner (everything)"
                  ) : (
                    <select value={u.pt_access} onChange={(e) => void update(u, { pt_access: e.target.value as PtAccess })}>
                      {(Object.keys(PT_ACCESS_LABELS) as PtAccess[]).map((a) => (
                        <option key={a} value={a}>
                          {PT_ACCESS_LABELS[a]}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>{formatDateTime(u.created_at)}</td>
                <td className="num">
                  {u.role !== "owner" && (
                    <div className="row">
                      <button className="small-btn" onClick={() => void resetPassword(u)}>
                        Reset password
                      </button>
                      <button className="small-btn" onClick={() => void update(u, { disabled: !u.disabled })}>
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddUser({ onAdded }: { onAdded: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [access, setAccess] = useState<PtAccess>("view");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser({
        username: username.trim() || undefined,
        email: email.trim() || undefined,
        display_name: displayName.trim() || undefined,
        pt_access: access,
        password,
      });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row wrap">
        <label className="field inline">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
        </label>
        <label className="field inline grow">
          <span>Email (optional)</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field inline grow">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>PT access</span>
          <select value={access} onChange={(e) => setAccess(e.target.value as PtAccess)}>
            {(Object.keys(PT_ACCESS_LABELS) as PtAccess[]).map((a) => (
              <option key={a} value={a}>
                {PT_ACCESS_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline grow">
          <span>Initial password (12+ characters)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy || (!username.trim() && !email.trim())}>
          {busy ? "Adding…" : "Add user"}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

function Routing() {
  const [routing, setRouting] = useState<AiRouting | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.routing().then(setRouting, (e) => setError(errorMessage(e)));
  }, []);

  const route = (r: AiRoute) => `${PROVIDER_LABELS[r.provider] ?? r.provider} · ${r.model ?? "model not set"}`;

  return (
    <div className="card stack">
      <h2>AI routing</h2>
      <p className="muted small">Fixed on the server (TRANSLATE_PROVIDER and LIGHT_PROVIDER in server/.env).</p>
      <ErrorText message={error} />
      {routing && (
        <dl className="kv">
          <dt>Translation</dt>
          <dd>{route(routing.translate)}</dd>
          <dt>Transcription</dt>
          <dd>{route(routing.transcribe)}</dd>
          <dt>Light tasks</dt>
          <dd>{route(routing.light)}</dd>
        </dl>
      )}
    </div>
  );
}
