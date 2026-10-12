// What the main window is busy with (recording, translating, uploading…), broadcast to the desktop usage ball,
// which shows it in its top half. Main window only; the ball listens for the "activity" event.
import { emit, listen } from "@tauri-apps/api/event";

export type ActivityKind = "recording" | "saving" | "transcribing" | "translating" | "syncing" | "uploading" | "importing" | "planning" | "learning";

export interface Activity {
  id: number;
  kind: ActivityKind;
  label: string; // short, fits the ball: "Recording", "Importing trips"
  startedAt: number; // ms since epoch, for the ball's timer
}

const active = new Map<number, Activity>();
let nextId = 1;

function broadcast() {
  emit("activity", [...active.values()]).catch(() => {
    // not running in Tauri (browser preview): nothing to tell
  });
}

/** Marks the start of an activity; call the returned function when it ends (safe to call twice). */
export function startActivity(kind: ActivityKind, label: string): () => void {
  const id = nextId++;
  active.set(id, { id, kind, label, startedAt: Date.now() });
  broadcast();
  return () => {
    if (active.delete(id)) broadcast();
  };
}

/** Runs `fn` as an activity: shown on the ball while it runs, whether it succeeds or fails. */
export async function track<T>(kind: ActivityKind, label: string, fn: () => Promise<T>): Promise<T> {
  const end = startActivity(kind, label);
  try {
    return await fn();
  } finally {
    end();
  }
}

/** Main window: answer the ball when it opens and asks what's going on. Call once at startup. */
export function serveActivityRequests(): void {
  listen("activity-request", broadcast).catch(() => {});
}
