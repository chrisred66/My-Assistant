// The desktop pet (window "pet", Super Admin only): a chubby blue whale that swims around the screen.
// - Eats a bowl of white rice (吃大白饭) whenever tokens are used: when an AI job in the main window ends, and when the
//   day's token count goes up (checked every 30 s, including Claude Code). It gets rounder as the day's tokens grow.
// - Shows what the main window is doing (headphones while recording, a thought bubble for other jobs).
// - Sleepy late at night, hungry around meal times; happy when clicked or petted (stroke the mouse back and forth).
// - Click: today's tokens in a bubble. Double-click: open My Assistant. Drag: move it (it rests a while). Right-click:
//   stay here / swim around, or put it away.
import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { Whale, type Mood, type Prop } from "./components/Whale";
import { ImagePet } from "./components/ImagePet";
import { PackPet, type PackState } from "./components/PackPet";
import type { Activity, ActivityKind } from "./lib/activity";
import { api, configureApi, PROVIDERS, SOURCE_LABELS, USAGE_SOURCES, type UsageSource } from "./lib/api";
import { focusMain } from "./lib/ball";
import { claudeCodeEntries, claudeCodeTotals, type InOut } from "./lib/claudeCode";
import { formatCompact, toIsoDate } from "./lib/format";
import { loadPack, loadSkin, petLook, petStays, savePetPosition, setPetEnabled, setPetStays, skinFacing, type LoadedPack, type PetLook, type PetSkin } from "./lib/pet";
import { getToken, loadSettings } from "./lib/settings";
import "./DesktopPet.css";

const POLL_MS = 30_000;
const EAT_MS = 4_500;
const SPEED = 70; // logical px per second while swimming

const PROPS: Record<ActivityKind, Prop> = {
  recording: "headphones",
  transcribing: "headphones",
  saving: "box",
  uploading: "box",
  importing: "box",
  translating: "translate",
  learning: "pencil",
  syncing: "gear",
  planning: "sparkle",
};
/** Jobs that spend tokens: the pet eats when they finish. */
const AI_KINDS: ActivityKind[] = ["transcribing", "translating", "learning", "planning", "recording"];

type Today = Partial<Record<UsageSource, InOut>>;

export default function DesktopPet() {
  const [facing, setFacing] = useState<1 | -1>(1);
  const [moving, setMoving] = useState(false);
  const [eatingUntil, setEatingUntil] = useState(0);
  const [happyUntil, setHappyUntil] = useState(0);
  const [held, setHeld] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const [bubble, setBubble] = useState<"usage" | "menu" | null>(null);
  const [stay, setStay] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [skin, setSkin] = useState<PetSkin>({});
  const [imageFaces, setImageFaces] = useState<"left" | "right">("right");
  const [pack, setPack] = useState<LoadedPack | null>(null);
  const [look, setLook] = useState<PetLook>("auto");
  // Event counters for the animation pack (each bump plays that event's clip once).
  const [events, setEvents] = useState({ click: 0, pet: 0, eat: 0, tier: 0 });
  const bump = (k: "click" | "pet" | "eat" | "tier") => setEvents((e) => ({ ...e, [k]: e[k] + 1 }));

  const win = getCurrentWindow();
  const lastTotal = useRef<number | null>(null);
  const restUntil = useRef(0);
  const hover = useRef(false);
  const pet = useRef<{ x: number; dir: number; flips: number; t: number }>({ x: 0, dir: 0, flips: 0, t: 0 });
  const press = useRef<{ x: number; y: number } | null>(null);

  const eat = useCallback(() => {
    setEatingUntil(Date.now() + EAT_MS);
    setEvents((e) => ({ ...e, eat: e.eat + 1 }));
  }, []);

  // Clock for moods and timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void petStays().then(setStay);
  }, []);

  // Your own images, if set (Settings → Desktop pet); reloaded when they change there.
  useEffect(() => {
    const reload = () => {
      void loadSkin().then(setSkin);
      void skinFacing().then(setImageFaces);
      void loadPack().then(setPack);
      void petLook().then(setLook);
    };
    reload();
    const unlisten = listen("pet-skin-changed", reload);
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
  const hasSkin = Object.keys(skin).length > 0;
  // Which look: chosen in Settings, or the best available.
  const shown: "pack" | "images" | "whale" =
    look === "pack" && pack ? "pack" : look === "images" && hasSkin ? "images" : look === "whale" ? "whale" : pack ? "pack" : hasSkin ? "images" : "whale";

  // What the main window is doing; eat when an AI job finishes.
  useEffect(() => {
    let previous: Activity[] = [];
    const unlisten = listen<Activity[]>("activity", (e) => {
      const ended = previous.filter((a) => !e.payload.some((b) => b.id === a.id));
      if (ended.some((a) => AI_KINDS.includes(a.kind))) eat();
      previous = e.payload;
      setActivities(e.payload);
    });
    void unlisten.then(() => emit("activity-request")).catch(() => {});
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, [eat]);

  // Today's tokens (server providers + Claude Code); eat when the total goes up.
  const load = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) return;
      configureApi({ baseUrl: (await loadSettings()).serverUrl, token });
      const day = toIsoDate(new Date());
      const [summary, cc] = await Promise.all([api.usageSummary(day, day, "day"), claudeCodeEntries(1)]);
      const t: Today = {};
      for (const p of PROVIDERS) {
        const rows = summary.rows.filter((r) => r.provider === p);
        if (rows.length) t[p] = { input: rows.reduce((n, r) => n + r.input_tokens, 0), output: rows.reduce((n, r) => n + r.output_tokens, 0) };
      }
      if (cc) t.claude_code = claudeCodeTotals(cc).today;
      const total = Object.values(t).reduce((n, v) => n + (v?.input ?? 0) + (v?.output ?? 0), 0);
      if (lastTotal.current !== null && total > lastTotal.current) eat();
      lastTotal.current = total;
      setToday(t);
    } catch {
      // offline or signed out: the pet just keeps swimming
    }
  }, [eat]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // ---- mood ----------------------------------------------------------------------------------------------------
  const current = activities.length ? activities.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)) : null;
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  const eating = now < eatingUntil;
  const night = hour >= 23 || hour < 6;
  const mealTime = (hour >= 11.5 && hour < 13.5) || (hour >= 17.5 && hour < 19.5);
  const justAte = now - eatingUntil < 20 * 60_000;
  const mood: Mood = held
    ? "held"
    : eating
      ? "eating"
      : now < happyUntil
        ? "happy"
        : current
          ? "busy"
          : night
            ? "sleepy"
            : mealTime && !justAte
              ? "hungry"
              : moving
                ? "swim"
                : "idle";
  const prop: Prop = current ? PROPS[current.kind] : null;
  const total = today ? Object.values(today).reduce((n, v) => n + (v?.input ?? 0) + (v?.output ?? 0), 0) : 0;
  const fullness = Math.min(1, Math.log10(1 + total / 20_000) / 2.5); // ~1m tokens: about 70% rounder-ness

  // The animation pack's state loop, and the token tier for its "balance" clips.
  const packState: PackState = held ? "held" : moving ? "moving" : current ? "busy" : night ? "sleepy" : mealTime && !justAte ? "hungry" : "idle";
  const tierIndex = [100_000, 500_000, 1_000_000, 3_000_000, 10_000_000].filter((t) => total >= t).length;

  // ---- roaming ---------------------------------------------------------------------------------------------------
  const canRoam = !stay && !held && !eating && mood !== "sleepy" && bubble === null;
  useEffect(() => {
    if (!canRoam) {
      setMoving(false);
      return;
    }
    let cancelled = false;
    let timer = 0;
    (async () => {
      const monitor = await currentMonitor().catch(() => null);
      if (!monitor || cancelled) return;
      const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
      const scale = monitor.scaleFactor || 1;
      const size = await win.outerSize();
      let pos = await win.outerPosition();
      const minX = area.position.x;
      const minY = area.position.y;
      const maxX = area.position.x + area.size.width - size.width;
      const maxY = area.position.y + area.size.height - size.height;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

      const swimTo = (tx: number, ty: number) =>
        new Promise<void>((resolve) => {
          let last = performance.now();
          const step = () => {
            if (cancelled) return resolve();
            if (hover.current) {
              setMoving(false);
              last = performance.now();
              timer = window.setTimeout(step, 200); // holds still under the cursor
              return;
            }
            const t = performance.now();
            const dt = Math.min(0.1, (t - last) / 1000);
            last = t;
            const dx = tx - pos.x;
            const dy = ty - pos.y;
            const dist = Math.hypot(dx, dy);
            const v = SPEED * scale * dt * (mood === "busy" || mood === "hungry" ? 0.5 : 1);
            if (dist <= v) {
              pos = new PhysicalPosition(Math.round(tx), Math.round(ty));
              void win.setPosition(pos);
              return resolve();
            }
            // A gentle wave on the way.
            const wobble = Math.sin(t / 380) * 0.6 * scale;
            pos = new PhysicalPosition(Math.round(pos.x + (dx / dist) * v), Math.round(pos.y + (dy / dist) * v + wobble));
            setFacing(dx >= 0 ? 1 : -1);
            setMoving(true);
            void win.setPosition(pos);
            timer = window.setTimeout(step, 33);
          };
          step();
        });

      while (!cancelled) {
        const wait = Math.max(restUntil.current - Date.now(), 3000 + Math.random() * 8000);
        setMoving(false);
        await new Promise((r) => (timer = window.setTimeout(r, wait)));
        if (cancelled) break;
        pos = await win.outerPosition();
        // Mostly short trips nearby, sometimes across the screen.
        const far = Math.random() < 0.25;
        const reach = (far ? 900 : 320) * scale;
        const tx = clamp(pos.x + (Math.random() - 0.5) * 2 * reach, minX, maxX);
        const ty = clamp(pos.y + (Math.random() - 0.5) * reach, minY, maxY);
        await swimTo(tx, ty);
        if (!cancelled) void savePetPosition(Math.round(tx), Math.round(ty));
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // mood changes only adjust speed; restarting the loop for them would make it stutter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRoam]);

  // ---- pointer: click, drag, petting ------------------------------------------------------------------------------
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    press.current = { x: e.screenX, y: e.screenY };
  }

  function onPointerMove(e: React.PointerEvent) {
    // Dragging: past a few pixels with the button down.
    if (press.current && e.buttons & 1 && Math.hypot(e.screenX - press.current.x, e.screenY - press.current.y) > 5) {
      press.current = null;
      setHeld(true);
      setBubble(null);
      void win.startDragging().finally(async () => {
        setHeld(false);
        restUntil.current = Date.now() + 20_000; // rests where it was put
        const p = await win.outerPosition();
        void savePetPosition(p.x, p.y);
      });
      return;
    }
    // Petting: the cursor stroking back and forth over it.
    const s = pet.current;
    const dir = Math.sign(e.screenX - s.x);
    if (dir !== 0 && dir !== s.dir) {
      if (Date.now() - s.t > 1500) s.flips = 0;
      s.flips++;
      s.t = Date.now();
      s.dir = dir;
      if (s.flips >= 5) {
        setHappyUntil(Date.now() + 2500);
        bump("pet");
        s.flips = 0;
      }
    }
    s.x = e.screenX;
  }

  function onPointerUp() {
    if (!press.current) return;
    press.current = null;
    setHappyUntil(Date.now() + 1200);
    // Opening today's numbers plays the token-tier clip; closing it, a click reaction.
    bump(bubble === "usage" ? "click" : "tier");
    setBubble((b) => (b === "usage" ? null : "usage"));
  }

  async function toggleStay() {
    const next = !stay;
    setStay(next);
    setBubble(null);
    await setPetStays(next);
  }

  const items = USAGE_SOURCES.filter((p) => today?.[p] && (today[p]!.input || today[p]!.output));

  return (
    <div
      className="pet"
      onMouseEnter={() => (hover.current = true)}
      onMouseLeave={() => {
        hover.current = false;
        pet.current.flips = 0;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setBubble((b) => (b === "menu" ? null : "menu"));
      }}
    >
      {bubble === "usage" && (
        <div className="pet-bubble" onClick={() => setBubble(null)}>
          <strong>{today ? `${formatCompact(total)} tokens` : "…"}</strong>
          <span className="pet-sub">of rice eaten today</span>
          {items.map((p) => (
            <span key={p} className="pet-row">
              <i className={`pet-dot dot-${p}`} />
              {SOURCE_LABELS[p]}
              <span className="pet-io">
                <b className="in">↓</b>
                {formatCompact(today![p]!.input)} <b className="out">↑</b>
                {formatCompact(today![p]!.output)}
              </span>
            </span>
          ))}
          {current && <span className="pet-sub">Busy: {current.label}</span>}
        </div>
      )}
      {bubble === "menu" && (
        <div className="pet-bubble pet-menu">
          <button onClick={() => void toggleStay()}>{stay ? "Swim around" : "Stay here"}</button>
          <button onClick={() => void focusMain()}>Open My Assistant</button>
          <button onClick={() => void setPetEnabled(false)}>Put the pet away</button>
          {shown === "pack" && pack && <span className="pet-sub pet-credit">Animations: {pack.pack.link.replace(/^https:\/\//, "")}</span>}
        </div>
      )}
      <div
        className={`pet-body${shown === "images" ? " image" : shown === "pack" ? " pack" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => void focusMain()}
        title={current ? `${current.label}…` : mood === "sleepy" ? "Sleeping" : mood === "hungry" ? "Hungry" : "Click for today's tokens"}
      >
        {shown === "pack" && pack ? (
          <PackPet pack={pack.pack} base={pack.url} state={packState} activity={current?.kind ?? null} facing={facing} events={events} tierIndex={tierIndex} />
        ) : shown === "images" ? (
          <ImagePet skin={skin} mood={mood} prop={prop} flip={(facing === 1) !== (imageFaces === "right")} />
        ) : (
          <Whale mood={mood} prop={prop} facing={facing} fullness={fullness} />
        )}
      </div>
    </div>
  );
}
