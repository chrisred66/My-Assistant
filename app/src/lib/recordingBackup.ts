// Safeguards for live recordings and meetings, which are otherwise only saved when you press Stop.
// - Backup: each second of the compressed audio is copied to IndexedDB (on this device) as it's recorded, so a crash
//   or a closed app loses about a second at most. What's left behind is uploaded as the recording's audio on the next
//   start (POST /live/{id}/finish, the same call Stop makes), and the copy is dropped once the server has it. Pieces
//   from one MediaRecorder, joined in order, are a complete file, so nothing needs stitching.
// - In progress: the panels register their "stop and save" here, so signing out, switching account or role, closing
//   the window and restarting for an update save the recording first instead of cutting it off.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, ApiError } from "./api";
import { toSqlDateTime } from "./format";
import { t } from "./i18n";

export type RecordingKind = "live" | "meeting";

interface Session {
  id: number; // the recording's id on the server
  userId: number; // whose it is: only recovered while that account is the one in use
  kind: RecordingKind;
  mimeType: string;
  durationMs: number;
  parts: number;
}

// ---- Storage -------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** The backup database; null where IndexedDB isn't available (recording still works, without a backup). */
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const open = indexedDB.open("recording-backup", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("sessions", { keyPath: "id" });
        open.result.createObjectStore("parts"); // key [recording id, piece number], value Blob
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** One read-write transaction; true once it's committed. Transactions run in the order they're asked for. */
async function write(fn: (tx: IDBTransaction) => void): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(["sessions", "parts"], "readwrite");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
      fn(tx);
    } catch {
      resolve(false);
    }
  });
}

function read<T>(store: string, query: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        if (!d) return reject(new Error("no storage"));
        const r = query(d.transaction(store).objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

const partsOf = (id: number) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/** The backup of one recording, written as it's recorded (see LiveRecorder's `backup` option). */
export class AudioBackup {
  private session: Session | null = null;
  private failed = false;

  constructor(
    private readonly id: number,
    private readonly kind: RecordingKind,
  ) {}

  /** Whether everything so far made it to the backup (false: storage unavailable or a write failed). */
  get intact(): boolean {
    return this.session !== null && !this.failed;
  }

  begin(mimeType: string): void {
    if (owner === null) return;
    this.session = { id: this.id, userId: owner, kind: this.kind, mimeType, durationMs: 0, parts: 0 };
    const session = { ...this.session };
    void write((tx) => tx.objectStore("sessions").put(session)).then((ok) => ok || (this.failed = true));
  }

  append(piece: Blob, durationMs: number): void {
    if (!this.session) return;
    const n = this.session.parts++;
    this.session.durationMs = durationMs;
    const session = { ...this.session };
    void write((tx) => {
      tx.objectStore("parts").put(piece, [this.id, n]);
      tx.objectStore("sessions").put(session);
    }).then((ok) => ok || (this.failed = true));
  }
}

/** Drops a recording's backup (once the server has its audio). */
export async function discardBackup(id: number): Promise<void> {
  await write((tx) => {
    tx.objectStore("parts").delete(partsOf(id));
    tx.objectStore("sessions").delete(id);
  });
}

/** "recording-2026-10-21-14-05-00.webm", by the audio's type. */
export function audioFileName(kind: RecordingKind, mimeType: string, at = new Date()): string {
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
  return `${kind === "meeting" ? "meeting" : "recording"}-${toSqlDateTime(at).replace(/[: ]/g, "-")}.${ext}`;
}

// ---- Recovery ------------------------------------------------------------------

let owner: number | null = null;
let recovering: Promise<void> | null = null;
let recovered: number[] = [];
const recoveredListeners = new Set<() => void>();

/** The account in use (also while viewing as someone); recovers what it left behind. App.tsx keeps it current. */
export function setRecordingOwner(userId: number | null): void {
  owner = userId;
  if (userId !== null) void recoverRecordings();
}

/** Uploads backups left behind by a crash, a closed app or a failed save. Safe to call any time. */
export function recoverRecordings(): Promise<void> {
  recovering ??= runRecovery().finally(() => (recovering = null));
  return recovering;
}

async function runRecovery(): Promise<void> {
  const userId = owner;
  if (userId === null) return;
  let sessions: Session[];
  try {
    sessions = await read<Session[]>("sessions", (s) => s.getAll());
  } catch {
    return;
  }
  for (const s of sessions) {
    if (s.userId !== userId || inProgress.has(s.id) || owner !== userId) continue;
    try {
      const parts = await read<Blob[]>("parts", (store) => store.getAll(partsOf(s.id)));
      if (parts.length > 0) {
        const audio = new Blob(parts, { type: s.mimeType });
        await api.liveFinish(s.id, audio, audioFileName(s.kind, s.mimeType), s.durationMs / 1000);
        recovered.push(s.id);
        recoveredListeners.forEach((f) => f());
      }
      await discardBackup(s.id); // uploaded, or nothing was recorded
    } catch (e) {
      // Deleted on the server meanwhile: nothing to attach it to. Otherwise (offline, not allowed now) it's tried again.
      if (e instanceof ApiError && e.status === 404) await discardBackup(s.id);
    }
  }
}

/** Recordings recovered since last asked (for the "recovered" note on Recordings). */
export function takeRecovered(): number[] {
  const out = recovered;
  recovered = [];
  return out;
}

/** Called after each recovered recording; returns the unsubscribe. */
export function onRecovered(f: () => void): () => void {
  recoveredListeners.add(f);
  return () => void recoveredListeners.delete(f);
}

// ---- In progress ---------------------------------------------------------------

const inProgress = new Map<number, () => Promise<void>>();

function tellNative() {
  // lib.rs: closing the main window waits for "close-requested" to be handled while this is on.
  invoke("set_recording_active", { active: inProgress.size > 0 }).catch(() => {});
}

/** A panel's recording has started; `stopAndSave` is its Stop. Call the returned function once it's saved (or not). */
export function markInProgress(id: number, stopAndSave: () => Promise<void>): () => void {
  inProgress.set(id, stopAndSave);
  tellNative();
  return () => {
    if (inProgress.delete(id)) tellNative();
  };
}

export const isRecordingNow = (id: number) => inProgress.has(id);

const saveAll = () => Promise.all([...inProgress.values()].map((stop) => stop().catch(() => {})));

/** Before signing out, switching account or role, or restarting: asks, then stops and saves what's recording.
 *  False: the person chose to keep recording, so don't go ahead. */
export async function endRecordingsFirst(): Promise<boolean> {
  if (inProgress.size === 0) return true;
  if (!window.confirm(t("A recording is in progress. It will be stopped and saved first. Continue?"))) return false;
  await saveAll();
  return true;
}

/** Main window, once: closing it while recording saves the recording, then quits (a second close quits at once; the
 *  backup is then uploaded on the next start). Up to 30 s, so a stalled upload can't keep the app open. */
export function saveRecordingsOnClose(): void {
  listen("close-requested", async () => {
    await Promise.race([saveAll(), new Promise((resolve) => window.setTimeout(resolve, 30_000))]);
    await invoke("quit_app").catch(() => {});
  }).catch(() => {
    // not running in Tauri (browser preview): the browser closes the page itself
  });
}
