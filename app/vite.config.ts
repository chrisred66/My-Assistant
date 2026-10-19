import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
const host = process.env.TAURI_DEV_HOST;

/** The newest release version on GitHub ("0.4.1"), from the repo's v* tags; local tags if GitHub can't be reached. */
function latestRelease(): string | null {
  const versions = (out: string) =>
    [...out.matchAll(/v(\d+)\.(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  let found: (readonly [number, number, number])[] = [];
  for (const cmd of ['git ls-remote --tags --refs origin "v*"', 'git tag --list "v*"']) {
    try {
      found = versions(execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      found = [];
    }
    if (found.length) break;
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const top = found.at(-1);
  return top ? top.join(".") : null;
}

/**
 * The version shown next to the app's name. A build shows its own version, which is the GitHub release it's published
 * as ("ver. 0.4.2"). The dev version shows the version its changes will be released as, the newest release plus one
 * ("dev. ver. 0.4.3").
 */
function appVersion(command: "serve" | "build"): string {
  const own = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")).version as string;
  if (command === "build") return own;
  const latest = latestRelease();
  if (!latest) return own;
  const [major, minor, patch] = latest.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion(command)),
  },

  // Pre-bundle every Tauri module the app uses. Otherwise the first import of a new one makes the dev server
  // re-bundle while windows are open, and a window can end up with mixed old/new code (blank screen until reloaded).
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-http",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-store",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
