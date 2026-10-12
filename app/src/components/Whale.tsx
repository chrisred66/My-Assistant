// The desktop pet's whale: an original chubby blue whale drawn in SVG (facing right; the pet window mirrors it when it
// swims left). Its face follows the mood, and props show what it's doing: headphones while recording, a rice bowl and
// chopsticks while eating tokens (吃大白饭), a thought bubble with the current job, Zzz when asleep, hearts when petted.
import type { ReactElement } from "react";

export type Mood = "idle" | "swim" | "happy" | "eating" | "sleepy" | "hungry" | "busy" | "held";
export type Prop = "headphones" | "pencil" | "translate" | "gear" | "sparkle" | "box" | null;

/** Small glyphs for the thought bubble (24-unit icons, drawn at the bubble's centre). */
export const THOUGHTS: Record<Exclude<Prop, null>, ReactElement> = {
  headphones: <path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4" />,
  translate: (
    <>
      <path d="M3 5h10M8 3v2M5 9c2 4 5 6 8 7M11 5c-1 5-4 9-8 11" />
      <path d="M13 21l4-9 4 9M14.5 18h5" />
    </>
  ),
  gear: <path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" />,
  sparkle: <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />,
  box: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
};

export function Whale({
  mood,
  prop,
  facing,
  fullness,
}: {
  mood: Mood;
  prop: Prop;
  facing: 1 | -1;
  fullness: number; // 0..1: rounder as more tokens are eaten today
}) {
  const eyes =
    mood === "sleepy" ? (
      <path d="M97 53 Q104 58 111 53" className="w-line" />
    ) : mood === "happy" || mood === "eating" ? (
      <path d="M97 55 Q104 46 111 55" className="w-line" />
    ) : mood === "held" ? (
      <g>
        <circle cx="104" cy="52" r="7.5" className="w-eye-white" />
        <circle cx="104" cy="52" r="2.6" className="w-pupil" />
      </g>
    ) : (
      <g className="w-blink">
        <circle cx="104" cy="52" r="7.5" className="w-eye-white" />
        <circle cx="105.6" cy="53.2" r="4.4" className="w-pupil" />
        <circle cx="103.6" cy="50.6" r="1.7" className="w-shine" />
      </g>
    );
  const mouth =
    mood === "eating" ? (
      <ellipse cx="117" cy="71" rx="4" ry="3.2" className="w-mouth-open w-chew" />
    ) : mood === "held" ? (
      <ellipse cx="117" cy="71" rx="2.6" ry="3" className="w-mouth-open" />
    ) : mood === "sleepy" ? (
      <path d="M113 71 Q117 72.5 121 71" className="w-line thin" />
    ) : (
      <path d="M111 69 Q117 75 123 68" className="w-line thin" />
    );
  const s = 1 + fullness * 0.22;

  return (
    <svg viewBox="-10 -36 170 146" className={`whale mood-${mood}`} aria-hidden>
      <defs>
        <linearGradient id="w-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5aa2ff" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <clipPath id="w-clip">
          <path d="M30 60 C30 32 62 22 88 24 C116 26 128 46 126 64 C124 86 102 96 74 96 C50 96 34 86 30 60 Z" />
        </clipPath>
      </defs>

      {/* Mirrored as a whole when swimming left; bobbing and fullness scale around the belly. */}
      <g transform={facing === -1 ? "translate(140 0) scale(-1 1)" : undefined}>
        <g className="w-bob">
          <g style={{ transform: `scale(${s})`, transformOrigin: "78px 96px" }}>
            {/* Tail */}
            <g className="w-tail">
              <path d="M34 59 Q22 58 16 50 Q9 41 3 45 Q9 54 12 61 Q8 69 3 76 Q10 81 18 72 Q24 66 34 68 Z" className="w-fin" />
            </g>
            {/* Body, belly, grooves */}
            <path d="M30 60 C30 32 62 22 88 24 C116 26 128 46 126 64 C124 86 102 96 74 96 C50 96 34 86 30 60 Z" fill="url(#w-body)" />
            <g clipPath="url(#w-clip)">
              <ellipse cx="90" cy="96" rx="44" ry="20" className="w-belly" />
              <path d="M66 84 Q88 90 112 80 M70 89 Q90 94 108 86" className="w-groove" />
            </g>
            <ellipse cx="88" cy="34" rx="16" ry="5.5" className="w-gloss" />
            {/* Flipper */}
            <path d="M70 80 Q63 95 52 98 Q64 101 77 87 Z" className="w-fin w-flap" />
            {/* Face */}
            <ellipse cx="111" cy="63" rx="6" ry="3.4" className="w-cheek" />
            {eyes}
            {mouth}
            {mood === "hungry" && <path d="M121 72 q1.5 5 0 7 q-1.5-2 0-7z" className="w-drool" />}
            {mood === "held" && <path d="M120 36 q3 5 0 8 q-3-3 0-8z" className="w-sweat" />}

            {/* Headphones (recording, meetings, transcribing) */}
            {prop === "headphones" && (
              <g>
                <path d="M80 36 Q100 6 124 42" className="w-band" />
                <rect x="117" y="38" width="11" height="15" rx="5" className="w-cup" />
                <rect x="76" y="31" width="10" height="14" rx="5" className="w-cup back" />
              </g>
            )}

            {/* 吃大白饭: a bowl of white rice and chopsticks while tokens are used */}
            {mood === "eating" && (
              <g className="w-meal" transform="translate(118 58) scale(1.35)">
                {/* a heaped bowl of white rice in a pale porcelain bowl, chopsticks lifting a bite */}
                <path d="M2 14 Q4 1 14 1 Q24 1 26 14 Z" className="w-rice" />
                <path d="M7 8 l1.6 -0.8 M13 5 l1.6 0.4 M18 8 l1.4 -1 M10 12 l1.5 -0.3 M20 12 l1.2 0.6 M15 10 l1.5 -0.6" className="w-grain-line" />
                <path d="M0 13.5 L28 13.5 Q26.5 30 14 30 Q1.5 30 0 13.5 Z" className="w-bowl" />
                <path d="M1.5 19 L26.5 19" className="w-bowl-band" />
                <path d="M9 30 L19 30" className="w-bowl-foot" />
                <g className="w-sticks">
                  <path d="M33 -8 L10 6 M36 -5 L12 8" className="w-chopstick" />
                  <ellipse cx="11" cy="7" rx="2.6" ry="1.8" className="w-rice" />
                </g>
                <circle cx="4" cy="9" r="1" className="w-grain flying" />
              </g>
            )}
          </g>
        </g>
      </g>

      {/* Above the head (never mirrored): water spout, Zzz, hearts, thought bubble. */}
      {(mood === "happy" || mood === "idle") && (
        <g className={`w-spout ${mood === "happy" ? "on" : ""}`}>
          <path d={facing === 1 ? "M96 22 q-2-10 -8-14 M96 22 q0-12 0-16 M96 22 q2-10 8-14" : "M44 22 q-2-10 -8-14 M44 22 q0-12 0-16 M44 22 q2-10 8-14"} />
        </g>
      )}
      {mood === "sleepy" && (
        <g className="w-zzz">
          <text x={facing === 1 ? 112 : 18} y="16">z</text>
          <text x={facing === 1 ? 122 : 8} y="4" className="b">z</text>
          <text x={facing === 1 ? 134 : -4} y="-10" className="c">Z</text>
        </g>
      )}
      {mood === "happy" && (
        <g className="w-hearts">
          <path d="M70 6 c-3-5 -10-2 -7 3 l7 7 7-7 c3-5 -4-8 -7-3z" />
          <path d="M100 -6 c-2-4 -8-2 -6 3 l6 5 6-5 c2-5 -4-7 -6-3z" className="b" />
          <path d="M44 -2 c-2-3 -6-1 -4 2 l4 4 4-4 c2-3 -2-5 -4-2z" className="c" />
        </g>
      )}
      {(mood === "hungry" || (prop && prop !== "headphones")) && (
        <g className="w-thought">
          <circle cx={facing === 1 ? 70 : 70} cy="16" r="2.4" />
          <circle cx={facing === 1 ? 62 : 78} cy="6" r="3.6" />
          <ellipse cx="70" cy="-14" rx="21" ry="17" />
          {mood === "hungry" ? (
            <g transform="translate(58 -26)">
              <path d="M2 10 Q5 2 12 2 Q19 2 22 10 Z" className="w-rice" />
              <path d="M1 10 L23 10 Q21 22 12 22 Q3 22 1 10 Z" className="w-bowl" />
            </g>
          ) : (
            <g transform="translate(58 -26)" className="w-thought-icon">
              {THOUGHTS[prop as Exclude<Prop, "headphones" | null>]}
            </g>
          )}
        </g>
      )}
    </svg>
  );
}
