import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebinarStore } from "./store";
import { WebinarEngine } from "./engine";
import { uid, DomainError } from "./core";
const port = (process as any).parentPort;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const store = new WebinarStore(
  process.argv[2],
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "webinar",
    "migrations",
  ),
);
const host = (method: string, payload: any) =>
  new Promise<any>((resolve, reject) => {
    const id = uid();
    pending.set(id, { resolve, reject });
    port.postMessage({ kind: "host", id, method, payload });
  });
const engine = new WebinarEngine(store, host, () =>
  port.postMessage({ kind: "changed" }),
);
port.on("message", async (event: any) => {
  const p = event.data;
  if (p.kind === "host-result") {
    const call = pending.get(p.id);
    if (call) {
      pending.delete(p.id);
      p.ok ? call.resolve(p.value) : call.reject(new Error(p.error));
    }
    return;
  }
  try {
    const value =
      p.method === "evidence.derive"
        ? await engine.derive(
            p.payload.projectId,
            p.payload.evidenceId,
            p.payload.plan,
          )
        : await engine.handle(p.method, p.payload);
    port.postMessage({ kind: "result", id: p.id, ok: true, value });
  } catch (e) {
    port.postMessage({
      kind: "result",
      id: p.id,
      ok: false,
      code: e instanceof DomainError ? e.code : "VALIDATION",
      error:
        e instanceof DomainError
          ? e.message
          : "The operation could not be completed. Check the input and retry.",
    });
  }
});
port.postMessage({ kind: "ready" });
void engine.recoverLocalJobs();
