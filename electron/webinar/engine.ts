import { z } from "zod";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  contextSchema,
  id,
  counter,
  documentSchema,
  envelopeSchema,
  profileSchema,
} from "../../common/webinar/schema";
import type { UploadManifest } from "../../common/webinar/types";
import { WebinarStore } from "./store";
import { EvidenceService, suggestedMasks } from "./evidence";
import { CapturePersistence } from "./capture-store";
import { GenerationService } from "./generation";
import { WordExporter } from "./export";
import { importLegacy } from "./legacy";
import { SceneService } from "./scenes";
import {
  assert,
  uid,
  now,
  digest,
  DomainError,
  contained,
  atomicFile,
  type Row,
} from "./core";

type Host = (method: string, payload: any) => Promise<any>;
export class WebinarEngine {
  evidence: EvidenceService;
  capture: CapturePersistence;
  generation: GenerationService;
  exporter: WordExporter;
  previews = new Map<string, UploadManifest>();
  running = new Map<string, AbortController>();
  constructor(
    public store: WebinarStore,
    private host: Host,
    private changed: () => void = () => {},
  ) {
    this.evidence = new EvidenceService(store);
    this.capture = new CapturePersistence(store);
    this.generation = new GenerationService(
      store,
      this.evidence,
      undefined,
      (projectId, recordingId, atUs) =>
        this.handle("source.probe", { projectId, recordingId, atUs }),
    );
    this.exporter = new WordExporter(store);
  }
  async handle(method: string, input: any): Promise<any> {
    if (method === "project.restore") return this.store.restore(input.source);
    if (method === "project.importLegacy")
      return importLegacy(this.store, input.source);
    if (method === "project.create") {
      const p = z
        .object({ context: contextSchema, budgetMicrousd: counter })
        .strict()
        .parse(input);
      return { projectId: this.store.create(p) };
    }
    if (method === "project.list") return this.store.list();
    if (method === "jobs.busy")
      return {
        busy: [...this.store.projects.values()].some(
          (db) =>
            !!db.get(
              "SELECT id FROM jobs WHERE state='Running' AND stage IN ('transcribe','scenes','export') LIMIT 1",
            ),
        ),
      };
    if (method === "billing.list")
      return this.store.catalog.all(
        "SELECT q.id,q.project_id,q.job_id,q.state,q.accounting,q.reserved_microusd,q.charged_microusd,p.lifecycle FROM provider_requests q JOIN project_registry p ON p.id=q.project_id ORDER BY q.created_at DESC LIMIT 200",
      );
    if (method === "billing.reconcile")
      return this.store.reconcileCharge(
        id.parse(input.projectId),
        id.parse(input.requestId),
        counter.parse(input.chargedMicrousd),
        z.string().min(10).max(2000).parse(input.note),
      );
    const projectId = id.parse(input.projectId);
    if (method.startsWith("draft.")) {
      this.store.active(projectId);
      const file = contained(
        this.store.directory(projectId),
        "staging/editor-draft.json",
      );
      if (method === "draft.get")
        return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      if (method === "draft.clear") {
        if (existsSync(file)) unlinkSync(file);
        return {};
      }
      if (method === "draft.save") {
        const value = z
          .object({
            baseRevisionId: id.nullable(),
            document: documentSchema,
            sequence: counter,
          })
          .strict()
          .parse(input.draft);
        assert(
          value.document.projectId === projectId,
          "FORBIDDEN",
          "Wrong draft project.",
        );
        const previous = existsSync(file)
          ? JSON.parse(readFileSync(file, "utf8"))
          : null;
        if (!previous || previous.sequence < value.sequence)
          atomicFile(file, Buffer.from(JSON.stringify(value)));
        return {};
      }
      throw new DomainError("VALIDATION", "Unknown draft action.");
    }
    if (method === "project.snapshot")
      return this.store.snapshot(projectId, {
        evidenceOffset: counter.parse(input.evidenceOffset ?? 0),
        transcriptOffset: counter.parse(input.transcriptOffset ?? 0),
        limit: 100,
      });
    if (method === "evidence.inspectText") {
      const e = this.store
        .db(projectId)
        .get("SELECT * FROM evidence WHERE id=?", id.parse(input.evidenceId));
      assert(e, "NOT_FOUND", "Screenshot is unavailable.");
      const { filename, asset } = this.store.assetPath(
          projectId,
          e.raw_asset_id,
        ),
        words = await this.host("ocr", { filename });
      this.store.active(projectId);
      const masks = (await suggestedMasks(words))
        .map((r) => ({
          ...r,
          width: Math.min(r.width, asset.width - r.x),
          height: Math.min(r.height, asset.height - r.y),
        }))
        .filter((r) => r.width > 0 && r.height > 0);
      return {
        masks,
        wordCount: words.length,
        note: "OCR can miss secrets and misread code. Review the full image and every proposed mask.",
      };
    }
    if (method === "revision.get")
      return this.store.revision(projectId, id.parse(input.revisionId));
    if (method === "source.timeline") {
      const recordingId = id.parse(input.recordingId),
        db = this.store.db(projectId);
      assert(
        db.get("SELECT id FROM recordings WHERE id=?", recordingId),
        "NOT_FOUND",
        "Recording unavailable.",
      );
      return {
        segments: db.all(
          "SELECT s.*,c.scale,c.session_anchor_us,c.media_anchor_us,c.uncertainty_us FROM segments s JOIN clock_maps c ON c.id=s.clock_map_id WHERE s.recording_id=? ORDER BY s.start_us",
          recordingId,
        ),
        intervals: db.all(
          "SELECT * FROM intervals WHERE recording_id=? ORDER BY start_us",
          recordingId,
        ),
      };
    }
    if (method === "source.probe") {
      const db = this.store.db(projectId),
        recordingId = id.parse(input.recordingId),
        atUs = counter.parse(input.atUs);
      const segment = db.get(
        "SELECT s.*,c.scale,c.session_anchor_us,c.media_anchor_us FROM segments s JOIN clock_maps c ON c.id=s.clock_map_id WHERE s.recording_id=? AND s.track='screen' AND s.start_us<=? AND s.end_us>?",
        recordingId,
        atUs,
        atUs,
      );
      assert(segment, "NOT_FOUND", "No screen segment covers this time.");
      const sourceVersion = this.store.meta(projectId).source_version,
        frame = await this.host("decode", {
          filename: this.store.assetPath(projectId, segment.asset_id).filename,
          track: "screen",
          samples: false,
          frameAtUs: Math.round(
            segment.media_anchor_us +
              (atUs - segment.session_anchor_us) / segment.scale,
          ),
        });
      assert(
        this.store.meta(projectId).source_version === sourceVersion,
        "CONFLICT",
        "Source changed during frame extraction.",
      );
      const a = this.store.asset(projectId, frame.bytes, "frame", "image/png", {
          width: frame.width,
          height: frame.height,
        }),
        evidenceId = uid();
      db.run(
        "INSERT INTO evidence VALUES(?,?,?,?,?,?)",
        evidenceId,
        recordingId,
        a.id,
        atUs,
        "probe",
        JSON.stringify({
          encodedFallback: true,
          requestedAtUs: atUs,
          seekTimeUs: frame.seekTimeUs,
        }),
      );
      this.store.event(db, "evidence.candidateAdded", { evidenceId });
      return { evidenceId };
    }
    if (method === "project.dependency")
      return {
        hash: this.store.dependencyHash(projectId, id.parse(input.revisionId)),
      };
    if (method === "asset.path")
      return this.store.assetPath(projectId, id.parse(input.assetId));
    if (method === "project.backup") {
      this.store.backup(projectId, input.destination);
      return {};
    }
    if (method.startsWith("capture."))
      return this.captureCommand(projectId, method, input.payload);
    if (method === "evidence.prepare") {
      const profile = profileSchema.parse(input.profile),
        ids = z.array(id).max(2000).parse(input.derivativeIds);
      let spanIds =
        input.spanIds === undefined
          ? undefined
          : z.array(id).max(100000).parse(input.spanIds);
      if (input.excludedSpanIds !== undefined) {
        const excluded = z.array(id).max(100000).parse(input.excludedSpanIds);
        spanIds = this.store
          .db(projectId)
          .all("SELECT id FROM transcript_spans")
          .filter((t) => !excluded.includes(t.id))
          .map((t) => t.id);
      }
      const candidate = await this.evidence.prepare(
        projectId,
        ids,
        digest(profile),
        spanIds,
      );
      this.previews.set(projectId, candidate);
      return candidate;
    }
    if (
      method === "jobs.generate" ||
      method === "jobs.transcribe" ||
      method === "jobs.export" ||
      method === "jobs.scenes"
    ) {
      const stage =
        method === "jobs.generate"
          ? "compose"
          : method === "jobs.transcribe"
            ? "transcribe"
            : method === "jobs.scenes"
              ? "scenes"
              : "export";
      const running = [...this.store.projects.values()].flatMap((db) =>
        db.all("SELECT stage FROM jobs WHERE state='Running'"),
      );
      assert(
        stage === "compose"
          ? running.filter((j) => j.stage === "compose").length < 2
          : !running.some((j) =>
              ["transcribe", "scenes", "export"].includes(j.stage),
            ),
        "BUSY",
        "Another processing job is using the available worker. Wait or cancel it first.",
      );
      const jobInput =
        stage === "compose"
          ? {
              manifestId: id.parse(input.manifestId),
              profile: profileSchema.parse(input.profile),
              base: this.store.meta(projectId).head_revision_id,
            }
          : stage === "export"
            ? {
                revisionId: id.parse(input.revisionId),
                mode: z.enum(["draft", "ready"]).parse(input.mode),
              }
            : stage === "scenes"
              ? {
                  evidenceIds: this.store
                    .snapshot(projectId)
                    .evidence.map((e) => e.id),
                }
              : {
                  recordingId: id.parse(input.recordingId),
                  allowDownload: !!input.allowDownload,
                };
      const jobId = this.store.newJob(projectId, stage, jobInput);
      const current = this.store
        .db(projectId)
        .get("SELECT * FROM jobs WHERE id=?", jobId)!;
      if (current.state === "Succeeded") return { jobId };
      assert(
        ["Queued", "WaitingForNetwork"].includes(current.state),
        "BUSY",
        "This job needs retry or review.",
      );
      void this.runWithRetries(
        projectId,
        jobId,
        stage,
        jobInput,
        input.key,
      ).catch(() => {});
      return { jobId };
    }
    if (method === "job.output") {
      const j = this.store
        .db(projectId)
        .get("SELECT * FROM jobs WHERE id=?", id.parse(input.jobId));
      assert(j?.output_asset_id, "BUSY", "Job output is not ready.");
      return JSON.parse(
        this.store.assetBytes(projectId, j.output_asset_id).toString(),
      );
    }
    if (method === "export.publish") {
      const db = this.store.db(projectId),
        e = db.get(
          "SELECT * FROM exports WHERE id=?",
          id.parse(input.exportId),
        );
      assert(
        e && e.state === "Rendered",
        "VALIDATION",
        "Export is not publishable.",
      );
      if (e.approval_id) {
        const a = db.get(
          "SELECT * FROM approvals WHERE id=? AND revoked_at IS NULL",
          e.approval_id,
        );
        assert(
          a &&
            a.dependency_hash ===
              this.store.dependencyHash(projectId, e.revision_id),
          "EVIDENCE_STALE",
          "Export approval changed.",
        );
      }
      return this.store.assetPath(projectId, e.asset_id);
    }
    if (method === "export.destination") {
      const db = this.store.db(projectId),
        row = db.get(
          "SELECT * FROM exports WHERE id=? AND state='Rendered'",
          id.parse(input.exportId),
        );
      assert(row, "VALIDATION", "Export is not ready.");
      const asset = this.store.assetPath(projectId, row.asset_id).asset;
      db.run(
        "UPDATE exports SET destination_token=? WHERE id=?",
        JSON.stringify({
          version: 1,
          path: input.destination,
          hash: asset.sha256,
          preparedAt: now(),
        }),
        row.id,
      );
      return {};
    }
    if (method === "export.published") {
      this.store.recoverExports(projectId);
      const row = this.store
        .db(projectId)
        .get("SELECT state FROM exports WHERE id=?", id.parse(input.exportId));
      assert(
        row?.state === "Published",
        "EXPORT_FAILED",
        "Published file could not be verified.",
      );
      return {};
    }
    const envelope = envelopeSchema.parse(input),
      p: any = envelope.payload;
    if (method === "project.delete") {
      assert(
        p.confirmProjectId === projectId,
        "VALIDATION",
        "Project deletion did not match.",
      );
      for (const job of this.store
        .db(projectId)
        .all("SELECT id FROM jobs WHERE state='Running'"))
        this.running.get(job.id)?.abort();
      this.capture.abandon(projectId);
      return this.store.delete(projectId);
    }
    return this.store.mutate(
      projectId,
      envelope.requestId,
      method,
      p,
      envelope.expectedStateVersion,
      (db) => {
        if (method === "project.update") {
          const context = contextSchema.parse(p),
            meta = this.store.meta(projectId);
          if (digest(context) !== digest(JSON.parse(meta.context_json))) {
            db.run(
              "UPDATE project SET title=?,context_json=? WHERE singleton=1",
              context.title,
              JSON.stringify(context),
            );
            this.store.invalidate(db);
            if (meta.head_revision_id) {
              const doc = this.store.revision(
                projectId,
                meta.head_revision_id,
              ).document;
              doc.context = context;
              doc.title = context.title;
              this.store.save(projectId, doc, meta.head_revision_id);
            }
          }
          return {};
        }
        if (method === "project.budget") {
          const amount = counter.parse(p.budgetMicrousd);
          this.store.catalog.run(
            "UPDATE project_registry SET budget_microusd=? WHERE id=?",
            amount,
            projectId,
          );
          return {};
        }
        if (method === "presenters.save") {
          const rows = z
            .array(
              z
                .object({
                  id: id.nullable(),
                  name: z.string().trim().min(1).max(200),
                  wordsPerMinute: z.number().int().min(60).max(250),
                  active: z.boolean(),
                })
                .strict(),
            )
            .max(20)
            .parse(p.presenters);
          db.run("UPDATE presenters SET active=0");
          const result = rows.map((r) => ({ ...r, id: r.id ?? uid() }));
          for (const r of result)
            db.run(
              "INSERT INTO presenters VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,words_per_minute=excluded.words_per_minute,active=excluded.active",
              r.id,
              r.name,
              r.wordsPerMinute,
              r.active ? 1 : 0,
            );
          this.store.invalidate(db, false);
          const head = this.store.meta(projectId).head_revision_id;
          if (head) {
            const doc = this.store.revision(projectId, head).document;
            doc.presenters = result
              .filter((p) => p.active)
              .map((p) => ({
                id: p.id,
                name: p.name,
                wordsPerMinute: p.wordsPerMinute,
              }));
            for (const s of doc.sections) {
              if (!doc.presenters.some((p) => p.id === s.presenterId)) {
                s.presenterId = null;
                s.assignment = "unassigned";
              }
              if (!doc.presenters.some((p) => p.id === s.handoffToPresenterId))
                s.handoffToPresenterId = null;
            }
            this.store.save(projectId, doc, head);
          }
          return { presenters: result };
        }
        if (method === "transcript.correct") {
          const spanId = id.parse(p.spanId),
            text = z.string().max(12000).parse(p.text);
          assert(
            db.get("SELECT id FROM transcript_spans WHERE id=?", spanId),
            "NOT_FOUND",
            "Transcript span missing.",
          );
          const version = db.get(
            "SELECT COALESCE(MAX(version),0)+1 AS n FROM transcript_edits WHERE span_id=?",
            spanId,
          )!.n;
          const editId = uid();
          db.run(
            "INSERT INTO transcript_edits VALUES(?,?,?,?,?,?)",
            editId,
            spanId,
            version,
            text,
            "Editor",
            now(),
          );
          this.store.invalidate(db);
          return { editId };
        }
        if (method === "manifest.approve") {
          const candidate = this.previews.get(projectId);
          assert(
            candidate && candidate.hash === p.candidateHash,
            "EVIDENCE_STALE",
            "Prepare and review the evidence first.",
          );
          return this.evidence.approve(projectId, candidate);
        }
        if (method === "manifest.revoke") {
          db.run(
            "UPDATE upload_manifests SET revoked_at=? WHERE id=?",
            now(),
            id.parse(p.manifestId),
          );
          return {};
        }
        if (method === "script.manual") return this.manual(projectId);
        if (method === "take.select") {
          const groupId = id.parse(p.groupId),
            group = db.get(
              "SELECT * FROM take_groups WHERE id=? ORDER BY version DESC LIMIT 1",
              groupId,
            );
          assert(
            group && group.version === p.expectedGroupVersion,
            "CONFLICT",
            "Take selection changed.",
          );
          const members = JSON.parse(group.members_json) as {
              id: string;
              version: number;
            }[],
            stepId = id.parse(p.stepId),
            version = z.number().int().positive().parse(p.stepVersion);
          assert(
            members.some((m) => m.id === stepId && m.version === version),
            "VALIDATION",
            "The step does not belong to this take group.",
          );
          db.run(
            "INSERT INTO take_groups VALUES(?,?,?,?,?)",
            groupId,
            group.version + 1,
            group.members_json,
            stepId,
            version,
          );
          const head = this.store.meta(projectId).head_revision_id;
          assert(head, "VALIDATION", "Generate a script first.");
          const doc = this.store.revision(projectId, head).document;
          const excluded = new Set(
            members.filter((m) => m.id !== stepId).map((m) => m.id),
          );
          doc.sections = doc.sections
            .map((s) => ({
              ...s,
              blocks: s.blocks.filter(
                (b) => !b.stepRefs.some((r) => excluded.has(r.id)),
              ),
            }))
            .filter((s) => s.blocks.length > 0);
          this.store.invalidate(db, false);
          const proposal = this.store.save(projectId, doc, head, "generated");
          return {
            groupVersion: group.version + 1,
            proposedRevisionId: proposal.id,
          };
        }
        if (method === "script.save")
          return this.store.save(
            projectId,
            documentSchema.parse(p.document),
            p.baseRevisionId === null ? null : id.parse(p.baseRevisionId),
          );
        if (method === "script.merge") {
          const proposal = this.store.revision(
            projectId,
            id.parse(p.proposedRevisionId),
          );
          const m = this.store.meta(projectId);
          assert(
            proposal.sourceVersion === m.source_version &&
              proposal.policyVersion === m.policy_version,
            "EVIDENCE_STALE",
            "Proposal evidence changed. Generate a current proposal.",
          );
          return this.store.save(
            projectId,
            documentSchema.parse(p.resolvedDocument),
            id.parse(p.baseRevisionId),
            "merge",
          );
        }
        if (method === "script.approve")
          return this.store.approve(
            projectId,
            id.parse(p.revisionId),
            z.string().length(64).parse(p.dependencyHash),
          );
        if (method === "review.resolve")
          return this.store.resolveFlag(projectId, p);
        if (method === "jobs.cancel") {
          const jobId = id.parse(p.jobId);
          this.running.get(jobId)?.abort();
          void this.host("cancelTranscription", { jobId }).catch(() => {});
          return this.store.cancelJob(projectId, jobId);
        }
        if (method === "jobs.retry") {
          const job = db.get(
            "SELECT * FROM jobs WHERE id=?",
            id.parse(p.jobId),
          );
          assert(
            job &&
              ["Failed", "Cancelled", "WaitingForReview"].includes(job.state),
            "VALIDATION",
            "Job cannot be retried.",
          );
          const uncertain = this.store.catalog.get(
            "SELECT id FROM provider_requests WHERE project_id=? AND job_id=? AND accounting='Unknown'",
            projectId,
            job.id,
          );
          assert(
            !uncertain || p.acceptUncertainCharge === true,
            "PROVIDER_UNKNOWN",
            "This job may already have incurred a charge. Confirm a budgeted retry.",
          );
          db.run(
            "UPDATE jobs SET state='Queued',lease_token=NULL,error_code=NULL WHERE id=?",
            job.id,
          );
          return { jobId: job.id };
        }
        throw new DomainError("VALIDATION", "Unknown project operation.");
      },
    );
  }
  async derive(projectId: string, evidenceId: string, plan: any) {
    return this.evidence.derive(
      id.parse(projectId),
      id.parse(evidenceId),
      plan,
    );
  }
  async recoverLocalJobs() {
    for (const [projectId, db] of this.store.projects)
      for (const job of db.all(
        "SELECT * FROM jobs WHERE state='Queued' AND stage IN ('transcribe','scenes','export') ORDER BY created_at",
      )) {
        try {
          await this.runWithRetries(
            projectId,
            job.id,
            job.stage,
            JSON.parse(job.input_json),
          );
        } catch {
          /* The durable job exposes its final failure for review. */
        }
      }
  }
  async runWithRetries(
    projectId: string,
    jobId: string,
    stage: string,
    input: any,
    key?: string,
  ) {
    for (;;) {
      try {
        return await this.run(projectId, jobId, stage, input, key);
      } catch (error) {
        const job = this.store
          .db(projectId)
          .get("SELECT * FROM jobs WHERE id=?", jobId);
        const transient =
          error instanceof DomainError &&
          ["DECODE_FAILED", "PROVIDER_UNAVAILABLE"].includes(error.code);
        if (
          stage === "compose" ||
          !transient ||
          !job ||
          job.attempt >= 3 ||
          !["Failed", "WaitingForReview"].includes(job.state)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, job.attempt * 500));
        this.store
          .db(projectId)
          .run(
            "UPDATE jobs SET state='Queued' WHERE id=? AND state IN ('Failed','WaitingForReview')",
            jobId,
          );
      }
    }
  }
  private async captureCommand(projectId: string, method: string, p: any) {
    if (method === "capture.start")
      return this.capture.start(projectId, p.profile);
    if (method === "capture.state")
      return this.capture.state(
        projectId,
        id.parse(p.recordingId),
        p.state,
        counter.parse(p.atUs),
        p.reason,
      );
    if (method === "capture.open") return this.capture.open(projectId, p);
    if (method === "capture.chunk") return this.capture.chunk(projectId, p);
    if (method === "capture.seal")
      return this.capture.seal(projectId, p, (filename, track) =>
        this.host("decode", { filename, track, samples: false }),
      );
    if (method === "capture.frame") return this.capture.frame(projectId, p);
    if (method === "capture.marker")
      return this.capture.marker(
        projectId,
        p.recordingId,
        p.atUs,
        p.label,
        p.kind,
      );
    if (method === "capture.abandon") {
      this.capture.abandon(projectId);
      return {};
    }
    throw new DomainError("VALIDATION", "Unknown capture operation.");
  }
  manual(projectId: string) {
    const db = this.store.db(projectId),
      m = this.store.meta(projectId),
      snapshot = this.store.snapshot(projectId);
    assert(
      snapshot.transcript.length,
      "AUDIO_MISSING",
      "Transcribe your recording first.",
    );
    const sections = snapshot.transcript.map((t: Row) => ({
      id: uid(),
      title: `Demonstration at ${(t.start_us / 1e6).toFixed(0)} seconds`,
      presenterId: null,
      assignment: "unassigned" as const,
      handoffToPresenterId: null,
      blocks: [
        {
          id: uid(),
          kind: "say" as const,
          text: t.current_text,
          provenance: "narrated" as const,
          refs: [
            {
              kind: "transcript" as const,
              id: t.id,
              source: {
                recordingId: t.recording_id,
                startUs: t.start_us,
                endUs: t.end_us,
              },
            },
          ],
          stepRefs: [],
          imageDerivativeIds: [],
          timingGroup: uid(),
          timingMode: "serial" as const,
          durationSeconds: null,
          requiresTechnicalVerification: true,
        },
      ],
    }));
    const grouped = new Map<string, (typeof sections)[number]>();
    for (const section of sections) {
      const source = section.blocks[0].refs[0].source,
        key = source.recordingId + ":" + Math.floor(source.startUs / 90000000),
        prior = grouped.get(key);
      if (prior) prior.blocks.push(...section.blocks);
      else grouped.set(key, section);
    }
    return this.store.save(
      projectId,
      {
        schemaVersion: 1,
        projectId,
        title: m.title,
        context: JSON.parse(m.context_json),
        presenters: db
          .all("SELECT * FROM presenters WHERE active=1")
          .map((p) => ({
            id: p.id,
            name: p.name,
            wordsPerMinute: p.words_per_minute,
          })),
        sections: [...grouped.values()],
      },
      m.head_revision_id,
    );
  }
  async run(
    projectId: string,
    jobId: string,
    stage: string,
    input: any,
    key?: string,
  ) {
    const job = this.store.claim(projectId, jobId),
      abort = new AbortController();
    this.running.set(jobId, abort);
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(projectId, job);
      } catch {
        abort.abort();
      }
    }, 5000);
    this.changed();
    try {
      let value: any;
      if (stage === "compose")
        value = await this.generation.generate(
          projectId,
          job,
          input.manifestId,
          input.profile,
          key ?? "",
          abort.signal,
        );
      else if (stage === "scenes")
        value = await new SceneService(this.store).analyze(
          projectId,
          () => !abort.signal.aborted && this.store.leaseValid(projectId, job),
        );
      else if (stage === "export")
        value = await this.exporter.render(
          projectId,
          input.revisionId,
          input.mode,
        );
      else
        value = await this.transcribe(
          projectId,
          job,
          input.recordingId,
          input.allowDownload,
          abort.signal,
        );
      this.store.finishJob(projectId, job, value);
    } catch (e) {
      try {
        this.store.failJob(
          projectId,
          job,
          e instanceof DomainError ? e.code : "INTERNAL",
        );
      } catch {}
      throw e;
    } finally {
      clearInterval(heartbeat);
      this.running.delete(jobId);
      this.changed();
    }
  }
  async transcribe(
    projectId: string,
    job: Row,
    recordingId: string,
    allowDownload: boolean,
    signal: AbortSignal,
  ) {
    const db = this.store.db(projectId),
      segments = db.all(
        "SELECT * FROM segments WHERE recording_id=? AND track='microphone' ORDER BY sequence",
        recordingId,
      );
    assert(
      segments.length,
      "AUDIO_MISSING",
      "No microphone segments are available.",
    );
    const all: any[] = [];
    for (const segment of segments) {
      assert(
        !signal.aborted && this.store.leaseValid(projectId, job),
        "CANCELLED",
        "Transcription cancelled.",
      );
      const filename = this.store.assetPath(
        projectId,
        segment.asset_id,
      ).filename;
      assert(
        segment.media_out_us <= 45000000,
        "DECODE_FAILED",
        "Long legacy audio is available for playback; import its existing narration or record a new bounded rehearsal for transcription.",
      );
      const windowId = this.store.newJob(projectId, "asrWindow", {
          assetHash: db.get(
            "SELECT sha256 FROM assets WHERE id=?",
            segment.asset_id,
          )!.sha256,
          model: "Xenova/whisper-small",
          dtype: "q8",
          start: segment.media_in_us,
          end: segment.media_out_us,
        }),
        previous = db.get("SELECT * FROM jobs WHERE id=?", windowId)!;
      let result: any;
      if (previous.state === "Succeeded")
        result = JSON.parse(
          this.store.assetBytes(projectId, previous.output_asset_id).toString(),
        );
      else {
        if (
          ["Failed", "WaitingForReview", "Cancelled"].includes(previous.state)
        )
          db.run("UPDATE jobs SET state='Queued' WHERE id=?", windowId);
        const child = this.store.claim(projectId, windowId),
          heartbeat = setInterval(() => {
            try {
              this.store.heartbeat(projectId, child);
            } catch {}
          }, 5000);
        try {
          result = await this.host("transcribe", {
            filename,
            allowDownload,
            jobId: job.id,
          });
          assert(
            !signal.aborted && this.store.leaseValid(projectId, job),
            "CANCELLED",
            "Transcription cancelled.",
          );
          this.store.finishJob(projectId, child, result);
        } catch (e) {
          this.store.failJob(
            projectId,
            child,
            e instanceof DomainError ? e.code : "MODEL_MISSING",
          );
          if (e instanceof DomainError) throw e;
          throw new DomainError(
            "MODEL_MISSING",
            "Local transcription failed. Check the model download and try again.",
          );
        } finally {
          clearInterval(heartbeat);
        }
      }
      const chunks = result.chunks?.length
        ? result.chunks
        : [
            {
              text: result.text,
              timestamp: [0, (segment.end_us - segment.start_us) / 1e6],
            },
          ];
      for (const chunk of chunks) {
        const text = String(chunk.text ?? "").trim();
        if (!text) continue;
        const start = Math.max(
            segment.start_us,
            segment.start_us -
              segment.media_in_us +
              Math.round((chunk.timestamp?.[0] ?? 0) * 1e6),
          ),
          end = Math.min(
            segment.end_us,
            segment.start_us -
              segment.media_in_us +
              Math.round(
                (chunk.timestamp?.[1] ??
                  (segment.end_us - segment.start_us) / 1e6) * 1e6,
              ),
          );
        if (end > start)
          all.push({
            id: uid(),
            start,
            end,
            text,
            sourceHash: db.get(
              "SELECT sha256 FROM assets WHERE id=?",
              segment.asset_id,
            )!.sha256,
          });
      }
    }
    assert(
      this.store.leaseValid(projectId, job),
      "CANCELLED",
      "Transcription changed.",
    );
    assert(
      all.length,
      "AUDIO_MISSING",
      "No speech was recognized. Listen to the microphone recording before retrying.",
    );
    assert(
      !db.get(
        "SELECT id FROM transcript_spans WHERE recording_id=?",
        recordingId,
      ),
      "CONFLICT",
      "Transcript already exists. Use corrections to preserve history.",
    );
    db.tx(() => {
      for (const s of all)
        db.run(
          "INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)",
          s.id,
          recordingId,
          s.start,
          s.end,
          s.text,
          "Xenova/whisper-small",
          s.sourceHash,
          "[]",
        );
      this.store.invalidate(db);
    });
    return { spanCount: all.length };
  }
}
