// A transcript line by line: each original line with its translation underneath. Lines pair one to one when the counts
// match; when they don't (the translator split or merged a line somewhere), they're aligned by length, allowing one
// line to pair with two on the other side (a small version of the Gale-Church alignment used for translations).
// Single-paragraph texts pair by sentence the same way.

const lines = (t: string) => t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const sentences = (t: string) =>
  t
    .split(/(?<=[.!?。！？؟])\s+|(?<=[。！？؟])(?=\S)/u)
    .map((s) => s.trim())
    .filter(Boolean);

type Pair = { src: string; en: string | null };

/**
 * Aligns two lists of lines by length. Steps: 1-1, 1-2, 2-1 (a split or merge), 1-0 / 0-1 (a line with no
 * counterpart); the cost of a step is how far the English length is from what the original's length predicts.
 */
function align(src: string[], en: string[]): Pair[] | null {
  const n = src.length;
  const m = en.length;
  if (n * m > 4_000_000) return null;
  const len = (s: string) => Math.max(1, s.length);
  const ratio = en.reduce((a, s) => a + len(s), 0) / src.reduce((a, s) => a + len(s), 0);
  const fit = (a: number, b: number) => {
    const expected = a * ratio;
    return Math.abs(b - expected) / Math.sqrt(expected + b + 1);
  };
  const STEPS: [number, number, number][] = [
    [1, 1, 0],
    [1, 2, 4],
    [2, 1, 4],
    [1, 0, 6],
    [0, 1, 6],
  ];
  const cost = new Float64Array((n + 1) * (m + 1)).fill(Infinity);
  const back = new Int8Array((n + 1) * (m + 1)).fill(-1);
  const at = (i: number, j: number) => i * (m + 1) + j;
  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[at(i, j)];
      if (here === Infinity) continue;
      STEPS.forEach(([di, dj, penalty], k) => {
        const ni = i + di;
        const nj = j + dj;
        if (ni > n || nj > m) return;
        let a = 0;
        for (let x = i; x < ni; x++) a += len(src[x]);
        let b = 0;
        for (let y = j; y < nj; y++) b += len(en[y]);
        const c = here + penalty + (di && dj ? fit(a, b) : 1);
        if (c < cost[at(ni, nj)]) {
          cost[at(ni, nj)] = c;
          back[at(ni, nj)] = k;
        }
      });
    }
  }
  const out: Pair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = back[at(i, j)];
    if (k < 0) return null;
    const [di, dj] = STEPS[k];
    const s = src.slice(i - di, i).join(" ");
    const e = en.slice(j - dj, j).join(" ");
    if (di) out.push({ src: s, en: e || null });
    else if (out.length) out[out.length - 1].en = [e, out[out.length - 1].en].filter(Boolean).join(" ");
    else out.push({ src: "", en: e });
    i -= di;
    j -= dj;
  }
  return out.reverse();
}

/** Pairs of original and English (English null when there's none). */
export function pairLines(source: string, english: string | null): Pair[] {
  const src = lines(source);
  if (!english) return src.map((s) => ({ src: s, en: null }));
  const en = lines(english);
  if (en.length === src.length && src.length > 1) return src.map((s, i) => ({ src: s, en: en[i] }));
  if (src.length > 1 && en.length > 1) {
    const aligned = align(src, en);
    if (aligned) return aligned;
  }
  const ss = sentences(source);
  const es = sentences(english);
  if (ss.length === es.length && ss.length > 1) return ss.map((s, i) => ({ src: s, en: es[i] }));
  if (ss.length > 1 && es.length > 1) {
    const aligned = align(ss, es);
    if (aligned) return aligned;
  }
  return [{ src: src.join("\n"), en: en.join("\n") }];
}

/** Lines whose "translation" is the same text (English originals, English turns in a meeting) show once. */
export function LinePairs({ source, english }: { source: string; english: string | null }) {
  const pairs = pairLines(source, english);
  const aligned = pairs.length > 1 || !english || sentences(source).length <= 1; // one sentence pairs with its translation
  return (
    <div className={`line-pairs${aligned ? "" : " blocks"}`}>
      {pairs.map((p, i) => (
        <div key={i} className="line-pair">
          {p.src && (
            <p className="line-src" dir="auto">
              {p.src}
            </p>
          )}
          {p.en && p.en !== p.src && <p className="line-en">{p.en}</p>}
        </div>
      ))}
    </div>
  );
}
