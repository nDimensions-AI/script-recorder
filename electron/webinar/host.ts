import {
  WEBINAR_AI,
  webinarProviderSettings,
  verifiedProvider,
  type ProviderVerification,
} from "../../common/webinar/provider-profile";
import { connectProviderSchema, verifyProviderConnection } from "./provider";
import { inspectText } from "./ocr";
import {
  app,
  BrowserWindow,
  ipcMain,
  utilityProcess,
  desktopCapturer,
  dialog,
  safeStorage,
  session,
  protocol,
  powerMonitor,
  screen,
  shell,
} from "electron";
import type { UtilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  defaultCaptureProfile,
  captureProfileSchema,
  type ProviderSettings,
} from "../../common/webinar/schema";
import { atomicFile } from "./core";
import { assetResponse } from "./media";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// Bundled main and worker entries live together in dist-electron.
const staticDir = () => path.join(dirname, "webinar");
let worker: UtilityProcess | null = null,
  compute: UtilityProcess | null = null,
  window: BrowserWindow | null = null,
  capture: BrowserWindow | null = null;
let ready: Promise<void>,
  readyResolve: () => void,
  readyReject: (e: Error) => void;
const pending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let active: {
  projectId: string;
  recordingId: string;
  origin: bigint;
  state: string;
  lastHealth: number;
} | null = null;
let controlTail: Promise<any> = Promise.resolve(),
  asrTail: Promise<any> = Promise.resolve();
const mediaPending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const capabilities = new Map<
  string,
  { projectId: string; assetId: string; expires: number }
>();
const sourceTokens = new Map<string, string>();
let capturePort: Electron.MessagePortMain | null = null;
const segmentTracks = new Map<string, string>();
let localProgress: string | null = null;
let processingCount = 0;
let computeJobId: string | null = null;
const cancelledComputeJobs = new Set<string>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
const root = () => path.join(app.getPath("userData"), "webinar");
const clock = () =>
  active ? Number((process.hrtime.bigint() - active.origin) / 1000n) : 0;
const publicMethods = new Set([
  "evidence.inspectText",
  "billing.list",
  "billing.reconcile",
  "draft.get",
  "draft.save",
  "draft.clear",
  "source.probe",
  "jobs.scenes",
  "take.select",
  "project.budget",
  "revision.get",
  "source.timeline",
  "project.create",
  "project.list",
  "project.snapshot",
  "project.dependency",
  "project.update",
  "presenters.save",
  "transcript.correct",
  "script.manual",
  "script.save",
  "script.merge",
  "script.approve",
  "review.resolve",
  "manifest.approve",
  "manifest.revoke",
  "jobs.cancel",
  "jobs.retry",
  "project.delete",
  "evidence.derive",
  "evidence.prepare",
  "jobs.generate",
  "jobs.transcribe",
  "jobs.export",
  "job.output",
]);
export function registerWebinarProtocol() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "webinar-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}
export function rpc(method: string, payload: any): Promise<any> {
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Background operation timed out."));
          }, 180000);
        pending.set(id, { resolve, reject, timer });
        worker!.postMessage({ kind: "call", id, method, payload });
      }),
  );
}
function changed() {
  if (window && !window.isDestroyed())
    window.webContents.send("webinar:changed");
}
function validSender(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Forbidden application window.");
}
function providerFile() {
  return path.join(root(), "provider.json");
}
function provider(): {
  settings: ProviderSettings;
  key: string;
  verification?: ProviderVerification;
} | null {
  if (!existsSync(providerFile())) return null;
  const saved = JSON.parse(readFileSync(providerFile(), "utf8"));
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Windows credential protection is unavailable.");
  return {
    settings: webinarProviderSettings(),
    key: safeStorage.decryptString(Buffer.from(saved.secret, "base64")),
    verification: saved.verification,
  };
}
function secureWindow(preload: string) {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      preload,
      partition: "webinar",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  return win;
}
async function decode(payload: {
  filename: string;
  track: string;
  samples: boolean;
  frameAtUs?: number;
}): Promise<any> {
  if (statSync(payload.filename).size > 128 * 1024 ** 2)
    throw new Error(
      "Legacy or oversized media cannot use the bounded decoder.",
    );
  const win = secureWindow(path.join(staticDir(), "decoder-preload.cjs")),
    id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Media decode timed out.")),
      15000,
    );
    const onReady = (e: Electron.IpcMainEvent) => {
      if (e.sender === win.webContents)
        win.webContents.send("webinar:decode", {
          id,
          track: payload.track,
          samples: payload.samples,
          frameAtUs: payload.frameAtUs,
          bytes: readFileSync(payload.filename),
        });
    };
    const onResult = (e: Electron.IpcMainEvent, r: any) => {
      if (e.sender === win.webContents && r.id === id)
        r.ok ? finish(null, r.value) : finish(new Error(r.error));
    };
    const finish = (error: Error | null, value?: any) => {
      clearTimeout(timeout);
      ipcMain.removeListener("webinar:decoder-ready", onReady);
      ipcMain.removeListener("webinar:decoded", onResult);
      if (!win.isDestroyed()) win.destroy();
      error ? reject(error) : resolve(value);
    };
    ipcMain.on("webinar:decoder-ready", onReady);
    ipcMain.on("webinar:decoded", onResult);
    win.webContents.once("render-process-gone", () =>
      finish(new Error("Media decoder stopped.")),
    );
    void win
      .loadFile(path.join(staticDir(), "capture.html"))
      .catch((e) => finish(e));
  });
}
function transcribe(payload: {
  filename: string;
  allowDownload: boolean;
  jobId: string;
}): Promise<any> {
  processingCount++;
  const task = asrTail.then(async () => {
    if (cancelledComputeJobs.has(payload.jobId))
      throw new Error("Transcription cancelled.");
    computeJobId = payload.jobId;
    const audio = await decode({
      ...payload,
      track: "microphone",
      samples: true,
    });
    if (!compute)
      compute = utilityProcess.fork(
        path.join(dirname, "webinar-compute.js"),
        [],
        { stdio: "pipe", serviceName: "Webinar local transcription" },
      );
    const proc = compute,
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          cleanup();
          proc.kill();
          compute = null;
          reject(new Error("Local transcription timed out."));
        },
        (payload.allowDownload ? 30 : 10) * 60000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        proc.removeListener("message", onMessage);
        proc.removeListener("exit", onExit);
      };
      const onMessage = (p: any) => {
        if (p.id !== id) return;
        if (p.kind === "progress") {
          localProgress =
            p.status === "done"
              ? "Speech model file verified."
              : `Downloading speech model: ${Math.round((p.loaded / p.total) * 100)}% of current file`;
          return;
        }
        cleanup();
        p.ok ? resolve(p.value) : reject(new Error(p.error));
      };
      const onExit = () => {
        cleanup();
        compute = null;
        reject(new Error("Local transcription process stopped."));
      };
      proc.on("message", onMessage);
      proc.once("exit", onExit);
      proc.postMessage({
        id,
        method: "transcribe",
        samples: audio.samples,
        cacheDir: path.join(app.getPath("userData"), "models"),
        allowDownload: payload.allowDownload,
      });
    });
  });
  asrTail = task.catch(() => {});
  return task.finally(() => {
    processingCount--;
    localProgress = null;
    if (computeJobId === payload.jobId) computeJobId = null;
  });
}
async function hostCall(method: string, payload: any) {
  if (method === "cancelTranscription") {
    cancelledComputeJobs.add(payload.jobId);
    if (computeJobId === payload.jobId) compute?.kill();
    return {};
  }
  if (method === "ocr") return inspectText(payload.filename);
  if (method === "decode") return decode(payload);
  if (method === "transcribe") return transcribe(payload);
  throw new Error("Unsupported host operation.");
}
async function control(method: string, payload: any = {}) {
  if (!capture || capture.isDestroyed())
    throw new Error("Capture is unavailable.");
  const id = randomUUID();
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      mediaPending.delete(id);
      reject(new Error("Capture control timed out."));
    }, 20000);
    mediaPending.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });
    capture!.webContents.send("webinar:capture-control", {
      id,
      method,
      payload,
    });
  });
}
async function captureCommand(method: string, p: any) {
  if (method === "start") {
    if (active) throw new Error("Stop the active recording first.");
    if (processingCount || (await rpc("jobs.busy", {})).busy)
      throw new Error("Finish or cancel local processing before recording.");
    const sourceId = sourceTokens.get(p.sourceToken);
    if (!sourceId) throw new Error("Select a current display.");
    const profile = captureProfileSchema.parse(
        p.profile ?? defaultCaptureProfile,
      ),
      result = await rpc("capture.start", {
        projectId: p.projectId,
        payload: { profile },
      });
    active = {
      projectId: p.projectId,
      recordingId: result.recordingId,
      origin: process.hrtime.bigint(),
      state: "Preflight",
      lastHealth: Date.now(),
    };
    try {
      capture = secureWindow(path.join(staticDir(), "capture-preload.cjs"));
      await new Promise<void>((resolve, reject) => {
        const win = capture!;
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          ipcMain.removeListener("webinar:capture-ready", listener);
          error ? reject(error) : resolve();
        };
        const listener = (e: Electron.IpcMainEvent) => {
          if (
            e.sender === win.webContents &&
            e.senderFrame === win.webContents.mainFrame
          )
            finish();
        };
        const timeout = setTimeout(
          () => finish(new Error("Capture initialization timed out.")),
          10000,
        );
        ipcMain.on("webinar:capture-ready", listener);
        void win.loadFile(path.join(staticDir(), "capture.html")).catch(finish);
      });
      await control("start", {
        profile,
        recordingId: active.recordingId,
        atUs: clock(),
        sourceId,
        microphoneId: p.microphoneId,
        synthetic:
          !app.isPackaged && process.env.WEBINAR_SYNTHETIC_CAPTURE === "1",
      });
      await rpc("capture.state", {
        projectId: active.projectId,
        payload: {
          recordingId: active.recordingId,
          state: "Recording",
          atUs: clock(),
        },
      });
      active.state = "Recording";
    } catch (e) {
      await failCapture(e instanceof Error ? e.message : "Capture failed");
      throw e;
    }
  } else {
    if (!active) throw new Error("No active recording.");
    const a = active;
    if (method === "pause") {
      const paused = await control("pause");
      await rpc("capture.state", {
        projectId: a.projectId,
        payload: {
          recordingId: a.recordingId,
          state: "Paused",
          atUs: paused.atUs,
        },
      });
      a.state = "Paused";
    } else if (method === "resume") {
      await rpc("capture.state", {
        projectId: a.projectId,
        payload: {
          recordingId: a.recordingId,
          state: "Recording",
          atUs: clock(),
        },
      });
      try {
        await control("resume", { atUs: clock() });
        a.state = "Recording";
        a.lastHealth = Date.now();
      } catch (e) {
        try {
          await control("pause");
        } catch {}
        await rpc("capture.state", {
          projectId: a.projectId,
          payload: {
            recordingId: a.recordingId,
            state: "Paused",
            atUs: clock(),
            reason: "Original capture device could not be reacquired.",
          },
        });
        a.state = "Paused";
        throw e;
      }
    } else if (method === "marker") {
      const result = await control("marker");
      await rpc("capture.marker", {
        projectId: a.projectId,
        payload: {
          recordingId: a.recordingId,
          atUs: result.atUs,
          label: String(p.label ?? "Important moment").slice(0, 200),
          kind: "moment",
        },
      });
    } else if (method === "stop") {
      await rpc("capture.state", {
        projectId: a.projectId,
        payload: {
          recordingId: a.recordingId,
          state: "Finalizing",
          atUs: clock(),
        },
      });
      a.state = "Finalizing";
      try {
        const stopped = await control("stop");
        await rpc("capture.state", {
          projectId: a.projectId,
          payload: {
            recordingId: a.recordingId,
            state: "Captured",
            atUs: stopped.atUs,
          },
        });
      } catch (e) {
        await rpc("capture.state", {
          projectId: a.projectId,
          payload: {
            recordingId: a.recordingId,
            state: "Incomplete",
            atUs: clock(),
            reason: "Finalization failed",
          },
        });
        throw e;
      } finally {
        capture?.destroy();
        capture = null;
        active = null;
      }
    } else throw new Error("Unknown recording control.");
  }
  changed();
  return captureStatus();
}
function captureStatus() {
  return active
    ? {
        projectId: active.projectId,
        recordingId: active.recordingId,
        state: active.state,
        atUs: clock(),
      }
    : { state: "Idle" };
}
async function failCapture(message: string) {
  const a = active;
  if (!a) return;
  try {
    await rpc("capture.state", {
      projectId: a.projectId,
      payload: {
        recordingId: a.recordingId,
        state: "Incomplete",
        atUs: clock(),
        reason: message,
      },
    });
    await rpc("capture.abandon", { projectId: a.projectId, payload: {} });
  } finally {
    capture?.destroy();
    capture = null;
    active = null;
    changed();
  }
}

export async function launchWebinar(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return window;
  }
  if (!worker) {
    mkdirSync(root(), { recursive: true });
    ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    worker = utilityProcess.fork(
      path.join(dirname, "webinar-worker.js"),
      [root()],
      { stdio: "pipe", serviceName: "Webinar project store" },
    );
    worker.on("message", (p: any) => {
      if (p.kind === "ready") {
        readyResolve();
        return;
      }
      if (p.kind === "changed") {
        changed();
        return;
      }
      if (p.kind === "host") {
        void hostCall(p.method, p.payload).then(
          (value) =>
            worker?.postMessage({
              kind: "host-result",
              id: p.id,
              ok: true,
              value,
            }),
          (error) =>
            worker?.postMessage({
              kind: "host-result",
              id: p.id,
              ok: false,
              error: error.message,
            }),
        );
        return;
      }
      const call = pending.get(p.id);
      if (call) {
        pending.delete(p.id);
        clearTimeout(call.timer);
        p.ok
          ? call.resolve(p.value)
          : call.reject(Object.assign(new Error(p.error), { code: p.code }));
      }
    });
    worker.on("exit", () => {
      const error = new Error(
        "Project storage process stopped. Restart the application.",
      );
      readyReject(error);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      changed();
    });
    const ses = session.fromPartition("webinar");
    ses.setPermissionRequestHandler((wc, permission, callback) =>
      callback(
        permission === "media" &&
          (wc === capture?.webContents || wc === window?.webContents),
      ),
    );
    ses.setPermissionCheckHandler(
      (wc, permission) =>
        permission === "media" &&
        (wc === capture?.webContents || wc === window?.webContents),
    );
    ses.protocol.handle("webinar-asset", async (request) => {
      const token = new URL(request.url).hostname,
        cap = capabilities.get(token);
      if (
        !cap ||
        cap.expires < Date.now() ||
        !["GET", "HEAD"].includes(request.method)
      )
        return new Response("Unavailable", { status: 403 });
      try {
        const { filename, asset } = await rpc("asset.path", {
          projectId: cap.projectId,
          assetId: cap.assetId,
        });
        return assetResponse(
          filename,
          asset.mime,
          asset.byte_length,
          request.method,
          request.headers.get("range"),
          process.env.VITE_DEV_SERVER_URL
            ? new URL(process.env.VITE_DEV_SERVER_URL).origin
            : "null",
        );
      } catch {
        return new Response("Unavailable", { status: 404 });
      }
    });
    ipcMain.on("webinar:capture-port", (event) => {
      if (
        event.sender !== capture?.webContents ||
        event.senderFrame !== capture.webContents.mainFrame ||
        !active ||
        event.ports.length !== 1
      ) {
        for (const port of event.ports) port.close();
        return;
      }
      capturePort?.close();
      segmentTracks.clear();
      const port = event.ports[0],
        owner = capture,
        recordingId = active.recordingId,
        projectId = active.projectId,
        credits = new Map<string, number>();
      capturePort = port;
      port.on("message", async (event) => {
        const request = event.data;
        let track: string | undefined,
          credit = 0;
        try {
          if (
            capture !== owner ||
            active?.recordingId !== recordingId ||
            capturePort !== port
          )
            throw new Error("Capture epoch is no longer active.");
          if (
            typeof request?.id !== "string" ||
            request.id.length > 64 ||
            !(request.payload?.bytes instanceof Uint8Array) ||
            request.payload.bytes.length > 1024 ** 2
          )
            throw new Error("Invalid capture fragment.");
          track = segmentTracks.get(request.payload.segmentId);
          if (!track) throw new Error("Capture segment is not open.");
          credit = request.payload.bytes.length;
          const outstanding = credits.get(track) ?? 0;
          if (outstanding + credit > 16 * 1024 ** 2) {
            credit = 0;
            throw new Error("Capture credit exceeded.");
          }
          credits.set(track, outstanding + credit);
          const value = await rpc("capture.chunk", {
            projectId,
            payload: request.payload,
          });
          if (capturePort === port)
            port.postMessage({ id: request.id, ok: true, value });
        } catch (error) {
          try {
            port.postMessage({
              id: request?.id,
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Capture write failed.",
            });
          } catch {}
        } finally {
          if (track && credit)
            credits.set(track, Math.max(0, (credits.get(track) ?? 0) - credit));
        }
      });
      port.on("close", () => {
        if (capturePort === port) {
          capturePort = null;
          if (
            capture === owner &&
            active?.recordingId === recordingId &&
            active.state === "Recording"
          )
            void failCapture("Capture writer channel closed unexpectedly.");
        }
      });
      port.start();
    });
    ipcMain.handle("webinar:capture-data", async (e, { method, payload }) => {
      if (
        e.sender !== capture?.webContents ||
        e.senderFrame !== capture.webContents.mainFrame ||
        !active
      )
        throw new Error("Forbidden capture sender");
      if (method === "clock") return { atUs: clock() };
      if (!["open", "seal", "frame"].includes(method))
        throw new Error("Unknown capture method");
      const value = await rpc("capture." + method, {
        projectId: active.projectId,
        payload,
      });
      if (method === "open")
        segmentTracks.set(payload.segmentId, payload.track);
      if (method === "seal") segmentTracks.delete(payload.segmentId);
      return value;
    });
    ipcMain.on("webinar:capture-result", (e, p) => {
      if (e.sender !== capture?.webContents) return;
      const call = mediaPending.get(p.id);
      if (call) {
        mediaPending.delete(p.id);
        p.ok ? call.resolve(p.value) : call.reject(new Error(p.error));
      }
    });
    ipcMain.on("webinar:capture-health", (e) => {
      if (e.sender === capture?.webContents && active)
        active.lastHealth = Date.now();
    });
    ipcMain.on("webinar:capture-fault", (e, message) => {
      if (e.sender === capture?.webContents)
        void failCapture(String(message).slice(0, 200));
    });
    healthTimer = setInterval(() => {
      if (
        active?.state === "Recording" &&
        Date.now() - active.lastHealth > 5000
      )
        void failCapture("Capture heartbeat was lost.");
    }, 1000);
    powerMonitor.on("suspend", () => {
      if (active) void failCapture("Computer suspended during capture.");
    });
    powerMonitor.on("lock-screen", () => {
      if (active) void failCapture("Computer locked during capture.");
    });
    screen.on("display-removed", () => {
      if (active)
        void failCapture(
          "A display was removed. Re-select the original screen before recording again.",
        );
    });
    ipcMain.handle("webinar:command", async (e, { method, payload }) => {
      try {
        validSender(e);
        if (
          typeof method !== "string" ||
          Buffer.byteLength(JSON.stringify(payload ?? {})) >
            (["script.save", "script.merge", "draft.save"].includes(method)
              ? 5
              : 1) *
              1024 ** 2
        )
          throw new Error("Invalid request size.");
        let value: any;
        if (method === "provider.status") {
          const p = provider();
          value = {
            configured: !!p && verifiedProvider(p.verification),
            keySaved: !!p,
            displayName: WEBINAR_AI.displayName,
            modelId: WEBINAR_AI.modelId,
            checkedAt: p?.verification?.checkedAt,
          };
        } else if (method === "provider.openKeyPage") {
          await shell.openExternal(WEBINAR_AI.keyPage);
          value = { opened: true };
        } else if (method === "provider.configure") {
          const parsed = connectProviderSchema.safeParse(payload);
          if (!parsed.success)
            throw new Error(
              "Enter a valid Google AI Studio API key. The app manages the model and pricing.",
            );
          if (!safeStorage.isEncryptionAvailable())
            throw new Error("Windows credential protection is unavailable.");
          const key = parsed.data.key ?? provider()?.key;
          if (!key)
            throw new Error("Paste your Google AI Studio API key to connect.");
          const verification = await verifyProviderConnection(key, undefined, {
            checkEvidence: false,
          });
          atomicFile(
            providerFile(),
            Buffer.from(
              JSON.stringify({
                schemaVersion: 2,
                secret: safeStorage.encryptString(key).toString("base64"),
                verification,
              }),
            ),
          );
          value = {
            configured: true,
            displayName: WEBINAR_AI.displayName,
            checkedAt: verification.checkedAt,
          };
        } else if (method === "sources.list") {
          sourceTokens.clear();
          value = (
            !app.isPackaged && process.env.WEBINAR_SYNTHETIC_CAPTURE === "1"
              ? [
                  {
                    id: "synthetic",
                    name: "Synthetic test pattern",
                    thumbnail: { toDataURL: () => "" },
                  },
                ]
              : await desktopCapturer.getSources({
                  types: ["screen"],
                  thumbnailSize: { width: 320, height: 180 },
                })
          ).map((s) => {
            const token = randomUUID();
            sourceTokens.set(token, s.id);
            return { token, name: s.name, thumbnail: s.thumbnail.toDataURL() };
          });
        } else if (method === "capture.status")
          value = { ...captureStatus(), localProgress };
        else if (method.startsWith("record.")) {
          const work = controlTail.then(() =>
            captureCommand(method.slice(7), payload),
          );
          controlTail = work.catch(() => {});
          value = await work;
        } else if (method === "asset.url") {
          const { asset } = await rpc("asset.path", payload),
            token = randomUUID();
          capabilities.set(token, {
            projectId: payload.projectId,
            assetId: asset.id,
            expires: Date.now() + 3600000,
          });
          value = { url: `webinar-asset://${token}/asset` };
        } else if (method === "export.download") {
          const asset = await rpc("export.publish", payload);
          const picked = await dialog.showSaveDialog(window!, {
            defaultPath: "Webinar-Script.docx",
            filters: [{ name: "Word document", extensions: ["docx"] }],
          });
          if (picked.canceled || !picked.filePath) value = { cancelled: true };
          else {
            await rpc("export.destination", {
              ...payload,
              destination: picked.filePath,
            });
            await rpc("export.publish", payload);
            atomicFile(picked.filePath, readFileSync(asset.filename));
            await rpc("export.published", {
              ...payload,
              destination: picked.filePath,
            });
            value = { saved: true };
          }
        } else if (
          method === "project.restore" ||
          method === "project.importLegacy"
        ) {
          if (active)
            throw new Error("Finish recording before importing a project.");
          const picked = await dialog.showOpenDialog(window!, {
            title:
              method === "project.restore"
                ? "Select a webinar backup folder"
                : "Select a legacy session folder",
            properties: ["openDirectory"],
          });
          value = picked.canceled
            ? { cancelled: true }
            : await rpc(method, { source: picked.filePaths[0] });
        } else if (method === "project.backup") {
          const picked = await dialog.showOpenDialog(window!, {
            properties: ["openDirectory", "createDirectory"],
          });
          value = picked.canceled
            ? { cancelled: true }
            : await rpc(method, {
                ...payload,
                destination: path.join(
                  picked.filePaths[0],
                  "webinar-backup-" + randomUUID(),
                ),
              });
        } else if (publicMethods.has(method)) {
          if (
            active &&
            [
              "jobs.generate",
              "jobs.transcribe",
              "jobs.scenes",
              "evidence.inspectText",
            ].includes(method)
          )
            throw new Error(
              "Finish recording before starting background processing.",
            );
          if (
            method === "project.delete" &&
            active?.projectId === payload.projectId
          )
            throw new Error("Stop recording before deleting this project.");
          if (method === "jobs.generate" || method === "evidence.prepare") {
            const p = provider();
            if (!p || !verifiedProvider(p.verification))
              throw new Error(
                "Connect your Gemini account from Connect AI before generating a script.",
              );
            payload = {
              ...payload,
              profile: p.settings,
              ...(method === "jobs.generate" ? { key: p.key } : {}),
            };
          }
          value = await rpc(method, payload);
        } else throw new Error("Unknown application operation.");
        if (
          ![
            "project.list",
            "project.snapshot",
            "project.dependency",
            "provider.status",
            "capture.status",
            "asset.url",
            "job.output",
            "draft.get",
            "draft.save",
            "draft.clear",
            "source.probe",
            "jobs.scenes",
            "take.select",
            "project.budget",
            "revision.get",
            "source.timeline",
          ].includes(method)
        )
          changed();
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          code: (error as any).code ?? "VALIDATION",
          error: error instanceof Error ? error.message : "Operation failed",
        };
      }
    });
  }
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 720,
    title: "nDimensions.AI Webinar Script Recorder",
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: path.join(staticDir(), "preload.cjs"),
      partition: "webinar",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.on("closed", () => {
    window = null;
    capabilities.clear();
  });
  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL + "#webinar");
  else
    await window.loadFile(path.join(dirname, "..", "dist", "index.html"), {
      hash: "webinar",
    });
  return window;
}
export async function shutdownWebinar() {
  if (active) {
    try {
      await captureCommand("stop", {});
    } catch {
      await failCapture("Application quit during capture.");
    }
  }
  if (healthTimer) clearInterval(healthTimer);
  compute?.kill();
  worker?.kill();
}
export async function webinarShortcut() {
  if (active) {
    const work = controlTail.then(() => captureCommand("stop", {}));
    controlTail = work.catch(() => {});
    return work;
  }
  await launchWebinar();
}
