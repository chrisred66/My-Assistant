// PT Management → Drivers: which driver drove which bus and bus model, who drives several models, who works Shift A
// (morning) or Shift B (evening), and each driver's energy consumption on each bus against everyone on that model.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ErrorText } from "../../components/common";
import { api, type PtDriverBus, type PtDrivers, type PtDriverShift } from "../../lib/api";
import { errorMessage, formatInteger, LOCALE } from "../../lib/format";
import { t, tn } from "../../lib/i18n";

type View = "drivers" | "models" | "multi" | "shifts" | "energy";
type Preset = "90" | "180" | "all" | "custom";

const VIEWS: { id: View; label: string; description: string }[] = [
  { id: "drivers", label: "By driver", description: "Every driver and the buses they drove. Click a driver to see their buses." },
  { id: "models", label: "By bus model", description: "Drivers grouped by the bus model they drove." },
  { id: "multi", label: "Multi-model drivers", description: "Drivers who have driven more than one bus model." },
  {
    id: "shifts",
    label: "Shifts",
    description:
      "Each bus's day is split into Shift A (morning) and Shift B (evening) at the change of driver; with no change, its trips are split in half, and a bus with a single trip goes by start time (before 10:00 = A). Counted in working days.",
  },
  {
    id: "energy",
    label: "Energy performance",
    description:
      "Each driver's consumption on each bus against the average of all drivers on the same bus model, with the hot season (June–September) and the mild season compared separately (kWh/100 km for battery buses, kg/100 km for hydrogen).",
  },
];

/** Within ±5% of the model average counts as average. */
const BAND = 5;

const km = (v: number | null) => (v === null ? "—" : t("{n} km", { n: formatInteger(Math.round(v)) }));
const fixed = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : v.toLocaleString(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fixed(Math.abs(v))}%`);
// "{n} driver" / "{n} drivers", translated as a whole.
const plural = (n: number, one: string, many = `${one}s`) => tn(n, `{n} ${one}`, `{n} ${many}`);
const byId = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
const span = (from: string, to: string) => (from === to ? day(from) : `${day(from)} – ${day(to)}`);
const per100 = (energy: number | null, distance: number | null) => (energy && distance ? (energy / distance) * 100 : null);

function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Avg {
  energy: number;
  km: number;
  value: number | null; // per 100 km
}

/** Consumption averages grouped by `key`, over the whole year or one season. */
function averages(rows: PtDriverBus[], key: (r: PtDriverBus) => string, season?: "hot" | "mild") {
  const m = new Map<string, Avg>();
  for (const r of rows) {
    const distance = season ? r[season].km : r.km;
    const used = season ? r[season].energy_used : r.energy_used;
    if (!distance || !used) continue;
    const a = m.get(key(r)) ?? { energy: 0, km: 0, value: null };
    a.energy += used;
    a.km += distance;
    m.set(key(r), a);
  }
  for (const a of m.values()) a.value = per100(a.energy, a.km);
  return m;
}

interface SeasonAvgs {
  model: Record<"hot" | "mild", Map<string, Avg>>;
  bus: Record<"hot" | "mild", Map<string, Avg>>;
}

interface Driver {
  id: string;
  buses: PtDriverBus[];
  models: Map<string, { model: string; energy: string; trips: number; buses: string[] }>;
  trips: number;
  km: number;
  shift: PtDriverShift | undefined;
}

export default function Drivers() {
  const [data, setData] = useState<PtDrivers | null>(null);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [preset, setPreset] = useState<Preset>("all");
  const [view, setView] = useState<View>("drivers");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setError(null);
    api.ptDrivers(range).then(
      (d) => !stale && setData(d),
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [range]);

  function choosePreset(p: Preset) {
    setPreset(p);
    if (!data || p === "custom") return;
    setRange(p === "all" ? {} : { from: shiftDate(data.max_date, -(Number(p) - 1)), to: data.max_date });
  }

  const drivers = useMemo(() => {
    const out = new Map<string, Driver>();
    if (!data) return out;
    const shifts = new Map(data.drivers.map((s) => [s.driver_id, s]));
    for (const r of data.rows) {
      const d: Driver = out.get(r.driver_id) ?? { id: r.driver_id, buses: [], models: new Map(), trips: 0, km: 0, shift: shifts.get(r.driver_id) };
      d.buses.push(r);
      d.trips += r.trips;
      d.km += r.km ?? 0;
      const m = d.models.get(r.model) ?? { model: r.model, energy: r.energy, trips: 0, buses: [] };
      m.trips += r.trips;
      m.buses.push(r.bus_id);
      d.models.set(r.model, m);
      out.set(r.driver_id, d);
    }
    return out;
  }, [data]);

  const q = query.trim();
  const shown = useMemo(() => [...drivers.values()].filter((d) => !q || d.id.includes(q)).sort((a, b) => byId(a.id, b.id)), [drivers, q]);
  const modelAvg = useMemo(() => averages(data?.rows ?? [], (r) => r.model), [data]);
  const seasonAvgs = useMemo<SeasonAvgs>(() => {
    const rows = data?.rows ?? [];
    const byModel = (r: PtDriverBus) => r.model;
    const byBus = (r: PtDriverBus) => r.bus_id;
    return {
      model: { hot: averages(rows, byModel, "hot"), mild: averages(rows, byModel, "mild") },
      bus: { hot: averages(rows, byBus, "hot"), mild: averages(rows, byBus, "mild") },
    };
  }, [data]);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  if (!data) return error ? <ErrorText message={error} /> : <p className="muted">{t("Loading…")}</p>;

  const multi = [...drivers.values()].filter((d) => d.models.size > 1).length;

  return (
    <div className="stack">
      <div className="filters row wrap">
        <label className="field inline">
          <span>{t("Range")}</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
            <option value="90">{t("Last 90 days of data")}</option>
            <option value="180">{t("Last 180 days of data")}</option>
            <option value="all">{t("All data")}</option>
            <option value="custom">{t("Custom…")}</option>
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="field inline">
              <span>{t("From")}</span>
              <input type="date" value={data.from} min={data.min_date} max={data.to} onChange={(e) => e.target.value && setRange({ from: e.target.value, to: data.to })} />
            </label>
            <label className="field inline">
              <span>{t("To")}</span>
              <input type="date" value={data.to} min={data.from} max={data.max_date} onChange={(e) => e.target.value && setRange({ from: data.from, to: e.target.value })} />
            </label>
          </>
        )}
        <label className="field inline">
          <span>{t("Driver")}</span>
          <input type="search" placeholder={t("Driver ID…")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Find a driver")} />
        </label>
      </div>

      <ErrorText message={error} />

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">{t("Drivers")}</span>
          <span className="tile-value">{formatInteger(drivers.size)}</span>
          <span className="muted small">{span(data.from, data.to)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">{t("Buses driven")}</span>
          <span className="tile-value">{formatInteger(new Set(data.rows.map((r) => r.bus_id)).size)}</span>
          <span className="muted small">{plural(new Set(data.rows.map((r) => r.model)).size, "model")}</span>
        </div>
        <div className="tile">
          <span className="tile-label">{t("Drive 2+ models")}</span>
          <span className="tile-value">{formatInteger(multi)}</span>
          <span className="muted small">{drivers.size ? t("{math}% of drivers", { math: Math.round((multi / drivers.size) * 100) }) : ""}</span>
        </div>
      </div>

      <div className="segmented" role="tablist" aria-label={t("Driver views")}>
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
            {t(v.label)}
          </button>
        ))}
      </div>
      <p className="muted small">{t(current.description)}</p>

      {shown.length === 0 && <p className="muted">{t("No drivers match.")}</p>}
      {shown.length > 0 && view === "drivers" && <ByDriver drivers={shown} />}
      {shown.length > 0 && view === "models" && <ByModel drivers={shown} modelAvg={modelAvg} />}
      {shown.length > 0 && view === "multi" && <MultiModel drivers={shown} />}
      {shown.length > 0 && view === "shifts" && <Shifts drivers={shown} basis={data.shift_basis} />}
      {shown.length > 0 && view === "energy" && <Energy drivers={shown} avgs={seasonAvgs} />}
    </div>
  );
}

/** Column sorting: click a header to sort by it, click again to flip. */
function useSort<K extends string>(initial: K, initialDesc = false) {
  const [sort, setSort] = useState({ key: initial, desc: initialDesc });
  const th = (key: K, label: ReactNode, num = false) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button className="th-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : num }))}>
        {label}
        <span aria-hidden className="th-arrow">
          {sort.key === key ? (sort.desc ? "↓" : "↑") : ""}
        </span>
      </button>
    </th>
  );
  const order = <T,>(items: T[], value: (item: T, key: K) => number | string) =>
    [...items].sort((a, b) => {
      const x = value(a, sort.key);
      const y = value(b, sort.key);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.desc ? -c : c;
    });
  return { th, order };
}

/** A small two-part bar: Shift A share against Shift B. */
function ShiftBar({ a, b }: { a: number; b: number }) {
  const total = a + b;
  if (!total) return <span className="muted">—</span>;
  const pa = Math.round((a / total) * 100);
  return (
    <span className="shift-bar" title={t("Shift A {pa}% · Shift B {v}%", { pa, v: 100 - pa })}>
      {a > 0 && <span className="shift-a" style={{ flexGrow: a }} />}
      {b > 0 && <span className="shift-b" style={{ flexGrow: b }} />}
    </span>
  );
}

function ExpandAll({ all, open, onChange }: { all: string[]; open: Set<string>; onChange: (s: Set<string>) => void }) {
  const allOpen = all.length > 0 && all.every((k) => open.has(k));
  return (
    <button className="small-btn" onClick={() => onChange(allOpen ? new Set() : new Set(all))}>
      {allOpen ? t("Collapse all") : t("Expand all")}
    </button>
  );
}

function toggle(set: Set<string>, key: string) {
  const s = new Set(set);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  return s;
}

// 1. Driver → buses (collapsed by default).

type DriverKey = "id" | "buses" | "models" | "trips" | "days" | "km" | "last";

function ByDriver({ drivers }: { drivers: Driver[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { th, order } = useSort<DriverKey>("id");
  const rows = order(drivers, (d, k) =>
    k === "id" ? Number(d.id) : k === "buses" ? d.buses.length : k === "models" ? d.models.size : k === "trips" ? d.trips : k === "days" ? (d.shift?.days ?? 0) : k === "km" ? d.km : (d.shift?.last_date ?? ""),
  );
  return (
    <div className="stack">
      <div className="row space-between">
        <span className="muted small">{plural(drivers.length, "driver")}</span>
        <ExpandAll all={drivers.map((d) => d.id)} open={open} onChange={setOpen} />
      </div>
      <table className="data-table drivers-table">
        <thead>
          <tr>
            {th("id", t("Driver"))}
            {th("buses", t("Buses"), true)}
            {th("models", t("Models"), true)}
            {th("trips", t("Trips"), true)}
            {th("days", t("Days"), true)}
            {th("km", t("Distance"), true)}
            <th>{t("Shift A / B")}</th>
            {th("last", t("Active"))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const isOpen = open.has(d.id);
            return (
              <Fragment key={d.id}>
                <tr className={`clickable${isOpen ? " expanded" : ""}`} onClick={() => setOpen(toggle(open, d.id))}>
                  <td>
                    <button className="disclosure" aria-expanded={isOpen} aria-label={t("Driver {id}: show buses", { id: d.id })}>
                      {isOpen ? "▾" : "▸"}
                    </button>{" "}
                    <span className="mono">{d.id}</span>
                  </td>
                  <td className="num">{d.buses.length}</td>
                  <td className="num">{d.models.size}</td>
                  <td className="num">{formatInteger(d.trips)}</td>
                  <td className="num">{formatInteger(d.shift?.days ?? 0)}</td>
                  <td className="num">{km(d.km)}</td>
                  <td>
                    <ShiftBar a={d.shift?.a_days ?? 0} b={d.shift?.b_days ?? 0} />
                  </td>
                  <td className="small">{d.shift ? span(d.shift.first_date, d.shift.last_date) : ""}</td>
                </tr>
                {isOpen && (
                  <tr className="details-row">
                    <td colSpan={8}>
                      <table className="data-table inner-table">
                        <thead>
                          <tr>
                            <th>{t("Bus")}</th>
                            <th>{t("Model")}</th>
                            <th className="num">{t("Trips")}</th>
                            <th className="num">{t("Days")}</th>
                            <th className="num">{t("Distance")}</th>
                            <th className="num">{t("Consumption")}</th>
                            <th className="num">{t("Shift A / B trips")}</th>
                            <th>{t("Dates")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.buses.map((b) => (
                            <tr key={b.bus_id}>
                              <td className="mono">{b.bus_id}</td>
                              <td>{b.model}</td>
                              <td className="num">{formatInteger(b.trips)}</td>
                              <td className="num">{formatInteger(b.days)}</td>
                              <td className="num">{km(b.km)}</td>
                              <td className="num">
                                {fixed(per100(b.energy_used, b.km))} <span className="muted small">{t("{unit}/100 km", { unit: t(b.unit) })}</span>
                              </td>
                              <td className="num">
                                {formatInteger(b.a_trips)} / {formatInteger(b.b_trips)}
                              </td>
                              <td className="small">{span(b.first_date, b.last_date)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 2. Bus model → drivers.

function ByModel({ drivers, modelAvg }: { drivers: Driver[]; modelAvg: Map<string, Avg> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const models = useMemo(() => {
    const m = new Map<string, { model: string; energy: string; unit: string; trips: number; buses: Set<string>; rows: Map<string, PtDriverBus[]> }>();
    for (const d of drivers)
      for (const b of d.buses) {
        const g = m.get(b.model) ?? { model: b.model, energy: b.energy, unit: b.unit, trips: 0, buses: new Set(), rows: new Map() };
        g.trips += b.trips;
        g.buses.add(b.bus_id);
        g.rows.set(d.id, [...(g.rows.get(d.id) ?? []), b]);
        m.set(b.model, g);
      }
    return [...m.values()].sort((a, b) => b.trips - a.trips);
  }, [drivers]);

  return (
    <div className="stack">
      <div className="row space-between">
        <span className="muted small">{plural(models.length, "bus model")}</span>
        <ExpandAll all={models.map((m) => m.model)} open={open} onChange={setOpen} />
      </div>
      {models.map((m) => {
        const isOpen = open.has(m.model);
        const list = [...m.rows].map(([id, buses]) => ({
          id,
          buses,
          trips: buses.reduce((n, b) => n + b.trips, 0),
          km: buses.reduce((n, b) => n + (b.km ?? 0), 0),
          energy: buses.reduce((n, b) => n + (b.energy_used ?? 0), 0),
        }));
        list.sort((a, b) => b.trips - a.trips);
        return (
          <div key={m.model} className="card model-group">
            <button className="model-head" aria-expanded={isOpen} onClick={() => setOpen(toggle(open, m.model))}>
              <span className="disclosure">{isOpen ? "▾" : "▸"}</span>
              <span className="model-name">{m.model}</span>
              <span className="badge">{m.energy}</span>
              <span className="muted small grow">{t("{count} · {size} · {trips} · model average {value} {unit}/100 km", { count: plural(list.length, "driver"), size: plural(m.buses.size, "bus", "buses"), trips: plural(m.trips, "trip"), value: fixed(modelAvg.get(m.model)?.value), unit: t(m.unit) })}</span>
            </button>
            {!isOpen && (
              <p className="driver-chips small">
                {list.map((d) => (
                  <span key={d.id} className="chip mono" title={t("{trips} on {buses}", { trips: plural(d.trips, "trip"), buses: d.buses.map((b) => b.bus_id).join(", ") })}>
                    {d.id}
                  </span>
                ))}
              </p>
            )}
            {isOpen && (
              <table className="data-table inner-table">
                <thead>
                  <tr>
                    <th>{t("Driver")}</th>
                    <th>{t("Buses")}</th>
                    <th className="num">{t("Trips")}</th>
                    <th className="num">{t("Distance")}</th>
                    <th className="num">{t("Consumption")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.id}</td>
                      <td>
                        {d.buses.map((b) => (
                          <span key={b.bus_id} className="badge mono" title={plural(b.trips, "trip")}>
                            {b.bus_id}
                          </span>
                        ))}
                      </td>
                      <td className="num">{formatInteger(d.trips)}</td>
                      <td className="num">{km(d.km)}</td>
                      <td className="num">
                        {fixed(per100(d.energy, d.km))} <span className="muted small">{t("{unit}/100 km", { unit: t(m.unit) })}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 3. Drivers on more than one model.

type MultiKey = "id" | "models" | "buses" | "trips";

function MultiModel({ drivers }: { drivers: Driver[] }) {
  const { th, order } = useSort<MultiKey>("models", true);
  const multi = drivers.filter((d) => d.models.size > 1);
  const both = multi.filter((d) => new Set([...d.models.values()].map((m) => m.energy)).size > 1).length;
  const rows = order(multi, (d, k) => (k === "id" ? Number(d.id) : k === "models" ? d.models.size * 1e6 + d.trips : k === "buses" ? d.buses.length : d.trips));
  if (!multi.length) return <p className="muted">{t("No driver here has driven more than one bus model.")}</p>;
  return (
    <div className="stack">
      <span className="muted small">{t("{count} of {count2} have driven more than one model{v}.", { count: plural(multi.length, "driver"), count2: formatInteger(drivers.length), v: both > 0 && t("; {both} drove both battery and hydrogen buses", { both: plural(both, "driver") }) })}</span>
      <table className="data-table">
        <thead>
          <tr>
            {th("id", t("Driver"))}
            {th("models", t("Models"), true)}
            <th>{t("Models driven (trips)")}</th>
            {th("buses", t("Buses"), true)}
            {th("trips", t("Trips"), true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const models = [...d.models.values()].sort((a, b) => b.trips - a.trips);
            const mixed = new Set(models.map((m) => m.energy)).size > 1;
            return (
              <tr key={d.id}>
                <td className="mono">{d.id}</td>
                <td className="num">{d.models.size}</td>
                <td>
                  {models.map((m) => (
                    <span key={m.model} className={`badge ${m.energy === "Hydrogen" ? "badge-energy-h" : "badge-energy-e"}`} title={t("Buses {join}", { join: m.buses.join(", ") })}>
                      {m.model} · {formatInteger(m.trips)}
                    </span>
                  ))}
                  {mixed && <span className="muted small">{t("battery + hydrogen")}</span>}
                </td>
                <td className="num">{d.buses.length}</td>
                <td className="num">{formatInteger(d.trips)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 4. Shift A / Shift B.

type ShiftFilter = "all" | "a" | "b" | "both";
type ShiftKey = "id" | "a_days" | "b_days" | "a_trips" | "b_trips" | "share";

const shiftClass = (s: PtDriverShift): Exclude<ShiftFilter, "all"> => (s.b_days === 0 ? "a" : s.a_days === 0 ? "b" : "both");

function Shifts({ drivers, basis }: { drivers: Driver[]; basis: PtDrivers["shift_basis"] }) {
  const [filter, setFilter] = useState<ShiftFilter>("all");
  const { th, order } = useSort<ShiftKey>("id");
  const all = drivers.filter((d): d is Driver & { shift: PtDriverShift } => !!d.shift);
  const count = (f: ShiftFilter) => (f === "all" ? all.length : all.filter((d) => shiftClass(d.shift) === f).length);
  const list = all.filter((d) => filter === "all" || shiftClass(d.shift) === filter);
  const rows = order(list, (d, k) =>
    k === "id" ? Number(d.id) : k === "share" ? d.shift.a_days / Math.max(1, d.shift.a_days + d.shift.b_days) : d.shift[k],
  );
  const label: Record<ShiftFilter, string> = { all: t("All"), a: t("Shift A only"), b: t("Shift B only"), both: t("Both shifts") };
  return (
    <div className="stack">
      <div className="row wrap">
        <div className="segmented" role="group" aria-label={t("Shift")}>
          {(["all", "a", "b", "both"] as ShiftFilter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label[f]} ({count(f)})
            </button>
          ))}
        </div>
        <span className="muted small align-end">
          <span className="swatch shift-a" aria-hidden /> {t("Shift A (morning)")} <span className="swatch shift-b" aria-hidden /> {t("Shift B (evening)")}
        </span>
      </div>
      <p className="muted small">{t("Bus-days split at a driver handover: {driver_change} · in half (same driver all day): {halves} · single trip, by start time: {single}.", { driver_change: formatInteger(basis.driver_change), halves: formatInteger(basis.halves), single: formatInteger(basis.single) })}</p>
      <table className="data-table">
        <thead>
          <tr>
            {th("id", t("Driver"))}
            <th>{t("Works")}</th>
            {th("a_days", t("Shift A days"), true)}
            {th("b_days", t("Shift B days"), true)}
            {th("share", t("A / B split"))}
            {th("a_trips", t("Shift A trips"), true)}
            {th("b_trips", t("Shift B trips"), true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const s = d.shift;
            const c = shiftClass(s);
            const share = s.a_days / Math.max(1, s.a_days + s.b_days);
            const works = c === "a" ? t("Shift A") : c === "b" ? t("Shift B") : share >= 0.8 ? t("Mostly A") : share <= 0.2 ? t("Mostly B") : t("Both");
            return (
              <tr key={d.id}>
                <td className="mono">{d.id}</td>
                <td>{works}</td>
                <td className="num">{formatInteger(s.a_days)}</td>
                <td className="num">{formatInteger(s.b_days)}</td>
                <td>
                  <ShiftBar a={s.a_days} b={s.b_days} />
                </td>
                <td className="num">{formatInteger(s.a_trips)}</td>
                <td className="num">{formatInteger(s.b_trips)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 5. Energy performance per driver per bus, split into the hot season and the rest of the year.

type EnergyFilter = "all" | "Electric" | "Hydrogen";
type Season = "hot" | "mild";
type RankKey = "id" | "km" | "hot" | "mild" | "diff";

const SEASONS: { id: Season; label: string; months: string }[] = [
  { id: "hot", label: "Hot season", months: "Jun–Sep" },
  { id: "mild", label: "Mild season", months: "Oct–May" },
];

interface SeasonPerf {
  km: number;
  energy: number;
  value: number | null; // this driver, per 100 km
  model: number | null; // all drivers on this model, same season
  bus: number | null; // all drivers on this bus, same season
  diff: number | null; // % against the model average
  counted: boolean;
}

interface Perf {
  row: PtDriverBus;
  hot: SeasonPerf;
  mild: SeasonPerf;
}

function verdict(diff: number | null) {
  if (diff === null) return null;
  if (diff <= -BAND) return <span className="badge badge-good">{t("Efficient")}</span>;
  if (diff >= 3 * BAND) return <span className="badge badge-serious">{t("Heavy")}</span>;
  if (diff >= BAND) return <span className="badge badge-warning">{t("Above average")}</span>;
  return <span className="badge badge-info">{t("Average")}</span>;
}

/** Energy used against what the model averages predict for the same distances (so kWh and kg combine as a ratio). */
function score(items: SeasonPerf[]) {
  const counted = items.filter((p) => p.counted);
  const used = counted.reduce((n, p) => n + p.energy, 0);
  const expected = counted.reduce((n, p) => n + (p.km * (p.model ?? 0)) / 100, 0);
  return { km: counted.reduce((n, p) => n + p.km, 0), diff: expected ? (used / expected - 1) * 100 : null };
}

/** A driver's own consumption across all their buses: one figure per unit (battery kWh and hydrogen kg never mix). */
function Consumption({ perf, season }: { perf: Perf[]; season?: Season }) {
  const pick = (p: Perf) => (season ? [p[season]] : [p.hot, p.mild]);
  const units = (["kWh", "kg"] as const)
    .map((unit) => {
      const own = perf.filter((p) => p.row.unit === unit);
      const parts = own.flatMap(pick);
      const value = per100(
        parts.reduce((n, s) => n + s.energy, 0),
        parts.reduce((n, s) => n + s.km, 0),
      );
      return { unit, value, models: new Set(own.filter((p) => pick(p).some((x) => x.km > 0)).map((p) => p.row.model)).size };
    })
    .filter((u) => u.value !== null);
  if (!units.length) return <span className="muted">—</span>;
  return (
    <span className="cons-cell">
      {units.map((u) => (
        <span key={u.unit}>
          {fixed(u.value)} <span className="muted small">{t("{unit}/100 km", { unit: t(u.unit) })}</span>
          {u.models > 1 && <span className="muted small">{t("· {models} models", { models: u.models })}</span>}
        </span>
      ))}
    </span>
  );
}

function Energy({ drivers, avgs }: { drivers: Driver[]; avgs: SeasonAvgs }) {
  const [minKm, setMinKm] = useState(300);
  const [energy, setEnergy] = useState<EnergyFilter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { th, order } = useSort<RankKey>("diff");

  const ranked = useMemo(
    () =>
      drivers
        .map((d) => {
          const perf: Perf[] = d.buses
            .filter((b) => energy === "all" || b.energy === energy)
            .map((b) => {
              const season = (s: Season): SeasonPerf => {
                const value = per100(b[s].energy_used, b[s].km);
                const model = avgs.model[s].get(b.model)?.value ?? null;
                return {
                  km: b[s].km,
                  energy: b[s].energy_used,
                  value,
                  model,
                  bus: avgs.bus[s].get(b.bus_id)?.value ?? null,
                  diff: value !== null && model ? (value / model - 1) * 100 : null,
                  counted: value !== null && model !== null && b[s].km >= minKm,
                };
              };
              return { row: b, hot: season("hot"), mild: season("mild") };
            })
            .sort((a, b) => (b.row.km ?? 0) - (a.row.km ?? 0));
          const all = score(perf.flatMap((p) => [p.hot, p.mild]));
          return {
            id: d.id,
            perf,
            km: all.km,
            diff: all.diff,
            hot: score(perf.map((p) => p.hot)).diff,
            mild: score(perf.map((p) => p.mild)).diff,
          };
        })
        .filter((d) => d.perf.length > 0),
    [drivers, avgs, energy, minKm],
  );
  const rated = ranked.filter((d) => d.diff !== null);
  const last = (v: number | null) => v ?? Number.MAX_VALUE; // unrated sort last
  const rows = order(rated, (d, k) => (k === "id" ? Number(d.id) : k === "km" ? d.km : last(d[k])));
  const unrated = ranked.length - rated.length;
  const efficient = rated.filter((d) => (d.diff ?? 0) <= -BAND).length;
  const heavy = rated.filter((d) => (d.diff ?? 0) >= BAND).length;

  return (
    <div className="stack">
      <div className="filters row wrap">
        <div className="segmented" role="group" aria-label={t("Energy type")}>
          {(["all", "Electric", "Hydrogen"] as EnergyFilter[]).map((e) => (
            <button key={e} className={energy === e ? "on" : ""} aria-pressed={energy === e} onClick={() => setEnergy(e)}>
              {e === "all" ? t("All buses") : e === "Electric" ? t("Battery") : t("Hydrogen")}
            </button>
          ))}
        </div>
        <label className="field inline">
          <span>{t("Count a bus from")}</span>
          <input type="number" min={0} step={50} value={minKm} onChange={(e) => setMinKm(Math.max(0, Number(e.target.value) || 0))} style={{ width: "6em" }} />
          <span>{t("km per season")}</span>
        </label>
        <ExpandAll all={rows.map((d) => d.id)} open={open} onChange={setOpen} />
      </div>
      <p className="muted small">{t("Hot season is June–September (Abu Dhabi summer, heavy air-conditioning load). Each season is compared with the same season's model average, so summer driving isn't held against anyone. {count} rated: {efficient} efficient (≥{bAND}% below average), {heavy} above average (≥{bAND2}% over).{v} Negative is better.", { count: plural(rated.length, "driver"), efficient: formatInteger(efficient), bAND: BAND, heavy: formatInteger(heavy), bAND2: BAND, v: unrated > 0 && t(" {unrated} with under {minKm} km on every bus in both seasons not rated.", { unrated: plural(unrated, "driver"), minKm: formatInteger(minKm) }) })}</p>
      <table className="data-table drivers-table">
        <thead>
          <tr>
            {th("id", t("Driver"))}
            {th("km", t("Distance counted"), true)}
            <th className="num">{t("Consumption (all their models)")}</th>
            {th("hot", t("Hot (Jun–Sep) vs model"), true)}
            {th("mild", t("Mild (Oct–May) vs model"), true)}
            {th("diff", t("Overall"), true)}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const isOpen = open.has(d.id);
            return (
              <Fragment key={d.id}>
                <tr className={`clickable${isOpen ? " expanded" : ""}`} onClick={() => setOpen(toggle(open, d.id))}>
                  <td>
                    <button className="disclosure" aria-expanded={isOpen} aria-label={t("Driver {id}: show buses", { id: d.id })}>
                      {isOpen ? "▾" : "▸"}
                    </button>{" "}
                    <span className="mono">{d.id}</span>
                  </td>
                  <td className="num">{km(d.km)}</td>
                  <td className="num">
                    <Consumption perf={d.perf} />
                  </td>
                  <td className="num">
                    <DiffBar diff={d.hot} />
                  </td>
                  <td className="num">
                    <DiffBar diff={d.mild} />
                  </td>
                  <td className="num">{pct(d.diff)}</td>
                  <td>{verdict(d.diff)}</td>
                </tr>
                {isOpen && (
                  <tr className="details-row">
                    <td colSpan={7}>
                      <table className="data-table inner-table">
                        <thead>
                          <tr>
                            <th rowSpan={2}>{t("Bus")}</th>
                            <th rowSpan={2}>{t("Model")}</th>
                            {SEASONS.map((s) => (
                              <th key={s.id} colSpan={4} className="season-head">
                                {t(s.label)} ({t(s.months)})
                              </th>
                            ))}
                          </tr>
                          <tr>
                            {SEASONS.map((s) => (
                              <Fragment key={s.id}>
                                <th className="num season-start">{t("Distance")}</th>
                                <th className="num">{t("This driver")}</th>
                                <th className="num">{t("Model avg")}</th>
                                <th className="num">{t("vs model")}</th>
                              </Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {d.perf.map((p) => (
                            <tr key={p.row.bus_id}>
                              <td className="mono">{p.row.bus_id}</td>
                              <td>
                                {p.row.model} <span className="muted small">{t("{unit}/100 km", { unit: t(p.row.unit) })}</span>
                              </td>
                              {SEASONS.map(({ id }) => {
                                const s = p[id];
                                const dim = s.counted ? "" : " muted";
                                return (
                                  <Fragment key={id}>
                                    <td className={`num season-start${dim}`}>{s.km ? km(s.km) : "—"}</td>
                                    <td className={`num${dim}`}>{fixed(s.value)}</td>
                                    <td className="num" title={s.bus !== null ? t("This bus, all drivers: {bus}", { bus: fixed(s.bus) }) : undefined}>
                                      {fixed(s.model)}
                                    </td>
                                    <td className={`num${dim}`}>{pct(s.diff)}</td>
                                  </Fragment>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="muted small season-note">
                        {t("This driver by season:")} {t("hot")} <Consumption perf={d.perf} season="hot" /> · {t("mild")} <Consumption perf={d.perf} season="mild" />.{" "}
                        {t("Greyed figures are under {km} km and not counted.", { km: formatInteger(minKm) })}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The signed difference with a small bar either side of zero (left = less energy than average). */
function DiffBar({ diff }: { diff: number | null }) {
  if (diff === null) return <span className="muted">—</span>;
  const w = Math.min(50, Math.abs(diff) * 2); // 25% fills one side
  return (
    <span className="diff-cell">
      <span className="diff-bar" aria-hidden>
        <span className={diff < 0 ? "diff-neg" : "diff-pos"} style={diff < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }} />
      </span>
      {pct(diff)}
    </span>
  );
}
