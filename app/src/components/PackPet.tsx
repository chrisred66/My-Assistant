// The desktop pet as an animation pack: transparent WebM clips (VP9 with alpha) directed by the rules in
// lib/petRules.ts. Each situation has a loop (idle breathing, dragged, running, asleep) or a chain (one clip after
// another: working, eating while tokens are used, typing); events play a one-off on top (coming back from idle,
// token use finishing, git commits and reverts, clicks, the token-tier clip), with follow-ups queued after them.
// Two video elements swap, so changing clips doesn't flicker. The pack lives in the app data folder
// (pet-pack/pack.json + clips) and is played over the asset protocol.
import { useEffect, useRef, useState } from "react";
import type { ActivityKind } from "../lib/activity";
import {
  EXIT_IDLE,
  FOLLOW,
  GIT,
  IDLE,
  MORNING,
  MORNING_AFTER,
  pickRule,
  SLEEP,
  TOKENS,
  TOKENS_DONE,
  TYPING,
  WORK,
} from "../lib/petRules";

export interface Pack {
  name: string;
  credit: string;
  link: string;
  idle: string;
  look: string;
  random: { weight: number; clips: string[]; seasonal?: boolean; noMirror?: boolean }[];
  seasons: Record<string, number[]>;
  click: string[];
  drag: string;
  walk: string[];
  runLeft: string;
  eat: string[];
  meals: { breakfast: string; lunch: string; dinner: string };
  hungry: string;
  sleep: string;
  sleepAlt: string[];
  work: { think: string; busy: string; record: string; sort: string; done: string; fail: string };
  tiers: string[]; // by today's tokens, least to most
  clips?: string[]; // every clip in the pack
}

/**
 * What the pet is doing, in priority order: dragged, walking, an app job, tokens being used, you typing, asleep
 * (night and you're idle), idle (you're away), active (you're at the computer but not typing: just breathing).
 */
export type PackState = "held" | "moving" | "busy" | "tokens" | "typing" | "sleepy" | "idle" | "active";

/** Triggers: each bump of a counter plays that event's clip once. */
export interface PackEvents {
  click: number;
  pet: number;
  tier: number; // clicked for today's numbers: the token-tier clip
  exitIdle: number; // you came back after a while away
  tokensDone: number; // token use stopped
  committing: number;
  committed: number;
  reverted: number;
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

export function PackPet({
  pack,
  base,
  state,
  activity,
  facing,
  events,
  tierIndex,
  idleMin,
  onActing,
}: {
  pack: Pack;
  base: (clip: string) => string; // clip name -> playable URL
  state: PackState;
  activity: ActivityKind | null;
  facing: 1 | -1;
  events: PackEvents;
  tierIndex: number;
  idleMin: number; // minutes since your last keyboard/mouse input
  onActing?: (acting: boolean) => void; // a one-off started (true) or everything settled back (false)
}) {
  const videos = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0);
  const [mirror, setMirror] = useState(false);
  const frontRef = useRef(0);
  const playing = useRef<{ clip: string; kind: "loop" | "chain" | "once" } | null>(null);
  const queue = useRef<string[]>([]);
  const recent = useRef<string[]>([]);
  const workTurn = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctx = useRef({ activity, facing, idleMin });
  ctx.current = { activity, facing, idleMin };

  const all = useRef(new Set<string>());
  useEffect(() => {
    // Every clip the pack has (rules naming a missing clip are skipped).
    const s = new Set<string>([...(pack.clips ?? []), pack.idle, pack.look, pack.drag, pack.runLeft, pack.hungry, pack.sleep, ...pack.sleepAlt, ...pack.walk, ...pack.eat, ...pack.click, ...pack.tiers, ...Object.values(pack.meals), ...Object.values(pack.work), ...pack.random.flatMap((g) => g.clips)]);
    all.current = s;
  }, [pack]);
  const has = (clip: string) => all.current.has(clip);

  function remember(clip: string) {
    recent.current.push(clip);
    if (recent.current.length > 12) recent.current.shift();
  }

  /** Shows `clip`: looping, as part of a chain (another follows when it ends), or once (then queue / state). */
  function play(clip: string, kind: "loop" | "chain" | "once", flip = false) {
    if (kind === "loop" && playing.current?.kind === "loop" && playing.current.clip === clip) {
      setMirror(flip);
      return;
    }
    playing.current = { clip, kind };
    onActing?.(kind === "once");
    if (kind !== "loop") remember(clip);
    const back = 1 - frontRef.current;
    const v = videos[back].current;
    if (!v) return;
    v.loop = kind === "loop";
    v.src = base(clip);
    const show = () => {
      v.removeEventListener("canplay", show);
      void v.play().catch(() => {});
      videos[frontRef.current].current?.pause();
      frontRef.current = back;
      setFront(back);
      setMirror(flip);
    };
    v.addEventListener("canplay", show);
    v.load();
  }

  /** What to show for the current state (a loop, or the next clip of a chain). */
  function stateClip(): { clip: string; kind: "loop" | "chain"; flip?: boolean } {
    const { activity, facing, idleMin } = ctx.current;
    const now = new Date();
    switch (stateRef.current) {
      case "held":
        return { clip: pack.drag, kind: "loop" };
      case "moving":
        return { clip: pack.runLeft, kind: "loop", flip: facing === 1 }; // the run clip faces left
      case "busy": {
        const list = (activity && WORK[activity]) || ["工作状态-忙碌点按"];
        const clip = list[workTurn.current++ % list.length];
        return list.length > 1 ? { clip, kind: "chain" } : { clip, kind: "loop" };
      }
      case "tokens":
        return { clip: pickRule(TOKENS, now, idleMin, recent.current, has) ?? pack.idle, kind: "chain" };
      case "typing":
        return { clip: pickRule(TYPING, now, idleMin, recent.current, has) ?? pack.idle, kind: "chain" };
      case "sleepy":
        return { clip: SLEEP.loop, kind: "loop" };
      default:
        return { clip: pack.idle, kind: "loop" };
    }
  }

  function settle() {
    const next = queue.current.shift();
    if (next) return play(next, "once");
    const s = stateClip();
    play(s.clip, s.kind, s.flip);
  }

  /** A one-off now (dropping anything queued), followed by its follow-ups. */
  function event(clip: string | null | undefined, then?: string) {
    if (!clip || !has(clip) || stateRef.current === "held") return;
    queue.current = then && has(then) ? [then] : [];
    play(clip, "once");
  }

  // State changes switch the loop/chain (a one-off in progress finishes first, except being picked up).
  useEffect(() => {
    if (playing.current?.kind === "once" && state !== "held") return;
    workTurn.current = 0;
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activity, facing === 1]);

  // A clip ended: its follow-up, the queue, or back to the state (the next link of a chain).
  useEffect(() => {
    const els = videos.map((r) => r.current);
    const onEnded = () => {
      const cur = playing.current;
      if (!cur || cur.kind === "loop") return;
      const follow = FOLLOW[cur.clip];
      if (follow && has(follow) && !queue.current.length) queue.current.push(follow);
      settle();
    };
    els.forEach((v) => v?.addEventListener("ended", onEnded));
    return () => els.forEach((v) => v?.removeEventListener("ended", onEnded));
  });

  // Events.
  const seen = useRef(events);
  useEffect(() => {
    const prev = seen.current;
    seen.current = events;
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    if (events.committed > prev.committed) {
      // A commit just made: celebrate (after the filing clip if it's still on).
      if (playing.current?.clip === GIT.committing && playing.current.kind === "once") queue.current = [GIT.committed];
      else event(GIT.committed);
    } else if (events.committing > prev.committing) event(GIT.committing);
    else if (events.reverted > prev.reverted) event(GIT.reverted);
    else if (events.tier > prev.tier) event(pack.tiers[Math.min(pack.tiers.length - 1, Math.max(0, tierIndex))]);
    else if (events.click > prev.click || events.pet > prev.pet) event(pick(pack.click));
    else if (events.tokensDone > prev.tokensDone) event(TOKENS_DONE);
    else if (events.exitIdle > prev.exitIdle) {
      const clip = pickRule(EXIT_IDLE, now, 0, recent.current, has);
      const morning = h >= MORNING[0] && h < MORNING[1];
      event(clip, clip && morning ? MORNING_AFTER[clip] : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.committed, events.committing, events.reverted, events.tier, events.click, events.pet, events.tokensDone, events.exitIdle]);

  // The idle routine (you're away): every so often a random clip from the idle rules; asleep, a yawn now and then.
  // One timer for the pet's whole life; it acts only if the pet is idle or asleep when it fires.
  useEffect(() => {
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        const s = stateRef.current;
        if (playing.current?.kind === "loop") {
          if (s === "idle") {
            const clip = pickRule(IDLE, new Date(), ctx.current.idleMin, recent.current, has);
            if (clip) event(clip);
          } else if (s === "sleepy" && Math.random() < 0.35) {
            event(pick(SLEEP.extra));
          }
        }
        next();
      }, 7000 + Math.random() * 11000);
    };
    next();
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack]);

  return (
    <div className="pack-pet" style={mirror ? { transform: "scaleX(-1)" } : undefined}>
      {videos.map((ref, i) => (
        <video key={i} ref={ref} muted playsInline preload="auto" className={i === front ? "on" : ""} />
      ))}
    </div>
  );
}
