import { z } from "zod";

export const id = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const contextSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    audience: z.string().max(8000),
    objective: z.string().max(8000),
    targetDurationSeconds: z.number().int().min(60).max(14400),
    narrator: z.string().trim().min(1).max(200),
    language: z.literal("en"),
    glossary: z
      .array(
        z
          .object({
            term: z.string().max(200),
            explanation: z.string().max(2000),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const intervalSchema = z
  .object({ recordingId: id, startUs: counter, endUs: counter })
  .strict()
  .refine((v) => v.endUs >= v.startUs, "Invalid interval");
export const refSchema = z
  .object({
    kind: z.enum(["image", "transcript", "terminal", "user"]),
    id,
    source: intervalSchema.nullable(),
  })
  .strict();
export const rectSchema = z
  .object({
    x: counter,
    y: counter,
    width: z.number().int().min(1).max(32768),
    height: z.number().int().min(1).max(32768),
  })
  .strict();
export const provenance = z.enum([
  "observed",
  "narrated",
  "user_supplied",
  "editorial",
]);
export const blockSchema = z
  .object({
    id,
    kind: z.enum(["say", "do", "show", "producer", "handoff"]),
    text: z.string().max(12000),
    provenance,
    refs: z.array(refSchema).max(200),
    stepRefs: z
      .array(z.object({ id, version: z.number().int().positive() }).strict())
      .max(200),
    imageDerivativeIds: z.array(id).max(20),
    timingGroup: id,
    timingMode: z.enum(["serial", "overlap"]),
    durationSeconds: z.number().finite().min(0).max(14400).nullable(),
    requiresTechnicalVerification: z.boolean(),
  })
  .strict();
export const sectionSchema = z
  .object({
    id,
    title: z.string().max(200),
    presenterId: id.nullable(),
    assignment: z.enum(["suggested", "confirmed", "unassigned"]),
    blocks: z.array(blockSchema).max(2000),
    handoffToPresenterId: id.nullable(),
  })
  .strict();
export const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: id,
    title: z.string().max(200),
    context: contextSchema,
    presenters: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(200),
            wordsPerMinute: z.number().int().min(60).max(250),
          })
          .strict(),
      )
      .max(20),
    sections: z.array(sectionSchema).max(200),
  })
  .strict()
  .superRefine((v, c) => {
    const blocks = v.sections.flatMap((s) => s.blocks);
    if (
      blocks.length > 2000 ||
      blocks.reduce((n, b) => n + b.text.length, 0) > 200000
    )
      c.addIssue({
        code: "custom",
        message: "Script exceeds the supported size",
      });
    const ids = [
      v.projectId,
      ...v.presenters.map((p) => p.id),
      ...v.sections.map((s) => s.id),
      ...blocks.map((b) => b.id),
    ];
    if (new Set(ids).size !== ids.length)
      c.addIssue({ code: "custom", message: "Duplicate document identifiers" });
    const presenters = new Set(v.presenters.map((p) => p.id));
    for (const s of v.sections)
      if (
        (s.presenterId && !presenters.has(s.presenterId)) ||
        (s.handoffToPresenterId && !presenters.has(s.handoffToPresenterId))
      )
        c.addIssue({ code: "custom", message: "Unknown presenter" });
  });
export const profileSchema = z
  .object({
    modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),
    inputMicrousdPerMillion: z.number().int().min(0).max(1e12),
    outputMicrousdPerMillion: z.number().int().min(0).max(1e12),
    maxInputTokens: z.number().int().min(1000).max(1000000),
    maxOutputTokens: z.number().int().min(256).max(32768),
    maxImages: z.number().int().min(1).max(12),
    maxRequestBytes: z.number().int().min(100000).max(18000000),
    timeoutMs: z.number().int().min(5000).max(180000),
    rateCardId: z.string().trim().min(1).max(200),
  })
  .strict();
export type ProviderSettings = z.infer<typeof profileSchema>;
export const captureProfileSchema = z
  .object({
    width: z.number().int().min(640).max(3840),
    height: z.number().int().min(360).max(2160),
    fps: z.number().int().min(5).max(30),
    videoBitsPerSecond: z.number().int().min(500000).max(12000000),
    audioBitsPerSecond: z.number().int().min(64000).max(256000),
    segmentTargetSeconds: z.number().int().min(5).max(30),
    nativeStills: z.boolean(),
  })
  .strict();
export const defaultCaptureProfile = {
  width: 1920,
  height: 1080,
  fps: 15,
  videoBitsPerSecond: 4000000,
  audioBitsPerSecond: 128000,
  segmentTargetSeconds: 30,
  nativeStills: true,
};
export const envelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: id,
    projectId: id,
    expectedStateVersion: counter,
    payload: z.unknown(),
  })
  .strict();

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  throw new Error("Unsupported canonical value");
}
