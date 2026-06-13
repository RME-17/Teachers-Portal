/**
 * Silent background updates for the packaged NSIS installer (not portable .exe).
 * Publishes via electron-builder → GitHub Releases (see package.json "build.publish").
 */
const { app, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

function isPortableWindowsBuild() {
  return (
    process.platform === "win32" &&
    typeof process.env.PORTABLE_EXECUTABLE_DIR === "string" &&
    process.env.PORTABLE_EXECUTABLE_DIR.length > 0
  );
}

function isAutoUpdateEnabled() {
  if (!app.isPackaged) {
    return false;
  }
  if (process.env.RME_DISABLE_AUTO_UPDATE === "1") {
    return false;
  }
  if (isPortableWindowsBuild()) {
    return false;
  }
  return true;
}

/**
 * @param {() => import("electron").BrowserWindow | null} getMainWindow
 */
function initAutoUpdate(getMainWindow) {
  if (!isAutoUpdateEnabled()) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("error", (err) => {
    console.warn("[auto-update]", err instanceof Error ? err.message : err);
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version =
      info && typeof info.version === "string" ? info.version : "";
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("app-update:downloaded", { version });
    }
    dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: version
          ? `Recruit My English ${version} has been downloaded.`
          : "A new version has been downloaded.",
        detail:
          "The update will install when you close the app. You can also restart now to apply it immediately.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      })
      .catch(() => {
        /* ignore */
      });
  });

  const runCheck = () => {
    void autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.warn(
        "[auto-update] check failed:",
        e instanceof Error ? e.message : e,
      );
    });
  };

  setTimeout(runCheck, 12_000);
  setInterval(runCheck, 5 * 60 * 1000);
}

/**
 * @param {import("electron").IpcMain} ipcMain
 */
function registerAutoUpdateIpc(ipcMain) {
  ipcMain.handle("app-update:status", () => ({
    enabled: isAutoUpdateEnabled(),
    portable: isPortableWindowsBuild(),
    version: app.getVersion(),
  }));

  ipcMain.handle("app-update:check", async () => {
    if (!isAutoUpdateEnabled()) {
      return {
        ok: false,
        code: "DISABLED",
        message:
          "Automatic updates work only in the installed app (NSIS setup), not in dev or the portable .exe.",
      };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      const ver = result?.updateInfo?.version;
      return {
        ok: true,
        version: typeof ver === "string" ? ver : null,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });

  ipcMain.handle("app-update:quit-and-install", () => {
    if (!isAutoUpdateEnabled()) {
      return { ok: false };
    }
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

module.exports = {
  initAutoUpdate,
  registerAutoUpdateIpc,
  isAutoUpdateEnabled,
};
