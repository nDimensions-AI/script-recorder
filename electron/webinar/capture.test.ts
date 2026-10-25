import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebinarStore } from "./store";
import { CapturePersistence } from "./capture-store";
import { defaultCaptureProfile } from "../../common/webinar/schema";
import { uid } from "./core";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "webinar-capture-")),
    migrations = path.resolve("electron/webinar/migrations"),
    store = new WebinarStore(root, migrations),
    projectId = store.create({
      context: {
        title: "Crash test",
        narrator: "Fixture",
        audience: "",
        objective: "",
        targetDurationSeconds: 60,
        language: "en",
        glossary: [],
      },
      budgetMicrousd: 0,
    }),
    capture = new CapturePersistence(store),
    recordingId = capture.start(projectId, defaultCaptureProfile).recordingId;
  capture.state(projectId, recordingId, "Recording", 0);
  return {
    root,
    migrations,
    store,
    projectId,
    capture,
    recordingId,
    close() {
      capture.abandon(projectId);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function segment(
  f: ReturnType<typeof fixture>,
  start: number,
  end: number,
  sequence: number,
) {
  const segmentId = uid();
  f.capture.open(f.projectId, {
    recordingId: f.recordingId,
    segmentId,
    track: "screen",
    startUs: start,
    sequence,
  });
  assert.throws(
    () =>
      f.capture.chunk(f.projectId, {
        segmentId,
        sequence: 2,
        bytes: Buffer.from("bad"),
      }),
    /sequence/,
  );
  f.capture.chunk(f.projectId, {
    segmentId,
    sequence: 0,
    bytes: Buffer.from("synthetic-container"),
  });
  await f.capture.seal(
    f.projectId,
    { segmentId, endUs: end, mime: "video/webm" },
    async () => ({ durationUs: end - start }),
  );
}
test("segment writes enforce sequencing and trim rotation overlap without changing bytes", async () => {
  const f = fixture();
  try {
    await segment(f, 0, 5000000, 0);
    await segment(f, 4750000, 9750000, 1);
    const rows = f.store
      .db(f.projectId)
      .all("SELECT * FROM segments ORDER BY sequence");
    assert.equal(rows[1].start_us, 5000000);
    assert.equal(rows[1].media_in_us, 250000);
    assert.equal(
      f.store.assetBytes(f.projectId, rows[1].asset_id).toString(),
      "synthetic-container",
    );
    f.capture.state(f.projectId, f.recordingId, "Paused", 10000000);
    f.capture.state(f.projectId, f.recordingId, "Recording", 20000000);
    const pause = f.store.db(f.projectId).get("SELECT * FROM intervals")!;
    assert.equal(pause.end_us - pause.start_us, 10000000);
  } finally {
    f.close();
  }
});
test("a decode-verified sealed sidecar is recovered after a database commit failure", async () => {
  const f = fixture();
  let reopened: WebinarStore | undefined;
  try {
    const db = f.store.db(f.projectId),
      original = db.run.bind(db);
    let injected = false;
    db.run = (sql, ...args) => {
      if (!injected && sql.startsWith("INSERT INTO segments")) {
        injected = true;
        throw new Error("Injected crash before commit");
      }
      return original(sql, ...args);
    };
    await assert.rejects(() => segment(f, 0, 5000000, 0), /Injected crash/);
    assert.equal(db.all("SELECT * FROM segments").length, 0);
    f.store.close();
    reopened = new WebinarStore(f.root, f.migrations);
    assert.equal(
      reopened.db(f.projectId).all("SELECT * FROM segments").length,
      1,
    );
    assert.equal(
      reopened.snapshot(f.projectId).recordings[0].state,
      "Incomplete",
    );
  } finally {
    reopened?.close();
    if (!reopened) f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("late decoder completion cannot append to an interrupted recording", async () => {
  const f = fixture();
  try {
    const segmentId = uid();
    f.capture.open(f.projectId, {
      recordingId: f.recordingId,
      segmentId,
      track: "screen",
      startUs: 0,
      sequence: 0,
    });
    f.capture.chunk(f.projectId, {
      segmentId,
      sequence: 0,
      bytes: Buffer.from("bytes"),
    });
    let release!: (r: { durationUs: number }) => void;
    const decoding = f.capture.seal(
      f.projectId,
      { segmentId, endUs: 1000000, mime: "video/webm" },
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    f.capture.state(
      f.projectId,
      f.recordingId,
      "Incomplete",
      1000000,
      "Source lost",
    );
    release({ durationUs: 1000000 });
    await assert.rejects(decoding, /no longer accepting/);
    assert.equal(
      f.store.db(f.projectId).all("SELECT * FROM segments").length,
      0,
    );
  } finally {
    f.close();
  }
});
