import { parentPort } from "node:worker_threads";
import { ensureModel } from "./model";
// Works in Electron utilityProcess and Node worker_threads during qualification.
const port: any = (process as any).parentPort ?? parentPort;
let pipe: any;
port.on("message", async (event: any) => {
  const p = event.data ?? event;
  try {
    if (p.method !== "transcribe")
      throw new Error("Unknown processing operation");
    if (!(p.samples instanceof Float32Array) || p.samples.length > 16000 * 45)
      throw new Error("ASR window exceeds 45 seconds");
    if (!pipe) {
      const local = await ensureModel(p.cacheDir, p.allowDownload, (progress) =>
        port.postMessage({ id: p.id, kind: "progress", ...progress }),
      );
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = p.cacheDir;
      tf.env.allowRemoteModels = false;
      pipe = await tf.pipeline("automatic-speech-recognition", local, {
        dtype: "q8",
        local_files_only: true,
        session_options: { enableCpuMemArena: false },
      });
    }
    const result = await pipe(p.samples, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "en",
      task: "transcribe",
    });
    port.postMessage({ id: p.id, ok: true, value: result });
  } catch (e) {
    port.postMessage({
      id: p.id,
      ok: false,
      error: e instanceof Error ? e.message : "Local transcription failed",
    });
  }
});
