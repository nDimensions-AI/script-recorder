import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createRequire } from "node:module";
import { WebinarStore } from "./store";
import { EvidenceService } from "./evidence";
import { GenerationService } from "./generation";
import { WordExporter, durationSeconds } from "./export";
import { uid, now, digest } from "./core";
import { WebinarEngine } from "./engine";
import { mergeThreeWay } from "../../common/webinar/merge";

const require = createRequire(import.meta.url),
  AdmZip = require("adm-zip");
const settings = {
  modelId: "fixture-model",
  inputMicrousdPerMillion: 1000000,
  outputMicrousdPerMillion: 1000000,
  maxInputTokens: 16000,
  maxOutputTokens: 2048,
  maxImages: 12,
  maxRequestBytes: 1000000,
  timeoutMs: 5000,
  rateCardId: "fixture-only",
};
export async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "webinar-workflow-")),
    store = new WebinarStore(root, path.resolve("electron/webinar/migrations"));
  const context = {
    title: "Code demonstration",
    narrator: "CharanTheAiGuy",
    audience: "Developers",
    objective: "Explain a failed command and a corrected command",
    targetDurationSeconds: 1800,
    language: "en" as const,
    glossary: [],
  };
  const projectId = store.create({ context, budgetMicrousd: 1000000 }),
    db = store.db(projectId),
    recordingId = uid(),
    spanId = uid(),
    evidenceId = uid(),
    presenter = uid();
  db.run(
    "INSERT INTO recordings VALUES(?,?,'Captured',1,'{}',?,?,?)",
    recordingId,
    "Charan",
    now(),
    now(),
    10000000,
  );
  db.run(
    "INSERT INTO presenters VALUES(?,?,130,1)",
    presenter,
    "CharanTheAiGuy",
  );
  db.run(
    "INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)",
    spanId,
    recordingId,
    0,
    9000000,
    "The first command failed. Change 41 to 42, then rerun.",
    "fixture",
    "a".repeat(64),
    "[]",
  );
  const image = await sharp({
      create: { width: 640, height: 360, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer(),
    raw = store.asset(projectId, image, "frame", "image/png", {
      width: 640,
      height: 360,
    });
  db.run(
    "INSERT INTO evidence VALUES(?,?,?,?,?,?)",
    evidenceId,
    recordingId,
    raw.id,
    3000000,
    "marker",
    "{}",
  );
  const evidence = new EvidenceService(store),
    derivative = await evidence.derive(projectId, evidenceId, {
      crop: { x: 10, y: 10, width: 600, height: 300 },
      masks: [{ x: 20, y: 20, width: 80, height: 40 }],
      fill: "#000000",
      transformVersion: "1",
    });
  const preview = await evidence.prepare(
      projectId,
      [derivative.id],
      digest(settings),
      [spanId],
    ),
    manifest = evidence.approve(projectId, preview);
  return {
    root,
    store,
    projectId,
    db,
    recordingId,
    spanId,
    evidenceId,
    presenter,
    derivative,
    evidence,
    manifest,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function response(output: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify(output) }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 300,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 20,
      },
    }),
  );
}
test("solid masks apply before cropping and manifest revocation blocks descendants", async () => {
  const f = await fixture();
  try {
    const { data, info } = await sharp(
      f.store.assetBytes(f.projectId, f.derivative.assetId),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 600);
    assert.equal(data[(20 * 600 + 20) * info.channels], 0);
    assert.equal(data[0], 255);
    const child = await f.evidence.descendant(
      f.projectId,
      f.manifest,
      '{"summary":"approved evidence"}',
      uid(),
    );
    assert.equal(child.parentManifestHash, f.manifest.hash);
    f.db.run(
      "UPDATE upload_manifests SET revoked_at=? WHERE id=?",
      now(),
      f.manifest.id,
    );
    assert.throws(
      () => f.evidence.get(f.projectId, child.id, digest(settings)),
      /Approve current/,
    );
  } finally {
    f.close();
  }
});
test("selected evidence produces a source-linked proposal and self-contained approved Word", async () => {
  const f = await fixture();
  try {
    const bodies: any[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      assert.equal(
        String(url).startsWith("https://generativelanguage.googleapis.com/"),
        true,
      );
      assert.equal(body.tools, undefined);
      if (String(url).endsWith(":countTokens"))
        return new Response('{"totalTokens":900}');
      if (body.systemInstruction.parts[0].text.includes("Extract demonstrated"))
        return response({
          steps: [
            {
              localId: "one",
              title: "Correct and rerun",
              action: "Replace 41 with 42.",
              narration: "The first attempt failed.",
              outcome: "The corrected command was run.",
              imageIds: [f.derivative.id],
              textIds: [f.manifest.texts[0].textId],
              uncertainty: "Verify the outcome on screen.",
              takeGroup: null,
            },
          ],
        });
      return response({
        lines: [
          {
            localId: "one",
            spoken:
              "The first command failed. We change 41 to 42 and try again.",
          },
        ],
      });
    };
    const generation = new GenerationService(f.store, f.evidence, fetcher),
      job = f.store.claim(
        f.projectId,
        f.store.newJob(f.projectId, "compose", { manifest: f.manifest.id }),
      );
    const revision = await generation.generate(
      f.projectId,
      job,
      f.manifest.id,
      settings,
      "fixture-key-not-real",
      new AbortController().signal,
    );
    assert.equal(bodies.length, 4);
    assert(!JSON.stringify(bodies).includes("video/webm"));
    assert(!JSON.stringify(bodies).includes("audio/webm"));
    assert.equal(f.db.all("SELECT * FROM upload_manifests").length, 2);
    const doc = structuredClone(revision.document);
    for (const s of doc.sections) {
      s.presenterId = f.presenter;
      s.assignment = "confirmed";
      for (const b of s.blocks) b.requiresTechnicalVerification = false;
    }
    const reviewed = f.store.save(f.projectId, doc, revision.id);
    const exporter = new WordExporter(f.store);
    await assert.rejects(
      () => exporter.render(f.projectId, reviewed.id, "ready"),
      /Approve/,
    );
    f.store.approve(
      f.projectId,
      reviewed.id,
      f.store.dependencyHash(f.projectId, reviewed.id),
    );
    const output = await exporter.render(f.projectId, reviewed.id, "ready"),
      bytes = f.store.assetBytes(f.projectId, output.assetId),
      zip = new AdmZip(bytes);
    assert(zip.readAsText("word/document.xml").includes("APPROVED"));
    assert(zip.readAsText("word/document.xml").includes("CharanTheAiGuy"));
    assert(
      zip
        .getEntries()
        .some(
          (e: any) =>
            e.entryName.startsWith("word/media/") &&
            e
              .getData()
              .equals(f.store.assetBytes(f.projectId, f.derivative.assetId)),
        ),
    );
    assert(durationSeconds(doc) > 0);
    if (process.env.WEBINAR_EXPORT_FIXTURE)
      writeFileSync(process.env.WEBINAR_EXPORT_FIXTURE, bytes);
    const backup = path.join(f.root, "backup");
    f.store.backup(f.projectId, backup);
    const restored = f.store.restore(backup);
    assert.notEqual(restored.projectId, f.projectId);
    assert.equal(f.store.snapshot(restored.projectId).approval, undefined);
    assert.equal(
      f.store.snapshot(restored.projectId).head?.document.projectId,
      restored.projectId,
    );
    assert.equal(
      readFileSync(path.join(backup, "backup.json")).length > 0,
      true,
    );
  } finally {
    f.close();
  }
});
test("unknown network outcome retains its charge; revoked evidence sends zero requests", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (url) => {
      calls++;
      if (String(url).endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      throw new Error("connection lost");
    };
    const g = new GenerationService(f.store, f.evidence, fetcher),
      job = f.store.claim(
        f.projectId,
        f.store.newJob(f.projectId, "compose", {}),
      );
    await assert.rejects(
      () =>
        g.generate(
          f.projectId,
          job,
          f.manifest.id,
          settings,
          "fixture-key-not-real",
          new AbortController().signal,
        ),
      /uncertain/,
    );
    assert.equal(
      f.store.catalog.all("SELECT * FROM provider_requests")[0].accounting,
      "Unknown",
    );
    assert.equal(calls, 2);
    f.store.invalidate(f.db);
    calls = 0;
    await assert.rejects(
      () =>
        g.generate(
          f.projectId,
          job,
          f.manifest.id,
          settings,
          "fixture-key-not-real",
          new AbortController().signal,
        ),
      /Approve/,
    );
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});
test("unknown reference IDs and expired monotonic leases are rejected", async () => {
  const f = await fixture();
  try {
    const g = new GenerationService(f.store, f.evidence);
    assert.throws(
      () =>
        g.validateSteps(
          {
            steps: [
              {
                localId: "x",
                title: "x",
                action: "x",
                narration: "x",
                outcome: null,
                imageIds: [uid()],
                textIds: [f.manifest.texts[0].textId],
                uncertainty: null,
                takeGroup: null,
              },
            ],
          },
          [f.manifest.texts[0].textId],
          [f.derivative.id],
        ),
      /outside/,
    );
    const job = f.store.claim(
      f.projectId,
      f.store.newJob(f.projectId, "inspect", {}),
    );
    f.store.leaseDeadlines.set(job.lease_token, 0);
    assert.equal(f.store.leaseValid(f.projectId, job), false);
    assert.throws(() => f.store.heartbeat(f.projectId, job), /expired/);
  } finally {
    f.close();
  }
});

test("oversized packets subdivide at source boundaries with exactly one owner per step", async () => {
  const f = await fixture();
  try {
    const second = uid();
    f.db.run(
      "UPDATE recordings SET duration_us=60000000 WHERE id=?",
      f.recordingId,
    );
    f.db.run(
      "INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)",
      second,
      f.recordingId,
      30000000,
      50000000,
      "Now verify the corrected command.",
      "fixture",
      "b".repeat(64),
      "[]",
    );
    const manifest = f.evidence.approve(
      f.projectId,
      await f.evidence.prepare(
        f.projectId,
        [f.derivative.id],
        digest(settings),
        [f.spanId, second],
      ),
    );
    let dispatches = 0,
      oversized = 0;
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)),
        content = body.generateContentRequest ?? body,
        packet = JSON.parse(content.contents[0].parts[0].text);
      if (String(url).endsWith(":countTokens")) {
        if (packet.ownedTextIds?.length > 1) {
          oversized++;
          return new Response('{"totalTokens":999999}');
        }
        return new Response('{"totalTokens":100}');
      }
      dispatches++;
      if (packet.ownedTextIds)
        return response({
          steps: packet.ownedTextIds.map((textId: string) => ({
            localId: textId,
            title: "Verify code",
            action: "Inspect the result.",
            narration: "Verify the command.",
            outcome: null,
            imageIds: [],
            textIds: [textId],
            uncertainty: null,
            takeGroup: null,
          })),
        });
      return response({
        lines: packet.steps.steps.map((s: any) => ({
          localId: s.localId,
          spoken: "Inspect the demonstrated result.",
        })),
      });
    };
    const service = new GenerationService(f.store, f.evidence, fetcher),
      job = f.store.claim(
        f.projectId,
        f.store.newJob(f.projectId, "compose", { manifest: manifest.id }),
      );
    const revision = await service.generate(
      f.projectId,
      job,
      manifest.id,
      settings,
      "fixture-key-not-real",
      new AbortController().signal,
    );
    assert.equal(oversized, 1);
    assert.equal(dispatches, 4);
    assert.equal(revision.document.sections.length, 2);
    assert.equal(
      new Set(revision.document.sections.map((s) => s.blocks[0].refs[0].id))
        .size,
      2,
    );
  } finally {
    f.close();
  }
});

test("confirmed billing reconciliation survives deletion and rejects conflicting replay", async () => {
  const f = await fixture();
  try {
    const request = f.store.reserve(
      f.projectId,
      uid(),
      1,
      "a".repeat(64),
      "b".repeat(64),
      settings,
    );
    f.store.dispatched(request);
    f.store.settle(request, null, settings);
    f.store.delete(f.projectId);
    assert.throws(
      () => f.store.reconcileCharge(f.projectId, request, 0, "guess"),
      /billing evidence/,
    );
    f.store.reconcileCharge(
      f.projectId,
      request,
      321,
      "Provider invoice reference TEST-42 confirms the charge.",
    );
    assert.equal(
      f.store.catalog.get(
        "SELECT charged_microusd FROM provider_requests WHERE id=?",
        request,
      )?.charged_microusd,
      321,
    );
    assert.throws(
      () =>
        f.store.reconcileCharge(
          f.projectId,
          request,
          0,
          "A different confirmed invoice.",
        ),
      /already reconciled/,
    );
  } finally {
    f.close();
  }
});

test("export publication recovers after rename and never replaces modified external files", async () => {
  const f = await fixture();
  try {
    const engine = new WebinarEngine(f.store, async () => {}),
      revision = engine.manual(f.projectId),
      output = await new WordExporter(f.store).render(
        f.projectId,
        revision.id,
        "draft",
      );
    const destination = path.join(f.root, "saved.docx");
    await engine.handle("export.destination", {
      projectId: f.projectId,
      exportId: output.exportId,
      destination,
    });
    writeFileSync(destination, "Someone else changed this file.");
    f.store.recoverExports(f.projectId);
    assert.equal(
      f.db.get("SELECT state FROM exports WHERE id=?", output.exportId)?.state,
      "Rendered",
    );
    assert.equal(
      readFileSync(destination, "utf8"),
      "Someone else changed this file.",
    );
    writeFileSync(destination, f.store.assetBytes(f.projectId, output.assetId));
    f.store.recoverExports(f.projectId);
    assert.equal(
      f.db.get("SELECT state FROM exports WHERE id=?", output.exportId)?.state,
      "Published",
    );
  } finally {
    f.close();
  }
});

test("three-way merge preserves overlapping user edits and carries independent changes", async () => {
  const f = await fixture();
  try {
    const engine = new WebinarEngine(f.store, async () => {}),
      base = engine.manual(f.projectId).document,
      current = structuredClone(base),
      proposal = structuredClone(base);
    current.sections[0].blocks[0].text = "My verified wording";
    proposal.sections[0].blocks[0].text = "AI rewritten wording";
    proposal.sections[0].title = "Independent title update";
    const result = mergeThreeWay(base, current, proposal);
    assert.equal(
      result.document.sections[0].blocks[0].text,
      "My verified wording",
    );
    assert.equal(result.document.sections[0].title, "Independent title update");
    assert.equal(result.conflicts.length, 1);
    proposal.sections = [];
    assert.equal(
      mergeThreeWay(base, current, proposal).document.sections.length,
      1,
    );
    assert.equal(
      mergeThreeWay(base, base, proposal).document.sections.length,
      0,
    );
  } finally {
    f.close();
  }
});

test("large transcripts page without truncating manual script coverage", async () => {
  const f = await fixture();
  try {
    f.db.run(
      "UPDATE recordings SET duration_us=3600000000 WHERE id=?",
      f.recordingId,
    );
    f.db.tx(() => {
      for (let i = 1; i <= 240; i++)
        f.db.run(
          "INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)",
          uid(),
          f.recordingId,
          i * 10000000,
          i * 10000000 + 5000000,
          `Narrated action ${i}`,
          "fixture",
          "a".repeat(64),
          "[]",
        );
    });
    const page = f.store.snapshot(f.projectId, {
      evidenceOffset: 0,
      transcriptOffset: 200,
      limit: 100,
    });
    assert.equal(page.transcript.length, 41);
    assert.equal(page.counts.transcript, 241);
    const document = new WebinarEngine(f.store, async () => {}).manual(
      f.projectId,
    ).document;
    assert(document.sections.length < 200);
    assert.equal(document.sections.flatMap((s) => s.blocks).length, 241);
  } finally {
    f.close();
  }
});

test("restart fences composition packets with an unobserved provider outcome", async () => {
  const f = await fixture();
  let reopened: WebinarStore | undefined;
  try {
    const job = f.store.claim(
      f.projectId,
      f.store.newJob(f.projectId, "composePacket", { fixture: "restart" }),
    );
    const request = f.store.reserve(
      f.projectId,
      job.id,
      1,
      "a".repeat(64),
      "b".repeat(64),
      settings,
    );
    f.store.dispatched(request);
    f.store.close();
    reopened = new WebinarStore(
      f.root,
      path.resolve("electron/webinar/migrations"),
    );
    assert.equal(
      reopened.db(f.projectId).get("SELECT state FROM jobs WHERE id=?", job.id)
        ?.state,
      "WaitingForReview",
    );
    assert.equal(
      reopened.catalog.get(
        "SELECT accounting FROM provider_requests WHERE id=?",
        request,
      )?.accounting,
      "Unknown",
    );
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reapproved unchanged evidence reuses validated packets without another billable call", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      const packet = JSON.parse(
        JSON.parse(String(init?.body)).contents[0].parts[0].text,
      );
      return packet.ownedTextIds
        ? response({
            steps: [
              {
                localId: "one",
                title: "Verify",
                action: "Inspect command.",
                narration: "Inspect the command.",
                outcome: null,
                imageIds: [],
                textIds: [packet.ownedTextIds[0]],
                uncertainty: null,
                takeGroup: null,
              },
            ],
          })
        : response({
            lines: [{ localId: "one", spoken: "Inspect the command." }],
          });
    };
    const service = new GenerationService(f.store, f.evidence, fetcher);
    const run = (manifestId: string) =>
      service.generate(
        f.projectId,
        f.store.claim(
          f.projectId,
          f.store.newJob(f.projectId, "compose", { manifestId }),
        ),
        manifestId,
        settings,
        "fixture-key-not-real",
        new AbortController().signal,
      );
    const first = await run(f.manifest.id);
    assert.equal(calls, 4);
    f.store.invalidate(f.db);
    const reapproved = f.evidence.approve(
      f.projectId,
      await f.evidence.prepare(
        f.projectId,
        [f.derivative.id],
        digest(settings),
        [f.spanId],
      ),
    );
    const next = await run(reapproved.id);
    assert.equal(calls, 4);
    assert.equal(next.document.sections[0].id, first.document.sections[0].id);
    assert.equal(
      next.document.sections[0].blocks[0].id,
      first.document.sections[0].blocks[0].id,
    );
    assert.equal(next.document.sections[0].blocks[0].stepRefs[0].version, 2);
    assert.equal(f.store.meta(f.projectId).head_revision_id, first.id);
  } finally {
    f.close();
  }
});

test("evidence expansion retrieves at most two local candidates without broadening uploads", async () => {
  const f = await fixture();
  try {
    let expansions = 0;
    const outbound: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      outbound.push(String(init?.body));
      if (String(url).endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      const packet = JSON.parse(
        JSON.parse(String(init?.body)).contents[0].parts[0].text,
      );
      return packet.ownedTextIds
        ? response({
            steps: [
              {
                localId: "one",
                title: "Check result",
                action: "Inspect the result.",
                narration: "The result needs inspection.",
                outcome: null,
                imageIds: [],
                textIds: [packet.ownedTextIds[0]],
                uncertainty: "Missing screenshot coverage",
                takeGroup: null,
              },
            ],
            coverageRequests: [
              {
                startUs: 1000000,
                endUs: 2000000,
                reason: "Inspect the failed attempt",
              },
              {
                startUs: 4000000,
                endUs: 5000000,
                reason: "Inspect the correction",
              },
            ],
          })
        : response({
            lines: [
              {
                localId: "one",
                spoken: "Inspect the result before confirming it.",
              },
            ],
          });
    };
    const service = new GenerationService(
      f.store,
      f.evidence,
      fetcher,
      async () => {
        expansions++;
        return {
          evidenceId: uid(),
          privateFixture: "NEVER_SEND_THIS_RAW_FRAME",
        };
      },
    );
    const run = (manifestId: string) =>
      service.generate(
        f.projectId,
        f.store.claim(
          f.projectId,
          f.store.newJob(f.projectId, "compose", { manifestId }),
        ),
        manifestId,
        settings,
        "fixture-key-not-real",
        new AbortController().signal,
      );
    const result = await run(f.manifest.id);
    assert.equal(expansions, 2);
    assert(
      f.db.get(
        "SELECT id FROM review_flags WHERE revision_id=? AND code='EVIDENCE_EXPANSION'",
        result.id,
      ),
    );
    const approved = f.evidence.approve(
      f.projectId,
      await f.evidence.prepare(
        f.projectId,
        [f.derivative.id],
        digest(settings),
        [f.spanId],
      ),
    );
    await run(approved.id);
    assert.equal(expansions, 2);
    assert(!outbound.join("").includes("NEVER_SEND_THIS_RAW_FRAME"));
  } finally {
    f.close();
  }
});

test("a busy speech-polishing service preserves a reviewable draft and uncertain cost reservation", async () => {
  const f = await fixture();
  try {
    let generationCalls = 0;
    const service = new GenerationService(
      f.store,
      f.evidence,
      async (url, options) => {
        if (String(url).endsWith(":countTokens"))
          return new Response('{"totalTokens":100}');
        generationCalls++;
        const packet = JSON.parse(
          JSON.parse(String(options?.body)).contents[0].parts[0].text,
        );
        if (packet.ownedTextIds)
          return response({
            steps: [
              {
                localId: "one",
                title: "Correct command",
                action: "Change 41 to 42.",
                narration: "The first attempt failed; change 41 to 42.",
                outcome: "The corrected command passed.",
                imageIds: [f.derivative.id],
                textIds: [packet.ownedTextIds[0]],
                uncertainty: null,
                takeGroup: null,
              },
            ],
          });
        return new Response("Temporary overload", { status: 503 });
      },
    );
    const job = f.store.claim(
        f.projectId,
        f.store.newJob(f.projectId, "compose", { manifest: f.manifest.id }),
      ),
      revision = await service.generate(
        f.projectId,
        job,
        f.manifest.id,
        settings,
        "fixture-key-not-real",
        new AbortController().signal,
      );
    assert.equal(generationCalls, 2);
    assert(
      revision.document.sections[0].blocks.some((b) =>
        b.text.includes("41 to 42"),
      ),
    );
    assert(
      f.db.get(
        "SELECT id FROM review_flags WHERE revision_id=? AND code='SPEECH_REVIEW'",
        revision.id,
      ),
    );
    assert(
      f.store.catalog.get(
        "SELECT id FROM provider_requests WHERE accounting='Unknown' AND charged_microusd IS NULL",
      ),
    );
    assert.equal(
      revision.document.sections[0].blocks.find((b) => b.kind === "show")
        ?.imageDerivativeIds[0],
      f.derivative.id,
    );
  } finally {
    f.close();
  }
});
