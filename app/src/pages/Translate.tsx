import { useState, type FormEvent } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { api, type TranslateResult } from "../lib/api";
import { errorMessage, formatInteger } from "../lib/format";

export default function Translate() {
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslateResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.translate(text, model.trim() || undefined));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Translate</h1>
        <p className="muted">Arabic text to English, translated by Claude. Every translation is saved to Transcripts and token-logged.</p>
      </header>

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
            <span>Claude model (optional)</span>
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
    </section>
  );
}
