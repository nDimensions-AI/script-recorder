import {
  existsSync,
  statSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import manifest from "../../common/webinar/model-manifest.json" with { type: "json" };
import { fileHash } from "./core";

export async function ensureModel(
  cacheDir: string,
  allowDownload: boolean,
  progress: (value: any) => void,
) {
  const root = path.join(cacheDir, ...manifest.modelId.split("/"));
  mkdirSync(root, { recursive: true });
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (;;) {
        const entry = manifest.files[next++];
        if (!entry) return;
        const target = path.join(root, entry.name);
        mkdirSync(path.dirname(target), { recursive: true });
        if (
          existsSync(target) &&
          statSync(target).size === entry.size &&
          fileHash(target) === entry.sha256
        )
          continue;
        if (!allowDownload)
          throw new Error(
            "The pinned local speech model is missing or has failed its checksum. Approve a model download.",
          );
        if (existsSync(target))
          renameSync(target, target + ".invalid-" + Date.now());
        const partial = target + ".download";
        if (existsSync(partial) && statSync(partial).size > entry.size)
          unlinkSync(partial);
        let offset = existsSync(partial) ? statSync(partial).size : 0;
        const fd = openSync(partial, "a");
        try {
          while (offset < entry.size) {
            const end = Math.min(entry.size, offset + 1024 * 1024) - 1;
            let bytes: Uint8Array | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const response = await fetch(
                  `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/${entry.name}`,
                  {
                    headers: { Range: `bytes=${offset}-${end}` },
                    signal: AbortSignal.timeout(30000),
                  },
                );
                if (
                  response.status !== 206 ||
                  response.headers.get("content-range") !==
                    `bytes ${offset}-${end}/${entry.size}`
                ) {
                  await response.body?.cancel();
                  throw new Error(
                    "Model host did not return the requested range.",
                  );
                }
                if (!response.body)
                  throw new Error("Model host returned an empty range.");
                const reader = response.body.getReader(),
                  chunks: Uint8Array[] = [];
                let length = 0;
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.length;
                    if (length > end - offset + 1)
                      throw new Error("Model range exceeded its size limit.");
                    chunks.push(value);
                  }
                } finally {
                  await reader.cancel();
                  reader.releaseLock();
                }
                bytes = Buffer.concat(chunks);
                if (bytes.length !== end - offset + 1)
                  throw new Error("Model range was incomplete.");
                break;
              } catch (e) {
                if (attempt === 2) throw e;
              }
            }
            if (!bytes) throw new Error("Model download failed.");
            let written = 0;
            while (written < bytes.length)
              written += writeSync(fd, bytes, written, bytes.length - written);
            fsyncSync(fd);
            offset += bytes.length;
            progress({
              status: "progress",
              file: entry.name,
              loaded: offset,
              total: entry.size,
            });
          }
        } finally {
          closeSync(fd);
        }
        if (fileHash(partial) !== entry.sha256) {
          unlinkSync(partial);
          throw new Error("Speech model checksum mismatch.");
        }
        renameSync(partial, target);
        progress({ status: "done", file: entry.name });
      }
    }),
  );
  return root;
}
