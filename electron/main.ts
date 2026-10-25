// Copyright (c) 2026 nDimensions.AI and CharanTheAiGuy
// SPDX-License-Identifier: MIT
import { app, dialog, globalShortcut, Menu, type Tray } from "electron";
import { installCrashGuards } from "./crash-guards";
import { dockIcon } from "./icons";
import { createLogger } from "./logger";
import { createTray } from "./tray";
import {
  launchWebinar,
  registerWebinarProtocol,
  shutdownWebinar,
  webinarShortcut,
} from "./webinar/host";

const log = createLogger("Main");
// Keep the package identity stable so existing local projects remain available.
if (process.env.WEBINAR_DATA_DIR)
  app.setPath("userData", process.env.WEBINAR_DATA_DIR);
let quitting = false;
let quitReady = false;
let tray: Tray | undefined;
function openWorkspace() {
  if (quitting) return;
  void launchWebinar().catch((error) => {
    log.error("Workspace failed to open:", error);
    dialog.showErrorBox(
      "Unable to open Script Recorder",
      "Restart the application. Your saved projects remain on this computer.",
    );
  });
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerWebinarProtocol();
  installCrashGuards(log);
  app.on("second-instance", () => {
    void app.whenReady().then(openWorkspace);
  });
  void app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(null);
      const icon = dockIcon();
      if (icon) app.dock?.setIcon(icon);
      try {
        tray = createTray(openWorkspace);
      } catch (error) {
        log.warn("Tray unavailable:", error);
      }
      if (
        !globalShortcut.register("CommandOrControl+Shift+R", () => {
          void webinarShortcut().catch((error) =>
            log.warn("Recording shortcut failed:", error),
          );
        })
      )
        log.warn("Recording shortcut is already in use.");
      openWorkspace();
    })
    .catch((error) => {
      log.error("Startup failed:", error);
      app.quit();
    });
  app.on("activate", openWorkspace);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdownWebinar()
      .catch((error) => log.warn("Shutdown failed:", error))
      .finally(() => {
        quitReady = true;
        app.quit();
      });
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    tray?.destroy();
  });
}
