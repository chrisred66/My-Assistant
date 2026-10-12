// The desktop pet: an always-on-top window ("pet" in tauri.conf.json) that swims around the screen: your own images
// (one per mood, set in Settings) or, without any, the built-in blue whale. Like the usage ball it's declared hidden;
// the main window shows it for the Super Admin when switched on in Settings, and the choices are remembered in the store.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join, sep } from "@tauri-apps/api/path";
import type { Pack } from "../components/PackPet";
import { emit } from "@tauri-apps/api/event";
import { Window, PhysicalPosition } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";

async function store() {
  return load("settings.json", { autoSave: true, defaults: {} });
}

async function petWindow(): Promise<Window | null> {
  try {
    return await Window.getByLabel("pet");
  } catch {
    return null; // not running in Tauri (e.g. a browser preview)
  }
}

export async function petEnabled(): Promise<boolean> {
  return (await (await store()).get<boolean>("desktopPet")) ?? false;
}

/** Shows or hides the pet and remembers the choice. */
export async function setPetEnabled(on: boolean): Promise<void> {
  await (await store()).set("desktopPet", on);
  await (on ? showPet() : hidePet());
}

export async function showPet(): Promise<void> {
  const w = await petWindow();
  if (!w) return;
  const pos = await (await store()).get<{ x: number; y: number }>("petPosition");
  if (pos) await w.setPosition(new PhysicalPosition(pos.x, pos.y)).catch(() => {});
  await w.show();
}

export async function hidePet(): Promise<void> {
  await (await petWindow())?.hide();
}

export async function savePetPosition(x: number, y: number): Promise<void> {
  await (await store()).set("petPosition", { x, y });
}

/** "Stay here": the pet stops roaming until told to swim again. */
export async function petStays(): Promise<boolean> {
  return (await (await store()).get<boolean>("petStay")) ?? false;
}

export async function setPetStays(stay: boolean): Promise<void> {
  await (await store()).set("petStay", stay);
}

// ---- Your own images (Settings → Desktop pet) ------------------------------------------------------------------------

export const SKIN_MOODS = ["idle", "swim", "eating", "happy", "sleepy", "hungry", "busy", "held"] as const;
export type SkinMood = (typeof SKIN_MOODS)[number];
/** Mood -> image (data URL); empty: the built-in whale. */
export type PetSkin = Partial<Record<SkinMood, string>>;

export async function loadSkin(): Promise<PetSkin> {
  try {
    return await invoke<PetSkin>("pet_skin_list");
  } catch {
    return {};
  }
}

/** Saves an image for a mood and tells the pet window to reload. */
export async function saveSkinImage(mood: SkinMood, file: File): Promise<void> {
  const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  await invoke("pet_skin_save", { mood, ext, data });
  await emit("pet-skin-changed");
}

export async function clearSkin(mood: SkinMood | null): Promise<void> {
  await invoke("pet_skin_clear", { mood });
  await emit("pet-skin-changed");
}

/** The credit line for your images (artists, licence), kept next to them. */
export async function skinCredit(): Promise<string> {
  try {
    return await invoke<string>("pet_skin_credit");
  } catch {
    return "";
  }
}

export async function setSkinCredit(text: string): Promise<void> {
  await invoke("pet_skin_set_credit", { text });
}

/** Which way the images face, so the pet can mirror them when it swims the other way. */
export async function skinFacing(): Promise<"left" | "right"> {
  return (await (await store()).get<"left" | "right">("petSkinFacing")) ?? "right";
}

export async function setSkinFacing(facing: "left" | "right"): Promise<void> {
  await (await store()).set("petSkinFacing", facing);
  await emit("pet-skin-changed");
}

// ---- Animation pack (pet-pack/ in the app data folder: pack.json + WebM clips) ----------------------------------------

export interface LoadedPack {
  pack: Pack;
  url: (clip: string) => string;
}

/** The installed animation pack, or null when there isn't one. */
export async function loadPack(): Promise<LoadedPack | null> {
  try {
    const dir = await join(await appDataDir(), "pet-pack");
    const res = await fetch(convertFileSrc(await join(dir, "pack.json")));
    if (!res.ok) return null;
    const pack = (await res.json()) as Pack;
    return { pack, url: (clip) => convertFileSrc(`${dir}${sep()}${clip}.webm`) };
  } catch {
    return null;
  }
}

/** Which look the pet uses; "auto": the pack if installed, else your images, else the whale. */
export type PetLook = "auto" | "pack" | "images" | "whale";

export async function petLook(): Promise<PetLook> {
  return (await (await store()).get<PetLook>("petLook")) ?? "auto";
}

export async function setPetLook(look: PetLook): Promise<void> {
  await (await store()).set("petLook", look);
  await emit("pet-skin-changed");
}
