// Choosing which role to act in: the full-screen picker after sign-in (accounts with several roles) and the compact
// switcher in the sidebar. The server applies the chosen role (POST /auth/role), so the app shows just what it allows.
import { useState } from "react";
import { api, type User, type UserRole } from "../lib/api";
import { errorMessage } from "../lib/format";
import { ErrorText } from "./common";

const MODULES: Record<string, string> = { operations: "Operations", maintenance: "Repair & Maintenance", planning: "Fleet, Trials and Charging" };

/** One line on what a role can do. */
export function roleDescription(id: string): string {
  const [kind, a, b] = id.split(":");
  if (kind === "super_admin") return "Everything, including Usage and all users.";
  if (kind === "admin") return "Everything except Usage; manages users below Admin.";
  if (kind === "general") return a === "paid" ? "Recordings with transcription, Translate and Transcripts." : "Record audio and 10 Translate requests a day.";
  if (a === "big_man") return "All PT modules, with full rights.";
  return `${MODULES[b] ?? b}: ${a === "manager" ? "add, edit, close and delete" : "view and add"}. General Tool as Free.`;
}

function group(id: string): string {
  return id.startsWith("pt:") ? "PT Management" : id.startsWith("general:") ? "General User" : "Administration";
}

/** After sign-in, before the main window: pick a role. */
export function RolePicker({
  user,
  onChosen,
  onSignOut,
  signOutLabel = "Sign out",
}: {
  user: User;
  onChosen: (u: User) => void;
  onSignOut: () => void;
  signOutLabel?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(role: UserRole) {
    setBusy(role.id);
    setError(null);
    try {
      onChosen(await api.setRole(role.id));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  const groups = [...new Set(user.roles.map((r) => group(r.id)))];
  return (
    <div className="center-screen">
      <div className="card role-picker stack">
        <div className="stack-tight">
          <h1>Choose a role</h1>
          <p className="muted">
            {user.viewed_by ? `Viewing as ${user.display_name}.` : `Signed in as ${user.display_name}.`} You can switch roles at any time from the
            sidebar.
          </p>
        </div>
        {groups.map((g) => (
          <div key={g} className="stack-tight">
            <h3>{g}</h3>
            <div className="role-grid">
              {user.roles
                .filter((r) => group(r.id) === g)
                .map((r) => (
                  <button key={r.id} className="role-card" onClick={() => void choose(r)} disabled={busy !== null}>
                    <strong>{r.label.replace(/^(PT|General User) · /, "")}</strong>
                    <span className="muted small">{busy === r.id ? "Opening…" : roleDescription(r.id)}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        <ErrorText message={error} />
        <div>
          <button className="link-btn small" onClick={onSignOut}>
            {signOutLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Sidebar: the active role, and a list to switch to another. */
export function RoleSwitcher({ user, onSwitched }: { user: User; onSwitched: (u: User) => void }) {
  const [busy, setBusy] = useState(false);
  if (user.roles.length < 2) return null;
  return (
    <label className="role-switcher" title={user.active_role ? roleDescription(user.active_role) : undefined}>
      <span>Acting as</span>
      <select
        value={user.active_role ?? ""}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          api.setRole(e.target.value).then(onSwitched, () => {}).finally(() => setBusy(false));
        }}
      >
        {[...new Set(user.roles.map((r) => group(r.id)))].map((g) => (
          <optgroup key={g} label={g}>
            {user.roles
              .filter((r) => group(r.id) === g)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
