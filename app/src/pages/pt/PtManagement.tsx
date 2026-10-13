// PT Management: the GBA (Green Bus) toolkit, ported from the standalone ptManagement app.
import { useCallback, useEffect, useState } from "react";
import { ErrorText } from "../../components/common";
import { api, canPt, type PtModule, type PtStatus, type User } from "../../lib/api";
import { errorMessage, formatInteger } from "../../lib/format";
import Fleet from "./Fleet";
import Maintenance from "./Maintenance";
import Charging from "./Charging";
import Operations from "./Operations";
import Drivers from "./Drivers";
import Trials from "./Trials";

type Section = "fleet" | "operations" | "drivers" | "trials" | "charging" | "maintenance";

// Each section belongs to a PT module; people see the sections of the modules their account includes.
const SECTIONS: { id: Section; module: PtModule; label: string; description: string }[] = [
  { id: "fleet", module: "planning", label: "Fleet", description: "Electric and hydrogen bus manufacturers, their models and vehicle rosters." },
  { id: "operations", module: "operations", label: "Operations", description: "Daily trip logs (upload or manual entry), KPIs, trends, efficiency and trip exceptions." },
  { id: "drivers", module: "operations", label: "Drivers", description: "Which driver drove which bus and model, multi-model drivers, Shift A / B, and energy performance per bus." },
  { id: "trials", module: "planning", label: "Trials", description: "Trial buses and operations, trial trip data, analysis, and promoting a trial bus to the fleet." },
  { id: "charging", module: "planning", label: "Charging", description: "Charging stations and chargers, and the charging-demand simulation." },
  { id: "maintenance", module: "maintenance", label: "Repair & Maintenance", description: "Work orders, preventive maintenance plans and what's due, downtime, availability and maintenance cost." },
];

export default function PtManagement({ user }: { user: User }) {
  const sections = SECTIONS.filter((s) => canPt(user, s.module));
  const [section, setSection] = useState<Section>(sections[0]?.id ?? "fleet");
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

  const current = sections.find((s) => s.id === section) ?? sections[0] ?? SECTIONS[0];
  const superAdmin = user.role === "super_admin";

  return (
    <section className="page">
      <div className="sticky-head">
        <header className="page-header">
          <h1>PT Management</h1>
          <p className="muted">Green Bus Assessment toolkit: fleet, operations, trials, charging, and repair &amp; maintenance.</p>
        </header>

        <div className="segmented" role="tablist" aria-label="PT Management sections">
          {sections.map((s) => (
            <button key={s.id} role="tab" aria-selected={current.id === s.id} className={current.id === s.id ? "on" : ""} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <p className="muted small">{current.description}</p>
      </div>

      <ErrorText message={error} />
      {status === null && !error && <p className="muted">Checking the PT database…</p>}

      {status && !status.connected && <Setup status={status} owner={superAdmin} onRetry={() => void load()} />}

      {status?.connected && current.id === "fleet" && <Fleet user={user} />}
      {status?.connected && current.id === "operations" && <Operations user={user} />}
      {status?.connected && current.id === "drivers" && <Drivers />}
      {status?.connected && current.id === "trials" && <Trials user={user} />}
      {status?.connected && current.id === "charging" && <Charging user={user} />}
      {status?.connected && current.id === "maintenance" && <Maintenance user={user} />}

      {status?.connected && superAdmin && status.tables && (
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
