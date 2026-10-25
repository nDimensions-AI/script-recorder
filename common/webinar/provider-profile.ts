import type { ProviderSettings } from "./schema";

// Product-owned selection. End users connect an account; they do not qualify models.
export const WEBINAR_AI = Object.freeze({
  provider: "Google Gemini",
  modelId: "gemini-3.6-flash",
  displayName: "Gemini 3.6 Flash",
  qualificationVersion: "webinar-account-access-v2",
  documentation:
    "https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash",
  pricingSource: "https://ai.google.dev/gemini-api/docs/pricing",
  reviewedAt: "2026-10-25",
  keyPage: "https://aistudio.google.com/apikey",
});

export function webinarProviderSettings(at = new Date()): ProviderSettings {
  const scheduledRates = at.getTime() >= Date.parse("2027-01-01T00:00:00Z");
  return {
    modelId: WEBINAR_AI.modelId,
    inputMicrousdPerMillion: scheduledRates ? 1500000 : 750000,
    outputMicrousdPerMillion: scheduledRates ? 7500000 : 3750000,
    rateCardId: scheduledRates
      ? "google-standard-2027-01-01"
      : "google-standard-2026-10-25",
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    maxImages: 12,
    maxRequestBytes: 18000000,
    timeoutMs: 120000,
  };
}

export function webinarGenerationConfig(
  settings: ProviderSettings,
  schema: Record<string, unknown>,
) {
  // Large nested array bounds create an unservable constrained-decoding grammar.
  // Send the structural shape; strict Zod bounds still validate every response locally.
  const localBounds = new Set([
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ]);
  const servingShape = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(servingShape)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !localBounds.has(key))
              .map(([key, child]) => [key, servingShape(child)]),
          )
        : value;
  return {
    responseMimeType: "application/json",
    responseJsonSchema: servingShape(schema) as Record<string, unknown>,
    maxOutputTokens: settings.maxOutputTokens,
    ...(settings.modelId === WEBINAR_AI.modelId
      ? { thinkingConfig: { thinkingLevel: "low" } }
      : {}),
    // Gemini 3 uses its provider-default temperature; low overrides impair reasoning.
  };
}

export interface ProviderVerification {
  modelId: string;
  qualificationVersion: string;
  checkedAt: string;
  modelVersion: string;
  checkLevel: "access" | "evidence";
}

export function verifiedProvider(
  value: unknown,
): value is ProviderVerification {
  const v = value as ProviderVerification | null;
  return (
    !!v &&
    v.modelId === WEBINAR_AI.modelId &&
    v.qualificationVersion === WEBINAR_AI.qualificationVersion &&
    ["access", "evidence"].includes(v.checkLevel) &&
    typeof v.checkedAt === "string" &&
    Number.isFinite(Date.parse(v.checkedAt))
  );
}
