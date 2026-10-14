import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { CopyButton, ErrorText } from "../components/common";
import { TranscriptEditor } from "../components/TranscriptEdit";
import { LinePairs } from "../components/LinePairs";
import MeetingPanel, { MeetingSpeakers } from "./MeetingPanel";
import { api, type Recording, type RemovedAudio, type StorageInfo, type UploadResult } from "../lib/api";
import {
  errorMessage,
  formatBytes,
  formatDateTime,
  formatDuration,
  languageName,
  toSqlDateTime,
} from "../lib/format";
import { LiveRecorder, type LiveChunk } from "../lib/liveRecorder";
import { startActivity, track } from "../lib/activity";
import { isDesktop } from "../lib/platform";

const KEY_HINT = "Transcription needs its AI API key set in server/.env.";
const MAX_IN_FLIGHT = 2; // chunks being transcribed at once; more would only queue at the server

function withHint(message: string): string {
  return /AI API key|rejected the server's API key/i.test(message) ? `${message} ${KEY_HINT}` : message;
}

/** `canTranscribe` false (free plan): record and save audio only; nothing is sent for transcription. */
export default function Recordings({ canTranscribe = true }: { canTranscribe?: boolean }) {
  const [list, setList] = useState<Recording[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [removed, setRemoved] = useState<RemovedAudio[]>([]);

  const refresh = useCallback(async () => {
    setListError(null);
    try {
      const [list, storage] = await Promise.all([api.recordings(), api.recordingStorage()]);
      setList(list);
      setStorage(storage);
    } catch (e) {
      setListError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saved = useCallback(
    (id: number, removedAudio?: RemovedAudio[]) => {
      setExpanded(id);
      if (removedAudio?.length) setRemoved(removedAudio);
      void refresh();
    },
    [refresh],
  );

  return (
    <section className="page">

      {!canTranscribe && (
        <p className="adjusted-note small">
          Free plan: recordings are saved as audio. Live transcripts, meetings with speakers, transcribing and translating recordings are on the paid
          plan.
        </p>
      )}
      <LivePanel onSaved={saved} canTranscribe={canTranscribe} />
      {canTranscribe && <MeetingPanel onSaved={saved} />}
      <FileUpload onSaved={saved} canTranscribe={canTranscribe} />

      <div className="row space-between">
        <h2>Saved recordings</h2>
        <button className="small-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {storage && <StorageBar storage={storage} />}
      {removed.length > 0 && (
        <div className="adjusted-note small">
          To stay within your 125 MB, the audio of your oldest {removed.length === 1 ? "recording was" : `${removed.length} recordings were`} removed:{" "}
          {removed.map((x) => x.title || `#${x.id}`).join(", ")}. Their transcripts are kept.{" "}
          <button className="link-btn" onClick={() => setRemoved([])}>
            OK
          </button>
        </div>
      )}
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
                    <td>
                      {r.title || r.original_name || (r.kind === "meeting" ? `Meeting #${r.id}` : `Recording #${r.id}`)}
                      {r.kind === "meeting" && <span className="lang-tag">Meeting</span>}
                    </td>
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
                        <RecordingDetails recording={r} onChanged={() => void refresh()} canTranscribe={canTranscribe} />
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

/** How much of the 125 MB is used; near the limit it says the oldest audio goes first. */
function StorageBar({ storage }: { storage: StorageInfo }) {
  const share = Math.min(1, storage.used_bytes / storage.limit_bytes);
  return (
    <div className="storage-bar small">
      <span>
        Audio storage: {formatBytes(storage.used_bytes)} of {formatBytes(storage.limit_bytes)}
      </span>
      <span className={`storage-track${share > 0.8 ? " near" : ""}`} aria-hidden>
        <span style={{ width: `${share * 100}%` }} />
      </span>
      {share > 0.8 && (
        <span className="muted">When it's full, the oldest recordings' audio is removed to make room (transcripts stay). Save any audio you want to keep.</span>
      )}
    </div>
  );
}

function status(r: Recording): string {
  if (r.audio_removed_at) return r.source_text ? "Transcript (audio removed)" : "Audio removed";
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

function LivePanel({ onSaved, canTranscribe }: { onSaved: (recordingId: number, removed?: RemovedAudio[]) => void; canTranscribe: boolean }) {
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

    // Free plan: chunks aren't sent (no transcription); the whole recording is still saved on Stop.
    const recorder = new LiveRecorder({ onChunk: canTranscribe ? enqueue : () => {}, onLevel: setLevel });
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
      const done = await api.liveFinish(recordingId, recording.audio, `recording-${stamp}.${ext}`, recording.durationMs / 1000);
      setSavedId(recordingId);
      setTitle("");
      onSaved(recordingId, done.audio_removed);
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

  // Tell the desktop ball while recording (and while the recording is being saved).
  useEffect(() => {
    if (phase === "recording") return startActivity("recording", "Recording");
    if (phase === "finishing") return startActivity("saving", "Saving audio");
  }, [phase]);

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

function FileUpload({ onSaved, canTranscribe }: { onSaved: (recordingId: number, removed?: RemovedAudio[]) => void; canTranscribe: boolean }) {
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
      const res = await track("uploading", "Uploading", () => api.uploadRecording(file, file.name, {
        title: title.trim() || undefined,
        recordedAt: toSqlDateTime(new Date(file.lastModified)),
        transcribe: canTranscribe,
      }));
      setResult(res);
      pick(undefined);
      setTitle("");
      onSaved(res.id, res.audio_removed);
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
              {busy ? (canTranscribe ? "Uploading & transcribing…" : "Uploading…") : canTranscribe ? "Upload & transcribe" : "Upload"}
            </button>
          </div>
        )}
        <ErrorText message={error} />
        {result && (
          <div className="stack-tight">
            <p className="small">Saved recording #{result.id}. Open it in the list below.</p>
            {result.transcribe_error && canTranscribe && <p className="error-text">Transcription failed: {withHint(result.transcribe_error)}</p>}
            {result.translate_error && <p className="error-text">Translation failed: {result.translate_error}</p>}
          </div>
        )}
      </form>
    </details>
  );
}

// ---- One saved recording --------------------------------------------------------

function RecordingDetails({ recording: r, onChanged, canTranscribe }: { recording: Recording; onChanged: () => void; canTranscribe: boolean }) {
  const [busy, setBusy] = useState<"transcribe" | "translate" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const hasAudio = r.has_audio;
  const name = r.title || r.original_name || `Recording #${r.id}`;

  /** Downloads the audio and saves it where the person chooses (kept even after it's removed from the server). */
  async function saveAudio() {
    setError(null);
    try {
      const { bytes, name: fileName } = await api.recordingAudio(r.id);
      const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "webm";
      const path = await save({ defaultPath: fileName, filters: [{ name: "Audio", extensions: [ext] }] });
      if (!path) return;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await invoke("save_file", { path, data: btoa(binary) });
      setNote(`Audio saved to ${path}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function rename() {
    const title = window.prompt("Recording title", r.title || r.original_name || "");
    if (title === null) return;
    setError(null);
    try {
      await api.renameRecording(r.id, title);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${name}"? Its audio and transcript are deleted too.`)) return;
    setBusy("delete");
    setError(null);
    try {
      await api.deleteRecording(r.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }
  const english = r.language === "en";

  async function run(step: "transcribe" | "translate") {
    const again =
      r.kind === "meeting"
        ? "Transcribe the whole meeting again, with speakers? This replaces the current text and its translation."
        : "Transcribe the whole recording again? This replaces the current text and its translation.";
    if (step === "transcribe" && r.source_text && !window.confirm(again)) {
      return;
    }
    setBusy(step);
    setError(null);
    try {
      if (step === "transcribe") {
        const t = await track("transcribing", "Transcribing", () => api.transcribeRecording(r.id));
        if (t.language !== "en") await track("translating", "Translating", () => api.translateTranscript(t.transcript_id));
      } else if (r.transcript_id) {
        const transcriptId = r.transcript_id;
        await track("translating", "Translating", () => api.translateTranscript(transcriptId));
      }
      onChanged();
    } catch (e) {
      setError(withHint(errorMessage(e)));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  const actions = (
    <div className="row recording-actions">
      <button className="small-btn" onClick={() => void rename()} disabled={busy !== null}>
        Rename
      </button>
      {hasAudio && isDesktop && (
        <button className="small-btn" onClick={() => void saveAudio()} disabled={busy !== null}>
          Save audio…
        </button>
      )}
      {r.transcript_id && r.source_text && !editing && (
        <button className="small-btn" onClick={() => (setEditing(true), setNote(null))} disabled={busy !== null}>
          Edit transcript
        </button>
      )}
      <button className="small-btn danger" onClick={() => void remove()} disabled={busy !== null}>
        {busy === "delete" ? "Deleting…" : "Delete recording"}
      </button>
      {note && <span className="muted small">{note}</span>}
      {r.kind === "meeting" && <MeetingSpeakers recordingId={r.id} onChanged={onChanged} />}
    </div>
  );

  if (editing && r.transcript_id && r.source_text) {
    return (
      <div className="stack-tight details">
        {actions}
        <ErrorText message={error} />
        <TranscriptEditor
          id={r.transcript_id}
          source={r.source_text}
          english={r.translated_text}
          language={r.language}
          onCancel={() => setEditing(false)}
          onSaved={(learning) => {
            setEditing(false);
            setNote(learning ? "Saved. Your corrections will be applied to future transcripts." : "Saved.");
            onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack-tight details">
      {actions}
      <div className="stack-tight">
        <div className="row space-between wrap">
          <h3>
            {r.source_text && r.language ? languageName(r.language) : "Transcript"}
            {r.source_text && !english && " → English"}
          </h3>
          <div className="row">
            {r.source_text && <CopyButton text={r.source_text} label="Copy original" />}
            {r.translated_text && <CopyButton text={r.translated_text} label="Copy English" />}
            {hasAudio && canTranscribe && (
              <button className="small-btn" onClick={() => void run("transcribe")} disabled={busy !== null}>
                {busy === "transcribe" ? "Transcribing…" : r.source_text ? "Transcribe again" : "Transcribe"}
              </button>
            )}
            {r.source_text && !english && canTranscribe && (
              <button className="small-btn" onClick={() => void run("translate")} disabled={busy !== null}>
                {busy === "translate" ? "Translating…" : r.translated_text ? "Translate again" : "Translate"}
              </button>
            )}
          </div>
        </div>
        {r.source_text ? (
          <>
            <LinePairs source={r.source_text} english={r.translated_text} />
            {!r.translated_text && !english && <p className="muted small">Not translated yet.</p>}
          </>
        ) : (
          <p className="muted small">{r.audio_removed_at ? "The audio was removed to stay within your 125 MB of storage, and it wasn't transcribed." : !hasAudio ? "This recording wasn't finished, so no audio was saved." : canTranscribe ? "Not transcribed yet." : "Audio only: transcription is on the paid plan."}</p>
        )}
        <ErrorText message={error} />
      </div>
    </div>
  );
}
