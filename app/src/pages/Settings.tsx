import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../components/common";
import { api, type ActivityEntry, type Device, type GeneralPlan, type ManagedUser, type PtModule, type PtRole, type Role, type User } from "../lib/api";
import { ballEnabled, setBallEnabled } from "../lib/ball";
import { clearSkin, loadPack, loadSkin, petEnabled, petLook, saveSkinImage, setPetEnabled, setPetLook, setSkinCredit, setSkinFacing, skinCredit, skinFacing, SKIN_MOODS, type LoadedPack, type PetLook, type PetSkin, type SkinMood } from "../lib/pet";
import ThemeSwitch from "../components/ThemeSwitch";
import LanguageSwitch from "../components/LanguageSwitch";
import { checkForUpdates, currentVersion, getAutoUpdate, RELEASES_URL, setAutoUpdate, useUpdates } from "../lib/updates";
import { isDesktop } from "../lib/platform";
import { errorMessage, formatDateTime } from "../lib/format";
import type { Settings } from "../lib/settings";
import { t } from "../lib/i18n";

interface Props {
  settings: Settings;
  user: User;
  onLogout: () => void;
  onUserChange: (user: User) => void;
}

const ROLE_LABELS: Record<Role, string> = { super_admin: "Super Admin", admin: "Admin", user: "User" };
const PLAN_LABELS: Record<GeneralPlan, string> = { none: "No access", free: "Free", paid: "Paid" };
const PT_ROLE_LABELS: Record<PtRole, string> = { none: "No access", big_man: "Big Man (all PT)", manager: "Manager", staff: "Low Man" };
const MODULE_LABELS: Record<PtModule, string> = { operations: "Operations", maintenance: "Maintenance", planning: "Planning" };

/** "Maintenance Manager", "Big Man (all PT)", "No access". */
function ptLabel(role: PtRole, module: PtModule | null): string {
  return (role === "manager" || role === "staff") && module ? `${t(MODULE_LABELS[module])} ${t(PT_ROLE_LABELS[role])}` : t(PT_ROLE_LABELS[role]);
}

/** One line describing the account: "Super Admin", or "General User free · PT Maintenance Low Man". */
function groupsLabel(u: User): string {
  if (u.role !== "user") return t(ROLE_LABELS[u.role]);
  const plan = u.access.general_plan; // PT users without a plan of their own are free
  const parts = [
    plan !== "none" ? t("General User {lowerCase}{v}", { lowerCase: t(PLAN_LABELS[plan]).toLowerCase(), v: u.general_plan === "none" ? t(" (with PT)") : "" }) : null,
    u.pt_role !== "none" ? t("PT {role}", { role: ptLabel(u.pt_role, u.pt_module) }) : null,
  ];
  return parts.filter(Boolean).join(" · ") || t("No access yet");
}

export default function SettingsPage({ settings, user, onLogout, onUserChange }: Props) {
  const [check, setCheck] = useState<string | null>(null);

  async function testConnection() {
    setCheck(t("Checking…"));
    try {
      const h = await api.health(settings.serverUrl);
      setCheck(h.ok ? t("Reachable · server time {time}", { time: h.time }) : t("Server answered, but not OK."));
    } catch (e) {
      setCheck(errorMessage(e));
    }
  }

  return (
    <section className="page">
      <header className="page-header sticky-head">
        <h1>{t("Settings")}</h1>
      </header>

      <div className="card stack">
        <dl className="kv">
          <dt>{t("Signed in as")}</dt>
          <dd>
            {user.display_name}
            {user.email && user.email !== user.display_name ? ` (${user.email})` : ""}
            {" · "}
            {user.active_role ? t(user.roles.find((r) => r.id === user.active_role)?.label ?? groupsLabel(user)) : groupsLabel(user)}
            {user.roles.length > 1 && <span className="muted small"> {t("(switch roles in the sidebar)")}</span>}
          </dd>
          <dt>{t("Server")}</dt>
          <dd className="mono">{settings.serverUrl}</dd>
          <dt>{t("This device")}</dt>
          <dd>{settings.deviceName}</dd>
        </dl>
        <div className="row wrap">
          <button onClick={() => void testConnection()}>{t("Test connection")}</button>
          {check && <span className="muted small">{check}</span>}
        </div>
      </div>

      <div className="card stack">
        <h2>{t("Appearance")}</h2>
        <div className="row wrap">
          <ThemeSwitch />
          <span className="muted small align-end">{t("Follow the system, light or dark. Remembered on this device.")}</span>
        </div>
        <div className="row wrap">
          <LanguageSwitch
            onChange={(language) => {
              // Saved with your account, so it follows you to every device (not while viewing as someone else).
              if (!user.viewed_by) void api.setLanguage(language).then(onUserChange, () => {});
            }}
          />
          <span className="muted small align-end">{t("The app's language. Saved with your account, so it follows you to every device.")}</span>
        </div>
      </div>
      <UpdatesSetting />
      <YourName user={user} onUserChange={onUserChange} />
      {isDesktop && user.access.usage && <UsageBallSetting />}
      {isDesktop && user.access.usage && <PetSetting />}
      <ChangePassword onSignedOut={onLogout} />
      {!user.viewed_by && <Devices />}
      {user.access.manage_users && <Users me={user} />}
      {user.access.manage_users && <Activity me={user} />}

      <div className="card stack">
        <h2>{t("Sign out")}</h2>
        <p className="muted small">
          {t("Revokes this device's token on the server. To switch servers (for example to your desktop's Tailscale address), sign out and sign in again with the new address.")}
        </p>
        <div>
          <button className="danger" onClick={onLogout}>
            {t("Sign out")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Super Admin: the floating desktop ball with today's and this month's tokens per provider. */
function UsageBallSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ballEnabled().then(setOn, () => setOn(false));
  }, []);

  async function toggle(next: boolean) {
    setError(null);
    try {
      await setBallEnabled(next);
      setOn(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="card stack">
      <h2>{t("Desktop usage ball")}</h2>
      <label className="check">
        <input type="checkbox" checked={!!on} disabled={on === null} onChange={(e) => void toggle(e.target.checked)} />
        {t("Show a floating ball on the desktop with token usage")}
      </label>
      <p className="muted small">
        {t("It stays on top of other windows and switches provider every 6 seconds, showing tokens used today and this month (refreshed every 2 minutes). Drag it anywhere; double-click it to bring this window back. It closes when you quit the app.")}
      </p>
      <ErrorText message={error} />
    </div>
  );
}

function PetSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    petEnabled().then(setOn, () => setOn(false));
  }, []);

  async function toggle(next: boolean) {
    setError(null);
    try {
      await setPetEnabled(next);
      setOn(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="card stack">
      <h2>{t("Desktop pet")}</h2>
      <label className="check">
        <input type="checkbox" checked={!!on} disabled={on === null} onChange={(e) => void toggle(e.target.checked)} />
        {t("Show the blue whale on the desktop")}
      </label>
      <p className="muted small">
        {t("It swims around the screen and eats a bowl of rice whenever tokens are used, getting rounder through the day. It shows what you're doing (headphones while you record), sleeps late at night and gets hungry at meal times. Click it for today's tokens, stroke it to make it happy, double-click to open this window, drag it anywhere, right-click for Stay here / Swim around. It hides while another app is full screen.")}
      </p>
      <ErrorText message={error} />
      <PetLookSetting />
      <PetSkinSetting />
    </div>
  );
}

/** Which character: the installed animation pack, your images, or the built-in whale. */
function PetLookSetting() {
  const [look, setLook] = useState<PetLook>("auto");
  const [pack, setPack] = useState<LoadedPack | null>(null);

  useEffect(() => {
    void petLook().then(setLook);
    void loadPack().then(setPack);
  }, []);

  async function choose(next: PetLook) {
    setLook(next);
    await setPetLook(next);
  }

  return (
    <div className="stack-tight">
      <label className="field inline">
        <span>{t("Character")}</span>
        <select value={look} onChange={(e) => void choose(e.target.value as PetLook)}>
          <option value="auto">{t("Automatic (best available)")}</option>
          <option value="pack" disabled={!pack}>
            {pack ? t("Animation pack: {name}", { name: pack.pack.name }) : t("Animation pack (not installed)")}
          </option>
          <option value="images">{t("Your images (below)")}</option>
          <option value="whale">{t("Built-in whale")}</option>
        </select>
      </label>
      {pack && (
        <p className="muted small">
          {pack.pack.credit}{" "}
          <a href={pack.pack.link} target="_blank" rel="noreferrer">
            {pack.pack.link}
          </a>
        </p>
      )}
    </div>
  );
}

const MOOD_LABELS: Record<SkinMood, string> = {
  idle: "Idle",
  swim: "Swimming",
  eating: "Eating",
  happy: "Happy / petted",
  sleepy: "Sleepy",
  hungry: "Hungry",
  busy: "Busy",
  held: "Being dragged",
};

/** The pet's look: your own images, one per mood (missing ones borrow from Idle). */
function PetSkinSetting() {
  const [skin, setSkin] = useState<PetSkin>({});
  const [facing, setFacing] = useState<"left" | "right">("right");
  const [credit, setCredit] = useState("");
  const [busy, setBusy] = useState<SkinMood | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setSkin(await loadSkin());
    setFacing(await skinFacing());
    setCredit(await skinCredit());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(which: SkinMood | "all", work: () => Promise<void>) {
    setBusy(which);
    setError(null);
    try {
      await work();
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const any = Object.keys(skin).length > 0;
  return (
    <details className="pet-skin" open={any}>
      <summary>{t("Look: {v}", { v: any ? t("your images") : t("built-in whale") })}</summary>
      <p className="muted small">
        {t("Use your own character: an image (PNG, GIF, WebP; animated GIFs work, transparent backgrounds look best) for each mood. Missing moods use Idle, and the rice bowl, Zzz and hearts are added around it. Only use images you're allowed to use.")}
      </p>
      <div className="pet-skin-grid">
        {SKIN_MOODS.map((m) => (
          <div key={m} className="pet-skin-slot">
            <div className="pet-skin-preview">{skin[m] ? <img src={skin[m]} alt={t(MOOD_LABELS[m])} /> : <span className="muted small">{m === "idle" ? t("None") : t("Uses Idle")}</span>}</div>
            <strong className="small">{t(MOOD_LABELS[m])}</strong>
            <div className="row">
              <label className="small-btn file-btn">
                {busy === m ? t("Saving…") : skin[m] ? t("Replace") : t("Choose…")}
                <input
                  type="file"
                  accept="image/png,image/gif,image/webp,image/jpeg"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void run(m, () => saveSkinImage(m, file));
                  }}
                />
              </label>
              {skin[m] && (
                <button className="link-btn small" disabled={busy !== null} onClick={() => void run(m, () => clearSkin(m))}>
                  {t("Remove")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("The images face")}</span>
          <select value={facing} onChange={(e) => void run("all", () => setSkinFacing(e.target.value as "left" | "right"))}>
            <option value="right">{t("Right")}</option>
            <option value="left">{t("Left")}</option>
          </select>
        </label>
        <label className="field inline grow">
          <span>{t("Credits")}</span>
          <input
            value={credit}
            onChange={(e) => setCredit(e.target.value)}
            onBlur={() => void setSkinCredit(credit).catch(() => {})}
            placeholder={t("Who made these images, and under what licence")}
          />
        </label>
        {any && (
          <button
            className="small-btn align-end"
            disabled={busy !== null}
            onClick={() => window.confirm(t("Remove all images and go back to the whale?")) && void run("all", () => clearSkin(null))}
          >
            {t("Remove all")}
          </button>
        )}
      </div>
      <ErrorText message={error} />
    </details>
  );
}

/** Your display name, shown in the sidebar instead of your login. */
function YourName({ user, onUserChange }: { user: User; onUserChange: (u: User) => void }) {
  const [name, setName] = useState(user.has_name === false ? "" : user.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      onUserChange(await api.updateProfile(name.trim()));
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{t("Your name")}</h2>
      <p className="muted small">{t("Shown at the bottom of the sidebar. Leave it empty to show your login ({v}) instead.", { v: user.username ?? user.email })}</p>
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? t("Saving…") : t("Save")}
        </button>
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{t("Saved.")}</p>}
    </form>
  );
}

/** After a change the server signs out every device, this one too, so the app goes back to the sign-in screen. */
function ChangePassword({ onSignedOut }: { onSignedOut: () => void }) {
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
      setError(t("The new passwords don't match."));
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      window.alert(t("Password changed. You've been signed out on all your devices: sign in again with your new password."));
      onSignedOut();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{t("Change password")}</h2>
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Current password")}</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="field inline grow">
          <span>{t("New password (12+ characters)")}</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} autoComplete="new-password" />
        </label>
        <label className="field inline grow">
          <span>{t("Confirm new password")}</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? t("Saving…") : t("Change")}
        </button>
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{t("Password changed.")}</p>}
    </form>
  );
}

/** Administrators: everyone's accounts and groups. Admins can change only accounts below Admin. */
function Users({ me }: { me: User }) {
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
    const password = window.prompt(t("New password for {display_name} (12+ characters). They'll be signed out everywhere.", { display_name: u.display_name }));
    if (password) await update(u, { password });
  }

  return (
    <div className="card stack">
      <div className="row space-between">
        <h2>{t("Users")}</h2>
        <button className="small-btn" onClick={() => setShowAdd((s) => !s)} aria-expanded={showAdd}>
          {showAdd ? t("Cancel") : t("Add user…")}
        </button>
      </div>
      <p className="muted small">{t("Each account has a General User plan (the General Tool: Recordings, Translate, Transcripts, Daily Feed) and a PT role. Free: record (audio only) and 300 words of translation a day, no transcription. Paid: 3,000 words of translation and 60 minutes of transcription (recordings and meetings together) a day. Everyone has 125 MB of audio storage. PT users get Free unless given Paid. PT Managers and Low Man work in one module (Planning = Fleet, Trials, Charging); Low Man can view and add, Managers can also edit, close and delete. Admins manage accounts below Admin and use the General Tool as Paid; they see PT only with a PT role. {v}", { v: me.account_role === "super_admin" ? "" : t("Admins can change accounts below Admin only.") })}</p>
      {showAdd && (
        <AddUser
          me={me}
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
      <ErrorText message={error} />
      {users && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("Name")}</th>
                <th>{t("Role")}</th>
                <th>{t("General User")}</th>
                <th>{t("PT Management")}</th>
                <th>{t("Added")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.disabled ? "muted-row" : undefined}>
                  <td>
                    {u.display_name}
                    {u.disabled && " (disabled)"}
                    <div className="muted small mono">{u.username ?? u.email}</div>
                  </td>
                  <td>
                    {u.editable && me.account_role === "super_admin" ? (
                      <select value={u.role} onChange={(e) => void update(u, { role: e.target.value as "admin" | "user" })} aria-label={t("Role of {display_name}", { display_name: u.display_name })}>
                        <option value="user">{t("User")}</option>
                        <option value="admin">{t("Admin")}</option>
                      </select>
                    ) : (
                      t(ROLE_LABELS[u.role])
                    )}
                  </td>
                  <td>
                    {u.role !== "user" ? (
                      <span className="muted small">{u.role === "admin" ? t("Paid") : "all"}</span>
                    ) : u.editable ? (
                      <select value={u.general_plan} onChange={(e) => void update(u, { general_plan: e.target.value as GeneralPlan })} aria-label={t("General User plan of {display_name}", { display_name: u.display_name })}>
                        {(Object.keys(PLAN_LABELS) as GeneralPlan[]).map((p) => (
                          <option key={p} value={p}>
                            {p === "none" && u.pt_role !== "none" ? t("Free (with PT)") : t(PLAN_LABELS[p])}
                          </option>
                        ))}
                      </select>
                    ) : u.general_plan === "none" && u.pt_role !== "none" ? (
                      t("Free (with PT)")
                    ) : (
                      t(PLAN_LABELS[u.general_plan])
                    )}
                  </td>
                  <td>
                    {u.role === "super_admin" ? (
                      <span className="muted small">{t("all")}</span>
                    ) : u.editable ? (
                      <PtGroupPicker
                        role={u.pt_role}
                        module={u.pt_module}
                        onChange={(pt_role, pt_module) => void update(u, { pt_role, pt_module: pt_module ?? "" })}
                        label={u.display_name}
                      />
                    ) : (
                      ptLabel(u.pt_role, u.pt_module)
                    )}
                  </td>
                  <td className="nowrap">{formatDateTime(u.created_at)}</td>
                  <td className="num">
                    {u.editable && (
                      <div className="row">
                        <button className="small-btn" onClick={() => void resetPassword(u)}>
                          {t("Reset password")}
                        </button>
                        <button className="small-btn" onClick={() => void update(u, { disabled: !u.disabled })}>
                          {u.disabled ? t("Enable") : t("Disable")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** PT role, plus the module for Managers and Low Man. Changes are sent once they're complete. */
function PtGroupPicker({
  role,
  module,
  onChange,
  label,
}: {
  role: PtRole;
  module: PtModule | null;
  onChange: (role: PtRole, module: PtModule | null) => void;
  label: string;
}) {
  const [r, setR] = useState<PtRole>(role);
  const needsModule = r === "manager" || r === "staff";
  useEffect(() => setR(role), [role]);
  return (
    <div className="row">
      <select
        value={r}
        onChange={(e) => {
          const next = e.target.value as PtRole;
          setR(next);
          // A Manager or Low Man needs a module first; keep the current one when switching between them.
          if (next === "none" || next === "big_man") onChange(next, null);
          else if (module) onChange(next, module);
        }}
        aria-label={t("PT role of {label}", { label })}
      >
        {(Object.keys(PT_ROLE_LABELS) as PtRole[]).map((x) => (
          <option key={x} value={x}>
            {t(PT_ROLE_LABELS[x])}
          </option>
        ))}
      </select>
      {needsModule && (
        <select value={module ?? ""} onChange={(e) => e.target.value && onChange(r, e.target.value as PtModule)} aria-label={t("PT module of {label}", { label })}>
          {!module && <option value="">{t("Module…")}</option>}
          {(Object.keys(MODULE_LABELS) as PtModule[]).map((m) => (
            <option key={m} value={m}>
              {t(MODULE_LABELS[m])}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function AddUser({ me, onAdded }: { me: User; onAdded: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [plan, setPlan] = useState<GeneralPlan>("free");
  const [ptRole, setPtRole] = useState<PtRole>("none");
  const [ptModule, setPtModule] = useState<PtModule | "">("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsModule = ptRole === "manager" || ptRole === "staff";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser({
        username: username.trim() || undefined,
        email: email.trim() || undefined,
        display_name: displayName.trim() || undefined,
        role,
        general_plan: role === "user" ? plan : "none",
        pt_role: ptRole,
        pt_module: needsModule ? ptModule : "",
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
    <form className="stack adjust-panel" onSubmit={(e) => void submit(e)}>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Username")}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
        </label>
        <label className="field inline grow">
          <span>{t("Email (optional)")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field inline grow">
          <span>{t("Display name")}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        {me.account_role === "super_admin" && (
          <label className="field inline">
            <span>{t("Role")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
              <option value="user">{t("User")}</option>
              <option value="admin">{t("Admin (manages users; General Tool as Paid; PT only with a PT role)")}</option>
            </select>
          </label>
        )}
        <>
            {role === "user" && (
              <label className="field inline">
                <span>{t("General User")}</span>
                <select value={plan} onChange={(e) => setPlan(e.target.value as GeneralPlan)}>
                  {(Object.keys(PLAN_LABELS) as GeneralPlan[]).map((p) => (
                    <option key={p} value={p}>
                      {t(PLAN_LABELS[p])}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field inline">
              <span>{t("PT role")}</span>
              <select value={ptRole} onChange={(e) => setPtRole(e.target.value as PtRole)}>
                {(Object.keys(PT_ROLE_LABELS) as PtRole[]).map((x) => (
                  <option key={x} value={x}>
                    {t(PT_ROLE_LABELS[x])}
                  </option>
                ))}
              </select>
            </label>
            {needsModule && (
              <label className="field inline">
                <span>{t("PT module")}</span>
                <select value={ptModule} onChange={(e) => setPtModule(e.target.value as PtModule)} required>
                  <option value="">{t("Choose…")}</option>
                  {(Object.keys(MODULE_LABELS) as PtModule[]).map((m) => (
                    <option key={m} value={m}>
                      {t(MODULE_LABELS[m])}
                    </option>
                  ))}
                </select>
              </label>
            )}
        </>
        <label className="field inline grow">
          <span>{t("Initial password (12+ characters)")}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy || (!username.trim() && !email.trim()) || (needsModule && !ptModule)}>
          {busy ? t("Adding…") : t("Add user")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

/** Where you're signed in: sign out a lost or old device, or every device except this one. */
function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.devices().then(setDevices, (e) => setError(errorMessage(e)));
  }, []);

  async function run(action: () => Promise<Device[]>) {
    setError(null);
    try {
      setDevices(await action());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const others = devices?.filter((d) => !d.current).length ?? 0;
  return (
    <div className="card stack">
      <div className="row space-between wrap">
        <h2>{t("Your devices")}</h2>
        {others > 0 && (
          <button className="small-btn" onClick={() => void run(api.signOutOtherDevices)}>
            {t("Sign out all other devices")}
          </button>
        )}
      </div>
      <p className="muted small">{t("Where your account is signed in. Sign out a device you've lost or no longer use; it will need your password again.")}</p>
      <ErrorText message={error} />
      {devices && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("Device")}</th>
              <th>{t("Signed in")}</th>
              <th>{t("Last used")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.device || t("Unnamed device")}
                  {d.current && <> <span className="badge badge-good">{t("this device")}</span></>}
                </td>
                <td className="nowrap">{formatDateTime(d.signed_in_at)}</td>
                <td className="nowrap">{d.last_used_at ? formatDateTime(d.last_used_at) : "—"}</td>
                <td className="num">
                  {!d.current && (
                    <button className="small-btn" onClick={() => void run(() => api.signOutDevice(d.id))}>
                      {t("Sign out")}
                    </button>
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

/** This device's app version, automatic updates (desktop) and "Check for updates". */
function UpdatesSetting() {
  const u = useUpdates();
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    void currentVersion().then(setVersion);
    void getAutoUpdate().then(setAuto);
  }, []);

  const status =
    u.phase === "checking" ? t("Checking…")
    : u.phase === "none" ? t("You have the latest version.")
    : u.phase === "available" ? t("Version {version} is available.", { version: u.version ?? "" })
    : u.phase === "downloading" ? t("Downloading version {version}…", { version: u.version ?? "" })
    : u.phase === "ready" ? t("Version {version} is ready: restart to finish updating.", { version: u.version ?? "" })
    : u.phase === "installing" ? t("Installing the update…")
    : u.phase === "error" ? t("Couldn't check for updates: {error}", { error: u.error ?? "" })
    : "";

  return (
    <div className="card stack">
      <h2>{t("Updates")}</h2>
      <p className="muted small">{t("This is version {version}.", { version: version || "…" })}</p>
      {isDesktop ? (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={!!auto}
              disabled={auto === null}
              onChange={(e) => {
                setAuto(e.target.checked);
                void setAutoUpdate(e.target.checked);
              }}
            />
            {t("Update automatically")}
          </label>
          <p className="muted small">
            {t("On: new versions download in the background and you're asked to restart when one is ready. Off: you're asked before anything is downloaded. Remembered on this device.")}
          </p>
        </>
      ) : (
        <p className="muted small">
          {t("The phone app can't update itself: when a new version is out you'll get a link to download it.")}{" "}
          <a
            href={RELEASES_URL}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(RELEASES_URL).catch(() => window.open(RELEASES_URL, "_blank"));
            }}
          >
            {t("All releases")}
          </a>
        </p>
      )}
      <div className="row wrap">
        <button onClick={() => void checkForUpdates(true)} disabled={u.phase === "checking" || u.phase === "downloading" || u.phase === "installing"}>
          {t("Check for updates")}
        </button>
        {status && <span className={`small align-end ${u.phase === "error" ? "error-text" : "muted"}`}>{status}</span>}
      </div>
    </div>
  );
}

/** Plain-English names for the actions in the activity log ("POST /recordings" → "Uploaded a recording"). */
const ACTIONS: [RegExp, string][] = [
  [/^sign-in$/, "Signed in"],
  [/^sign-in failed$/, "Failed sign-in"],
  [/^sign-in locked$/, "Sign-in blocked (too many failures)"],
  [/^POST \/auth\/logout$/, "Signed out"],
  [/^POST \/auth\/password$/, "Changed password"],
  [/^POST \/auth\/role$/, "Switched role"],
  [/^POST \/auth\/profile$/, "Changed their name"],
  [/^(DELETE \/auth\/devices\/|POST \/auth\/devices\/sign-out-others)/, "Signed out a device"],
  [/^POST \/users$/, "Created an account"],
  [/^POST \/users\/\d+$/, "Changed an account"],
  [/^POST \/ai\/translate$/, "Translated text"],
  [/^POST \/recordings$/, "Uploaded a recording"],
  [/^POST \/recordings\/\d+\/transcribe$/, "Transcribed a recording"],
  [/^POST \/recordings\/\d+$/, "Renamed a recording"],
  [/^DELETE \/recordings\/\d+$/, "Deleted a recording"],
  [/^POST \/live$/, "Started a live recording"],
  [/^POST \/live\/\d+\/chunk$/, "Live transcription"],
  [/^POST \/live\/\d+\/finish$/, "Saved a live recording"],
  [/^POST \/meetings$/, "Started a meeting"],
  [/^POST \/meetings\/\d+\/chunk$/, "Meeting transcription"],
  [/^POST \/meetings\/\d+\/translate$/, "Translated a meeting"],
  [/^POST \/meetings\/\d+\/speakers$/, "Named a speaker"],
  [/^POST \/transcripts\/\d+\/translate$/, "Translated a transcript"],
  [/^POST \/transcripts\/\d+$/, "Edited a transcript"],
  [/^DELETE \/transcripts\/\d+$/, "Deleted a transcript"],
  [/^POST \/transcripts\/learn$/, "Learned from edits"],
  [/^POST \/feed\/topics/, "Changed feed topics"],
  [/^DELETE \/feed\/topics/, "Removed a feed topic"],
  [/^POST \/feed\/generate$/, "Built the Daily Feed"],
  [/^POST \/usage\/sync$/, "Synced usage"],
  [/^GET /, "Viewed"],
];

function actionLabel(a: ActivityEntry): string {
  const hit = ACTIONS.find(([re]) => re.test(a.action));
  return hit ? t(hit[1]) : a.action;
}

/** Administrators: what people did (the Super Admin sees everyone; Admins see accounts below Admin). */
function Activity({ me }: { me: User }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userId, setUserId] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setError(null);
      try {
        const res = await api.activity({ user: userId === "" ? undefined : userId, from: from || undefined, to: to || undefined, limit: 100, offset });
        setTotal(res.total);
        setRows((r) => (offset === 0 ? res.rows : [...r, ...res.rows]));
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [userId, from, to],
  );

  useEffect(() => {
    if (!open) return;
    void load(0);
  }, [open, load]);

  useEffect(() => {
    if (open && users.length === 0) api.users().then(setUsers, () => undefined);
  }, [open, users.length]);

  return (
    <details className="card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("Activity")}</summary>
      <div className="stack">
        <p className="muted small">{t("Every change people make, every sign-in attempt, and everything opened while the Super Admin views as someone. Only the action is kept, never what was typed or recorded. Kept for a year.{v}", { v: me.account_role === "super_admin" ? "" : t(" You see accounts below Admin.") })}</p>
        <div className="row wrap">
          <label className="field inline">
            <span>{t("Person")}</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{t("Everyone")}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>{t("From")}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field inline">
            <span>{t("To")}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <ErrorText message={error} />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("When")}</th>
                <th>{t("Who")}</th>
                <th>{t("What")}</th>
                <th>{t("Result")}</th>
                <th>{t("From")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={a.status !== null && a.status >= 400 ? "muted-row" : undefined}>
                  <td className="nowrap">{formatDateTime(a.created_at)}</td>
                  <td>
                    {a.user_name ?? (a.target ? <span className="mono small">{a.target}</span> : "—")}
                    {a.viewed_by_name && <div className="muted small">{t("viewed by {viewed_by_name}", { viewed_by_name: a.viewed_by_name })}</div>}
                  </td>
                  <td>
                    {actionLabel(a)}
                    <div className="muted small mono">{a.action}</div>
                  </td>
                  <td>{a.status === null ? "" : a.status < 400 ? "OK" : a.status === 429 ? t("Limit reached") : a.status === 403 ? t("Not allowed") : t("Failed ({status})", { status: a.status })}</td>
                  <td className="small">
                    {a.ip}
                    {a.device && <div className="muted small" title={a.device}>{a.device.slice(0, 40)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !error && <p className="muted small">{t("Nothing yet.")}</p>}
        {rows.length < total && (
          <div>
            <button className="small-btn" onClick={() => void load(rows.length)}>{t("Show more ({v} older)", { v: total - rows.length })}</button>
          </div>
        )}
      </div>
    </details>
  );
}
