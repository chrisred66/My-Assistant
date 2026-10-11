import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ErrorText, ProviderSelect } from "../components/common";
import { HorizontalBars, Legend, StackedColumns, type BarItem, type StackedPoint } from "../components/UsageChart";
import {
  api,
  PROVIDER_LABELS,
  PROVIDERS,
  type Provider,
  type ProviderSyncStatus,
  type UsageGroup,
  type UsageProviders,
  type UsageRow,
  type UsageView,
} from "../lib/api";
import { errorMessage, formatCompact, formatDateTime, formatInteger, formatUsd, toIsoDate, toSqlDateTime } from "../lib/format";

type Preset = "month" | "7" | "30" | "90" | "custom";
type Metric = "cost" | "tokens";

function presetRange(preset: Exclude<Preset, "custom">): { from: string; to: string } {
  const today = new Date();
  if (preset === "month") return { from: toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: toIsoDate(today) };
  const start = new Date(today);
  start.setDate(start.getDate() - (Number(preset) - 1));
  return { from: toIsoDate(start), to: toIsoDate(today) };
}

/** Every day/month in the range, so gaps show as empty columns instead of being skipped. */
function buckets(from: string, to: string, group: "day" | "month"): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (group === "month") d.setDate(1);
  while (d <= end && out.length < 400) {
    out.push(group === "day" ? toIsoDate(d) : toIsoDate(d).slice(0, 7));
    if (group === "day") d.setDate(d.getDate() + 1);
    else d.setMonth(d.getMonth() + 1);
  }
  return out;
}

function shortLabel(bucket: string, group: "day" | "month"): string {
  const d = new Date(group === "day" ? `${bucket}T00:00:00` : `${bucket}-01T00:00:00`);
  return group === "day"
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function longLabel(bucket: string, group: "day" | "month"): string {
  const d = new Date(group === "day" ? `${bucket}T00:00:00` : `${bucket}-01T00:00:00`);
  return group === "day"
    ? d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

const metricValue = (r: UsageRow, metric: Metric) => (metric === "cost" ? (r.cost_usd ?? 0) : r.input_tokens + r.output_tokens);

export default function Usage() {
  const [preset, setPreset] = useState<Preset>("month");
  const [range, setRange] = useState(presetRange("month"));
  const [group, setGroup] = useState<UsageGroup>("day");
  const [metric, setMetric] = useState<Metric>("cost");
  const [view, setView] = useState<UsageView>("providers");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [sources, setSources] = useState<UsageProviders | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api.usageSummary(range.from, range.to, group, view)).rows);
    } catch (e) {
      setError(errorMessage(e));
      setRows([]);
    }
  }, [range, group, view]);

  const loadSources = useCallback(async () => {
    try {
      setSources(await api.usageProviders());
    } catch {
      setSources(null); // the panel just stays hidden
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const anthropicSynced = !!sources?.anthropic.synced_at;

  function choosePreset(p: Preset) {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  }

  const totals = useMemo(() => {
    const t = { cost: 0, requests: 0, input: 0, output: 0, unpriced: 0 };
    for (const r of rows ?? []) {
      t.cost += r.cost_usd ?? 0;
      t.requests += r.requests;
      t.input += r.input_tokens;
      t.output += r.output_tokens;
      if (r.cost_usd === null && r.input_tokens + r.output_tokens + r.audio_seconds > 0) t.unpriced++;
    }
    return t;
  }, [rows]);

  const providersPresent = useMemo(() => PROVIDERS.filter((p) => rows?.some((r) => r.provider === p)), [rows]);

  const stacked: StackedPoint[] = useMemo(() => {
    if (!rows || group === "model") return [];
    return buckets(range.from, range.to, group).map((b) => {
      const values: Partial<Record<Provider, number>> = {};
      for (const r of rows.filter((x) => x.bucket === b)) values[r.provider] = (values[r.provider] ?? 0) + metricValue(r, metric);
      return { label: shortLabel(b, group), title: longLabel(b, group), values };
    });
  }, [rows, group, range, metric]);

  const bars: BarItem[] = useMemo(() => {
    if (!rows || group !== "model") return [];
    return rows
      .map((r) => ({
        label: r.bucket.slice(r.provider.length + 1) || r.bucket,
        provider: r.provider,
        value: metricValue(r, metric),
        detail: `${formatInteger(r.requests)} requests · ${formatCompact(r.input_tokens)} in / ${formatCompact(r.output_tokens)} out`,
      }))
      .sort((a, b) => b.value - a.value);
  }, [rows, group, metric]);

  const fmt = metric === "cost" ? formatUsd : (v: number) => `${formatInteger(v)} tokens`;
  const fmtTick = metric === "cost" ? (v: number) => (v === 0 ? "$0" : formatUsd(v)) : formatCompact;

  return (
    <section className="page">
      <header className="page-header">
        <h1>Usage</h1>
        <p className="muted">
          {view === "providers"
            ? "Everything Anthropic and OpenAI report for your accounts (synced from their usage APIs), DeepSeek usage from this app, and manual entries."
            : "Only the calls made through this app."}
        </p>
      </header>

      <div className="filters row wrap">
        <div className="field inline">
          <span>Data</span>
          <div className="segmented" role="group" aria-label="Data source">
            <button className={view === "providers" ? "on" : ""} aria-pressed={view === "providers"} onClick={() => setView("providers")}>
              All provider usage
            </button>
            <button className={view === "app" ? "on" : ""} aria-pressed={view === "app"} onClick={() => setView("app")}>
              This app only
            </button>
          </div>
        </div>
        <label className="field inline">
          <span>Range</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
            <option value="month">This month</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="field inline">
              <span>From</span>
              <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
            </label>
            <label className="field inline">
              <span>To</span>
              <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
            </label>
          </>
        )}
        <label className="field inline">
          <span>Group by</span>
          <select value={group} onChange={(e) => setGroup(e.target.value as UsageGroup)}>
            <option value="day">Day</option>
            <option value="month">Month</option>
            <option value="model">Model</option>
          </select>
        </label>
        <div className="field inline">
          <span>Show</span>
          <div className="segmented" role="group" aria-label="Metric">
            <button className={metric === "cost" ? "on" : ""} aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>
              Cost
            </button>
            <button className={metric === "tokens" ? "on" : ""} aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>
              Tokens
            </button>
          </div>
        </div>
        <button className="small-btn align-end" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {view === "providers" && sources && (
        <Sources
          sources={sources}
          range={range}
          onSynced={() => {
            void loadSources();
            void load();
          }}
        />
      )}

      <ErrorText message={error} />

      <div className="tiles">
        <div className="tile hero">
          <span className="tile-label">Total cost</span>
          <span className="tile-value">{formatUsd(totals.cost)}</span>
          {totals.unpriced > 0 && <span className="muted small">Some usage has no price set and isn't included</span>}
        </div>
        <div className="tile">
          <span className="tile-label">Requests</span>
          <span className="tile-value">{formatCompact(totals.requests)}</span>
          {view === "providers" && anthropicSynced && <span className="muted small">Anthropic doesn't report request counts</span>}
        </div>
        <div className="tile">
          <span className="tile-label">Input tokens</span>
          <span className="tile-value">{formatCompact(totals.input)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Output tokens</span>
          <span className="tile-value">{formatCompact(totals.output)}</span>
        </div>
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows?.length === 0 && !error && <p className="muted">No usage in this range yet.</p>}

      {rows && rows.length > 0 && (
        <div className="card stack">
          <div className="row space-between wrap">
            <h2>
              {metric === "cost" ? "Cost" : "Tokens"} by {group === "model" ? "model" : group}
            </h2>
            {providersPresent.length > 1 && <Legend providers={providersPresent} />}
            {providersPresent.length === 1 && <span className="muted small">{PROVIDER_LABELS[providersPresent[0]]}</span>}
          </div>
          {group === "model" ? (
            <HorizontalBars items={bars} format={fmt} />
          ) : (
            <StackedColumns points={stacked} format={fmt} formatTick={fmtTick} />
          )}
        </div>
      )}

      {rows && rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{group === "model" ? "Model" : group === "day" ? "Day" : "Month"}</th>
              <th>Provider</th>
              <th className="num">Requests</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Audio min</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.bucket}-${r.provider}`}>
                <td>{r.bucket}</td>
                <td>
                  <span className={`swatch series-${r.provider}`} aria-hidden /> {PROVIDER_LABELS[r.provider] ?? r.provider}
                </td>
                <td className="num">{formatInteger(r.requests)}</td>
                <td className="num">{formatInteger(r.input_tokens)}</td>
                <td className="num">{formatInteger(r.output_tokens)}</td>
                <td className="num">{formatInteger(r.cache_read_tokens)}</td>
                <td className="num">{r.audio_seconds ? (r.audio_seconds / 60).toFixed(1) : "—"}</td>
                <td className="num">{formatUsd(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div>
        <button className="small-btn" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
          {showForm ? "Hide manual entry" : "Add usage manually…"}
        </button>
      </div>
      {showForm && <ManualEntry onSaved={() => void load()} />}
    </section>
  );
}

/** Where the "All provider usage" numbers come from, with a sync button and DeepSeek's balance. */
function Sources({
  sources,
  range,
  onSynced,
}: {
  sources: UsageProviders;
  range: { from: string; to: string };
  onSynced: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSync = sources.anthropic.can_sync || sources.openai.can_sync;

  async function sync() {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.syncUsage(range.from, range.to);
      const parts = (["anthropic", "openai"] as const).map((p) => {
        const r = res.results[p];
        if (!r) return null;
        if (r.ok) return `${PROVIDER_LABELS[p]}: ${r.rows} rows`;
        return `${PROVIDER_LABELS[p]}: ${r.skipped ? "not set up" : "failed"}`;
      });
      setMessage(`Synced ${res.from} to ${res.to}. ${parts.filter(Boolean).join(" · ")}`);
      onSynced();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  const syncLine = (s: ProviderSyncStatus) => {
    if (!s.can_sync) return <span className="muted">Not set up. Add {s.key_setting} to server/.env.</span>;
    if (s.last_error) return <span className="error-text small">Last sync failed: {s.last_error}</span>;
    if (!s.synced_at) return <span className="muted">Ready. Not synced yet.</span>;
    return (
      <span className="muted">
        Synced {formatDateTime(s.synced_at)} · covers {s.range_from} to {s.range_to}
      </span>
    );
  };

  const ds = sources.deepseek;
  return (
    <div className="card stack">
      <div className="row space-between wrap">
        <h2>Sources</h2>
        <button className="small-btn" onClick={() => void sync()} disabled={syncing || !canSync}>
          {syncing ? "Syncing…" : "Sync this range from providers"}
        </button>
      </div>
      <dl className="kv">
        <dt>Anthropic</dt>
        <dd className="small">{syncLine(sources.anthropic)}</dd>
        <dt>OpenAI</dt>
        <dd className="small">{syncLine(sources.openai)}</dd>
        <dt>DeepSeek</dt>
        <dd className="small">
          {ds.balance_error ? (
            <span className="error-text small">Balance unavailable: {ds.balance_error}</span>
          ) : (
            <span>
              Balance{" "}
              {(ds.balance ?? [])
                .filter((b) => Number(b.total) > 0)
                .map((b) => `${Number(b.total).toFixed(2)} ${b.currency}`)
                .join(" · ") || "0.00"}
              {ds.available === false && " (not enough to make requests)"}
            </span>
          )}
          <span className="muted"> · No usage-history API, so usage here comes from this app.</span>
        </dd>
      </dl>
      <p className="muted small">
        Provider data appears a few minutes after use. Calls made through this app are already included in Anthropic's and OpenAI's
        numbers, so they aren't added twice.
      </p>
      {message && <p className="small">{message}</p>}
      <ErrorText message={error} />
    </div>
  );
}

function ManualEntry({ onSaved }: { onSaved: () => void }) {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState(() => toSqlDateTime(new Date()).slice(0, 16).replace(" ", "T"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.addUsage({
        provider,
        model: model.trim(),
        input_tokens: Number(input) || 0,
        output_tokens: Number(output) || 0,
        note: note.trim() || undefined,
        occurred_at: when ? `${when.replace("T", " ")}:00` : undefined,
      });
      setMessage("Saved.");
      setInput("");
      setOutput("");
      setNote("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>Manual usage entry</h2>
      <p className="muted small">For usage from tools that don't go through this server, e.g. the Claude or ChatGPT apps.</p>
      <div className="row wrap">
        <label className="field inline">
          <span>Provider</span>
          <ProviderSelect value={provider} onChange={(v) => v && setProvider(v)} allowDefault={false} />
        </label>
        <label className="field inline grow">
          <span>Model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} required placeholder="e.g. claude-sonnet-5-5" spellCheck={false} />
        </label>
        <label className="field inline">
          <span>Input tokens</span>
          <input type="number" min={0} value={input} onChange={(e) => setInput(e.target.value)} required />
        </label>
        <label className="field inline">
          <span>Output tokens</span>
          <input type="number" min={0} value={output} onChange={(e) => setOutput(e.target.value)} required />
        </label>
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>When</span>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <label className="field inline grow">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="Optional" />
        </label>
        <button className="primary align-end" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <ErrorText message={error} />
      {message && <p className="small">{message}</p>}
    </form>
  );
}
