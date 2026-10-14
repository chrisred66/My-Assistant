import { useCallback, useEffect, useState } from "react";
import "./App.css";
import "@fontsource-variable/space-grotesk";
import "./theme.css";
import ThemeSwitch from "./components/ThemeSwitch";
import BackToTop from "./components/BackToTop";
import { RolePicker, RoleSwitcher } from "./components/RolePicker";
import { AccountSwitcher } from "./components/AccountSwitcher";
import { api, ApiError, configureApi, hasPt, type User } from "./lib/api";
import { ballEnabled, hideBall, showBall } from "./lib/ball";
import { hidePet, petEnabled, showPet } from "./lib/pet";
import { errorMessage } from "./lib/format";
import { clearToken, getToken, loadSettings, type Settings } from "./lib/settings";
import Login from "./pages/Login";
import Language, { type LanguageTab } from "./pages/Language";
import PtManagement from "./pages/pt/PtManagement";
import SettingsPage from "./pages/Settings";
import Usage from "./pages/Usage";
import DailyFeed from "./pages/DailyFeed";
import { watchDailyFeed } from "./lib/feedNotify";
import { isDesktop } from "./lib/platform";
import { listen } from "@tauri-apps/api/event";
import { serveActivityRequests } from "./lib/activity";

const APP_NAME = "My Assistant";

type Page = "pt" | "feed" | "language" | "usage" | "settings";

const NAV: { id: Page; label: string; visible: (u: User) => boolean }[] = [
  { id: "pt", label: "PT Management", visible: (u) => hasPt(u) },
  { id: "feed", label: "Daily Feed", visible: (u) => u.access.general },
  { id: "language", label: "General Tool", visible: (u) => u.access.general },
  { id: "usage", label: "Usage", visible: (u) => u.access.usage },
  { id: "settings", label: "Settings", visible: () => true },
];

/** First page this user may open. */
const homePage = (u: User): Page => NAV.find((n) => n.visible(u))?.id ?? "settings";

type Session =
  | { state: "loading" }
  | { state: "signedOut"; settings: Settings }
  | { state: "offline"; settings: Settings; message: string }
  | { state: "signedIn"; settings: Settings; user: User };

serveActivityRequests(); // the desktop ball asks what's going on when it opens

export default function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [page, setPage] = useState<Page>("pt");
  const [languageTab, setLanguageTab] = useState<LanguageTab>("recordings");

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

  // The desktop usage ball shows usage, which only the Super Admin can see: shown while they're signed in (in any role,
  // if switched on in Settings), hidden otherwise.
  const ballOwner = isDesktop && session.state === "signedIn" && (session.user.account_role === "super_admin" || session.user.viewed_by !== null);
  useEffect(() => {
    if (ballOwner) void ballEnabled().then((on) => (on ? showBall() : hideBall()));
    else void hideBall();
    // The desktop pet, likewise Super Admin only.
    if (ballOwner) void petEnabled().then((on) => (on ? showPet() : hidePet()));
    else void hidePet();
  }, [ballOwner]);

  // Daily Feed delivery (the Super Admin): the 8:00 notification and the pet's announcement.
  useEffect(() => {
    if (!ballOwner) return;
    return watchDailyFeed();
  }, [ballOwner]);
  // The pet's "open" button: show a page.
  useEffect(() => {
    const unlisten = listen<{ page: string }>("open-page", (e) => {
      if (NAV.some((n) => n.id === e.payload.page)) setPage(e.payload.page as Page);
    });
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  async function logout() {
    // Viewing as another account: "sign out" goes back to your own account instead.
    if (session.state === "signedIn" && session.user.viewed_by) return switchAccount(await api.viewAs(null));
    try {
      await api.logout();
    } catch {
      // the token is dropped locally either way
    }
    await signOutLocally();
  }

  /** After viewing as another account (or going back): its first page unless it has the current one. */
  function switchAccount(user: User) {
    setPage((p) => (NAV.find((n) => n.id === p)?.visible(user) ? p : homePage(user)));
    setSession((s) => (s.state === "signedIn" ? { ...s, user } : s));
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

  // Several roles and none chosen yet: pick one before the main window.
  if (session.user.roles.length > 1 && !session.user.active_role) {
    return (
      <RolePicker
        user={session.user}
        onChosen={(user) => {
          setPage(homePage(user));
          setSession({ ...session, user });
        }}
        onSignOut={() => void logout()}
        signOutLabel={session.user.viewed_by ? "Back to my account" : undefined}
      />
    );
  }

  /** After switching role: stay on the page if the new role has it, otherwise go to its first page. */
  const switchRole = (user: User) => {
    setPage((p) => (NAV.find((n) => n.id === p)?.visible(user) ? p : homePage(user)));
    setSession({ ...session, user });
  };

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">{APP_NAME}</div>
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
        <div className="sidebar-footer">
          {session.user.viewed_by && (
            <div className="viewing-as" role="status">
              <span>
                Viewing as <strong>{session.user.display_name}</strong>
              </span>
              <button className="small-btn" onClick={() => void api.viewAs(null).then(switchAccount)}>
                Back to my account
              </button>
            </div>
          )}
          <RoleSwitcher user={session.user} onSwitched={switchRole} />
          <ThemeSwitch />
          <div className="sidebar-user-row">
            <span className="sidebar-user" title={session.settings.serverUrl}>
              {session.user.display_name}
            </span>
            {(session.user.account_role === "super_admin" || session.user.viewed_by) && (
              <AccountSwitcher user={session.user} onSwitched={switchAccount} />
            )}
          </div>
        </div>
      </nav>
      {/* Keyed by account and role, so each page starts fresh with that account's data and permissions. */}
      <main className="content" key={`${session.user.id}:${session.user.active_role ?? "all"}`}>
        {page === "language" && (
          <Language
            tab={languageTab}
            onTab={setLanguageTab}
            canTranscribe={session.user.access.transcribe}
          />
        )}
        {page === "feed" && <DailyFeed user={session.user} />}
        {page === "usage" && <Usage />}
        {page === "pt" && <PtManagement user={session.user} />}
        {page === "settings" && <SettingsPage
            settings={session.settings}
            user={session.user}
            onLogout={() => void logout()}
            onUserChange={(user) => setSession({ ...session, user })}
          />}
        <BackToTop />
      </main>
    </div>
  );
}
