// PT Management → Charging: charging assets (stations, chargers, guns) and the overnight charging simulation.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LineChart, type Point } from "../../components/charts";
import { ErrorText } from "../../components/common";
import {
  api,
  canPt,
  type PtAiGoal,
  type PtAiSchedule,
  type PtChargingDemand,
  type PtHistoryStat,
  type PtHistoryWeekdays,
  type PtStation,
  type User,
} from "../../lib/api";
import { errorMessage, formatInteger } from "../../lib/format";
import {
  adjustBuses,
  adjustLanes,
  autoSchedule,
  BUFFER,
  chargerKey,
  clock,
  isAdjusted,
  NO_ADJUSTMENTS,
  TURNAROUND,
  type Adjustments,
  DAY,
  lanesFrom,
  needsFor,
  powerProfile,
  simulate,
  snap,
  SNAP,
  summarize,
  type ScheduleSummary,
  type BusNeed,
  type Lane,
  type Session,
  type SessionResult,
} from "./chargingModel";
import { track } from "../../lib/activity";

const kwh = (v: number) => `${formatInteger(Math.round(v))} kWh`;

export default function Charging({ user }: { user: User }) {
  const [stations, setStations] = useState<PtStation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetsOpen, setAssetsOpen] = useState(false);

  const loadAssets = useCallback(async () => {
    setError(null);
    try {
      setStations(await api.ptChargingAssets());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  return (
    <div className="stack">
      <ErrorText message={error} />
      {stations && <Simulation stations={stations} canAi={canPt(user, "planning", "manage")} />}
      <details className="card" open={assetsOpen} onToggle={(e) => setAssetsOpen(e.currentTarget.open)}>
        <summary>
          Charging assets{" "}
          {stations && (
            <span className="muted small">
              ({stations.length} station(s), {stations.reduce((n, s) => n + s.chargers.length, 0)} charger(s),{" "}
              {stations.reduce((n, s) => n + s.chargers.reduce((g, c) => g + c.guns.length, 0), 0)} gun(s))
            </span>
          )}
        </summary>
        {stations && <Assets user={user} stations={stations} onChanged={() => void loadAssets()} />}
      </details>
    </div>
  );
}

// --- Assets ---------------------------------------------------------------------

function Assets({ user, stations, onChanged }: { user: User; stations: PtStation[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"station" | number | null>(null); // number = add charger to that station
  // Stations and chargers are settings: Planning managers.
  const canEdit = canPt(user, "planning", "manage");
  const canRemove = canPt(user, "planning", "manage");

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setAdding(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="stack pt-tables">
      <p className="muted small">
        A charger's guns share its power: one gun on its own gets the one-gun output; when both are in use each gets the two-gun output.
      </p>
      <ErrorText message={error} />
      {stations.map((s) => (
        <div key={s.station_id} className="stack-tight">
          <div className="row space-between wrap">
            <h3>{s.station_name}</h3>
            <div className="row">
              {canEdit && (
                <button className="small-btn" onClick={() => setAdding(adding === s.station_id ? null : s.station_id)}>
                  {adding === s.station_id ? "Cancel" : "Add charger…"}
                </button>
              )}
              {canRemove && s.chargers.length === 0 && (
                <button
                  className="small-btn danger"
                  onClick={() => window.confirm(`Remove the empty station ${s.station_name}?`) && void act(() => api.ptRemoveStation(s.station_id))}
                >
                  Remove station
                </button>
              )}
            </div>
          </div>
          {adding === s.station_id && <AddCharger stationId={s.station_id} onSave={(c) => act(() => api.ptAddCharger(c))} />}
          {s.chargers.length === 0 ? (
            <p className="muted small">No chargers yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Charger</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th className="num">Guns</th>
                  <th className="num">Total</th>
                  <th className="num">One gun</th>
                  <th className="num">Two guns (each)</th>
                  {canRemove && <th />}
                </tr>
              </thead>
              <tbody>
                {s.chargers.map((c) => (
                  <tr key={c.charger_id}>
                    <td className="mono">{c.charger_id}</td>
                    <td>{c.location}</td>
                    <td>{c.output_type}</td>
                    <td className="num">{c.guns.length}</td>
                    <td className="num">{c.charger_output} kW</td>
                    <td className="num">{c.one_gun_output} kW</td>
                    <td className="num">{c.guns.length > 1 ? (c.two_gun_output ? `${c.two_gun_output} kW` : "not stated") : "—"}</td>
                    {canRemove && (
                      <td className="num">
                        <button
                          className="small-btn danger"
                          onClick={() =>
                            window.confirm(`Remove charger ${c.charger_id} from ${s.station_name}?`) && void act(() => api.ptRemoveCharger(s.station_id, c.charger_id))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {canEdit &&
        (adding === "station" ? (
          <AddStation onSave={(name) => act(() => api.ptAddStation(name))} onCancel={() => setAdding(null)} />
        ) : (
          <div>
            <button className="small-btn" onClick={() => setAdding("station")}>
              Add station…
            </button>
          </div>
        ))}
    </div>
  );
}

function AddStation({ onSave, onCancel }: { onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(name.trim());
      }}
    >
      <label className="field inline grow">
        <span>Station name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <button className="primary align-end" type="submit">
        Add station
      </button>
      <button type="button" className="align-end" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function AddCharger({ stationId, onSave }: { stationId: number; onSave: (c: Parameters<typeof api.ptAddCharger>[0]) => Promise<void> }) {
  const [f, setF] = useState({ charger_id: "", location: "", output_type: "DC" as "DC" | "AC", gun_count: "2", charger_output: "", one_gun_output: "", two_gun_output: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSave({
      station_id: stationId,
      charger_id: f.charger_id.trim(),
      location: f.location.trim() || undefined,
      output_type: f.output_type,
      gun_count: Number(f.gun_count),
      charger_output: Number(f.charger_output),
      one_gun_output: Number(f.one_gun_output || f.charger_output),
      two_gun_output: Number(f.gun_count) > 1 ? Number(f.two_gun_output || 0) : undefined,
    });
  }
  return (
    <form className="row wrap" onSubmit={(e) => void submit(e)}>
      <label className="field inline">
        <span>Charger name / number</span>
        <input value={f.charger_id} onChange={set("charger_id")} required />
      </label>
      <label className="field inline grow">
        <span>Location (optional)</span>
        <input value={f.location} onChange={set("location")} />
      </label>
      <label className="field inline">
        <span>Type</span>
        <select value={f.output_type} onChange={set("output_type")}>
          <option>DC</option>
          <option>AC</option>
        </select>
      </label>
      <label className="field inline">
        <span>Guns</span>
        <select value={f.gun_count} onChange={set("gun_count")}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="field inline">
        <span>Total kW</span>
        <input type="number" min="1" value={f.charger_output} onChange={set("charger_output")} required />
      </label>
      <label className="field inline">
        <span>One gun kW</span>
        <input type="number" min="1" value={f.one_gun_output} placeholder={f.charger_output} onChange={set("one_gun_output")} />
      </label>
      {Number(f.gun_count) > 1 && (
        <label className="field inline">
          <span>Two guns kW (each)</span>
          <input type="number" min="0" value={f.two_gun_output} onChange={set("two_gun_output")} />
        </label>
      )}
      <button className="primary align-end" type="submit">
        Add charger
      </button>
    </form>
  );
}

// --- Simulation -------------------------------------------------------------------

const GOAL_LABELS: Record<PtAiGoal, string> = {
  all_charged: "Charge every bus fully, then keep peak low",
  lowest_peak: "Lowest, flattest site power",
  night_tariff: "Charge mostly 23:00–07:00 (night tariff)",
  fewest_guns: "Use as few guns as possible",
};
const STAT_LABELS: Record<PtHistoryStat, string> = { avg: "average day", p85: "85th percentile (safer)", max: "highest day" };

/** Where the timeline's sessions came from. */
type Source = { kind: "auto" } | { kind: "ai"; result: PtAiSchedule; previous: { sessions: Session[]; unplaced: number[] }; before: ScheduleSummary };

function Simulation({ stations, canAi }: { stations: PtStation[]; canAi: boolean }) {
  const allLanes = useMemo(() => lanesFrom(stations), [stations]);
  const [date, setDate] = useState<string | undefined>(undefined);
  const [demand, setDemand] = useState<PtChargingDemand | null>(null);
  // Plan for a specific operating day, or a typical day built from recent history.
  const [basis, setBasis] = useState<"day" | "typical">("day");
  const [history, setHistory] = useState<{ days: number; weekdays: PtHistoryWeekdays; stat: PtHistoryStat }>({ days: 30, weekdays: "all", stat: "p85" });
  const [dayList, setDayList] = useState<PtChargingDemand["days"]>([]);
  const [source, setSource] = useState<Source>({ kind: "auto" });
  const [edited, setEdited] = useState(false); // sessions moved by hand since the last (auto or AI) schedule
  const [aiOpen, setAiOpen] = useState(false);
  const [aiGoal, setAiGoal] = useState<PtAiGoal>("all_charged");
  const [aiNotes, setAiNotes] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [reserve, setReserve] = useState(10);
  const [efficiency, setEfficiency] = useState(0.92);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(allLanes.map((l) => l.key)));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [unplaced, setUnplaced] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NO_ADJUSTMENTS);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const adjusted = isAdjusted(adjust);

  useEffect(() => setEnabled(new Set(allLanes.map((l) => l.key))), [allLanes]);

  useEffect(() => {
    let stale = false;
    setError(null);
    (basis === "day" ? api.ptChargingDemand(date) : api.ptChargingHistory(history)).then(
      (d) => {
        if (stale) return;
        setDemand(d);
        if (d.days.length) setDayList(d.days);
      },
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [basis, date, history]);

  // Ad-hoc adjustments apply here only; the stored charger and bus data are never changed.
  const lanes = useMemo(() => adjustLanes(allLanes.filter((l) => enabled.has(l.key)), adjust), [allLanes, enabled, adjust]);
  const needs = useMemo(
    () => (demand ? needsFor(adjustBuses(demand.buses, adjust), reserve, efficiency, adjust.turnaround ?? TURNAROUND) : []),
    [demand, reserve, efficiency, adjust],
  );

  const reschedule = useCallback(() => {
    const r = autoSchedule(needs, lanes, adjust.buffer ?? BUFFER);
    setSessions(r.sessions);
    setUnplaced(r.unplaced);
    setSource({ kind: "auto" });
    setEdited(false);
  }, [needs, lanes, adjust.buffer]);

  /** The AI plans for exactly what's on screen: current requirements (after adjustments) and enabled guns. */
  async function aiSchedule() {
    setAiBusy(true);
    setError(null);
    try {
      const result = await track("planning", "AI planning", () => api.ptAiSchedule({
        lanes: lanes.map((l) => ({
          key: l.key,
          label: `${l.stationName} charger ${l.chargerId} gun ${l.gunId}`,
          charger: `${l.stationId}/${l.chargerId}`,
          one_gun: l.oneGun,
          two_gun: l.twoGun,
        })),
        buses: needs.map((n) => ({
          bus_id: n.bus.bus_id,
          required_kwh: n.requiredKwh,
          available: n.available,
          deadline: n.deadline !== null && n.deadline > n.available ? n.deadline : null,
          max_intake_kw: n.bus.max_intake_kw,
        })),
        buffer: adjust.buffer ?? BUFFER,
        goal: aiGoal,
        instructions: aiNotes,
      }));
      setSource({ kind: "ai", result, previous: { sessions, unplaced }, before: summarize(sessions, lanes, needs) });
      setSessions(result.sessions.map((x) => ({ busId: x.bus_id, lane: x.lane, start: x.start, duration: x.duration })));
      setUnplaced(result.unplaced);
      setEdited(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAiBusy(false);
    }
  }

  function undoAi() {
    if (source.kind !== "ai") return;
    setSessions(source.previous.sessions);
    setUnplaced(source.previous.unplaced);
    setSource({ kind: "auto" });
    setEdited(false);
  }

  // A new day or a different set of chargers starts from a fresh schedule. Reserve, efficiency and adjusted outputs
  // keep the current sessions and recompute what they deliver ("Auto-schedule again" re-plans with them).
  useEffect(() => {
    reschedule();
  }, [demand, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => simulate(sessions, lanes, needs), [sessions, lanes, needs]);
  const profile = useMemo(() => powerProfile(sessions, lanes, needs), [sessions, lanes, needs]);
  const needBy = useMemo(() => new Map(needs.map((n) => [n.bus.bus_id, n])), [needs]);

  const totals = useMemo(() => summarize(sessions, lanes, needs), [sessions, lanes, needs]);

  const profilePoints: Point[] = profile.map((kw, i) => ({ label: clock(i * SNAP), title: `${clock(i * SNAP)}–${clock((i + 1) * SNAP)}`, values: { kw } }));

  return (
    <>
      <div className="card stack">
        <div className="row space-between wrap">
          <h2>Overnight charging simulation</h2>
          <div className="row">
            <button className="small-btn" onClick={() => setAdjustOpen((o) => !o)} aria-expanded={adjustOpen}>
              {adjustOpen ? "Hide parameters" : "Adjust parameters…"}
            </button>
            {canAi && (
              <button className="small-btn" onClick={() => setAiOpen((o) => !o)} aria-expanded={aiOpen}>
                {aiOpen ? "Hide AI schedule" : "AI schedule…"}
              </button>
            )}
            <button className="small-btn" onClick={reschedule}>
              Auto-schedule again
            </button>
          </div>
        </div>
        <p className="small schedule-source">
          Schedule:{" "}
          <strong>{source.kind === "ai" ? `AI (${GOAL_LABELS[aiGoal].toLowerCase()})` : "automatic"}</strong>
          {edited && " · moved by hand"}
          {source.kind === "ai" && (
            <>
              {" · "}
              <button className="link-btn" onClick={undoAi}>
                <u>back to the previous schedule</u>
              </button>
            </>
          )}
        </p>
        {aiOpen && canAi && (
          <div className="adjust-panel stack">
            <p className="muted small">
              The AI plans for what the simulation shows now: the chosen day or typical day, the selected chargers, reserve, efficiency and any
              adjusted parameters. It decides which gun each bus uses, the order and any hold-backs; the app then works out the exact times so every
              session is long enough for the bus's full energy, and loads the result here, where you can still drag sessions and change parameters.
              Each request is a paid AI call, logged under Usage.
            </p>
            <div className="row wrap">
              <label className="field inline">
                <span>Goal</span>
                <select value={aiGoal} onChange={(e) => setAiGoal(e.target.value as PtAiGoal)}>
                  {(Object.keys(GOAL_LABELS) as PtAiGoal[]).map((g) => (
                    <option key={g} value={g}>
                      {GOAL_LABELS[g]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field inline grow">
                <span>Extra instructions (optional)</span>
                <input value={aiNotes} onChange={(e) => setAiNotes(e.target.value)} maxLength={1000} placeholder="e.g. keep Main Bus Station free after 02:00; bus 3007 first" />
              </label>
              <button className="primary align-end" onClick={() => void aiSchedule()} disabled={aiBusy || needs.length === 0 || lanes.length === 0}>
                {aiBusy ? "Planning…" : "Generate schedule"}
              </button>
            </div>
            {source.kind === "ai" && <AiResult source={source} after={totals} edited={edited} />}
          </div>
        )}
        {adjusted && (
          <p className="adjusted-note small">
            Using adjusted parameters for this simulation only; the saved charger and bus data are unchanged.{" "}
            <button className="link-btn" onClick={() => setAdjust(NO_ADJUSTMENTS)}>
              <u>Back to saved values</u>
            </button>
          </p>
        )}
        {adjustOpen && <AdjustPanel stations={stations} buses={demand?.buses ?? []} value={adjust} onChange={setAdjust} />}
        <div className="filters row wrap">
          <label className="field inline">
            <span>Plan for</span>
            <select
              value={basis === "typical" ? "typical" : (demand?.date ?? "")}
              onChange={(e) => {
                if (e.target.value === "typical") setBasis("typical");
                else {
                  setBasis("day");
                  setDate(e.target.value);
                }
              }}
            >
              <option value="typical">Typical day (from recent history)…</option>
              {basis === "typical" && !dayList.length && <option value="">(loading days…)</option>}
              {dayList.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.date} · {d.buses} bus(es)
                </option>
              ))}
            </select>
          </label>
          {basis === "typical" && (
            <>
              <label className="field inline">
                <span>From the last</span>
                <select value={history.days} onChange={(e) => setHistory({ ...history, days: Number(e.target.value) })}>
                  {[14, 30, 60, 90].map((n) => (
                    <option key={n} value={n}>
                      {n} days of data
                    </option>
                  ))}
                </select>
              </label>
              <label className="field inline">
                <span>Days</span>
                <select value={history.weekdays} onChange={(e) => setHistory({ ...history, weekdays: e.target.value as PtHistoryWeekdays })}>
                  <option value="all">All days</option>
                  <option value="mon-fri">Mon–Fri</option>
                  <option value="sat-sun">Sat–Sun</option>
                </select>
              </label>
              <label className="field inline">
                <span>Energy per bus</span>
                <select value={history.stat} onChange={(e) => setHistory({ ...history, stat: e.target.value as PtHistoryStat })}>
                  {(Object.keys(STAT_LABELS) as PtHistoryStat[]).map((k) => (
                    <option key={k} value={k}>
                      {STAT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="field inline">
            <span>Reserve (kWh)</span>
            <input type="number" min="0" step="5" value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
          </label>
          <label className="field inline">
            <span>Charging efficiency</span>
            <input type="number" min="0.5" max="1" step="0.01" value={efficiency} onChange={(e) => setEfficiency(Number(e.target.value) || 1)} />
          </label>
          <ChargerPicker lanes={allLanes} enabled={enabled} onChange={setEnabled} />
        </div>
        {basis === "typical" && demand?.basis && (
          <p className="small">
            Typical day from {demand.basis.from} to {demand.basis.to}
            {demand.basis.weekdays !== "all" && ` (${demand.basis.weekdays === "mon-fri" ? "Mon–Fri" : "Sat–Sun"} only)`}: each electric bus that ran,
            with its {STAT_LABELS[demand.basis.stat]} energy use and its usual last-trip end and first departure.
          </p>
        )}
        <p className="muted small">
          Each bus needs what it used that day plus the reserve, divided by the charging efficiency. Sessions start at least{" "}
          {adjust.turnaround ?? TURNAROUND} minutes after its last trip. Drag a session to move it (also to another gun), or drag its edges to change
          its length; times snap to 10 minutes.
        </p>
        <ErrorText message={error} />
        {demand && (
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Buses to charge</span>
              <span className="tile-value">{needs.length}</span>
              {demand.not_charged.length > 0 && <span className="muted small">{demand.not_charged.length} hydrogen bus(es) not included</span>}
            </div>
            <div className="tile">
              <span className="tile-label">Energy needed</span>
              <span className="tile-value">{kwh(totals.required)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Delivered</span>
              <span className="tile-value">{kwh(totals.delivered)}</span>
              <span className={totals.required - totals.delivered > 0.5 ? "error-text small" : "muted small"}>
                {totals.required - totals.delivered > 0.5 ? `${kwh(totals.required - totals.delivered)} short` : "everything covered"}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Buses not fully charged</span>
              <span className="tile-value">{totals.short}</span>
              {totals.late > 0 && <span className="error-text small">{totals.late} finish after their first departure</span>}
            </div>
            <div className="tile">
              <span className="tile-label">Peak power</span>
              <span className="tile-value">{formatInteger(totals.peak)} kW</span>
              {totals.peak > 0 && <span className="muted small">at {clock(totals.peakAt)}</span>}
            </div>
          </div>
        )}
        {unplaced.length > 0 && (
          <p className="error-text small">
            No free charger before 19:00 for bus {unplaced.join(", ")}. Enable more chargers or shorten other sessions, then auto-schedule again.
          </p>
        )}
        {lanes.length === 0 ? (
          <p className="muted">No chargers selected.</p>
        ) : (
          <Timeline
            lanes={lanes}
            sessions={sessions}
            results={results}
            needBy={needBy}
            onChange={(s) => {
              setSessions(s);
              setEdited(true);
            }}
          />
        )}
        <div className="legend small">
          <span>
            <span className="swatch tl-ok-swatch" aria-hidden /> enough
          </span>
          <span>
            <span className="swatch tl-short-swatch" aria-hidden /> not enough
          </span>
          <span>
            <span className="swatch tl-shared-swatch" aria-hidden /> sharing the charger (two-gun rate)
          </span>
          <span>
            <span className="tl-deadline-key" aria-hidden /> first departure, when charging runs past it
          </span>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="card stack">
          <h2>Site power draw (kW)</h2>
          <LineChart
            points={profilePoints}
            series={[{ key: "kw", label: "Power", color: "c4" }]}
            format={(v) => `${formatInteger(v)} kW`}
            formatTick={(v) => formatInteger(v)}
            height={200}
            label="Total charging power through the night"
          />
        </div>
      )}

      {demand && needs.length > 0 && (
        <details className="card">
          <summary>Per-bus schedule ({needs.length} buses)</summary>
          <table className="data-table pt-tables">
            <thead>
              <tr>
                <th className="num">Bus</th>
                <th>Model</th>
                <th>Service</th>
                <th className="num">Used</th>
                <th className="num">Needed</th>
                <th>Charging</th>
                <th className="num">Delivered</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {needs.map((n) => {
                const s = sessions.find((x) => x.busId === n.bus.bus_id);
                const r = results.get(n.bus.bus_id);
                const lane = s && lanes.find((l) => l.key === s.lane);
                const ok = r && r.deliveredKwh >= n.requiredKwh - 0.05;
                return (
                  <tr key={n.bus.bus_id}>
                    <td className="num mono">{n.bus.bus_id}</td>
                    <td>
                      {n.bus.model} {n.bus.battery_kwh ? <span className="muted small">({n.bus.battery_kwh} kWh)</span> : null}
                    </td>
                    <td className="nowrap">
                      {n.bus.first_start?.slice(0, 5)}–{n.bus.last_end?.slice(0, 5)} · {formatInteger(n.bus.distance)} km
                    </td>
                    <td className="num">{kwh(n.bus.energy_kwh ?? 0)}</td>
                    <td className="num">{kwh(n.requiredKwh)}</td>
                    <td className="nowrap">
                      {s && lane ? (
                        <>
                          {clock(s.start)}–{clock(s.start + s.duration)}
                          <div className="muted small">
                            {lane.stationName} · charger {lane.chargerId} gun {lane.gunId}
                          </div>
                        </>
                      ) : (
                        <span className="muted">not scheduled</span>
                      )}
                    </td>
                    <td className="num">{kwh(r?.deliveredKwh ?? 0)}</td>
                    <td>
                      {!s ? (
                        <span className="badge badge-critical">no slot</span>
                      ) : ok ? (
                        <span className="badge badge-good">enough</span>
                      ) : (
                        <span className="badge badge-serious">{kwh(n.requiredKwh - (r?.deliveredKwh ?? 0))} short</span>
                      )}
                      {r?.late && <span className="badge badge-warning">after first departure</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

/** The AI's plan next to the schedule it replaced, with its notes and the app's corrections. */
function AiResult({ source, after, edited }: { source: Extract<Source, { kind: "ai" }>; after: ScheduleSummary; edited: boolean }) {
  const b = source.before;
  const rows: [string, (s: ScheduleSummary) => string, (s: ScheduleSummary) => number, boolean][] = [
    ["Delivered", (s) => kwh(s.delivered), (s) => s.delivered, true],
    ["Short", (s) => kwh(Math.max(0, s.required - s.delivered)), (s) => -(s.required - s.delivered), true],
    ["Buses not fully charged", (s) => String(s.short), (s) => -s.short, true],
    ["Finishing after first departure", (s) => String(s.late), (s) => -s.late, true],
    ["Peak power", (s) => `${formatInteger(s.peak)} kW at ${clock(s.peakAt)}`, (s) => -s.peak, true],
  ];
  return (
    <div className="stack-tight">
      {source.result.notes && (
        <p className="small">
          <strong>AI notes:</strong> {source.result.notes} <span className="muted">(its own summary; the figures below are calculated by the app)</span>
        </p>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th />
            <th className="num">Previous schedule</th>
            <th className="num">AI schedule{edited ? " (as edited)" : ""}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, show, score]) => {
            const better = score(after) > score(b) + 0.01;
            const worse = score(after) < score(b) - 0.01;
            return (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{show(b)}</td>
                <td className={`num${better ? " better" : worse ? " worse" : ""}`}>
                  {show(after)} {better ? "▲" : worse ? "▼" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {source.result.repairs.length > 0 && (
        <details>
          <summary className="small">The app corrected {source.result.repairs.length} thing(s) in the AI's plan</summary>
          <ul className="small">
            {source.result.repairs.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">{formatInteger(source.result.tokens)} tokens (see Usage)</p>
    </div>
  );
}

/** What-if inputs. Blank fields fall back to the saved value, shown as the placeholder. */
function AdjustPanel({
  stations,
  buses,
  value,
  onChange,
}: {
  stations: PtStation[];
  buses: PtChargingDemand["buses"];
  value: Adjustments;
  onChange: (a: Adjustments) => void;
}) {
  const num = (s: string): number | undefined => (s.trim() === "" ? undefined : Math.max(0, Number(s)));

  function setCharger(key: string, field: "oneGun" | "twoGun", raw: string) {
    const next = { ...value.chargers };
    const c = { ...next[key], [field]: num(raw) };
    if (c.oneGun === undefined) delete c.oneGun;
    if (c.twoGun === undefined) delete c.twoGun;
    if (Object.keys(c).length) next[key] = c;
    else delete next[key];
    onChange({ ...value, chargers: next });
  }

  function setIntake(busId: number, raw: string, saved: number | null) {
    const next = { ...value.intake };
    const v = raw.trim() === "" ? undefined : Number(raw) > 0 ? Number(raw) : null;
    if (v === undefined || v === saved) delete next[busId];
    else next[busId] = v;
    onChange({ ...value, intake: next });
  }

  const shown = (n: number | undefined) => (n === undefined ? "" : String(n));

  return (
    <div className="adjust-panel stack">
      <p className="muted small">
        Try other values without changing the saved data. Leave a field empty to use the saved value (shown in grey). Outputs and intake change what
        each session delivers straight away; use <strong>Auto-schedule again</strong> to re-plan the sessions around them.
      </p>
      <div className="row wrap">
        <label className="field inline">
          <span>Plug-in delay after last trip (min)</span>
          <input
            type="number"
            min="0"
            step="10"
            placeholder={String(TURNAROUND)}
            value={shown(value.turnaround)}
            onChange={(e) => onChange({ ...value, turnaround: num(e.target.value) })}
          />
        </label>
        <label className="field inline">
          <span>Gap between sessions on a gun (min)</span>
          <input
            type="number"
            min="0"
            step="5"
            placeholder={String(BUFFER)}
            value={shown(value.buffer)}
            onChange={(e) => onChange({ ...value, buffer: num(e.target.value) })}
          />
        </label>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Charger</th>
              <th className="num">Guns</th>
              <th>One gun (kW)</th>
              <th>Each of two guns (kW)</th>
            </tr>
          </thead>
          <tbody>
            {stations.flatMap((s) =>
              s.chargers.map((c) => {
                const key = chargerKey({ stationId: s.station_id, chargerId: c.charger_id });
                const a = value.chargers[key];
                return (
                  <tr key={key} className={a ? "adjusted" : undefined}>
                    <td>
                      {s.station_name} · charger {c.charger_id}
                    </td>
                    <td className="num">{c.guns.length}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        placeholder={String(c.one_gun_output)}
                        value={shown(a?.oneGun)}
                        onChange={(e) => setCharger(key, "oneGun", e.target.value)}
                        aria-label={`One-gun output, ${s.station_name} charger ${c.charger_id}`}
                      />
                    </td>
                    <td>
                      {c.guns.length > 1 ? (
                        <input
                          type="number"
                          min="0"
                          placeholder={String(c.two_gun_output || c.one_gun_output)}
                          value={shown(a?.twoGun)}
                          onChange={(e) => setCharger(key, "twoGun", e.target.value)}
                          aria-label={`Two-gun output, ${s.station_name} charger ${c.charger_id}`}
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>

      {buses.length > 0 && (
        <details>
          <summary className="small">Bus maximum charging intake ({buses.length} buses)</summary>
          <p className="muted small">
            The most power a bus accepts. Empty means the saved value, or no limit when none is stated (the imported models don't state one).
          </p>
          <div className="intake-grid">
            {buses.map((b) => (
              <label key={b.bus_id} className={`field inline${b.bus_id in value.intake ? " adjusted" : ""}`}>
                <span>
                  Bus {b.bus_id} <span className="muted">{b.model}</span>
                </span>
                <input
                  type="number"
                  min="0"
                  placeholder={b.max_intake_kw ? String(b.max_intake_kw) : "no limit"}
                  value={b.bus_id in value.intake ? (value.intake[b.bus_id] ?? "") : ""}
                  onChange={(e) => setIntake(b.bus_id, e.target.value, b.max_intake_kw)}
                />
              </label>
            ))}
          </div>
        </details>
      )}

      <div className="row">
        <button className="small-btn" onClick={() => onChange(NO_ADJUSTMENTS)} disabled={!isAdjusted(value)}>
          Back to saved values
        </button>
      </div>
    </div>
  );
}

function ChargerPicker({ lanes, enabled, onChange }: { lanes: Lane[]; enabled: Set<string>; onChange: (s: Set<string>) => void }) {
  const byStation = new Map<number, Lane[]>();
  for (const l of lanes) byStation.set(l.stationId, [...(byStation.get(l.stationId) ?? []), l]);
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(enabled);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    onChange(next);
  };
  return (
    <details className="picker">
      <summary>
        Chargers: {enabled.size} of {lanes.length} guns
      </summary>
      <div className="picker-panel stack-tight">
        <div className="row">
          <button type="button" className="small-btn" onClick={() => onChange(new Set(lanes.map((l) => l.key)))}>
            All
          </button>
          <button type="button" className="small-btn" onClick={() => onChange(new Set())}>
            None
          </button>
        </div>
        {[...byStation.values()].map((ls) => {
          const all = ls.every((l) => enabled.has(l.key));
          return (
            <div key={ls[0].stationId} className="stack-tight">
              <label className="check">
                <input type="checkbox" checked={all} onChange={(e) => toggle(ls.map((l) => l.key), e.target.checked)} />
                <strong>{ls[0].stationName}</strong>
              </label>
              {ls.map((l) => (
                <label key={l.key} className="check indent">
                  <input type="checkbox" checked={enabled.has(l.key)} onChange={(e) => toggle([l.key], e.target.checked)} />
                  Charger {l.chargerId} · gun {l.gunId} <span className="muted small">({l.oneGun}/{l.twoGun} kW)</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </details>
  );
}

// --- Timeline -------------------------------------------------------------------------

const LANE_H = 52;
const LABEL_W = 170;
const EDGE = 7; // px at each end of a session that resizes instead of moving

interface Drag {
  busId: number;
  mode: "move" | "left" | "right";
  x0: number;
  y0: number;
  orig: Session;
}

function Timeline({
  lanes,
  sessions,
  results,
  needBy,
  onChange,
}: {
  lanes: Lane[];
  sessions: Session[];
  results: Map<number, SessionResult>;
  needBy: Map<number, BusNeed>;
  onChange: (s: Session[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<Session | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const trackW = Math.max(0, width - LABEL_W);
  const pxPerMin = trackW / DAY;
  const laneIndex = new Map(lanes.map((l, i) => [l.key, i]));
  const hourStep = trackW / 24 < 46 ? 2 : 1;

  function down(e: ReactPointerEvent<HTMLDivElement>, s: Session) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const mode = x < EDGE ? "left" : x > box.width - EDGE ? "right" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ busId: s.busId, mode, x0: e.clientX, y0: e.clientY, orig: s });
    setPreview(s);
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || !pxPerMin) return;
    const dm = snap((e.clientX - drag.x0) / pxPerMin);
    const o = drag.orig;
    let next: Session;
    if (drag.mode === "move") {
      const li = Math.max(0, Math.min(lanes.length - 1, (laneIndex.get(o.lane) ?? 0) + Math.round((e.clientY - drag.y0) / LANE_H)));
      next = { ...o, lane: lanes[li].key, start: Math.max(0, Math.min(DAY - o.duration, o.start + dm)) };
    } else if (drag.mode === "left") {
      const start = Math.max(0, Math.min(o.start + o.duration - SNAP, o.start + dm));
      next = { ...o, start, duration: o.start + o.duration - start };
    } else {
      next = { ...o, duration: Math.max(SNAP, Math.min(DAY - o.start, o.duration + dm)) };
    }
    setPreview(next);
  }

  function up() {
    if (drag && preview) onChange(sessions.map((s) => (s.busId === drag.busId ? preview : s)));
    setDrag(null);
    setPreview(null);
  }

  return (
    <div className="timeline" ref={ref}>
      {trackW > 0 && (
        <>
          <div className="tl-hours" style={{ marginLeft: LABEL_W }}>
            {Array.from({ length: 24 / hourStep }, (_, i) => (
              <span key={i} style={{ left: i * hourStep * 60 * pxPerMin }}>
                {clock(i * hourStep * 60)}
              </span>
            ))}
          </div>
          {lanes.map((l) => (
            <div key={l.key} className="tl-lane" style={{ height: LANE_H }}>
              <div className="tl-label" style={{ width: LABEL_W }}>
                <span>{l.stationName}</span>
                <span className="muted small">
                  Charger {l.chargerId} · gun {l.gunId}
                </span>
              </div>
              <div className="tl-track" style={{ width: trackW, backgroundSize: `${hourStep * 60 * pxPerMin}px 100%` }}>
                {sessions
                  .filter((s0) => (preview && preview.busId === s0.busId ? preview.lane : s0.lane) === l.key)
                  .map((s0) => {
                    const s = preview && preview.busId === s0.busId ? preview : s0;
                    const n = needBy.get(s.busId);
                    const r = results.get(s.busId);
                    const ok = r && n && r.deliveredKwh >= n.requiredKwh - 0.05;
                    const w = s.duration * pxPerMin;
                    const title = `Bus ${s.busId}: ${clock(s.start)}–${clock(s.start + s.duration)} (${s.duration} min) · needs ${kwh(n?.requiredKwh ?? 0)}, gets ${kwh(
                      r?.deliveredKwh ?? 0,
                    )}${r?.late ? " · finishes after its first departure" : ""}`;
                    return (
                      <div
                        key={s.busId}
                        className={`tl-session ${ok ? "ok" : "short"}${drag?.busId === s.busId ? " dragging" : ""}${r?.late ? " late" : ""}`}
                        style={{ left: s.start * pxPerMin, width: w }}
                        title={title}
                        onPointerDown={(e) => down(e, s0)}
                        onPointerMove={move}
                        onPointerUp={up}
                        onPointerCancel={up}
                      >
                        {r?.segments
                          .filter((g) => g.shared)
                          .map((g, i) => (
                            <span key={i} className="tl-shared" style={{ left: (g.start - s.start) * pxPerMin, width: (g.end - g.start) * pxPerMin }} />
                          ))}
                        <span className="tl-text">
                          <strong>{s.busId}</strong>
                          {w > 90 && ` ${clock(s.start)}–${clock(s.start + s.duration)}`}
                          {w > 150 && n && ` · ${formatInteger(r?.deliveredKwh ?? 0)}/${formatInteger(n.requiredKwh)} kWh`}
                        </span>
                      </div>
                    );
                  })}
                {sessions
                  .filter((s) => s.lane === l.key)
                  .map((s) => {
                    const n = needBy.get(s.busId);
                    return results.get(s.busId)?.late && n?.deadline != null ? (
                      <span key={`d${s.busId}`} className="tl-deadline" style={{ left: n.deadline * pxPerMin }} title={`Bus ${s.busId} first departure ${clock(n.deadline)}`} />
                    ) : null;
                  })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
