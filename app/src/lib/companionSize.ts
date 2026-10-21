// The desktop ball's and pet's size on screen. They take the same share of the screen they're on as on the 27"
// 1440p monitor they were designed on (the ball 138 px of 1440 at 100% scaling, about 3.2 cm), so they're smaller on
// a laptop than on a big monitor, but never smaller than 2 cm (the monitor's physical size, from screens.rs, says how
// big a pixel is). Settings adds a size of your own on top (50–150%). The window is resized and its page zoomed, so
// everything inside keeps its proportions.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { load } from "@tauri-apps/plugin-store";
import { useEffect, useState } from "react";

export type Companion = "ball" | "pet";
/** The windows' sizes at 100% (tauri.conf.json). */
export const BASE: Record<Companion, { w: number; h: number }> = { ball: { w: 128, h: 138 }, pet: { w: 490, h: 330 } };

const SCREEN_SHARE = 138 / 1440; // the ball's height as a share of the screen's height
const MIN_BALL_MM = 20;
const STORE_KEY: Record<Companion, string> = { ball: "ballSize", pet: "petSize" };

interface Screen {
  x: number;
  y: number;
  width: number;
  height: number;
  width_mm: number;
  height_mm: number;
}

const store = () => load("settings.json", { autoSave: true, defaults: {} });

/** Your own size for a companion, in percent (100 = sized to the screen). */
export async function getCompanionPercent(kind: Companion): Promise<number> {
  return (await (await store()).get<number>(STORE_KEY[kind])) ?? 100;
}

export async function setCompanionPercent(kind: Companion, percent: number): Promise<void> {
  await (await store()).set(STORE_KEY[kind], Math.min(150, Math.max(50, Math.round(percent))));
  await emit("companion-size");
}

/** The zoom for the screen this window is on, before your own size. */
async function screenFactor(): Promise<number> {
  const monitor = await currentMonitor();
  if (!monitor) return 1;
  const scale = monitor.scaleFactor || 1;
  const heightPx = monitor.size.height;
  let f = (SCREEN_SHARE * heightPx) / (BASE.ball.h * scale);
  const screens = await invoke<Screen[]>("screen_sizes").catch(() => [] as Screen[]);
  const screen = screens.find((s) => s.x === monitor.position.x && s.y === monitor.position.y);
  if (screen && screen.height_mm > 0 && screen.height > 0) {
    const mmPerPx = screen.height_mm / screen.height;
    f = Math.max(f, MIN_BALL_MM / (BASE.ball.h * scale * mmPerPx)); // still big enough to read
  }
  return Math.min(1.5, Math.max(0.4, f));
}

/**
 * In the ball's or pet's own window: sizes it to its screen and your setting, and again when it moves to another
 * screen or the setting changes. Returns the zoom in use.
 */
export function useCompanionSize(kind: Companion): number {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let applied = 0;
    let cancelled = false;
    const apply = async () => {
      try {
        const f = Math.round((await screenFactor()) * ((await getCompanionPercent(kind)) / 100) * 100) / 100;
        if (cancelled || f === applied) return;
        applied = f;
        const base = BASE[kind];
        await getCurrentWindow().setSize(new LogicalSize(Math.round(base.w * f), Math.round(base.h * f)));
        await getCurrentWebview().setZoom(f);
        setZoom(f);
      } catch {
        // not in Tauri, or the window is closing
      }
    };
    void apply();
    const timer = window.setInterval(() => void apply(), 5000); // moved to another screen
    const unlisten = listen("companion-size", () => void apply());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, [kind]);
  return zoom;
}
