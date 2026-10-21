// The desktop usage ball (window "ball"): tokens used today and this month, one item at a time, switching every
// 6 seconds: the three API providers (from the server) and Claude Code (from its local logs, via a Rust command). While the main window is busy (recording, translating, importing…) the ball splits: the top half
// shows that activity with an icon and a timer, the bottom half keeps the usage. Drag it anywhere; double-click to
// bring up the main window. Usage is owner-only on the server.
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Activity, ActivityKind } from "./lib/activity";
import { api, configureApi, PROVIDERS, SOURCE_LABELS, USAGE_SOURCES, type UsageRow, type UsageSource } from "./lib/api";
import { claudeCodeEntries, claudeCodeTotals as totalsOf, type InOut } from "./lib/claudeCode";
import { focusMain, saveBallPosition } from "./lib/ball";
import { formatCompact, formatInteger, toIsoDate } from "./lib/format";
import { getToken, loadSettings } from "./lib/settings";
import "./UsageBall.css";
import { t } from "./lib/i18n";
import { useCompanionSize } from "./lib/companionSize";

const ROTATE_MS = 6000;
const REFRESH_MS = 2 * 60 * 1000;

/** What the ball rotates through: the API providers, then Claude Code. */
type Item = UsageSource;
const ITEMS = USAGE_SOURCES;
const ITEM_LABELS = SOURCE_LABELS;
type Totals = Record<Item, { today: InOut; month: InOut } | null>; // null: couldn't be read

/** Claude Code tokens today and this month (local time), from its local logs. */
async function claudeCodeTotals(): Promise<{ today: InOut; month: InOut } | null> {
  const entries = await claudeCodeEntries(40);
  return entries && totalsOf(entries);
}

const svg = (children: ReactElement | ReactElement[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const ICONS: Record<ActivityKind, ReactElement> = {
  recording: svg([<rect key="a" x="9" y="2" width="6" height="12" rx="3" />, <path key="b" d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />]),
  saving: svg([<path key="a" d="M12 3v12M7 10l5 5 5-5" />, <path key="b" d="M5 21h14" />]),
  transcribing: svg(<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2M21 12h0" />),
  translating: svg([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />]),
  syncing: svg(<path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" />),
  uploading: svg([<path key="a" d="M12 21V9M7 14l5-5 5 5" />, <path key="b" d="M5 3h14" />]),
  importing: svg([<path key="a" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />, <path key="b" d="M14 3v5h5M12 11v6M9 14l3 3 3-3" />]),
  planning: svg(<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />),
  // A pencil writing: learning from your transcript edits.
  learning: svg([<path key="a" d="M4 20h4L19 9l-4-4L4 16z" />, <path key="b" d="M13.5 6.5l4 4" />]),
};

/** "0:07", "12:34", "1:02:03" */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const tokens = (rows: UsageRow[], p: UsageSource): InOut =>
  rows.filter((r) => r.provider === p).reduce((n, r) => ({ input: n.input + r.input_tokens, output: n.output + r.output_tokens }), { input: 0, output: 0 });

/** Input as a green down arrow, output as a red up arrow. */
const ARROWS = {
  input: svg(<path d="M12 4v15M6 13l6 6 6-6" />),
  output: svg(<path d="M12 20V5M6 11l6-6 6 6" />),
};

/** Today's input and output, one row each (or side by side when `inline`). */
function InOutRows({ v, inline = false }: { v: InOut | undefined; inline?: boolean }) {
  return (
    <span className={`ball-io${inline ? " inline" : ""}`} data-tauri-drag-region>
      {(["input", "output"] as const).map((k) => (
        <span key={k} className={`ball-io-row io-${k}`} data-tauri-drag-region aria-label={k === "input" ? "input" : "output"}>
          <span className="ball-arrow" data-tauri-drag-region>
            {ARROWS[k]}
          </span>
          <span className="ball-io-value" data-tauri-drag-region>
            {v ? formatCompact(v[k]) : "—"}
          </span>
        </span>
      ))}
    </span>
  );
}

export default function UsageBall() {
  useCompanionSize("ball"); // sized to the screen and your setting
  const [totals, setTotals] = useState<Totals | null>(null);
  const [index, setIndex] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  // Rolling: the desktop pet pushes the ball around and sends its angle; "settle" eases it back upright.
  const [roll, setRoll] = useState<{ angle: number; settling: boolean }>({ angle: 0, settling: false });

  useEffect(() => {
    const unlisten = listen<{ angle?: number; settle?: boolean }>("ball-roll", (e) => {
      if (e.payload.settle) setRoll((r) => ({ angle: Math.round(r.angle / 360) * 360, settling: true }));
      else if (typeof e.payload.angle === "number") setRoll({ angle: e.payload.angle, settling: false });
    });
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
  const rollStyle = roll.angle ? { transform: `rotate(${roll.angle}deg)`, transition: roll.settling ? "transform 700ms ease-out, border-color 400ms ease" : "border-color 400ms ease" } : undefined;
  const [now, setNow] = useState(Date.now());

  // What the main window is doing; ask once on opening, then follow its broadcasts.
  useEffect(() => {
    const unlisten = listen<Activity[]>("activity", (e) => setActivities(e.payload));
    void unlisten.then(() => emit("activity-request")).catch(() => {});
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
  // Tick the activity timer.
  useEffect(() => {
    if (!activities.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activities.length]);

  const load = useCallback(async () => {
    try {
      const settings = await loadSettings();
      const token = await getToken();
      if (!token) {
        setProblem(t("Sign in"));
        return;
      }
      configureApi({ baseUrl: settings.serverUrl, token, onUnauthorized: () => setProblem(t("Sign in")) });
      const now = new Date();
      const today = toIsoDate(now);
      const monthStart = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
      const [day, month, cc] = await Promise.all([api.usageSummary(today, today, "day"), api.usageSummary(monthStart, today, "month"), claudeCodeTotals()]);
      const next = { claude_code: cc } as Totals;
      for (const p of PROVIDERS) next[p] = { today: tokens(day.rows, p), month: tokens(month.rows, p) };
      setTotals(next);
      setProblem(null);
    } catch {
      setProblem(t("Offline"));
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => void load(), REFRESH_MS);
    const rotate = setInterval(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => {
      clearInterval(refresh);
      clearInterval(rotate);
    };
  }, [load]);

  // Remember where it was dragged to.
  useEffect(() => {
    const unlisten = getCurrentWindow().onMoved(({ payload }) => void saveBallPosition(payload.x, payload.y));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const provider = ITEMS[index % ITEMS.length];
  const tot = totals?.[provider];
  const current = activities.length ? activities.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)) : null;

  const title = current
    ? `${activities.map((a) => `${a.label} (${elapsed(now - a.startedAt)})`).join("\n")}\n${t("Double-click to open My Assistant")}`
    : totals
      ? ITEMS.map((p) => {
          const x = totals[p];
          return `${t(ITEM_LABELS[p])}: ${
            x
              ? t("today {input} in / {output} out, this month {input2} in / {output2} out", { input: formatInteger(x.today.input), output: formatInteger(x.today.output), input2: formatInteger(x.month.input), output2: formatInteger(x.month.output) })
              : t("not available")
          }`;
        }).join("\n") + "\n" + t("Double-click to open My Assistant")
      : t("Double-click to open My Assistant");

  // The provider's name is a ribbon across the top of the disc; the disc holds the numbers.
  return (
    <div className={`ball-frame ball-${provider}`} data-tauri-drag-region onDoubleClick={() => void focusMain()} title={title}>
      {!problem && (
        <div className="ball-banner" key={provider} data-tauri-drag-region>
          {ITEM_LABELS[provider]}
        </div>
      )}
      {current && !problem ? (
        <div className="ball ball-split" data-tauri-drag-region style={rollStyle}>
          <div className={`ball-activity act-${current.kind}`} key={current.id} data-tauri-drag-region>
            <span className="ball-icon" data-tauri-drag-region>
              {ICONS[current.kind]}
            </span>
            <span className="ball-act-label" data-tauri-drag-region>
              {current.label}
              {activities.length > 1 && <span className="ball-more"> +{activities.length - 1}</span>}
            </span>
            <span className="ball-act-time" data-tauri-drag-region>
              {elapsed(now - current.startedAt)}
            </span>
          </div>
          <span className="ball-divider" data-tauri-drag-region />
          <div className="ball-usage" key={provider} data-tauri-drag-region>
            {totals ? <InOutRows v={tot?.today} inline /> : <span className="ball-value small">…</span>}
          </div>
        </div>
      ) : (
        <div className="ball" data-tauri-drag-region style={rollStyle}>
          {problem ? (
            <span className="ball-problem" data-tauri-drag-region>
              {problem}
            </span>
          ) : (
            <div className="ball-body" key={provider} data-tauri-drag-region>
              {totals ? <InOutRows v={tot?.today} /> : <span className="ball-value">…</span>}
              {tot && (
                <span className="ball-month" data-tauri-drag-region>{t("{compact} this month", { compact: formatCompact(tot.month.input + tot.month.output) })}</span>
              )}
            </div>
          )}
          <span className="ball-dots" data-tauri-drag-region>
            {ITEMS.map((p) => (
              <i key={p} className={p === provider ? "on" : ""} />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
