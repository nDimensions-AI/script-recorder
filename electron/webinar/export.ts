import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  Footer,
  PageNumber,
} from "docx";
import { createRequire } from "node:module";
import { WebinarStore } from "./store";
import { assert, uid, now, bytesHash } from "./core";
import { timing } from "../../common/webinar/timing";
import type { ScriptDocument } from "../../common/webinar/types";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
export const durationSeconds = (doc: ScriptDocument) => timing(doc).total;
export class WordExporter {
  constructor(private store: WebinarStore) {}
  async render(projectId: string, revisionId: string, mode: "draft" | "ready") {
    const revision = this.store.revision(projectId, revisionId),
      db = this.store.db(projectId),
      dependency = this.store.dependencyHash(projectId, revisionId);
    const approval = db.get(
      "SELECT * FROM approvals WHERE revision_id=? AND revoked_at IS NULL AND dependency_hash=? ORDER BY approved_at DESC LIMIT 1",
      revisionId,
      dependency,
    );
    if (mode === "ready")
      assert(
        approval,
        "VALIDATION",
        "Approve the current revision before exporting Ready.",
      );
    const exportId = uid();
    db.run(
      "INSERT INTO exports VALUES(?,?,?,'1','Preparing',NULL,NULL,?)",
      exportId,
      revisionId,
      mode === "ready" ? approval!.id : null,
      now(),
    );
    const doc = revision.document,
      children: (Paragraph | Table)[] = [];
    children.push(
      new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }),
      new Paragraph({
        text: `${mode === "draft" ? "DRAFT — review required" : "APPROVED"} · nDimensions.AI and CharanTheAiGuy`,
      }),
      new Paragraph(`Revision ${revisionId}`),
      new Paragraph(`Audience: ${doc.context.audience}`),
      new Paragraph(`Objective: ${doc.context.objective}`),
    );
    if (approval && mode === "ready")
      children.push(
        new Paragraph(
          `Approved by ${approval.approved_by} at ${approval.approved_at}`,
        ),
      );
    children.push(
      new Paragraph(
        `Estimated duration: ${Math.ceil(durationSeconds(doc) / 60)} minute(s). Validate through rehearsal.`,
      ),
    );
    if (mode === "draft")
      for (const flag of db.all(
        "SELECT * FROM review_flags WHERE revision_id=?",
        revisionId,
      ))
        children.push(
          new Paragraph({
            text: `Review: ${JSON.parse(flag.detail_json).message}`,
            style: "Review",
          }),
        );
    children.push(
      new Paragraph({ text: "Running order", heading: HeadingLevel.HEADING_1 }),
    );
    const row = (values: string[], header = false) =>
      new TableRow({
        tableHeader: header,
        children: values.map(
          (text) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text, bold: header })],
                }),
              ],
              shading: header ? { fill: "E9EDF0" } : undefined,
              margins: { top: 100, bottom: 100, left: 100, right: 100 },
            }),
        ),
      });
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          row(["Section", "Presenter"], true),
          ...doc.sections.map((s) =>
            row([
              s.title,
              doc.presenters.find((p) => p.id === s.presenterId)?.name ??
                "Unassigned",
            ]),
          ),
        ],
      }),
    );
    const usedImages: string[] = [];
    for (const section of doc.sections) {
      children.push(
        new Paragraph({
          text: section.title,
          heading: HeadingLevel.HEADING_1,
          keepNext: true,
        }),
        new Paragraph({
          text: `Presenter: ${doc.presenters.find((p) => p.id === section.presenterId)?.name ?? "Unassigned"}`,
        }),
      );
      for (const block of section.blocks) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.kind.toUpperCase() + ": ",
                bold: true,
              }),
              new TextRun(block.text),
            ],
            keepNext: block.imageDerivativeIds.length > 0,
          }),
        );
        if (block.provenance === "editorial")
          children.push(
            new Paragraph({ text: "Editorial addition", style: "Caption" }),
          );
        for (const imageId of block.imageDerivativeIds) {
          const image = db.get(
            "SELECT d.*,e.recording_id,e.at_us,a.width,a.height,a.mime FROM derivatives d JOIN evidence e ON e.id=d.evidence_id JOIN assets a ON a.id=d.asset_id WHERE d.id=?",
            imageId,
          );
          assert(image, "EVIDENCE_STALE", "Screenshot is unavailable.");
          const bytes = this.store.assetBytes(projectId, image.asset_id),
            scale = Math.min(624 / image.width, 620 / image.height, 1);
          children.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: bytes,
                  type: image.mime === "image/png" ? "png" : "jpg",
                  transformation: {
                    width: Math.round(image.width * scale),
                    height: Math.round(image.height * scale),
                  },
                  altText: {
                    title: section.title,
                    description: `Source screenshot at ${image.at_us / 1e6} seconds`,
                    name: imageId,
                  },
                }),
              ],
              keepNext: true,
            }),
          );
          children.push(
            new Paragraph({
              text: `Recording ${image.recording_id} · ${(image.at_us / 1e6).toFixed(1)} s · screenshot ${imageId}`,
              style: "Caption",
            }),
          );
          usedImages.push(imageId);
        }
      }
      if (section.handoffToPresenterId)
        children.push(
          new Paragraph(
            `Handoff to ${doc.presenters.find((p) => p.id === section.handoffToPresenterId)?.name ?? "Unassigned"}`,
          ),
        );
    }
    children.push(
      new Paragraph({
        text: "Evidence references",
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        keepNext: true,
      }),
    );
    const printedRefs = new Set<string>();
    for (const s of doc.sections)
      for (const b of s.blocks)
        for (const r of b.refs) {
          const key = s.id + ":" + r.kind + ":" + r.id;
          if (printedRefs.has(key)) continue;
          printedRefs.add(key);
          children.push(
            new Paragraph({
              text: `${s.title} · ${r.kind} ${r.id}${r.source ? ` · recording ${r.source.recordingId} · ${(r.source.startUs / 1e6).toFixed(1)}–${(r.source.endUs / 1e6).toFixed(1)} s` : ""}`,
              style: "Caption",
            }),
          );
        }
    const word = new Document({
      creator: "nDimensions.AI and CharanTheAiGuy",
      title: doc.title,
      description: `Webinar script revision ${revisionId}`,
      styles: {
        default: {
          document: {
            run: { font: "Calibri", size: 22, color: "000000" },
            paragraph: { spacing: { after: 120 } },
          },
        },
        paragraphStyles: [
          {
            id: "Heading1",
            name: "heading 1",
            basedOn: "Normal",
            next: "Normal",
            run: { color: "000000", bold: true, size: 28 },
            paragraph: { keepNext: true, spacing: { before: 240, after: 120 } },
          },
          {
            id: "Caption",
            name: "Caption",
            basedOn: "Normal",
            run: { size: 18 },
            paragraph: { spacing: { after: 120 } },
          },
          {
            id: "Review",
            name: "Review",
            basedOn: "Normal",
            run: { bold: true },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
            },
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  children: [
                    new TextRun("nDimensions.AI · "),
                    new TextRun({ children: [PageNumber.CURRENT] }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    });
    const bytes = await Packer.toBuffer(word);
    this.store.active(projectId);
    if (mode === "ready")
      assert(
        this.store.dependencyHash(projectId, revisionId) === dependency &&
          db.get(
            "SELECT id FROM approvals WHERE id=? AND revoked_at IS NULL",
            approval!.id,
          ),
        "EVIDENCE_STALE",
        "Approval changed during export.",
      );
    const zip = new AdmZip(bytes),
      entries = zip.getEntries();
    assert(
      zip.getEntry("word/document.xml"),
      "EXPORT_FAILED",
      "Word document is incomplete.",
    );
    assert(zip.test(), "EXPORT_FAILED", "Word ZIP integrity check failed.");
    assert(
      !entries.some(
        (e: any) =>
          e.entryName.endsWith(".rels") &&
          /TargetMode="External"[^>]*image|image[^>]*TargetMode="External"/.test(
            e.getData().toString(),
          ),
      ),
      "EXPORT_FAILED",
      "External images are forbidden.",
    );
    assert(
      !usedImages.length ||
        entries.some((e: any) => e.entryName.startsWith("word/media/")),
      "EXPORT_FAILED",
      "Screenshots were not embedded.",
    );
    const mediaHashes = new Set(
      entries
        .filter(
          (e: any) => e.entryName.startsWith("word/media/") && !e.isDirectory,
        )
        .map((e: any) => bytesHash(e.getData())),
    );
    for (const imageId of new Set(usedImages)) {
      const image = db.get(
        "SELECT a.sha256 FROM derivatives d JOIN assets a ON a.id=d.asset_id WHERE d.id=?",
        imageId,
      )!;
      assert(
        mediaHashes.has(image.sha256),
        "EXPORT_FAILED",
        "An embedded screenshot differs from the reviewed derivative.",
      );
    }
    const asset = this.store.asset(
      projectId,
      bytes,
      "export",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    db.run(
      "UPDATE exports SET state='Rendered',asset_id=? WHERE id=?",
      asset.id,
      exportId,
    );
    return {
      exportId,
      assetId: asset.id,
      dependencyHash: dependency,
      revisionId,
      mode,
    };
  }
}
