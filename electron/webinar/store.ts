import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  copyFileSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  contextSchema,
  documentSchema,
  profileSchema,
  type ProviderSettings,
} from "../../common/webinar/schema";
import type {
  ProjectContext,
  ScriptDocument,
  RevisionSnapshot,
} from "../../common/webinar/types";
import {
  Db,
  assert,
  uid,
  now,
  digest,
  bytesHash,
  fileHash,
  contained,
  atomicFile,
  safeId,
  type Row,
} from "./core";

export class WebinarStore {
  catalog: Db;
  projects = new Map<string, Db>();
  bootId = uid();
  leaseDeadlines = new Map<string, number>();
  constructor(
    public root: string,
    public migrations: string,
  ) {
    mkdirSync(path.join(root, "projects"), { recursive: true });
    this.catalog = new Db(
      path.join(root, "catalog.sqlite"),
      readFileSync(path.join(migrations, "catalog.sql"), "utf8"),
    );
    for (const p of this.catalog.all(
      "SELECT * FROM project_registry WHERE lifecycle='Active'",
    )) {
      const filename = path.join(root, "projects", p.id, "project.sqlite");
      if (!existsSync(filename)) continue;
      const db = this.db(p.id);
      this.recoverSeals(p.id);
      this.recoverExports(p.id);
      db.run(
        "UPDATE intervals SET end_us=MAX(start_us,COALESCE((SELECT duration_us FROM recordings r WHERE r.id=intervals.recording_id),start_us)) WHERE end_us IS NULL",
      );
      db.run(
        "UPDATE recordings SET state='Incomplete',stopped_at=? WHERE state NOT IN ('Captured','Incomplete')",
        now(),
      );
      db.run(
        "UPDATE jobs SET state=CASE WHEN stage IN ('extractSteps','composePacket','compose') THEN 'WaitingForReview' ELSE 'Queued' END,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE state='Running'",
      );
    }
    this.catalog.run(
      "UPDATE provider_requests SET state='Unknown',accounting='Unknown' WHERE state='Dispatched'",
    );
    this.catalog.run(
      "UPDATE provider_requests SET state='Cancelled',accounting='Settled',charged_microusd=0 WHERE state='Prepared'",
    );
    for (const p of this.catalog.all(
      "SELECT id FROM project_registry WHERE lifecycle='Deleting'",
    ))
      this.completeDeletion(p.id);
  }
  directory(projectId: string) {
    return contained(this.root, path.join("projects", safeId(projectId)));
  }
  recoverExports(projectId: string) {
    const db = this.db(projectId);
    for (const row of db.all(
      "SELECT * FROM exports WHERE state='Rendered' AND destination_token IS NOT NULL",
    )) {
      try {
        const token = JSON.parse(row.destination_token);
        if (token.version !== 1 || !path.isAbsolute(token.path)) continue;
        if (existsSync(token.path) && fileHash(token.path) === token.hash)
          db.run("UPDATE exports SET state='Published' WHERE id=?", row.id);
      } catch {
        /* A missing or replaced external file is not overwritten during recovery. */
      }
    }
  }
  recoverSeals(projectId: string) {
    const db = this.db(projectId),
      staging = contained(this.directory(projectId), "staging");
    if (!existsSync(staging)) return;
    for (const name of readdirSync(staging).filter((n) =>
      n.endsWith(".sealed.json"),
    )) {
      const file = contained(staging, name);
      try {
        assert(
          statSync(file).size < 100000,
          "VALIDATION",
          "Invalid seal descriptor.",
        );
        const record = JSON.parse(readFileSync(file, "utf8"));
        assert(
          record.clock?.length === 10 && record.segment?.length === 11,
          "VALIDATION",
          "Invalid seal descriptor.",
        );
        const a = record.asset;
        assert(
          bytesHash(
            readFileSync(contained(this.directory(projectId), a.relative_path)),
          ) === a.sha256,
          "EVIDENCE_STALE",
          "Recovered segment checksum mismatch.",
        );
        db.tx(() => {
          if (!db.get("SELECT id FROM assets WHERE id=?", a.id))
            db.run(
              "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)",
              a.id,
              a.sha256,
              a.kind,
              a.relative_path,
              a.mime,
              a.byte_length,
              a.width,
              a.height,
              a.parent_asset_id,
              a.created_at,
            );
          db.run(
            "INSERT OR IGNORE INTO clock_maps VALUES(?,?,?,?,?,?,?,?,?,?)",
            ...record.clock,
          );
          db.run(
            "INSERT OR IGNORE INTO segments VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ...record.segment,
          );
          db.run(
            "UPDATE recordings SET duration_us=MAX(COALESCE(duration_us,0),?) WHERE id=?",
            record.segment[7],
            record.segment[1],
          );
        });
        unlinkSync(file);
      } catch {
        this.event(db, "recovery.quarantined", {
          reason:
            "A sealed sidecar could not be validated. The partial file remains local.",
        });
      }
    }
  }
  active(projectId: string): Row {
    const p = this.catalog.get(
      "SELECT * FROM project_registry WHERE id=?",
      safeId(projectId),
    );
    assert(
      p && p.lifecycle === "Active",
      "NOT_FOUND",
      "Project is unavailable.",
    );
    return p;
  }
  db(projectId: string): Db {
    this.active(projectId);
    let db = this.projects.get(projectId);
    if (!db) {
      const file = path.join(this.directory(projectId), "project.sqlite");
      assert(existsSync(file), "NOT_FOUND", "Project database is missing.");
      db = new Db(
        file,
        readFileSync(path.join(this.migrations, "project.sql"), "utf8"),
      );
      this.projects.set(projectId, db);
    }
    return db;
  }
  meta(projectId: string): Row {
    return this.db(projectId).get("SELECT * FROM project WHERE singleton=1")!;
  }
  create(input: { context: ProjectContext; budgetMicrousd: number }): string {
    const context = contextSchema.parse(input.context);
    assert(
      Number.isSafeInteger(input.budgetMicrousd) && input.budgetMicrousd >= 0,
      "VALIDATION",
      "Invalid project budget.",
    );
    const id = uid(),
      dir = this.directory(id);
    mkdirSync(dir, { recursive: true });
    for (const name of ["assets", "staging", "exports"])
      mkdirSync(path.join(dir, name));
    const db = new Db(
      path.join(dir, "project.sqlite"),
      readFileSync(path.join(this.migrations, "project.sql"), "utf8"),
    );
    db.run(
      "INSERT INTO project(singleton,id,title,context_json,policy_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?)",
      id,
      context.title,
      JSON.stringify(context),
      JSON.stringify({
        cloud: "selected_evidence",
        stages: ["extract", "compose"],
      }),
      now(),
      now(),
    );
    this.catalog.run(
      "INSERT INTO project_registry VALUES(?,?,'Active',0,?,?,?)",
      id,
      id,
      input.budgetMicrousd,
      now(),
      now(),
    );
    this.projects.set(id, db);
    return id;
  }
  list() {
    return this.catalog
      .all(
        "SELECT * FROM project_registry WHERE lifecycle<>'Deleted' ORDER BY created_at DESC",
      )
      .map((p) => ({
        id: p.id,
        lifecycle: p.lifecycle,
        title:
          p.lifecycle === "Active" &&
          existsSync(path.join(this.directory(p.id), "project.sqlite"))
            ? this.meta(p.id).title
            : "Deleting project",
      }));
  }
  snapshot(
    projectId: string,
    paging?: {
      evidenceOffset: number;
      transcriptOffset: number;
      limit: number;
    },
  ) {
    const db = this.db(projectId),
      m = this.meta(projectId),
      head = m.head_revision_id
        ? this.revision(projectId, m.head_revision_id)
        : null;
    const currentSteps = new Set(
      head?.document.sections.flatMap((s) =>
        s.blocks.flatMap((b) => b.stepRefs.map((r) => r.id)),
      ) ?? [],
    );
    return {
      projectId,
      stateVersion: m.state_version,
      sourceVersion: m.source_version,
      policyVersion: m.policy_version,
      context: JSON.parse(m.context_json),
      head,
      lastEventSequence: db.get(
        "SELECT COALESCE(MAX(sequence),0) AS n FROM events",
      )!.n,
      recordings: db.all(
        "SELECT r.*,EXISTS(SELECT 1 FROM transcript_spans t WHERE t.recording_id=r.id) AS has_transcript FROM recordings r ORDER BY started_at",
      ),
      presenters: db.all("SELECT * FROM presenters WHERE active=1"),
      markers: db.all("SELECT * FROM markers ORDER BY at_us"),
      takes: db
        .all(
          "SELECT * FROM take_groups t WHERE version=(SELECT MAX(version) FROM take_groups x WHERE x.id=t.id)",
        )
        .filter((t) =>
          JSON.parse(t.members_json).some((m: any) => currentSteps.has(m.id)),
        ),
      jobs: db.all(
        "SELECT id,stage,state,error_code FROM jobs ORDER BY created_at DESC LIMIT 100",
      ),
      transcript: db.all(
        `SELECT s.*,COALESCE((SELECT text FROM transcript_edits e WHERE e.span_id=s.id ORDER BY version DESC LIMIT 1),s.original_text) AS current_text FROM transcript_spans s ORDER BY recording_id,start_us LIMIT ? OFFSET ?`,
        paging?.limit ?? 100000,
        paging?.transcriptOffset ?? 0,
      ),
      evidence: db.all(
        "SELECT e.*,a.width,a.height,a.sha256 FROM evidence e JOIN assets a ON a.id=e.raw_asset_id ORDER BY e.recording_id,e.at_us LIMIT ? OFFSET ?",
        paging?.limit ?? 100000,
        paging?.evidenceOffset ?? 0,
      ),
      derivatives: db.all(
        "SELECT d.*,a.width,a.height,a.sha256 FROM derivatives d JOIN assets a ON a.id=d.asset_id ORDER BY d.created_at",
      ),
      manifests: db.all(
        "SELECT id,sha256,approved_at,revoked_at FROM upload_manifests ORDER BY approved_at DESC",
      ),
      flags: head
        ? db.all(
            "SELECT f.*, (SELECT decision FROM review_decisions d WHERE d.flag_id=f.id ORDER BY created_at DESC LIMIT 1) AS decision FROM review_flags f WHERE revision_id=?",
            head.id,
          )
        : [],
      proposals: db.all(
        "SELECT id,base_id,created_at FROM script_revisions WHERE origin='generated' AND id<>COALESCE(?, '') ORDER BY created_at DESC LIMIT 30",
        m.head_revision_id,
      ),
      approval: head
        ? db.get(
            "SELECT * FROM approvals WHERE revision_id=? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1",
            head.id,
          )
        : null,
      requests: this.catalog.all(
        "SELECT id,state,accounting,reserved_microusd,charged_microusd FROM provider_requests WHERE project_id=?",
        projectId,
      ),
      counts: {
        evidence: db.get("SELECT COUNT(*) AS n FROM evidence")!.n,
        transcript: db.get("SELECT COUNT(*) AS n FROM transcript_spans")!.n,
      },
      budgetMicrousd: this.active(projectId).budget_microusd,
    };
  }
  mutate<T>(
    projectId: string,
    requestId: string,
    method: string,
    payload: unknown,
    expected: number,
    fn: (db: Db) => T,
  ): T {
    const db = this.db(projectId);
    safeId(requestId);
    return db.tx(() => {
      const receipt = db.get(
          "SELECT * FROM operations WHERE request_id=?",
          requestId,
        ),
        h = digest(payload);
      if (receipt) {
        assert(
          receipt.method === method && receipt.payload_hash === h,
          "VALIDATION",
          "Request ID was reused.",
        );
        return JSON.parse(receipt.result_json);
      }
      assert(
        this.meta(projectId).state_version === expected,
        "CONFLICT",
        "Project changed. Refresh before saving.",
      );
      const value = fn(db);
      db.run(
        "UPDATE project SET state_version=state_version+1,updated_at=? WHERE singleton=1",
        now(),
      );
      db.run(
        "INSERT INTO operations VALUES(?,?,?,?,?)",
        requestId,
        method,
        h,
        JSON.stringify(value ?? null),
        now(),
      );
      this.event(db, method);
      return value;
    });
  }
  event(db: Db, kind: string, payload: unknown = {}) {
    db.run(
      "INSERT INTO events(kind,state_version,payload_json,created_at) VALUES(?,(SELECT state_version FROM project WHERE singleton=1),?,?)",
      kind,
      JSON.stringify(payload),
      now(),
    );
  }
  invalidate(db: Db, source = true) {
    if (source)
      db.run(
        "UPDATE project SET source_version=source_version+1 WHERE singleton=1",
      );
    db.run("UPDATE approvals SET revoked_at=? WHERE revoked_at IS NULL", now());
    if (source) {
      db.run(
        "UPDATE upload_manifests SET revoked_at=? WHERE revoked_at IS NULL",
        now(),
      );
      db.run(
        "UPDATE jobs SET state='Superseded',lease_token=NULL WHERE stage IN ('prepareEvidence','extractSteps','reconcile','compose','validate','export') AND state IN ('Queued','Running','WaitingForNetwork','WaitingForReview')",
      );
    }
  }
  asset(
    projectId: string,
    bytes: Uint8Array,
    kind: string,
    mime: string,
    dimensions?: { width: number; height: number },
    parent: string | null = null,
  ): Row {
    const db = this.db(projectId),
      id = uid(),
      sha = bytesHash(bytes),
      ext =
        mime === "image/png"
          ? "png"
          : mime === "image/jpeg"
            ? "jpg"
            : mime.includes("webm")
              ? "webm"
              : mime.includes("wordprocessingml")
                ? "docx"
                : "json";
    const relative = path.join("assets", sha.slice(0, 2), id + "." + ext),
      filename = contained(this.directory(projectId), relative);
    atomicFile(filename, bytes);
    const a = {
      id,
      sha256: sha,
      kind,
      relative_path: relative,
      mime,
      byte_length: bytes.byteLength,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      parent_asset_id: parent,
      created_at: now(),
    };
    atomicFile(filename + ".sealed.json", Buffer.from(JSON.stringify(a)));
    db.run(
      "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)",
      ...Object.values(a),
    );
    return a;
  }
  assetPath(
    projectId: string,
    assetId: string,
  ): { filename: string; asset: Row } {
    const a = this.db(projectId).get(
      "SELECT * FROM assets WHERE id=?",
      safeId(assetId),
    );
    assert(a, "NOT_FOUND", "Evidence is missing.");
    return {
      filename: contained(this.directory(projectId), a.relative_path),
      asset: a,
    };
  }
  assetFromFile(
    projectId: string,
    filename: string,
    kind: "video" | "audio",
    mime: string,
  ) {
    const db = this.db(projectId),
      id = uid(),
      sha = fileHash(filename),
      relative = path.join("assets", sha.slice(0, 2), id + ".webm"),
      target = contained(this.directory(projectId), relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(filename, target);
    assert(
      fileHash(target) === sha,
      "EVIDENCE_STALE",
      "Source file changed during import.",
    );
    const a = {
      id,
      sha256: sha,
      kind,
      relative_path: relative,
      mime,
      byte_length: statSync(target).size,
      width: null,
      height: null,
      parent_asset_id: null,
      created_at: now(),
    };
    atomicFile(target + ".sealed.json", Buffer.from(JSON.stringify(a)));
    db.run(
      "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)",
      ...Object.values(a),
    );
    return a;
  }
  assetBytes(projectId: string, assetId: string): Buffer {
    const { filename, asset } = this.assetPath(projectId, assetId);
    const bytes = readFileSync(filename);
    assert(
      bytesHash(bytes) === asset.sha256,
      "EVIDENCE_STALE",
      "Evidence changed on disk.",
    );
    return bytes;
  }
  revision(projectId: string, id: string): RevisionSnapshot {
    const r = this.db(projectId).get(
      "SELECT * FROM script_revisions WHERE id=?",
      safeId(id),
    );
    assert(r, "NOT_FOUND", "Revision is unavailable.");
    return {
      id: r.id,
      parentId: r.parent_id,
      baseId: r.base_id,
      contentHash: r.content_hash,
      sourceVersion: r.source_version,
      policyVersion: r.policy_version,
      document: documentSchema.parse(JSON.parse(r.document_json)),
      metadata: JSON.parse(r.metadata_json),
    };
  }
  validateDocument(projectId: string, input: unknown): ScriptDocument {
    const doc = documentSchema.parse(input);
    assert(doc.projectId === projectId, "FORBIDDEN", "Wrong project.");
    const db = this.db(projectId);
    for (const section of doc.sections)
      for (const block of section.blocks) {
        for (const image of block.imageDerivativeIds)
          assert(
            db.get("SELECT id FROM derivatives WHERE id=?", image),
            "VALIDATION",
            "Unknown screenshot.",
          );
        for (const ref of block.refs) {
          if (ref.kind === "image")
            assert(
              db.get("SELECT id FROM derivatives WHERE id=?", ref.id),
              "VALIDATION",
              "Unknown screenshot reference.",
            );
          else if (ref.kind === "transcript")
            assert(
              db.get("SELECT id FROM text_derivatives WHERE id=?", ref.id) ||
                db.get("SELECT id FROM transcript_spans WHERE id=?", ref.id),
              "VALIDATION",
              "Unknown transcript reference.",
            );
          else if (ref.kind === "terminal")
            assert(
              db.get(
                "SELECT id FROM text_derivatives WHERE id=? AND source_kind='terminal'",
                ref.id,
              ),
              "VALIDATION",
              "Unknown terminal reference.",
            );
          else
            assert(
              block.provenance === "user_supplied",
              "VALIDATION",
              "User references require user-supplied provenance.",
            );
          if (ref.source) {
            const r = db.get(
              "SELECT * FROM recordings WHERE id=?",
              ref.source.recordingId,
            );
            assert(
              r && ref.source.endUs <= r.duration_us,
              "VALIDATION",
              "Evidence time is outside the recording.",
            );
            if (ref.kind === "image") {
              const e = db.get(
                "SELECT e.* FROM evidence e JOIN derivatives d ON d.evidence_id=e.id WHERE d.id=?",
                ref.id,
              )!;
              assert(
                e.recording_id === ref.source.recordingId &&
                  ref.source.startUs === e.at_us &&
                  ref.source.endUs === e.at_us,
                "VALIDATION",
                "Screenshot timestamp does not match its source.",
              );
            }
            if (ref.kind === "transcript") {
              const t =
                db.get("SELECT * FROM transcript_spans WHERE id=?", ref.id) ??
                db.get(
                  "SELECT s.* FROM transcript_spans s JOIN text_derivatives d ON d.span_id=s.id WHERE d.id=?",
                  ref.id,
                );
              assert(
                t &&
                  t.recording_id === ref.source.recordingId &&
                  ref.source.startUs >= t.start_us &&
                  ref.source.endUs <= t.end_us,
                "VALIDATION",
                "Transcript timestamp does not match its source.",
              );
            }
          }
        }
        for (const step of block.stepRefs)
          assert(
            db.get(
              "SELECT id FROM steps WHERE id=? AND version=?",
              step.id,
              step.version,
            ),
            "VALIDATION",
            "Unknown step version.",
          );
        if (block.provenance === "observed")
          assert(
            block.refs.some((r) => r.kind === "image" || r.kind === "terminal"),
            "VALIDATION",
            "Observed statements need visual or terminal evidence.",
          );
        if (block.provenance === "narrated")
          assert(
            block.refs.some((r) => r.kind === "transcript"),
            "VALIDATION",
            "Narrated statements need transcript evidence.",
          );
      }
    return doc;
  }
  save(
    projectId: string,
    input: unknown,
    baseId: string | null,
    origin: "user" | "generated" | "merge" | "import" = "user",
  ): RevisionSnapshot {
    const doc = this.validateDocument(projectId, input),
      db = this.db(projectId),
      m = this.meta(projectId);
    if (origin !== "generated")
      assert(
        m.head_revision_id === baseId,
        "CONFLICT",
        "Script changed. Compare your edits with the current revision.",
      );
    if (baseId) {
      const base = this.revision(projectId, baseId);
      if (origin === "user" && base.sourceVersion !== m.source_version)
        for (const s of doc.sections)
          for (const b of s.blocks)
            if (b.refs.length) b.requiresTechnicalVerification = true;
    }
    const id = uid();
    db.run(
      "INSERT INTO script_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      m.head_revision_id,
      baseId,
      origin,
      JSON.stringify({
        predecessors: {},
        author: origin === "generated" ? "AI proposal" : "Editor",
      }),
      JSON.stringify(doc),
      digest(doc),
      m.source_version,
      m.policy_version,
      1,
      now(),
    );
    if (origin !== "generated" || !m.head_revision_id) {
      db.run("UPDATE project SET head_revision_id=? WHERE singleton=1", id);
      this.invalidate(db, false);
    }
    this.flagRevision(projectId, id, doc);
    return this.revision(projectId, id);
  }
  flagRevision(projectId: string, revisionId: string, doc: ScriptDocument) {
    const db = this.db(projectId);
    const flag = (subject: string, code: string, detail: string) =>
      db.run(
        "INSERT INTO review_flags VALUES(?,?,?,?,'blocking',?)",
        uid(),
        revisionId,
        subject,
        code,
        JSON.stringify({ message: detail }),
      );
    if (!doc.sections.length)
      flag(revisionId, "EMPTY_SCRIPT", "Add at least one section.");
    for (const section of doc.sections) {
      if (!section.presenterId || section.assignment !== "confirmed")
        flag(section.id, "PRESENTER_UNCONFIRMED", "Confirm a presenter.");
      for (const b of section.blocks) {
        if (b.requiresTechnicalVerification)
          flag(
            b.id,
            "TECHNICAL_VERIFICATION",
            "Verify technical details against source.",
          );
        if (
          b.kind === "producer" &&
          b.text.includes("Additional evidence review")
        )
          flag(
            b.id,
            "EVIDENCE_EXPANSION",
            "Review the requested source interval and confirm coverage before approval.",
          );
        if (b.kind === "producer" && b.text.startsWith("Speech review:"))
          flag(
            b.id,
            "SPEECH_REVIEW",
            "Review the spoken wording. The optional writing pass was unavailable.",
          );
      }
      if (
        !section.blocks.length ||
        section.blocks.every(
          (b) => !b.text.trim() && !b.imageDerivativeIds.length,
        )
      )
        flag(
          section.id,
          "EMPTY_SECTION",
          "Add useful script content or exclude this section.",
        );
    }
    if (db.get("SELECT id FROM recordings WHERE state='Incomplete' LIMIT 1"))
      flag(
        revisionId,
        "CAPTURE_INCOMPLETE",
        "Inspect missing capture intervals and confirm the script scope.",
      );
    const currentSteps = new Set(
      doc.sections.flatMap((s) =>
        s.blocks.flatMap((b) => b.stepRefs.map((r) => r.id)),
      ),
    );
    for (const take of db.all(
      "SELECT * FROM take_groups t WHERE selected_step_id IS NULL AND version=(SELECT MAX(version) FROM take_groups x WHERE x.id=t.id)",
    ))
      if (
        JSON.parse(take.members_json).filter((m: any) => currentSteps.has(m.id))
          .length > 1
      )
        flag(
          take.id,
          "TAKE_UNRESOLVED",
          "Select which take belongs in the live script.",
        );
    const referenced = new Set(
      doc.sections.flatMap((s) =>
        s.blocks.flatMap((b) =>
          b.refs
            .filter((r) => r.kind === "transcript")
            .map(
              (r) =>
                db.get("SELECT span_id FROM text_derivatives WHERE id=?", r.id)
                  ?.span_id ?? r.id,
            ),
        ),
      ),
    );
    const uncovered = db
      .all("SELECT id FROM transcript_spans")
      .filter((t) => !referenced.has(t.id));
    if (uncovered.length)
      flag(
        revisionId,
        "COVERAGE_REVIEW",
        `${uncovered.length} transcript passages are not represented. Review and explicitly exclude intentional omissions.`,
      );
  }
  dependencyHash(projectId: string, revisionId: string) {
    const r = this.revision(projectId, revisionId),
      db = this.db(projectId),
      m = this.meta(projectId);
    const imageIds = [
      ...new Set(
        r.document.sections.flatMap((s) =>
          s.blocks.flatMap((b) => b.imageDerivativeIds),
        ),
      ),
    ].sort();
    const images = imageIds.map((i) => {
      const d = db.get(
        "SELECT d.*,a.sha256 FROM derivatives d JOIN assets a ON a.id=d.asset_id WHERE d.id=?",
        i,
      );
      assert(d, "EVIDENCE_STALE", "Missing screenshot.");
      this.assetBytes(projectId, d.asset_id);
      return d;
    });
    return digest({
      revision: r.contentHash,
      images,
      sourceVersion: m.source_version,
      policyVersion: m.policy_version,
    });
  }
  approve(projectId: string, revisionId: string, hash: string) {
    const db = this.db(projectId),
      m = this.meta(projectId);
    assert(
      m.head_revision_id === revisionId,
      "CONFLICT",
      "Approve the current revision.",
    );
    const revision = this.revision(projectId, revisionId);
    assert(
      revision.sourceVersion === m.source_version &&
        revision.policyVersion === m.policy_version,
      "EVIDENCE_STALE",
      "Source changed since this revision. Review and save a new revision.",
    );
    const unresolved = db.all(
      `SELECT f.id FROM review_flags f WHERE revision_id=? AND severity='blocking' AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.flag_id=f.id AND d.decision IN ('verified','corrected','excluded'))`,
      revisionId,
    );
    assert(
      !unresolved.length,
      "VALIDATION",
      "Resolve blocking review items before approval.",
    );
    const actual = this.dependencyHash(projectId, revisionId);
    assert(actual === hash, "EVIDENCE_STALE", "Approval evidence changed.");
    const id = uid();
    db.run(
      "INSERT INTO approvals VALUES(?,?,?,?,?,NULL)",
      id,
      revisionId,
      actual,
      "Editor",
      now(),
    );
    return { approvalId: id };
  }
  resolveFlag(
    projectId: string,
    input: {
      flagId: string;
      revisionId: string;
      decision: string;
      reason: string;
      refs: unknown[];
    },
  ) {
    const db = this.db(projectId),
      flag = db.get(
        "SELECT * FROM review_flags WHERE id=? AND revision_id=?",
        input.flagId,
        input.revisionId,
      );
    assert(flag, "NOT_FOUND", "Review item not found.");
    assert(
      input.reason.trim().length >= 10,
      "VALIDATION",
      "Explain the review decision.",
    );
    assert(
      ["verified", "corrected", "excluded", "acknowledged"].includes(
        input.decision,
      ),
      "VALIDATION",
      "Invalid decision.",
    );
    assert(
      ![
        "PRESENTER_UNCONFIRMED",
        "EMPTY_SCRIPT",
        "EMPTY_SECTION",
        "TAKE_UNRESOLVED",
      ].includes(flag.code),
      "VALIDATION",
      "Update the script or select the take to resolve this issue.",
    );
    assert(
      !(flag.severity === "blocking" && input.decision === "acknowledged"),
      "VALIDATION",
      "Acknowledging a blocking issue does not resolve it.",
    );
    const id = uid();
    db.run(
      "INSERT INTO review_decisions VALUES(?,?,?,?,?,?)",
      id,
      input.flagId,
      input.decision,
      JSON.stringify({ reason: input.reason, refs: input.refs }),
      "Editor",
      now(),
    );
    return { decisionId: id };
  }
  newJob(
    projectId: string,
    stage: string,
    input: unknown,
    dependencies: string[] = [],
  ) {
    const db = this.db(projectId),
      generation = this.active(projectId).generation,
      key = digest({ stage, input, generation });
    const existing = db.get("SELECT * FROM jobs WHERE job_key=?", key);
    if (existing) return existing.id;
    const id = uid();
    db.tx(() => {
      db.run(
        "INSERT INTO jobs(id,job_key,stage,input_json,state,generation,created_at,updated_at) VALUES(?,?,?,?,'Queued',?,?,?)",
        id,
        key,
        stage,
        JSON.stringify(input),
        generation,
        now(),
        now(),
      );
      for (const d of dependencies) {
        assert(
          db.get("SELECT id FROM jobs WHERE id=?", d),
          "VALIDATION",
          "Missing job dependency.",
        );
        db.run("INSERT INTO job_dependencies VALUES(?,?)", id, d);
      }
    });
    return id;
  }
  claim(projectId: string, jobId: string): Row {
    const db = this.db(projectId);
    return db.tx(() => {
      const job = db.get("SELECT * FROM jobs WHERE id=?", safeId(jobId));
      assert(
        job && ["Queued", "WaitingForNetwork"].includes(job.state),
        "BUSY",
        "Job is not ready.",
      );
      assert(
        job.generation === this.active(projectId).generation,
        "CANCELLED",
        "Project generation changed.",
      );
      assert(
        !db.get(
          "SELECT 1 FROM job_dependencies d JOIN jobs j ON d.depends_on=j.id WHERE d.job_id=? AND j.state<>'Succeeded'",
          jobId,
        ),
        "BUSY",
        "Dependencies are unfinished.",
      );
      const lease = uid();
      this.leaseDeadlines.set(lease, performance.now() + 30000);
      db.run(
        "UPDATE jobs SET state='Running',attempt=attempt+1,lease_token=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        lease,
        this.bootId,
        new Date(Date.now() + 30000).toISOString(),
        now(),
        jobId,
      );
      return db.get("SELECT * FROM jobs WHERE id=?", jobId)!;
    });
  }
  leaseValid(projectId: string, job: Row) {
    const current = this.db(projectId).get(
      "SELECT * FROM jobs WHERE id=?",
      job.id,
    );
    return (
      !!current &&
      current.state === "Running" &&
      current.lease_token === job.lease_token &&
      current.lease_owner === this.bootId &&
      (this.leaseDeadlines.get(job.lease_token) ?? 0) > performance.now() &&
      current.generation === this.active(projectId).generation
    );
  }
  heartbeat(projectId: string, job: Row) {
    assert(
      this.leaseValid(projectId, job),
      "CANCELLED",
      "Job was cancelled, expired or superseded.",
    );
    this.leaseDeadlines.set(job.lease_token, performance.now() + 30000);
    this.db(projectId).run(
      "UPDATE jobs SET lease_until=? WHERE id=?",
      new Date(Date.now() + 30000).toISOString(),
      job.id,
    );
  }
  finishJob(projectId: string, job: Row, output: unknown) {
    assert(this.leaseValid(projectId, job), "CANCELLED", "Stale job result.");
    const a = this.asset(
      projectId,
      Buffer.from(JSON.stringify(output)),
      "job_output",
      "application/json",
    );
    const db = this.db(projectId);
    db.tx(() => {
      assert(this.leaseValid(projectId, job), "CANCELLED", "Stale job result.");
      db.run(
        "UPDATE jobs SET state='Succeeded',output_asset_id=?,lease_token=NULL,updated_at=? WHERE id=?",
        a.id,
        now(),
        job.id,
      );
      this.event(db, "job.changed", { id: job.id });
    });
    return output;
  }
  failJob(projectId: string, job: Row, code: string) {
    const db = this.db(projectId);
    if (this.leaseValid(projectId, job))
      db.run(
        "UPDATE jobs SET state=?,error_code=?,lease_token=NULL,updated_at=? WHERE id=?",
        [
          "PROVIDER_UNKNOWN",
          "MODEL_MISSING",
          "POLICY_DENIED",
          "OUTPUT_INVALID",
          "EVIDENCE_EXPANSION_REQUIRED",
        ].includes(code)
          ? "WaitingForReview"
          : "Failed",
        code,
        now(),
        job.id,
      );
  }
  cancelJob(projectId: string, jobId: string) {
    this.db(projectId).run(
      "UPDATE jobs SET state='Cancelled',lease_token=NULL,updated_at=? WHERE id=? AND state<>'Succeeded'",
      now(),
      safeId(jobId),
    );
    return { state: "Cancelled" };
  }
  reserve(
    projectId: string,
    jobId: string,
    attempt: number,
    manifestHash: string,
    requestHash: string,
    settings: ProviderSettings,
  ): string {
    profileSchema.parse(settings);
    const amount = Math.ceil(
      (settings.maxInputTokens * settings.inputMicrousdPerMillion) / 1e6 +
        (settings.maxOutputTokens * settings.outputMicrousdPerMillion) / 1e6,
    );
    assert(
      Number.isSafeInteger(amount),
      "VALIDATION",
      "Invalid usage estimate.",
    );
    return this.catalog.tx(() => {
      const p = this.active(projectId),
        spent = this.catalog.get(
          "SELECT COALESCE(SUM(CASE WHEN accounting='Settled' THEN charged_microusd ELSE reserved_microusd END),0) AS n FROM provider_requests WHERE project_id=?",
          projectId,
        )!.n;
      assert(
        spent + amount <= p.budget_microusd,
        "BUDGET_EXCEEDED",
        "This request exceeds the project budget.",
      );
      const id = uid();
      this.catalog.run(
        "INSERT INTO provider_requests(id,project_id,project_generation,job_id,attempt,manifest_hash,request_hash,model_id,rate_card_id,state,accounting,reserved_microusd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'Prepared','Reserved',?,?,?)",
        id,
        projectId,
        p.generation,
        jobId,
        attempt,
        manifestHash,
        requestHash,
        settings.modelId,
        settings.rateCardId,
        amount,
        now(),
        now(),
      );
      return id;
    });
  }
  dispatched(requestId: string) {
    const q = this.catalog.get(
      "SELECT * FROM provider_requests WHERE id=?",
      requestId,
    );
    assert(
      q && this.active(q.project_id).generation === q.project_generation,
      "CANCELLED",
      "Project changed.",
    );
    this.catalog.run(
      "UPDATE provider_requests SET state='Dispatched',updated_at=? WHERE id=?",
      now(),
      requestId,
    );
  }
  settle(
    requestId: string,
    usage: { input: number; output: number } | null,
    settings: ProviderSettings,
    knownFree = false,
  ) {
    if (!usage && !knownFree) {
      this.catalog.run(
        "UPDATE provider_requests SET state='Unknown',accounting='Unknown',updated_at=? WHERE id=?",
        now(),
        requestId,
      );
      return;
    }
    const charge = usage
      ? Math.ceil(
          (usage.input * settings.inputMicrousdPerMillion) / 1e6 +
            (usage.output * settings.outputMicrousdPerMillion) / 1e6,
        )
      : 0;
    assert(
      Number.isSafeInteger(charge) && charge >= 0,
      "VALIDATION",
      "Invalid provider usage.",
    );
    this.catalog.run(
      "UPDATE provider_requests SET state=?,accounting='Settled',charged_microusd=?,usage_json=?,updated_at=? WHERE id=?",
      knownFree ? "Failed" : "Succeeded",
      charge,
      JSON.stringify(usage),
      now(),
      requestId,
    );
  }
  reconcileCharge(
    projectId: string,
    requestId: string,
    chargedMicrousd: number,
    note: string,
  ) {
    assert(
      Number.isSafeInteger(chargedMicrousd) && chargedMicrousd >= 0,
      "VALIDATION",
      "Enter a nonnegative confirmed charge.",
    );
    assert(
      note.trim().length >= 10 && note.length <= 2000,
      "VALIDATION",
      "Describe the provider billing evidence.",
    );
    return this.catalog.tx(() => {
      const request = this.catalog.get(
        "SELECT * FROM provider_requests WHERE id=? AND project_id=?",
        safeId(requestId),
        safeId(projectId),
      );
      assert(request, "NOT_FOUND", "Provider request is unavailable.");
      if (request.accounting === "Settled") {
        assert(
          request.charged_microusd === chargedMicrousd,
          "CONFLICT",
          "This request was already reconciled with another charge.",
        );
        return { reconciled: true };
      }
      assert(
        request.accounting === "Unknown",
        "VALIDATION",
        "Only uncertain requests need reconciliation.",
      );
      this.catalog.run(
        "UPDATE provider_requests SET accounting='Settled',charged_microusd=?,usage_json=?,updated_at=? WHERE id=?",
        chargedMicrousd,
        JSON.stringify({
          reconciliation: { note: note.trim(), by: "Editor", at: now() },
        }),
        now(),
        requestId,
      );
      return { reconciled: true };
    });
  }
  delete(projectId: string) {
    const p = this.active(projectId);
    this.catalog.tx(() => {
      this.catalog.run(
        "UPDATE project_registry SET lifecycle='Deleting',generation=generation+1,updated_at=? WHERE id=?",
        now(),
        p.id,
      );
      this.catalog.run(
        "INSERT OR REPLACE INTO deletion_tasks VALUES(?,'Pending','Pending',?)",
        p.id,
        now(),
      );
    });
    this.completeDeletion(p.id);
    return { deletionTaskId: p.id };
  }
  completeDeletion(projectId: string) {
    this.projects.get(projectId)?.close();
    this.projects.delete(projectId);
    const dir = this.directory(projectId);
    rmSync(dir, { recursive: true, force: true });
    this.catalog.tx(() => {
      this.catalog.run(
        "UPDATE project_registry SET lifecycle='Deleted',updated_at=? WHERE id=?",
        now(),
        projectId,
      );
      this.catalog.run(
        "UPDATE deletion_tasks SET local_state='Removed',remote_state=CASE WHEN EXISTS(SELECT 1 FROM remote_objects r JOIN provider_requests q ON q.id=r.request_id WHERE q.project_id=? AND r.state NOT IN ('Deleted','Expired')) THEN 'Pending' ELSE 'Complete' END,updated_at=? WHERE project_id=?",
        projectId,
        now(),
        projectId,
      );
    });
  }
  backup(projectId: string, destination: string) {
    const db = this.db(projectId);
    mkdirSync(destination, { recursive: true });
    const file = path.join(destination, "project.sqlite");
    assert(
      !existsSync(file),
      "VALIDATION",
      "Backup destination already exists.",
    );
    db.run("VACUUM INTO ?", file);
    const manifest = db.all("SELECT * FROM assets");
    for (const asset of manifest) {
      const target = path.join(destination, asset.relative_path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(this.assetPath(projectId, asset.id).filename, target);
    }
    atomicFile(
      path.join(destination, "backup.json"),
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, projectId, assets: manifest }),
      ),
    );
  }
  restore(source: string) {
    const descriptor = contained(source, "backup.json");
    assert(
      statSync(descriptor).size <= 20 * 1024 ** 2,
      "VALIDATION",
      "Backup manifest is too large.",
    );
    const manifest = JSON.parse(readFileSync(descriptor, "utf8"));
    assert(
      manifest.schemaVersion === 1 && Array.isArray(manifest.assets),
      "VALIDATION",
      "Unsupported backup.",
    );
    const newId = uid(),
      dir = this.directory(newId);
    mkdirSync(dir, { recursive: true });
    let db: Db | undefined;
    try {
      copyFileSync(
        contained(source, "project.sqlite"),
        path.join(dir, "project.sqlite"),
      );
      db = new Db(
        path.join(dir, "project.sqlite"),
        readFileSync(path.join(this.migrations, "project.sql"), "utf8"),
      );
      assert(
        db.get("PRAGMA integrity_check")?.integrity_check === "ok" &&
          !db.all("PRAGMA foreign_key_check").length,
        "VALIDATION",
        "Backup database failed integrity checks.",
      );
      assert(
        db.get("SELECT id FROM project WHERE singleton=1")?.id ===
          manifest.projectId,
        "VALIDATION",
        "Backup identity mismatch.",
      );
      for (const a of db.all("SELECT * FROM assets")) {
        assert(
          manifest.assets.some(
            (m: Row) => m.id === a.id && m.sha256 === a.sha256,
          ),
          "VALIDATION",
          "Incomplete backup asset manifest.",
        );
        const original = contained(source, a.relative_path);
        assert(
          statSync(original).size === a.byte_length &&
            fileHash(original) === a.sha256,
          "EVIDENCE_STALE",
          "Backup asset failed its checksum.",
        );
        const target = contained(dir, a.relative_path);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(original, target);
      }
      db.tx(() => {
        // Restore changes the project namespace. Rebuild revision hashes once, then
        // reinstate the immutability trigger before registering the project.
        db!.db.exec("DROP TRIGGER revisions_are_immutable");
        for (const r of db!.all(
          "SELECT id,document_json FROM script_revisions",
        )) {
          const doc = documentSchema.parse({
            ...JSON.parse(r.document_json),
            projectId: newId,
          });
          db!.run(
            "UPDATE script_revisions SET document_json=?,content_hash=? WHERE id=?",
            JSON.stringify(doc),
            digest(doc),
            r.id,
          );
        }
        db!.db.exec(
          "CREATE TRIGGER revisions_are_immutable BEFORE UPDATE ON script_revisions BEGIN SELECT RAISE(ABORT, 'Create a new script revision'); END;",
        );
        db!.run(
          "UPDATE project SET id=?,source_version=source_version+1,state_version=state_version+1 WHERE singleton=1",
          newId,
        );
        db!.run("UPDATE approvals SET revoked_at=?", now());
        db!.run("UPDATE upload_manifests SET revoked_at=?", now());
        db!.run(
          "UPDATE jobs SET state='Cancelled',lease_token=NULL WHERE state<>'Succeeded'",
        );
        db!.run(
          "UPDATE exports SET state='Superseded' WHERE approval_id IS NOT NULL",
        );
        db!.run("DELETE FROM operations");
      });
      for (const name of ["staging", "exports"])
        mkdirSync(path.join(dir, name), { recursive: true });
      this.catalog.run(
        "INSERT INTO project_registry VALUES(?,?,'Active',0,0,?,?)",
        newId,
        newId,
        now(),
        now(),
      );
      this.projects.set(newId, db);
      return { projectId: newId };
    } catch (e) {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  close() {
    for (const db of this.projects.values()) db.close();
    this.projects.clear();
    this.catalog.close();
  }
}
