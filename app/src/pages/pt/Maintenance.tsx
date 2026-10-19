// PT Management → Repair & Maintenance: work orders, preventive maintenance plans and their due list, and a
// dashboard (availability, downtime, cost, failures). New in this app; the original ptManagement had none.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BarList, ColumnChart, SeriesLegend, type BarItem, type Color, type Point } from "../../components/charts";
import { ErrorText } from "../../components/common";
import {
  api,
  canPt,
  type PtMaintenance,
  type PtMaintInput,
  type PtMaintOptions,
  type PtMaintPlan,
  type PtMaintRecord,
  type PtMaintStatus,
  type PtMaintType,
  type PtPlanDue,
  type User,
} from "../../lib/api";
import { errorMessage, formatDay, formatInteger, LOCALE } from "../../lib/format";
import MaintImport from "./MaintImport";
import { t } from "../../lib/i18n";

const TYPE_LABELS: Record<PtMaintType, string> = {
  preventive: "Preventive service",
  corrective: "Repair",
  breakdown: "Breakdown",
  inspection: "Inspection",
  accident: "Accident damage",
  warranty: "Warranty work",
};
const STATUS_LABELS: Record<PtMaintStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_parts: "Waiting for parts",
  completed: "Completed",
  cancelled: "Cancelled",
};
const STATUS_BADGE: Record<PtMaintStatus, string> = { open: "serious", in_progress: "warning", waiting_parts: "warning", completed: "good", cancelled: "info" };
const PRIORITY_BADGE = { critical: "critical", high: "serious", normal: "info", low: "info" } as const;
const OPEN: PtMaintStatus[] = ["open", "in_progress", "waiting_parts"];
const PARTS: Color = "c1";
const LABOUR: Color = "c2";

const today = () => new Date().toISOString().slice(0, 10);
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(LOCALE, { month: "short", year: "2-digit", timeZone: "UTC" });

type Preset = "30" | "90" | "365" | "all" | "custom";

export default function Maintenance({ user }: { user: User }) {
  const [options, setOptions] = useState<PtMaintOptions | null>(null);
  const [preset, setPreset] = useState<Preset>("365");
  const [range, setRange] = useState({ from: daysAgo(364), to: today() });
  const [filter, setFilter] = useState<{ bus?: string; type?: string; category?: string; status?: string }>({});
  const [data, setData] = useState<PtMaintenance | null>(null);
  const [plans, setPlans] = useState<{ plans: PtMaintPlan[]; due: PtPlanDue[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PtMaintInput & { record_id?: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [shareBy, setShareBy] = useState<"records" | "cost" | "downtime">("records");
  const [importOpen, setImportOpen] = useState(false);
  const canAdd = canPt(user, "maintenance", "add"); // create work orders
  const canEdit = canPt(user, "maintenance", "manage"); // edit, close, import, plans

  useEffect(() => {
    api.ptMaintOptions().then(setOptions, (e) => setError(errorMessage(e)));
  }, [version]);

  useEffect(() => {
    let stale = false;
    setError(null);
    Promise.all([api.ptMaintenance({ ...range, ...filter }), api.ptMaintPlans()]).then(
      ([d, p]) => {
        if (stale) return;
        setData(d);
        setPlans(p);
      },
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [range, filter, version]);

  const changed = () => {
    setEditing(null);
    setVersion((v) => v + 1);
  };

  function choosePreset(p: Preset) {
    setPreset(p);
    if (p === "all") setRange({ from: options?.min_date ?? daysAgo(3650), to: today() });
    else if (p !== "custom") setRange({ from: daysAgo(Number(p) - 1), to: today() });
  }

  const catLabel = useMemo(() => new Map(options?.categories.map((c) => [c.code, c.label]) ?? []), [options]);
  const cur = options?.currency ?? "";
  const money = (v: number) => `${cur} ${formatInteger(Math.round(v))}`;

  if (!options) return error ? <ErrorText message={error} /> : <p className="muted">{t("Loading…")}</p>;

  const openRecords = data?.records.filter((m) => OPEN.includes(m.status)) ?? [];
  const closedRecords = (data?.records.filter((m) => !OPEN.includes(m.status)) ?? []).sort(
    (a, b) => (b.completed_date ?? "").localeCompare(a.completed_date ?? "") || b.record_id - a.record_id,
  );
  const tableProps = {
    money,
    catLabel,
    canEdit,
    canRemove: canPt(user, "maintenance", "manage"),
    options,
    onEdit: (m: PtMaintRecord) => {
      setEditing(m);
      document.getElementById("pt-work-orders")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    onChanged: changed,
    onError: setError,
  };

  const overdue = plans?.due.filter((d) => d.state === "overdue").length ?? 0;
  const dueSoon = plans?.due.filter((d) => d.state === "due_soon").length ?? 0;
  const mTotals = data?.totals;

  const monthPoints: Point[] = (data?.by_month ?? []).map((m) => ({
    label: monthLabel(String(m.key)),
    title: `${new Date(`${m.key}-01T00:00:00Z`).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" })} · ${m.records} work order(s)`,
    values: { parts: m.parts, labour: m.labour },
  }));
  const shareOf = (c: PtMaintenance["by_category"][number]) => (shareBy === "records" ? c.records : shareBy === "cost" ? c.cost : c.downtime_hours);
  const shareTotal = (data?.by_category ?? []).reduce((n, c) => n + shareOf(c), 0) || 1;
  const categoryBars: BarItem[] = (data?.by_category ?? [])
    .filter((c) => shareOf(c) > 0)
    .sort((a, b) => shareOf(b) - shareOf(a))
    .map((c) => ({
      key: String(c.key),
      label: catLabel.get(String(c.key)) ?? String(c.key),
      value: (shareOf(c) / shareTotal) * 100,
      color: "c3",
      detail: t("{records} work order(s) · {failures} failure(s) · {downtime_hours} h down · {cost}", { records: c.records, failures: c.failures, downtime_hours: formatInteger(c.downtime_hours), cost: money(c.cost) }),
    }));
  const downtimeBars: BarItem[] = (data?.by_bus ?? [])
    .filter((b) => b.downtime_hours > 0)
    .sort((a, b) => b.downtime_hours - a.downtime_hours)
    .slice(0, 12)
    .map((b) => ({
      key: String(b.key),
      label: t("Bus {key}", { key: b.key }),
      value: b.downtime_hours,
      color: "serious",
      detail: `${t("{availability}% available · {records} work order(s)", { availability: b.availability, records: b.records })} · ${money(b.cost)}${b.km ? t(" · {km} km run", { km: formatInteger(b.km) }) : ""}`,
    }));
  const typeBars: BarItem[] = (data?.by_type ?? [])
    .sort((a, b) => b.records - a.records)
    .map((x) => ({
      key: String(x.key),
      label: t(TYPE_LABELS[x.key as PtMaintType]) ?? String(x.key),
      value: x.records,
      color: x.key === "breakdown" ? "critical" : x.key === "corrective" || x.key === "accident" ? "serious" : x.key === "preventive" || x.key === "inspection" ? "good" : "neutral",
      detail: t("{cost} · {downtime_hours} h down", { cost: money(x.cost), downtime_hours: formatInteger(x.downtime_hours) }),
    }));

  return (
    <div className="stack">
      <div className="filters row wrap">
        <label className="field inline">
          <span>{t("Range")}</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
            <option value="30">{t("Last 30 days")}</option>
            <option value="90">{t("Last 90 days")}</option>
            <option value="365">{t("Last 12 months")}</option>
            <option value="all">{t("All records")}</option>
            <option value="custom">{t("Custom…")}</option>
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="field inline">
              <span>{t("From")}</span>
              <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
            </label>
            <label className="field inline">
              <span>{t("To")}</span>
              <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
            </label>
          </>
        )}
        <label className="field inline">
          <span>{t("Bus")}</span>
          <select value={filter.bus ?? ""} onChange={(e) => setFilter({ ...filter, bus: e.target.value || undefined })}>
            <option value="">{t("All buses")}</option>
            {options.buses.map((b) => (
              <option key={b.bus_id} value={b.bus_id}>
                {b.bus_id} · {b.model}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Type")}</span>
          <select value={filter.type ?? ""} onChange={(e) => setFilter({ ...filter, type: e.target.value || undefined })}>
            <option value="">{t("All types")}</option>
            {options.types.map((x) => (
              <option key={x} value={x}>
                {t(TYPE_LABELS[x])}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Category")}</span>
          <select value={filter.category ?? ""} onChange={(e) => setFilter({ ...filter, category: e.target.value || undefined })}>
            <option value="">{t("All categories")}</option>
            {options.categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Status")}</span>
          <select value={filter.status ?? ""} onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })}>
            <option value="">{t("Any status")}</option>
            {options.statuses.map((s) => (
              <option key={s} value={s}>
                {t(STATUS_LABELS[s])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorText message={error} />

      {mTotals && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">{t("Open work orders")}</span>
            <span className="tile-value">{formatInteger(mTotals.open)}</span>
            {(overdue > 0 || dueSoon > 0) && (
              <span className={overdue ? "error-text small" : "muted small"}>{t("{overdue} service(s) overdue · {dueSoon} due soon", { overdue, dueSoon })}</span>
            )}
          </div>
          <div className="tile">
            <span className="tile-label">{t("Fleet availability")}</span>
            <span className="tile-value">{mTotals.availability === null ? "—" : `${mTotals.availability}%`}</span>
            <span className="muted small">{t("{downtime_hours} bus-hours out of service", { downtime_hours: formatInteger(mTotals.downtime_hours) })}</span>
          </div>
          <div className="tile">
            <span className="tile-label">{t("Maintenance cost")}</span>
            <span className="tile-value">{money(mTotals.cost)}</span>
            <span className="muted small">{t("{v}parts {parts}", { v: mTotals.cost_per_km !== null ? t("{cur} {cost_per_km} per km · ", { cur, cost_per_km: mTotals.cost_per_km.toFixed(2) }) : "", parts: money(mTotals.parts) })}</span>
          </div>
          <div className="tile">
            <span className="tile-label">{t("Failures")}</span>
            <span className="tile-value">{formatInteger(mTotals.failures)}</span>
            <span className="muted small">{t("{v}{completed} of {reported} work orders done", { v: mTotals.failures_per_10k_km !== null ? t("{failures_per_10k_km} per 10,000 km · ", { failures_per_10k_km: mTotals.failures_per_10k_km }) : "", completed: mTotals.completed, reported: mTotals.reported })}</span>
          </div>
        </div>
      )}

      {data && data.totals.reported > 0 && (
        <>
          <div className="chart-grid">
            <div className="card stack">
              <div className="row space-between wrap">
                <h2>{t("Cost by month")}</h2>
                <SeriesLegend series={[{ label: t("Parts"), color: PARTS }, { label: t("Labour"), color: LABOUR }]} />
              </div>
              <ColumnChart
                points={monthPoints}
                series={[
                  { key: "parts", label: t("Parts"), color: PARTS },
                  { key: "labour", label: t("Labour"), color: LABOUR },
                ]}
                format={money}
                formatTick={(v) => formatInteger(v)}
                height={220}
                label={t("Maintenance cost by month")}
              />
            </div>
            <div className="card stack">
              <div className="row space-between wrap">
                <h2>{t("Work by category")}</h2>
                <div className="segmented" role="group" aria-label={t("Share of")}>
                  {(
                    [
                      ["records", t("Work orders")],
                      ["cost", t("Cost")],
                      ["downtime", t("Downtime")],
                    ] as const
                  ).map(([k, label]) => (
                    <button key={k} className={shareBy === k ? "on" : ""} aria-pressed={shareBy === k} onClick={() => setShareBy(k)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {categoryBars.length ? (
                <BarList
                  items={categoryBars}
                  format={(v) => `${v.toFixed(v < 10 ? 1 : 0)}%`}
                  label={t("Share of {shareBy} by category", { shareBy })}
                  onSelect={(it) => setFilter({ ...filter, category: it.key })}
                />
              ) : (
                <p className="muted small">{t("Nothing recorded for this measure yet.")}</p>
              )}
              <p className="muted small">{t("Share of all {v} in the range. Click a category to filter.", { v: shareBy === "records" ? t("work orders") : shareBy === "cost" ? t("maintenance cost") : "downtime" })}</p>
            </div>
          </div>
          <div className="chart-grid">
            <div className="card stack">
              <h2>{t("Downtime by bus (hours)")}</h2>
              {downtimeBars.length ? (
                <BarList items={downtimeBars} format={(v) => formatInteger(v)} label={t("Downtime by bus")} onSelect={(it) => setFilter({ ...filter, bus: it.key })} />
              ) : (
                <p className="muted small">{t("No downtime recorded in this range.")}</p>
              )}
            </div>
            <div className="card stack">
              <h2>{t("Work orders by type")}</h2>
              <BarList items={typeBars} format={(v) => formatInteger(v)} label={t("Work orders by type")} onSelect={(it) => setFilter({ ...filter, type: it.key })} />
              {data.repeat_failures.length > 0 && (
                <div className="stack-tight">
                  <h3>{t("Repeat failures")}</h3>
                  {data.repeat_failures.map((r) => (
                    <span key={`${r.bus_id}/${r.category}`} className="small" title={t("Same bus, same category, more than one failure")}>
                      <span className="badge badge-serious">×{r.count}</span> {t("Bus {bus_id}", { bus_id: r.bus_id })}: {catLabel.get(r.category) ?? r.category}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}


      <div className="card stack" id="pt-work-orders">
        <div className="row space-between wrap">
          <h2>{t("Work orders")}</h2>
          {canAdd && (
            <div className="row">
              {canEdit && (
                <button className="small-btn" onClick={() => setImportOpen((o) => !o)} aria-expanded={importOpen}>
                  {importOpen ? t("Close import") : t("Import from Access…")}
                </button>
              )}
              <button
                className="small-btn"
                onClick={() => setEditing(editing && !editing.record_id ? null : { type: "corrective", category: "general", status: "open", priority: "normal", reported_date: today() })}
              >
                {editing && !editing.record_id ? t("Cancel") : t("New work order…")}
              </button>
            </div>
          )}
        </div>
        {importOpen && (
          <MaintImport options={options} labels={{ type: TYPE_LABELS, status: STATUS_LABELS, category: catLabel }} onDone={() => setVersion((v) => v + 1)} />
        )}
        {editing && (
          <WorkOrderForm
            key={editing.record_id ?? `new-${editing.plan_id ?? ""}-${editing.bus_id ?? ""}`}
            initial={editing}
            options={options}
            onSaved={changed}
            onCancel={() => setEditing(null)}
          />
        )}
        {data && data.records.length === 0 && (
          <p className="muted">{t("No work orders {v}. Record repairs, inspections and services here; open ones always stay listed whatever the date range.", { v: Object.values(filter).some(Boolean) ? t("match these filters") : "yet" })}</p>
        )}
        {data && data.records.length > 0 && (
          <>
            <h3>{t("Open ({count})", { count: openRecords.length })}</h3>
            {openRecords.length === 0 ? (
              <p className="muted small">{t("No open work orders.")}</p>
            ) : (
              <WorkOrderTable rows={openRecords} {...tableProps} />
            )}
            {closedRecords.length > 0 && (
              <details className="closed-orders">
                <summary>
                  {t("Closed ({count})", { count: closedRecords.length })} <span className="muted small">{t("reported in the selected range")}</span>
                </summary>
                <WorkOrderTable rows={closedRecords} {...tableProps} />
              </details>
            )}
          </>
        )}
      </div>

      {plans && (
        <Preventive
          plans={plans}
          options={options}
          canEdit={canEdit}
          canRemove={canPt(user, "maintenance", "manage")}
          catLabel={catLabel}
          onLog={(d) =>
            setEditing({
              bus_id: d.bus_id,
              plan_id: d.plan_id,
              type: "preventive",
              category: d.category,
              title: d.plan,
              status: "open",
              reported_date: today(),
              odometer_km: d.odometer_km ?? undefined,
            })
          }
          onChanged={changed}
        />
      )}
    </div>
  );
}

function WorkOrderTable({
  rows,
  money,
  catLabel,
  canEdit,
  canRemove,
  options,
  onEdit,
  onChanged,
  onError,
}: {
  rows: PtMaintRecord[];
  money: (v: number) => string;
  catLabel: Map<string, string>;
  canEdit: boolean;
  canRemove: boolean;
  options: PtMaintOptions;
  onEdit: (m: PtMaintRecord) => void;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const closed = !OPEN.includes(rows[0]?.status);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{closed ? t("Reported → closed") : t("Reported")}</th>
            <th className="num">{t("Bus")}</th>
            <th>{t("Work")}</th>
            <th>{t("Category")}</th>
            <th>{t("Status")}</th>
            {closed && <th className="num">{t("Downtime")}</th>}
            {closed && <th className="num">{t("Cost")}</th>}
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <WorkOrderRow
              key={m.record_id}
              m={m}
              money={money}
              catLabel={catLabel}
              canEdit={canEdit}
              canRemove={canRemove}
              options={options}
              onEdit={() => onEdit(m)}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkOrderRow({
  m,
  money,
  catLabel,
  canEdit,
  canRemove,
  options,
  onEdit,
  onChanged,
  onError,
}: {
  m: PtMaintRecord;
  money: (v: number) => string;
  catLabel: Map<string, string>;
  canEdit: boolean;
  canRemove: boolean;
  options: PtMaintOptions;
  onEdit: () => void;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const [closing, setClosing] = useState(false);
  const isOpen = OPEN.includes(m.status);
  async function act(fn: () => Promise<unknown>) {
    onError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    }
  }
  const cols = (isOpen ? 5 : 7) + (canEdit ? 1 : 0);
  return (
    <>
      <tr className={closing ? "expanded" : undefined}>
        <td className="nowrap">
          {formatDay(m.reported_date)}
          {!isOpen && m.completed_date && <div className="small">→ {formatDay(m.completed_date)}</div>}
          {isOpen && <div className="muted small">{t("{reported_date} open", { reported_date: daysOpen(m.reported_date) })}</div>}
        </td>
        <td className="num mono">{m.bus_id}</td>
        <td>
          <strong>{m.title}</strong> {m.priority !== "normal" && <span className={`badge badge-${PRIORITY_BADGE[m.priority]}`}>{m.priority}</span>}
          {m.external_ref && !m.external_ref.startsWith("auto:") && <span className="muted small mono">{t("WO {external_ref}", { external_ref: m.external_ref })}</span>}
          {m.source === "access" && <span className="muted small" title={t("Imported from an Access export")}> {t("· imported")}</span>}
          <div className="muted small">
            {t(TYPE_LABELS[m.type])}
            {m.plan_name && ` · plan: ${m.plan_name}`}
            {m.workshop && ` · ${m.workshop}`}
            {m.odometer_km !== null && ` · ${t("{n} km", { n: formatInteger(m.odometer_km) })}`}
          </div>
          {m.description && <div className="small">{m.description}</div>}
          {!isOpen && m.closing_note && <div className="small">{t("Closing note: {closing_note}", { closing_note: m.closing_note })}</div>}
        </td>
        <td>{catLabel.get(m.category) ?? m.category}</td>
        <td>
          {canEdit && isOpen ? (
            <select value={m.status} onChange={(e) => void act(() => api.ptUpdateMaint(m.record_id, { status: e.target.value as PtMaintStatus }))} aria-label={t("Status of work order {record_id}", { record_id: m.record_id })}>
              {OPEN.map((s) => (
                <option key={s} value={s}>
                  {t(STATUS_LABELS[s])}
                </option>
              ))}
            </select>
          ) : (
            <span className={`badge badge-${STATUS_BADGE[m.status]}`}>{t(STATUS_LABELS[m.status])}</span>
          )}
        </td>
        {!isOpen && <td className="num">{m.downtime_hours === null ? "—" : `${m.downtime_hours} h`}</td>}
        {!isOpen && <td className="num">{m.total_cost === null ? "—" : money(m.total_cost)}</td>}
        {canEdit && (
          <td className="num">
            <div className="row">
              {isOpen ? (
                <button className="small-btn primary" onClick={() => setClosing((c) => !c)} aria-expanded={closing}>
                  {closing ? t("Cancel") : t("Close…")}
                </button>
              ) : (
                <button className="small-btn" onClick={() => void act(() => api.ptReopenMaint(m.record_id))}>
                  {t("Reopen")}
                </button>
              )}
              <button className="small-btn" onClick={onEdit}>
                {t("Edit")}
              </button>
              {canRemove && (
                <button className="small-btn danger" onClick={() => window.confirm(t("Delete work order \"{title}\" for bus {bus_id}?", { title: m.title, bus_id: m.bus_id })) && void act(() => api.ptDeleteMaint(m.record_id))}>
                  {t("Delete")}
                </button>
              )}
            </div>
          </td>
        )}
      </tr>
      {closing && (
        <tr className="details-row">
          <td colSpan={cols}>
            <CloseForm m={m} currency={options.currency} onClosed={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function daysOpen(reported: string) {
  const d = Math.max(0, Math.round((Date.parse(today()) - Date.parse(reported)) / 86400000));
  return d === 1 ? "1 day" : `${d} days`;
}

/** Step 2: the workshop has reported back. */
function CloseForm({ m, currency, onClosed }: { m: PtMaintRecord; currency: string; onClosed: () => void }) {
  const [f, setF] = useState({ closed_date: today() < m.reported_date ? m.reported_date : today(), outcome: "completed" as "completed" | "cancelled", downtime_hours: "", labour_hours: "", parts_cost: "", labour_cost: "", closing_note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const elapsedH = Math.max(0, (Date.parse(f.closed_date) - Date.parse(m.reported_date)) / 3600000);
  const num = (v: string): number | "" => (v === "" ? "" : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ptCloseMaint(m.record_id, {
        closed_date: f.closed_date,
        outcome: f.outcome,
        downtime_hours: num(f.downtime_hours),
        labour_hours: num(f.labour_hours),
        parts_cost: num(f.parts_cost),
        labour_cost: num(f.labour_cost),
        closing_note: f.closing_note.trim() || undefined,
      });
      onClosed();
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
          <span>{t("Closing date")}</span>
          <input type="date" value={f.closed_date} min={m.reported_date} onChange={set("closed_date")} required />
        </label>
        <label className="field inline">
          <span>{t("Outcome")}</span>
          <select value={f.outcome} onChange={set("outcome")}>
            <option value="completed">{t("Completed")}</option>
            <option value="cancelled">{t("Cancelled (not done)")}</option>
          </select>
        </label>
        <label className="field inline">
          <span>{t("Downtime (h, optional)")}</span>
          <input type="number" min="0" step="any" value={f.downtime_hours} onChange={set("downtime_hours")} placeholder={t("{elapsedH} if off road throughout", { elapsedH: formatInteger(elapsedH) })} />
        </label>
        <label className="field inline">
          <span>{t("Labour (h)")}</span>
          <input type="number" min="0" step="any" value={f.labour_hours} onChange={set("labour_hours")} />
        </label>
        <label className="field inline">
          <span>{t("Parts ({currency})", { currency })}</span>
          <input type="number" min="0" step="any" value={f.parts_cost} onChange={set("parts_cost")} />
        </label>
        <label className="field inline">
          <span>{t("Labour ({currency})", { currency })}</span>
          <input type="number" min="0" step="any" value={f.labour_cost} onChange={set("labour_cost")} />
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Closing note (optional)")}</span>
          <input value={f.closing_note} onChange={set("closing_note")} placeholder={t("What the workshop did or found")} />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? t("Closing…") : t("Close work order")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

/** Step 1 (new or open work order). For a closed one, the closing details can be corrected too. */
function WorkOrderForm({
  initial,
  options,
  onSaved,
  onCancel,
}: {
  initial: PtMaintInput & { record_id?: number };
  options: PtMaintOptions;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const isClosed = !!initial.record_id && !!initial.status && !OPEN.includes(initial.status);
  const [f, setF] = useState({
    bus_id: str(initial.bus_id),
    type: (initial.type ?? "corrective") as PtMaintType,
    category: initial.category ?? "general",
    title: initial.title ?? "",
    description: initial.description ?? "",
    priority: initial.priority ?? "normal",
    status: (initial.status ?? "open") as PtMaintStatus,
    reported_date: initial.reported_date ?? today(),
    odometer_km: str(initial.odometer_km),
    workshop: initial.workshop ?? "",
    plan_id: str(initial.plan_id),
    // Closed work orders only:
    completed_date: str(initial.completed_date),
    downtime_hours: str(initial.downtime_hours),
    labour_hours: str(initial.labour_hours),
    parts_cost: str(initial.parts_cost),
    labour_cost: str(initial.labour_cost),
    closing_note: initial.closing_note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const bus = options.buses.find((b) => String(b.bus_id) === f.bus_id);
  const plansForBus = options.plans.filter((p) => !p.model_id || p.model_id === bus?.model_id);
  // Default the workshop to the bus's manufacturer when a bus is picked on a new work order.
  const pickBus = (e: { target: { value: string } }) => {
    const b = options.buses.find((x) => String(x.bus_id) === e.target.value);
    setF((p) => ({ ...p, bus_id: e.target.value, workshop: p.workshop || (b?.manufacturer && options.workshops.includes(b.manufacturer) ? b.manufacturer : "") }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // "" tells the server to clear a field.
    const wire: Record<string, unknown> = {
      bus_id: Number(f.bus_id),
      type: f.type,
      category: f.category,
      title: f.title.trim(),
      description: f.description.trim(),
      priority: f.priority,
      reported_date: f.reported_date,
      workshop: f.workshop,
      plan_id: f.plan_id ? Number(f.plan_id) : "",
      odometer_km: f.odometer_km === "" ? "" : Number(f.odometer_km),
    };
    if (!isClosed) wire.status = f.status;
    if (isClosed) {
      wire.completed_date = f.completed_date;
      wire.closing_note = f.closing_note.trim();
      for (const k of ["downtime_hours", "labour_hours", "parts_cost", "labour_cost"] as const) wire[k] = f[k] === "" ? "" : Number(f[k]);
    }
    try {
      if (initial.record_id) await api.ptUpdateMaint(initial.record_id, wire as PtMaintInput);
      else await api.ptAddMaint(wire as PtMaintInput);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack adjust-panel" onSubmit={(e) => void submit(e)}>
      <strong className="small">{initial.record_id ? t("Edit work order #{record_id}", { record_id: initial.record_id }) : t("New work order")}</strong>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Bus")}</span>
          <select value={f.bus_id} onChange={pickBus} required>
            <option value="">{t("Choose…")}</option>
            {options.buses.map((b) => (
              <option key={b.bus_id} value={b.bus_id}>
                {b.bus_id} · {b.model}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Type")}</span>
          <select value={f.type} onChange={set("type")}>
            {options.types.map((x) => (
              <option key={x} value={x}>
                {t(TYPE_LABELS[x])}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Category")}</span>
          <select value={f.category} onChange={set("category")}>
            {options.categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline grow">
          <span>{t("Work (short description)")}</span>
          <input value={f.title} onChange={set("title")} required placeholder={t("e.g. Replace front brake pads")} />
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Priority")}</span>
          <select value={f.priority} onChange={set("priority")}>
            {options.priorities.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        {!isClosed && (
          <label className="field inline">
            <span>{t("Status")}</span>
            <select value={f.status} onChange={set("status")}>
              {OPEN.map((s) => (
                <option key={s} value={s}>
                  {t(STATUS_LABELS[s])}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field inline">
          <span>{t("Reported")}</span>
          <input type="date" value={f.reported_date} onChange={set("reported_date")} required />
        </label>
        <label className="field inline">
          <span>{t("Workshop")}</span>
          <select value={f.workshop} onChange={set("workshop")}>
            <option value="">{t("— not assigned —")}</option>
            {options.workshops.map((w) => (
              <option key={w}>{w}</option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Odometer (km)")}</span>
          <input
            type="number"
            min="0"
            step="any"
            value={f.odometer_km}
            placeholder={bus?.odometer_km ? t("last trip: {odometer_km}", { odometer_km: formatInteger(bus.odometer_km) }) : ""}
            onChange={set("odometer_km")}
          />
        </label>
        {plansForBus.length > 0 && (
          <label className="field inline">
            <span>{t("Carries out plan")}</span>
            <select value={f.plan_id} onChange={set("plan_id")}>
              <option value="">{t("— none —")}</option>
              {plansForBus.map((p) => (
                <option key={p.plan_id} value={p.plan_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field">
        <span>{t("Details (optional)")}</span>
        <textarea rows={2} value={f.description} onChange={set("description")} />
      </label>
      {isClosed && (
        <div className="row wrap">
          <label className="field inline">
            <span>{t("Closing date")}</span>
            <input type="date" value={f.completed_date} min={f.reported_date} onChange={set("completed_date")} required />
          </label>
          {(
            [
              ["downtime_hours", t("Downtime (h)")],
              ["labour_hours", t("Labour (h)")],
              ["parts_cost", t("Parts ({currency})", { currency: options.currency })],
              ["labour_cost", t("Labour ({currency})", { currency: options.currency })],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="field inline">
              <span>{label}</span>
              <input type="number" min="0" step="any" value={f[k]} onChange={set(k)} />
            </label>
          ))}
          <label className="field inline grow">
            <span>{t("Closing note")}</span>
            <input value={f.closing_note} onChange={set("closing_note")} />
          </label>
        </div>
      )}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t("Saving…") : initial.record_id ? t("Save changes") : t("Create work order")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
      {!initial.record_id && <p className="muted small">{t("Downtime, labour and costs are added when the work order is closed.")}</p>}
      <ErrorText message={error} />
    </form>
  );
}

const DUE_BADGE = { overdue: "critical", due_soon: "warning", never_done: "info", ok: "good" } as const;
const DUE_LABEL = { overdue: "Overdue", due_soon: "Due soon", never_done: "No service recorded yet", ok: "OK" } as const;

function Preventive({
  plans,
  options,
  canEdit,
  canRemove,
  catLabel,
  onLog,
  onChanged,
}: {
  plans: { plans: PtMaintPlan[]; due: PtPlanDue[] };
  options: PtMaintOptions;
  canEdit: boolean;
  canRemove: boolean;
  catLabel: Map<string, string>;
  onLog: (d: PtPlanDue) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urgent = plans.due.filter((d) => d.state === "overdue" || d.state === "due_soon");
  const rows = showAll ? plans.due : urgent;

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
        onChanged();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [onChanged],
  );

  const due = (d: PtPlanDue) => {
    const parts: string[] = [];
    if (d.km_left !== null) parts.push(d.km_left < 0 ? t("{integer} km over", { integer: formatInteger(-d.km_left) }) : t("in {km_left} km", { km_left: formatInteger(d.km_left) }));
    if (d.days_left !== null) parts.push(d.days_left < 0 ? t("{v} days late", { v: -d.days_left }) : t("in {days_left} days ({due_date})", { days_left: d.days_left, due_date: formatDay(d.due_date) }));
    return parts.join(" · ") || "—";
  };

  return (
    <details className="card">
      <summary>
        {t("Preventive maintenance")}{" "}
        <span className="muted small">{t("({count} plan(s){v})", { count: plans.plans.filter((p) => p.active).length, v: urgent.length > 0 && t(", {count} overdue, {count2} due soon", { count: urgent.filter((d) => d.state === "overdue").length, count2: urgent.filter((d) => d.state === "due_soon").length }) })}</span>
      </summary>
      <div className="stack pt-tables">
        <ErrorText message={error} />
        {plans.plans.length === 0 ? (
          <p className="muted small">
            {t("No plans yet. A plan is a service repeated every so many km and/or days (for example an A-service every 10,000 km or 90 days), for every bus or one model. The due list then shows which buses need it, using each bus's latest odometer reading from the trip logs.")}
          </p>
        ) : (
          <>
            <div className="row space-between wrap">
              <span className="muted small">{t("Due dates count from the last completed work order for the plan; odometers come from the latest trip log (data up to {v}).", { v: options.buses.reduce((m, b) => (b.last_trip && b.last_trip > m ? b.last_trip : m), "") ? formatDay(options.buses.reduce((m, b) => (b.last_trip && b.last_trip > m ? b.last_trip : m), "")) : "—" })}</span>
              <label className="check small">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t("Show all buses")}
              </label>
            </div>
            {rows.length === 0 ? (
              <p className="muted small">{t("Nothing overdue or due soon.")}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Plan")}</th>
                    <th className="num">{t("Bus")}</th>
                    <th>{t("Last done")}</th>
                    <th>{t("Next due")}</th>
                    <th>{t("Status")}</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={`${d.plan_id}/${d.bus_id}`}>
                      <td>{d.plan}</td>
                      <td className="num mono">
                        {d.bus_id} <span className="muted small">{d.model}</span>
                      </td>
                      <td>
                        {d.last_done ?? "—"}
                        {d.last_km !== null && <div className="muted small">{t("{last_km} km", { last_km: formatInteger(d.last_km) })}</div>}
                      </td>
                      <td>{d.state === "never_done" ? <span className="muted small">{t("log the last service to start tracking")}</span> : due(d)}</td>
                      <td>
                        <span className={`badge badge-${DUE_BADGE[d.state]}`}>{t(DUE_LABEL[d.state])}</span>
                      </td>
                      {canEdit && (
                        <td className="num">
                          <button className="small-btn" onClick={() => onLog(d)}>
                            {t("Log service…")}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details>
              <summary className="small">{t("Plans ({count})", { count: plans.plans.length })}</summary>
              <table className="data-table pt-tables">
                <thead>
                  <tr>
                    <th>{t("Plan")}</th>
                    <th>{t("Applies to")}</th>
                    <th>{t("Category")}</th>
                    <th>{t("Every")}</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {plans.plans.map((p) => (
                    <tr key={p.plan_id} className={p.active ? undefined : "muted-row"}>
                      <td>
                        {p.name}
                        {!p.active && " (paused)"}
                        {p.notes && <div className="muted small">{p.notes}</div>}
                      </td>
                      <td>{p.model_id ? (options.models.find((m) => m.model_id === p.model_id)?.label ?? p.model_id) : t("All buses")}</td>
                      <td>{catLabel.get(p.category) ?? p.category}</td>
                      <td>{[p.interval_km && t("{n} km", { n: formatInteger(p.interval_km) }), p.interval_days && t("{n} days", { n: p.interval_days })].filter(Boolean).join(t(" or "))}</td>
                      {canEdit && (
                        <td className="num">
                          <div className="row">
                            <button className="small-btn" onClick={() => void act(() => api.ptSetMaintPlanActive(p.plan_id, !p.active))}>
                              {p.active ? t("Pause") : t("Resume")}
                            </button>
                            {canRemove && (
                              <button className="small-btn danger" onClick={() => window.confirm(t("Delete plan \"{name}\"?", { name: p.name })) && void act(() => api.ptDeleteMaintPlan(p.plan_id))}>
                                {t("Delete")}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
        {canEdit &&
          (adding ? (
            <AddPlan
              options={options}
              onSave={(p) =>
                act(async () => {
                  await api.ptAddMaintPlan(p);
                  setAdding(false);
                })
              }
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div>
              <button className="small-btn" onClick={() => setAdding(true)}>
                {t("Add plan…")}
              </button>
            </div>
          ))}
      </div>
    </details>
  );
}

function AddPlan({
  options,
  onSave,
  onCancel,
}: {
  options: PtMaintOptions;
  onSave: (p: Parameters<typeof api.ptAddMaintPlan>[0]) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState({ name: "", category: "general", model_id: "", interval_km: "", interval_days: "", notes: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      className="stack adjust-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          name: f.name.trim(),
          category: f.category,
          model_id: f.model_id || undefined,
          interval_km: f.interval_km ? Number(f.interval_km) : undefined,
          interval_days: f.interval_days ? Number(f.interval_days) : undefined,
          notes: f.notes.trim() || undefined,
        });
      }}
    >
      <div className="row wrap">
        <label className="field inline grow">
          <span>{t("Plan name")}</span>
          <input value={f.name} onChange={set("name")} required placeholder={t("e.g. A-service, HV battery check")} />
        </label>
        <label className="field inline">
          <span>{t("Category")}</span>
          <select value={f.category} onChange={set("category")}>
            {options.categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Applies to")}</span>
          <select value={f.model_id} onChange={set("model_id")}>
            <option value="">{t("All buses")}</option>
            {options.models.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>{t("Every (km)")}</span>
          <input type="number" min="1" value={f.interval_km} onChange={set("interval_km")} />
        </label>
        <label className="field inline">
          <span>{t("and/or every (days)")}</span>
          <input type="number" min="1" value={f.interval_days} onChange={set("interval_days")} />
        </label>
        <label className="field inline grow">
          <span>{t("Notes")}</span>
          <input value={f.notes} onChange={set("notes")} />
        </label>
        <button className="primary align-end" type="submit" disabled={!f.interval_km && !f.interval_days}>
          {t("Add plan")}
        </button>
        <button type="button" className="align-end" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
