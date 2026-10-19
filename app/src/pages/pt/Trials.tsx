// PT Management → Trials: trial buses, trials (one trial bus on a route for a period), and the same dashboard as
// Operations over trial trips only. Ported from ptManagement's trial monitoring.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../../components/common";
import { api, canPt, type PtManufacturer, type PtTrial, type PtTrialBus, type PtTrialStatus, type User } from "../../lib/api";
import { errorMessage, formatDay, formatInteger } from "../../lib/format";
import Operations from "./Operations";
import { t } from "../../lib/i18n";

const STATUS_LABELS: Record<PtTrialStatus, string> = { planned: "Planned", in_progress: "In progress", completed: "Completed" };

export default function Trials({ user }: { user: User }) {
  const [trials, setTrials] = useState<PtTrial[] | null>(null);
  const [buses, setBuses] = useState<PtTrialBus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"trial" | "bus" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const canAdd = canPt(user, "planning", "add"); // new trials and trial buses
  const canEdit = canPt(user, "planning", "manage"); // status, adding to the fleet

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, b] = await Promise.all([api.ptTrials(), api.ptTrialBuses()]);
      setTrials(t);
      setBuses(b);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => {
    setAdding(null);
    setRefreshKey((k) => k + 1);
    void load();
  };

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function promote(b: PtTrialBus) {
    const n = window.prompt(t("Add trial bus {bus_id} ({v}) to the fleet as bus number… (the number used in trip logs)", { bus_id: b.bus_id, v: b.model ?? "model?" }));
    if (!n) return;
    const plate = window.prompt(t("Plate (optional)"), "") ?? "";
    void act(() => api.ptPromoteTrialBus(b.trial_bus_id, Number(n), plate.trim() || undefined));
  }

  const activeBuses = (buses ?? []).filter((b) => b.status !== "promoted");

  return (
    <div className="stack">
      <ErrorText message={error} />

      <div className="card stack">
        <div className="row space-between wrap">
          <h2>{t("Trials")}</h2>
          {canAdd && (
            <button className="small-btn" onClick={() => setAdding(adding === "trial" ? null : "trial")} aria-expanded={adding === "trial"}>
              {adding === "trial" ? t("Cancel") : t("New trial…")}
            </button>
          )}
        </div>
        {adding === "trial" && <AddTrial buses={activeBuses} onAdded={changed} onAddBus={() => setAdding("bus")} />}
        {trials === null && !error && <p className="muted">{t("Loading…")}</p>}
        {trials?.length === 0 && <p className="muted">{t("No trials yet. Add a trial bus, then create a trial for it.")}</p>}
        {trials && trials.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Trial")}</th>
                  <th>{t("Bus")}</th>
                  <th>{t("Route")}</th>
                  <th>{t("Period")}</th>
                  <th className="num">{t("Trips")}</th>
                  <th className="num">{t("Distance")}</th>
                  <th>{t("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {trials.map((trial) => (
                  <tr key={trial.trial_id}>
                    <td>
                      <strong>{trial.trial_name}</strong>
                      {(trial.load_condition || trial.notes) && <div className="muted small">{[trial.load_condition, trial.notes].filter(Boolean).join(" · ")}</div>}
                    </td>
                    <td>
                      {trial.bus_label ?? <span className="muted">—</span>}
                      {trial.model && (
                        <div className="muted small">
                          {trial.manufacturer} {trial.model}
                        </div>
                      )}
                    </td>
                    <td>{trial.route ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {trial.start_date ? formatDay(trial.start_date) : "?"} → {trial.end_date ? formatDay(trial.end_date) : t("open")}
                      {trial.first_trip && (
                        <div className="muted small">{t("trips {first_trip} to {last_trip}", { first_trip: formatDay(trial.first_trip), last_trip: formatDay(trial.last_trip) })}</div>
                      )}
                    </td>
                    <td className="num">{formatInteger(trial.trips)}</td>
                    <td className="num">{t("{integer} km", { integer: formatInteger(Math.round(trial.distance)) })}</td>
                    <td>
                      {canEdit ? (
                        <select
                          value={trial.status}
                          onChange={(e) => void act(() => api.ptUpdateTrial(trial.trial_id, { status: e.target.value as PtTrialStatus }))}
                          aria-label={t("Status of {trial_name}", { trial_name: trial.trial_name })}
                        >
                          {(Object.keys(STATUS_LABELS) as PtTrialStatus[]).map((s) => (
                            <option key={s} value={s}>
                              {t(STATUS_LABELS[s])}
                            </option>
                          ))}
                        </select>
                      ) : (
                        t(STATUS_LABELS[trial.status])
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details className="card" open={adding === "bus" || (buses !== null && buses.length === 0)}>
        <summary>{t("Trial buses ({v})", { v: buses?.length ?? "…" })}</summary>
        <div className="stack pt-tables">
          {canAdd && (
            <div>
              <button className="small-btn" onClick={() => setAdding(adding === "bus" ? null : "bus")} aria-expanded={adding === "bus"}>
                {adding === "bus" ? t("Cancel") : t("Add trial bus…")}
              </button>
            </div>
          )}
          {adding === "bus" && <AddTrialBus onAdded={changed} />}
          {buses && buses.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Bus")}</th>
                  <th>{t("Model")}</th>
                  <th>{t("Energy")}</th>
                  <th className="num">{t("Trials")}</th>
                  <th className="num">{t("Trips")}</th>
                  <th>{t("Status")}</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {buses.map((b) => (
                  <tr key={b.trial_bus_id}>
                    <td className="mono">
                      {b.bus_id}
                      {b.notes && <div className="muted small">{b.notes}</div>}
                    </td>
                    <td>
                      {b.manufacturer} {b.model} {b.model_year ? `(${b.model_year})` : ""}
                      {b.bus_length && (
                        <div className="muted small">
                          {b.bus_length} m {b.bus_type}
                        </div>
                      )}
                    </td>
                    <td>{b.energy_source ?? "—"}</td>
                    <td className="num">{b.trials}</td>
                    <td className="num">{formatInteger(b.trips)}</td>
                    <td>{b.status === "promoted" ? t("In the fleet as bus {promoted_to_bus_id}", { promoted_to_bus_id: b.promoted_to_bus_id }) : b.status === "active" ? t("On trial") : t("Finished")}</td>
                    {canEdit && (
                      <td className="num">
                        {b.status !== "promoted" && (
                          <button className="small-btn" onClick={() => promote(b)} title={t("Add this bus to the fleet")}>
                            {t("Add to fleet…")}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </details>

      {trials && <Operations user={user} dataset="trial" trials={trials} refreshKey={refreshKey} />}
    </div>
  );
}

function AddTrial({ buses, onAdded, onAddBus }: { buses: PtTrialBus[]; onAdded: () => void; onAddBus: () => void }) {
  const [name, setName] = useState("");
  const [bus, setBus] = useState(buses[0] ? String(buses[0].trial_bus_id) : "");
  const [route, setRoute] = useState("");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState("");
  const [load, setLoad] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (buses.length === 0) {
    return (
      <p className="small">
        {t("A trial needs a trial bus.")}{" "}
        <button className="link-btn" onClick={onAddBus}>
          <u>{t("Add a trial bus first")}</u>
        </button>
        .
      </p>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ptAddTrial({
        trial_name: name.trim(),
        trial_bus_id: Number(bus),
        route: route.trim() || undefined,
        start_date: start,
        end_date: end || undefined,
        load_condition: load.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder={t("e.g. Yutong U12 on route 65, summer")} />
        </label>
        <label className="field inline">
          <span>{t("Trial bus")}</span>
          <select value={bus} onChange={(e) => setBus(e.target.value)}>
            {buses.map((b) => (
              <option key={b.trial_bus_id} value={b.trial_bus_id}>
                {b.bus_id} · {b.model}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Route")}</span>
          <input value={route} onChange={(e) => setRoute(e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Start")}</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>{t("End (optional)")}</span>
          <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="field inline">
          <span>{t("Load condition")}</span>
          <input value={load} onChange={(e) => setLoad(e.target.value)} placeholder={t("e.g. full, ballast 4 t")} />
        </label>
        <label className="field inline grow">
          <span>{t("Notes")}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? t("Creating…") : t("Create trial")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

function AddTrialBus({ onAdded }: { onAdded: () => void }) {
  const [makers, setMakers] = useState<PtManufacturer[] | null>(null);
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.ptManufacturers().then(
      (m) => {
        setMakers(m);
        setModel((cur) => cur || (m.flatMap((x) => x.models)[0]?.model_id ?? ""));
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ptAddTrialBus({ bus_id: label.trim(), model_id: model, notes: notes.trim() || undefined });
      onAdded();
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
          <span>{t("Label (plate or vendor number)")}</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={50} />
        </label>
        <label className="field inline grow">
          <span>{t("Model")}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} required>
            {makers?.map((m) =>
              m.models.length ? (
                <optgroup key={m.manufacturer} label={m.display_name}>
                  {m.models.map((md) => (
                    <option key={md.model_id} value={md.model_id}>
                      {md.model} ({md.model_year}) · {md.bus_length} m {md.bus_type}
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>
        </label>
        <label className="field inline grow">
          <span>{t("Notes")}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button className="primary align-end" type="submit" disabled={busy || !model}>
          {busy ? t("Adding…") : t("Add trial bus")}
        </button>
      </div>
      <p className="muted small">{t("A new model? Add it under Fleet → manufacturer → Add model first.")}</p>
      <ErrorText message={error} />
    </form>
  );
}
