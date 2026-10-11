import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CopyButton, ErrorText } from "../components/common";
import { api, type Recording, type UploadResult } from "../lib/api";
import {
  errorMessage,
  formatBytes,
  formatDateTime,
  formatDuration,
  languageName,
  toSqlDateTime,
} from "../lib/format";
import { LiveRecorder, type LiveChunk } from "../lib/liveRecorder";

const OPENAI_HINT = "Transcription uses OpenAI on the server, so it needs OPENAI_API_KEY in server/.env.";
const MAX_IN_FLIGHT = 2; // chunks being transcribed at once; more would only queue at the server

function withHint(message: string): string {
  return /OPENAI_API_KEY|openai/i.test(message) ? `${message} ${OPENAI_HINT}` : message;
}

export default function Recordings() {
  const [list, setList] = useState<Recording[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    try {
      setList(await api.recordings());
    } catch (e) {
      setListError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saved = useCallback(
    (id: number) => {
      setExpanded(id);
      void refresh();
    },
    [refresh],
  );

  return (
    <section className="page">
      <header className="page-header">
        <h1>Recordings</h1>
        <p className="muted">
          Speak and watch the transcript appear. Anything not in English is translated as you go. The recording is saved when you stop.
        </p>
      </header>

      <LivePanel onSaved={saved} />
      <FileUpload onSaved={saved} />

      <div className="row space-between">
        <h2>Saved recordings</h2>
        <button className="small-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <ErrorText message={listError} />
      {list === null && !listError && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">No recordings yet.</p>}
      {list && list.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Recorded</th>
              <th className="num">Length</th>
              <th>Language</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const open = expanded === r.id;
              return (
                <Fragment key={r.id}>
                  <tr className={open ? "expanded" : undefined}>
                    <td>{r.title || r.original_name || `Recording #${r.id}`}</td>
                    <td>{formatDateTime(r.recorded_at ?? r.created_at)}</td>
                    <td className="num">{formatDuration(r.duration_sec)}</td>
                    <td>{r.source_text ? languageName(r.language) : "—"}</td>
                    <td>{status(r)}</td>
                    <td className="num">
                      <button className="small-btn" onClick={() => setExpanded(open ? null : r.id)} aria-expanded={open}>
                        {open ? "Hide" : "Open"}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="details-row">
                      <td colSpan={6}>
                        <RecordingDetails recording={r} onChanged={() => void refresh()} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function status(r: Recording): string {
  if (!r.original_name && r.size_bytes === 0) return "Not finished";
  if (!r.source_text) return "Audio only";
  if (r.language === "en" || r.translated_text) return "Transcribed";
  return "Needs translation";
}

// ---- Live recording ----------------------------------------------------------

interface Segment {
  seq: number;
  startMs: number;
  status: "pending" | "done" | "error";
  text?: string;
  language?: string | null;
  english?: string | null;
  error?: string;
}

type Phase = "idle" | "starting" | "recording" | "finishing";

function LivePanel({ onSaved }: { onSaved: (recordingId: number) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  const recorderRef = useRef<LiveRecorder | null>(null);
  const recordingIdRef = useRef<number | null>(null);
  const queueRef = useRef<LiveChunk[]>([]);
  const chunksRef = useRef(new Map<number, LiveChunk>()); // kept for retries
  const inFlightRef = useRef(0);
  const lastTextRef = useRef(""); // context for the next chunk
  const idleWaitersRef = useRef<(() => void)[]>([]);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const patch = (seq: number, update: Partial<Segment>) =>
    setSegments((prev) => prev.map((s) => (s.seq === seq ? { ...s, ...update } : s)));

  const pump = useCallback(() => {
    while (inFlightRef.current < MAX_IN_FLIGHT && queueRef.current.length > 0) {
      const chunk = queueRef.current.shift()!;
      const recordingId = recordingIdRef.current;
      if (recordingId === null) return;
      inFlightRef.current++;
      api
        .liveChunk(recordingId, chunk, lastTextRef.current)
        .then((res) => {
          if (res.text) lastTextRef.current = res.text;
          patch(chunk.seq, {
            status: res.translate_error ? "error" : "done",
            text: res.text,
            language: res.language,
            english: res.english,
            error: res.translate_error ? `Translation failed: ${res.translate_error}` : undefined,
          });
        })
        .catch((e) => patch(chunk.seq, { status: "error", error: withHint(errorMessage(e)) }))
        .finally(() => {
          inFlightRef.current--;
          pump();
          if (inFlightRef.current === 0 && queueRef.current.length === 0) {
            idleWaitersRef.current.splice(0).forEach((resolve) => resolve());
          }
        });
    }
  }, []);

  const enqueue = useCallback(
    (chunk: LiveChunk) => {
      chunksRef.current.set(chunk.seq, chunk);
      setSegments((prev) => [
        ...prev.filter((s) => s.seq !== chunk.seq),
        { seq: chunk.seq, startMs: chunk.startMs, status: "pending" },
      ]);
      queueRef.current.push(chunk);
      pump();
    },
    [pump],
  );

  const whenIdle = () =>
    inFlightRef.current === 0 && queueRef.current.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => idleWaitersRef.current.push(resolve));

  async function start() {
    setError(null);
    setSavedId(null);
    setSegments([]);
    chunksRef.current.clear();
    queueRef.current = [];
    lastTextRef.current = "";
    setPhase("starting");

    const recorder = new LiveRecorder({ onChunk: enqueue, onLevel: setLevel });
    try {
      const session = await api.liveStart(title.trim() || undefined, toSqlDateTime(new Date()));
      recordingIdRef.current = session.recording_id;
      await recorder.start();
    } catch (e) {
      setPhase("idle");
      const message = errorMessage(e);
      setError(
        /Permission|NotAllowed|NotFound|microphone/i.test(message)
          ? `Microphone unavailable: ${message}. Check Windows Settings → Privacy & security → Microphone.`
          : message,
      );
      return;
    }
    recorderRef.current = recorder;
    const startedAt = Date.now();
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    setPhase("recording");
  }

  async function stop() {
    const recorder = recorderRef.current;
    const recordingId = recordingIdRef.current;
    if (!recorder || recordingId === null) return;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    setPhase("finishing");
    setLevel(0);
    try {
      const recording = await recorder.stop(); // emits the last chunk
      await whenIdle();
      const ext = recording.mimeType.includes("ogg") ? "ogg" : recording.mimeType.includes("mp4") ? "m4a" : "webm";
      const stamp = toSqlDateTime(new Date()).replace(/[: ]/g, "-");
      await api.liveFinish(recordingId, recording.audio, `recording-${stamp}.${ext}`, recording.durationMs / 1000);
      setSavedId(recordingId);
      setTitle("");
      onSaved(recordingId);
    } catch (e) {
      setError(`The recording couldn't be saved: ${errorMessage(e)}`);
    } finally {
      recorderRef.current = null;
      setPhase("idle");
    }
  }

  function retry(seq: number) {
    const chunk = chunksRef.current.get(seq);
    if (chunk) enqueue(chunk);
  }

  // Leaving the page mid-recording abandons it.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      void recorderRef.current?.cancel();
    },
    [],
  );

  // Follow new text, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [segments]);

  const pending = segments.filter((s) => s.status === "pending").length;
  const shown = [...segments].sort((a, b) => a.seq - b.seq).filter((s) => s.status !== "done" || s.text);

  return (
    <div className="card stack">
      <div className="row wrap">
        <label className="field inline grow">
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={255}
            placeholder="Optional"
            disabled={phase !== "idle"}
          />
        </label>
        {phase === "recording" ? (
          <button className="danger align-end" onClick={() => void stop()}>
            ■ Stop ({formatDuration(elapsed)})
          </button>
        ) : (
          <button className="primary align-end" onClick={() => void start()} disabled={phase !== "idle"}>
            {phase === "starting" ? "Starting…" : phase === "finishing" ? "Saving…" : "● Record"}
          </button>
        )}
      </div>

      {phase === "recording" && (
        <div className="row">
          <span className="rec-dot" aria-hidden />
          <div className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <span className="muted small">{pending > 0 ? `Transcribing ${pending}…` : "Listening…"}</span>
        </div>
      )}
      {phase === "finishing" && (
        <p className="muted small">{pending > 0 ? `Finishing the last ${pending} part(s), then saving…` : "Saving the recording…"}</p>
      )}
      <ErrorText message={error} />
      {savedId !== null && phase === "idle" && <p className="small">Saved as recording #{savedId}.</p>}

      {shown.length > 0 && (
        <div className="live-transcript" ref={scrollRef} aria-live="polite">
          <div className="live-row live-head">
            <span>Original</span>
            <span>English</span>
          </div>
          {shown.map((s) => (
            <div key={s.seq} className="live-row">
              <div>
                {s.status === "pending" && <span className="muted small">Transcribing…</span>}
                {s.text && (
                  <p className="prose" dir="auto">
                    {s.text}
                  </p>
                )}
                {s.text && s.language && <span className="lang-tag">{languageName(s.language)}</span>}
              </div>
              <div>
                {s.english && <p className="prose">{s.english}</p>}
                {s.status === "done" && !s.english && s.language === "en" && <span className="muted small">Already English</span>}
                {s.status === "error" && (
                  <div className="stack-tight">
                    <span className="error-text small">{s.error}</span>
                    {phase !== "finishing" && (
                      <button className="small-btn" onClick={() => retry(s.seq)}>
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Upload an existing file ------------------------------------------------------

function FileUpload({ onSaved }: { onSaved: (recordingId: number) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  function pick(f: File | undefined) {
    if (url) URL.revokeObjectURL(url);
    setFile(f ?? null);
    setUrl(f ? URL.createObjectURL(f) : null);
    setResult(null);
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadRecording(file, file.name, {
        title: title.trim() || undefined,
        recordedAt: toSqlDateTime(new Date(file.lastModified)),
        transcribe: true,
      });
      setResult(res);
      pick(undefined);
      setTitle("");
      onSaved(res.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card">
      <summary>Upload an existing audio file</summary>
      <form className="stack upload-form" onSubmit={(e) => void upload(e)}>
        <div className="row wrap">
          <label className="file-btn">
            Choose audio file…
            <input type="file" accept="audio/*,video/webm,video/mp4" onChange={(e) => pick(e.target.files?.[0])} hidden />
          </label>
          {file && url && (
            <>
              <audio controls src={url} />
              <span className="muted small">
                {file.name} · {formatBytes(file.size)}
              </span>
            </>
          )}
        </div>
        {file && (
          <div className="row wrap">
            <label className="field inline grow">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="Optional" />
            </label>
            <button className="primary align-end" type="submit" disabled={busy}>
              {busy ? "Uploading & transcribing…" : "Upload & transcribe"}
            </button>
          </div>
        )}
        <ErrorText message={error} />
        {result && (
          <div className="stack-tight">
            <p className="small">Saved recording #{result.id}. Open it in the list below.</p>
            {result.transcribe_error && <p className="error-text">Transcription failed: {withHint(result.transcribe_error)}</p>}
            {result.translate_error && <p className="error-text">Translation failed: {result.translate_error}</p>}
          </div>
        )}
      </form>
    </details>
  );
}

// ---- One saved recording --------------------------------------------------------

function RecordingDetails({ recording: r, onChanged }: { recording: Recording; onChanged: () => void }) {
  const [busy, setBusy] = useState<"transcribe" | "translate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasAudio = r.size_bytes > 0;
  const english = r.language === "en";

  async function run(step: "transcribe" | "translate") {
    if (step === "transcribe" && r.source_text && !window.confirm("Transcribe the whole recording again? This replaces the current text and its translation.")) {
      return;
    }
    setBusy(step);
    setError(null);
    try {
      if (step === "transcribe") {
        const t = await api.transcribeRecording(r.id);
        if (t.language !== "en") await api.translateTranscript(t.transcript_id);
      } else if (r.transcript_id) {
        await api.translateTranscript(r.transcript_id);
      }
      onChanged();
    } catch (e) {
      setError(withHint(errorMessage(e)));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="two-col details">
      <div className="stack-tight">
        <div className="row space-between">
          <h3>Original{r.source_text && r.language ? ` · ${languageName(r.language)}` : ""}</h3>
          <div className="row">
            {r.source_text && <CopyButton text={r.source_text} />}
            {hasAudio && (
              <button className="small-btn" onClick={() => void run("transcribe")} disabled={busy !== null}>
                {busy === "transcribe" ? "Transcribing…" : r.source_text ? "Transcribe again" : "Transcribe"}
              </button>
            )}
          </div>
        </div>
        {r.source_text ? (
          <p className="prose" dir="auto">
            {r.source_text}
          </p>
        ) : (
          <p className="muted small">{hasAudio ? "Not transcribed yet." : "This recording wasn't finished, so no audio was saved."}</p>
        )}
      </div>

      <div className="stack-tight">
        <div className="row space-between">
          <h3>English</h3>
          <div className="row">
            {r.translated_text && <CopyButton text={r.translated_text} />}
            {r.source_text && !english && (
              <button className="small-btn" onClick={() => void run("translate")} disabled={busy !== null}>
                {busy === "translate" ? "Translating…" : r.translated_text ? "Translate again" : "Translate"}
              </button>
            )}
          </div>
        </div>
        {r.translated_text ? (
          <p className="prose">{r.translated_text}</p>
        ) : (
          <p className="muted small">
            {english ? "The original is in English." : r.source_text ? "Not translated yet." : "Transcribe first."}
          </p>
        )}
      </div>
      <div className="details-error">
        <ErrorText message={error} />
      </div>
    </div>
  );
}
