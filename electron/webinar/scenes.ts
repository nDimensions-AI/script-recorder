import sharp from "sharp";
import { WebinarStore } from "./store";
import { assert } from "./core";

export class SceneService {
  constructor(private store: WebinarStore) {}
  async analyze(projectId: string, valid: () => boolean) {
    const db = this.store.db(projectId),
      evidence = db.all(
        "SELECT e.*,a.width,a.height FROM evidence e JOIN assets a ON a.id=e.raw_asset_id ORDER BY e.recording_id,e.at_us",
      ),
      candidates: any[] = [];
    let previous = "",
      previousRecording = "";
    for (const e of evidence) {
      assert(valid(), "CANCELLED", "Scene analysis cancelled.");
      const pixels = await sharp(
        this.store.assetBytes(projectId, e.raw_asset_id),
      )
        .resize(9, 8, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer();
      let hash = "";
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          hash += pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? "1" : "0";
      if (previousRecording !== e.recording_id) previous = "";
      const novelty = previous
        ? [...hash].reduce((n, b, i) => n + (b !== previous[i] ? 1 : 0), 0) / 64
        : 1;
      const components = {
        coverage: 1,
        stability: 0.5,
        readability: Math.min(1, e.width / 1920),
        novelty,
        marker: e.source === "marker" ? 1 : 0,
      };
      const score = Object.values(components).reduce((n, v) => n + v, 0) / 5;
      candidates.push({
        id: e.id,
        atUs: e.at_us,
        recordingId: e.recording_id,
        score,
        quality: {
          version: 1,
          dHash: BigInt("0b" + hash)
            .toString(16)
            .padStart(16, "0"),
          components,
          score,
          limitedResolution: e.width < 1280,
          note: "Heuristic ranking; code changes and markers are never automatically discarded.",
        },
      });
      previous = hash;
      previousRecording = e.recording_id;
    }
    // Stability measures the following frame, independently of novelty against the previous.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i],
        next = candidates[i + 1];
      if (next && next.recordingId === c.recordingId) {
        const a = BigInt("0x" + c.quality.dHash),
          b = BigInt("0x" + next.quality.dHash);
        c.quality.components.stability =
          1 - (a ^ b).toString(2).replaceAll("0", "").length / 64;
      }
      c.score = Object.values(c.quality.components).reduce(
        (n: any, v: any) => n + v,
        0,
      ) as number;
      c.score /= 5;
      c.quality.score = c.score;
    }
    const buckets = new Map<string, any[]>();
    for (const c of candidates) {
      const key = c.recordingId + ":" + Math.floor(c.atUs / 90000000),
        bucket = buckets.get(key) ?? [];
      bucket.push(c);
      buckets.set(key, bucket);
    }
    const recommendedIds = [...buckets.values()].flatMap((bucket) =>
      bucket
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((c) => c.id),
    );
    assert(valid(), "CANCELLED", "Scene analysis changed.");
    db.tx(() => {
      for (const c of candidates)
        db.run(
          "UPDATE evidence SET quality_json=? WHERE id=?",
          JSON.stringify({
            ...c.quality,
            recommended: recommendedIds.includes(c.id),
          }),
          c.id,
        );
    });
    return { recommendedIds, candidateCount: candidates.length };
  }
}
