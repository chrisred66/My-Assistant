// "Translate into": my language (the account's, the default) or another one. See lib/targetLanguage.ts.
import { t, useLang } from "../lib/i18n";
import { setTargetChoice, TARGETS, targetName, useTarget, type TargetChoice, type TargetPurpose } from "../lib/targetLanguage";

export default function TargetPicker({ purpose, disabled = false }: { purpose: TargetPurpose; disabled?: boolean }) {
  const [choice] = useTarget(purpose);
  const lang = useLang();
  return (
    <label className="field inline">
      <span>{t("Translate into")}</span>
      <select value={choice} disabled={disabled} onChange={(e) => setTargetChoice(purpose, e.target.value as TargetChoice)}>
        <option value="auto">{t("My language ({name})", { name: targetName(lang) })}</option>
        {TARGETS.map((code) => (
          <option key={code} value={code}>
            {targetName(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
