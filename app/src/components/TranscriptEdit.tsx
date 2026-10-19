// Editing your own transcripts and translations, and what's been learned from your edits. A changed original of a
// transcribed recording is learned from in the background (the server picks DeepSeek for Chinese, OpenAI otherwise),
// and new transcripts come out with those corrections applied.
import { useCallback, useEffect, useState } from "react";
import { api, type HabitGroup, type LearnResult, type TranscriptHabits } from "../lib/api";
import { track } from "../lib/activity";
import { errorMessage, languageName } from "../lib/format";
import { ErrorText } from "./common";
import { t, tn } from "../lib/i18n";
import { targetName } from "../lib/targetLanguage";

/** Learn from pending edits without holding up the page (the ball shows "Learning"). */
export function learnInBackground(): Promise<LearnResult | null> {
  return track("learning", t("Learning edits"), () => api.learnHabits()).catch(() => null);
}

/** Original and translation side by side, editable. `onSaved(learning)`: learning says your changes are being learned from. */
export function TranscriptEditor({
  id,
  source,
  english,
  language,
  targetLang,
  onSaved,
  onCancel,
}: {
  id: number;
  source: string;
  english: string | null; // the translation, in targetLang
  language: string | null;
  targetLang: string;
  onSaved: (learning: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(source);
  const [en, setEn] = useState(english ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showEnglish = english !== null || language !== targetLang;

  async function save() {
    const patch: { source_text?: string; translated_text?: string } = {};
    if (text !== source) patch.source_text = text;
    if (showEnglish && en !== (english ?? "")) patch.translated_text = en;
    if (!patch.source_text && patch.translated_text === undefined) return onCancel();
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateTranscript(id, patch);
      if (res.learn) void learnInBackground();
      onSaved(res.learn);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="stack-tight transcript-edit">
      <div className={showEnglish ? "two-col" : undefined}>
        <label className="field">
          <span>{t("Original{v}", { v: language ? ` · ${languageName(language)}` : "" })}</span>
          <textarea dir="auto" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {showEnglish && (
          <label className="field">
            <span>{targetName(targetLang)}</span>
            <textarea rows={8} value={en} onChange={(e) => setEn(e.target.value)} placeholder={t("Not translated yet")} />
          </label>
        )}
      </div>
      <ErrorText message={error} />
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={busy || !text.trim()}>
          {busy ? t("Saving…") : t("Save")}
        </button>
        <button onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}

const GROUP_LABELS: Record<HabitGroup, string> = { zh: "Chinese", other: "Other languages" };

/** What's been learned from your edits: remove a rule, forget a language, or learn edits still waiting. */
export function LearnedHabits() {
  const [habits, setHabits] = useState<TranscriptHabits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHabits(await api.habits());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(run: () => Promise<TranscriptHabits>) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      setHabits(res);
      if ("errors" in res && Array.isArray(res.errors) && res.errors.length) setError(res.errors.join(" · "));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const total = habits ? habits.rules.zh.length + habits.rules.other.length : 0;
  return (
    <details className="card habits">
      <summary>
        {t("Learned from your edits")}
        {habits && <span className="muted small"> · {total === 0 ? t("nothing yet") : tn(total, "{n} rule", "{n} rules")}</span>}
      </summary>
      <p className="muted small">
        {t("When you correct a recording's transcript, the changes you keep making (names, terms, misheard words, punctuation, fillers) become rules that are applied to your new transcripts.")}
      </p>
      <ErrorText message={error} />
      {habits && habits.pending > 0 && (
        <div className="row">
          <span className="small">{t("{pending} edit{v} not learned yet.", { pending: habits.pending, v: habits.pending === 1 ? "" : "s" })}</span>
          <button className="small-btn" disabled={busy} onClick={() => void change(() => track("learning", t("Learning edits"), () => api.learnHabits()))}>
            {busy ? t("Learning…") : t("Learn now")}
          </button>
        </div>
      )}
      {habits &&
        (["zh", "other"] as HabitGroup[]).map((g) => {
          const rules = habits.rules[g];
          if (!rules.length) return null;
          return (
            <div key={g} className="stack-tight">
              <div className="row space-between">
                <h3>{t(GROUP_LABELS[g])}</h3>
                <button
                  className="link-btn small"
                  disabled={busy}
                  onClick={() => window.confirm(t("Forget everything learned for {lowerCase}?", { lowerCase: t(GROUP_LABELS[g]).toLowerCase() })) && void change(() => api.setHabits(g, []))}
                >
                  {t("Forget all")}
                </button>
              </div>
              <ul className="habit-list">
                {rules.map((rule, i) => (
                  <li key={rule}>
                    <span dir="auto">{rule}</span>
                    <button
                      className="link-btn small"
                      aria-label={t("Remove rule: {rule}", { rule })}
                      title={t("Remove this rule")}
                      disabled={busy}
                      onClick={() => void change(() => api.setHabits(g, rules.filter((_, j) => j !== i)))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </details>
  );
}
