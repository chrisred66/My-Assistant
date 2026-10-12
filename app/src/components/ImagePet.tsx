// The desktop pet with the user's own images (one per mood, see lib/pet.ts and Settings → Desktop pet). The image is
// animated with CSS (bob, hop, wiggle, dangle, chew); Zzz, hearts, the thought bubble and the rice bowl are drawn around
// it, so a mood without its own image still shows what's going on.
import { THOUGHTS, type Mood, type Prop } from "./Whale";
import type { PetSkin } from "../lib/pet";

/** Which image to show for a mood, falling back to related ones, then any. */
const FALLBACK: Record<Mood, (keyof PetSkin)[]> = {
  idle: ["idle"],
  swim: ["swim", "idle"],
  busy: ["busy", "idle"],
  held: ["held", "happy", "idle"],
  eating: ["eating", "happy", "idle"],
  happy: ["happy", "idle"],
  sleepy: ["sleepy", "idle"],
  hungry: ["hungry", "idle"],
};

export function skinImage(skin: PetSkin, mood: Mood): { src: string; own: boolean } | null {
  for (const m of FALLBACK[mood]) if (skin[m]) return { src: skin[m]!, own: m === mood };
  const any = Object.values(skin).find(Boolean);
  return any ? { src: any, own: false } : null;
}

export function ImagePet({ skin, mood, prop, flip }: { skin: PetSkin; mood: Mood; prop: Prop; flip: boolean }) {
  const img = skinImage(skin, mood);
  if (!img) return null;
  const bowl = mood === "eating" && !skin.eating;
  const thought = mood === "hungry" ? "hungry" : prop;
  return (
    <div className={`img-pet mood-${mood}${img.own ? "" : " borrowed"}`}>
      <img src={img.src} alt="" draggable={false} style={flip ? { transform: "scaleX(-1)" } : undefined} />
      <svg viewBox="0 0 160 160" className="img-pet-overlay" aria-hidden>
        {mood === "sleepy" && (
          <g className="w-zzz">
            <text x="118" y="34">z</text>
            <text x="128" y="22" className="b">z</text>
            <text x="140" y="8" className="c">Z</text>
          </g>
        )}
        {mood === "happy" && (
          <g className="w-hearts">
            <path d="M40 30 c-3-5 -10-2 -7 3 l7 7 7-7 c3-5 -4-8 -7-3z" />
            <path d="M120 22 c-2-4 -8-2 -6 3 l6 5 6-5 c2-5 -4-7 -6-3z" className="b" />
            <path d="M80 10 c-2-3 -6-1 -4 2 l4 4 4-4 c2-3 -2-5 -4-2z" className="c" />
          </g>
        )}
        {thought && (
          <g className="w-thought">
            <circle cx="122" cy="44" r="2.4" />
            <circle cx="128" cy="36" r="3.4" />
            <ellipse cx="138" cy="18" rx="19" ry="15" />
            {thought === "hungry" ? (
              <g transform="translate(127 8)">
                <path d="M2 10 Q5 2 12 2 Q19 2 22 10 Z" className="w-rice" />
                <path d="M1 10 L23 10 Q21 22 12 22 Q3 22 1 10 Z" className="w-bowl" />
              </g>
            ) : (
              <g transform="translate(126 6)" className="w-thought-icon">
                {THOUGHTS[thought]}
              </g>
            )}
          </g>
        )}
        {bowl && (
          <g className="w-meal" transform="translate(112 112) scale(1.35)">
            <path d="M2 14 Q4 1 14 1 Q24 1 26 14 Z" className="w-rice" />
            <path d="M7 8 l1.6 -0.8 M13 5 l1.6 0.4 M18 8 l1.4 -1 M10 12 l1.5 -0.3 M20 12 l1.2 0.6 M15 10 l1.5 -0.6" className="w-grain-line" />
            <path d="M0 13.5 L28 13.5 Q26.5 30 14 30 Q1.5 30 0 13.5 Z" className="w-bowl" />
            <path d="M1.5 19 L26.5 19" className="w-bowl-band" />
            <path d="M9 30 L19 30" className="w-bowl-foot" />
            <g className="w-sticks">
              <path d="M33 -8 L10 6 M36 -5 L12 8" className="w-chopstick" />
              <ellipse cx="11" cy="7" rx="2.6" ry="1.8" className="w-rice" />
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
