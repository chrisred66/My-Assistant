// General Tool: Translate, Recordings and Transcripts as one tab. Sub-pages stay mounted once opened, so a live
// recording keeps going while you look at Transcripts.
import { useEffect, useState } from "react";
import { api, type User } from "../lib/api";
import { formatInteger } from "../lib/format";
import Recordings from "./Recordings";
import Transcripts from "./Transcripts";
import Translate from "./Translate";
import { t } from "../lib/i18n";

export type LanguageTab = "translate" | "recordings" | "transcripts";

const TABS: { id: LanguageTab; label: string; description: string }[] = [
  {
    id: "recordings",
    label: "Recordings",
    description: "Speak and watch the transcript appear. Anything in another language is translated into yours (or the one you choose) as you go. The recording is saved when you stop.",
  },
  { id: "translate", label: "Translate", description: "Text in any language, translated by AI into yours (or the one you choose). Your translations are listed below the form, where you can edit or delete them." },
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
  const parts = [t("{used} of {limit} words translated", { used: formatInteger(a.words.used), limit: formatInteger(a.words.limit) })];
  if (a.transcribe_minutes.limit) {
    parts.push(t("{used} of {limit} minutes transcribed", { used: a.transcribe_minutes.used, limit: a.transcribe_minutes.limit }));
  }
  return (
    <p className="small">
      {t("Today: {parts}. Resets at midnight.", { parts: parts.join(" · ") })}
      {free && " " + t("Free plan: recordings are saved as audio only; transcription is on the paid plan.")}
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
          <h1>{t("General Tool")}</h1>
        </header>
        <div className="segmented" role="tablist" aria-label={t("General Tool")}>
          {TABS.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? "on" : ""} onClick={() => choose(item.id)}>
              {t(item.label)}
            </button>
          ))}
        </div>
        <p className="muted small">{t(current.description)}</p>
        <AllowanceLine free={!canTranscribe} />
      </div>
      {opened.has("recordings") && <div hidden={tab !== "recordings"}><Recordings canTranscribe={canTranscribe} /></div>}
      {opened.has("translate") && <div hidden={tab !== "translate"}><Translate /></div>}
      {/* Remounted on each visit so the list includes what was just saved. */}
      {tab === "transcripts" && <Transcripts canTranscribe={canTranscribe} />}
    </section>
  );
}
