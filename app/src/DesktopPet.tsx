// The desktop pet (window "pet", Super Admin only): a chubby blue whale that swims around the screen.
// - Eats a bowl of white rice (吃大白饭) whenever tokens are used: when an AI job in the main window ends, and when the
//   day's token count goes up (checked every 30 s, including Claude Code). It gets rounder as the day's tokens grow.
// - Shows what the main window is doing (headphones while recording, a thought bubble for other jobs).
// - Sleepy late at night, hungry around meal times; happy when clicked or petted (stroke the mouse back and forth).
// - Click: today's tokens in a bubble. Double-click: open My Assistant. Drag: move it (it rests a while). Right-click:
//   stay here / swim around, or put it away.
// - While you browse the web and no tokens have been used for a few minutes, it plays with the usage ball: swims
//   behind it and pushes it, and the ball rolls. Pushes go away from the cursor, and stop if the cursor comes near.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition, Window } from "@tauri-apps/api/window";
import { Whale, type Mood, type Prop } from "./components/Whale";
import { ImagePet } from "./components/ImagePet";
import { PackPet, type PackEvents, type PackState } from "./components/PackPet";
import { DEFAULT_REPOS, EXIT_IDLE_AFTER_MS, IDLE_MS, TOKEN_ACTIVE_MS } from "./lib/petRules";
import type { Activity, ActivityKind } from "./lib/activity";
import { api, configureApi, PROVIDERS, SOURCE_LABELS, USAGE_SOURCES, type UsageSource } from "./lib/api";
import { focusMain } from "./lib/ball";
import { claudeCodeEntries, claudeCodeTotals, type InOut } from "./lib/claudeCode";
import { formatCompact, toIsoDate } from "./lib/format";
import { feedAnnounced, feedToAnnounce, loadPack, loadSkin, petLook, petStays, savePetPosition, setPetEnabled, setPetStays, skinFacing, type LoadedPack, type PetLook, type PetSkin } from "./lib/pet";
import { getToken, loadSettings } from "./lib/settings";
import "./DesktopPet.css";

const POLL_MS = 30_000;
const EAT_MS = 4_500;
const EAT_EVERY_MS = 3 * 60_000; // token use seen by the 30 s check eats at most this often (AI jobs finishing always do)
const SPEED = 70; // logical px per second while swimming
const QUIET_MS = 3 * 60_000; // no tokens used for this long (while browsing): time to play with the ball
const AVOID = 260; // logical px: pushes keep the ball this far from the cursor
// The usage ball window (128 x 138, logical): its disc's centre and radius.
const BALL = { cx: 64, cy: 74, r: 58 };

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
  const [bubble, setBubble] = useState<"usage" | "menu" | "news" | null>(null);
  const [stay, setStay] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [skin, setSkin] = useState<PetSkin>({});
  const [imageFaces, setImageFaces] = useState<"left" | "right">("right");
  const [pack, setPack] = useState<LoadedPack | null>(null);
  const [look, setLook] = useState<PetLook>("auto");
  // Event counters for the animation pack (each bump plays that event's clip once; see lib/petRules.ts).
  const [events, setEvents] = useState<PackEvents>({ click: 0, pet: 0, tier: 0, exitIdle: 0, tokensDone: 0, committing: 0, committed: 0, reverted: 0 });
  const bump = (k: keyof PackEvents) => setEvents((e) => ({ ...e, [k]: e[k] + 1 }));
  // You: milliseconds since your last keyboard/mouse input, and whether you're typing (native signals).
  const [user, setUser] = useState({ idleMs: 0, typing: false });

  const win = getCurrentWindow();
  const lastTotal = useRef<number | null>(null);
  const restUntil = useRef(0);
  const hover = useRef(false);
  const pet = useRef<{ x: number; dir: number; flips: number; t: number }>({ x: 0, dir: 0, flips: 0, t: 0 });
  const press = useRef<{ x: number; y: number } | null>(null);
  const lastTokenAt = useRef(0);
  const lastMealAt = useRef(0);
  const acting = useRef(false); // the animation pack is playing a one-off clip: don't walk off mid-clip
  const shownRef = useRef<"pack" | "images" | "whale">("whale");
  const playOk = useRef(false);
  const [browsing, setBrowsing] = useState(false);

  const eat = useCallback(() => {
    lastTokenAt.current = Date.now();
    lastMealAt.current = Date.now();
    setEatingUntil(Date.now() + EAT_MS);
  }, []);

  // Your keyboard/mouse activity; coming back after a while away is an event.
  useEffect(() => {
    let prevIdle = 0;
    const unlisten = listen<{ idle_ms: number; typing: boolean }>("user-activity", (e) => {
      const { idle_ms, typing } = e.payload;
      if (prevIdle >= EXIT_IDLE_AFTER_MS && idle_ms < 3000) setEvents((ev) => ({ ...ev, exitIdle: ev.exitIdle + 1 }));
      prevIdle = idle_ms;
      setUser({ idleMs: idle_ms, typing });
    });
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // Git commits and reverts in the watched repositories.
  useEffect(() => {
    void invoke("pet_watch_repos", { repos: DEFAULT_REPOS }).catch(() => {});
    const unlisten = listen<{ action: "committing" | "committed" | "reverted" }>("git-activity", (e) =>
      setEvents((ev) => ({ ...ev, [e.payload.action]: ev[e.payload.action] + 1 })),
    );
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // Clock for moods and timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void petStays().then(setStay);
  }, []);

  // The Daily Feed arrived (the main window's 8:00 watcher): announce it.
  useEffect(() => {
    // Also on start: the announcement may have gone out before this window was listening.
    const announce = () =>
      void feedToAnnounce().then((yes) => {
        if (!yes) return;
        setBubble("news");
        setEvents((ev) => ({ ...ev, click: ev.click + 1 }));
      });
    announce();
    const unlisten = listen("feed-ready", () => window.setTimeout(announce, 500));
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // Click-through: the window is bigger than the character (room for whole animations), so outside her body (and
  // her bubble) clicks go to whatever is behind. The cursor is checked a dozen times a second.
  const hitBox = useRef({ w: 150, h: 128 });
  useEffect(() => {
    let ignoring: boolean | null = null;
    let scale = 1;
    void currentMonitor().then((m) => (scale = m?.scaleFactor || 1), () => {});
    const t = window.setInterval(async () => {
      try {
        const [c, p, s] = await Promise.all([cursorPosition(), win.outerPosition(), win.outerSize()]);
        const box = hitBox.current;
        const x = c.x - p.x;
        const y = c.y - p.y;
        const inBody = Math.abs(x - s.width / 2) <= (box.w / 2) * scale && y >= s.height - box.h * scale && y <= s.height;
        const inBubble = bubbleRef.current !== null && y < s.height - box.h * scale && x >= 0 && x <= s.width && y >= 0;
        const ignore = !(inBody || inBubble || press.current !== null);
        if (ignore !== ignoring) {
          ignoring = ignore;
          await win.setIgnoreCursorEvents(ignore);
        }
      } catch {
        // window closing
      }
    }, 80);
    return () => {
      window.clearInterval(t);
      void win.setIgnoreCursorEvents(false).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;

  // Is the app in front a web browser? (Reported by the native full-screen watcher.)
  useEffect(() => {
    void invoke<{ browser: boolean }>("foreground_app").then((f) => setBrowsing(f.browser), () => {});
    const unlisten = listen<{ browser: boolean }>("foreground-app", (e) => setBrowsing(e.payload.browser));
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
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
  shownRef.current = shown;
  // The part of the window that's her (logical px, at the bottom centre): clicks elsewhere pass through.
  hitBox.current = shown === "pack" ? { w: 190, h: 240 } : shown === "images" ? { w: 184, h: 200 } : { w: 150, h: 128 };

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
      if (lastTotal.current !== null && total > lastTotal.current) {
        lastTokenAt.current = Date.now();
        // The whale and image looks eat at most every few minutes; the animation pack eats while tokens flow.
        if (Date.now() - lastMealAt.current > EAT_EVERY_MS) eat();
      }
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
  const userIdle = user.idleMs >= IDLE_MS;
  const tokensActive = now - lastTokenAt.current < TOKEN_ACTIVE_MS;
  const packState: PackState = held
    ? "held"
    : moving
      ? "moving"
      : current
        ? "busy"
        : tokensActive
          ? "tokens"
          : user.typing
            ? "typing"
            : night && userIdle
              ? "sleepy"
              : userIdle
                ? "idle"
                : "active";
  // Token use stopping is an event ("finishing token usage").
  const wasTokens = useRef(false);
  useEffect(() => {
    if (wasTokens.current && !tokensActive) bump("tokensDone");
    wasTokens.current = tokensActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensActive]);
  const tierIndex = [100_000, 500_000, 1_000_000, 3_000_000, 10_000_000].filter((t) => total >= t).length;

  // Play with the ball: browsing, nothing running, no tokens for a while.
  playOk.current = browsing && !current && now - lastTokenAt.current > QUIET_MS && mood !== "sleepy";

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
      // The window is wider and taller than her: let its empty margins hang off-screen so she can reach the edges.
      const padX = Math.max(0, size.width / 2 - (hitBox.current.w / 2 + 10) * scale);
      const padTop = Math.max(0, size.height - (hitBox.current.h + 20) * scale);
      const minX = area.position.x - padX;
      const minY = area.position.y - padTop;
      const maxX = area.position.x + area.size.width - size.width + padX;
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

      const dist2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
      /** Distance from point p to the segment a-b. */
      const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
        const vx = bx - ax;
        const vy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
        return dist2(px, py, ax + t * vx, ay + t * vy);
      };

      /** One round of play: swim behind the ball, push it away from the cursor, let it roll to a stop. */
      const playWithBall = async () => {
        const ball = await Window.getByLabel("ball").catch(() => null);
        if (!ball || !(await ball.isVisible().catch(() => false))) return;
        const bpos = await ball.outerPosition();
        const bsize = await ball.outerSize();
        const avoid = AVOID * scale;
        const r = BALL.r * scale;
        let bx = bpos.x + BALL.cx * scale; // disc centre
        let by = bpos.y + BALL.cy * scale;
        const ballMin = { x: minX + BALL.cx * scale, y: minY + BALL.cy * scale };
        const ballMax = { x: area.position.x + area.size.width - bsize.width + BALL.cx * scale, y: area.position.y + area.size.height - bsize.height + BALL.cy * scale };
        let cursor = await cursorPosition().catch(() => null);
        if (cursor && dist2(cursor.x, cursor.y, bx, by) < avoid) return; // you're near it: leave it alone

        // A direction (mostly sideways, as a ball rolls) whose path stays furthest from the cursor.
        let best: { dx: number; dy: number; len: number; score: number } | null = null;
        for (let i = 0; i < 16; i++) {
          const a = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.9;
          const len = (220 + Math.random() * 300) * scale;
          const tx = clamp(bx + Math.cos(a) * len, ballMin.x, ballMax.x);
          const ty = clamp(by + Math.sin(a) * len, ballMin.y, ballMax.y);
          const real = dist2(bx, by, tx, ty);
          if (real < 90 * scale) continue;
          const score = cursor ? toSegment(cursor.x, cursor.y, bx, by, tx, ty) : 1e9;
          if (!best || score > best.score) best = { dx: (tx - bx) / real, dy: (ty - by) / real, len: real, score };
        }
        if (!best || best.score < avoid) return;
        const { dx, dy } = best;

        // Behind the ball: the pet's body (about the middle of its window, a little low) just short of the disc.
        const body = { x: size.width / 2, y: size.height - (hitBox.current.h / 2) * scale };
        const behind = (cx: number, cy: number) => ({
          x: clamp(cx - dx * (r + 62 * scale) - body.x, minX, maxX),
          y: clamp(cy - dy * (r + 30 * scale) - body.y + 16 * scale, minY, maxY),
        });
        const start = behind(bx, by);
        await swimTo(start.x, start.y);
        if (cancelled || !playOk.current) return;
        cursor = await cursorPosition().catch(() => null);
        if (cursor && toSegment(cursor.x, cursor.y, bx, by, bx + dx * best.len, by + dy * best.len) < avoid) return;

        // Push: the ball speeds up while pushed, then rolls on and slows; the roll angle follows the distance.
        setFacing(dx >= 0 ? 1 : -1);
        setMoving(true);
        let v = 0;
        let travelled = 0;
        let angle = 0;
        let brake = 1;
        let petV = 0;
        let cur = cursor;
        const watch = window.setInterval(() => {
          void cursorPosition().then((c) => (cur = c), () => {});
        }, 100);
        await new Promise<void>((resolve) => {
          let last = performance.now();
          const step = () => {
            if (cancelled) return resolve();
            const t = performance.now();
            const dt = Math.min(0.1, (t - last) / 1000);
            last = t;
            const contact = travelled < best!.len * 0.6 && brake === 1 && playOk.current;
            if (cur && dist2(cur.x, cur.y, bx, by) < avoid * 0.85) brake = 4; // the cursor came near: stop
            v = contact ? Math.min(230 * scale, v + 420 * scale * dt) : Math.max(0, v - 170 * scale * dt * brake);
            const stepLen = v * dt;
            const nx = clamp(bx + dx * stepLen, ballMin.x, ballMax.x);
            const ny = clamp(by + dy * stepLen, ballMin.y, ballMax.y);
            const moved = dist2(bx, by, nx, ny);
            if (moved < stepLen * 0.5) v = 0; // hit the edge of the screen
            bx = nx;
            by = ny;
            travelled += moved;
            angle += (moved / r) * (180 / Math.PI) * (dx >= 0 ? 1 : -1);
            void ball.setPosition(new PhysicalPosition(Math.round(bx - BALL.cx * scale), Math.round(by - BALL.cy * scale)));
            void emit("ball-roll", { angle });
            // The pet keeps up while pushing, then slows down behind the rolling ball.
            if (contact) {
              const p = behind(bx, by);
              pos = new PhysicalPosition(Math.round(p.x), Math.round(p.y));
              petV = v;
            } else {
              petV = Math.max(0, petV - 300 * scale * dt);
              pos = new PhysicalPosition(Math.round(clamp(pos.x + dx * petV * dt, minX, maxX)), Math.round(clamp(pos.y + dy * petV * dt, minY, maxY)));
            }
            void win.setPosition(pos);
            if (v <= 0 && !contact && petV <= 0) return resolve();
            timer = window.setTimeout(step, 33);
          };
          step();
        });
        window.clearInterval(watch);
        setMoving(false);
        void emit("ball-roll", { settle: true });
        void savePetPosition(pos.x, pos.y);
      };

      while (!cancelled) {
        // The animation pack has plenty to do in place, so it rests longer between walks.
        const rest = shownRef.current === "pack" ? 12000 + Math.random() * 18000 : 3000 + Math.random() * 8000;
        const wait = Math.max(restUntil.current - Date.now(), playOk.current ? 2500 + Math.random() * 4000 : rest);
        setMoving(false);
        await new Promise((r) => (timer = window.setTimeout(r, wait)));
        // Let a clip that's playing finish before walking off.
        while (!cancelled && acting.current) await new Promise((r) => (timer = window.setTimeout(r, 500)));
        if (cancelled) break;
        if (playOk.current && Math.random() < 0.8) {
          await playWithBall().catch(() => {});
          continue;
        }
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
      void emit("ball-roll", { settle: true }); // interrupted mid-roll: the ball eases back upright
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
      {bubble === "news" && (
        <div className="pet-bubble pet-news">
          <strong>Your Daily Feed is ready</strong>
          <span className="pet-sub">Today's top stories on your topics</span>
          <button
            onClick={() => {
              setBubble(null);
              void feedAnnounced();
              void emit("open-page", { page: "feed" });
              void focusMain();
            }}
          >
            Open Daily Feed
          </button>
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
          <PackPet pack={pack.pack} base={pack.url} state={packState} activity={current?.kind ?? null} facing={facing} events={events} tierIndex={tierIndex} idleMin={user.idleMs / 60_000} onActing={(a) => (acting.current = a)} />
        ) : shown === "images" ? (
          <ImagePet skin={skin} mood={mood} prop={prop} flip={(facing === 1) !== (imageFaces === "right")} />
        ) : (
          <Whale mood={mood} prop={prop} facing={facing} fullness={fullness} />
        )}
      </div>
    </div>
  );
}
