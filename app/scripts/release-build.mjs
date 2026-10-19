// Builds the signed Windows release and everything the in-app updater needs, into app/release/ (not committed):
//   My-Assistant-<v>-windows-setup.exe (+ .sig), My-Assistant-<v>-windows.msi, latest.json, SHA256SUMS.txt
// Upload all of them to the GitHub release v<v>: the app checks releases/latest/download/latest.json.
//
// Usage (from app/):  npm run release -- "What's new in this version (shown in the update prompt)"
// The updater signing key is read from TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD), or else from
// %USERPROFILE%\.android-keys\my-assistant-updater.key and .password.txt. Never commit the key; keep a copy in the
// password manager: without it, installed apps can't be updated any more.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "chrisred66/My-Assistant";
const app = join(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8")).version;
const notes = process.argv.slice(2).join(" ").trim() || `My Assistant ${version}`;

const keyDir = join(homedir(), ".android-keys");
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = join(keyDir, "my-assistant-updater.key");
  if (!existsSync(keyFile)) throw new Error(`No updater key: set TAURI_SIGNING_PRIVATE_KEY or put it at ${keyFile}`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= readFileSync(join(keyDir, "my-assistant-updater.password.txt"), "utf8").trim();
}

console.log(`Building My Assistant ${version}…`);
execSync("npx tauri build", { cwd: app, env, stdio: "inherit" });

const bundle = join(app, "src-tauri", "target", "release", "bundle");
const find = (dir, re) => {
  const hit = readdirSync(join(bundle, dir)).find((f) => re.test(f) && f.includes(`_${version}_`));
  if (!hit) throw new Error(`No ${re} for ${version} in ${dir}`);
  return join(bundle, dir, hit);
};
const setup = find("nsis", /-setup\.exe$/);
const msi = find("msi", /\.msi$/);

const out = join(app, "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const setupName = `My-Assistant-${version}-windows-setup.exe`;
const files = {
  [setupName]: setup,
  [`${setupName}.sig`]: `${setup}.sig`,
  [`My-Assistant-${version}-windows.msi`]: msi,
};
for (const [name, from] of Object.entries(files)) copyFileSync(from, join(out, name));

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(`${setup}.sig`, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${setupName}`,
    },
  },
};
writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

const sums = readdirSync(out)
  .filter((f) => !f.endsWith(".txt"))
  .map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`);
writeFileSync(join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n");

console.log(`\nRelease files in ${out}:\n  ${readdirSync(out).join("\n  ")}`);
console.log(`Add the Android APK, then: gh release create v${version} app/release/* --title "My Assistant ${version}" --notes-file …`);
