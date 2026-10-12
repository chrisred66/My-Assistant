// The desktop usage ball: a small always-on-top window ("ball" in tauri.conf.json) that shows token usage.
// It's declared hidden; the main window shows or hides it, and the choice is remembered in the store.
import { Window, PhysicalPosition } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";

const STORE = "settings.json";

async function store() {
  return load(STORE, { autoSave: true, defaults: {} });
}

export async function ballEnabled(): Promise<boolean> {
  return (await (await store()).get<boolean>("usageBall")) ?? false;
}

async function ballWindow(): Promise<Window | null> {
  try {
    return await Window.getByLabel("ball");
  } catch {
    return null; // not running in Tauri (e.g. a browser preview)
  }
}

/** Shows or hides the ball and remembers the choice. */
export async function setBallEnabled(on: boolean): Promise<void> {
  await (await store()).set("usageBall", on);
  await (on ? showBall() : hideBall());
}

export async function showBall(): Promise<void> {
  const w = await ballWindow();
  if (!w) return;
  const pos = await (await store()).get<{ x: number; y: number }>("usageBallPosition");
  if (pos) await w.setPosition(new PhysicalPosition(pos.x, pos.y)).catch(() => {});
  await w.show();
}

export async function hideBall(): Promise<void> {
  await (await ballWindow())?.hide();
}

/** Called by the ball window when it's dragged, so it reopens in the same place. */
export async function saveBallPosition(x: number, y: number): Promise<void> {
  await (await store()).set("usageBallPosition", { x, y });
}

/** From the ball: bring the main window to the front. */
export async function focusMain(): Promise<void> {
  const w = await Window.getByLabel("main");
  if (!w) return;
  await w.unminimize();
  await w.show();
  await w.setFocus();
}
