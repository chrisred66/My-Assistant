// The Daily Feed's day selector: the latest days as buttons, as many as fit; when they don't all fit, a calendar button
// opens a month view of every day that has a feed.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LOCALE } from "../lib/format";
import { t, useLang } from "../lib/i18n";

const GAP = 2; // .segmented gap
const CALENDAR_BUTTON = 52; // room kept for the calendar button

export default function DayPicker({
  dates, // newest first, "YYYY-MM-DD"
  shown,
  label,
  onPick,
}: {
  dates: string[];
  shown: string;
  label: (d: string) => string;
  onPick: (d: string) => void;
}) {
  const lang = useLang();
  const barRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [widths, setWidths] = useState<number[] | null>(null);
  const [room, setRoom] = useState(Infinity);
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null); // where the month view opens
  const chips = dates.slice(0, 14);

  // Measure every chip once (all rendered), then lay out from the cached widths as the width changes.
  useLayoutEffect(() => setWidths(null), [chips.join(), lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (widths === null) setWidths(chips.map((_, i) => chipRefs.current[i]?.offsetWidth ?? 0));
  });
  useEffect(() => {
    const el = barRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let fit = chips.length;
  if (widths) {
    const total = widths.reduce((s, w) => s + w + GAP, 6);
    if (total > room || dates.length > chips.length) {
      fit = 0;
      let used = 6 + CALENDAR_BUTTON;
      while (fit < widths.length && used + widths[fit] + GAP <= room) used += widths[fit++] + GAP;
      fit = Math.max(1, fit);
    }
  }
  const needCalendar = widths !== null && fit < dates.length;
  const hiddenShown = needCalendar && !chips.slice(0, fit).includes(shown);

  return (
    <div className="day-picker" ref={barRef}>
      <div className="segmented" role="tablist" aria-label={t("Day")}>
        {chips.map((d, i) =>
          widths !== null && i >= fit ? null : (
            <button
              key={d}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              role="tab"
              aria-selected={d === shown}
              className={d === shown ? "on" : ""}
              onClick={() => onPick(d)}
            >
              {label(d)}
            </button>
          ),
        )}
        {needCalendar && (
          <button
            className={`day-picker-cal${hiddenShown ? " on" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open !== null}
            title={t("Choose a day")}
            aria-label={t("Choose a day")}
            onClick={(e) => {
              // Under the button, kept on screen. Fixed and outside the header, whose clip-path would cut it off.
              const r = e.currentTarget.getBoundingClientRect();
              setOpen((o) => (o ? null : { top: r.bottom + 6, left: Math.max(16, Math.min(r.right - 280, window.innerWidth - 296)) }));
            }}
          >
            {hiddenShown ? `📅 ${label(shown)}` : "📅"}
          </button>
        )}
      </div>
      {open &&
        createPortal(
          <Calendar
            at={open}
            dates={new Set(dates)}
            shown={shown}
            onPick={(d) => {
              setOpen(null);
              onPick(d);
            }}
            onClose={() => setOpen(null)}
          />,
          document.body,
        )}
    </div>
  );
}

/** A month view where only the days in `dates` can be chosen. */
function Calendar({
  at,
  dates,
  shown,
  onPick,
  onClose,
}: {
  at: { top: number; left: number };
  dates: Set<string>;
  shown: string;
  onPick: (d: string) => void;
  onClose: () => void;
}) {
  const sorted = [...dates].sort();
  const first = sorted[0] ?? shown;
  const last = sorted[sorted.length - 1] ?? shown;
  const [month, setMonth] = useState((shown || last).slice(0, 7)); // "YYYY-MM"
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.(".day-picker-cal")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    const scrolled = (e: Event) => !ref.current?.contains(e.target as Node) && onClose(); // it's fixed: the page moved away
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const lead = (start.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = (d: number) => `${month}-${String(d).padStart(2, "0")}`;
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(LOCALE, { weekday: "narrow", timeZone: "UTC" }),
  );

  return (
    <div className="calendar card" role="dialog" aria-label={t("Choose a day")} ref={ref} style={{ top: at.top, left: at.left }}>
      <div className="row space-between">
        <button className="small-btn" onClick={() => shift(-1)} disabled={month <= first.slice(0, 7)} aria-label={t("Previous month")}>
          ‹
        </button>
        <strong>{start.toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" })}</strong>
        <button className="small-btn" onClick={() => shift(1)} disabled={month >= last.slice(0, 7)} aria-label={t("Next month")}>
          ›
        </button>
      </div>
      <div className="calendar-grid">
        {weekdays.map((w, i) => (
          <span key={`w${i}`} className="calendar-weekday">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`l${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = iso(i + 1);
          const has = dates.has(d);
          return (
            <button key={d} className={`calendar-day${d === shown ? " on" : ""}`} disabled={!has} onClick={() => onPick(d)}>
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
