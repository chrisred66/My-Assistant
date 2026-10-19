// PT Management → Fleet: manufacturers, their models and buses (ported from ptManagement's manufacturer pages).
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { BarList, SeriesLegend, type BarItem, type Color } from "../../components/charts";
import { ErrorText } from "../../components/common";
import {
  api,
  canPt,
  PT_ENERGY_SOURCES,
  type PtEnergySource,
  type PtManufacturer,
  type PtManufacturerDetail,
  type PtModel,
  type User,
} from "../../lib/api";
import { errorMessage, formatDay, formatInteger } from "../../lib/format";
import { t } from "../../lib/i18n";

const CATEGORIES = PT_ENERGY_SOURCES;
const BUS_TYPES = ["City", "Regional", "Intercity", "Double decker", "Coach"];

/** Lenient, because imported data has misspellings ("Hyrrogen"). */
function isHydrogen(energy: string) {
  return /^hy(?!brid)/i.test(energy);
}

/** Same slots as Operations: electric c1, hydrogen c2. */
function energyColor(energy: string): Color {
  return isHydrogen(energy) ? "c2" : energy === "Electric" ? "c1" : energy === "Hybrid" ? "c3" : "c4";
}

/** kWh for battery buses, kg for hydrogen. */
function capacityUnit(energy: string) {
  return isHydrogen(energy) ? "kg" : t("kWh");
}

export default function Fleet({ user }: { user: User }) {
  const [list, setList] = useState<PtManufacturer[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addingModelTo, setAddingModelTo] = useState<string | null>(null);
  const canEdit = canPt(user, "planning", "add");
  const canRemove = canPt(user, "planning", "manage");

  const load = useCallback(async () => {
    setError(null);
    try {
      setList(await api.ptManufacturers());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (open) {
    return (
      <ManufacturerDetail
        user={user}
        manufacturer={open}
        onBack={() => {
          setOpen(null);
          void load();
        }}
      />
    );
  }

  async function removeManufacturer(m: PtManufacturer) {
    const ok = window.confirm(
      t("Remove {name} with its {models} model(s) and {buses} bus(es)? They're moved to the archive tables; trip logs are kept.", {
        name: m.display_name,
        models: m.models.length,
        buses: m.bus_count,
      }),
    );
    if (!ok) return;
    setError(null);
    try {
      await api.ptRemoveManufacturer(m.manufacturer);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const models = list?.flatMap((m) => m.models) ?? [];
  const busesWhere = (test: (energy: string) => boolean) => models.filter((m) => test(m.energy_source)).reduce((n, m) => n + m.bus_count, 0);

  return (
    <div className="stack">
      <ErrorText message={error} />
      {list && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">{t("Buses")}</span>
            <span className="tile-value">{formatInteger(list.reduce((n, m) => n + m.bus_count, 0))}</span>
          </div>
          <div className="tile">
            <span className="tile-label">{t("Electric / hydrogen buses")}</span>
            <span className="tile-value">
              {formatInteger(busesWhere((e) => e === "Electric"))} / {formatInteger(busesWhere(isHydrogen))}
            </span>
          </div>
          <div className="tile">
            <span className="tile-label">{t("Models")}</span>
            <span className="tile-value">{formatInteger(models.length)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">{t("Manufacturers")}</span>
            <span className="tile-value">{formatInteger(list.length)}</span>
          </div>
        </div>
      )}

      {list && list.some((m) => m.bus_count > 0) && <FleetCharts list={list} />}

      <div className="card stack">
        <div className="row space-between">
          <h2>{t("Manufacturers")}</h2>
          {canEdit && (
            <button className="small-btn" onClick={() => setShowAdd((s) => !s)} aria-expanded={showAdd}>
              {showAdd ? t("Cancel") : t("Add manufacturer…")}
            </button>
          )}
        </div>
        {showAdd && (
          <AddManufacturer
            onAdded={(key) => {
              setShowAdd(false);
              setOpen(key);
            }}
          />
        )}
        {list === null && !error && <p className="muted">{t("Loading…")}</p>}
        {list && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("Manufacturer")}</th>
                <th>{t("Category")}</th>
                <th>{t("Models")}</th>
                <th className="num">{t("Buses")}</th>
                {(canEdit || canRemove) && <th />}
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <Fragment key={m.manufacturer}>
                  <tr className={addingModelTo === m.manufacturer ? "expanded" : undefined}>
                    <td>
                      <button className="link-btn" onClick={() => setOpen(m.manufacturer)}>
                        <strong>{m.display_name}</strong>
                      </button>
                    </td>
                    <td>{t(m.category)}</td>
                    <td className="small">
                      {m.models.length === 0 ? (
                        <span className="muted">{t("No models yet")}</span>
                      ) : (
                        m.models.map((md) => (
                          <div key={md.model_id}>
                            {md.model} ({md.model_year}) · {md.bus_length} m {md.bus_type} ·{" "}
                            <span className={md.bus_count ? undefined : "muted"}>{t("{bus_count} bus{v}", { bus_count: md.bus_count, v: md.bus_count === 1 ? "" : "es" })}</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="num">{formatInteger(m.bus_count)}</td>
                    {(canEdit || canRemove) && (
                      <td className="num">
                        <div className="row">
                          {canEdit && (
                            <button
                              className="small-btn"
                              onClick={() => setAddingModelTo(addingModelTo === m.manufacturer ? null : m.manufacturer)}
                              aria-expanded={addingModelTo === m.manufacturer}
                            >
                              {addingModelTo === m.manufacturer ? t("Cancel") : t("Add model…")}
                            </button>
                          )}
                          {canRemove && (
                            <button className="small-btn danger" onClick={() => void removeManufacturer(m)}>
                              {t("Remove…")}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                  {addingModelTo === m.manufacturer && (
                    <tr className="details-row">
                      <td colSpan={5}>
                        <p className="small">
                          {t("New vehicle model for")} <strong>{m.display_name}</strong>
                        </p>
                        <AddModel
                          manufacturer={m.manufacturer}
                          onAdded={() => {
                            setAddingModelTo(null);
                            void load();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FleetCharts({ list }: { list: PtManufacturer[] }) {
  const byMaker: BarItem[] = list
    .filter((m) => m.bus_count > 0)
    .sort((a, b) => b.bus_count - a.bus_count)
    .map((m) => ({
      key: m.manufacturer,
      label: m.display_name,
      value: m.bus_count,
      color: energyColor(m.category),
      detail: m.models.filter((md) => md.bus_count > 0).map((md) => `${md.model} (${md.model_year}): ${md.bus_count}`).join(" · "),
    }));
  const byModel: BarItem[] = list
    .flatMap((m) => m.models.map((md) => ({ ...md, maker: m.display_name })))
    .filter((md) => md.bus_count > 0)
    .sort((a, b) => b.bus_count - a.bus_count)
    .map((md) => ({
      key: md.model_id,
      label: `${md.maker} ${md.model} (${md.model_year})`,
      value: md.bus_count,
      color: energyColor(md.energy_source),
      detail: `${md.bus_length} m ${t(md.bus_type)} · ${md.energy_capacity} ${capacityUnit(md.energy_source)}`,
    }));
  const energies = [...new Set(list.flatMap((m) => m.models.filter((md) => md.bus_count > 0).map((md) => (isHydrogen(md.energy_source) ? t("Hydrogen") : md.energy_source))))];
  const legend = <SeriesLegend series={energies.map((e) => ({ label: e, color: energyColor(e) }))} />;
  return (
    <div className="chart-grid">
      <div className="card stack">
        <div className="row space-between wrap">
          <h2>{t("Buses by manufacturer")}</h2>
          {energies.length > 1 && legend}
        </div>
        <BarList items={byMaker} format={(v) => formatInteger(v)} label={t("Buses by manufacturer")} />
      </div>
      <div className="card stack">
        <div className="row space-between wrap">
          <h2>{t("Buses by model")}</h2>
          {energies.length > 1 && legend}
        </div>
        <BarList items={byModel} format={(v) => formatInteger(v)} label={t("Buses by model")} />
      </div>
    </div>
  );
}

function AddManufacturer({ onAdded }: { onAdded: (key: string) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [category, setCategory] = useState<string>("Electric");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedKey = displayName.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.ptAddManufacturer({ manufacturer: key.trim() || suggestedKey, display_name: displayName.trim(), category });
      onAdded(r.manufacturer);
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
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>{t("Short ID (optional)")}</span>
          <input
            value={key}
            placeholder={suggestedKey || t("e.g. Wisdom_Motor")}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            aria-describedby="mf-id-help"
          />
        </label>
        <label className="field inline">
          <span>{t("Category")}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(c)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary align-end" type="submit" disabled={busy || !(key.trim() || suggestedKey)}>
          {busy ? t("Adding…") : t("Add")}
        </button>
      </div>
      <p id="mf-id-help" className="muted small">
        {t("The short ID is how the system refers to this manufacturer internally. It's the start of every model ID (for example {example}) and can't be changed later. Letters, digits and _ only, no spaces.", {
          example: `${(key.trim() || suggestedKey || "Yutong").replace(/[^A-Za-z0-9]/g, "").toUpperCase()}_U12_2024`,
        })}{" "}
        {suggestedKey ? t("Leave it empty to use the name ({key}).", { key: suggestedKey }) : t("Leave it empty to use the name.")}
      </p>
      <ErrorText message={error} />
    </form>
  );
}

function ManufacturerDetail({ user, manufacturer, onBack }: { user: User; manufacturer: string; onBack: () => void }) {
  const [detail, setDetail] = useState<PtManufacturerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"model" | "bus" | null>(null);
  const canEdit = canPt(user, "planning", "add");
  const canRemove = canPt(user, "planning", "manage");

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.ptManufacturer(manufacturer));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [manufacturer]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removeManufacturer() {
    if (!detail) return;
    const buses = detail.buses.length;
    const ok = window.confirm(
      t("Remove {name} with its {models} model(s) and {buses} bus(es)? They're moved to the archive tables; trip logs are kept.", {
        name: detail.display_name,
        models: detail.models.length,
        buses,
      }),
    );
    if (!ok) return;
    try {
      await api.ptRemoveManufacturer(detail.manufacturer);
      onBack();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="stack">
      <div className="row space-between">
        <button className="small-btn" onClick={onBack}>
          {t("← All manufacturers")}
        </button>
        {canRemove && detail && (
          <button className="small-btn danger" onClick={() => void removeManufacturer()}>
            {t("Remove manufacturer…")}
          </button>
        )}
      </div>
      <ErrorText message={error} />
      {detail === null && !error && <p className="muted">{t("Loading…")}</p>}
      {detail && (
        <>
          <div className="card stack-tight">
            <h2>{detail.display_name}</h2>
            <p className="muted small">
              {t(detail.category)} · {t("key")} <span className="mono">{detail.manufacturer}</span> ·{" "}
              {t("{models} model(s), {buses} bus(es)", { models: detail.models.length, buses: detail.buses.length })}
            </p>
          </div>

          <div className="card stack">
            <div className="row space-between">
              <h2>{t("Models")}</h2>
              {canEdit && (
                <button className="small-btn" onClick={() => setAdding(adding === "model" ? null : "model")} aria-expanded={adding === "model"}>
                  {adding === "model" ? t("Cancel") : t("Add model…")}
                </button>
              )}
            </div>
            {adding === "model" && (
              <AddModel
                manufacturer={detail.manufacturer}
                onAdded={() => {
                  setAdding(null);
                  void load();
                }}
              />
            )}
            {detail.models.length === 0 ? (
              <p className="muted">{t("No models yet.")}</p>
            ) : (
              <ModelsTable
                models={detail.models}
                canRemove={canRemove}
                onRemove={(m) => {
                  if (window.confirm(t("Remove model {model} ({model_year})? It's moved to the archive table.", { model: m.model, model_year: m.model_year }))) {
                    void act(() => api.ptRemoveModel(m.model_id));
                  }
                }}
              />
            )}
          </div>

          <div className="card stack">
            <div className="row space-between">
              <h2>{t("Buses")}</h2>
              {canEdit && detail.models.length > 0 && (
                <button className="small-btn" onClick={() => setAdding(adding === "bus" ? null : "bus")} aria-expanded={adding === "bus"}>
                  {adding === "bus" ? t("Cancel") : t("Add bus…")}
                </button>
              )}
            </div>
            {adding === "bus" && (
              <AddBus
                models={detail.models}
                onAdded={() => {
                  setAdding(null);
                  void load();
                }}
              />
            )}
            {detail.buses.length === 0 ? (
              <p className="muted">{t("No buses yet.")}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="num">{t("Bus")}</th>
                    <th>{t("Plate")}</th>
                    <th>{t("Model")}</th>
                    <th className="num">{t("Trips")}</th>
                    <th>{t("Last trip")}</th>
                    {(canEdit || canRemove) && <th />}
                  </tr>
                </thead>
                <tbody>
                  {detail.buses.map((b) => (
                    <tr key={b.bus_id}>
                      <td className="num mono">{b.bus_id}</td>
                      <td>{b.plate || <span className="muted">—</span>}</td>
                      <td>
                        {b.model} ({b.model_year})
                      </td>
                      <td className="num">{formatInteger(b.trip_count)}</td>
                      <td>{b.last_trip ? formatDay(b.last_trip) : <span className="muted">{t("none")}</span>}</td>
                      {(canEdit || canRemove) && (
                        <td className="num">
                          <div className="row">
                            {canEdit && (
                              <button
                                className="small-btn"
                                onClick={() => {
                                  const plate = window.prompt(t("Plate for bus {bus_id}", { bus_id: b.bus_id }), b.plate);
                                  if (plate !== null) void act(() => api.ptSetPlate(b.bus_id, plate));
                                }}
                              >
                                {t("Plate…")}
                              </button>
                            )}
                            {canRemove && (
                              <button
                                className="small-btn danger"
                                onClick={() => {
                                  const trips = b.trip_count ? t(" Its {trip_count} trip(s) stay in the trip log.", { trip_count: b.trip_count }) : "";
                                  if (window.confirm(t("Remove bus {bus_id}? It's moved to the archive table.{trips}", { bus_id: b.bus_id, trips }))) {
                                    void act(() => api.ptRemoveBus(b.bus_id));
                                  }
                                }}
                              >
                                {t("Remove")}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ModelsTable({ models, canRemove, onRemove }: { models: PtModel[]; canRemove: boolean; onRemove: (m: PtModel) => void }) {
  const dims = (m: PtModel) => [m.bus_length, m.bus_width, m.bus_height].map((v) => (v ? String(v) : "?")).join(" × ");
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t("Model")}</th>
          <th>{t("Type")}</th>
          <th>{t("Energy")}</th>
          <th>L × W × H (m)</th>
          <th className="num">{t("Capacity")}</th>
          <th>{t("Charging")}</th>
          <th className="num">{t("Weight (t)")}</th>
          <th className="num">{t("Buses")}</th>
          {canRemove && <th />}
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model_id}>
            <td>
              <strong>{m.model}</strong> ({m.model_year})
              <div className="muted small mono">{m.model_id}</div>
            </td>
            <td>{m.bus_type}</td>
            <td>{m.energy_source}</td>
            <td>{dims(m)}</td>
            <td className="num">
              {m.energy_capacity ? `${m.energy_capacity} ${capacityUnit(m.energy_source)}` : <span className="muted">—</span>}
            </td>
            <td className="small">
              {m.charging_port_count ? (
                <>
                  {t("{count} port(s)", { count: m.charging_port_count })}
                  {(m.one_port_intake || m.two_port_intake) > 0 && (
                    <div className="muted">{t("{one_port_intake} kW one port · {two_port_intake} kW two ports", { one_port_intake: m.one_port_intake, two_port_intake: m.two_port_intake })}</div>
                  )}
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td className="num">
              {m.curb_weight || "—"}
              {m.gvw ? <div className="muted small">{t("GVW {gvw}", { gvw: m.gvw })}</div> : null}
            </td>
            <td className="num">{formatInteger(m.bus_count)}</td>
            {canRemove && (
              <td className="num">
                <button
                  className="small-btn danger"
                  disabled={m.bus_count > 0}
                  title={m.bus_count > 0 ? t("Remove its buses first") : undefined}
                  onClick={() => onRemove(m)}
                >
                  {t("Remove")}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddModel({ manufacturer, onAdded }: { manufacturer: string; onAdded: () => void }) {
  const [f, setF] = useState({
    model: "",
    model_year: String(new Date().getFullYear()),
    bus_type: "City",
    energy_source: "Electric" as PtEnergySource,
    bus_length: "",
    bus_width: "",
    bus_height: "",
    curb_weight: "",
    gvw: "",
    axle_count: "2",
    energy_capacity: "",
    charging_port_count: "",
    one_port_intake: "",
    two_port_intake: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const n = (v: string) => (v.trim() === "" ? 0 : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ptAddModel({
        manufacturer,
        model: f.model.trim(),
        model_year: n(f.model_year),
        bus_type: f.bus_type.trim(),
        energy_source: f.energy_source,
        bus_length: n(f.bus_length),
        bus_width: n(f.bus_width),
        bus_height: n(f.bus_height),
        curb_weight: n(f.curb_weight),
        gvw: f.gvw.trim() === "" ? null : n(f.gvw),
        axle_count: n(f.axle_count),
        energy_capacity: n(f.energy_capacity),
        charging_port_count: n(f.charging_port_count),
        one_port_intake: n(f.one_port_intake),
        two_port_intake: n(f.two_port_intake),
      });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const numField = (k: keyof typeof f, label: string, step = "any") => (
    <label className="field inline">
      <span>{label}</span>
      <input type="number" min="0" step={step} value={f[k]} onChange={set(k)} />
    </label>
  );

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Model")}</span>
          <input value={f.model} onChange={set("model")} required />
        </label>
        <label className="field inline">
          <span>{t("Year")}</span>
          <input type="number" min="1990" step="1" value={f.model_year} onChange={set("model_year")} required />
        </label>
        <label className="field inline">
          <span>{t("Type")}</span>
          <input list="pt-bus-types" value={f.bus_type} onChange={set("bus_type")} required />
          <datalist id="pt-bus-types">
            {BUS_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="field inline">
          <span>{t("Energy")}</span>
          <select value={f.energy_source} onChange={set("energy_source")}>
            {PT_ENERGY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Length (m)")}</span>
          <input type="number" min="1" max="30" step="any" value={f.bus_length} onChange={set("bus_length")} required />
        </label>
        {numField("bus_width", t("Width (m)"))}
        {numField("bus_height", t("Height (m)"))}
        {numField("axle_count", t("Axles"), "1")}
        {numField("curb_weight", t("Curb weight (t)"))}
        {numField("gvw", t("GVW (optional)"), "1")}
      </div>
      <div className="row wrap">
        {numField("energy_capacity", t("Capacity ({energy_source})", { energy_source: capacityUnit(f.energy_source) }))}
        {numField("charging_port_count", t("Charging ports"), "1")}
        {numField("one_port_intake", t("One-port intake (kW)"), "1")}
        {numField("two_port_intake", t("Two-port intake (kW)"), "1")}
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? t("Adding…") : t("Add model")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

function AddBus({ models, onAdded }: { models: PtModel[]; onAdded: () => void }) {
  const [modelId, setModelId] = useState(models[0]?.model_id ?? "");
  const [busId, setBusId] = useState("");
  const [plate, setPlate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ptAddBus({ model_id: modelId, bus_id: busId.trim() ? Number(busId) : undefined, plate: plate.trim() });
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
          <span>{t("Model")}</span>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.model} ({m.model_year})
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Bus number (as in trip logs)")}</span>
          <input type="number" min="1" step="1" value={busId} placeholder={t("next free")} onChange={(e) => setBusId(e.target.value)} />
        </label>
        <label className="field inline">
          <span>{t("Plate (optional)")}</span>
          <input value={plate} onChange={(e) => setPlate(e.target.value)} />
        </label>
        <button className="primary align-end" type="submit" disabled={busy || !modelId}>
          {busy ? t("Adding…") : t("Add bus")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}
