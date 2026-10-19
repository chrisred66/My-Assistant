// The language translations go into. By default the account's language (follows it when it changes); a person can
// pick another, separately for the Translate page and for transcription (recordings, meetings, transcripts).
// Remembered on this device. The source language is always detected.
import { useSyncExternalStore } from "react";
import { LOCALE } from "./format";
import { getLang, useLang } from "./i18n";

/** The languages offered (the server's Language::TARGETS). */
export const TARGETS = ["en", "zh", "ar", "fr", "de", "es", "ru", "ja", "ko", "hi", "ur"] as const;
export type Target = (typeof TARGETS)[number];
export type TargetChoice = Target | "auto";
export type TargetPurpose = "translate" | "transcribe";

const key = (purpose: TargetPurpose) => `my-assistant-target-${purpose}`;
const listeners = new Set<() => void>();

function read(purpose: TargetPurpose): TargetChoice {
  try {
    const v = localStorage.getItem(key(purpose));
    return v && (TARGETS as readonly string[]).includes(v) ? (v as Target) : "auto";
  } catch {
    return "auto";
  }
}

export function setTargetChoice(purpose: TargetPurpose, choice: TargetChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(key(purpose));
    else localStorage.setItem(key(purpose), choice);
  } catch {
    // this session only
  }
  listeners.forEach((l) => l());
}

/** The language to translate into now: the choice, or the account's language. */
export function targetFor(purpose: TargetPurpose): Target {
  const choice = read(purpose);
  return choice === "auto" ? getLang() : choice;
}

/** [choice, effective target] for a purpose; re-renders when either changes. */
export function useTarget(purpose: TargetPurpose): [TargetChoice, Target] {
  const lang = useLang();
  const choice = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(purpose),
  );
  return [choice, choice === "auto" ? lang : choice];
}

/** A target's name in the app's language: "English", "简体中文", "Arabic"… ("en" for older translations). */
export function targetName(code: string | null | undefined): string {
  const c = !code ? "en" : code === "zh" ? "zh-Hans" : code;
  try {
    return new Intl.DisplayNames([LOCALE], { type: "language" }).of(c) ?? c;
  } catch {
    return c;
  }
}
