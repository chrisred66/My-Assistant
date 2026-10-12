// PT Operations: adding trip data (edit access) and resolving conflicting duplicates (admin).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../../components/common";
import {
  api,
  canPt,
  type PtDataset,
  type PtDuplicate,
  type PtManualTrip,
  type PtSaveResult,
  type PtTrial,
  type PtTripOptions,
  type PtTripTarget,
  type PtUploadPreview,
  type User,
} from "../../lib/api";
import { errorMessage, formatInteger } from "../../lib/format";
import { track } from "../../lib/activity";

type Tool = "upload" | "manual" | "duplicates";

function saved(r: PtSaveResult) {
  const parts = [`${formatInteger(r.inserted)} new trip(s) saved`];
  if (r.identical) parts.push(`${formatInteger(r.identical)} already there (skipped)`);
  if (r.conflicts) parts.push(`${formatInteger(r.conflicts)} conflicting with existing trips (see Duplicates)`);
  return parts.join(" · ");
}

export default function TripTools({
  user,
  options,
  onChanged,
  dataset = "fleet",
  trials = [],
  defaultTrial,
}: {
  user: User;
  options: PtTripOptions;
  onChanged: () => void;
  dataset?: PtDataset;
  trials?: PtTrial[];
  defaultTrial?: string;
}) {
  const isTrial = dataset === "trial";
  const [tool, setTool] = useState<Tool | null>(null);
  const [dupCount, setDupCount] = useState<number | null>(null);
  // Trials: which trial new trips belong to (every trip is that trial's bus).
  const [trialId, setTrialId] = useState(defaultTrial ?? (trials.length === 1 ? String(trials[0].trial_id) : ""));
  useEffect(() => {
    if (defaultTrial) setTrialId(defaultTrial);
  }, [defaultTrial]);
  const trial = trials.find((t) => String(t.trial_id) === trialId);
  const target: PtTripTarget | undefined = isTrial ? (trial ? { dataset: "trial", trial: trial.trial_id } : undefined) : {};

  const countDuplicates = useCallback(() => {
    if (isTrial) return; // conflicting trial trips are only counted, not kept
    api.ptDuplicates().then((d) => setDupCount(d.length), () => setDupCount(null));
  }, [isTrial]);

  useEffect(countDuplicates, [countDuplicates]);

  const changed = () => {
    onChanged();
    countDuplicates();
  };

  return (
    <div className="card stack">
      <div className="row space-between wrap">
        <h2>Trip data</h2>
        <div className="segmented" role="tablist" aria-label="Trip data tools">
          <button role="tab" aria-selected={tool === "upload"} className={tool === "upload" ? "on" : ""} onClick={() => setTool(tool === "upload" ? null : "upload")}>
            Upload file
          </button>
          <button role="tab" aria-selected={tool === "manual"} className={tool === "manual" ? "on" : ""} onClick={() => setTool(tool === "manual" ? null : "manual")}>
            Enter trips
          </button>
          {!isTrial && (
            <button
              role="tab"
              aria-selected={tool === "duplicates"}
              className={tool === "duplicates" ? "on" : ""}
              onClick={() => setTool(tool === "duplicates" ? null : "duplicates")}
            >
              Duplicates{dupCount ? ` (${dupCount})` : ""}
            </button>
          )}
        </div>
      </div>
      {isTrial && tool !== null && (
        <div className="row wrap">
          <label className="field inline">
            <span>Trial</span>
            <select value={trialId} onChange={(e) => setTrialId(e.target.value)}>
              <option value="">Choose a trial…</option>
              {trials.map((t) => (
                <option key={t.trial_id} value={t.trial_id} disabled={!t.bus_label}>
                  {t.trial_name}
                  {t.bus_label ? ` · bus ${t.bus_label}` : " (no bus)"}
                </option>
              ))}
            </select>
          </label>
          {trials.length === 0 && <span className="muted small align-end">Create a trial first (above).</span>}
        </div>
      )}
      {tool === null && (
        <p className="muted small">
          {isTrial
            ? "Upload a trial's trip log (.csv or .xlsx) or enter trips by hand. Every trip is recorded against the trial's bus, so the Bus ID column is optional."
            : "Upload a trip-log file (.csv or .xlsx), enter a driver's trips by hand, or review conflicting duplicates."}
        </p>
      )}
      {tool !== null && tool !== "duplicates" && target === undefined && <p className="muted small">Choose the trial these trips belong to.</p>}
      {tool === "upload" && target && <Upload key={trialId} target={target} isTrial={isTrial} onChanged={changed} />}
      {tool === "manual" && target && <ManualEntry key={trialId} options={options} target={target} isTrial={isTrial} onChanged={changed} />}
      {tool === "duplicates" && !isTrial && <Duplicates canResolve={canPt(user, "operations", "manage")} onChanged={changed} />}
    </div>
  );
}

function Upload({ target, isTrial, onChanged }: { target: PtTripTarget; isTrial: boolean; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [dateOrder, setDateOrder] = useState<"dmy" | "mdy" | undefined>(undefined);
  const [preview, setPreview] = useState<PtUploadPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function check(f: File, order?: "dmy" | "mdy") {
    setBusy(true);
    setError(null);
    setDone(null);
    setPreview(null);
    try {
      const p = await track("uploading", "Reading file", () => api.ptUploadPreview(f, order, target));
      setPreview(p);
      setDateOrder(p.date_order);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importFile() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await track("importing", "Trip import", () => api.ptUploadImport(file, dateOrder, target));
      setDone(`${file.name}: ${saved(r)}.`);
      setPreview(null);
      setFile(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted small">
        Columns needed (any order, spacing and case don't matter): Date, Driver ID, {isTrial ? "" : "Bus ID, "}Route, Start Time, End Time, Start KM,
        End KM, Start SOC, End SOC.{" "}
        {isTrial ? "A Bus ID column is optional; rows naming a different bus are skipped." : "Other columns are kept with the trip."} You'll see a
        preview before anything is saved.
      </p>
      <div className="row wrap">
        <label className="file-btn">
          {file ? file.name : "Choose file…"}
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              setFile(f);
              if (f) void check(f);
            }}
          />
        </label>
        {busy && <span className="muted small">Working…</span>}
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{done}</p>}
      {preview && file && (
        <div className="stack">
          <dl className="kv">
            <dt>Readable trips</dt>
            <dd>
              {formatInteger(preview.rows)}
              {preview.skipped > 0 && <span className="muted"> · {formatInteger(preview.skipped)} row(s) skipped</span>}
            </dd>
            <dt>Dates</dt>
            <dd>
              {preview.first_date} to {preview.last_date} ({preview.days} day(s))
            </dd>
            <dt>Date format</dt>
            <dd>
              <select
                value={dateOrder}
                onChange={(e) => {
                  const order = e.target.value as "dmy" | "mdy";
                  setDateOrder(order);
                  void check(file, order);
                }}
              >
                <option value="dmy">Day/month/year (31/12/2025)</option>
                <option value="mdy">Month/day/year (12/31/2025)</option>
              </select>
              <span className="muted small"> only matters for dates written with slashes{preview.date_order_detected === preview.date_order ? " · detected from the file" : ""}</span>
            </dd>
            <dt>Would save</dt>
            <dd>
              <strong>{formatInteger(preview.would.new)} new</strong> · {formatInteger(preview.would.identical)} already there ·{" "}
              {formatInteger(preview.would.conflict)} conflicting
            </dd>
            {preview.unknown_buses.length > 0 && (
              <>
                <dt>Not in the fleet</dt>
                <dd className="error-text small">
                  Bus {preview.unknown_buses.join(", ")}: trips are saved, but without energy figures. Add these buses in Fleet first if you want them.
                </dd>
              </>
            )}
            {preview.extra_columns.length > 0 && (
              <>
                <dt>Extra columns</dt>
                <dd className="small">{preview.extra_columns.join(", ")} (kept with each trip)</dd>
              </>
            )}
          </dl>
          {preview.skipped_examples.length > 0 && (
            <details>
              <summary className="small">Skipped rows</summary>
              <ul className="small">
                {preview.skipped_examples.map((s) => (
                  <li key={s.line}>
                    Line {s.line}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="num">Bus</th>
                  <th>Route</th>
                  <th className="num">Driver</th>
                  <th>Time</th>
                  <th className="num">Km</th>
                  <th className="num">SOC</th>
                  <th className="num">Energy</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`badge badge-${r.status === "new" ? "good" : r.status === "conflict" ? "serious" : "info"}`}>{r.status}</span>
                    </td>
                    <td className="nowrap">{r.date}</td>
                    <td className="num mono">{r.bus_id}</td>
                    <td>{r.route ?? "—"}</td>
                    <td className="num mono">{r.driver_id ?? "—"}</td>
                    <td className="mono nowrap">
                      {r.start_time ?? "?"}–{r.end_time ?? "?"}
                    </td>
                    <td className="num">
                      {r.start_km} → {r.end_km}
                    </td>
                    <td className="num">
                      {r.start_soc} → {r.end_soc}%
                    </td>
                    <td className="num">{r.energy_used === null ? "—" : r.energy_used.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows > preview.preview.length && <p className="muted small">First {preview.preview.length} of {formatInteger(preview.rows)} shown.</p>}
          <div className="row">
            <button className="primary" disabled={busy || preview.would.new + preview.would.conflict === 0} onClick={() => void importFile()}>
              {busy ? "Saving…" : `Save ${formatInteger(preview.would.new)} new trip(s)`}
            </button>
            <button
              onClick={() => {
                setPreview(null);
                setFile(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const emptyTrip = (): Record<keyof PtManualTrip, string> => ({ start_time: "", end_time: "", start_km: "", end_km: "", start_soc: "", end_soc: "" });

function ManualEntry({
  options,
  target,
  isTrial,
  onChanged,
}: {
  options: PtTripOptions;
  target: PtTripTarget;
  isTrial: boolean;
  onChanged: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [driver, setDriver] = useState("");
  const [bus, setBus] = useState("");
  const [route, setRoute] = useState("");
  const [trips, setTrips] = useState([emptyTrip()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const set = (i: number, k: keyof PtManualTrip, v: string) => setTrips((ts) => ts.map((t, j) => (j === i ? { ...t, [k]: v } : t)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await track("uploading", "Saving trips", () => api.ptAddTrips({
        ...target,
        date,
        driver_id: Number(driver),
        bus_id: isTrial ? undefined : Number(bus),
        route: route.trim(),
        trips: trips.map((t) => ({
          start_time: t.start_time,
          end_time: t.end_time,
          start_km: Number(t.start_km),
          end_km: Number(t.end_km),
          start_soc: Number(t.start_soc),
          end_soc: Number(t.end_soc),
        })),
      }));
      setDone(`${saved(r)}.`);
      setTrips([emptyTrip()]);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row wrap">
        <label className="field inline">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>Driver ID</span>
          <input type="number" min="1" step="1" value={driver} onChange={(e) => setDriver(e.target.value)} required />
        </label>
        {!isTrial && (
          <label className="field inline">
            <span>Bus</span>
            <input type="number" min="1" step="1" list="pt-buses" value={bus} onChange={(e) => setBus(e.target.value)} required />
            <datalist id="pt-buses">
              {options.buses.map((b) => (
                <option key={b.bus_id} value={b.bus_id}>
                  {b.model ?? ""}
                </option>
              ))}
            </datalist>
          </label>
        )}
        <label className="field inline">
          <span>Route</span>
          <input list="pt-routes" value={route} onChange={(e) => setRoute(e.target.value)} required />
          <datalist id="pt-routes">
            {options.routes.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Start time</th>
              <th>End time</th>
              <th>Start km</th>
              <th>End km</th>
              <th>Start SOC %</th>
              <th>End SOC %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trips.map((t, i) => (
              <tr key={i}>
                <td>
                  <input type="time" value={t.start_time} onChange={(e) => set(i, "start_time", e.target.value)} required aria-label="Start time" />
                </td>
                <td>
                  <input type="time" value={t.end_time} onChange={(e) => set(i, "end_time", e.target.value)} required aria-label="End time" />
                </td>
                <td>
                  <input type="number" min="0" step="any" value={t.start_km} onChange={(e) => set(i, "start_km", e.target.value)} required aria-label="Start km" />
                </td>
                <td>
                  <input type="number" min="0" step="any" value={t.end_km} onChange={(e) => set(i, "end_km", e.target.value)} required aria-label="End km" />
                </td>
                <td>
                  <input type="number" min="0" max="100" step="any" value={t.start_soc} onChange={(e) => set(i, "start_soc", e.target.value)} required aria-label="Start SOC" />
                </td>
                <td>
                  <input type="number" min="0" max="100" step="any" value={t.end_soc} onChange={(e) => set(i, "end_soc", e.target.value)} required aria-label="End SOC" />
                </td>
                <td className="num">
                  {trips.length > 1 && (
                    <button type="button" className="small-btn" onClick={() => setTrips((ts) => ts.filter((_, j) => j !== i))} aria-label={`Remove trip ${i + 1}`}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          type="button"
          className="small-btn"
          onClick={() =>
            // The next trip usually starts where the last one ended.
            setTrips((ts) => [...ts, { ...emptyTrip(), start_km: ts[ts.length - 1].end_km, start_soc: ts[ts.length - 1].end_soc }])
          }
        >
          Add trip
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : `Save ${trips.length} trip(s)`}
        </button>
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{done}</p>}
    </form>
  );
}

const DUP_FIELDS: [string, string][] = [
  ["date", "Date"],
  ["driver_id", "Driver"],
  ["route", "Route"],
  ["start_time", "Start"],
  ["end_time", "End"],
  ["start_km", "Start km"],
  ["end_km", "End km"],
  ["start_soc", "Start SOC"],
  ["end_soc", "End SOC"],
];

/** Compare loosely: "04:42:00" vs "4:42:00", 55377 vs "55377.00". */
function same(a: unknown, b: unknown) {
  const norm = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.padStart(8, "0").slice(0, 5);
    return Number.isFinite(Number(s)) && s !== "" ? String(Number(s)) : s;
  };
  return norm(a) === norm(b);
}

function Duplicates({ canResolve, onChanged }: { canResolve: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<PtDuplicate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.ptDuplicates());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(d: PtDuplicate, action: "keep" | "replace") {
    setError(null);
    try {
      await api.ptResolveDuplicate(d.id, action);
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="stack">
      <p className="muted small">
        Uploaded trips with the same date, bus and odometer readings as a saved trip, but different values. Differences are highlighted.
        {!canResolve && " Resolving them needs admin access."}
      </p>
      <ErrorText message={error} />
      {rows?.length === 0 && <p className="muted">No conflicting duplicates.</p>}
      {rows?.map((d) => (
        <div key={d.id} className="dup">
          <div className="row space-between wrap">
            <span className="small">
              <strong className="mono">{d.entry_key}</strong> · from {d.source_file ?? "unknown"} · {d.detected_at}
            </span>
            {canResolve && (
              <div className="row">
                <button className="small-btn" onClick={() => void resolve(d, "keep")}>
                  Keep saved
                </button>
                <button className="small-btn" onClick={() => void resolve(d, "replace")} disabled={!d.existing}>
                  Use uploaded
                </button>
              </div>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th />
                {DUP_FIELDS.map(([, label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Saved", d.existing],
                  ["Uploaded", d.incoming],
                ] as const
              ).map(([label, row]) => (
                <tr key={label}>
                  <th>{label}</th>
                  {DUP_FIELDS.map(([k]) => (
                    <td key={k} className={row && !same(d.existing?.[k], d.incoming?.[k]) ? "diff" : undefined}>
                      {row ? String(row[k] ?? "—") : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
