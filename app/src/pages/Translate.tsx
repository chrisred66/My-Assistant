import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { api, type Transcript, type TranslateResult } from "../lib/api";
import { TranscriptCard } from "./Transcripts";
import { errorMessage, formatInteger } from "../lib/format";
import { track } from "../lib/activity";
import { t } from "../lib/i18n";
import TargetPicker from "../components/TargetPicker";
import { targetName, useTarget } from "../lib/targetLanguage";

export default function Translate() {
  const [, target] = useTarget("translate");
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [history, setHistory] = useState<Transcript[] | null>(null);

  // Your earlier translations (typed text, not recordings), to look at, edit or delete.
  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.transcripts()).filter((t) => t.recording_id === null));
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await track("translating", t("Translating"), () => api.translate(text, target, model.trim() || undefined)));
      void loadHistory();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">

      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{t("Text in any language (detected automatically)")}</span>
          <textarea
            dir="auto"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("Type or paste the text here")}
            required
          />
        </label>

        <div className="row wrap">
          <TargetPicker purpose="translate" disabled={busy} />
          <label className="field inline grow">
            <span>{t("Model (optional)")}</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("Server default")} spellCheck={false} />
          </label>
          <button className="primary align-end" type="submit" disabled={busy || !text.trim()}>
            {busy ? t("Translating…") : t("Translate")}
          </button>
        </div>
      </form>

      <ErrorText message={error} />

      {result && (
        <div className="card stack">
          <div className="row space-between">
            <h2>{targetName(result.target_lang)}</h2>
            <CopyButton text={result.translation} />
          </div>
          <p className="prose">{result.translation}</p>
          <p className="muted small">{t("{model} · {input_tokens} input / {output_tokens} output tokens", { model: result.model, input_tokens: formatInteger(result.usage.input_tokens), output_tokens: formatInteger(result.usage.output_tokens) })}</p>
        </div>
      )}

      <h2>{t("Your translations")}</h2>
      {history === null && <p className="muted">{t("Loading…")}</p>}
      {history?.length === 0 && <p className="muted">{t("No translations yet.")}</p>}
      <div className="stack">
        {history?.map((t) => (
          <TranscriptCard key={t.id} transcript={t} onChanged={() => void loadHistory()} />
        ))}
      </div>
    </section>
  );
}
