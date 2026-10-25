import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebinarStore } from "./store";
import { uid, contained, Db } from "./core";
import { DatabaseSync } from "node:sqlite";
import type { ScriptDocument } from "../../common/webinar/types";

const context = {
  title: "Webinar",
  narrator: "Charan",
  audience: "Developers",
  objective: "Demonstrate code",
  targetDurationSeconds: 1800,
  language: "en" as const,
  glossary: [],
};
test("failed migration rolls back completely and newer schemas are rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "webinar-migration-")),
    file = path.join(root, "project.sqlite"),
    schema = readFileSync("electron/webinar/migrations/project.sql", "utf8");
  try {
    assert.throws(() => new Db(file, schema + "\nTHIS IS NOT SQL;"));
    const inspected = new DatabaseSync(file);
    assert.equal(
      inspected.prepare("PRAGMA user_version").get()!.user_version,
      0,
    );
    assert.equal(
      inspected
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
        .get()!.n,
      0,
    );
    inspected.close();
    const migrated = new Db(file, schema);
    assert.equal(migrated.get("PRAGMA user_version")!.user_version, 1);
    migrated.close();
    assert.throws(
      () => new Db(file, schema + "\n-- changed migration"),
      /checksum/,
    );
    const newer = new DatabaseSync(file);
    newer.exec("PRAGMA user_version=2");
    newer.close();
    assert.throws(() => new Db(file, schema), /newer application/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "webinar-test-")),
    store = new WebinarStore(root, path.resolve("electron/webinar/migrations"));
  const projectId = store.create({ context, budgetMicrousd: 10000 });
  return {
    store,
    projectId,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function document(projectId: string): ScriptDocument {
  return {
    schemaVersion: 1,
    projectId,
    title: "Webinar",
    context,
    presenters: [],
    sections: [],
  };
}
test("mutations are idempotent and reject conflicting payloads and stale revisions", () => {
  const f = fixture();
  try {
    const request = uid(),
      payload = { title: "First" };
    let calls = 0;
    const first = f.store.mutate(
      f.projectId,
      request,
      "edit",
      payload,
      0,
      () => ({ n: ++calls }),
    );
    assert.deepEqual(
      f.store.mutate(f.projectId, request, "edit", payload, 0, () => ({
        n: ++calls,
      })),
      first,
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        f.store.mutate(
          f.projectId,
          request,
          "edit",
          { title: "Other" },
          1,
          () => null,
        ),
      /reused/,
    );
    assert.throws(
      () => f.store.mutate(f.projectId, uid(), "edit", {}, 0, () => null),
      /changed/,
    );
  } finally {
    f.close();
  }
});
test("revisions are immutable and background proposals do not replace edited heads", () => {
  const f = fixture();
  try {
    const first = f.store.save(f.projectId, document(f.projectId), null);
    const edited = f.store.save(
      f.projectId,
      { ...first.document, title: "User edit" },
      first.id,
    );
    const proposal = f.store.save(
      f.projectId,
      { ...first.document, title: "AI rewrite" },
      first.id,
      "generated",
    );
    assert.equal(f.store.meta(f.projectId).head_revision_id, edited.id);
    assert.equal(proposal.baseId, first.id);
    assert.throws(
      () => f.store.save(f.projectId, first.document, first.id),
      /changed/,
    );
    assert.throws(
      () =>
        f.store
          .db(f.projectId)
          .run(
            "UPDATE script_revisions SET document_json='{}' WHERE id=?",
            first.id,
          ),
      /new script revision/,
    );
  } finally {
    f.close();
  }
});
test("observed claims and foreign project references fail validation", () => {
  const f = fixture();
  try {
    const d = document(f.projectId);
    d.sections = [
      {
        id: uid(),
        title: "Demo",
        presenterId: null,
        assignment: "unassigned",
        handoffToPresenterId: null,
        blocks: [
          {
            id: uid(),
            kind: "say",
            text: "It succeeded",
            provenance: "observed",
            refs: [],
            stepRefs: [],
            imageDerivativeIds: [],
            timingGroup: uid(),
            timingMode: "serial",
            durationSeconds: 1,
            requiresTechnicalVerification: true,
          },
        ],
      },
    ];
    assert.throws(() => f.store.save(f.projectId, d, null), /need visual/);
    assert.throws(
      () => f.store.save(f.projectId, { ...d, projectId: uid() }, null),
      /Wrong project/,
    );
    assert.throws(
      () => contained(f.store.directory(f.projectId), "../outside"),
      /escapes/,
    );
  } finally {
    f.close();
  }
});
test("cancelled worker leases cannot publish", () => {
  const f = fixture();
  try {
    const id = f.store.newJob(f.projectId, "inspect", {}),
      job = f.store.claim(f.projectId, id);
    f.store.cancelJob(f.projectId, id);
    assert.throws(
      () => f.store.finishJob(f.projectId, job, { value: "late" }),
      /Stale/,
    );
  } finally {
    f.close();
  }
});
test("uncertain charges remain reserved and survive project deletion", () => {
  const f = fixture();
  try {
    const settings = {
      modelId: "test-model",
      inputMicrousdPerMillion: 1000000,
      outputMicrousdPerMillion: 1000000,
      maxInputTokens: 1000,
      maxOutputTokens: 256,
      maxImages: 4,
      maxRequestBytes: 100000,
      timeoutMs: 10000,
      rateCardId: "test",
    };
    const q = f.store.reserve(
      f.projectId,
      uid(),
      1,
      "manifest",
      "request",
      settings,
    );
    f.store.dispatched(q);
    f.store.settle(q, null, settings);
    assert.equal(
      f.store.catalog.get(
        "SELECT accounting FROM provider_requests WHERE id=?",
        q,
      )!.accounting,
      "Unknown",
    );
    f.store.delete(f.projectId);
    assert.equal(
      f.store.catalog.get(
        "SELECT reserved_microusd FROM provider_requests WHERE id=?",
        q,
      )!.reserved_microusd,
      1256,
    );
    assert.throws(() => f.store.db(f.projectId), /unavailable/);
  } finally {
    f.close();
  }
});
test("asset hashes are checked before reuse", () => {
  const f = fixture();
  try {
    const a = f.store.asset(
      f.projectId,
      Buffer.from("original"),
      "job_output",
      "application/json",
    );
    assert.equal(f.store.assetBytes(f.projectId, a.id).toString(), "original");
    const record = f.store
      .db(f.projectId)
      .get("SELECT * FROM assets WHERE id=?", a.id)!;
    assert.equal(
      readFileSync(f.store.assetPath(f.projectId, a.id).filename).length,
      record.byte_length,
    );
  } finally {
    f.close();
  }
});
