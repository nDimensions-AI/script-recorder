import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetResponse } from "./media";
test("private media supports exact ranges, suffixes, HEAD and unsatisfiable ranges", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "webinar-range-")),
    file = path.join(root, "media");
  writeFileSync(file, "0123456789");
  try {
    let r = assetResponse(file, "video/webm", 10, "GET", "bytes=2-5", "null");
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await r.text(), "2345");
    r = assetResponse(file, "video/webm", 10, "GET", "bytes=-2", "null");
    assert.equal(await r.text(), "89");
    r = assetResponse(file, "video/webm", 10, "HEAD", null, "null");
    assert.equal(r.headers.get("content-length"), "10");
    assert.equal(await r.text(), "");
    for (const range of [
      "bytes=100-",
      "bytes=4-2",
      "bytes=0-1,3-4",
      "bytes=-0",
    ])
      assert.equal(
        assetResponse(file, "video/webm", 10, "GET", range, "null").status,
        416,
      );
    assert.equal(
      assetResponse(file, "video/webm", 11, "GET", null, "null").status,
      409,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
