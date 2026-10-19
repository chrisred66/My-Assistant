// Daily Feed: your topics of interest and each morning's feeds of the top verified stories from the past 24 hours.
// Free plan: one feed with all topics weighted equally; paid: one feed per topic. New topics start the next day.
// Stories count as verified when at least two different outlets reported them (see server/src/Feed.php).
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "../components/common";
import DayPicker from "../components/DayPicker";
import { api, type Feed, type FeedResponse, type User } from "../lib/api";
import { errorMessage, formatDateTime, formatDay, LOCALE } from "../lib/format";
import { getLang, t, tn } from "../lib/i18n";

const dayLabel = (d: string, today: string) => {
  if (d === today) return t("Today");
  const prevDay = new Date(`${today}T12:00:00`);
  prevDay.setDate(prevDay.getDate() - 1);
  if (d === prevDay.toISOString().slice(0, 10)) return t("Yesterday");
  return new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
};

const ago = (iso: string | null) => {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso.replace(" ", "T")).getTime()) / 3_600_000;
  return h < 1 ? t("under an hour ago") : h < 24 ? t("{h} h ago", { h: Math.round(h) }) : formatDateTime(iso);
};

// Topic names in the reader's language (set when a feed day is loaded); a topic not named yet shows as typed.
let topicNames: FeedResponse["topic_names"] = {};
const topicName = (topic: string) => topicNames[topic]?.[getLang()] ?? topic;

/** A feed's title in the reader's language: "Your topics", the topic, or the topic's Chinese-news feed. */
function feedTitle(f: Feed): string {
  if (f.feed_key === "combined") return t(f.title);
  const name = topicName(f.topics[0] ?? f.title);
  return f.feed_key.endsWith("#zh") ? `${name} · 中文` : name;
}

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
      const next = await api.feed(d ?? undefined);
      topicNames = next.topic_names ?? {};
      setData(next);
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
    if (!window.confirm(t("Stop following \"{name}\"?", { name }))) return;
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
  const active = data?.topics.filter((feedTopic) => feedTopic.effective_from <= today) ?? [];
  const pending = data?.topics.filter((feedTopic) => feedTopic.effective_from > today) ?? [];
  const dates = data?.can_go_back ? Array.from(new Set([today, ...data.dates])) : []; // newest first
  const feeds = data?.feeds ?? [];
  const current = feeds.find((f) => f.feed_key === tab) ?? feeds[0];
  const rebuildButton = isSuper && shownDate === today && feeds.length > 0 && (
    <button className="small-btn feed-rebuild" disabled={busy} onClick={() => void generate(true)}>
      {busy ? t("Building… (a few minutes)") : t("Rebuild today's feed")}
    </button>
  );

  return (
    <section className="page">
      {/* Title, day and feed tabs stay pinned above the feed while it scrolls. */}
      <div className="sticky-head">
        <header className="page-header">
          <h1>{t("Daily Feed")}</h1>
          <p className="muted">
            {t("The top stories of the past 24 hours on your topics, built every morning at 8:00. A story is included only when at least two different outlets reported it.")}
          </p>
        </header>
        {(dates.length > 1 || (feeds.length === 1 && rebuildButton)) && (
          <div className="row wrap feed-bar">
            {dates.length > 1 && (
              <DayPicker dates={dates} shown={shownDate} label={(d) => dayLabel(d, today)} onPick={setDate} />
            )}
            {feeds.length <= 1 && rebuildButton}
          </div>
        )}
        {feeds.length > 1 && current && (
          <div className="feed-tabs" role="tablist" aria-label={t("Feeds")}>
            {feeds.map((f) => {
              const zhTab = f.feed_key.endsWith("#zh");
              return (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={f === current}
                  className={`feed-tab${zhTab ? " zh" : ""}${f === current ? " on" : ""}`}
                  title={zhTab ? feedTitle(f) : undefined}
                  onClick={() => setTab(f.feed_key)}
                >
                  <span className="feed-tab-title" lang={zhTab ? "zh" : undefined}>
                    {zhTab ? "中文" : feedTitle(f)}
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
      {!data && !error && <p className="muted">{t("Loading…")}</p>}

      {data && data.feeds.length === 0 && (
        <div className="card">
          {shownDate !== today ? (
            <p className="muted">{t("No feed for this day.")}</p>
          ) : active.length === 0 ? (
            <p className="muted">{pending.length ? t("Your first feed arrives tomorrow at 8:00.") : t("Add a topic to get a feed every morning.")}</p>
          ) : (
            <div className="row">
              <p className="muted">{t("Today's feed hasn't been built yet{v}.", { v: Number(new Date().getHours()) < 8 ? t("; it's built at 8:00") : "" })}</p>
              {Number(new Date().getHours()) >= 8 && (
                <button className="small-btn" disabled={busy} onClick={() => void generate(false)}>
                  {busy ? t("Building… (a few minutes)") : t("Build it now")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {current && <FeedPanel feed={current} />}

      <div className="card stack">
        <div className="row space-between wrap">
          <h2>{t("Your topics")}</h2>
          <span className="muted small">
            {data?.plan === "combined" ? t("Free plan: one feed with your topics weighted equally") : t("One feed per topic")}
          </span>
        </div>
        <div className="feed-topics">
          {active.map((feedTopic) => (
            <span key={feedTopic.id} className="feed-topic">
              {topicName(feedTopic.topic)}
              <button
                className={`feed-zh${Number(feedTopic.include_zh) ? " on" : ""}`}
                aria-pressed={!!Number(feedTopic.include_zh)}
                title={Number(feedTopic.include_zh) ? t("Includes Chinese news (click to turn off)") : t("Also include Chinese news")}
                onClick={() => void toggleChinese(feedTopic.id, !Number(feedTopic.include_zh))}
              >
                中文
              </button>
              <button className="link-btn" aria-label={t("Remove {topic}", { topic: topicName(feedTopic.topic) })} title={t("Stop following")} onClick={() => void removeTopic(feedTopic.id, topicName(feedTopic.topic))}>
                ×
              </button>
            </span>
          ))}
          {pending.map((feedTopic) => (
            <span key={feedTopic.id} className="feed-topic pending" title={t("Starts in the feed of {effective_from}", { effective_from: formatDay(feedTopic.effective_from) })}>
              {topicName(feedTopic.topic)} <span className="small">{t("· from tomorrow")}</span>
              <button className="link-btn" aria-label={t("Remove {topic}", { topic: topicName(feedTopic.topic) })} title={t("Stop following")} onClick={() => void removeTopic(feedTopic.id, topicName(feedTopic.topic))}>
                ×
              </button>
            </span>
          ))}
          {data && !data.topics.length && <span className="muted small">{t("No topics yet.")}</span>}
        </div>
        <form className="row" onSubmit={(e) => void addTopic(e)}>
          <input className="grow" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={120} placeholder={t("Add a topic, e.g. hydrogen buses")} aria-label={t("New topic")} />
          <button className="primary" type="submit" disabled={!topic.trim()}>
            {t("Add topic")}
          </button>
        </form>
        <p className="muted small">
          {t("New topics start with tomorrow's feed. 中文 adds Chinese-language news to a topic (on the paid plan, in a tab of its own).")}
        </p>
      </div>

      {data && !data.can_go_back && <p className="muted small">{t("Earlier days' feeds are on the paid plan.")}</p>}
    </section>
  );
}

/** One feed: international stories, then Chinese ones in their own section; each with a summary, key points and its outlets. */
function FeedPanel({ feed: f }: { feed: Feed }) {
  const intl = f.items.filter((i) => i.lang !== "zh");
  const zh = f.items.filter((i) => i.lang === "zh");
  const sections = [
    { key: "intl", title: zh.length ? t("International") : null, items: intl },
    { key: "zh", title: intl.length ? "中文" : null, items: zh },
  ].filter((s) => s.items.length);
  // A topic's own Chinese feed (paid plan) aims for 15 stories; other feeds aim for 10 international ones.
  const chineseOnly = f.feed_key.endsWith("#zh");
  const main = chineseOnly ? zh : intl;
  const target = chineseOnly ? 15 : 10;
  return (
    <article key={f.id} className="card stack feed" role="tabpanel">
      <div className="row space-between wrap">
        <h2>{feedTitle(f)}</h2>
        <span className="muted small">
          {f.topics.length > 1 ? f.topics.map(topicName).join(" · ") + " · " : ""}
          {f.status === "ready" ? tn(f.items.length, "{n} story", "{n} stories") : t("not built")}
        </span>
      </div>
      {f.status === "failed" && <p className="error-text small">{f.error}</p>}
      {f.status === "ready" && main.length < target && (
        <p className="muted small">{t("Only {count} distinct verified {v} on this in the past 24 hours.", { count: main.length, v: main.length === 1 ? t("story") : t("stories") })}</p>
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
          {showTopic && ` · ${topicName(i.topic)}`}
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
          <span className="feed-verified">{t("✓ Verified · {sources} outlets:", { sources: i.sources })}</span> {shown.join(", ")}
          {i.source_list.length > 5 && (
            <button className="link-btn small" onClick={() => setAllSources((x) => !x)}>
              {allSources ? t("fewer") : t("+{n} more", { n: i.source_list.length - 5 })}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
