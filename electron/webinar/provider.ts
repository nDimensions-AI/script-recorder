import sharp from "sharp";
import { z } from "zod";
import {
  WEBINAR_AI,
  webinarProviderSettings,
  webinarGenerationConfig,
  type ProviderVerification,
} from "../../common/webinar/provider-profile";
import { assert, DomainError } from "./core";

export const connectProviderSchema = z
  .object({
    // Credentials are opaque. Google auth keys contain punctuation (for example AQ.).
    // Reject control characters and embedded whitespace, not legitimate key formats.
    key: z
      .string()
      .trim()
      .min(10)
      .max(1000)
      .regex(/^[\x21-\x7E]+$/)
      .optional(),
  })
  .strict();

const sampleSchema = z
  .object({
    originalValue: z.number().int(),
    correctedValue: z.number().int(),
    firstAttempt: z.enum(["failed", "succeeded"]),
    secondAttempt: z.enum(["failed", "succeeded"]),
    screenshotSourceId: z.string(),
    transcriptSourceId: z.string(),
  })
  .strict();

async function readJson(response: Response): Promise<any> {
  assert(
    response.body,
    "PROVIDER_UNAVAILABLE",
    "Gemini returned an empty response. Try connecting again.",
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const bytes of response.body as any) {
      size += bytes.length;
      assert(
        size <= 1024 * 1024,
        "OUTPUT_INVALID",
        "Gemini returned an unexpected response. Try connecting again.",
      );
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "PROVIDER_UNAVAILABLE",
      "The Gemini response was interrupted. Check your connection and retry.",
    );
  }
}

export async function verifyProviderConnection(
  key: string,
  fetcher: typeof fetch = fetch,
  options: { checkEvidence?: boolean } = {},
): Promise<ProviderVerification> {
  key = connectProviderSchema.parse({ key }).key!;
  const settings = webinarProviderSettings();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${WEBINAR_AI.modelId}`;
  const signal = AbortSignal.timeout(45000);
  const request = async (suffix: string, body?: unknown) => {
    let response: Response;
    try {
      response = await fetcher(endpoint + suffix, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-goog-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error as Error).name === "TimeoutError")
        throw new DomainError(
          "PROVIDER_TIMEOUT",
          suffix === ":generateContent"
            ? "Google accepted your key, but Gemini took too long to generate the evidence check. Try again later."
            : "Google took too long to respond to the connection check. Try connecting again.",
        );
      throw new DomainError(
        "PROVIDER_UNAVAILABLE",
        suffix === ":generateContent"
          ? "Google accepted your key, but the Gemini generation request was interrupted. Try again."
          : "Could not reach Gemini. Check your internet connection and try again.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 400 && body !== undefined
          ? "Gemini rejected the app’s connection check. Update the app or contact nDimensions.AI support."
          : response.status === 400 || response.status === 401
            ? "Gemini could not accept this API key. Copy a valid key from Google AI Studio and try again."
            : response.status === 403
              ? "This key cannot access Gemini. Check its Google AI Studio project permissions and regional availability."
              : response.status === 404
                ? "The supported Gemini model is unavailable for this account. Update the app or check your Google AI Studio access."
                : response.status === 429
                  ? "Gemini has reached this account’s quota. Check its quota or billing in Google AI Studio, then retry."
                  : "Gemini is temporarily unavailable. Please try connecting again.";
      throw new DomainError(
        response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_AUTH",
        message,
      );
    }
    return readJson(response);
  };

  const model = await request("");
  assert(
    model.name === `models/${WEBINAR_AI.modelId}` &&
      model.supportedGenerationMethods?.includes("generateContent") &&
      model.inputTokenLimit >= settings.maxInputTokens &&
      model.outputTokenLimit >= settings.maxOutputTokens,
    "PROVIDER_UNAVAILABLE",
    "This Gemini account does not expose the capabilities required by the app.",
  );

  const verification = {
    modelId: WEBINAR_AI.modelId,
    qualificationVersion: WEBINAR_AI.qualificationVersion,
    checkedAt: new Date().toISOString(),
    modelVersion: String(model.version ?? WEBINAR_AI.modelId),
  };
  if (options.checkEvidence === false)
    return { ...verification, checkLevel: "access" };

  // A fixed public fixture checks vision, chronology, JSON and source IDs together.
  // It reads no project, recording, transcript or user screenshot.
  const png = await sharp(
    Buffer.from(
      `<svg width="768" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="768" height="300" fill="#18232f"/><g fill="white" font-family="monospace" font-size="32"><text x="30" y="62">SYNTHETIC CONNECTION TEST</text><text x="30" y="135">Attempt 1: value = 41   FAIL</text><text x="30" y="210">Attempt 2: value = 42   PASS</text></g></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const body = {
    systemInstruction: {
      parts: [
        {
          text: "Read this fixed connection-test evidence and return the requested JSON. Preserve the first failure and subsequent successful correction. Use exactly the supplied source IDs.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Screenshot source ID: sample-screen. Transcript source ID: sample-transcript. Narration: The first command failed. I corrected the value, ran it again and it passed. Read both displayed values and outcomes from the screenshot.",
          },
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
        ],
      },
    ],
    generationConfig: webinarGenerationConfig(
      { ...settings, maxOutputTokens: 2048 },
      z.toJSONSchema(sampleSchema),
    ),
  };
  const tokens = await request(":countTokens", {
    generateContentRequest: { model: `models/${WEBINAR_AI.modelId}`, ...body },
  });
  assert(
    Number.isSafeInteger(tokens.totalTokens) &&
      tokens.totalTokens > 0 &&
      tokens.totalTokens <= 4096,
    "OUTPUT_INVALID",
    "Gemini could not verify the small connection-test request. Please retry.",
  );
  const result = await request(":generateContent", body);
  const candidate = result.candidates?.[0];
  assert(
    candidate?.finishReason === "STOP",
    "OUTPUT_INVALID",
    "Gemini did not complete the built-in evidence check. Please retry.",
  );
  try {
    const text = candidate.content.parts
      .filter((p: any) => typeof p.text === "string" && !p.thought)
      .map((p: any) => p.text)
      .join("");
    const observed = sampleSchema.parse(JSON.parse(text));
    assert(
      observed.originalValue === 41 &&
        observed.correctedValue === 42 &&
        observed.firstAttempt === "failed" &&
        observed.secondAttempt === "succeeded" &&
        observed.screenshotSourceId === "sample-screen" &&
        observed.transcriptSourceId === "sample-transcript",
      "OUTPUT_INVALID",
      "Evidence check did not match its reference.",
    );
  } catch {
    throw new DomainError(
      "OUTPUT_INVALID",
      "Gemini did not pass the built-in screenshot and script check. Your previous connection has been kept. Try again.",
    );
  }
  return {
    ...verification,
    modelVersion: String(
      result.modelVersion ?? model.version ?? WEBINAR_AI.modelId,
    ),
    checkLevel: "evidence",
  };
}
