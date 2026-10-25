const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("webinar", {
  invoke: (method, payload) =>
    ipcRenderer.invoke("webinar:command", { method, payload }),
  onChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("webinar:changed", handler);
    return () => ipcRenderer.removeListener("webinar:changed", handler);
  },
});
