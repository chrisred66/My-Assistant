// Hand-drawn SVG charts for the Usage page.
// Colors follow the provider (fixed slot order), never its rank; the table on the page is the
// accessible fallback for everything shown here.
import { useId, useState } from "react";
import { SOURCE_LABELS as PROVIDER_LABELS, USAGE_SOURCES as PROVIDERS, type UsageSource as Provider } from "../lib/api";
import { axisMargin, GAP, niceMax, RADIUS, rightRounded, Tooltip, topRounded, useWidth } from "./charts";

const MAX_BAR = 24;

export interface StackedPoint {
  label: string; // axis label
  title: string; // tooltip heading
  values: Partial<Record<Provider, number>>; // input tokens when `out` is given
  out?: Partial<Record<Provider, number>>; // output tokens: drawn as a second, striped column beside the first
}

/** Striped overlay for output bars: surface-coloured diagonal lines over the provider colour. */
function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" />
      </pattern>
    </defs>
  );
}

export function Legend({ providers, inOut = false }: { providers: Provider[]; inOut?: boolean }) {
  return (
    <ul className="legend" aria-label="Legend">
      {providers.map((p) => (
        <li key={p}>
          <span className={`swatch series-${p}`} aria-hidden />
          {PROVIDER_LABELS[p]}
        </li>
      ))}
      {inOut && (
        <>
          {providers.length > 0 && <li className="legend-sep" aria-hidden />}
          <li>
            <span className="swatch swatch-in" aria-hidden />
            In
          </li>
          <li>
            <span className="swatch swatch-out" aria-hidden />
            Out
          </li>
        </>
      )}
    </ul>
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

  const hatch = useId().replace(/:/g, "");
  const height = 260;
  const paired = points.some((p) => p.out);
  const sum = (v: Partial<Record<Provider, number>> | undefined) => PROVIDERS.reduce((s, k) => s + (v?.[k] ?? 0), 0);
  const totals = points.map((p) => sum(p.values));
  const outTotals = points.map((p) => sum(p.out));
  const max = niceMax(Math.max(0, ...totals, ...outTotals));
  const m = { top: 12, right: 8, bottom: 28, left: axisMargin(max, formatTick) };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const y = (v: number) => (v / max) * innerH;
  const band = points.length ? innerW / points.length : 0;
  // Paired: input and output columns side by side, with a small gap between them.
  const barW = paired ? Math.max(2, Math.min(MAX_BAR * 0.75, band * 0.36)) : Math.max(2, Math.min(MAX_BAR, band * 0.7));
  const pairGap = paired ? Math.min(3, band * 0.04) : 0;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 64))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={paired ? "Input and output tokens over time, stacked by provider" : "Usage over time, stacked by provider"}>
          {paired && <Hatch id={hatch} />}
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
              /** One stacked column at x; `striped` lays the output hatch over each segment. */
              const column = (values: Partial<Record<Provider, number>> | undefined, x: number, striped: boolean) => {
                const present = PROVIDERS.filter((k) => (values?.[k] ?? 0) > 0);
                let base = 0; // running stack height in px
                return present.map((k, j) => {
                  const h = y(values?.[k] ?? 0);
                  const gap = j > 0 && h > GAP ? GAP : 0;
                  const segH = h - gap;
                  const top = innerH - base - h;
                  base += h;
                  const d = j === present.length - 1 ? topRounded(x, top, barW, segH, RADIUS) : null;
                  return (
                    <g key={k}>
                      {d ? <path d={d} className={`series-${k}`} /> : <rect x={x} y={top} width={barW} height={segH} className={`series-${k}`} />}
                      {striped && (d ? <path d={d} fill={`url(#${hatch})`} /> : <rect x={x} y={top} width={barW} height={segH} fill={`url(#${hatch})`} />)}
                    </g>
                  );
                });
              };
              return (
                <g key={p.label + i}>
                  {hover === i && <rect x={i * band} width={band} height={innerH} className="hover-wash" />}
                  {paired ? (
                    <>
                      {column(p.values, cx - pairGap / 2 - barW, false)}
                      {column(p.out, cx + pairGap / 2, true)}
                    </>
                  ) : (
                    column(p.values, cx - barW / 2, false)
                  )}
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
          {paired && (
            <div className="tooltip-row io tooltip-head">
              <span />
              <span />
              <span className="num">In</span>
              <span className="num">Out</span>
            </div>
          )}
          {PROVIDERS.filter((k) => points[hover].values[k] !== undefined || points[hover].out?.[k] !== undefined).map((k) => (
            <div key={k} className={`tooltip-row${paired ? " io" : ""}`}>
              <span className={`swatch series-${k}`} aria-hidden />
              <span>{PROVIDER_LABELS[k]}</span>
              <span className="num">{format(points[hover].values[k] ?? 0)}</span>
              {paired && <span className="num">{format(points[hover].out?.[k] ?? 0)}</span>}
            </div>
          ))}
          <div className={`tooltip-row total${paired ? " io" : ""}`}>
            <span />
            <span>Total</span>
            <span className="num">{format(totals[hover])}</span>
            {paired && <span className="num">{format(outTotals[hover])}</span>}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

export interface BarItem {
  label: string;
  provider: Provider;
  value: number; // input tokens when `out` is given
  out?: number; // output tokens: a second, striped bar under the first
  detail?: string;
}

export function HorizontalBars({ items, format }: { items: BarItem[]; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hatch = useId().replace(/:/g, "");

  const paired = items.some((i) => i.out !== undefined);
  const row = paired ? 40 : 32;
  const thick = paired ? 12 : 16;
  const labelW = Math.min(220, width * 0.4);
  const valueW = 90;
  const innerW = Math.max(0, width - labelW - valueW);
  const max = Math.max(0, ...items.map((i) => Math.max(i.value, i.out ?? 0))) || 1;
  const height = items.length * row + 4;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={paired ? "Input and output tokens" : "Usage by model"}>
          {paired && <Hatch id={hatch} />}
          <line x1={labelW} x2={labelW} y2={height} className="axis-line" />
          {items.map((it, i) => {
            /** One bar from the axis; `striped` for output. */
            const bar = (v: number, yTop: number, striped: boolean) => {
              const w = Math.max(v > 0 ? 2 : 0, (v / max) * innerW);
              const d = w > 0 ? rightRounded(labelW, yTop, w, thick, RADIUS) : null;
              return (
                <>
                  {d && <path d={d} className={`series-${it.provider}`} />}
                  {d && striped && <path d={d} fill={`url(#${hatch})`} />}
                  <text x={labelW + w + 6} y={yTop + thick / 2} dy="0.32em" className="bar-value">
                    {format(v)}
                  </text>
                </>
              );
            };
            const mid = i * row + row / 2;
            return (
              <g key={it.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {hover === i && <rect y={i * row} width={width} height={row} className="hover-wash" />}
                <text x={labelW - 8} y={mid} dy="0.32em" textAnchor="end" className="bar-label">
                  {it.label.length > 30 ? `${it.label.slice(0, 29)}…` : it.label}
                </text>
                {paired ? (
                  <>
                    {bar(it.value, mid - thick - 1, false)}
                    {bar(it.out ?? 0, mid + 1, true)}
                  </>
                ) : (
                  bar(it.value, mid - thick / 2, false)
                )}
                <rect y={i * row} width={width} height={row} fill="transparent" />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && items[hover] && (
        <Tooltip x={labelW + 40} y={hover * row + 30} containerWidth={width}>
          <strong>{items[hover].label}</strong>
          <div className="tooltip-row">
            <span className={`swatch series-${items[hover].provider}`} aria-hidden />
            <span>{PROVIDER_LABELS[items[hover].provider]}</span>
            <span className="num">{paired ? `${format(items[hover].value)} in · ${format(items[hover].out ?? 0)} out` : format(items[hover].value)}</span>
          </div>
          {items[hover].detail && <div className="muted small">{items[hover].detail}</div>}
        </Tooltip>
      )}
    </div>
  );
}
