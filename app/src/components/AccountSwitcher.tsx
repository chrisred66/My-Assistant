// Super Admin: view the app as another account, from the button next to your name in the sidebar. Nothing is signed
// in or stored: requests carry "view as" (see api.viewAs), and the server acts as that account with its data and
// permissions. "Back to my account" drops it.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ManagedUser, type User } from "../lib/api";
import { errorMessage } from "../lib/format";

export function AccountSwitcher({ user, onSwitched }: { user: User; onSwitched: (u: User) => void }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<ManagedUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.viewableUsers().then(setAccounts, (e) => setError(errorMessage(e)));
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? []).filter(
      (a) => a.id !== user.id && (!q || [a.display_name, a.username, a.email].some((x) => x?.toLowerCase().includes(q))),
    );
  }, [accounts, query, user.id]);

  async function choose(id: number | null) {
    setBusy(true);
    setError(null);
    try {
      onSwitched(await api.viewAs(id));
      setOpen(false);
      setQuery("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-switcher" ref={box}>
      <button
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="View as another account"
        title="View as another account"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4l3 3-3 3M19 7h-4.5" />
        </svg>
      </button>
      {open && (
        <div className="account-menu" role="dialog" aria-label="View as another account">
          {user.viewed_by && (
            <button className="account-item back" onClick={() => void choose(null)} disabled={busy}>
              ← Back to my account <span className="muted small">({user.viewed_by.name})</span>
            </button>
          )}
          <input type="search" placeholder="Find an account…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Find an account" />
          {error && <p className="error-text small">{error}</p>}
          {accounts === null && !error && <p className="muted small">Loading…</p>}
          {accounts && shown.length === 0 && <p className="muted small">No other accounts.</p>}
          <div className="account-list">
            {shown.map((a) => (
              <button key={a.id} className="account-item" onClick={() => void choose(a.id)} disabled={busy}>
                <strong>{a.display_name}</strong>
                <span className="muted small">{a.roles.map((r) => r.label).join(" · ") || "No access"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
