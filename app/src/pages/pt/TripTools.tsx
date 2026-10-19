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
import { errorMessage, formatDateTime, formatDay, formatInteger } from "../../lib/format";
import { track } from "../../lib/activity";
import { t } from "../../lib/i18n";

type Tool = "upload" | "manual" | "duplicates";

function saved(r: PtSaveResult) {
  const parts = [t("{inserted} new trip(s) saved", { inserted: formatInteger(r.inserted) })];
  if (r.identical) parts.push(t("{identical} already there (skipped)", { identical: formatInteger(r.identical) }));
  if (r.conflicts) parts.push(t("{conflicts} conflicting with existing trips (see Duplicates)", { conflicts: formatInteger(r.conflicts) }));
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
  const trial = trials.find((tripItem) => String(tripItem.trial_id) === trialId);
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
        <h2>{t("Trip data")}</h2>
        <div className="segmented" role="tablist" aria-label={t("Trip data tools")}>
          <button role="tab" aria-selected={tool === "upload"} className={tool === "upload" ? "on" : ""} onClick={() => setTool(tool === "upload" ? null : "upload")}>
            {t("Upload file")}
          </button>
          <button role="tab" aria-selected={tool === "manual"} className={tool === "manual" ? "on" : ""} onClick={() => setTool(tool === "manual" ? null : "manual")}>
            {t("Enter trips")}
          </button>
          {!isTrial && (
            <button
              role="tab"
              aria-selected={tool === "duplicates"}
              className={tool === "duplicates" ? "on" : ""}
              onClick={() => setTool(tool === "duplicates" ? null : "duplicates")}
            >{t("Duplicates{v}", { v: dupCount ? ` (${dupCount})` : "" })}</button>
          )}
        </div>
      </div>
      {isTrial && tool !== null && (
        <div className="row wrap">
          <label className="field inline">
            <span>{t("Trial")}</span>
            <select value={trialId} onChange={(e) => setTrialId(e.target.value)}>
              <option value="">{t("Choose a trial…")}</option>
              {trials.map((tripItem) => (
                <option key={tripItem.trial_id} value={tripItem.trial_id} disabled={!tripItem.bus_label}>
                  {tripItem.trial_name}
                  {tripItem.bus_label ? t(" · bus {label}", { label: tripItem.bus_label }) : t(" (no bus)")}
                </option>
              ))}
            </select>
          </label>
          {trials.length === 0 && <span className="muted small align-end">{t("Create a trial first (above).")}</span>}
        </div>
      )}
      {tool === null && (
        <p className="muted small">
          {isTrial
            ? t("Upload a trial's trip log (.csv or .xlsx) or enter trips by hand. Every trip is recorded against the trial's bus, so the Bus ID column is optional.")
            : t("Upload a trip-log file (.csv or .xlsx), enter a driver's trips by hand, or review conflicting duplicates.")}
        </p>
      )}
      {tool !== null && tool !== "duplicates" && target === undefined && <p className="muted small">{t("Choose the trial these trips belong to.")}</p>}
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
      const p = await track("uploading", t("Reading file"), () => api.ptUploadPreview(f, order, target));
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
      const r = await track("importing", t("Trip import"), () => api.ptUploadImport(file, dateOrder, target));
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
      <p className="muted small">{t("Columns needed (any order, spacing and case don't matter): Date, Driver ID, {v}Route, Start Time, End Time, Start KM, End KM, Start SOC, End SOC. {v2} You'll see a preview before anything is saved.", { v: isTrial ? "" : t("Bus ID, "), v2: isTrial ? t("A Bus ID column is optional; rows naming a different bus are skipped.") : t("Other columns are kept with the trip.") })}</p>
      <div className="row wrap">
        <label className="file-btn">
          {file ? file.name : t("Choose file…")}
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
        {busy && <span className="muted small">{t("Working…")}</span>}
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{done}</p>}
      {preview && file && (
        <div className="stack">
          <dl className="kv">
            <dt>{t("Readable trips")}</dt>
            <dd>
              {formatInteger(preview.rows)}
              {preview.skipped > 0 && <span className="muted">{t("· {skipped} row(s) skipped", { skipped: formatInteger(preview.skipped) })}</span>}
            </dd>
            <dt>{t("Dates")}</dt>
            <dd>{t("{first_date} to {last_date} ({days} day(s))", { first_date: formatDay(preview.first_date), last_date: formatDay(preview.last_date), days: preview.days })}</dd>
            <dt>{t("Date format")}</dt>
            <dd>
              <select
                value={dateOrder}
                onChange={(e) => {
                  const order = e.target.value as "dmy" | "mdy";
                  setDateOrder(order);
                  void check(file, order);
                }}
              >
                <option value="dmy">{t("Day/month/year (31/12/2025)")}</option>
                <option value="mdy">{t("Month/day/year (12/31/2025)")}</option>
              </select>
              <span className="muted small">{t("only matters for dates written with slashes{v}", { v: preview.date_order_detected === preview.date_order ? t(" · detected from the file") : "" })}</span>
            </dd>
            <dt>{t("Would save")}</dt>
            <dd>
              <strong>{t("{new} new", { new: formatInteger(preview.would.new) })}</strong> ·{" "}
              {t("{identical} already there · {conflict} conflicting", { identical: formatInteger(preview.would.identical), conflict: formatInteger(preview.would.conflict) })}
            </dd>
            {preview.unknown_buses.length > 0 && (
              <>
                <dt>{t("Not in the fleet")}</dt>
                <dd className="error-text small">{t("Bus {join}: trips are saved, but without energy figures. Add these buses in Fleet first if you want them.", { join: preview.unknown_buses.join(", ") })}</dd>
              </>
            )}
            {preview.extra_columns.length > 0 && (
              <>
                <dt>{t("Extra columns")}</dt>
                <dd className="small">{t("{join} (kept with each trip)", { join: preview.extra_columns.join(", ") })}</dd>
              </>
            )}
          </dl>
          {preview.skipped_examples.length > 0 && (
            <details>
              <summary className="small">{t("Skipped rows")}</summary>
              <ul className="small">
                {preview.skipped_examples.map((s) => (
                  <li key={s.line}>{t("Line {line}: {reason}", { line: s.line, reason: s.reason })}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Status")}</th>
                  <th>{t("Date")}</th>
                  <th className="num">{t("Bus")}</th>
                  <th>{t("Route")}</th>
                  <th className="num">{t("Driver")}</th>
                  <th>{t("Time")}</th>
                  <th className="num">{t("Km")}</th>
                  <th className="num">{t("SOC")}</th>
                  <th className="num">{t("Energy")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`badge badge-${r.status === "new" ? "good" : r.status === "conflict" ? "serious" : "info"}`}>{r.status}</span>
                    </td>
                    <td className="nowrap">{formatDay(r.date)}</td>
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
          {preview.rows > preview.preview.length && <p className="muted small">{t("First {count} of {rows} shown.", { count: preview.preview.length, rows: formatInteger(preview.rows) })}</p>}
          <div className="row">
            <button className="primary" disabled={busy || preview.would.new + preview.would.conflict === 0} onClick={() => void importFile()}>
              {busy ? t("Saving…") : t("Save {new} new trip(s)", { new: formatInteger(preview.would.new) })}
            </button>
            <button
              onClick={() => {
                setPreview(null);
                setFile(null);
              }}
            >
              {t("Cancel")}
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

  const set = (i: number, k: keyof PtManualTrip, v: string) => setTrips((ts) => ts.map((tripItem, j) => (j === i ? { ...tripItem, [k]: v } : tripItem)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await track("uploading", t("Saving trips"), () => api.ptAddTrips({
        ...target,
        date,
        driver_id: Number(driver),
        bus_id: isTrial ? undefined : Number(bus),
        route: route.trim(),
        trips: trips.map((tripItem) => ({
          start_time: tripItem.start_time,
          end_time: tripItem.end_time,
          start_km: Number(tripItem.start_km),
          end_km: Number(tripItem.end_km),
          start_soc: Number(tripItem.start_soc),
          end_soc: Number(tripItem.end_soc),
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
          <span>{t("Date")}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>{t("Driver ID")}</span>
          <input type="number" min="1" step="1" value={driver} onChange={(e) => setDriver(e.target.value)} required />
        </label>
        {!isTrial && (
          <label className="field inline">
            <span>{t("Bus")}</span>
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
          <span>{t("Route")}</span>
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
              <th>{t("Start time")}</th>
              <th>{t("End time")}</th>
              <th>{t("Start km")}</th>
              <th>{t("End km")}</th>
              <th>{t("Start SOC %")}</th>
              <th>{t("End SOC %")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trips.map((tripItem, i) => (
              <tr key={i}>
                <td>
                  <input type="time" value={tripItem.start_time} onChange={(e) => set(i, "start_time", e.target.value)} required aria-label={t("Start time")} />
                </td>
                <td>
                  <input type="time" value={tripItem.end_time} onChange={(e) => set(i, "end_time", e.target.value)} required aria-label={t("End time")} />
                </td>
                <td>
                  <input type="number" min="0" step="any" value={tripItem.start_km} onChange={(e) => set(i, "start_km", e.target.value)} required aria-label={t("Start km")} />
                </td>
                <td>
                  <input type="number" min="0" step="any" value={tripItem.end_km} onChange={(e) => set(i, "end_km", e.target.value)} required aria-label={t("End km")} />
                </td>
                <td>
                  <input type="number" min="0" max="100" step="any" value={tripItem.start_soc} onChange={(e) => set(i, "start_soc", e.target.value)} required aria-label={t("Start SOC")} />
                </td>
                <td>
                  <input type="number" min="0" max="100" step="any" value={tripItem.end_soc} onChange={(e) => set(i, "end_soc", e.target.value)} required aria-label={t("End SOC")} />
                </td>
                <td className="num">
                  {trips.length > 1 && (
                    <button type="button" className="small-btn" onClick={() => setTrips((ts) => ts.filter((_, j) => j !== i))} aria-label={t("Remove trip {v}", { v: i + 1 })}>
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
          {t("Add trip")}
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t("Saving…") : t("Save {count} trip(s)", { count: trips.length })}
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
      <p className="muted small">{t("Uploaded trips with the same date, bus and odometer readings as a saved trip, but different values. Differences are highlighted.{v}", { v: !canResolve && t(" Resolving them needs admin access.") })}</p>
      <ErrorText message={error} />
      {rows?.length === 0 && <p className="muted">{t("No conflicting duplicates.")}</p>}
      {rows?.map((d) => (
        <div key={d.id} className="dup">
          <div className="row space-between wrap">
            <span className="small">
              <strong className="mono">{d.entry_key}</strong> · {t("from {file}", { file: d.source_file ?? t("unknown") })} · {formatDateTime(d.detected_at)}
            </span>
            {canResolve && (
              <div className="row">
                <button className="small-btn" onClick={() => void resolve(d, "keep")}>
                  {t("Keep saved")}
                </button>
                <button className="small-btn" onClick={() => void resolve(d, "replace")} disabled={!d.existing}>
                  {t("Use uploaded")}
                </button>
              </div>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th />
                {DUP_FIELDS.map(([, label]) => (
                  <th key={label}>{t(label)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [t("Saved"), d.existing],
                  [t("Uploaded"), d.incoming],
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
