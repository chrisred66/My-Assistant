import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { api, ApiError, canPt, configureApi, type User } from "./lib/api";
import { errorMessage } from "./lib/format";
import { clearToken, getToken, loadSettings, type Settings } from "./lib/settings";
import Login from "./pages/Login";
import PtManagement from "./pages/pt/PtManagement";
import Recordings from "./pages/Recordings";
import SettingsPage from "./pages/Settings";
import Transcripts from "./pages/Transcripts";
import Translate from "./pages/Translate";
import Usage from "./pages/Usage";

type Page = "translate" | "recordings" | "transcripts" | "usage" | "pt" | "settings";

const NAV: { id: Page; label: string; visible: (u: User) => boolean }[] = [
  { id: "translate", label: "Translate", visible: (u) => u.role === "owner" },
  { id: "recordings", label: "Recordings", visible: (u) => u.role === "owner" },
  { id: "transcripts", label: "Transcripts", visible: (u) => u.role === "owner" },
  { id: "usage", label: "Usage", visible: (u) => u.role === "owner" },
  { id: "pt", label: "PT Management", visible: (u) => canPt(u) },
  { id: "settings", label: "Settings", visible: () => true },
];

/** First page this user may open. */
const homePage = (u: User): Page => NAV.find((n) => n.visible(u))?.id ?? "settings";

type Session =
  | { state: "loading" }
  | { state: "signedOut"; settings: Settings }
  | { state: "offline"; settings: Settings; message: string }
  | { state: "signedIn"; settings: Settings; user: User };

export default function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [page, setPage] = useState<Page>("translate");

  const signOutLocally = useCallback(async () => {
    await clearToken();
    configureApi({ token: null });
    setSession({ state: "signedOut", settings: await loadSettings() });
  }, []);

  const restore = useCallback(async () => {
    setSession({ state: "loading" });
    const settings = await loadSettings();
    const token = await getToken();
    configureApi({ baseUrl: settings.serverUrl, token, onUnauthorized: () => void signOutLocally() });
    if (!token) {
      setSession({ state: "signedOut", settings });
      return;
    }
    try {
      const user = await api.me();
      setPage((p) => (NAV.find((n) => n.id === p)?.visible(user) ? p : homePage(user)));
      setSession({ state: "signedIn", settings, user });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await signOutLocally();
      } else {
        setSession({ state: "offline", settings, message: errorMessage(e) });
      }
    }
  }, [signOutLocally]);

  useEffect(() => {
    void restore();
  }, [restore]);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // the token is dropped locally either way
    }
    await signOutLocally();
  }

  if (session.state === "loading") {
    return <div className="center-screen muted">Loading…</div>;
  }

  if (session.state === "signedOut") {
        return (
      <Login
        settings={session.settings}
        onSignedIn={(settings, user) => {
          setPage(homePage(user));
          setSession({ state: "signedIn", settings, user });
        }}
      />
    );
  }

  if (session.state === "offline") {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Can't reach the server</h1>
          <p className="error-text">{session.message}</p>
          <p className="muted">Server: {session.settings.serverUrl}</p>
          <div className="row">
            <button className="primary" onClick={() => void restore()}>
              Try again
            </button>
            <button onClick={() => void signOutLocally()}>Change server / sign in again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">chrisManager</div>
        {NAV.filter((item) => item.visible(session.user)).map((item) => (
          <button
            key={item.id}
            className={`nav-item${page === item.id ? " active" : ""}`}
            aria-current={page === item.id ? "page" : undefined}
            onClick={() => setPage(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="sidebar-footer muted" title={session.settings.serverUrl}>
          {session.user.display_name}
        </div>
      </nav>
      <main className="content">
        {page === "translate" && <Translate />}
        {page === "recordings" && <Recordings />}
        {page === "transcripts" && <Transcripts />}
        {page === "usage" && <Usage />}
        {page === "pt" && <PtManagement user={session.user} />}
        {page === "settings" && <SettingsPage settings={session.settings} user={session.user} onLogout={() => void logout()} />}
      </main>
    </div>
  );
}
