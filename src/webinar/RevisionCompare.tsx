import { mergeThreeWay } from "../../common/webinar/merge";
import { useEffect, useState } from "react";
import type {
  ScriptDocument,
  RevisionSnapshot,
} from "../../common/webinar/types";
import { call } from "./api";

export function RevisionCompare({
  projectId,
  current,
  proposalId,
  onMerge,
  onClose,
}: {
  projectId: string;
  current: ScriptDocument;
  proposalId: string;
  onMerge: (doc: ScriptDocument) => Promise<void>;
  onClose: () => void;
}) {
  const [proposal, setProposal] = useState<RevisionSnapshot | null>(null),
    [base, setBase] = useState<RevisionSnapshot | null>(null),
    [resolved, setResolved] = useState(() => structuredClone(current)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [conflicts, setConflicts] = useState(0);
  useEffect(() => {
    void call("revision.get", { projectId, revisionId: proposalId })
      .then(async (p) => {
        setProposal(p);
        if (p.baseId) {
          const base = await call("revision.get", {
            projectId,
            revisionId: p.baseId,
          });
          setBase(base);
          const result = mergeThreeWay(base.document, current, p.document);
          setResolved(result.document);
          setConflicts(result.conflicts.length);
        }
      })
      .catch((e) => setError(e.message));
  }, [projectId, proposalId]);
  const text = (doc: ScriptDocument) =>
    doc.sections
      .map(
        (s) =>
          `${s.title}\n${s.blocks.map((b) => `${b.kind.toUpperCase()}: ${b.text}`).join("\n")}`,
      )
      .join("\n\n");
  return (
    <div className="wb-overlay">
      <section className="wb-modal wb-wide">
        <h2>Compare and merge proposal</h2>
        <p>
          Nonconflicting changes are carried forward. Overlapping edits retain
          your current value for review. Choose individual proposed sections to
          append or replace. Saving creates a new revision; both originals
          remain available.
        </p>
        {conflicts > 0 && (
          <p role="alert">
            {conflicts} overlapping edits or ordering changes need review in the
            comparison below.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="wb-compare">
          <div>
            <h3>Generation base</h3>
            <pre>{base ? text(base.document) : "No earlier script"}</pre>
          </div>
          <div>
            <h3>Current script</h3>
            <pre>{text(current)}</pre>
          </div>
          <div>
            <h3>AI proposal</h3>
            <pre>{proposal ? text(proposal.document) : "Loading…"}</pre>
          </div>
        </div>
        {proposal?.document.sections.map((section) => (
          <div className="wb-recording" key={section.id}>
            <strong>{section.title}</strong>
            <select
              aria-label={`Merge ${section.title}`}
              value=""
              onChange={(e) => {
                const target = e.target.value;
                if (!target) return;
                setResolved((d) => {
                  const next = structuredClone(d),
                    copy = structuredClone(section);
                  if (
                    next.sections.some(
                      (s) => s.id === copy.id && s.id !== target,
                    )
                  )
                    return next;
                  if (target === "append") next.sections.push(copy);
                  else {
                    const index = next.sections.findIndex(
                      (s) => s.id === target,
                    );
                    if (index >= 0) next.sections[index] = copy;
                  }
                  return next;
                });
              }}
            >
              <option value="">Keep current / choose merge action</option>
              <option value="append">Append proposed section</option>
              {resolved.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  Replace: {s.title}
                </option>
              ))}
            </select>
          </div>
        ))}
        <h3>Resolved running order</h3>
        {resolved.sections.map((s, i) => (
          <div key={s.id}>
            {i + 1}. {s.title}{" "}
            <button
              onClick={() =>
                setResolved((d) => ({
                  ...d,
                  sections: d.sections.filter((x) => x.id !== s.id),
                }))
              }
            >
              Remove from result
            </button>
          </div>
        ))}
        <div className="wb-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => setResolved(structuredClone(current))}>
            Reset to current
          </button>
          <button
            className="wb-primary"
            disabled={busy || !proposal}
            onClick={() => {
              setBusy(true);
              void onMerge(resolved)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Save resolved revision
          </button>
        </div>
      </section>
    </div>
  );
}
