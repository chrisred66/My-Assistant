// English / 中文 switch. Switches the app at once; `onChange` lets the caller also save the choice (Settings and the
// sidebar save it with the account; the sign-in screen just remembers it on this device until the person signs in).
// `compact`: the small pill used in the sidebar, next to the theme switch.
import { LANGS, setLang, t, useLang, type Lang } from "../lib/i18n";

export default function LanguageSwitch({ onChange, compact = false }: { onChange?: (lang: Lang) => void; compact?: boolean }) {
  const lang = useLang();
  return (
    <div className={compact ? "theme-switch lang-switch" : "segmented"} role="radiogroup" aria-label={t("Language")}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={lang === l.id}
          className={lang === l.id ? "on" : ""}
          lang={l.id === "zh" ? "zh-CN" : "en"}
          onClick={() => {
            setLang(l.id);
            onChange?.(l.id);
          }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
