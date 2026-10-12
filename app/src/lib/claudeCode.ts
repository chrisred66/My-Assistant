// Claude Code usage from this computer's Claude Code logs (Rust command claude_code_usage, src-tauri/src/claude_code.rs),
// for the desktop ball and the Usage page. Tokens counted: input + cache writes + output (cache reads are left out;
// they re-read the whole conversation every turn). Claude Code runs on a subscription, so there's no cost.
import { invoke } from "@tauri-apps/api/core";
import type { UsageRow } from "./api";

export interface ClaudeCodeEntry {
  ts: string; // ISO, UTC
  model: string;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  tokens: number;
}

/** Messages from logs touched in the last `days` days; null when unavailable (not the desktop app, no logs). */
export async function claudeCodeEntries(days: number): Promise<ClaudeCodeEntry[] | null> {
  try {
    return await invoke<ClaudeCodeEntry[]>("claude_code_usage", { days: Math.max(1, Math.min(400, Math.ceil(days))) });
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar date (YYYY-MM-DD) of a timestamp. */
export const localDay = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export interface InOut {
  input: number;
  output: number;
}

/** Input (with cache writes) and output tokens today and this month (local time), for the ball. */
export function claudeCodeTotals(entries: ClaudeCodeEntry[]): { today: InOut; month: InOut } {
  const today = localDay(new Date().toISOString());
  const month = today.slice(0, 7);
  const t = { input: 0, output: 0 };
  const m = { input: 0, output: 0 };
  for (const e of entries) {
    const day = localDay(e.ts);
    if (day.slice(0, 7) !== month) continue;
    m.input += e.input + e.cache_write;
    m.output += e.output;
    if (day === today) {
      t.input += e.input + e.cache_write;
      t.output += e.output;
    }
  }
  return { today: t, month: m };
}

/**
 * Usage rows like the server's, for a date range and grouping: by day (YYYY-MM-DD), month (YYYY-MM) or model
 * ("claude_code/<model>"). input_tokens includes cache writes, so input + output matches the ball's figure.
 */
export function claudeCodeRows(entries: ClaudeCodeEntry[], from: string, to: string, group: "day" | "month" | "model"): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const e of entries) {
    const day = localDay(e.ts);
    if (day < from || day > to) continue;
    const bucket = group === "day" ? day : group === "month" ? day.slice(0, 7) : `claude_code/${e.model}`;
    const r = rows.get(bucket) ?? {
      bucket,
      provider: "claude_code",
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      audio_seconds: 0,
      cost_usd: null,
    };
    r.requests += 1;
    r.input_tokens += e.input + e.cache_write;
    r.output_tokens += e.output;
    r.cache_read_tokens += e.cache_read;
    rows.set(bucket, r);
  }
  return [...rows.values()];
}
