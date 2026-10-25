import sharp from "sharp";
import { z } from "zod";
import { rectSchema } from "../../common/webinar/schema";
import type {
  UploadManifest,
  RedactionPlan,
  ApprovedText,
  ApprovedImage,
} from "../../common/webinar/types";
import { assert, uid, stableId, now, digest } from "./core";
import { WebinarStore } from "./store";
import { scanStructuredPii, resolveOverlaps } from "../../common/sensitive";
import { scanSecrets } from "../sensitive/secrets";

export async function redactText(text: string): Promise<string> {
  const hits = resolveOverlaps([
    ...scanStructuredPii(text),
    ...(await scanSecrets(text)),
  ]);
  let result = text;
  for (const h of [...hits].sort((a, b) => b.start - a.start))
    result = result.slice(0, h.start) + "[REDACTED]" + result.slice(h.end);
  return result;
}
export async function suggestedMasks(
  words: {
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }[],
) {
  let text = "";
  const ranges = words.slice(0, 10000).map((word) => {
    const start = text.length;
    text += word.text + " ";
    return { word, start, end: text.length - 1 };
  });
  const hits = resolveOverlaps([
    ...scanStructuredPii(text),
    ...(await scanSecrets(text)),
  ]);
  return ranges
    .filter((r) => hits.some((h) => h.start < r.end && h.end > r.start))
    .slice(0, 200)
    .map(({ word: { bbox: b } }) => ({
      x: Math.max(0, Math.floor(b.x0)),
      y: Math.max(0, Math.floor(b.y0)),
      width: Math.max(1, Math.ceil(b.x1) - Math.max(0, Math.floor(b.x0))),
      height: Math.max(1, Math.ceil(b.y1) - Math.max(0, Math.floor(b.y0))),
    }));
}
const planSchema = z
  .object({
    crop: rectSchema,
    masks: z.array(rectSchema).max(200),
    fill: z.literal("#000000"),
    transformVersion: z.literal("1"),
  })
  .strict();
export class EvidenceService {
  constructor(private store: WebinarStore) {}
  async derive(projectId: string, evidenceId: string, input: RedactionPlan) {
    const plan = planSchema.parse(input),
      db = this.store.db(projectId),
      e = db.get("SELECT * FROM evidence WHERE id=?", evidenceId);
    assert(e, "NOT_FOUND", "Screenshot not found.");
    const raw = this.store.assetBytes(projectId, e.raw_asset_id),
      metadata = await sharp(raw).metadata();
    const width = metadata.width!,
      height = metadata.height!;
    for (const r of [plan.crop, ...plan.masks])
      assert(
        r.x + r.width <= width && r.y + r.height <= height,
        "VALIDATION",
        "Crop or mask exceeds the screenshot.",
      );
    const patches = plan.masks.map((r) => ({
      input: Buffer.from(
        `<svg width="${r.width}" height="${r.height}"><rect width="100%" height="100%" fill="black"/></svg>`,
      ),
      left: r.x,
      top: r.y,
    }));
    let image = sharp(raw);
    if (patches.length) image = image.composite(patches);
    // Composite first into an intermediate image so masks use the original coordinates.
    const masked = await image.png().toBuffer();
    const bytes = await sharp(masked)
      .extract({
        left: plan.crop.x,
        top: plan.crop.y,
        width: plan.crop.width,
        height: plan.crop.height,
      })
      .png()
      .toBuffer();
    this.store.active(projectId);
    const a = this.store.asset(
        projectId,
        bytes,
        "image_derivative",
        "image/png",
        { width: plan.crop.width, height: plan.crop.height },
        e.raw_asset_id,
      ),
      id = uid();
    db.tx(() => {
      db.run(
        "INSERT INTO derivatives VALUES(?,?,?,?,?,?,?,?)",
        id,
        e.id,
        a.id,
        this.store.meta(projectId).policy_version,
        JSON.stringify(plan.crop),
        JSON.stringify(plan.masks),
        "1",
        now(),
      );
      this.store.invalidate(db);
    });
    return { id, assetId: a.id };
  }
  async prepare(
    projectId: string,
    derivativeIds: string[],
    profileHash: string,
    spanIds?: string[],
  ): Promise<UploadManifest> {
    assert(derivativeIds.length <= 2000, "VALIDATION", "Too many screenshots.");
    const db = this.store.db(projectId),
      meta = this.store.meta(projectId),
      images: ApprovedImage[] = [];
    for (const id of [...new Set(derivativeIds)]) {
      const d = db.get(
        "SELECT d.*,e.recording_id,e.at_us,a.sha256,a.mime,a.width,a.height,a.byte_length FROM derivatives d JOIN evidence e ON e.id=d.evidence_id JOIN assets a ON a.id=d.asset_id WHERE d.id=?",
        id,
      );
      assert(
        d && d.policy_version === meta.policy_version,
        "EVIDENCE_STALE",
        "Screenshot needs current redaction review.",
      );
      this.store.assetBytes(projectId, d.asset_id);
      images.push({
        evidenceId: d.evidence_id,
        derivativeId: d.id,
        hash: d.sha256,
        mime: d.mime,
        width: d.width,
        height: d.height,
        byteLength: d.byte_length,
        source: {
          recordingId: d.recording_id,
          startUs: d.at_us,
          endUs: d.at_us,
        },
      });
    }
    const spans = db.all(
      `SELECT s.*,COALESCE((SELECT text FROM transcript_edits e WHERE e.span_id=s.id ORDER BY version DESC LIMIT 1),s.original_text) AS current_text FROM transcript_spans s ORDER BY start_us`,
    );
    assert(
      spans.length,
      "AUDIO_MISSING",
      "Transcribe the rehearsal or add a source-linked transcript before generating.",
    );
    const texts: ApprovedText[] = [];
    if (spanIds)
      assert(
        spanIds.every((id) => spans.some((s) => s.id === id)),
        "VALIDATION",
        "Unknown transcript passage.",
      );
    for (const s of spans.filter((s) => !spanIds || spanIds.includes(s.id)))
      texts.push({
        textId: uid(),
        hash: "",
        text: await redactText(s.current_text),
        kind: "transcript",
        source: {
          recordingId: s.recording_id,
          startUs: s.start_us,
          endUs: s.end_us,
        },
        spanId: s.id,
        lineage: { manifestHashes: [], providerRequestIds: [] },
      });
    assert(
      texts.length,
      "VALIDATION",
      "Select at least one transcript passage.",
    );
    texts.push({
      textId: uid(),
      hash: "",
      text: await redactText(meta.context_json),
      kind: "context",
      source: null,
      spanId: null,
      lineage: { manifestHashes: [], providerRequestIds: [] },
    });
    assert(
      this.store.meta(projectId).source_version === meta.source_version,
      "EVIDENCE_STALE",
      "Source changed during preparation.",
    );
    for (const t of texts) {
      t.hash = digest(t.text);
      t.textId = stableId({
        projectId,
        spanId: t.spanId,
        kind: t.kind,
        hash: t.hash,
        policyVersion: meta.policy_version,
      });
    }
    const content = {
      schemaVersion: 1 as const,
      id: uid(),
      projectId,
      sourceVersion: meta.source_version,
      policyVersion: meta.policy_version,
      providerProfileHash: profileHash,
      images,
      texts,
      allowedStages: ["extract", "compose"] as ("extract" | "compose")[],
      parentManifestHash: null,
      approvalRootHash: null,
      approvedBy: "Editor",
      approvedAt: "",
    };
    return { ...content, hash: digest(content) };
  }
  approve(projectId: string, candidate: UploadManifest) {
    const db = this.store.db(projectId),
      m = this.store.meta(projectId),
      { hash, ...content } = candidate;
    assert(
      candidate.projectId === projectId && digest(content) === hash,
      "VALIDATION",
      "Preview changed.",
    );
    assert(
      m.source_version === candidate.sourceVersion &&
        m.policy_version === candidate.policyVersion,
      "EVIDENCE_STALE",
      "Prepare a current preview.",
    );
    const approved = { ...candidate, approvedAt: now() };
    const { hash: _old, ...body } = approved;
    approved.hash = digest(body);
    db.tx(() => {
      for (const t of candidate.texts) {
        const prior = db.get(
          "SELECT * FROM text_derivatives WHERE id=?",
          t.textId,
        );
        assert(
          !prior ||
            (prior.sha256 === t.hash &&
              prior.span_id === t.spanId &&
              prior.policy_version === m.policy_version),
          "EVIDENCE_STALE",
          "Text derivative identity changed.",
        );
        db.run(
          "INSERT OR IGNORE INTO text_derivatives VALUES(?,?,?,?,?,?,?,?,?)",
          t.textId,
          t.spanId,
          t.kind,
          m.source_version,
          t.text,
          t.hash,
          "[]",
          JSON.stringify(t.lineage),
          m.policy_version,
        );
      }
      db.run(
        "INSERT INTO upload_manifests VALUES(?,?,?,?,?,?,?,?,NULL)",
        approved.id,
        approved.hash,
        m.source_version,
        m.policy_version,
        approved.providerProfileHash,
        JSON.stringify(approved),
        "Editor",
        approved.approvedAt,
      );
      for (const i of approved.images)
        db.run(
          "INSERT INTO manifest_images VALUES(?,?)",
          approved.id,
          i.derivativeId,
        );
      for (const t of approved.texts)
        db.run("INSERT INTO manifest_texts VALUES(?,?)", approved.id, t.textId);
    });
    return approved;
  }
  get(
    projectId: string,
    manifestId: string,
    profileHash: string,
  ): UploadManifest {
    const db = this.store.db(projectId),
      row = db.get("SELECT * FROM upload_manifests WHERE id=?", manifestId),
      m = this.store.meta(projectId);
    assert(
      row &&
        !row.revoked_at &&
        row.source_version === m.source_version &&
        row.policy_version === m.policy_version &&
        row.provider_profile_hash === profileHash,
      "POLICY_DENIED",
      "Approve current evidence for this provider profile.",
    );
    const manifest = JSON.parse(row.payload_json) as UploadManifest;
    const { hash, ...body } = manifest;
    assert(
      digest(body) === hash && hash === row.sha256,
      "EVIDENCE_STALE",
      "Manifest integrity check failed.",
    );
    for (const t of manifest.texts)
      assert(
        digest(t.text) === t.hash,
        "EVIDENCE_STALE",
        "Transcript derivative changed.",
      );
    if (manifest.parentManifestHash) {
      const parent = db.get(
        "SELECT id FROM upload_manifests WHERE sha256=?",
        manifest.parentManifestHash,
      );
      assert(parent, "POLICY_DENIED", "Missing manifest ancestor.");
      this.get(projectId, parent.id, profileHash);
    }
    return manifest;
  }
  async descendant(
    projectId: string,
    parent: UploadManifest,
    text: string,
    requestId: string,
  ): Promise<UploadManifest> {
    assert(
      parent.allowedStages.includes("compose"),
      "POLICY_DENIED",
      "Composition was not approved.",
    );
    const redacted = await redactText(text);
    this.get(projectId, parent.id, parent.providerProfileHash);
    const previous = this.store
      .db(projectId)
      .get(
        "SELECT id FROM upload_manifests WHERE revoked_at IS NULL AND json_extract(payload_json,'$.parentManifestHash')=? AND json_extract(payload_json,'$.texts[0].hash')=? AND json_extract(payload_json,'$.texts[0].lineage.providerRequestIds[0]')=?",
        parent.hash,
        digest(redacted),
        requestId,
      );
    if (previous)
      return this.get(projectId, previous.id, parent.providerProfileHash);
    const derived: ApprovedText = {
      textId: uid(),
      hash: digest(redacted),
      text: redacted,
      kind: "model_derived",
      source: null,
      spanId: null,
      lineage: {
        manifestHashes: [parent.hash],
        providerRequestIds: [requestId],
      },
    };
    const body = {
      ...parent,
      id: uid(),
      images: [],
      texts: [derived],
      allowedStages: ["compose"] as ("extract" | "compose")[],
      parentManifestHash: parent.hash,
      approvalRootHash: parent.approvalRootHash ?? parent.hash,
      approvedAt: now(),
    };
    const { hash: _old, ...content } = body;
    return this.approve(projectId, { ...content, hash: digest(content) });
  }
}
