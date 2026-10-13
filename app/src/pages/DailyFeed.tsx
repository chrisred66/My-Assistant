// Daily Feed: your topics of interest and each morning's feeds of the top verified stories from the past 24 hours.
// Free plan: one feed with all topics weighted equally; paid: one feed per topic. New topics start the next day.
// Stories count as verified when at least two different outlets reported them (see server/src/Feed.php).
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../components/common";
import { api, type Feed, type FeedResponse, type User } from "../lib/api";
import { errorMessage, formatDateTime } from "../lib/format";

const dayLabel = (d: string, today: string) => {
  if (d === today) return "Today";
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() - 1);
  if (d === t.toISOString().slice(0, 10)) return "Yesterday";
  return new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

const ago = (iso: string | null) => {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso.replace(" ", "T")).getTime()) / 3_600_000;
  return h < 1 ? "under an hour ago" : h < 24 ? `${Math.round(h)} h ago` : formatDateTime(iso);
};

export default function DailyFeed({ user }: { user: User }) {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [tab, setTab] = useState<string | null>(null); // the shown feed (its key)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSuper = user.account_role === "super_admin";

  const load = useCallback(async (d: string | null) => {
    setError(null);
    try {
      setData(await api.feed(d ?? undefined));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [load, date]);

  async function addTopic(e: FormEvent) {
    e.preventDefault();
    if (!topic.trim()) return;
    setError(null);
    try {
      await api.addFeedTopic(topic.trim());
      setTopic("");
      await load(date);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleChinese(id: number, on: boolean) {
    try {
      await api.setFeedTopicChinese(id, on);
      await load(date);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeTopic(id: number, name: string) {
    if (!window.confirm(`Stop following "${name}"?`)) return;
    try {
      await api.removeFeedTopic(id);
      await load(date);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function generate(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.generateFeed(force);
      setDate(null);
      await load(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const today = data?.today ?? "";
  const shownDate = data?.date ?? "";
  const active = data?.topics.filter((t) => t.effective_from <= today) ?? [];
  const pending = data?.topics.filter((t) => t.effective_from > today) ?? [];
  const dates = data?.can_go_back ? Array.from(new Set([today, ...data.dates])).slice(0, 14) : [];
  const feeds = data?.feeds ?? [];
  const current = feeds.find((f) => f.feed_key === tab) ?? feeds[0];
  const rebuildButton = isSuper && shownDate === today && feeds.length > 0 && (
    <button className="small-btn feed-rebuild" disabled={busy} onClick={() => void generate(true)}>
      {busy ? "Building… (a few minutes)" : "Rebuild today's feed"}
    </button>
  );

  return (
    <section className="page">
      {/* Title, day and feed tabs stay pinned above the feed while it scrolls. */}
      <div className="sticky-head">
        <header className="page-header">
          <h1>Daily Feed</h1>
          <p className="muted">
            The top stories of the past 24 hours on your topics, built every morning at 8:00. A story is included only when at least two different
            outlets reported it.
          </p>
        </header>
        {(dates.length > 1 || (feeds.length === 1 && rebuildButton)) && (
          <div className="row wrap feed-bar">
            {dates.length > 1 && (
              <div className="segmented" role="tablist" aria-label="Day">
                {dates.map((d) => (
                  <button key={d} role="tab" aria-selected={d === shownDate} className={d === shownDate ? "on" : ""} onClick={() => setDate(d)}>
                    {dayLabel(d, today)}
                  </button>
                ))}
              </div>
            )}
            {feeds.length <= 1 && rebuildButton}
          </div>
        )}
        {feeds.length > 1 && current && (
          <div className="feed-tabs" role="tablist" aria-label="Feeds">
            {feeds.map((f) => {
              const zhTab = f.feed_key.endsWith("#zh");
              return (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={f === current}
                  className={`feed-tab${zhTab ? " zh" : ""}${f === current ? " on" : ""}`}
                  title={zhTab ? f.title : undefined}
                  onClick={() => setTab(f.feed_key)}
                >
                  <span className="feed-tab-title" lang={zhTab ? "zh" : undefined}>
                    {zhTab ? "中文" : f.title}
                  </span>
                  <span className="feed-tab-count">{f.status === "ready" ? f.items.length : "—"}</span>
                </button>
              );
            })}
            {rebuildButton}
          </div>
        )}
      </div>

      <ErrorText message={error} />
      {!data && !error && <p className="muted">Loading…</p>}

      {data && data.feeds.length === 0 && (
        <div className="card">
          {shownDate !== today ? (
            <p className="muted">No feed for this day.</p>
          ) : active.length === 0 ? (
            <p className="muted">{pending.length ? "Your first feed arrives tomorrow at 8:00." : "Add a topic to get a feed every morning."}</p>
          ) : (
            <div className="row">
              <p className="muted">Today's feed hasn't been built yet{Number(new Date().getHours()) < 8 ? "; it's built at 8:00" : ""}.</p>
              {Number(new Date().getHours()) >= 8 && (
                <button className="small-btn" disabled={busy} onClick={() => void generate(false)}>
                  {busy ? "Building… (a few minutes)" : "Build it now"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {current && <FeedPanel feed={current} />}

      <div className="card stack">
        <div className="row space-between wrap">
          <h2>Your topics</h2>
          <span className="muted small">
            {data?.plan === "combined" ? "Free plan: one feed with your topics weighted equally" : "One feed per topic"}
          </span>
        </div>
        <div className="feed-topics">
          {active.map((t) => (
            <span key={t.id} className="feed-topic">
              {t.topic}
              <button
                className={`feed-zh${Number(t.include_zh) ? " on" : ""}`}
                aria-pressed={!!Number(t.include_zh)}
                title={Number(t.include_zh) ? "Includes Chinese news (click to turn off)" : "Also include Chinese news"}
                onClick={() => void toggleChinese(t.id, !Number(t.include_zh))}
              >
                中文
              </button>
              <button className="link-btn" aria-label={`Remove ${t.topic}`} title="Stop following" onClick={() => void removeTopic(t.id, t.topic)}>
                ×
              </button>
            </span>
          ))}
          {pending.map((t) => (
            <span key={t.id} className="feed-topic pending" title={`Starts in the feed of ${t.effective_from}`}>
              {t.topic} <span className="small">· from tomorrow</span>
              <button className="link-btn" aria-label={`Remove ${t.topic}`} title="Stop following" onClick={() => void removeTopic(t.id, t.topic)}>
                ×
              </button>
            </span>
          ))}
          {data && !data.topics.length && <span className="muted small">No topics yet.</span>}
        </div>
        <form className="row" onSubmit={(e) => void addTopic(e)}>
          <input className="grow" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={120} placeholder="Add a topic, e.g. hydrogen buses" aria-label="New topic" />
          <button className="primary" type="submit" disabled={!topic.trim()}>
            Add topic
          </button>
        </form>
        <p className="muted small">
          New topics start with tomorrow's feed. 中文 adds Chinese-language news to a topic (on the paid plan, in a tab of its own).
        </p>
      </div>

      {data && !data.can_go_back && <p className="muted small">Earlier days' feeds are on the paid plan.</p>}
    </section>
  );
}

/** One feed: international stories, then Chinese ones in their own section; each with a summary, key points and its outlets. */
function FeedPanel({ feed: f }: { feed: Feed }) {
  const intl = f.items.filter((i) => i.lang !== "zh");
  const zh = f.items.filter((i) => i.lang === "zh");
  const sections = [
    { key: "intl", title: zh.length ? "International" : null, items: intl },
    { key: "zh", title: intl.length ? "中文" : null, items: zh },
  ].filter((s) => s.items.length);
  // A topic's own Chinese feed (paid plan) aims for 15 stories; other feeds aim for 10 international ones.
  const chineseOnly = f.feed_key.endsWith("#zh");
  const main = chineseOnly ? zh : intl;
  const target = chineseOnly ? 15 : 10;
  return (
    <article key={f.id} className="card stack feed" role="tabpanel">
      <div className="row space-between wrap">
        <h2>{f.title}</h2>
        <span className="muted small">
          {f.topics.length > 1 ? f.topics.join(" · ") + " · " : ""}
          {f.status === "ready" ? `${f.items.length} ${f.items.length === 1 ? "story" : "stories"}` : "not built"}
        </span>
      </div>
      {f.status === "failed" && <p className="error-text small">{f.error}</p>}
      {f.status === "ready" && main.length < target && (
        <p className="muted small">Only {main.length} distinct verified {main.length === 1 ? "story" : "stories"} on this in the past 24 hours.</p>
      )}
      {sections.map((sec) => (
        <section key={sec.key} className="feed-section" lang={sec.key === "zh" ? "zh" : undefined}>
          {sec.title && (
            <h3 className="feed-section-title">
              {sec.title} <span className="muted small">· {sec.items.length}</span>
            </h3>
          )}
          <ol className="feed-items">
            {sec.items.map((i) => (
              <FeedStory key={`${i.lang}-${i.rank}`} item={i} showTopic={f.topics.length > 1} />
            ))}
          </ol>
        </section>
      ))}
    </article>
  );
}

function FeedStory({ item: i, showTopic }: { item: Feed["items"][number]; showTopic: boolean }) {
  const [allSources, setAllSources] = useState(false);
  const shown = allSources ? i.source_list : i.source_list.slice(0, 5);
  return (
    <li className="feed-item">
      <span className="feed-rank">{i.rank}</span>
      <div className="stack-tight">
        <a
          href={i.url}
          className="feed-title"
          onClick={(e) => {
            e.preventDefault();
            void openUrl(i.url).catch(() => window.open(i.url, "_blank"));
          }}
        >
          {i.title}
        </a>
        <span className="muted small">
          {i.publisher} · {ago(i.published_at)}
          {showTopic && ` · ${i.topic}`}
        </span>
        {i.summary && <p className="feed-summary">{i.summary}</p>}
        {i.key_points.length > 0 && (
          <ul className="feed-points">
            {i.key_points.map((k, n) => (
              <li key={n}>{k}</li>
            ))}
          </ul>
        )}
        <span className="small feed-sources">
          <span className="feed-verified">✓ Verified · {i.sources} outlets:</span> {shown.join(", ")}
          {i.source_list.length > 5 && (
            <button className="link-btn small" onClick={() => setAllSources((x) => !x)}>
              {allSources ? "fewer" : `+${i.source_list.length - 5} more`}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
