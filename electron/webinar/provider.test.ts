import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEBINAR_AI,
  webinarProviderSettings,
  webinarGenerationConfig,
  verifiedProvider,
} from "../../common/webinar/provider-profile";
import { connectProviderSchema, verifyProviderConnection } from "./provider";
import { stepsSchema } from "./generation";

const expected = {
  originalValue: 41,
  correctedValue: 42,
  firstAttempt: "failed",
  secondAttempt: "succeeded",
  screenshotSourceId: "sample-screen",
  transcriptSourceId: "sample-transcript",
};
const metadata = {
  name: `models/${WEBINAR_AI.modelId}`,
  supportedGenerationMethods: ["generateContent"],
  inputTokenLimit: 1048576,
  outputTokenLimit: 65536,
};
const response = (value: unknown) => new Response(JSON.stringify(value));
const completion = (value: unknown) =>
  response({
    modelVersion: WEBINAR_AI.modelId,
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(value) }] },
      },
    ],
  });

test("opaque auth keys accept periods and punctuation while rejecting header controls", () => {
  for (const key of [
    "AQ.fixture-auth-key.with-period_123",
    "AIzaFixtureLegacyKey_12345",
    "AQ.fixture+key/with=punctuation",
  ]) {
    assert.equal(connectProviderSchema.parse({ key: ` ${key} ` }).key, key);
  }
  for (const key of [
    "AQ.fixture key_123",
    "AQ.fixture\r\nInjected: header",
    "",
    "short",
  ]) {
    assert.equal(connectProviderSchema.safeParse({ key }).success, false);
  }
});

test("account connection preserves a new auth key and makes no billable generation request", async () => {
  const key = "AQ." + "DummyProviderFixture_1234567890";
  let calls = 0;
  const verified = await verifyProviderConnection(
    ` ${key} `,
    async (url, options) => {
      calls++;
      assert.equal(String(url).endsWith("/gemini-3.6-flash"), true);
      assert.equal(options?.method, "GET");
      assert.equal(
        (options?.headers as Record<string, string>)["x-goog-api-key"],
        key,
      );
      return response(metadata);
    },
    { checkEvidence: false },
  );
  assert.equal(calls, 1);
  assert.equal(verified.checkLevel, "access");
  assert(verifiedProvider(verified));
});

test("provider grammar is simplified while local output-size validation stays strict", () => {
  const schema = {
    type: "object",
    properties: {
      steps: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 200 },
            atUs: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    },
  };
  const serving = webinarGenerationConfig(webinarProviderSettings(), schema)
    .responseJsonSchema as any;
  assert.equal(serving.properties.steps.maxItems, undefined);
  assert.equal(
    serving.properties.steps.items.properties.atUs.maximum,
    undefined,
  );
  assert.equal(schema.properties.steps.maxItems, 100);
  assert.equal(serving.properties.steps.items.properties.name.type, "string");
  assert.equal(
    stepsSchema.safeParse({
      steps: Array.from({ length: 101 }, (_, i) => ({
        localId: String(i),
        title: "Step",
        action: "Run",
        narration: "Run",
        outcome: null,
        imageIds: [],
        textIds: ["source"],
        uncertainty: null,
        takeGroup: null,
      })),
    }).success,
    false,
  );
});

test("a generation timeout after accepted authentication is not presented as an invalid key", async () => {
  await assert.rejects(
    () =>
      verifyProviderConnection(
        "AQ." + "DummyProviderFixture_1234567890",
        async (url, options) => {
          if (options?.method === "GET") return response(metadata);
          if (String(url).endsWith(":countTokens"))
            return response({ totalTokens: 1400 });
          throw new DOMException("Timed out", "TimeoutError");
        },
      ),
    (error: any) => {
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      assert.match(error.message, /accepted your key/);
      return true;
    },
  );
});

test("the product selects the model and published effective pricing automatically", () => {
  const now = webinarProviderSettings(new Date("2026-12-31T23:59:59Z"));
  const next = webinarProviderSettings(new Date("2027-01-01T00:00:00Z"));
  assert.equal(now.modelId, "gemini-3.6-flash");
  assert.equal(now.inputMicrousdPerMillion, 750000);
  assert.equal(now.outputMicrousdPerMillion, 3750000);
  assert.equal(next.inputMicrousdPerMillion, 1500000);
  assert.equal(next.outputMicrousdPerMillion, 7500000);
  assert.notEqual(now.rateCardId, next.rateCardId);
  assert.throws(() =>
    connectProviderSchema.parse({ key: "fixture-key-123", settings: now }),
  );
  assert.equal(
    (webinarGenerationConfig(now, {}) as any).temperature,
    undefined,
  );
  assert.equal(
    webinarGenerationConfig(now, {}).thinkingConfig?.thinkingLevel,
    "low",
  );
});

test("connecting verifies access, token counting, image reading, JSON and source attribution", async () => {
  const requests: { url: string; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), body });
    assert.equal(init?.redirect, "error");
    assert(!String(url).includes("fixture-key"));
    if (!body) return response(metadata);
    if (String(url).endsWith(":countTokens"))
      return response({ totalTokens: 1400 });
    const parts = body.contents[0].parts;
    assert.equal(parts[1].inlineData.mimeType, "image/png");
    assert(
      Buffer.from(parts[1].inlineData.data, "base64")
        .subarray(1, 4)
        .equals(Buffer.from("PNG")),
    );
    // Answers must be read from pixels, rather than being leaked in text or schema.
    assert(!parts[0].text.includes("41"));
    assert(!parts[0].text.includes("42"));
    assert.equal(
      body.generationConfig.responseJsonSchema.properties.originalValue.const,
      undefined,
    );
    assert.equal(body.generationConfig.maxOutputTokens, 2048);
    return completion(expected);
  };
  const verified = await verifyProviderConnection("fixture-key-123", fetcher);
  assert(verifiedProvider(verified));
  assert.equal(requests.length, 3);
  assert(
    requests.every((r) =>
      r.url.startsWith(
        `https://generativelanguage.googleapis.com/v1beta/models/${WEBINAR_AI.modelId}`,
      ),
    ),
  );
  assert(!JSON.stringify(requests).includes("video/webm"));
  assert(!JSON.stringify(requests).includes("audio/webm"));
});

test("unavailable model access fails before a generation request", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      verifyProviderConnection("fixture-key-123", async () => {
        calls++;
        return response({
          ...metadata,
          supportedGenerationMethods: ["embedContent"],
        });
      }),
    /capabilities required/,
  );
  assert.equal(calls, 1);
});

test("a plausible but incorrect visual result does not pass connection qualification", async () => {
  await assert.rejects(
    () =>
      verifyProviderConnection("fixture-key-123", async (url, init) => {
        if (!init?.body) return response(metadata);
        if (String(url).endsWith(":countTokens"))
          return response({ totalTokens: 1400 });
        return completion({ ...expected, correctedValue: 43 });
      }),
    /did not pass/,
  );
});

test("provider errors stay actionable and never echo keys or untrusted error bodies", async () => {
  await assert.rejects(
    () =>
      verifyProviderConnection(
        "fixture-key-123",
        async () =>
          new Response("fixture-key-123 and provider internals", {
            status: 403,
          }),
      ),
    (error: any) => {
      assert.equal(error.code, "PROVIDER_AUTH");
      assert(error.message.includes("permissions"));
      assert(!error.message.includes("fixture-key"));
      assert(!error.message.includes("internals"));
      return true;
    },
  );
  await assert.rejects(
    () =>
      verifyProviderConnection("fixture-key-123", async () => {
        throw new Error("fixture-key-123");
      }),
    /internet connection/,
  );
});

test("legacy manual settings do not count as a verified managed connection", () => {
  assert.equal(
    verifiedProvider({ settings: webinarProviderSettings() }),
    false,
  );
  assert.equal(
    verifiedProvider({
      modelId: "another-model",
      qualificationVersion: WEBINAR_AI.qualificationVersion,
      checkedAt: new Date().toISOString(),
    }),
    false,
  );
});
