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
import { errorMessage, formatDay, formatInteger, LOCALE } from "../../lib/format";
import TripTools from "./TripTools";
import { t, tn } from "../../lib/i18n";

type Preset = "30" | "90" | "all" | "custom";
/** Consumption by bus and route: the hot season (June–September, Abu Dhabi summer) against the mild season (October–May). */
/** The season names in the app's language. */
const seasonSeries = () => SEASON_SERIES.map((s) => ({ ...s, label: t(s.label) })) as typeof SEASON_SERIES;
const SEASON_SERIES: [{ label: string; color: Color }, { label: string; color: Color }] = [
  { label: "Hot season (Jun–Sep)", color: "c2" },
  { label: "Mild season (Oct–May)", color: "c1" },
];

export const SEVERITY_COLOR: Record<PtSeverity, Color> = { critical: "critical", serious: "serious", warning: "warning", info: "neutral" };
const ELECTRIC: Color = "c1";
const HYDROGEN: Color = "c2";
const DISTANCE: Color = "c3";
const SOC: Color = "c7";

const km = (v: number) => t("{n} km", { n: formatInteger(Math.round(v)) });
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
          ? t("Week of {k}", { k: longDay(k) })
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
    return error ? <ErrorText message={error} /> : <p className="muted">{t("Loading…")}</p>;
  }

  const electric = data?.by_energy.find((e) => e.energy === "Electric");
  const hydrogen = data?.by_energy.find((e) => e.energy === "Hydrogen");
  const exceptionTotal = data ? Object.entries(data.exceptions).reduce((n, [k, v]) => (k === "low_start_soc" ? n : n + v), 0) : 0;
  const thresholds = options.thresholds;

  const distancePoints: Point[] = trend.map((p) => ({ label: p.label, title: p.title, values: { distance: p.distance } }));
  const consumptionPoints = (key: "electric" | "hydrogen"): Point[] =>
    trend.map((p) => ({ label: p.label, title: p.title, values: { [key]: p[key], fleet: fleetTrend?.get(p.title)?.[key] ?? null } }));
  const consumptionSeries = (key: "electric" | "hydrogen", label: string, color: Color) =>
    isTrial && fleetTrend ? [{ key, label: t("This trial"), color }, { key: "fleet", label: t("Fleet average"), color: "neutral" as Color }] : [{ key, label: t(label), color }];

  // Sorted by the hot season (the higher, A/C-loaded figure), falling back to mild when a bus has no summer trips.
  const busPairs = (energy: string): PairItem[] =>
    (data?.by_bus ?? [])
      .filter((b) => b.energy === energy && (b.consumption_hot !== null || b.consumption_mild !== null))
      .sort((a, b) => (b.consumption_hot ?? b.consumption_mild ?? 0) - (a.consumption_hot ?? a.consumption_mild ?? 0))
      .map((b) => ({
        key: String(b.bus_id),
        label: t("Bus {label}", { label: b.label }) + (b.model ? ` · ${b.model}` : ""),
        a: b.consumption_hot,
        b: b.consumption_mild,
        detail: t("All year {consumption} · {trips} trips · {distance}", { consumption: fixed(b.consumption, energy === "Hydrogen" ? 2 : 1), trips: formatInteger(b.trips), distance: km(b.distance) }),
      }));

  const routeBars: BarItem[] = (data?.by_route ?? []).slice(0, 10).map((r) => ({
    key: r.route,
    label: t("Route {route}", { route: r.route }),
    value: r.distance,
    color: DISTANCE,
    detail: t("{trips} trips on {buses} bus(es) · avg {avg_trip_km} km per trip", { trips: formatInteger(r.trips), buses: r.buses, avg_trip_km: fixed(r.avg_trip_km) }),
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
            {i.severity === "info" ? t("Informational: not counted as an exception") : t(`${i.severity[0].toUpperCase()}${i.severity.slice(1)}`)}
            {buses.length > 0 && ` · ${tn(buses.length, "{n} bus", "{n} buses")}`}
          </div>
          {buses.slice(0, 10).map((b) => (
            <div key={b.bus_id} className="tooltip-row">
              <span />
              <span>{t("Bus {label}", { label: b.label })}</span>
              <span className="num">{t("{trips} trip{v}", { trips: formatInteger(b.trips), v: b.trips === 1 ? "" : "s" })}</span>
            </div>
          ))}
          {buses.length > 10 && <div className="muted">{t("and {v} more", { v: buses.length - 10 })}</div>}
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
        label: t("Route {route}", { route: r.route }),
        a: r[`${energy}_hot`],
        b: r[`${energy}_mild`],
        detail: t("All year {consumption} · {trips} trips on {buses} bus(es) · {distance}", { consumption: fixed(r[`${energy}_per_100km`], energy === "hydrogen" ? 2 : 1), trips: formatInteger(r.trips), buses: r.buses, distance: km(r.distance) }),
      }));
  const electricRoutes = routePairs("electric");
  const hydrogenRoutes = routePairs("hydrogen");

  const socPoints: Point[] = (data?.soc_drop_bands ?? []).map((b) => ({
    label: `${b.band}–${b.band + 10}%`,
    title: t("SOC drop {band}–{v}%", { band: b.band, v: b.band + 10 }),
    values: { trips: b.trips },
  }));

  return (
    <div className="stack">
      <div className="filters row wrap">
        <label className="field inline">
          <span>{t("Range")}</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
            <option value="30">{t("Last 30 days of data")}</option>
            <option value="90">{t("Last 90 days of data")}</option>
            <option value="all">{t("All data")}</option>
            <option value="custom">{t("Custom…")}</option>
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="field inline">
              <span>{t("From")}</span>
              <input type="date" value={filter.from} max={filter.to} onChange={(e) => e.target.value && setFilter({ ...filter, from: e.target.value })} />
            </label>
            <label className="field inline">
              <span>{t("To")}</span>
              <input type="date" value={filter.to} min={filter.from} onChange={(e) => e.target.value && setFilter({ ...filter, to: e.target.value })} />
            </label>
          </>
        )}
        {isTrial && (
          <label className="field inline">
            <span>{t("Trial")}</span>
            <select value={filter.trial ?? ""} onChange={(e) => setFilter({ ...filter, trial: e.target.value || undefined })}>
              <option value="">{t("All trials")}</option>
              {trials.map((trialItem) => (
                <option key={trialItem.trial_id} value={trialItem.trial_id}>
                  {trialItem.trial_name}
                  {trialItem.bus_label ? ` · ${trialItem.bus_label}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field inline">
          <span>{t("Energy")}</span>
          <select value={filter.energy ?? ""} onChange={(e) => setFilter({ ...filter, energy: e.target.value || undefined, bus: undefined })}>
            <option value="">{t("All")}</option>
            <option>{t("Electric")}</option>
            <option>{t("Hydrogen")}</option>
          </select>
        </label>
        <label className="field inline">
          <span>{t("Bus")}</span>
          <select value={filter.bus ?? ""} onChange={(e) => setFilter({ ...filter, bus: e.target.value || undefined })}>
            <option value="">{t("All buses")}</option>
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
          <span>{t("Route")}</span>
          <select value={filter.route ?? ""} onChange={(e) => setFilter({ ...filter, route: e.target.value || undefined })}>
            <option value="">{t("All routes")}</option>
            {options.routes.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <span className="subtle align-end">{t("Data: {v} to {v2} · {trips} trips", { v: formatDay(options.min_date), v2: formatDay(options.max_date), trips: formatInteger(options.trips) })}</span>
      </div>

      <ErrorText message={error} />

      {data && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">{t("Trips")}</span>
              <span className="tile-value">{formatInteger(data.totals.trips)}</span>
              <span className="muted small">{t("{buses} buses · {drivers} drivers · {days} days", { buses: data.totals.buses, drivers: data.totals.drivers, days: data.totals.days })}</span>
            </div>
            <div className="tile">
              <span className="tile-label">{t("Distance")}</span>
              <span className="tile-value">{km(data.totals.distance)}</span>
              {data.totals.excluded_trips > 0 && <span className="muted small">{t("{excluded_trips} trip(s) with impossible distance left out", { excluded_trips: data.totals.excluded_trips })}</span>}
            </div>
            {electric && (
              <div className="tile">
                <span className="tile-label">
                  <span className="swatch bg-c1" aria-hidden /> {t("Electric consumption")}
                </span>
                <span className="tile-value">
                  {fixed(electric.consumption)} <span className="small">{t("kWh/100 km")}</span>
                </span>
                <span className="muted small">{t("{energy_used} kWh over {km}", { energy_used: fixed(electric.energy_used, 0), km: km(electric.distance ?? 0) })}</span>
                <SeasonSplit e={electric} digits={1} />
              </div>
            )}
            {hydrogen && (
              <div className="tile">
                <span className="tile-label">
                  <span className="swatch bg-c2" aria-hidden /> {t("Hydrogen consumption")}
                </span>
                <span className="tile-value">
                  {fixed(hydrogen.consumption, 2)} <span className="small">{t("kg/100 km")}</span>
                </span>
                <span className="muted small">{t("{energy_used} kg over {km}", { energy_used: fixed(hydrogen.energy_used, 0), km: km(hydrogen.distance ?? 0) })}</span>
                <SeasonSplit e={hydrogen} digits={2} />
              </div>
            )}
            <div className="tile">
              <span className="tile-label">{t("Exceptions")}</span>
              <span className="tile-value">{formatInteger(exceptionTotal)}</span>
              <span className="muted small">{t("avg SOC drop {avg_soc_drop}% · lowest end {min_end_soc}%", { avg_soc_drop: fixed(data.totals.avg_soc_drop), min_end_soc: fixed(data.totals.min_end_soc, 0) })}</span>
            </div>
          </div>

          {data.totals.trips === 0 ? (
            <p className="muted">{t("No trips match these filters.")}</p>
          ) : (
            <>
              <div className="card stack">
                <div className="row space-between wrap">
                  <h2>{t("Trends")}</h2>
                  <div className="row wrap">
                    <label className="field inline">
                      <span>{t("From")}</span>
                      <input
                        type="date"
                        value={shownFrom}
                        min={filter.from}
                        max={shownTo}
                        onChange={(e) => e.target.value && setPeriod({ from: e.target.value, to: shownTo })}
                      />
                    </label>
                    <label className="field inline">
                      <span>{t("To")}</span>
                      <input
                        type="date"
                        value={shownTo}
                        min={shownFrom}
                        max={filter.to}
                        onChange={(e) => e.target.value && setPeriod({ from: shownFrom, to: e.target.value })}
                      />
                    </label>
                    <div className="field inline">
                      <span>{t("Group by")}</span>
                      <div className="segmented" role="group" aria-label={t("Time grouping")}>
                        {(["auto", "day", "week", "month"] as const).map((g) => (
                          <button key={g} className={grainChoice === g ? "on" : ""} aria-pressed={grainChoice === g} onClick={() => setGrainChoice(g)}>
                            {g === "auto" ? t("Auto ({grain})", { grain: t(grain) }) : t(g[0].toUpperCase() + g.slice(1))}
                          </button>
                        ))}
                      </div>
                    </div>
                    {period && (
                      <button className="small-btn align-end" onClick={() => setPeriod(null)}>
                        {t("Reset zoom")}
                      </button>
                    )}
                  </div>
                </div>
                <p className="muted small">{t("Drag across any trend chart to zoom in on that period; grouping gets finer automatically.")}</p>
                <h3>{t("Distance by {grain}", { grain: t(grain) })}</h3>
                {trend.length === 0 ? (
                  <p className="muted">{t("No trips in this period.")}</p>
                ) : (
                  <ColumnChart
                    points={distancePoints}
                    series={[{ key: "distance", label: t("Distance"), color: DISTANCE }]}
                    format={km}
                    formatTick={(v) => formatInteger(v)}
                    label={t("Distance over time")}
                    onZoom={zoom}
                  />
                )}
              </div>

              <div className="chart-grid">
                {electric && (
                  <div className="card stack">
                    <h2>{t("Electric consumption (kWh/100 km)")}</h2>
                    <LineChart
                      points={consumptionPoints("electric")}
                      series={consumptionSeries("electric", "Electric", ELECTRIC)}
                      format={(v) => `${fixed(v)} ${t("kWh/100 km")}`}
                      formatTick={(v) => formatInteger(v)}
                      reference={{ value: thresholds.high_kwh_per_100km, label: t("high: {v}", { v: thresholds.high_kwh_per_100km }) }}
                      maxValue={robustMax(trend.map((p) => p.electric), thresholds.high_kwh_per_100km)}
                      label={t("Electric consumption over time")}
                      onZoom={zoom}
                    />
                    {isTrial && fleetTrend && (
                      <SeriesLegend series={[{ label: t("This trial"), color: ELECTRIC }, { label: t("Fleet average (same days)"), color: "neutral" }]} />
                    )}
                  </div>
                )}
                {hydrogen && (
                  <div className="card stack">
                    <h2>{t("Hydrogen consumption (kg/100 km)")}</h2>
                    <LineChart
                      points={consumptionPoints("hydrogen")}
                      series={consumptionSeries("hydrogen", "Hydrogen", HYDROGEN)}
                      format={(v) => `${fixed(v, 2)} ${t("kg/100 km")}`}
                      formatTick={(v) => fixed(v, 0)}
                      reference={{ value: thresholds.high_kg_per_100km, label: t("high: {v}", { v: thresholds.high_kg_per_100km }) }}
                      maxValue={robustMax(trend.map((p) => p.hydrogen), thresholds.high_kg_per_100km)}
                      label={t("Hydrogen consumption over time")}
                      onZoom={zoom}
                    />
                    {isTrial && fleetTrend && (
                      <SeriesLegend series={[{ label: t("This trial"), color: HYDROGEN }, { label: t("Fleet average (same days)"), color: "neutral" }]} />
                    )}
                  </div>
                )}
              </div>

              <p className="muted small">
                {t("Consumption by bus and by route: hot season (June–September, Abu Dhabi summer, heavy air-conditioning load) against the mild season (October–May), with the summer change on the right.")}
              </p>
              <div className="chart-grid">
                {(["Electric", "Hydrogen"] as const).map((energy) => {
                  const pairs = busPairs(energy);
                  if (!pairs.length) return null;
                  return (
                    <div key={energy} className="card stack">
                      <h2>{energy === "Hydrogen" ? t("Hydrogen buses: consumption (kg/100 km)") : t("Electric buses: consumption (kWh/100 km)")}</h2>
                      <PairedBarList
                        items={pairs}
                        series={seasonSeries()}
                        format={(v) => fixed(v, energy === "Hydrogen" ? 2 : 1)}
                        label={energy === "Hydrogen" ? t("Hydrogen consumption by bus, hot season against mild season") : t("Electric consumption by bus, hot season against mild season")}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="chart-grid">
                <div className="card stack">
                  <h2>{t("Exceptions by type")}</h2>
                  <p className="muted small">{t("High consumption: over {high_kwh_per_100km} kWh/100 km (electric) or {high_kg_per_100km} kg/100 km (hydrogen). Click a bar to list the trips.", { high_kwh_per_100km: thresholds.high_kwh_per_100km, high_kg_per_100km: thresholds.high_kg_per_100km })}</p>
                  <BarList
                    items={exceptionBars}
                    format={(v) => formatInteger(v)}
                    label={t("Trip exceptions by type")}
                    onSelect={(it) => {
                      setIssue(it.key);
                      setTripsOpen(true);
                      requestAnimationFrame(() => document.getElementById("pt-trips")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                    }}
                  />
                  <SeriesLegend
                    series={[
                      { label: t("Data error"), color: "critical" },
                      { label: t("Serious"), color: "serious" },
                      { label: t("Warning"), color: "warning" },
                      { label: t("Info"), color: "neutral" },
                    ]}
                  />
                </div>
                <div className="card stack">
                  <h2>{t("SOC drop per trip")}</h2>
                  <ColumnChart points={socPoints} series={[{ key: "trips", label: t("Trips"), color: SOC }]} format={(v) => tn(v, "{n} trip", "{n} trips")} formatTick={(v) => formatInteger(v)} height={200} label={t("Distribution of SOC drop per trip")} />
                </div>
              </div>

              <div className="chart-grid">
                {(electricRoutes.length > 0 || hydrogenRoutes.length > 0) && (
                  <div className="card stack">
                    <h2>{t("Energy consumption by route")}</h2>
                    {electricRoutes.length > 0 && (
                      <>
                        <h3>
                          {t("Electric (kWh/100 km)")}
                        </h3>
                        <PairedBarList items={electricRoutes} series={seasonSeries()} format={(v) => fixed(v)} label={t("Electric consumption by route, hot season against mild season")} />
                      </>
                    )}
                    {hydrogenRoutes.length > 0 && (
                      <>
                        <h3>
                          {t("Hydrogen (kg/100 km)")}
                        </h3>
                        <PairedBarList items={hydrogenRoutes} series={seasonSeries()} format={(v) => fixed(v, 2)} label={t("Hydrogen consumption by route, hot season against mild season")} />
                      </>
                    )}
                  </div>
                )}
                <div className="card stack">
                  <h2>{t("Distance by route{v}", { v: data.by_route.length > 10 ? t(" (top 10)") : "" })}</h2>
                  <BarList items={routeBars} format={km} label={t("Distance by route")} onSelect={(it) => setFilter({ ...filter, route: it.key === "(none)" ? undefined : it.key })} />
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
      <summary>{t("Per-bus summary ({count} buses)", { count: data.by_bus.length })}</summary>
      <table className="data-table pt-tables">
        <thead>
          <tr>
            <th className="num">{t("Bus")}</th>
            <th>{t("Model")}</th>
            <th>{t("Energy")}</th>
            <th className="num">{t("Trips")}</th>
            <th className="num">{t("Days")}</th>
            <th className="num">{t("Distance")}</th>
            <th className="num">{t("Energy used")}</th>
            <th className="num">{t("Per 100 km")}</th>
            <th className="num">{t("Avg SOC drop")}</th>
            <th className="num">{t("Lowest end SOC")}</th>
            <th className="num">{t("Exceptions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.by_bus.map((b) => (
            <tr key={b.bus_id}>
              <td className="num mono">{b.label}</td>
              <td>{b.model ?? <span className="muted">{t("not in fleet")}</span>}</td>
              <td>
                <span className={`swatch bg-${energyColor(b.energy)}`} aria-hidden /> {b.energy}
              </td>
              <td className="num">{formatInteger(b.trips)}</td>
              <td className="num">{b.days}</td>
              <td className="num">{km(b.distance)}</td>
              <td className="num">{b.energy_used === null ? "—" : `${fixed(b.energy_used, 0)} ${t(b.unit)}`}</td>
              <td className="num">{b.consumption === null ? "—" : `${fixed(b.consumption, b.unit === "kg" ? 2 : 1)} ${t(b.unit)}`}</td>
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

  const showing = issue === "" ? t("all trips") : issue === "any" ? t("trips with exceptions") : (issueInfo.get(issue)?.label.toLowerCase() ?? issue);
  return (
    <details id="pt-trips" className="card" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>
        {t("Trips")}{" "}
        <span className="muted small">
          ({showing}
          {result && open ? `: ${formatInteger(result.total)}` : ""})
        </span>
      </summary>
      <div className="stack pt-tables">
      <div className="row space-between wrap">
        <span />
        <label className="field inline">
          <span>{t("Show")}</span>
          <select value={issue} onChange={(e) => onIssue(e.target.value)}>
            <option value="">{t("All trips")}</option>
            <option value="any">{t("Trips with exceptions")}</option>
            {options.issues.map((i) => (
              <option key={i.code} value={i.code}>
                {t(i.label)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText message={error} />
      {result && (
        <>
          <p className="muted small">{t("{total} trip(s){v}", { total: formatInteger(result.total), v: result.total > PAGE ? t(" · page {v} of {pages}", { v: page + 1, pages }) : "" })}</p>
          {result.rows.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Date")}</th>
                    <th className="num">{t("Bus")}</th>
                    <th>{t("Route")}</th>
                    <th className="num">{t("Driver")}</th>
                    <th>{t("Time")}</th>
                    <th className="num">{t("Distance")}</th>
                    <th className="num">{t("SOC")}</th>
                    <th className="num">{t("Energy")}</th>
                    <th className="num">{t("Per 100 km")}</th>
                    <th>{t("Issues")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => {
                    const unit = r.energy === "Hydrogen" ? "kg" : t("kWh");
                    return (
                      <tr key={r.trip_id}>
                        <td className="nowrap">{formatDay(r.date)}</td>
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
                {t("← Newer")}
              </button>
              <button className="small-btn" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                {t("Older →")}
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
        {t("Hot (Jun–Sep)")} <strong>{fixed(e.consumption_hot, digits)}</strong>
      </span>
      <span>
        {t("Mild (Oct–May)")} <strong>{fixed(e.consumption_mild, digits)}</strong>
      </span>
    </span>
  );
}
