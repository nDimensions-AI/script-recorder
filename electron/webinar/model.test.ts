import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import manifest from "../../common/webinar/model-manifest.json" with { type: "json" };
import { ensureModel } from "./model";

test("model preparation never downloads without explicit permission", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webinar-model-test-"));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected network");
  });
  try {
    await assert.rejects(
      ensureModel(directory, false, () => {}),
      /Approve a model download/,
    );
    assert.equal(requests, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model preparation rejects an oversized streamed range before writing it", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webinar-model-test-"));
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, options: RequestInit) => {
      const entry = manifest.files.find((f) => input.endsWith("/" + f.name))!;
      const range = (options.headers as Record<string, string>).Range;
      return new Response(new Uint8Array(2 * 1024 * 1024), {
        status: 206,
        headers: {
          "content-range": range.replace("=", " ") + "/" + entry.size,
        },
      });
    },
  );
  try {
    await assert.rejects(
      ensureModel(directory, true, () => {}),
      /exceeded its size limit/,
    );
    for (const entry of manifest.files.slice(0, 2)) {
      const partial = path.join(
        directory,
        manifest.modelId,
        entry.name + ".download",
      );
      assert.equal(statSync(partial).size, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
