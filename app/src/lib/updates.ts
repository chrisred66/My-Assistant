// App updates from the GitHub releases (signed; see "plugins.updater" in tauri.conf.json).
// Desktop: checked at start and every 6 hours. With automatic updates on (the default), a new version is downloaded in
// the background and the person is asked to restart; with them off, they're asked first and it's downloaded then.
// Phone: Android apps can't replace themselves, so a new version only shows a link to the download.
import { getVersion } from "@tauri-apps/api/app";
import { load } from "@tauri-apps/plugin-store";
import { useSyncExternalStore } from "react";
import { t } from "./i18n";
import { isDesktop } from "./platform";

const MANIFEST_URL = "https://github.com/chrisred66/My-Assistant/releases/latest/download/latest.json";
export const RELEASES_URL = "https://github.com/chrisred66/My-Assistant/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "installing" | "error";
export interface UpdateState {
  phase: UpdatePhase;
  version?: string; // the new version
  notes?: string;
  progress?: number; // 0..1 while downloading, when the size is known
  error?: string;
  dismissed?: boolean; // "Later": the banner is hidden until the next check
}

type DesktopUpdate = import("@tauri-apps/plugin-updater").Update;

let state: UpdateState = { phase: "idle" };
let pending: DesktopUpdate | null = null;
const listeners = new Set<() => void>();
function set(patch: Partial<UpdateState>, replace = false) {
  state = replace ? (patch as UpdateState) : { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useUpdates(): UpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

// ---- the setting (per device) ------------------------------------------------------------------------------------

const settingsStore = () => load("settings.json", { autoSave: true, defaults: {} });

export async function getAutoUpdate(): Promise<boolean> {
  return (await (await settingsStore()).get<boolean>("autoUpdate")) ?? true;
}

export async function setAutoUpdate(on: boolean): Promise<void> {
  await (await settingsStore()).set("autoUpdate", on);
  // Turned on with an update waiting: start downloading it now.
  if (on && state.phase === "available") void download();
}

// ---- checking ----------------------------------------------------------------------------------------------------

/** Is version a newer than b ("0.4.2" vs "0.4.1")? */
function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Looks for a new version. `manual`: from the Settings button (shows "up to date" and errors). */
export async function checkForUpdates(manual = false): Promise<void> {
  if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return;
  if (state.phase === "ready" && !manual) return; // already downloaded, waiting for a restart
  set({ phase: "checking", error: undefined });
  try {
    if (isDesktop) {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        set({ phase: "none" });
        return;
      }
      pending = update;
      set({ phase: "available", version: update.version, notes: update.body, dismissed: false });
      if (await getAutoUpdate()) await download();
    } else {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const res = await fetch(MANIFEST_URL, { cache: "no-store" } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = (await res.json()) as { version: string; notes?: string };
      if (newer(manifest.version, await getVersion())) {
        set({ phase: "available", version: manifest.version.replace(/^v/, ""), notes: manifest.notes, dismissed: false });
      } else {
        set({ phase: "none" });
      }
    }
  } catch (e) {
    // Offline or no release yet: quiet unless asked for.
    set(manual ? { phase: "error", error: e instanceof Error ? e.message : String(e) } : { phase: "idle" });
  }
}

/** Downloads the waiting update (desktop); it's installed on restart. */
export async function download(): Promise<void> {
  if (!pending || state.phase === "downloading" || state.phase === "ready") return;
  let total = 0;
  let got = 0;
  set({ phase: "downloading", progress: undefined });
  try {
    await pending.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        got += event.data.chunkLength;
        if (total) set({ progress: Math.min(1, got / total) });
      }
    });
    set({ phase: "ready", progress: 1 });
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Installs the downloaded update and restarts the app (on Windows the installer closes and reopens it). */
export async function restartToUpdate(): Promise<void> {
  if (!pending) return;
  if (state.phase !== "ready") await download();
  if (state.phase !== "ready") return; // the download failed: the error is shown
  set({ phase: "installing" });
  try {
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** "Update now" with automatic updates off: download, then install and restart straight away. */
export const updateNow = restartToUpdate;

/** "Later": hides the banner until the next check. */
export function dismissUpdate(): void {
  set({ dismissed: true });
}

let started = false;
/** Starts the checks (once, in the main window; not in development, where there's nothing to install). */
export function startUpdateChecks(): void {
  if (started || import.meta.env.DEV) return;
  started = true;
  setTimeout(() => void checkForUpdates(), 15_000);
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}

/** "(ver. 0.4.2)", or "(dev. ver. 0.4.3)" in the dev version: shown after the app's name in the title bar. */
export function versionLabel(): string {
  return import.meta.env.DEV ? t("(dev. ver. {v})", { v: __APP_VERSION__ }) : t("(ver. {v})", { v: __APP_VERSION__ });
}

export async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}
