// PT Repair & Maintenance → import work orders from an Access export (.xlsx / .csv).
// The export's layout isn't fixed: columns and free-text values are mapped here (guessed, then remembered by the
// server for files with the same columns). Re-importing a later export updates the same work orders.
import { useState } from "react";
import { ErrorText } from "../../components/common";
import { api, type PtMaintImport, type PtMaintOptions } from "../../lib/api";
import { errorMessage, formatInteger } from "../../lib/format";
import { track } from "../../lib/activity";

type ValueMaps = Record<string, Record<string, string | null>>;

const VALUE_LABELS: Record<string, string> = { type: "Type", category: "Category", status: "Status", priority: "Priority", workshop: "Workshop" };

export default function MaintImport({
  options,
  labels,
  onDone,
}: {
  options: PtMaintOptions;
  labels: { type: Record<string, string>; status: Record<string, string>; category: Map<string, string> };
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PtMaintImport | null>(null);
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [values, setValues] = useState<ValueMaps>({});
  const [dateOrder, setDateOrder] = useState<"dmy" | "mdy" | undefined>(undefined);
  const [dirty, setDirty] = useState(false); // mapping changed since the last preview
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(f: File, action: "preview" | "import", opts: { columns?: Record<string, string>; values?: ValueMaps; dateOrder?: "dmy" | "mdy" }) {
    setBusy(true);
    setError(null);
    try {
      const r = await track(action === "import" ? "importing" : "uploading", action === "import" ? "WO import" : "Reading file", () =>
        api.ptImportMaint(f, action, opts),
      );
      if (action === "import") {
        setDone(
          `${r.file}: ${formatInteger(r.inserted ?? 0)} new, ${formatInteger(r.updated ?? 0)} updated, ${formatInteger(r.unchanged ?? 0)} unchanged` +
            (r.skipped ? `, ${formatInteger(r.skipped)} skipped` : "") +
            ". The mapping is remembered for files with these columns.",
        );
        setPreview(null);
        setFile(null);
        onDone();
        return;
      }
      setPreview(r);
      setColumns(r.columns);
      const v: ValueMaps = {};
      for (const [field, list] of Object.entries(r.value_maps)) v[field] = Object.fromEntries(list.map((x) => [x.value, x.maps_to]));
      setValues(v);
      setDateOrder(r.date_order);
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const choices: Record<string, { value: string; label: string }[]> = {
    type: options.types.map((t) => ({ value: t, label: labels.type[t] ?? t })),
    status: options.statuses.map((s) => ({ value: s, label: labels.status[s] ?? s })),
    priority: options.priorities.map((p) => ({ value: p, label: p })),
    category: options.categories.map((c) => ({ value: c.code, label: c.label })),
    workshop: options.workshops.map((w) => ({ value: w, label: w })),
  };
  const defaults: Record<string, string> = { type: "Repair", category: "General / other", status: "open, or completed if it has a closing date", priority: "normal", workshop: "not assigned" };

  return (
    <div className="stack adjust-panel">
      <strong className="small">Import work orders from an Access export</strong>
      <p className="muted small">
        In Access: External Data → Export → Excel (or Text File). Upload the .xlsx or .csv here. Match its columns to the fields below once; the
        mapping is remembered for later exports with the same columns. Work orders are matched by their work-order number, so importing a newer
        export updates them (e.g. adds closing dates and costs) instead of duplicating them.
      </p>
      <div className="row wrap">
        <label className="file-btn">
          {file ? file.name : "Choose export…"}
          <input
            type="file"
            accept=".xlsx,.csv,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              setFile(f);
              setDone(null);
              setPreview(null);
              if (f) void run(f, "preview", {});
            }}
          />
        </label>
        {busy && <span className="muted small">Reading…</span>}
      </div>
      <ErrorText message={error} />
      {done && <p className="small">{done}</p>}

      {preview && file && (
        <>
          <p className="small">
            <strong>{preview.file}</strong>: {formatInteger(preview.total_rows)} rows, {preview.headers.length} columns.{" "}
            {preview.remembered ? "This layout was imported before; its mapping is filled in." : "New layout: check the guessed mapping below."}
          </p>

          <details open={!preview.remembered || !preview.ready}>
            <summary className="small">
              <strong>Columns</strong> {preview.ready ? "" : <span className="error-text">— choose the columns marked *</span>}
            </summary>
            <div className="map-grid">
              {preview.fields.map((f) => (
                <label key={f.field} className={`field inline${f.required && !columns[f.field] ? " missing" : ""}`}>
                  <span>
                    {f.label}
                    {f.required && " *"}
                  </span>
                  <select
                    value={columns[f.field] ?? ""}
                    onChange={(e) => {
                      const next = { ...columns };
                      if (e.target.value) next[f.field] = e.target.value;
                      else delete next[f.field];
                      setColumns(next);
                      setDirty(true);
                    }}
                  >
                    <option value="">— not in the file —</option>
                    {preview.headers.map((h, i) => (
                      <option key={`${h}${i}`} value={h}>
                        {h || `(column ${i + 1})`}
                        {preview.sample[0]?.[i] !== undefined && preview.sample[0]?.[i] !== null && preview.sample[0]?.[i] !== "" ? ` — e.g. ${String(preview.sample[0][i]).slice(0, 24)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="field inline">
                <span>Dates are written</span>
                <select
                  value={dateOrder}
                  onChange={(e) => {
                    setDateOrder(e.target.value as "dmy" | "mdy");
                    setDirty(true);
                  }}
                >
                  <option value="dmy">day/month/year</option>
                  <option value="mdy">month/day/year</option>
                </select>
              </label>
            </div>
            {!columns.external_ref && (
              <p className="muted small">
                Without a work-order number column, rows are matched by bus + reported date + work description; changing any of those in Access would
                import the row again as new.
              </p>
            )}
          </details>

          {Object.keys(preview.value_maps).length > 0 && (
            <details open={!preview.remembered}>
              <summary className="small">
                <strong>Values</strong> — how the export's wording maps to the app
              </summary>
              <div className="stack pt-tables">
                {Object.entries(preview.value_maps).map(([field, list]) => (
                  <div key={field} className="stack-tight">
                    <h3>{VALUE_LABELS[field] ?? field}</h3>
                    <div className="map-grid">
                      {list.map((v) => (
                        <label key={v.value} className={`field inline${values[field]?.[v.value] ? "" : " unmapped"}`}>
                          <span>
                            “{v.value}” <span className="muted">({v.rows})</span>
                          </span>
                          <select
                            value={values[field]?.[v.value] ?? ""}
                            onChange={(e) => {
                              setValues({ ...values, [field]: { ...values[field], [v.value]: e.target.value || null } });
                              setDirty(true);
                            }}
                          >
                            <option value="">— default ({defaults[field]}) —</option>
                            {choices[field]?.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {dirty ? (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void run(file, "preview", { columns, values, dateOrder })}>
                Update preview
              </button>
              <span className="muted small align-end">The mapping changed; update the preview before importing.</span>
            </div>
          ) : (
            preview.ready &&
            preview.would && (
              <>
                <dl className="kv">
                  <dt>Readable rows</dt>
                  <dd>
                    {formatInteger(preview.rows ?? 0)}
                    {preview.skipped ? <span className="muted"> · {formatInteger(preview.skipped)} skipped</span> : null}
                  </dd>
                  <dt>Would import</dt>
                  <dd>
                    <strong>{formatInteger(preview.would.new)} new</strong> · {formatInteger(preview.would.update)} updated ·{" "}
                    {formatInteger(preview.would.unchanged)} unchanged
                  </dd>
                </dl>
                {preview.skipped_examples && preview.skipped_examples.length > 0 && (
                  <details>
                    <summary className="small">Skipped rows</summary>
                    <ul className="small">
                      {preview.skipped_examples.map((s) => (
                        <li key={s.line}>
                          Line {s.line}: {s.reason}
                        </li>
                      ))}
                    </ul>
                    <p className="muted small">Buses must be in Fleet (by fleet number or plate).</p>
                  </details>
                )}
                {preview.preview && preview.preview.length > 0 && (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th />
                          <th>WO</th>
                          <th className="num">Bus</th>
                          <th>Reported → closed</th>
                          <th>Work</th>
                          <th>Type · category</th>
                          <th>Status</th>
                          <th>Workshop</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.map((r) => (
                          <tr key={r.external_ref}>
                            <td>
                              <span className={`badge badge-${r.import_status === "new" ? "good" : r.import_status === "update" ? "warning" : "info"}`}>
                                {r.import_status}
                              </span>
                            </td>
                            <td className="mono small">{r.external_ref.startsWith("auto:") ? "—" : r.external_ref}</td>
                            <td className="num mono">{r.bus_id}</td>
                            <td className="nowrap">
                              {r.reported_date}
                              {r.completed_date && ` → ${r.completed_date}`}
                            </td>
                            <td>{r.title}</td>
                            <td className="small">
                              {labels.type[r.type ?? ""] ?? r.type} · {labels.category.get(r.category ?? "") ?? r.category}
                            </td>
                            <td>{labels.status[r.status ?? ""] ?? r.status}</td>
                            <td>{r.workshop ?? <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="row">
                  <button
                    className="primary"
                    disabled={busy || preview.would.new + preview.would.update === 0}
                    onClick={() => void run(file, "import", { columns, values, dateOrder })}
                  >
                    {busy ? "Importing…" : `Import ${formatInteger(preview.would.new)} new, update ${formatInteger(preview.would.update)}`}
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
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
