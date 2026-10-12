export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// The server sends MySQL DATETIME strings ("2026-10-11 14:05:00") in its own timezone.
/**
 * Every date, time and number in the app is formatted in English (British style: 15 May 2025, 24-hour clock,
 * 1,234.5), whatever the Windows display language. Use this instead of `undefined` in toLocale…() calls.
 */
export const LOCALE = "en-GB";

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" });
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatInteger(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(Math.round(n));
}

export function formatUsd(n: number | null): string {
  if (n === null) return "—";
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol", // "$0.12", not en-GB's "US$0.12"
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** Local time as the server's "YYYY-MM-DD HH:MM:SS". */
export function toSqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Local date as "YYYY-MM-DD". */
export function toIsoDate(d: Date): string {
  return toSqlDateTime(d).slice(0, 10);
}

/** "ar" -> "Arabic". Falls back to the raw value for codes Intl doesn't know. */
export function languageName(code: string | null | undefined): string {
  if (!code) return "Unknown language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
