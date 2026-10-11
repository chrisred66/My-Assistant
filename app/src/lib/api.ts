// Client for the chrisManager PHP API (see server/src/routes.php).
// Requests go through the Tauri HTTP plugin (Rust side), so the server needs no CORS headers.
import { fetch } from "@tauri-apps/plugin-http";

export type Provider = "anthropic" | "openai" | "deepseek";
export const PROVIDERS: Provider[] = ["anthropic", "openai", "deepseek"];
export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
};

export type PtAccess = "none" | "view" | "edit" | "admin";

export interface User {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: "owner" | "member"; // members only get PT Management, at their pt_access level
  pt_access: PtAccess;
}

export interface ManagedUser extends User {
  disabled: boolean;
  created_at: string;
}

export interface PtStatus {
  connected: boolean;
  database: string;
  tables?: Record<string, number>;
  error?: string;
}

const PT_RANK: Record<PtAccess, number> = { none: 0, view: 1, edit: 2, admin: 3 };

/** Whether the user may use PT Management at the given level. */
export function canPt(user: User, level: PtAccess = "view"): boolean {
  return user.role === "owner" || PT_RANK[user.pt_access] >= PT_RANK[level];
}

export interface TranslateResult {
  id: number;
  translation: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

// Transcripts can be in any language: `language` is an ISO 639-1 code where known ("ar", "en", ...),
// and `english` is null when the speech was already English.

export interface UploadResult {
  id: number;
  transcript_id?: number;
  text?: string;
  language?: string | null;
  english?: string | null;
  transcribe_error?: string; // the file was saved; transcription can be retried
  translate_error?: string; // the transcript was saved; translation can be retried
}

export interface TranscribeResult {
  transcript_id: number;
  text: string;
  language: string | null;
}

export interface TranslateTranscriptResult {
  transcript_id: number;
  language: string | null;
  english: string | null;
}

export interface LiveSession {
  recording_id: number;
  transcript_id: number;
}

export interface LiveChunkResult {
  seq: number;
  text: string; // empty when the chunk held no speech
  language: string | null;
  english: string | null;
  translate_error?: string;
}

export interface LiveFinishResult {
  id: number;
  transcript_id: number;
  text: string;
  english: string | null;
  language: string | null;
}

export interface Recording {
  id: number;
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  duration_sec: number | null;
  recorded_at: string | null;
  created_at: string;
  transcript_id: number | null;
  language: string | null;
  source_text: string | null;
  translated_text: string | null;
}

export interface Transcript {
  id: number;
  recording_id: number | null;
  language: string;
  source_text: string;
  translated_text: string | null; // null until translated
  translate_provider: string | null;
  translate_model: string | null;
  created_at: string;
}

export type UsageGroup = "day" | "month" | "model";

/** "providers": what Anthropic/OpenAI report (synced), DeepSeek from this app, plus manual entries. "app": this app only. */
export type UsageView = "providers" | "app";

export interface ProviderSyncStatus {
  can_sync: boolean; // an admin key is configured
  key_setting: string;
  synced_at: string | null;
  range_from: string | null;
  range_to: string | null;
  rows_imported: number;
  last_error: string | null;
}

export interface DeepSeekStatus {
  can_sync: false;
  note: string;
  available?: boolean;
  balance?: { currency: string; total: string; granted: string; topped_up: string }[];
  balance_error?: string;
}

export interface UsageProviders {
  anthropic: ProviderSyncStatus;
  openai: ProviderSyncStatus;
  deepseek: DeepSeekStatus;
}

export interface UsageSyncResult {
  from: string;
  to: string;
  results: Partial<Record<Provider, { ok: boolean; rows?: number; error?: string; skipped?: string }>>;
}

export interface UsageRow {
  bucket: string;
  provider: Provider;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  audio_seconds: number;
  cost_usd: number | null; // null when no price is configured for the model
}

export interface UsageSummary {
  from: string;
  to: string;
  rows: UsageRow[];
}

export interface ManualUsage {
  provider: Provider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  note?: string;
  occurred_at?: string;
}

export interface AiRoute {
  provider: Provider;
  model: string | null;
}

export interface AiRouting {
  translate: AiRoute;
  transcribe: AiRoute;
  light: AiRoute;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Config {
  baseUrl: string;
  token: string | null;
  onUnauthorized: () => void;
}

const config: Config = { baseUrl: "", token: null, onUnauthorized: () => {} };

export function configureApi(next: Partial<Config>) {
  Object.assign(config, next);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function request<T>(method: string, path: string, body?: unknown, baseUrl = config.baseUrl): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // fetch sets the multipart boundary
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  } catch (e) {
    throw new ApiError(0, `Can't reach the server at ${baseUrl}. Is it running, and is the address right? (${e})`);
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Apache error pages and PHP fatals arrive as HTML
  }

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status} from ${path}`;
    if (res.status === 401 && config.token) config.onUnauthorized();
    throw new ApiError(res.status, message);
  }
  if (data === null) {
    throw new ApiError(res.status, `Unexpected non-JSON response from ${path}. Check the server address.`);
  }
  return data as T;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export const api = {
  health: (baseUrl: string) => request<{ ok: boolean; time: string }>("GET", "/health", undefined, baseUrl),

  /** `login` is an email address or a username. */
  login: (baseUrl: string, login: string, password: string, device: string) =>
    request<{ token: string; user: User }>("POST", "/auth/login", { login, password, device }, baseUrl),

  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),

  me: () => request<User>("GET", "/auth/me"),

  changePassword: (current: string, next: string) => request<{ ok: boolean }>("POST", "/auth/password", { current, new: next }),

  // Owner only.
  users: () => request<ManagedUser[]>("GET", "/users"),

  createUser: (u: { username?: string; email?: string; display_name?: string; pt_access: PtAccess; password: string }) =>
    request<{ id: number }>("POST", "/users", u),

  updateUser: (id: number, patch: { display_name?: string; pt_access?: PtAccess; disabled?: boolean; password?: string }) =>
    request<{ ok: boolean }>("POST", `/users/${id}`, patch),

  ptStatus: () => request<PtStatus>("GET", "/pt/status"),

  // Providers are routed on the server (translation: Claude, transcription: OpenAI, light tasks: DeepSeek).
  routing: () => request<AiRouting>("GET", "/ai/routing"),

  translate: (text: string, model?: string) =>
    request<TranslateResult>("POST", "/ai/translate", { text, ...(model ? { model } : {}) }),

  uploadRecording: (
    audio: Blob,
    fileName: string,
    opts: { title?: string; recordedAt?: string; transcribe?: boolean },
  ) => {
    const form = new FormData();
    form.append("audio", audio, fileName);
    if (opts.title) form.append("title", opts.title);
    if (opts.recordedAt) form.append("recorded_at", opts.recordedAt);
    if (opts.transcribe) form.append("transcribe", "1"); // also translates non-English speech
    return request<UploadResult>("POST", "/recordings", form);
  },

  liveStart: (title?: string, recordedAt?: string) =>
    request<LiveSession>("POST", "/live", {
      ...(title ? { title } : {}),
      ...(recordedAt ? { recorded_at: recordedAt } : {}),
    }),

  liveChunk: (recordingId: number, chunk: { seq: number; startMs: number; wav: Blob }, prompt?: string) => {
    const form = new FormData();
    form.append("audio", chunk.wav, `chunk-${chunk.seq}.wav`);
    form.append("seq", String(chunk.seq));
    form.append("start_ms", String(chunk.startMs));
    if (prompt) form.append("prompt", prompt);
    return request<LiveChunkResult>("POST", `/live/${recordingId}/chunk`, form);
  },

  liveFinish: (recordingId: number, audio: Blob, fileName: string, durationSec: number) => {
    const form = new FormData();
    form.append("audio", audio, fileName);
    form.append("duration_sec", durationSec.toFixed(2));
    return request<LiveFinishResult>("POST", `/live/${recordingId}/finish`, form);
  },

  transcribeRecording: (recordingId: number) => request<TranscribeResult>("POST", `/recordings/${recordingId}/transcribe`),

  translateTranscript: (transcriptId: number, model?: string) =>
    request<TranslateTranscriptResult>("POST", `/transcripts/${transcriptId}/translate`, model ? { model } : {}),

  recordings: async (): Promise<Recording[]> =>
    (await request<Recording[]>("GET", "/recordings")).map((r) => ({
      ...r,
      id: num(r.id),
      size_bytes: num(r.size_bytes),
      duration_sec: r.duration_sec === null ? null : num(r.duration_sec),
      transcript_id: r.transcript_id === null ? null : num(r.transcript_id),
    })),

  transcripts: async (): Promise<Transcript[]> =>
    (await request<Transcript[]>("GET", "/transcripts")).map((t) => ({
      ...t,
      id: num(t.id),
      recording_id: t.recording_id === null ? null : num(t.recording_id),
    })),

  usageSummary: async (from: string, to: string, group: UsageGroup, view: UsageView = "providers"): Promise<UsageSummary> => {
    const q = new URLSearchParams({ from, to, group, view });
    const s = await request<UsageSummary>("GET", `/usage/summary?${q}`);
    return {
      ...s,
      rows: s.rows.map((r) => ({
        ...r,
        requests: num(r.requests),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens),
        audio_seconds: num(r.audio_seconds),
        cost_usd: r.cost_usd === null ? null : num(r.cost_usd),
      })),
    };
  },

  addUsage: (entry: ManualUsage) => request<{ ok: boolean }>("POST", "/usage", entry),

  usageProviders: () => request<UsageProviders>("GET", "/usage/providers"),

  syncUsage: (from?: string, to?: string) =>
    request<UsageSyncResult>("POST", "/usage/sync", { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
};
