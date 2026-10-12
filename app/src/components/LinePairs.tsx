// A transcript line by line: each original line with its English underneath. Lines pair up when the original and the
// translation have the same number of lines (live chunks, meeting turns, and transcripts translated line by line), else
// the same number of sentences; otherwise (older translations) the original and the English show as two blocks.

const lines = (t: string) => t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const sentences = (t: string) =>
  t
    .split(/(?<=[.!?。！？؟])\s+|(?<=[。！？؟])(?=\S)/u)
    .map((s) => s.trim())
    .filter(Boolean);

/** Pairs of original and English (English null when there's none, or for an English original). */
export function pairLines(source: string, english: string | null): { src: string; en: string | null }[] {
  const src = lines(source);
  if (!english) return src.map((s) => ({ src: s, en: null }));
  const en = lines(english);
  if (en.length === src.length && src.length > 1) return src.map((s, i) => ({ src: s, en: en[i] }));
  const ss = sentences(source);
  const es = sentences(english);
  if (ss.length === es.length && ss.length > 1) return ss.map((s, i) => ({ src: s, en: es[i] }));
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
          <p className="line-src" dir="auto">
            {p.src}
          </p>
          {p.en && p.en !== p.src && <p className="line-en">{p.en}</p>}
        </div>
      ))}
    </div>
  );
}
