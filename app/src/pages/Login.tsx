import { useState, type FormEvent } from "react";
import { api, configureApi, normalizeBaseUrl, type User } from "../lib/api";
import { errorMessage } from "../lib/format";
import { saveSettings, setToken, type Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onSignedIn: (settings: Settings, user: User) => void;
}

export default function Login({ settings, onSignedIn }: Props) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [email, setEmail] = useState(settings.email);
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(settings.deviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);

  async function testConnection() {
    setCheck("Checking…");
    try {
      const h = await api.health(normalizeBaseUrl(serverUrl));
      setCheck(h.ok ? "Server is reachable." : "Server answered, but not OK.");
    } catch (e) {
      setCheck(errorMessage(e));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = normalizeBaseUrl(serverUrl);
    try {
      const { token, user } = await api.login(base, email, password, deviceName.trim() || "unknown device");
      await setToken(token);
      const next: Settings = { serverUrl: base, email: user.email ?? user.username ?? email.trim(), deviceName: deviceName.trim() };
      await saveSettings(next);
      configureApi({ baseUrl: base, token });
      onSignedIn(next, user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="center-screen">
      <form className="card narrow stack" onSubmit={(e) => void submit(e)}>
        <h1>Sign in to My Assistant</h1>

        <label className="field">
          <span>Server address</span>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} required spellCheck={false} />
          <small className="muted">
            On this PC: http://localhost/chrisManager/server/public. From other devices: your desktop's Tailscale name.
          </small>
        </label>
        <div className="row">
          <button type="button" onClick={() => void testConnection()}>
            Test connection
          </button>
          {check && <span className="muted small">{check}</span>}
        </div>

        <label className="field">
          <span>Email or username</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" spellCheck={false} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="field">
          <span>Device name</span>
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} />
          <small className="muted">Shown on the server so you can tell your logins apart.</small>
        </label>

        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
