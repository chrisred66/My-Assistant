import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { api, type Transcript } from "../lib/api";
import { errorMessage, formatDateTime, languageName } from "../lib/format";

export default function Transcripts() {
  const [items, setItems] = useState<Transcript[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.transcripts());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!items || !q) return items;
    return items.filter(
      (t) => t.source_text.toLowerCase().includes(q) || (t.translated_text ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <section className="page">
      <header className="page-header">
        <h1>Transcripts</h1>
        <p className="muted">Your latest 200 transcripts, from recordings and typed text.</p>
      </header>

      <div className="row">
        <input
          className="grow"
          type="search"
          placeholder="Search original or English…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search transcripts"
        />
        <button className="small-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <ErrorText message={error} />
      {items === null && !error && <p className="muted">Loading…</p>}
      {filtered?.length === 0 && <p className="muted">{query ? "No matches." : "No transcripts yet."}</p>}

      <div className="stack">
        {filtered?.map((t) => (
          <TranscriptCard key={t.id} transcript={t} onTranslated={() => void refresh()} />
        ))}
      </div>
    </section>
  );
}

function TranscriptCard({ transcript: t, onTranslated }: { transcript: Transcript; onTranslated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function translate() {
    setBusy(true);
    setError(null);
    try {
      await api.translateTranscript(t.id);
      onTranslated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const source = t.recording_id ? `Recording #${t.recording_id}` : "Typed text";
  const via = t.translate_provider ? ` · ${t.translate_provider}/${t.translate_model}` : "";

  return (
    <article className="card transcript">
      <span className="muted small">
        {formatDateTime(t.created_at)} · {source}
        {via}
      </span>
      <div className="two-col">
        <div className="stack-tight">
          <div className="row space-between">
            <h3>Original · {languageName(t.language)}</h3>
            <CopyButton text={t.source_text} />
          </div>
          <p className="prose" dir="auto">
            {t.source_text}
          </p>
        </div>
        <div className="stack-tight">
          <div className="row space-between">
            <h3>English</h3>
            {t.translated_text ? (
              <CopyButton text={t.translated_text} />
            ) : t.language === "en" ? null : (
              <button className="small-btn" onClick={() => void translate()} disabled={busy}>
                {busy ? "Translating…" : "Translate"}
              </button>
            )}
          </div>
          {t.translated_text ? (
            <p className="prose">{t.translated_text}</p>
          ) : (
            <p className="muted small">{t.language === "en" ? "Already English." : "Not translated yet."}</p>
          )}
          <ErrorText message={error} />
        </div>
      </div>
    </article>
  );
}
