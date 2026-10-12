import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { api, type Transcript, type TranslateResult } from "../lib/api";
import { TranscriptCard } from "./Transcripts";
import { errorMessage, formatInteger } from "../lib/format";
import { track } from "../lib/activity";

export default function Translate() {
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
      setResult(await track("translating", "Translating", () => api.translate(text, model.trim() || undefined)));
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
          <span>Arabic text</span>
          <textarea
            className="arabic"
            dir="rtl"
            lang="ar"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اكتب أو الصق النص العربي هنا"
            required
          />
        </label>

        <div className="row wrap">
          <label className="field inline grow">
            <span>Model (optional)</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Server default" spellCheck={false} />
          </label>
          <button className="primary align-end" type="submit" disabled={busy || !text.trim()}>
            {busy ? "Translating…" : "Translate"}
          </button>
        </div>
      </form>

      <ErrorText message={error} />

      {result && (
        <div className="card stack">
          <div className="row space-between">
            <h2>English</h2>
            <CopyButton text={result.translation} />
          </div>
          <p className="prose">{result.translation}</p>
          <p className="muted small">
            {result.model} · {formatInteger(result.usage.input_tokens)} input / {formatInteger(result.usage.output_tokens)} output tokens
          </p>
        </div>
      )}

      <h2>Your translations</h2>
      {history === null && <p className="muted">Loading…</p>}
      {history?.length === 0 && <p className="muted">No translations yet.</p>}
      <div className="stack">
        {history?.map((t) => (
          <TranscriptCard key={t.id} transcript={t} onChanged={() => void loadHistory()} />
        ))}
      </div>
    </section>
  );
}
