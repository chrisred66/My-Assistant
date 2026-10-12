// Light / dark / follow-the-system theme. The choice is per device (localStorage) and is applied to <html> as
// data-theme before the first render, so there's no flash. theme.css does the rest.

export type ThemePref = "system" | "light" | "dark";

const KEY = "theme";
const EVENT = "themechange";

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage unavailable: the choice lasts until the app restarts
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: pref }));
}

/** Calls back when the theme is changed anywhere in this window (so several switches stay in step). */
export function onThemeChange(fn: (pref: ThemePref) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<ThemePref>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
