// Persistent app settings (store file) and the login token (OS credential store when available).
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

/** The public address (Cloudflare Tunnel to the always-on desktop). On that desktop itself, the local address is quicker. */
export const DEFAULT_SERVER_URL = "https://<your-tunnel-domain>";

export interface Settings {
  serverUrl: string;
  email: string;
  deviceName: string;
}

let storePromise: Promise<Store> | null = null;
const store = () => (storePromise ??= load("settings.json", { autoSave: true, defaults: {} }));

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android phone";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Mac/i.test(ua)) return "Mac";
  return "Unknown device";
}

export async function loadSettings(): Promise<Settings> {
  const s = await store();
  return {
    serverUrl: (await s.get<string>("serverUrl")) ?? DEFAULT_SERVER_URL,
    email: (await s.get<string>("email")) ?? "",
    deviceName: (await s.get<string>("deviceName")) ?? defaultDeviceName(),
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const s = await store();
  for (const [k, v] of Object.entries(patch)) await s.set(k, v);
}

// Token: Windows Credential Manager via Rust commands; store file as the fallback elsewhere.

export async function getToken(): Promise<string | null> {
  try {
    return await invoke<string | null>("token_get");
  } catch {
    return (await (await store()).get<string>("token")) ?? null;
  }
}

export async function setToken(token: string): Promise<void> {
  try {
    await invoke("token_set", { token });
  } catch {
    await (await store()).set("token", token);
  }
}

export async function clearToken(): Promise<void> {
  try {
    await invoke("token_delete");
  } catch {
    // fall through: also clear any fallback copy
  }
  await (await store()).delete("token");
}
