import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { LearnedHabits, TranscriptEditor } from "../components/TranscriptEdit";
import { LinePairs } from "../components/LinePairs";
import { api, type Transcript } from "../lib/api";
import { errorMessage, formatDateTime, languageName } from "../lib/format";
import { track } from "../lib/activity";
import { t } from "../lib/i18n";
import TargetPicker from "../components/TargetPicker";
import { targetName, useTarget } from "../lib/targetLanguage";

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
      (tRow) => tRow.source_text.toLowerCase().includes(q) || (tRow.translated_text ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <section className="page">
      {canTranscribe && <LearnedHabits />}

      <div className="row">
        <input
          className="grow"
          type="search"
          placeholder={t("Search original or translation…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("Search transcripts")}
        />
        {canTranscribe && <TargetPicker purpose="transcribe" />}
        <button className="small-btn" onClick={() => void refresh()}>
          {t("Refresh")}
        </button>
      </div>

      <ErrorText message={error} />
      {items === null && !error && <p className="muted">{t("Loading…")}</p>}
      {filtered?.length === 0 && <p className="muted">{query ? t("No matches.") : t("No transcripts yet.")}</p>}

      <div className="stack">
        {filtered?.map((tRow) => (
          <TranscriptCard key={tRow.id} transcript={tRow} onChanged={() => void refresh()} />
        ))}
      </div>
    </section>
  );
}

/** One transcript or translation: copy, translate, edit, delete. Also used for the Translate page's history. */
export function TranscriptCard({ transcript: tr0, onChanged }: { transcript: Transcript; onChanged: () => void }) {
  // Typed text follows the Translate page's language; recordings' transcripts, transcription's.
  const [, target] = useTarget(tr0.recording_id ? "transcribe" : "translate");
  const inTarget = tr0.language === target;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function translate() {
    setBusy(true);
    setError(null);
    try {
      await track("translating", t("Translating"), () => api.translateTranscript(tr0.id, target));
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const what = tr0.recording_id ? t("this transcript (the recording's audio stays)") : t("this translation");
    if (!window.confirm(t("Delete {what}?", { what }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTranscript(tr0.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const source = tr0.recording_id ? t("Recording #{recording_id}", { recording_id: tr0.recording_id }) : t("Typed text");

  return (
    <article className="card transcript">
      <div className="row space-between">
        <span className="muted small">
          {formatDateTime(tr0.created_at)} · {source}
        </span>
        {!editing && (
          <div className="row">
            <button className="small-btn" onClick={() => (setEditing(true), setNote(null))} disabled={busy}>
              {t("Edit")}
            </button>
            <button className="small-btn danger" onClick={() => void remove()} disabled={busy}>
              {t("Delete")}
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <TranscriptEditor
          id={tr0.id}
          source={tr0.source_text}
          english={tr0.translated_text}
          language={tr0.language}
          targetLang={tr0.translated_text ? tr0.target_lang : target}
          onCancel={() => setEditing(false)}
          onSaved={(learning) => {
            setEditing(false);
            setNote(learning ? t("Saved. Your corrections will be applied to future transcripts.") : t("Saved."));
            onChanged();
          }}
        />
      ) : (
        <div className="stack-tight">
          <div className="row space-between wrap">
            <h3>
              {languageName(tr0.language)}
              {(tr0.translated_text || !inTarget) && ` → ${targetName(tr0.translated_text ? tr0.target_lang : target)}`}
            </h3>
            <div className="row">
              <CopyButton text={tr0.source_text} label={t("Copy original")} />
              {tr0.translated_text && <CopyButton text={tr0.translated_text} label={t("Copy translation")} />}
              {!inTarget && (
                <button className="small-btn" onClick={() => void translate()} disabled={busy}>
                  {busy ? t("Translating…") : tr0.translated_text ? t("Translate again") : t("Translate")}
                </button>
              )}
            </div>
          </div>
          <LinePairs source={tr0.source_text} english={tr0.translated_text} />
          {!tr0.translated_text && !inTarget && <p className="muted small">{t("Not translated yet.")}</p>}
        </div>
      )}
      {note && <p className="muted small">{note}</p>}
      <ErrorText message={error} />
    </article>
  );
}
