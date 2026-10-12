// The desktop pet as an animation pack: transparent WebM clips (VP9 with alpha) chosen like a little director.
// Loops for states (idle, moving, dragged, asleep, busy with an app job) and one-off clips for events (clicked,
// petted, eating when tokens are used, a meal at meal times), with a random idle routine in between (weighted
// categories, festival clips only in their months). Two video elements swap, so changing clips doesn't flicker.
// The pack lives in the app data folder (pet-pack/pack.json + clips) and is played over the asset protocol.
import { useEffect, useRef, useState } from "react";
import type { ActivityKind } from "../lib/activity";

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
}

export type PackState = "idle" | "moving" | "held" | "sleepy" | "busy" | "hungry";

/** Triggers: each bump of a counter plays that event's clip once. */
export interface PackEvents {
  click: number;
  pet: number;
  eat: number;
  tier: number; // clicked for today's numbers: the token-tier clip
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
}: {
  pack: Pack;
  base: (clip: string) => string; // clip name -> playable URL
  state: PackState;
  activity: ActivityKind | null;
  facing: 1 | -1;
  events: PackEvents;
  tierIndex: number;
}) {
  const videos = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0);
  const [mirror, setMirror] = useState(false);
  const playing = useRef<{ clip: string; oneShot: boolean } | null>(null);
  const recent = useRef<string[]>([]);
  const lastMeal = useRef<string>("");
  const ateWithToken = useRef(false);

  /** Shows `clip` (looping, or once then back to the state loop). */
  function play(clip: string, oneShot: boolean, flip = false) {
    if (playing.current?.clip === clip && !oneShot) return;
    playing.current = { clip, oneShot };
    const back = 1 - front;
    const v = videos[back].current;
    if (!v) return;
    v.loop = !oneShot;
    v.src = base(clip);
    const show = () => {
      v.removeEventListener("canplay", show);
      void v.play().catch(() => {});
      setFront(back);
      setMirror(flip);
      videos[front].current?.pause();
    };
    v.addEventListener("canplay", show);
    v.load();
  }

  /** The loop for the current state. */
  function stateClip(): { clip: string; flip: boolean } {
    switch (state) {
      case "held":
        return { clip: pack.drag, flip: false };
      case "moving":
        return { clip: pack.runLeft, flip: facing === 1 }; // the run clip faces left
      case "sleepy":
        return { clip: pack.sleep, flip: false };
      case "busy":
        return {
          clip: activity === "recording" ? pack.work.record : activity === "translating" || activity === "learning" || activity === "planning" ? pack.work.think : pack.work.busy,
          flip: false,
        };
      default:
        return { clip: pack.idle, flip: false };
    }
  }

  function backToState() {
    const s = stateClip();
    play(s.clip, false, s.flip);
  }

  // State changes switch the loop (a one-off in progress finishes first, except being picked up).
  useEffect(() => {
    if (playing.current?.oneShot && state !== "held") return;
    backToState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activity, facing === 1]);

  // When a one-off ends, back to the state loop.
  useEffect(() => {
    const els = videos.map((r) => r.current);
    const onEnded = () => {
      if (playing.current?.oneShot) backToState();
    };
    els.forEach((v) => v?.addEventListener("ended", onEnded));
    return () => els.forEach((v) => v?.removeEventListener("ended", onEnded));
  });

  // Events: one-off clips.
  const seen = useRef(events);
  useEffect(() => {
    const prev = seen.current;
    seen.current = events;
    if (state === "held") return;
    if (events.eat > prev.eat) {
      // 吃Token and 吃白饭 take turns.
      ateWithToken.current = !ateWithToken.current;
      play(ateWithToken.current ? pack.eat[0] : pack.eat[1] ?? pack.eat[0], true);
    } else if (events.tier > prev.tier) {
      play(pack.tiers[Math.min(pack.tiers.length - 1, Math.max(0, tierIndex))], true);
    } else if (events.click > prev.click || events.pet > prev.pet) {
      play(pick(pack.click), true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.eat, events.tier, events.click, events.pet]);

  // The idle routine: every so often a random action; at meal times a meal; asleep, a yawn now and then.
  useEffect(() => {
    if (state !== "idle" && state !== "hungry" && state !== "sleepy") return;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        if (!playing.current?.oneShot) {
          const now = new Date();
          const h = now.getHours() + now.getMinutes() / 60;
          const meal = h >= 6.5 && h < 9.5 ? "breakfast" : h >= 11.5 && h < 13.5 ? "lunch" : h >= 17.5 && h < 19.5 ? "dinner" : null;
          const mealKey = meal ? `${now.toDateString()}-${meal}` : "";
          if (state === "sleepy") {
            if (Math.random() < 0.35) play(pick(pack.sleepAlt), true);
          } else if (meal && lastMeal.current !== mealKey) {
            lastMeal.current = mealKey;
            play(pack.meals[meal], true);
          } else if (state === "hungry" && Math.random() < 0.3) {
            play(pack.hungry, true);
          } else {
            play(randomAction(pack, now.getMonth() + 1, recent.current), true);
          }
        }
        next();
      }, 9000 + Math.random() * 16000);
    };
    next();
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pack]);

  return (
    <div className="pack-pet" style={mirror ? { transform: "scaleX(-1)" } : undefined}>
      {videos.map((ref, i) => (
        <video key={i} ref={ref} muted playsInline preload="auto" className={i === front ? "on" : ""} />
      ))}
    </div>
  );
}

/** A random idle action: a weighted category, then a clip not played recently (festival clips only in season). */
function randomAction(pack: Pack, month: number, recent: string[]): string {
  const groups = pack.random
    .map((g) => ({ ...g, clips: g.clips.filter((c) => !g.seasonal || (pack.seasons[c] ?? []).includes(month)) }))
    .filter((g) => g.clips.length);
  let r = Math.random() * groups.reduce((n, g) => n + g.weight, 0);
  const group = groups.find((g) => (r -= g.weight) < 0) ?? groups[0];
  const fresh = group.clips.filter((c) => !recent.includes(c));
  const clip = pick(fresh.length ? fresh : group.clips);
  recent.push(clip);
  if (recent.length > 12) recent.shift();
  return clip;
}
