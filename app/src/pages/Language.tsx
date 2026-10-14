// General Tool: Translate, Recordings and Transcripts as one tab. Sub-pages stay mounted once opened, so a live
// recording keeps going while you look at Transcripts.
import { useEffect, useState } from "react";
import { api, type User } from "../lib/api";
import Recordings from "./Recordings";
import Transcripts from "./Transcripts";
import Translate from "./Translate";

export type LanguageTab = "translate" | "recordings" | "transcripts";

const TABS: { id: LanguageTab; label: string; description: string }[] = [
  {
    id: "recordings",
    label: "Recordings",
    description: "Speak and watch the transcript appear. Anything not in English is translated as you go. The recording is saved when you stop.",
  },
  { id: "translate", label: "Translate", description: "Arabic text to English, translated by AI. Your translations are listed below the form, where you can edit or delete them." },
  { id: "transcripts", label: "Transcripts", description: "Your latest 200 transcripts, from recordings and typed text. Edit or delete any of them; corrections to recordings' transcripts are learned from." },
];

/** Today's allowances, refreshed every 30 s and when the page is focused (they change as you translate and transcribe). */
function AllowanceLine({ free }: { free: boolean }) {
  const [a, setA] = useState<User["access"]["allowance"]>(null);
  useEffect(() => {
    const load = () => api.me().then((u) => setA(u.access.allowance), () => undefined);
    load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  if (!a || a.words.limit === null) return null;
  const parts = [`${a.words.used.toLocaleString()} of ${a.words.limit.toLocaleString()} words translated`];
  if (a.transcribe_minutes.limit) parts.push(`${a.transcribe_minutes.used} of ${a.transcribe_minutes.limit} minutes transcribed`);
  return (
    <p className="small">
      Today: {parts.join(" · ")}. Resets at midnight.
      {free && " Free plan: recordings are saved as audio only; transcription is on the paid plan."}
    </p>
  );
}

export default function Language({
  tab,
  onTab,
  canTranscribe = true,
}: {
  tab: LanguageTab;
  onTab: (t: LanguageTab) => void;
  canTranscribe?: boolean;
}) {
  const [opened, setOpened] = useState<Set<LanguageTab>>(() => new Set([tab]));

  function choose(t: LanguageTab) {
    setOpened((s) => (s.has(t) ? s : new Set(s).add(t)));
    onTab(t);
  }

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <section className="page">
      <div className="sticky-head">
        <header className="page-header">
          <h1>General Tool</h1>
        </header>
        <div className="segmented" role="tablist" aria-label="General Tool">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => choose(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted small">{current.description}</p>
        <AllowanceLine free={!canTranscribe} />
      </div>
      {opened.has("recordings") && <div hidden={tab !== "recordings"}><Recordings canTranscribe={canTranscribe} /></div>}
      {opened.has("translate") && <div hidden={tab !== "translate"}><Translate /></div>}
      {/* Remounted on each visit so the list includes what was just saved. */}
      {tab === "transcripts" && <Transcripts canTranscribe={canTranscribe} />}
    </section>
  );
}
