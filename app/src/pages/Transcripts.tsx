import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { LearnedHabits, TranscriptEditor } from "../components/TranscriptEdit";
import { LinePairs } from "../components/LinePairs";
import { api, type Transcript } from "../lib/api";
import { errorMessage, formatDateTime, languageName } from "../lib/format";
import { track } from "../lib/activity";

/** `canTranscribe` false (free plan): no learning from edits (there are no transcripts of recordings to apply it to). */
export default function Transcripts({ canTranscribe = true }: { canTranscribe?: boolean }) {
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
      {canTranscribe && <LearnedHabits />}

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
          <TranscriptCard key={t.id} transcript={t} onChanged={() => void refresh()} />
        ))}
      </div>
    </section>
  );
}

/** One transcript or translation: copy, translate, edit, delete. Also used for the Translate page's history. */
export function TranscriptCard({ transcript: t, onChanged }: { transcript: Transcript; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function translate() {
    setBusy(true);
    setError(null);
    try {
      await track("translating", "Translating", () => api.translateTranscript(t.id));
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const what = t.recording_id ? "this transcript (the recording's audio stays)" : "this translation";
    if (!window.confirm(`Delete ${what}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTranscript(t.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const source = t.recording_id ? `Recording #${t.recording_id}` : "Typed text";

  return (
    <article className="card transcript">
      <div className="row space-between">
        <span className="muted small">
          {formatDateTime(t.created_at)} · {source}
        </span>
        {!editing && (
          <div className="row">
            <button className="small-btn" onClick={() => (setEditing(true), setNote(null))} disabled={busy}>
              Edit
            </button>
            <button className="small-btn danger" onClick={() => void remove()} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <TranscriptEditor
          id={t.id}
          source={t.source_text}
          english={t.translated_text}
          language={t.language}
          onCancel={() => setEditing(false)}
          onSaved={(learning) => {
            setEditing(false);
            setNote(learning ? "Saved. Your corrections will be applied to future transcripts." : "Saved.");
            onChanged();
          }}
        />
      ) : (
        <div className="stack-tight">
          <div className="row space-between wrap">
            <h3>
              {languageName(t.language)}
              {t.language !== "en" && " → English"}
            </h3>
            <div className="row">
              <CopyButton text={t.source_text} label="Copy original" />
              {t.translated_text && <CopyButton text={t.translated_text} label="Copy English" />}
              {t.language !== "en" && (
                <button className="small-btn" onClick={() => void translate()} disabled={busy}>
                  {busy ? "Translating…" : t.translated_text ? "Translate again" : "Translate"}
                </button>
              )}
            </div>
          </div>
          <LinePairs source={t.source_text} english={t.translated_text} />
          {!t.translated_text && t.language !== "en" && <p className="muted small">Not translated yet.</p>}
        </div>
      )}
      {note && <p className="muted small">{note}</p>}
      <ErrorText message={error} />
    </article>
  );
}
