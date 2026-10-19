// The update prompt, bottom right of the main window (see lib/updates.ts): "a new version is available" (automatic
// updates off, or the phone app), its download progress, then "restart to finish".
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../lib/i18n";
import { isDesktop } from "../lib/platform";
import { dismissUpdate, RELEASES_URL, restartToUpdate, updateNow, useUpdates } from "../lib/updates";

export default function UpdateBanner() {
  const u = useUpdates();
  const shown = ["available", "downloading", "ready", "installing"].includes(u.phase) || (u.phase === "error" && u.version);
  if (!shown || u.dismissed) return null;

  return (
    <div className="update-banner card" role="status">
      {u.phase === "available" && (
        <>
          <strong>{t("Version {version} is available", { version: u.version ?? "" })}</strong>
          {u.notes && <p className="muted small update-notes">{u.notes}</p>}
          <div className="row wrap">
            {isDesktop ? (
              <button className="primary" onClick={() => void updateNow()}>
                {t("Update and restart")}
              </button>
            ) : (
              <button className="primary" onClick={() => void openUrl(RELEASES_URL).catch(() => window.open(RELEASES_URL, "_blank"))}>
                {t("Download")}
              </button>
            )}
            <button onClick={dismissUpdate}>{t("Later")}</button>
          </div>
        </>
      )}
      {u.phase === "downloading" && (
        <>
          <strong>{t("Downloading version {version}…", { version: u.version ?? "" })}</strong>
          <progress max={1} value={u.progress} />
        </>
      )}
      {u.phase === "ready" && (
        <>
          <strong>{t("Version {version} is ready", { version: u.version ?? "" })}</strong>
          <p className="muted small">{t("Restart My Assistant to finish updating. Anything you're recording should be stopped first.")}</p>
          <div className="row wrap">
            <button className="primary" onClick={() => void restartToUpdate()}>
              {t("Restart now")}
            </button>
            <button onClick={dismissUpdate}>{t("Later")}</button>
          </div>
        </>
      )}
      {u.phase === "installing" && <strong>{t("Installing the update…")}</strong>}
      {u.phase === "error" && (
        <>
          <strong>{t("The update couldn't be installed")}</strong>
          <p className="error-text small">{u.error}</p>
          <button onClick={dismissUpdate}>{t("Close")}</button>
        </>
      )}
    </div>
  );
}
