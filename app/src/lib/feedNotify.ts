// Daily Feed delivery for the Super Admin: when today's feed is ready (built at 8:00), a desktop notification once a
// day, and the pet announces it. If 8:00 passed without a feed (the scheduled run was missed), asks the server to build
// it, at most once an hour.
import { emit } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { load } from "@tauri-apps/plugin-store";
import { api } from "./api";

const CHECK_MS = 5 * 60_000;
let lastBuildAttempt = 0;

async function store() {
  return load("settings.json", { autoSave: true, defaults: {} });
}

async function check(): Promise<void> {
  const status = await api.feedStatus();
  if (!status.ready) {
    if (status.after_8 && status.topics_due > 0 && Date.now() - lastBuildAttempt > 3_600_000) {
      lastBuildAttempt = Date.now();
      await api.generateFeed(false).catch(() => {});
      return check();
    }
    return;
  }
  const s = await store();
  if ((await s.get<string>("feedNotified")) === status.date) return;
  await s.set("feedNotified", status.date);
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title: "Your Daily Feed is ready", body: `Today's top stories (${status.ready} ${status.ready === 1 ? "feed" : "feeds"}) are in My Assistant → Daily Feed.` });
  } catch {
    // no notifications on this system: the pet still announces it
  }
  await emit("feed-ready", { date: status.date, feeds: status.ready });
}

/** Starts watching; returns a stop function. */
export function watchDailyFeed(): () => void {
  void check().catch(() => {});
  const t = window.setInterval(() => void check().catch(() => {}), CHECK_MS);
  return () => window.clearInterval(t);
}
