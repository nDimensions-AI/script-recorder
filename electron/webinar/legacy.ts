import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import sharp from "sharp";
import { z } from "zod";
import { WebinarStore } from "./store";
import { assert, contained, uid, now, bytesHash } from "./core";

export async function importLegacy(store: WebinarStore, source: string) {
  const json = (name: string, optional = false): any => {
    const file = contained(source, name);
    if (optional && !existsSync(file)) return null;
    assert(
      statSync(file).size < 20 * 1024 ** 2,
      "VALIDATION",
      "Legacy metadata is too large.",
    );
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const meta = z
    .object({
      startedAt: z.number().finite(),
      stoppedAt: z.number().finite().nullable(),
    })
    .passthrough()
    .parse(json("session.json"));
  const duration = Math.max(
    1,
    Math.round(((meta.stoppedAt ?? meta.startedAt) - meta.startedAt) * 1000),
  );
  const projectId = store.create({
      context: {
        title:
          "Imported rehearsal " + new Date(meta.startedAt).toLocaleDateString(),
        narrator: "Imported narrator",
        audience: "",
        objective: "",
        targetDurationSeconds: Math.max(
          60,
          Math.min(14400, Math.ceil(duration / 1e6)),
        ),
        language: "en",
        glossary: [],
      },
      budgetMicrousd: 0,
    }),
    db = store.db(projectId),
    recordingId = uid();
  const limitations = [
    "Legacy timestamps are uncertain. Verify source alignment.",
    "Imported media has not passed the new capture coverage checks.",
  ];
  try {
    db.run(
      "INSERT INTO recordings VALUES(?,?,'Incomplete',1,'{}',?,?,?)",
      recordingId,
      "Imported narrator",
      new Date(meta.startedAt).toISOString(),
      now(),
      duration,
    );
    const video = json("video.json", true),
      audio = json("audio.json", true),
      sources = [
        ...(video ? [{ ...video, track: "screen" }] : []),
        ...(audio
          ? (audio.segments ?? [audio]).map((a: any) => ({
              ...a,
              track: "microphone",
            }))
          : []),
      ];
    const sequence: Record<string, number> = { screen: 0, microphone: 0 };
    for (const s of sources) {
      const media = z
        .object({
          file: z.string().min(1),
          startEpoch: z.number().finite(),
          durationMs: z
            .number()
            .positive()
            .max(24 * 60 * 60 * 1000),
          track: z.enum(["screen", "microphone"]),
        })
        .passthrough()
        .parse(s);
      const file = contained(source, media.file);
      assert(
        statSync(file).size <= 20 * 1024 ** 3,
        "VALIDATION",
        "Legacy media exceeds the import limit.",
      );
      const bytes = Buffer.alloc(4),
        fd = openSync(file, "r");
      try {
        readSync(fd, bytes, 0, 4, 0);
      } finally {
        closeSync(fd);
      }
      assert(
        bytes.toString("hex") === "1a45dfa3",
        "VALIDATION",
        "Legacy media must be WebM.",
      );
      const asset = store.assetFromFile(
        projectId,
        file,
        media.track === "screen" ? "video" : "audio",
        media.track === "screen" ? "video/webm" : "audio/webm",
      );
      const start = Math.max(
          0,
          Math.round((media.startEpoch - meta.startedAt) * 1000),
        ),
        end = start + Math.round(media.durationMs * 1000),
        clock = uid();
      db.run(
        "INSERT INTO clock_maps VALUES(?,?,?,?,?,?,?,?,?,?)",
        clock,
        recordingId,
        media.track,
        1,
        start,
        0,
        1,
        1000000,
        "[]",
        now(),
      );
      db.run(
        "INSERT INTO segments VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        uid(),
        recordingId,
        media.track,
        sequence[media.track]++,
        asset.id,
        clock,
        start,
        end,
        0,
        end - start,
        JSON.stringify({ legacy: true, decodeVerified: false }),
      );
      db.run(
        "UPDATE recordings SET duration_us=MAX(duration_us,?) WHERE id=?",
        end,
        recordingId,
      );
      if (media.track === "microphone" && media.durationMs > 45000)
        limitations.push(
          "Long legacy audio is preserved for playback. Existing narration is imported; re-record for bounded automatic transcription.",
        );
    }
    if (!sequence.microphone)
      limitations.push("No legacy audio was available.");
    const frames =
      json("video-frames.json", true)?.frames ??
      json("frames/frames.json", true) ??
      [];
    assert(
      Array.isArray(frames) && frames.length <= 10000,
      "VALIDATION",
      "Invalid legacy frame list.",
    );
    for (const f of frames) {
      const filename = contained(
        source,
        typeof f.file === "string" && f.file.startsWith("video-frames")
          ? f.file
          : "frames/" + f.file,
      );
      assert(
        statSync(filename).size <= 20 * 1024 ** 2,
        "VALIDATION",
        "Legacy frame exceeds limit.",
      );
      const bytes = await sharp(filename).png().toBuffer(),
        m = await sharp(bytes).metadata(),
        atUs = Math.max(0, Math.round((Number(f.tMs) - meta.startedAt) * 1000));
      assert(
        Number.isSafeInteger(atUs),
        "VALIDATION",
        "Invalid legacy frame time.",
      );
      const a = store.asset(projectId, bytes, "frame", "image/png", {
        width: m.width!,
        height: m.height!,
      });
      db.run(
        "INSERT INTO evidence VALUES(?,?,?,?,?,?)",
        uid(),
        recordingId,
        a.id,
        atUs,
        "legacy",
        JSON.stringify({
          timingUncertain: true,
          limitedResolution: m.height! < 1080,
        }),
      );
      db.run(
        "UPDATE recordings SET duration_us=MAX(duration_us,?) WHERE id=?",
        atUs,
        recordingId,
      );
    }
    const narration = json("narration.json", true);
    for (const row of narration?.segments ?? []) {
      const span = z
        .object({
          atMs: z.number().nonnegative(),
          endMs: z.number().nonnegative(),
          text: z.string().max(12000),
        })
        .parse(row);
      if (span.endMs <= span.atMs) continue;
      db.run(
        "INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)",
        uid(),
        recordingId,
        Math.round(span.atMs * 1000),
        Math.round(span.endMs * 1000),
        span.text,
        String(narration.model ?? "legacy"),
        bytesHash(Buffer.from(JSON.stringify(row))),
        JSON.stringify(["TIMING_UNCERTAIN"]),
      );
      db.run(
        "UPDATE recordings SET duration_us=MAX(duration_us,?) WHERE id=?",
        Math.round(span.endMs * 1000),
        recordingId,
      );
    }
    const report = {
      recordingId,
      limitations,
      mediaCount: sources.length,
      frameCount: frames.length,
      originalPreserved: true,
    };
    store.asset(
      projectId,
      Buffer.from(JSON.stringify(report)),
      "job_output",
      "application/json",
    );
    store.event(db, "legacy.imported", report);
    return { projectId, report };
  } catch (e) {
    store.delete(projectId);
    throw e;
  }
}
