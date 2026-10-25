import { Menu, Tray, nativeImage } from "electron";
import { trayIcon } from "./icons";

export function createTray(openWorkspace: () => void): Tray {
  const fallback = nativeImage.createFromBitmap(
    Buffer.from([42, 54, 237, 255]),
    { width: 1, height: 1 },
  );
  const tray = new Tray(
    trayIcon() ?? fallback.resize({ width: 16, height: 16 }),
  );
  tray.setToolTip("nDimensions.AI Script Recorder");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open webinar workspace", click: openWorkspace },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]),
  );
  tray.on("double-click", openWorkspace);
  return tray;
}
