// The app's language: English or Simplified Chinese. Text in the code is written in English and is its own key;
// lib/i18n/zh.ts maps it to Chinese, and anything not (yet) translated shows in English.
//
//   t("Save")                                  -> "保存"
//   t("{n} of {limit} words", { n, limit })    -> "{n} / {limit} 字" with the values filled in
//   tn(count, "{n} driver", "{n} drivers")     -> English singular / plural; Chinese has one form
//
// The choice is saved with the account (users.language) and, before sign-in, on this device; the server is told it
// with every request (Accept-Language), so its messages come back in the same language.
import { useSyncExternalStore } from "react";
import { formatInteger, setLocale } from "./format";
import zh from "./i18n/zh";

export type Lang = "en" | "zh";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
];

const KEY = "my-assistant-lang";
const listeners = new Set<() => void>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // storage unavailable: fall through
  }
  return /^zh/i.test(navigator.language) ? "zh" : "en";
}

let lang: Lang = initial();
apply();

function apply() {
  setLocale(lang === "zh" ? "zh-CN" : "en-GB");
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  // For the WebView's own language (date pickers): the windows are created with it at the next start.
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_ui_language", { lang })).catch(() => {});
}

export function getLang(): Lang {
  return lang;
}

/** Switches the app's language now (every component re-renders) and remembers it on this device. */
export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // remembered for this session only
  }
  apply();
  listeners.forEach((l) => l());
}

// The desktop ball and pet are separate windows: they follow a change made in the main window.
window.addEventListener("storage", (e) => {
  if (e.key === KEY && (e.newValue === "en" || e.newValue === "zh")) setLang(e.newValue);
});

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
}

/** Untranslated texts seen in dev mode (window.__i18nMissing), to find the ones still to translate. */
const missing = new Set<string>();
if (import.meta.env.DEV) (window as unknown as { __i18nMissing: Set<string> }).__i18nMissing = missing;

/** The text in the current language, with {placeholders} filled in from `vars`. */
export function t(text: string, vars?: Record<string, string | number | null | undefined | false>): string {
  let out = text;
  if (lang === "zh") {
    const hit = zh[text];
    if (hit !== undefined) out = hit;
    else if (import.meta.env.DEV) missing.add(text);
  }
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (vars[k] === false || vars[k] == null ? "" : String(vars[k])) : m)) : out;
}

/** Singular or plural English text (Chinese has one form), with {n} = the count, formatted. */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number | null | undefined | false>): string {
  return t(n === 1 ? one : many, { n: formatInteger(n), ...vars });
}

/** Like t(), for a word that means different things in different places: zh.ts has "ai|Model" next to "Model". */
export function tc(context: string, text: string): string {
  return lang === "zh" ? (zh[`${context}|${text}`] ?? t(text)) : text;
}
