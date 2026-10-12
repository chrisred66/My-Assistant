// Meeting mode (paid plan): record an online meeting (what the computer plays, plus your microphone) or an in-person
// one (microphone), with live text labelled by speaker. Short chunks keep the text close behind the speech; English
// arrives a moment later from a separate call. Speakers can be named while recording or afterwards.
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorText } from "../components/common";
import { api, type MeetingSpeaker, type MeetingTurn } from "../lib/api";
import { startActivity } from "../lib/activity";
import { errorMessage, formatDuration, toSqlDateTime } from "../lib/format";
import { LiveRecorder, outputDevices, type LiveChunk } from "../lib/liveRecorder";

type Source = "online" | "in-person";
type Phase = "idle" | "starting" | "recording" | "finishing";

interface Chunk {
  seq: number;
  status: "pending" | "done" | "error";
  turns: (MeetingTurn & { english?: string | null })[];
  error?: string;
}

// Shorter chunks than plain live recording, so text follows the speech closely.
const CHUNKS = { minChunkMs: 3500, maxChunkMs: 8000, silenceMs: 450 };

/** A stable colour per speaker ("Speaker 3" -> slot 3), from the chart palette. */
export const speakerSlot = (label: string) => ((Number(label.replace(/\D/g, "")) || 1) - 1) % 8 + 1;

const DEVICE_KEY = "meetingOutputDevice";
const readDevice = () => {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
};

export default function MeetingPanel({ onSaved }: { onSaved: (recordingId: number) => void }) {
  const [source, setSource] = useState<Source>("online");
  const [devices, setDevices] = useState<{ name: string; default: boolean }[]>([]);
  const [device, setDevice] = useState(readDevice); // "" = the default output
  const [withMic, setWithMic] = useState(true);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [speakers, setSpeakers] = useState<MeetingSpeaker[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  const recorderRef = useRef<LiveRecorder | null>(null);
  const meetingRef = useRef<number | null>(null);
  const queueRef = useRef<LiveChunk[]>([]);
  const wavsRef = useRef(new Map<number, LiveChunk>()); // kept for retries
  const busyRef = useRef(false);
  const idleWaitersRef = useRef<(() => void)[]>([]);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void outputDevices().then(setDevices);
  }, []);

  function chooseDevice(name: string) {
    setDevice(name);
    try {
      localStorage.setItem(DEVICE_KEY, name);
    } catch {
      // remembered for this session only
    }
  }

  const patch = (seq: number, update: Partial<Chunk> | ((c: Chunk) => Partial<Chunk>)) =>
    setChunks((prev) => prev.map((c) => (c.seq === seq ? { ...c, ...(typeof update === "function" ? update(c) : update) } : c)));

  // One chunk at a time: speakers are matched against the voices heard so far, so order matters.
  const pump = useCallback(() => {
    if (busyRef.current) return;
    const chunk = queueRef.current.shift();
    const id = meetingRef.current;
    if (!chunk || id === null) {
      if (!busyRef.current) idleWaitersRef.current.splice(0).forEach((resolve) => resolve());
      return;
    }
    busyRef.current = true;
    api
      .meetingChunk(id, chunk)
      .then((res) => {
        patch(chunk.seq, { status: "done", turns: res.turns, error: undefined });
        setSpeakers(res.speakers);
        // English separately, without holding up the next chunk.
        if (res.turns.length) {
          void api
            .meetingTranslate(id, chunk.seq)
            .then((t) =>
              patch(chunk.seq, (c) => ({
                turns: c.turns.map((turn) => {
                  const hit = t.english.find((e) => e.part === turn.part);
                  return hit ? { ...turn, english: hit.english } : turn;
                }),
              })),
            )
            .catch(() => {});
        }
      })
      .catch((e) => patch(chunk.seq, { status: "error", error: errorMessage(e) }))
      .finally(() => {
        busyRef.current = false;
        pump();
      });
  }, []);

  const enqueue = useCallback(
    (chunk: LiveChunk) => {
      wavsRef.current.set(chunk.seq, chunk);
      setChunks((prev) => [...prev.filter((c) => c.seq !== chunk.seq), { seq: chunk.seq, status: "pending", turns: [] }]);
      queueRef.current.push(chunk);
      pump();
    },
    [pump],
  );

  const whenIdle = () =>
    !busyRef.current && queueRef.current.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaitersRef.current.push(resolve));

  async function start() {
    setError(null);
    setSavedId(null);
    setChunks([]);
    setSpeakers([]);
    wavsRef.current.clear();
    queueRef.current = [];
    setPhase("starting");
    const recorder = new LiveRecorder({
      ...CHUNKS,
      onChunk: enqueue,
      onLevel: setLevel,
      systemAudio: source === "online",
      systemDevice: devices.some((d) => d.name === device) ? device : null,
      mic: source === "in-person" || withMic,
    });
    try {
      const session = await api.meetingStart(title.trim() || undefined, toSqlDateTime(new Date()));
      meetingRef.current = session.recording_id;
      await recorder.start();
    } catch (e) {
      setPhase("idle");
      const message = errorMessage(e);
      setError(
        /Permission|NotAllowed|NotFound|microphone/i.test(message)
          ? `Microphone unavailable: ${message}. Check Windows Settings → Privacy & security → Microphone.`
          : /system_audio|not found|invoke/i.test(message) && source === "online"
            ? `The computer's audio can't be captured here (${message}). It works in the desktop app on Windows.`
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
    const id = meetingRef.current;
    if (!recorder || id === null) return;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    setPhase("finishing");
    setLevel(0);
    try {
      const recording = await recorder.stop(); // emits the last chunk
      await whenIdle();
      const ext = recording.mimeType.includes("ogg") ? "ogg" : recording.mimeType.includes("mp4") ? "m4a" : "webm";
      const stamp = toSqlDateTime(new Date()).replace(/[: ]/g, "-");
      await api.liveFinish(id, recording.audio, `meeting-${stamp}.${ext}`, recording.durationMs / 1000);
      setSavedId(id);
      setTitle("");
      onSaved(id);
    } catch (e) {
      setError(`The meeting couldn't be saved: ${errorMessage(e)}`);
    } finally {
      recorderRef.current = null;
      setPhase("idle");
    }
  }

  function retry(seq: number) {
    const chunk = wavsRef.current.get(seq);
    if (chunk) enqueue(chunk);
  }

  async function rename(s: MeetingSpeaker) {
    const id = meetingRef.current;
    const name = window.prompt(`Name for ${s.label}`, s.name ?? "");
    if (id === null || name === null) return;
    try {
      setSpeakers(await api.renameSpeaker(id, s.label, name));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    if (phase === "recording") return startActivity("recording", "Meeting");
    if (phase === "finishing") return startActivity("saving", "Saving meeting");
  }, [phase]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      void recorderRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  const nameOf = (label: string) => speakers.find((s) => s.label === label)?.name || label;
  // Consecutive turns by one speaker read as one block, across chunks.
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const blocks: { key: string; speaker: string; texts: { text: string; english?: string | null }[] }[] = [];
  for (const c of ordered) {
    for (const t of c.turns) {
      const last = blocks[blocks.length - 1];
      if (last && last.speaker === t.speaker) last.texts.push(t);
      else blocks.push({ key: `${c.seq}-${t.part}`, speaker: t.speaker, texts: [t] });
    }
  }
  const pending = chunks.filter((c) => c.status === "pending").length;
  const failed = ordered.filter((c) => c.status === "error");
  const idle = phase === "idle";

  return (
    <div className="card stack meeting">
      <div className="row space-between wrap">
        <h2>Meeting</h2>
        <span className="muted small">Live text with speakers · paid plan</span>
      </div>
      <div className="row wrap">
        <div className="field inline">
          <span>Meeting</span>
          <div className="segmented" role="group" aria-label="Meeting type">
            <button className={source === "online" ? "on" : ""} aria-pressed={source === "online"} onClick={() => setSource("online")} disabled={!idle}>
              Online
            </button>
            <button className={source === "in-person" ? "on" : ""} aria-pressed={source === "in-person"} onClick={() => setSource("in-person")} disabled={!idle}>
              In person
            </button>
          </div>
        </div>
        <label className="field inline grow">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="Optional" disabled={!idle} />
        </label>
        {phase === "recording" ? (
          <button className="danger align-end" onClick={() => void stop()}>
            ■ End meeting ({formatDuration(elapsed)})
          </button>
        ) : (
          <button className="primary align-end" onClick={() => void start()} disabled={!idle}>
            {phase === "starting" ? "Starting…" : phase === "finishing" ? "Saving…" : "● Start meeting"}
          </button>
        )}
      </div>
      {source === "online" && devices.length > 0 && (
        <label className="field inline">
          <span>Meeting audio from</span>
          <select value={devices.some((d) => d.name === device) ? device : ""} onChange={(e) => chooseDevice(e.target.value)} disabled={!idle}>
            <option value="">Default output ({devices.find((d) => d.default)?.name ?? "system default"})</option>
            {devices
              .filter((d) => !d.default)
              .map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {source === "online" && devices.length > 0 && (
        <p className="muted small device-hint">The device your meeting app plays through (headsets often have a separate "Chat" one).</p>
      )}
      {source === "online" ? (
        <label className="check small">
          <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} disabled={!idle} />
          Also record my microphone. Records what this computer plays (the meeting app) — use headphones so the others aren't picked up twice.
        </label>
      ) : (
        <p className="muted small">Records the microphone. Place the computer where it can hear everyone.</p>
      )}

      {phase === "recording" && (
        <div className="row">
          <span className="rec-dot" aria-hidden />
          <div className="meter" role="meter" aria-label="Audio level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <span className="muted small">{pending > 0 ? `Transcribing ${pending}…` : "Listening…"}</span>
        </div>
      )}
      {phase === "finishing" && <p className="muted small">{pending > 0 ? `Finishing the last ${pending} part(s), then saving…` : "Saving the meeting…"}</p>}
      <ErrorText message={error} />
      {savedId !== null && idle && <p className="small">Saved as recording #{savedId}. Speakers can still be renamed there.</p>}

      {speakers.length > 0 && (
        <div className="speaker-chips" aria-label="Speakers">
          {speakers.map((s) => (
            <button key={s.label} className="speaker-chip" onClick={() => void rename(s)} title={`Rename ${s.label}`}>
              <span className={`swatch bg-c${speakerSlot(s.label)}`} aria-hidden />
              {s.name || s.label}
              {s.name && <span className="muted small"> ({s.label})</span>}
            </button>
          ))}
          <span className="muted small">Click a speaker to name them.</span>
        </div>
      )}

      {(blocks.length > 0 || pending > 0) && (
        <div className="live-transcript meeting-transcript" ref={scrollRef} aria-live="polite">
          {blocks.map((b) => (
            <div key={b.key} className={`meeting-turn turn-c${speakerSlot(b.speaker)}`}>
              <div className="meeting-who">
                <span className={`swatch bg-c${speakerSlot(b.speaker)}`} aria-hidden />
                {nameOf(b.speaker)}
              </div>
              <p className="prose" dir="auto">
                {b.texts.map((t) => t.text).join(" ")}
              </p>
              {b.texts.some((t) => t.english) && <p className="prose muted">{b.texts.map((t) => t.english ?? t.text).join(" ")}</p>}
            </div>
          ))}
          {pending > 0 && <div className="meeting-turn muted small">Transcribing…</div>}
        </div>
      )}
      {failed.map((c) => (
        <div key={c.seq} className="row">
          <span className="error-text small">Part {c.seq + 1} failed: {c.error}</span>
          {phase !== "finishing" && (
            <button className="small-btn" onClick={() => retry(c.seq)}>
              Retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** For a saved meeting: its speakers, renamable. */
export function MeetingSpeakers({ recordingId, onChanged }: { recordingId: number; onChanged: () => void }) {
  const [speakers, setSpeakers] = useState<MeetingSpeaker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.meetingSpeakers(recordingId).then(setSpeakers, (e) => setError(errorMessage(e)));
  }, [recordingId]);

  async function rename(s: MeetingSpeaker) {
    const name = window.prompt(`Name for ${s.label}`, s.name ?? "");
    if (name === null) return;
    try {
      setSpeakers(await api.renameSpeaker(recordingId, s.label, name));
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!speakers?.length && !error) return null;
  return (
    <div className="speaker-chips" aria-label="Speakers">
      <span className="muted small">Speakers:</span>
      {speakers?.map((s) => (
        <button key={s.label} className="speaker-chip" onClick={() => void rename(s)} title={`Rename ${s.label}`}>
          <span className={`swatch bg-c${speakerSlot(s.label)}`} aria-hidden />
          {s.name || s.label}
        </button>
      ))}
      <ErrorText message={error} />
    </div>
  );
}
