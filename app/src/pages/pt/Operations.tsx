// PT Management → Operations: trip-log KPIs, trends, efficiency and exceptions (ported from ptManagement's
// operation monitoring), plus upload / manual entry / duplicates for edit access.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarList, ColumnChart, LineChart, PairedBarList, SeriesLegend, type BarItem, type Color, type PairItem, type Point } from "../../components/charts";
import { ErrorText } from "../../components/common";
import {
  api,
  canPt,
  type PtDataset,
  type PtEnergyTotals,
  type PtOperations,
  type PtSeverity,
  type PtTrial,
  type PtTrip,
  type PtTripFilter,
  type PtTripOptions,
  type User,
} from "../../lib/api";
import { errorMessage, formatInteger, LOCALE } from "../../lib/format";
import TripTools from "./TripTools";

type Preset = "30" | "90" | "all" | "custom";
/** Consumption by bus and route: the hot season (June–September, Abu Dhabi summer) against the mild season (October–May). */
const SEASON_SERIES: [{ label: string; color: Color }, { label: string; color: Color }] = [
  { label: "Hot season (Jun–Sep)", color: "c2" },
  { label: "Mild season (Oct–May)", color: "c1" },
];

export const SEVERITY_COLOR: Record<PtSeverity, Color> = { critical: "critical", serious: "serious", warning: "warning", info: "neutral" };
const ELECTRIC: Color = "c1";
const HYDROGEN: Color = "c2";
const DISTANCE: Color = "c3";
const SOC: Color = "c7";

const km = (v: number) => `${formatInteger(Math.round(v))} km`;
const fixed = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : v.toLocaleString(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
/** Scale top for a consumption line: the 95th percentile (with room for the threshold), so one bad day doesn't flatten it. */
function robustMax(values: (number | null)[], threshold: number) {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return undefined;
  return Math.max(threshold * 1.25, v[Math.floor(0.95 * (v.length - 1))] * 1.15);
}

const energyColor = (e: string): Color => (e === "Hydrogen" ? HYDROGEN : e === "Electric" ? ELECTRIC : "neutral");

function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function presetRange(p: Exclude<Preset, "custom">, o: PtTripOptions): { from: string; to: string } {
  const to = o.max_date ?? new Date().toISOString().slice(0, 10);
  if (p === "all") return { from: o.min_date ?? to, to };
  return { from: shiftDate(to, -(Number(p) - 1)), to };
}

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(LOCALE, { month: "short", year: "2-digit", timeZone: "UTC" });

type Grain = "day" | "week" | "month";

/** Monday of the ISO week containing the date. */
function weekStart(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The finest grouping that keeps the charts readable for a span of days. */
function autoGrain(days: number): Grain {
  return days <= 92 ? "day" : days <= 400 ? "week" : "month";
}

interface TrendPoint {
  start: string; // first and last day with data that the point covers
  end: string;
  label: string;
  title: string;
  trips: number;
  distance: number;
  electric: number | null;
  hydrogen: number | null;
}

/** Daily rows grouped by day, week or month (consumption recomputed from energy and distance totals, not averaged). */
function trendPoints(daily: PtOperations["daily"], grain: Grain): TrendPoint[] {
  const groups = new Map<string, { start: string; end: string; trips: number; distance: number; kwh: number; ekm: number; kg: number; hkm: number }>();
  for (const d of daily) {
    const k = grain === "day" ? d.date : grain === "week" ? weekStart(d.date) : d.date.slice(0, 7);
    const g = groups.get(k) ?? { start: d.date, end: d.date, trips: 0, distance: 0, kwh: 0, ekm: 0, kg: 0, hkm: 0 };
    g.end = d.date;
    g.trips += d.trips;
    g.distance += d.distance;
    if (d.electric_kwh && d.electric_per_100km) {
      g.kwh += d.electric_kwh;
      g.ekm += (d.electric_kwh / d.electric_per_100km) * 100;
    }
    if (d.hydrogen_kg && d.hydrogen_per_100km) {
      g.kg += d.hydrogen_kg;
      g.hkm += (d.hydrogen_kg / d.hydrogen_per_100km) * 100;
    }
    groups.set(k, g);
  }
  return [...groups].map(([k, g]) => ({
    start: g.start,
    end: g.end,
    label: grain === "month" ? monthLabel(k) : dayLabel(k),
    title:
      grain === "day"
        ? longDay(k)
        : grain === "week"
          ? `Week of ${longDay(k)}`
          : new Date(`${k}-01T00:00:00Z`).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }),
    trips: g.trips,
    distance: g.distance,
    electric: g.ekm ? (g.kwh / g.ekm) * 100 : null,
    hydrogen: g.hkm ? (g.kg / g.hkm) * 100 : null,
  }));
}

/**
 * The dashboard for fleet trips, or (dataset "trial") for trial buses' trips, with a trial picker.
 * `refreshKey` reloads everything when it changes (e.g. after a trial is added on the Trials page).
 */
export default function Operations({
  user,
  dataset = "fleet",
  trials = [],
  refreshKey = 0,
}: {
  user: User;
  dataset?: PtDataset;
  trials?: PtTrial[];
  refreshKey?: number;
}) {
  const isTrial = dataset === "trial";
  const [options, setOptions] = useState<PtTripOptions | null>(null);
  const [preset, setPreset] = useState<Preset>(isTrial ? "all" : "90");
  const [filter, setFilter] = useState<PtTripFilter | null>(null);
  const [data, setData] = useState<PtOperations | null>(null);
  // Trials: the fleet's daily figures over the same dates, drawn as a comparison line.
  const [fleetDaily, setFleetDaily] = useState<PtOperations["daily"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<string>("any");
  const [tripsOpen, setTripsOpen] = useState(false);
  // Period shown in the trend charts (inside the filter range); null = the whole range.
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [grainChoice, setGrainChoice] = useState<Grain | "auto">("auto");
  const [version, setVersion] = useState(0); // bumped after uploads so everything reloads

  const loadOptions = useCallback(async () => {
    try {
      const o = await api.ptTripOptions(dataset);
      setOptions(o);
      setFilter((f) => f ?? { ...presetRange(isTrial ? "all" : "90", o), ...(isTrial ? { dataset: "trial" as const } : {}) });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [dataset, isTrial]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions, version, refreshKey]);

  useEffect(() => setPeriod(null), [filter]);

  useEffect(() => {
    if (!filter) return;
    let stale = false;
    setError(null);
    api.ptOperations(filter).then(
      (d) => !stale && setData(d),
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [filter, version, refreshKey]);

  useEffect(() => {
    if (!isTrial || !filter) return;
    let stale = false;
    api.ptOperations({ from: filter.from, to: filter.to, energy: filter.energy }).then(
      (d) => !stale && setFleetDaily(d.daily),
      () => !stale && setFleetDaily(null), // the comparison is optional
    );
    return () => {
      stale = true;
    };
  }, [isTrial, filter?.from, filter?.to, filter?.energy, version]); // eslint-disable-line react-hooks/exhaustive-deps

  function choosePreset(p: Preset) {
    setPreset(p);
    if (p !== "custom" && options && filter) setFilter({ ...filter, ...presetRange(p, options) });
  }

  const issueInfo = useMemo(() => new Map(options?.issues.map((i) => [i.code, i]) ?? []), [options]);
  const shownFrom = period?.from ?? filter?.from ?? "";
  const shownTo = period?.to ?? filter?.to ?? "";
  const shownDays = shownFrom ? (Date.parse(shownTo) - Date.parse(shownFrom)) / 86400000 + 1 : 0;
  const grain: Grain = grainChoice === "auto" ? autoGrain(shownDays) : grainChoice;
  const trend = useMemo(
    () => (data ? trendPoints(data.daily.filter((d) => d.date >= shownFrom && d.date <= shownTo), grain) : []),
    [data, shownFrom, shownTo, grain],
  );
  // Fleet comparison, grouped the same way and matched by period.
  const fleetTrend = useMemo(() => {
    if (!fleetDaily) return null;
    const pts = trendPoints(
      fleetDaily.filter((d) => d.date >= shownFrom && d.date <= shownTo),
      grain,
    );
    return new Map(pts.map((p) => [p.title, p]));
  }, [fleetDaily, shownFrom, shownTo, grain]);
  const zoom = (i: number, j: number) => {
    if (!trend[i] || !trend[j]) return;
    setPeriod({ from: trend[i].start, to: trend[j].end });
    setGrainChoice("auto");
  };

  if (!options || !filter) {
    return error ? <ErrorText message={error} /> : <p className="muted">Loading…</p>;
  }

  const electric = data?.by_energy.find((e) => e.energy === "Electric");
  const hydrogen = data?.by_energy.find((e) => e.energy === "Hydrogen");
  const exceptionTotal = data ? Object.entries(data.exceptions).reduce((n, [k, v]) => (k === "low_start_soc" ? n : n + v), 0) : 0;
  const t = options.thresholds;

  const distancePoints: Point[] = trend.map((p) => ({ label: p.label, title: p.title, values: { distance: p.distance } }));
  const consumptionPoints = (key: "electric" | "hydrogen"): Point[] =>
    trend.map((p) => ({ label: p.label, title: p.title, values: { [key]: p[key], fleet: fleetTrend?.get(p.title)?.[key] ?? null } }));
  const consumptionSeries = (key: "electric" | "hydrogen", label: string, color: Color) =>
    isTrial && fleetTrend ? [{ key, label: "This trial", color }, { key: "fleet", label: "Fleet average", color: "neutral" as Color }] : [{ key, label, color }];

  // Sorted by the hot season (the higher, A/C-loaded figure), falling back to mild when a bus has no summer trips.
  const busPairs = (energy: string): PairItem[] =>
    (data?.by_bus ?? [])
      .filter((b) => b.energy === energy && (b.consumption_hot !== null || b.consumption_mild !== null))
      .sort((a, b) => (b.consumption_hot ?? b.consumption_mild ?? 0) - (a.consumption_hot ?? a.consumption_mild ?? 0))
      .map((b) => ({
        key: String(b.bus_id),
        label: `Bus ${b.label}${b.model ? ` · ${b.model}` : ""}`,
        a: b.consumption_hot,
        b: b.consumption_mild,
        detail: `All year ${fixed(b.consumption, energy === "Hydrogen" ? 2 : 1)} · ${formatInteger(b.trips)} trips · ${km(b.distance)}`,
      }));

  const routeBars: BarItem[] = (data?.by_route ?? []).slice(0, 10).map((r) => ({
    key: r.route,
    label: `Route ${r.route}`,
    value: r.distance,
    color: DISTANCE,
    detail: `${formatInteger(r.trips)} trips on ${r.buses} bus(es) · avg ${fixed(r.avg_trip_km)} km per trip`,
  }));

  const exceptionBars: BarItem[] = options.issues.map((i) => {
    const buses = data?.exception_buses[i.code] ?? [];
    return {
      key: i.code,
      label: i.label,
      value: data?.exceptions[i.code] ?? 0,
      color: SEVERITY_COLOR[i.severity],
      detail: (
        <>
          <div className="muted">
            {i.severity === "info" ? "Informational: not counted as an exception" : `${i.severity[0].toUpperCase()}${i.severity.slice(1)}`}
            {buses.length > 0 && ` · ${buses.length} bus${buses.length === 1 ? "" : "es"}`}
          </div>
          {buses.slice(0, 10).map((b) => (
            <div key={b.bus_id} className="tooltip-row">
              <span />
              <span>Bus {b.label}</span>
              <span className="num">
                {formatInteger(b.trips)} trip{b.trips === 1 ? "" : "s"}
              </span>
            </div>
          ))}
          {buses.length > 10 && <div className="muted">and {buses.length - 10} more</div>}
        </>
      ),
    };
  });

  const routePairs = (energy: "electric" | "hydrogen"): PairItem[] =>
    (data?.by_route ?? [])
      .filter((r) => r[`${energy}_hot`] !== null || r[`${energy}_mild`] !== null)
      .sort((a, b) => (b[`${energy}_hot`] ?? b[`${energy}_mild`] ?? 0) - (a[`${energy}_hot`] ?? a[`${energy}_mild`] ?? 0))
      .map((r) => ({
        key: r.route,
        label: `Route ${r.route}`,
        a: r[`${energy}_hot`],
        b: r[`${energy}_mild`],
        detail: `All year ${fixed(r[`${energy}_per_100km`], energy === "hydrogen" ? 2 : 1)} · ${formatInteger(r.trips)} trips on ${r.buses} bus(es) · ${km(r.distance)}`,
      }));
  const electricRoutes = routePairs("electric");
  const hydrogenRoutes = routePairs("hydrogen");

  const socPoints: Point[] = (data?.soc_drop_bands ?? []).map((b) => ({
    label: `${b.band}–${b.band + 10}%`,
    title: `SOC drop ${b.band}–${b.band + 10}%`,
    values: { trips: b.trips },
  }));

  return (
    <div className="stack">
      <div className="filters row wrap">
        <label className="field inline">
          <span>Range</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
            <option value="30">Last 30 days of data</option>
            <option value="90">Last 90 days of data</option>
            <option value="all">All data</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="field inline">
              <span>From</span>
              <input type="date" value={filter.from} max={filter.to} onChange={(e) => e.target.value && setFilter({ ...filter, from: e.target.value })} />
            </label>
            <label className="field inline">
              <span>To</span>
              <input type="date" value={filter.to} min={filter.from} onChange={(e) => e.target.value && setFilter({ ...filter, to: e.target.value })} />
            </label>
          </>
        )}
        {isTrial && (
          <label className="field inline">
            <span>Trial</span>
            <select value={filter.trial ?? ""} onChange={(e) => setFilter({ ...filter, trial: e.target.value || undefined })}>
              <option value="">All trials</option>
              {trials.map((t) => (
                <option key={t.trial_id} value={t.trial_id}>
                  {t.trial_name}
                  {t.bus_label ? ` · ${t.bus_label}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field inline">
          <span>Energy</span>
          <select value={filter.energy ?? ""} onChange={(e) => setFilter({ ...filter, energy: e.target.value || undefined, bus: undefined })}>
            <option value="">All</option>
            <option>Electric</option>
            <option>Hydrogen</option>
          </select>
        </label>
        <label className="field inline">
          <span>Bus</span>
          <select value={filter.bus ?? ""} onChange={(e) => setFilter({ ...filter, bus: e.target.value || undefined })}>
            <option value="">All buses</option>
            {options.buses
              .filter((b) => !filter.energy || b.energy === filter.energy)
              .map((b) => (
                <option key={b.bus_id} value={b.bus_id}>
                  {b.label}
                  {b.model ? ` · ${b.model}` : ""}
                </option>
              ))}
          </select>
        </label>
        <label className="field inline">
          <span>Route</span>
          <select value={filter.route ?? ""} onChange={(e) => setFilter({ ...filter, route: e.target.value || undefined })}>
            <option value="">All routes</option>
            {options.routes.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <span className="subtle align-end">
          Data: {options.min_date ?? "—"} to {options.max_date ?? "—"} · {formatInteger(options.trips)} trips
        </span>
      </div>

      <ErrorText message={error} />

      {data && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Trips</span>
              <span className="tile-value">{formatInteger(data.totals.trips)}</span>
              <span className="muted small">
                {data.totals.buses} buses · {data.totals.drivers} drivers · {data.totals.days} days
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Distance</span>
              <span className="tile-value">{km(data.totals.distance)}</span>
              {data.totals.excluded_trips > 0 && <span className="muted small">{data.totals.excluded_trips} trip(s) with impossible distance left out</span>}
            </div>
            {electric && (
              <div className="tile">
                <span className="tile-label">
                  <span className="swatch bg-c1" aria-hidden /> Electric consumption
                </span>
                <span className="tile-value">
                  {fixed(electric.consumption)} <span className="small">kWh/100 km</span>
                </span>
                <span className="muted small">
                  {fixed(electric.energy_used, 0)} kWh over {km(electric.distance ?? 0)}
                </span>
                <SeasonSplit e={electric} digits={1} />
              </div>
            )}
            {hydrogen && (
              <div className="tile">
                <span className="tile-label">
                  <span className="swatch bg-c2" aria-hidden /> Hydrogen consumption
                </span>
                <span className="tile-value">
                  {fixed(hydrogen.consumption, 2)} <span className="small">kg/100 km</span>
                </span>
                <span className="muted small">
                  {fixed(hydrogen.energy_used, 0)} kg over {km(hydrogen.distance ?? 0)}
                </span>
                <SeasonSplit e={hydrogen} digits={2} />
              </div>
            )}
            <div className="tile">
              <span className="tile-label">Exceptions</span>
              <span className="tile-value">{formatInteger(exceptionTotal)}</span>
              <span className="muted small">
                avg SOC drop {fixed(data.totals.avg_soc_drop)}% · lowest end {fixed(data.totals.min_end_soc, 0)}%
              </span>
            </div>
          </div>

          {data.totals.trips === 0 ? (
            <p className="muted">No trips match these filters.</p>
          ) : (
            <>
              <div className="card stack">
                <div className="row space-between wrap">
                  <h2>Trends</h2>
                  <div className="row wrap">
                    <label className="field inline">
                      <span>From</span>
                      <input
                        type="date"
                        value={shownFrom}
                        min={filter.from}
                        max={shownTo}
                        onChange={(e) => e.target.value && setPeriod({ from: e.target.value, to: shownTo })}
                      />
                    </label>
                    <label className="field inline">
                      <span>To</span>
                      <input
                        type="date"
                        value={shownTo}
                        min={shownFrom}
                        max={filter.to}
                        onChange={(e) => e.target.value && setPeriod({ from: shownFrom, to: e.target.value })}
                      />
                    </label>
                    <div className="field inline">
                      <span>Group by</span>
                      <div className="segmented" role="group" aria-label="Time grouping">
                        {(["auto", "day", "week", "month"] as const).map((g) => (
                          <button key={g} className={grainChoice === g ? "on" : ""} aria-pressed={grainChoice === g} onClick={() => setGrainChoice(g)}>
                            {g === "auto" ? `Auto (${grain})` : g[0].toUpperCase() + g.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    {period && (
                      <button className="small-btn align-end" onClick={() => setPeriod(null)}>
                        Reset zoom
                      </button>
                    )}
                  </div>
                </div>
                <p className="muted small">Drag across any trend chart to zoom in on that period; grouping gets finer automatically.</p>
                <h3>Distance by {grain}</h3>
                {trend.length === 0 ? (
                  <p className="muted">No trips in this period.</p>
                ) : (
                  <ColumnChart
                    points={distancePoints}
                    series={[{ key: "distance", label: "Distance", color: DISTANCE }]}
                    format={km}
                    formatTick={(v) => formatInteger(v)}
                    label="Distance over time"
                    onZoom={zoom}
                  />
                )}
              </div>

              <div className="chart-grid">
                {electric && (
                  <div className="card stack">
                    <h2>Electric consumption (kWh/100 km)</h2>
                    <LineChart
                      points={consumptionPoints("electric")}
                      series={consumptionSeries("electric", "Electric", ELECTRIC)}
                      format={(v) => `${fixed(v)} kWh/100 km`}
                      formatTick={(v) => formatInteger(v)}
                      reference={{ value: t.high_kwh_per_100km, label: `high: ${t.high_kwh_per_100km}` }}
                      maxValue={robustMax(trend.map((p) => p.electric), t.high_kwh_per_100km)}
                      label="Electric consumption over time"
                      onZoom={zoom}
                    />
                    {isTrial && fleetTrend && (
                      <SeriesLegend series={[{ label: "This trial", color: ELECTRIC }, { label: "Fleet average (same days)", color: "neutral" }]} />
                    )}
                  </div>
                )}
                {hydrogen && (
                  <div className="card stack">
                    <h2>Hydrogen consumption (kg/100 km)</h2>
                    <LineChart
                      points={consumptionPoints("hydrogen")}
                      series={consumptionSeries("hydrogen", "Hydrogen", HYDROGEN)}
                      format={(v) => `${fixed(v, 2)} kg/100 km`}
                      formatTick={(v) => fixed(v, 0)}
                      reference={{ value: t.high_kg_per_100km, label: `high: ${t.high_kg_per_100km}` }}
                      maxValue={robustMax(trend.map((p) => p.hydrogen), t.high_kg_per_100km)}
                      label="Hydrogen consumption over time"
                      onZoom={zoom}
                    />
                    {isTrial && fleetTrend && (
                      <SeriesLegend series={[{ label: "This trial", color: HYDROGEN }, { label: "Fleet average (same days)", color: "neutral" }]} />
                    )}
                  </div>
                )}
              </div>

              <p className="muted small">
                Consumption by bus and by route: hot season (June–September, Abu Dhabi summer, heavy air-conditioning load) against the mild season
                (October–May), with the summer change on the right.
              </p>
              <div className="chart-grid">
                {(["Electric", "Hydrogen"] as const).map((energy) => {
                  const pairs = busPairs(energy);
                  if (!pairs.length) return null;
                  return (
                    <div key={energy} className="card stack">
                      <h2>
                        {energy} buses: consumption ({energy === "Hydrogen" ? "kg" : "kWh"}/100 km)
                      </h2>
                      <PairedBarList
                        items={pairs}
                        series={SEASON_SERIES}
                        format={(v) => fixed(v, energy === "Hydrogen" ? 2 : 1)}
                        label={`${energy} consumption by bus, hot season against mild season`}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="chart-grid">
                <div className="card stack">
                  <h2>Exceptions by type</h2>
                  <p className="muted small">
                    High consumption: over {t.high_kwh_per_100km} kWh/100 km (electric) or {t.high_kg_per_100km} kg/100 km (hydrogen). Click a bar to list the trips.
                  </p>
                  <BarList
                    items={exceptionBars}
                    format={(v) => formatInteger(v)}
                    label="Trip exceptions by type"
                    onSelect={(it) => {
                      setIssue(it.key);
                      setTripsOpen(true);
                      requestAnimationFrame(() => document.getElementById("pt-trips")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                    }}
                  />
                  <SeriesLegend
                    series={[
                      { label: "Data error", color: "critical" },
                      { label: "Serious", color: "serious" },
                      { label: "Warning", color: "warning" },
                      { label: "Info", color: "neutral" },
                    ]}
                  />
                </div>
                <div className="card stack">
                  <h2>SOC drop per trip</h2>
                  <ColumnChart points={socPoints} series={[{ key: "trips", label: "Trips", color: SOC }]} format={(v) => `${formatInteger(v)} trips`} formatTick={(v) => formatInteger(v)} height={200} label="Distribution of SOC drop per trip" />
                </div>
              </div>

              <div className="chart-grid">
                {(electricRoutes.length > 0 || hydrogenRoutes.length > 0) && (
                  <div className="card stack">
                    <h2>Energy consumption by route</h2>
                    {electricRoutes.length > 0 && (
                      <>
                        <h3>
                          Electric (kWh/100 km)
                        </h3>
                        <PairedBarList items={electricRoutes} series={SEASON_SERIES} format={(v) => fixed(v)} label="Electric consumption by route, hot season against mild season" />
                      </>
                    )}
                    {hydrogenRoutes.length > 0 && (
                      <>
                        <h3>
                          Hydrogen (kg/100 km)
                        </h3>
                        <PairedBarList items={hydrogenRoutes} series={SEASON_SERIES} format={(v) => fixed(v, 2)} label="Hydrogen consumption by route, hot season against mild season" />
                      </>
                    )}
                  </div>
                )}
                <div className="card stack">
                  <h2>Distance by route{data.by_route.length > 10 ? " (top 10)" : ""}</h2>
                  <BarList items={routeBars} format={km} label="Distance by route" onSelect={(it) => setFilter({ ...filter, route: it.key === "(none)" ? undefined : it.key })} />
                </div>
              </div>

              <BusTable data={data} />
            </>
          )}

          <TripList
            filter={filter}
            issue={issue}
            onIssue={setIssue}
            options={options}
            issueInfo={issueInfo}
            version={version}
            open={tripsOpen}
            onToggle={setTripsOpen}
          />
        </>
      )}

      {canPt(user, isTrial ? "planning" : "operations", "add") && (
        <TripTools
          user={user}
          options={options}
          dataset={dataset}
          trials={trials}
          defaultTrial={filter.trial}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

function BusTable({ data }: { data: PtOperations }) {
  return (
    <details className="card">
      <summary>Per-bus summary ({data.by_bus.length} buses)</summary>
      <table className="data-table pt-tables">
        <thead>
          <tr>
            <th className="num">Bus</th>
            <th>Model</th>
            <th>Energy</th>
            <th className="num">Trips</th>
            <th className="num">Days</th>
            <th className="num">Distance</th>
            <th className="num">Energy used</th>
            <th className="num">Per 100 km</th>
            <th className="num">Avg SOC drop</th>
            <th className="num">Lowest end SOC</th>
            <th className="num">Exceptions</th>
          </tr>
        </thead>
        <tbody>
          {data.by_bus.map((b) => (
            <tr key={b.bus_id}>
              <td className="num mono">{b.label}</td>
              <td>{b.model ?? <span className="muted">not in fleet</span>}</td>
              <td>
                <span className={`swatch bg-${energyColor(b.energy)}`} aria-hidden /> {b.energy}
              </td>
              <td className="num">{formatInteger(b.trips)}</td>
              <td className="num">{b.days}</td>
              <td className="num">{km(b.distance)}</td>
              <td className="num">{b.energy_used === null ? "—" : `${fixed(b.energy_used, 0)} ${b.unit}`}</td>
              <td className="num">{b.consumption === null ? "—" : `${fixed(b.consumption, b.unit === "kg" ? 2 : 1)} ${b.unit}`}</td>
              <td className="num">{fixed(b.avg_soc_drop)}%</td>
              <td className="num">{fixed(b.min_end_soc, 0)}%</td>
              <td className="num">{formatInteger(b.exceptions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const PAGE = 100;

function TripList({
  filter,
  issue,
  onIssue,
  options,
  issueInfo,
  version,
  open,
  onToggle,
}: {
  filter: PtTripFilter;
  issue: string;
  onIssue: (i: string) => void;
  options: PtTripOptions;
  issueInfo: Map<string, PtTripOptions["issues"][number]>;
  version: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ total: number; rows: PtTrip[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPage(0), [filter, issue]);

  useEffect(() => {
    if (!open) return; // loaded when unfolded
    let stale = false;
    setError(null);
    api.ptTrips({ ...filter, issue: issue || undefined, limit: PAGE, offset: page * PAGE }).then(
      (r) => !stale && setResult(r),
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [filter, issue, page, version, open]);

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE)) : 1;

  const showing = issue === "" ? "all trips" : issue === "any" ? "trips with exceptions" : (issueInfo.get(issue)?.label.toLowerCase() ?? issue);
  return (
    <details id="pt-trips" className="card" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>
        Trips{" "}
        <span className="muted small">
          ({showing}
          {result && open ? `: ${formatInteger(result.total)}` : ""})
        </span>
      </summary>
      <div className="stack pt-tables">
      <div className="row space-between wrap">
        <span />
        <label className="field inline">
          <span>Show</span>
          <select value={issue} onChange={(e) => onIssue(e.target.value)}>
            <option value="">All trips</option>
            <option value="any">Trips with exceptions</option>
            {options.issues.map((i) => (
              <option key={i.code} value={i.code}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText message={error} />
      {result && (
        <>
          <p className="muted small">
            {formatInteger(result.total)} trip(s){result.total > PAGE ? ` · page ${page + 1} of ${pages}` : ""}
          </p>
          {result.rows.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Bus</th>
                    <th>Route</th>
                    <th className="num">Driver</th>
                    <th>Time</th>
                    <th className="num">Distance</th>
                    <th className="num">SOC</th>
                    <th className="num">Energy</th>
                    <th className="num">Per 100 km</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => {
                    const unit = r.energy === "Hydrogen" ? "kg" : "kWh";
                    return (
                      <tr key={r.trip_id}>
                        <td className="nowrap">{r.date}</td>
                        <td className="num mono">{r.bus_label ?? r.bus_id ?? "—"}</td>
                        <td>{r.route ?? "—"}</td>
                        <td className="num mono">{r.driver_id ?? "—"}</td>
                        <td className="mono nowrap">
                          {r.start_time?.slice(0, 5) ?? "?"}–{r.end_time?.slice(0, 5) ?? "?"}
                        </td>
                        <td className="num">{r.distance === null ? "—" : km(r.distance)}</td>
                        <td className="num">
                          {fixed(r.start_soc, 0)} → {fixed(r.end_soc, 0)}%
                        </td>
                        <td className="num">{r.energy_used === null ? "—" : `${fixed(r.energy_used)} ${unit}`}</td>
                        <td className="num">{r.energy_consumption === null ? "—" : fixed(r.energy_consumption, unit === "kg" ? 2 : 1)}</td>
                        <td>
                          {r.issues.map((code) => {
                            const info = issueInfo.get(code);
                            return (
                              <span key={code} className={`badge badge-${info?.severity ?? "info"}`}>
                                {info?.label ?? code}
                              </span>
                            );
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="row">
              <button className="small-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ← Newer
              </button>
              <button className="small-btn" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                Older →
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </details>
  );
}

/** A consumption tile's hot-season / mild-season figures (each only when that season has trips in range). */
function SeasonSplit({ e, digits }: { e: PtEnergyTotals; digits: number }) {
  if (e.consumption_hot === null && e.consumption_mild === null) return null;
  return (
    <span className="season-split small">
      <span className="season-hot">
        Hot (Jun–Sep) <strong>{fixed(e.consumption_hot, digits)}</strong>
      </span>
      <span>
        Mild (Oct–May) <strong>{fixed(e.consumption_mild, digits)}</strong>
      </span>
    </span>
  );
}
