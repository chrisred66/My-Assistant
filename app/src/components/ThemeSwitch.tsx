import { useEffect, useState, type ReactElement } from "react";
import { getTheme, onThemeChange, setTheme, type ThemePref } from "../lib/theme";

const OPTIONS: { id: ThemePref; label: string; icon: ReactElement }[] = [
  {
    id: "system",
    label: "Follow the system",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    id: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
];

/** System / Light / Dark. Remembered on this device. */
export default function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(getTheme);
  useEffect(() => onThemeChange(setPref), []);
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={pref === o.id}
          aria-label={o.label}
          title={o.label}
          className={pref === o.id ? "on" : ""}
          onClick={() => {
            setTheme(o.id);
            setPref(o.id);
          }}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
