// Hand-drawn SVG charts shared by Usage and PT Management.
// Colors: categorical slots c1..c8 in fixed order (assigned per entity, never by rank), or status colors
// (good / warning / serious / critical) for states. One y-axis per chart: measures in different units go in
// separate charts. Every chart has a hover tooltip; the tables on each page are the accessible fallback.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

export type Color =
  | `c${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`
  | "good"
  | "warning"
  | "serious"
  | "critical"
  | "neutral"
  // AI providers, on the Usage page only
  | "anthropic"
  | "openai"
  | "deepseek"
  | "claude_code";

export interface Series {
  key: string;
  label: string;
  color: Color;
}

export interface Point {
  label: string; // axis label
  title: string; // tooltip heading
  values: Record<string, number | null | undefined>;
}

export const GAP = 2; // surface gap between stacked segments
export const RADIUS = 4; // rounded data-end
const MAX_BAR = 24;

export function useWidth<T extends HTMLElement>() {
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

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/** Rect path with only the top corners rounded (square at the baseline). */
export function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** Rect path with only the right corners rounded (square at the baseline on the left). */
export function rightRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

export function Tooltip({ x, y, children, containerWidth }: { x: number; y: number; children: ReactNode; containerWidth: number }) {
  const flip = x > containerWidth - 200;
  return (
    <div className="chart-tooltip" style={{ left: flip ? undefined : x + 12, right: flip ? containerWidth - x + 12 : undefined, top: y }}>
      {children}
    </div>
  );
}

/**
 * Drag across a chart to pick a range of points. `indexAt` maps a mouse event on the plot overlay to a point index.
 * Returns the overlay's event handlers and the current selection (for drawing the brush).
 */
function useBrush(onZoom: ((from: number, to: number) => void) | undefined, setHover: (i: number | null) => void, indexAt: (e: MouseEvent<SVGRectElement>) => number) {
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const handlers = {
    onMouseMove: (e: MouseEvent<SVGRectElement>) => {
      const i = indexAt(e);
      setHover(i);
      if (drag) setDrag({ ...drag, b: i });
    },
    onMouseLeave: () => {
      setHover(null);
      setDrag(null);
    },
    onMouseDown: onZoom
      ? (e: MouseEvent<SVGRectElement>) => {
          e.preventDefault(); // no text selection while dragging
          const i = indexAt(e);
          setDrag({ a: i, b: i });
        }
      : undefined,
    onMouseUp: () => {
      if (drag && onZoom && drag.a !== drag.b) onZoom(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b));
      setDrag(null);
    },
    style: onZoom ? { cursor: "crosshair" } : undefined,
  };
  const selection = drag && drag.a !== drag.b ? { from: Math.min(drag.a, drag.b), to: Math.max(drag.a, drag.b) } : null;
  return { handlers, selection, dragging: drag !== null };
}

export function Swatch({ color }: { color: Color }) {
  return <span className={`swatch bg-${color}`} aria-hidden />;
}

export function SeriesLegend({ series }: { series: { label: string; color: Color }[] }) {
  return (
    <ul className="legend" aria-label="Legend">
      {series.map((s) => (
        <li key={s.label}>
          <Swatch color={s.color} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function yTicks(max: number) {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
}

/** Left margin wide enough for the longest y-axis label (11px tabular figures ≈ 6.6px each). */
export function axisMargin(max: number, formatTick: (v: number) => string) {
  return Math.max(40, Math.ceil(Math.max(...yTicks(max).map((t) => formatTick(t).length)) * 6.6) + 14);
}

/** Columns over time, stacked when there are several series. */
export function ColumnChart({
  points,
  series,
  format,
  formatTick = format,
  height = 240,
  label,
  onZoom,
}: {
  points: Point[];
  series: Series[];
  format: (v: number) => string;
  formatTick?: (v: number) => string;
  height?: number;
  label: string;
  /** Enables drag-to-zoom; called with the first and last point index of the dragged range. */
  onZoom?: (from: number, to: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = points.map((p) => series.reduce((s, k) => s + (p.values[k.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const m = { top: 12, right: 8, bottom: 28, left: axisMargin(max, formatTick) };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const y = (v: number) => (v / max) * innerH;
  const band = points.length ? innerW / points.length : 0;
  const barW = Math.max(1, Math.min(MAX_BAR, band * 0.7));
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 64))));
  const brush = useBrush(onZoom, setHover, (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(points.length - 1, Math.floor((e.clientX - box.left) / (band || 1))));
  });

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <g transform={`translate(${m.left},${m.top})`}>
            {yTicks(max).map((t) => (
              <g key={t} transform={`translate(0,${innerH - y(t)})`}>
                <line x2={innerW} className={t === 0 ? "axis-line" : "grid-line"} />
                <text x={-8} dy="0.32em" textAnchor="end" className="tick">
                  {formatTick(t)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx = i * band + band / 2;
              const present = series.filter((s) => (p.values[s.key] ?? 0) > 0);
              let base = 0;
              return (
                <g key={p.label + i}>
                  {hover === i && <rect x={i * band} width={band} height={innerH} className="hover-wash" />}
                  {present.map((s, j) => {
                    const h = y(p.values[s.key] ?? 0);
                    const gap = j > 0 && h > GAP ? GAP : 0;
                    const top = innerH - base - h;
                    base += h;
                    const x = cx - barW / 2;
                    return j === present.length - 1 ? (
                      <path key={s.key} d={topRounded(x, top, barW, h - gap, RADIUS)} className={`fill-${s.color}`} />
                    ) : (
                      <rect key={s.key} x={x} y={top} width={barW} height={h - gap} className={`fill-${s.color}`} />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={innerH + 18} textAnchor="middle" className="tick">
                      {p.label}
                    </text>
                  )}
                </g>
              );
            })}
            {brush.selection && (
              <rect x={brush.selection.from * band} width={(brush.selection.to - brush.selection.from + 1) * band} height={innerH} className="brush" />
            )}
            <rect width={innerW} height={innerH} fill="transparent" {...brush.handlers} />
          </g>
        </svg>
      )}
      {hover !== null && !brush.selection && points[hover] && (
        <Tooltip x={m.left + hover * band + band / 2} y={m.top} containerWidth={width}>
          <strong>{points[hover].title}</strong>
          {series.map((s) => (
            <div key={s.key} className="tooltip-row">
              <Swatch color={s.color} />
              <span>{s.label}</span>
              <span className="num">{format(points[hover].values[s.key] ?? 0)}</span>
            </div>
          ))}
          {series.length > 1 && (
            <div className="tooltip-row total">
              <span />
              <span>Total</span>
              <span className="num">{format(totals[hover])}</span>
            </div>
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** Lines over time with a crosshair. Missing values (null) break the line. */
export function LineChart({
  points,
  series,
  format,
  formatTick = format,
  height = 240,
  label,
  reference,
  maxValue,
  onZoom,
}: {
  points: Point[];
  series: Series[];
  format: (v: number) => string;
  formatTick?: (v: number) => string;
  height?: number;
  label: string;
  /** A dashed horizontal line, e.g. a threshold. */
  reference?: { value: number; label: string };
  /** Top of the scale. Values above it are drawn at the top edge as ▲ (the tooltip shows the real value). */
  maxValue?: number;
  /** Enables drag-to-zoom; called with the first and last point index of the dragged range. */
  onZoom?: (from: number, to: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const all = points.flatMap((p) => series.map((s) => p.values[s.key])).filter((v): v is number => typeof v === "number");
  const max = niceMax(Math.min(maxValue ?? Infinity, Math.max(0, ...all, reference?.value ?? 0)));
  const m = { top: 12, right: 12, bottom: 28, left: axisMargin(max, formatTick) };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const y = (v: number) => innerH - (Math.min(v, max) / max) * innerH;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => (points.length > 1 ? i * step : innerW / 2);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 64))));

  function path(key: string) {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p.values[key];
      if (typeof v !== "number") {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  const brush = useBrush(onZoom, setHover, (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(points.length - 1, step ? Math.round((e.clientX - box.left) / step) : 0));
  });

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <g transform={`translate(${m.left},${m.top})`}>
            {yTicks(max).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x2={innerW} className={t === 0 ? "axis-line" : "grid-line"} />
                <text x={-8} dy="0.32em" textAnchor="end" className="tick">
                  {formatTick(t)}
                </text>
              </g>
            ))}
            {reference && (
              <g transform={`translate(0,${y(reference.value)})`}>
                <line x2={innerW} className="ref-line" />
                <text x={innerW} y={-4} textAnchor="end" className="tick">
                  {reference.label}
                </text>
              </g>
            )}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text key={i} x={x(i)} y={innerH + 18} textAnchor="middle" className="tick">
                  {p.label}
                </text>
              ) : null,
            )}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y2={innerH} className="crosshair" />}
            {series.map((s) => (
              <path key={s.key} d={path(s.key)} className={`line stroke-${s.color}`} />
            ))}
            {/* Isolated points (a value with no neighbour) would be invisible as a line. */}
            {series.map((s) =>
              points.map((p, i) => {
                const v = p.values[s.key];
                const lonely = typeof v === "number" && typeof points[i - 1]?.values[s.key] !== "number" && typeof points[i + 1]?.values[s.key] !== "number";
                if (typeof v === "number" && v > max) {
                  const cx = x(i);
                  return <path key={`${s.key}${i}`} d={`M${cx - 5},6 L${cx + 5},6 L${cx},-2 Z`} className={`dot fill-${s.color}`} />;
                }
                return lonely || hover === i
                  ? typeof v === "number" && <circle key={`${s.key}${i}`} cx={x(i)} cy={y(v)} r={4} className={`dot fill-${s.color}`} />
                  : null;
              }),
            )}
            {brush.selection && (
              <rect x={x(brush.selection.from)} width={Math.max(1, x(brush.selection.to) - x(brush.selection.from))} height={innerH} className="brush" />
            )}
            <rect width={innerW} height={innerH} fill="transparent" {...brush.handlers} />
          </g>
        </svg>
      )}
      {hover !== null && !brush.selection && points[hover] && (
        <Tooltip x={m.left + x(hover)} y={m.top} containerWidth={width}>
          <strong>{points[hover].title}</strong>
          {series.map((s) => {
            const v = points[hover].values[s.key];
            return (
              <div key={s.key} className="tooltip-row">
                <Swatch color={s.color} />
                <span>{s.label}</span>
                <span className="num">{typeof v === "number" ? format(v) : "—"}</span>
              </div>
            );
          })}
        </Tooltip>
      )}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  color: Color;
  detail?: ReactNode;
}

/** Horizontal bars, one per item, with the value at the end. Click handler optional. */
export function BarList({
  items,
  format,
  label,
  onSelect,
}: {
  items: BarItem[];
  format: (v: number) => string;
  label: string;
  onSelect?: (item: BarItem) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const row = 30;
  const thick = 14;
  const labelW = Math.min(200, width * 0.38);
  const valueW = 110;
  const innerW = Math.max(0, width - labelW - valueW);
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const height = items.length * row + 4;
  const maxChars = Math.max(6, Math.floor((labelW - 12) / 6.8)); // ~6.8px per character at 12px

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <line x1={labelW} x2={labelW} y2={height} className="axis-line" />
          {items.map((it, i) => {
            const w = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * innerW);
            const yTop = i * row + (row - thick) / 2;
            return (
              <g
                key={it.key}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={onSelect ? () => onSelect(it) : undefined}
                style={onSelect ? { cursor: "pointer" } : undefined}
              >
                {hover === i && <rect y={i * row} width={width} height={row} className="hover-wash" />}
                <text x={labelW - 8} y={i * row + row / 2} dy="0.32em" textAnchor="end" className="bar-label">
                  {it.label.length > maxChars ? `${it.label.slice(0, maxChars - 1)}…` : it.label}
                </text>
                {w > 0 && <path d={rightRounded(labelW, yTop, w, thick, RADIUS)} className={`fill-${it.color}`} />}
                <text x={labelW + w + 6} y={i * row + row / 2} dy="0.32em" className="bar-value">
                  {format(it.value)}
                </text>
                <rect y={i * row} width={width} height={row} fill="transparent" />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && items[hover] && (items[hover].detail || items[hover].label.length > maxChars) && (
        <Tooltip x={labelW + 40} y={hover * row + row} containerWidth={width}>
          <strong>{items[hover].label}</strong>
          {items[hover].detail && <div className="small">{items[hover].detail}</div>}
        </Tooltip>
      )}
    </div>
  );
}
