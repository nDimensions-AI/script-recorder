import {
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  readFileSync,
  unlinkSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { captureProfileSchema } from "../../common/webinar/schema";
import { WebinarStore } from "./store";
import { assert, uid, now, atomicFile } from "./core";

export class CapturePersistence {
  files = new Map<
    string,
    {
      projectId: string;
      recordingId: string;
      track: string;
      sequence: number;
      fd: number;
      filename: string;
      startUs: number;
      bytes: number;
      segmentSequence: number;
      uncertaintyUs: number;
      clockSamples: unknown[];
    }
  >();
  constructor(private store: WebinarStore) {}
  start(projectId: string, profile: unknown) {
    captureProfileSchema.parse(profile);
    const db = this.store.db(projectId);
    assert(
      !db.get(
        "SELECT id FROM recordings WHERE state IN ('Preflight','Recording','Paused','Finalizing')",
      ),
      "BUSY",
      "A recording is already active.",
    );
    const stats = statfsSync(this.store.directory(projectId));
    assert(
      stats.bavail * stats.bsize >= 5 * 1024 ** 3,
      "STORAGE_FULL",
      "At least 5 GiB free space is required.",
    );
    const recordingId = uid();
    db.run(
      "INSERT INTO recordings(id,narrator,state,capture_epoch,profile_json,started_at) VALUES(?,?,'Preflight',1,?,?)",
      recordingId,
      JSON.parse(this.store.meta(projectId).context_json).narrator,
      JSON.stringify(profile),
      now(),
    );
    return { recordingId };
  }
  state(
    projectId: string,
    recordingId: string,
    state: string,
    atUs: number,
    reason = "",
  ) {
    const db = this.store.db(projectId),
      r = db.get("SELECT * FROM recordings WHERE id=?", recordingId);
    assert(r, "NOT_FOUND", "Recording missing.");
    const transitions: Record<string, string[]> = {
      Preflight: ["Recording", "Incomplete"],
      Recording: ["Paused", "Finalizing", "Incomplete"],
      Paused: ["Recording", "Finalizing", "Incomplete"],
      Finalizing: ["Captured", "Incomplete"],
    };
    assert(
      transitions[r.state]?.includes(state),
      "VALIDATION",
      "Invalid capture transition.",
    );
    if (state === "Recording" && r.state === "Paused")
      db.run(
        "UPDATE intervals SET end_us=? WHERE recording_id=? AND end_us IS NULL",
        atUs,
        recordingId,
      );
    if (state === "Paused")
      db.run(
        "INSERT INTO intervals VALUES(?,?,?,?,?,?,?)",
        uid(),
        recordingId,
        reason ? "gap" : "pause",
        "both",
        atUs,
        null,
        reason || "User paused",
      );
    if (state === "Incomplete")
      db.run(
        "INSERT INTO intervals VALUES(?,?,?,?,?,?,?)",
        uid(),
        recordingId,
        "gap",
        "both",
        atUs,
        atUs,
        reason || "Capture interrupted",
      );
    if (["Captured", "Incomplete"].includes(state)) {
      db.run(
        "UPDATE intervals SET end_us=? WHERE recording_id=? AND end_us IS NULL",
        atUs,
        recordingId,
      );
      this.store.invalidate(db);
    }
    db.run(
      "UPDATE recordings SET state=?,duration_us=?,stopped_at=?,capture_epoch=capture_epoch+? WHERE id=?",
      state,
      atUs,
      ["Captured", "Incomplete"].includes(state) ? now() : null,
      state === "Recording" && r.state === "Paused" ? 1 : 0,
      recordingId,
    );
    this.store.event(db, "capture.changed", { recordingId, state });
    return { state };
  }
  open(
    projectId: string,
    p: {
      recordingId: string;
      segmentId: string;
      track: string;
      startUs: number;
      sequence: number;
      uncertaintyUs?: number;
      clockSamples?: unknown[];
    },
  ) {
    const db = this.store.db(projectId),
      r = db.get("SELECT * FROM recordings WHERE id=?", p.recordingId);
    assert(
      r && ["Preflight", "Recording"].includes(r.state),
      "CANCELLED",
      "Capture is not active.",
    );
    assert(
      ["screen", "microphone"].includes(p.track) &&
        Number.isSafeInteger(p.startUs) &&
        p.startUs >= 0,
      "VALIDATION",
      "Invalid media segment.",
    );
    assert(!this.files.has(p.segmentId), "VALIDATION", "Segment already open.");
    const filename = path.join(
      this.store.directory(projectId),
      "staging",
      uid() + ".webm",
    );
    const descriptor = {
      projectId,
      recordingId: p.recordingId,
      track: p.track,
      sequence: 0,
      filename,
      startUs: p.startUs,
      bytes: 0,
      segmentSequence: p.sequence,
      uncertaintyUs: p.uncertaintyUs ?? 100000,
      clockSamples: p.clockSamples ?? [],
    };
    atomicFile(
      filename + ".partial.json",
      Buffer.from(JSON.stringify(descriptor)),
    );
    this.files.set(p.segmentId, {
      ...descriptor,
      fd: openSync(filename, "wx"),
    });
    return { creditBytes: 16 * 1024 ** 2 };
  }
  chunk(
    projectId: string,
    p: { segmentId: string; sequence: number; bytes: Uint8Array },
  ) {
    const s = this.files.get(p.segmentId);
    assert(s && s.projectId === projectId, "CANCELLED", "Segment is closed.");
    assert(
      p.bytes instanceof Uint8Array &&
        p.bytes.length <= 1024 ** 2 &&
        p.sequence === s.sequence,
      "VALIDATION",
      "Invalid media chunk sequence.",
    );
    assert(
      s.bytes + p.bytes.length <= 128 * 1024 ** 2,
      "VALIDATION",
      "Segment exceeded its safety limit.",
    );
    const stats = statfsSync(this.store.directory(projectId));
    assert(
      stats.bavail * stats.bsize > 256 * 1024 ** 2,
      "STORAGE_FULL",
      "Storage is almost full.",
    );
    let n = 0;
    while (n < p.bytes.length)
      n += writeSync(s.fd, p.bytes, n, p.bytes.length - n);
    s.sequence++;
    s.bytes += p.bytes.length;
    return { throughSequence: p.sequence };
  }
  async seal(
    projectId: string,
    p: { segmentId: string; endUs: number; mime: string },
    decode: (
      filename: string,
      track: string,
    ) => Promise<{ durationUs: number }>,
  ) {
    const s = this.files.get(p.segmentId);
    assert(s && s.projectId === projectId, "CANCELLED", "Segment is closed.");
    this.files.delete(p.segmentId);
    fsyncSync(s.fd);
    closeSync(s.fd);
    assert(
      s.bytes > 0 && p.endUs > s.startUs,
      "DECODE_FAILED",
      "Empty recording segment.",
    );
    const report = await decode(s.filename, s.track);
    assert(
      Number.isSafeInteger(report.durationUs) &&
        report.durationUs > 0 &&
        report.durationUs <= 45000000,
      "DECODE_FAILED",
      "Invalid segment duration.",
    );
    const db = this.store.db(projectId),
      r = db.get("SELECT * FROM recordings WHERE id=?", s.recordingId);
    assert(
      r && !["Captured", "Incomplete"].includes(r.state),
      "CANCELLED",
      "Recording is no longer accepting segments.",
    );
    const asset = this.store.asset(
      projectId,
      readFileSync(s.filename),
      s.track === "screen" ? "video" : "audio",
      p.mime,
    );
    const clock = uid(),
      end = Math.min(p.endUs, s.startUs + report.durationUs);
    const previous = db.get(
      "SELECT end_us FROM segments WHERE recording_id=? AND track=? ORDER BY sequence DESC LIMIT 1",
      s.recordingId,
      s.track,
    );
    const trimStart = Math.max(s.startUs, previous?.end_us ?? 0);
    assert(
      end > trimStart,
      "DECODE_FAILED",
      "Segment has no playable interval.",
    );
    const clockRow = [
      clock,
      s.recordingId,
      s.track,
      r.capture_epoch,
      s.startUs,
      0,
      1,
      s.uncertaintyUs,
      JSON.stringify(s.clockSamples),
      now(),
    ];
    const segmentRow = [
      uid(),
      s.recordingId,
      s.track,
      s.segmentSequence,
      asset.id,
      clock,
      trimStart,
      end,
      trimStart - s.startUs,
      end - s.startUs,
      JSON.stringify(report),
    ];
    const sidecar = s.filename + ".sealed.json";
    atomicFile(
      sidecar,
      Buffer.from(
        JSON.stringify({ asset, clock: clockRow, segment: segmentRow }),
      ),
    );
    db.tx(() => {
      db.run("INSERT INTO clock_maps VALUES(?,?,?,?,?,?,?,?,?,?)", ...clockRow);
      db.run(
        "INSERT INTO segments VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ...segmentRow,
      );
      db.run(
        "UPDATE recordings SET duration_us=MAX(COALESCE(duration_us,0),?) WHERE id=?",
        end,
        s.recordingId,
      );
    });
    unlinkSync(s.filename);
    unlinkSync(s.filename + ".partial.json");
    unlinkSync(sidecar);
    return { assetId: asset.id, durationUs: report.durationUs };
  }
  frame(
    projectId: string,
    p: {
      recordingId: string;
      atUs: number;
      bytes: Uint8Array;
      width: number;
      height: number;
      source: string;
    },
  ) {
    const db = this.store.db(projectId),
      r = db.get("SELECT * FROM recordings WHERE id=?", p.recordingId);
    assert(
      r && ["Preflight", "Recording"].includes(r.state),
      "CANCELLED",
      "Recording ended.",
    );
    assert(
      p.bytes.length <= 20 * 1024 ** 2 &&
        p.width > 0 &&
        p.height > 0 &&
        Number.isSafeInteger(p.atUs) &&
        p.atUs >= 0,
      "VALIDATION",
      "Invalid screenshot.",
    );
    const a = this.store.asset(projectId, p.bytes, "frame", "image/png", {
        width: p.width,
        height: p.height,
      }),
      id = uid();
    db.run(
      "INSERT INTO evidence VALUES(?,?,?,?,?,?)",
      id,
      p.recordingId,
      a.id,
      p.atUs,
      ["marker", "scene"].includes(p.source) ? p.source : "event",
      "{}",
    );
    return { id };
  }
  marker(
    projectId: string,
    recordingId: string,
    atUs: number,
    label: string,
    kind = "moment",
  ) {
    const db = this.store.db(projectId),
      id = uid();
    db.run(
      "INSERT INTO markers VALUES(?,?,?,?,?)",
      id,
      recordingId,
      atUs,
      kind,
      label,
    );
    return { id, atUs };
  }
  abandon(projectId: string) {
    for (const [id, s] of this.files)
      if (s.projectId === projectId) {
        try {
          fsyncSync(s.fd);
          closeSync(s.fd);
        } catch {}
        this.files.delete(id);
      }
  }
}
