// PT Management: the GBA (Green Bus) toolkit, ported from the standalone ptManagement app.
import { useCallback, useEffect, useState } from "react";
import { ErrorText } from "../../components/common";
import { api, type PtStatus, type User } from "../../lib/api";
import { errorMessage, formatInteger } from "../../lib/format";

type Section = "fleet" | "operations" | "trials" | "charging";

const SECTIONS: { id: Section; label: string; description: string }[] = [
  { id: "fleet", label: "Fleet", description: "Electric and hydrogen bus manufacturers, their models and vehicle rosters." },
  { id: "operations", label: "Operations", description: "Daily trip logs (upload or manual entry), KPIs, trends, efficiency and trip exceptions." },
  { id: "trials", label: "Trials", description: "Trial buses and operations, trial trip data, analysis, and promoting a trial bus to the fleet." },
  { id: "charging", label: "Charging", description: "Charging stations and chargers, and the charging-demand simulation." },
];

export default function PtManagement({ user }: { user: User }) {
  const [section, setSection] = useState<Section>("fleet");
  const [status, setStatus] = useState<PtStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.ptStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <section className="page">
      <header className="page-header">
        <h1>PT Management</h1>
        <p className="muted">Green Bus Assessment toolkit: fleet, operations, trials and charging.</p>
      </header>

      <div className="segmented" role="tablist" aria-label="PT Management sections">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} className={section === s.id ? "on" : ""} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <ErrorText message={error} />
      {status === null && !error && <p className="muted">Checking the PT database…</p>}

      {status && !status.connected && <Setup status={status} owner={user.role === "owner"} onRetry={() => void load()} />}

      {status?.connected && (
        <div className="card stack">
          <h2>{current.label}</h2>
          <p className="muted">{current.description}</p>
          <p className="small">This section is being ported from the standalone app.</p>
        </div>
      )}

      {status?.connected && user.role === "owner" && status.tables && (
        <details className="card">
          <summary>Database: {status.database}</summary>
          <table className="data-table pt-tables">
            <thead>
              <tr>
                <th>Table</th>
                <th className="num">Rows</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.tables).map(([name, rows]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className="num">{formatInteger(rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function Setup({ status, owner, onRetry }: { status: PtStatus; owner: boolean; onRetry: () => void }) {
  if (!owner) {
    return (
      <div className="card stack">
        <h2>Not set up yet</h2>
        <p className="muted">The PT Management data hasn't been loaded on the server yet. Please check back later.</p>
      </div>
    );
  }
  return (
    <div className="card stack">
      <h2>Import the GBA database</h2>
      <p className="error-text small">{status.error}</p>
      <ol className="steps">
        <li>
          On the machine that has the data, export <span className="mono">{status.database}</span> (phpMyAdmin → select the database → Export
          → SQL).
        </li>
        <li>
          Here, in phpMyAdmin, create a database named <span className="mono">{status.database}</span> (utf8mb4) and import the file.
        </li>
        <li>
          Give the app's database user access (phpMyAdmin → SQL tab):
          <pre className="mono code-block">GRANT ALL PRIVILEGES ON {status.database}.* TO 'chrismanager'@'localhost';</pre>
        </li>
      </ol>
      <div>
        <button className="primary" onClick={onRetry}>
          Check again
        </button>
      </div>
    </div>
  );
}
