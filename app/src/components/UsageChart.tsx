// Hand-drawn SVG charts for the Usage page.
// Colors follow the provider (fixed slot order), never its rank; the table on the page is the
// accessible fallback for everything shown here.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PROVIDER_LABELS, PROVIDERS, type Provider } from "../lib/api";

export interface StackedPoint {
  label: string; // axis label
  title: string; // tooltip heading
  values: Partial<Record<Provider, number>>;
}

const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end
const MAX_BAR = 24;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/** Rect path with only the top corners rounded (square at the baseline). */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** Rect path with only the right corners rounded (square at the baseline on the left). */
function rightRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

export function Legend({ providers }: { providers: Provider[] }) {
  return (
    <ul className="legend" aria-label="Legend">
      {providers.map((p) => (
        <li key={p}>
          <span className={`swatch series-${p}`} aria-hidden />
          {PROVIDER_LABELS[p]}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ x, y, children, containerWidth }: { x: number; y: number; children: ReactNode; containerWidth: number }) {
  const flip = x > containerWidth - 200;
  return (
    <div className="chart-tooltip" style={{ left: flip ? undefined : x + 12, right: flip ? containerWidth - x + 12 : undefined, top: y }}>
      {children}
    </div>
  );
}

export function StackedColumns({
  points,
  format,
  formatTick,
}: {
  points: StackedPoint[];
  format: (v: number) => string;
  formatTick: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 260;
  const m = { top: 12, right: 8, bottom: 28, left: 56 };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;

  const totals = points.map((p) => PROVIDERS.reduce((s, k) => s + (p.values[k] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const y = (v: number) => (v / max) * innerH;
  const band = points.length ? innerW / points.length : 0;
  const barW = Math.max(2, Math.min(MAX_BAR, band * 0.7));
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 64))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Usage over time, stacked by provider">
          <g transform={`translate(${m.left},${m.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${innerH - y(t)})`}>
                <line x2={innerW} className={t === 0 ? "axis-line" : "grid-line"} />
                <text x={-8} dy="0.32em" textAnchor="end" className="tick">
                  {formatTick(t)}
                </text>
              </g>
            ))}

            {points.map((p, i) => {
              const cx = i * band + band / 2;
              const present = PROVIDERS.filter((k) => (p.values[k] ?? 0) > 0);
              let base = 0; // running stack height in px
              return (
                <g key={p.label + i}>
                  {hover === i && <rect x={i * band} width={band} height={innerH} className="hover-wash" />}
                  {present.map((k, j) => {
                    const h = y(p.values[k] ?? 0);
                    const gap = j > 0 && h > GAP ? GAP : 0;
                    const segH = h - gap;
                    const top = innerH - base - h;
                    base += h;
                    const isTop = j === present.length - 1;
                    const x = cx - barW / 2;
                    return isTop ? (
                      <path key={k} d={topRounded(x, top, barW, segH, RADIUS)} className={`series-${k}`} />
                    ) : (
                      <rect key={k} x={x} y={top} width={barW} height={segH} className={`series-${k}`} />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={innerH + 18} textAnchor="middle" className="tick">
                      {p.label}
                    </text>
                  )}
                  <rect
                    x={i * band}
                    width={band}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {hover !== null && points[hover] && (
        <Tooltip x={m.left + hover * band + band / 2} y={m.top} containerWidth={width}>
          <strong>{points[hover].title}</strong>
          {PROVIDERS.filter((k) => points[hover].values[k] !== undefined).map((k) => (
            <div key={k} className="tooltip-row">
              <span className={`swatch series-${k}`} aria-hidden />
              <span>{PROVIDER_LABELS[k]}</span>
              <span className="num">{format(points[hover].values[k] ?? 0)}</span>
            </div>
          ))}
          <div className="tooltip-row total">
            <span />
            <span>Total</span>
            <span className="num">{format(totals[hover])}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

export interface BarItem {
  label: string;
  provider: Provider;
  value: number;
  detail?: string;
}

export function HorizontalBars({ items, format }: { items: BarItem[]; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const row = 32;
  const thick = 16;
  const labelW = Math.min(220, width * 0.4);
  const valueW = 90;
  const innerW = Math.max(0, width - labelW - valueW);
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const height = items.length * row + 4;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Usage by model">
          <line x1={labelW} x2={labelW} y2={height} className="axis-line" />
          {items.map((it, i) => {
            const w = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * innerW);
            const yTop = i * row + (row - thick) / 2;
            return (
              <g key={it.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {hover === i && <rect y={i * row} width={width} height={row} className="hover-wash" />}
                <text x={labelW - 8} y={i * row + row / 2} dy="0.32em" textAnchor="end" className="bar-label">
                  {it.label.length > 30 ? `${it.label.slice(0, 29)}…` : it.label}
                </text>
                {w > 0 && <path d={rightRounded(labelW, yTop, w, thick, RADIUS)} className={`series-${it.provider}`} />}
                <text x={labelW + w + 6} y={i * row + row / 2} dy="0.32em" className="bar-value">
                  {format(it.value)}
                </text>
                <rect y={i * row} width={width} height={row} fill="transparent" />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && items[hover] && (
        <Tooltip x={labelW + 40} y={hover * 32 + 30} containerWidth={width}>
          <strong>{items[hover].label}</strong>
          <div className="tooltip-row">
            <span className={`swatch series-${items[hover].provider}`} aria-hidden />
            <span>{PROVIDER_LABELS[items[hover].provider]}</span>
            <span className="num">{format(items[hover].value)}</span>
          </div>
          {items[hover].detail && <div className="muted small">{items[hover].detail}</div>}
        </Tooltip>
      )}
    </div>
  );
}
