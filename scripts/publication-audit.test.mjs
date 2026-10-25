import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicationFile } from "./publication-audit.mjs";

test("publication scan rejects private material without returning credential values", () => {
  const fake = "AQ." + "DummyPublicationScannerFixture_1234567890";
  const findings = inspectPublicationFile("src/example.ts", Buffer.from(fake));
  assert.deepEqual(findings, ["Google dotted key"]);
  assert.equal(JSON.stringify(findings).includes(fake), false);
  assert.ok(
    inspectPublicationFile("artifacts/data.txt", Buffer.from("safe")).length,
  );
  assert.ok(inspectPublicationFile(".env.local", Buffer.from("safe")).length);
  assert.ok(inspectPublicationFile("recording.webm", Buffer.alloc(4)).length);
});

test("publication scan accepts ordinary code and small documentation images", () => {
  assert.deepEqual(
    inspectPublicationFile("src/main.tsx", Buffer.from("const version = 1;")),
    [],
  );
  assert.deepEqual(
    inspectPublicationFile("docs/image.png", Buffer.from([137, 80, 78, 71, 0])),
    [],
  );
});
