import { ProviderConnection } from "./ProviderConnection";
import { Billing } from "./Billing";
import { useEffect, useRef, useState } from "react";
import type { ScriptDocument } from "../../common/webinar/types";
import { call, envelope, type Preview } from "./api";
import "./webinar.css";
import { timing } from "../../common/webinar/timing";
import { MicrophonePreview } from "./MicrophonePreview";
import { ProjectSettings } from "./ProjectSettings";
import { SourcePlayer } from "./SourcePlayer";
import { RevisionCompare } from "./RevisionCompare";

const seconds = (us: number) =>
  `${Math.floor(us / 60000000)}:${String(Math.floor(us / 1000000) % 60).padStart(2, "0")}`;
function AssetImage({
  projectId,
  assetId,
  onClick,
}: {
  projectId: string;
  assetId: string;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let valid = true;
    void call("asset.url", { projectId, assetId })
      .then((r) => {
        if (valid) setUrl(r.url);
      })
      .catch(() => {});
    return () => {
      valid = false;
    };
  }, [projectId, assetId]);
  return url ? (
    <img
      loading="lazy"
      src={url}
      alt="Recorded screen evidence"
      onClick={onClick}
    />
  ) : (
    <span>Loading screenshot…</span>
  );
}
export function WebinarApp() {
  const [billingOpen, setBillingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pages = useRef({ evidenceOffset: 0, transcriptOffset: 0 });
  const [sourceView, setSourceView] = useState<{
      recordingId: string;
      atUs: number;
    } | null>(null),
    [proposalId, setProposalId] = useState<string | null>(null);
  const [excludedSpans, setExcludedSpans] = useState<string[]>([]);
  const [projects, setProjects] = useState<any[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [snapshot, setSnapshot] = useState<any>(null);
  const [tab, setTab] = useState("capture"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [audience, setAudience] = useState(""),
    [objective, setObjective] = useState(""),
    [names, setNames] = useState("CharanTheAiGuy, Presenter 2, Presenter 3");
  const [budget, setBudget] = useState("5"),
    [minutes, setMinutes] = useState("30"),
    [sources, setSources] = useState<any[]>([]),
    [source, setSource] = useState(""),
    [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]),
    [microphone, setMicrophone] = useState("");
  const [capture, setCapture] = useState<any>({ state: "Idle" }),
    [providerOpen, setProviderOpen] = useState(false),
    [configured, setConfigured] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [selectedImages, setSelectedImages] = useState<string[]>([]),
    [inspector, setInspector] = useState<any>(null),
    [maskText, setMaskText] = useState(""),
    [cropText, setCropText] = useState("");
  const [draft, setDraft] = useState<ScriptDocument | null>(null),
    [dirty, setDirty] = useState(false),
    [base, setBase] = useState<string | null>(null),
    [sectionIndex, setSectionIndex] = useState(0);
  const dirtyRef = useRef(false),
    selectedRef = useRef(selected),
    headRef = useRef<string | null>(null),
    busyRef = useRef(false);
  dirtyRef.current = dirty;
  selectedRef.current = selected;
  busyRef.current = busy;
  async function refresh() {
    try {
      const [list, status] = await Promise.all([
        call("project.list"),
        call("capture.status"),
      ]);
      setProjects(list);
      setCapture(status);
      const projectId = selectedRef.current;
      if (projectId) {
        const s = await call("project.snapshot", {
          projectId,
          ...pages.current,
        });
        if (selectedRef.current !== projectId) return;
        setSnapshot(s);
        if (!dirtyRef.current && s.head?.id !== headRef.current) {
          setDraft(s.head?.document ?? null);
          setBase(s.head?.id ?? null);
          headRef.current = s.head?.id ?? null;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    void call("provider.status").then((p) => {
      setConfigured(p.configured);
    });
    const timer = setInterval(() => void refresh(), 2000);
    const off = window.webinar.onChanged(() => {
      if (!busyRef.current) void refresh();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);
  useEffect(() => {
    pages.current = { evidenceOffset: 0, transcriptOffset: 0 };
    headRef.current = null;
    setSnapshot(null);
    setDraft(null);
    setBase(null);
    setDirty(false);
    setPreview(null);
    setSelectedImages([]);
    setExcludedSpans([]);
    setSourceView(null);
    setProposalId(null);
    void refresh();
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let valid = true;
    void call("draft.get", { projectId: selected })
      .then((saved) => {
        if (valid && saved) {
          setDraft(saved.document);
          setBase(saved.baseRevisionId);
          setDirty(true);
          dirtyRef.current = true;
          setNotice(
            "Recovered unsaved edits. Compare with the latest revision before saving.",
          );
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      valid = false;
    };
  }, [selected]);
  useEffect(() => {
    if (!dirty || !draft || !selected) return;
    const timer = setTimeout(() => {
      void call("draft.save", {
        projectId: selected,
        draft: { document: draft, baseRevisionId: base, sequence: Date.now() },
      }).catch((e) =>
        setError("Draft recovery copy could not be saved: " + e.message),
      );
    }, 750);
    return () => clearTimeout(timer);
  }, [draft, dirty, selected, base]);
  async function act(fn: () => Promise<any>, message?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      if (message) setNotice(message);
      await refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(method: string, payload: any) {
    if (!snapshot) throw new Error("Choose a project.");
    return call(method, envelope(snapshot, payload));
  }
  function edit(fn: (doc: ScriptDocument) => void) {
    if (!draft) return;
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setDirty(true);
  }
  async function save() {
    if (!draft || !snapshot) return;
    const r = await mutate("script.save", {
      baseRevisionId: base,
      document: draft,
    });
    setDraft(r.document);
    setBase(r.id);
    headRef.current = r.id;
    dirtyRef.current = false;
    setDirty(false);
    await call("draft.clear", { projectId: selected });
    return r;
  }
  async function setupSources() {
    const list = await call("sources.list");
    setSources(list);
    setSource(list[0]?.token ?? "");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    const m = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput",
    );
    setMicrophones(m);
    setMicrophone(m[0]?.deviceId ?? "");
  }
  const section = draft?.sections[sectionIndex];
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  return (
    <div className="webinar-app">
      <aside className="wb-sidebar">
        <div className="wb-brand">
          <span className="wb-mark">nD</span>
          <div>
            <strong>nDimensions.AI</strong>
            <small>Webinar Script Recorder</small>
          </div>
        </div>
        <button className="wb-primary" onClick={() => setCreating(true)}>
          + New webinar
        </button>
        <div className="wb-projects">
          {projects.map((p) => (
            <button
              key={p.id}
              className={selected === p.id ? "selected" : ""}
              onClick={() => {
                if (p.id === selected) return;
                if (dirty && !confirm("Discard unsaved script edits?")) return;
                void act(async () => {
                  if (dirty) await call("draft.clear", { projectId: selected });
                  setSelected(p.id);
                });
              }}
            >
              <span>{p.title}</span>
              <small>
                {p.lifecycle === "Active" ? "Local project" : p.lifecycle}
              </small>
            </button>
          ))}
          {!projects.length && (
            <p>Your rehearsals and scripts will appear here.</p>
          )}
        </div>
        <button
          onClick={() =>
            void act(async () => {
              const r = await call("project.restore");
              if (r.projectId) setSelected(r.projectId);
            }, "Backup restored locally. Reapprove evidence before cloud use.")
          }
        >
          Restore backup
        </button>
        <button
          onClick={() =>
            void act(async () => {
              const r = await call("project.importLegacy");
              if (r.projectId) {
                setSelected(r.projectId);
                setNotice(r.report.limitations.join(" "));
              }
            })
          }
        >
          Import legacy session
        </button>
        <button onClick={() => setBillingOpen(true)}>
          AI request accounting
        </button>
        <button onClick={() => setProviderOpen(true)}>
          {configured ? "Gemini connected ✓" : "Connect AI"}
        </button>
        <small className="wb-owner">
          nDimensions.AI · CharanTheAiGuy
          <br />
          Recordings stay on this computer.
        </small>
      </aside>
      <main className="wb-main">
        <header className="wb-header">
          <div>
            <p className="wb-eyebrow">REHEARSE ONCE · REVIEW TOGETHER</p>
            <h1>
              {snapshot?.context.title ?? "Turn your rehearsal into a script"}
            </h1>
            <p>
              {snapshot
                ? "Record, select evidence, and prepare your team’s live running order."
                : "Capture your demonstration, keep the useful screenshots, and build a presenter-ready Word document."}
            </p>
          </div>
          {snapshot && (
            <button
              disabled={dirty || busy}
              onClick={() => setSettingsOpen(true)}
            >
              Project settings
            </button>
          )}
          {snapshot && (
            <button
              onClick={() =>
                void act(
                  () => call("project.backup", { projectId: selected }),
                  "Backup saved.",
                )
              }
              disabled={busy}
            >
              Back up project
            </button>
          )}
        </header>
        {error && (
          <div className="wb-alert" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div className="wb-notice" role="status">
            {notice}
          </div>
        )}
        {!snapshot ? (
          <div className="wb-empty">
            <div className="wb-orbit">●</div>
            <h2>A clear script starts with a real rehearsal.</h2>
            <p>
              One narrator. Three or four presenters. Screenshots grounded in
              what actually happened.
            </p>
            <button className="wb-primary" onClick={() => setCreating(true)}>
              Create your first webinar
            </button>
          </div>
        ) : (
          <>
            <nav className="wb-tabs">
              {[
                ["capture", "1 · Record"],
                ["evidence", "2 · Evidence"],
                ["script", "3 · Script"],
                ["export", "4 · Deliver"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {snapshot.jobs.some((j: any) => j.state === "Running") && (
              <div className="wb-notice">
                {capture.localProgress ??
                  "Processing locally or with your approved provider…"}{" "}
                {snapshot.jobs
                  .filter((j: any) => j.state === "Running")
                  .map((j: any) => (
                    <span key={j.id}>
                      {j.stage}{" "}
                      <button
                        onClick={() =>
                          void act(() => mutate("jobs.cancel", { jobId: j.id }))
                        }
                      >
                        Cancel
                      </button>
                    </span>
                  ))}
              </div>
            )}
            {snapshot.jobs
              .filter((j: any) =>
                ["Failed", "WaitingForReview"].includes(j.state),
              )
              .map((j: any) => (
                <div className="wb-alert" key={j.id}>
                  {j.stage}: {j.error_code ?? "Needs review"}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          mutate("jobs.retry", {
                            jobId: j.id,
                            acceptUncertainCharge:
                              j.error_code === "PROVIDER_UNKNOWN"
                                ? confirm(
                                    "The earlier request may have incurred a charge. Reserve budget for a retry?",
                                  )
                                : false,
                          }),
                        "Job is ready. Start the operation again to retry.",
                      )
                    }
                  >
                    Prepare retry
                  </button>
                </div>
              ))}
            {tab === "capture" && (
              <div className="wb-grid">
                <section className="wb-card">
                  <h2>Rehearsal capture</h2>
                  <p>
                    Choose one screen and your microphone. Your full recording
                    remains local.
                  </p>
                  <button
                    onClick={() => void act(setupSources)}
                    disabled={busy || capture.state !== "Idle"}
                  >
                    Preview capture devices
                  </button>
                  <div className="wb-sources">
                    {sources.map((s) => (
                      <button
                        key={s.token}
                        className={source === s.token ? "chosen" : ""}
                        onClick={() => setSource(s.token)}
                      >
                        <img src={s.thumbnail} alt={s.name} />
                        {s.name}
                      </button>
                    ))}
                  </div>
                  <label>
                    Microphone
                    <select
                      value={microphone}
                      onChange={(e) => setMicrophone(e.target.value)}
                    >
                      {microphones.map((m) => (
                        <option key={m.deviceId} value={m.deviceId}>
                          {m.label || "Microphone"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {capture.state === "Idle" && (
                    <MicrophonePreview deviceId={microphone} />
                  )}
                  <div className="wb-record-state">
                    <span
                      className={capture.state === "Recording" ? "wb-live" : ""}
                    >
                      ●
                    </span>
                    <strong>{capture.state}</strong>
                    <span>{seconds(capture.atUs ?? 0)}</span>
                  </div>
                  <div className="wb-actions">
                    {capture.state === "Idle" ? (
                      <button
                        className="wb-primary"
                        disabled={!source || busy}
                        onClick={() =>
                          void act(() =>
                            call("record.start", {
                              projectId: selected,
                              sourceToken: source,
                              microphoneId: microphone,
                            }),
                          )
                        }
                      >
                        Start rehearsal
                      </button>
                    ) : (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              call(
                                capture.state === "Paused"
                                  ? "record.resume"
                                  : "record.pause",
                                {},
                              ),
                            )
                          }
                        >
                          {capture.state === "Paused" ? "Resume" : "Pause"}
                        </button>
                        <button
                          disabled={busy || capture.state !== "Recording"}
                          onClick={() =>
                            void act(() =>
                              call("record.marker", {
                                label: "Important moment",
                              }),
                            )
                          }
                        >
                          Mark moment
                        </button>
                        <button
                          className="wb-danger"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => call("record.stop", {}),
                              "Recording saved. Transcribe it below.",
                            )
                          }
                        >
                          Stop and save
                        </button>
                      </>
                    )}
                  </div>
                </section>
                <section className="wb-card">
                  <h2>Recordings</h2>
                  {!snapshot.recordings.length ? (
                    <p>
                      No recording yet. Run your demo as you would explain it to
                      the team.
                    </p>
                  ) : (
                    snapshot.recordings.map((r: any) => (
                      <div className="wb-recording" key={r.id}>
                        <strong>
                          {new Date(r.started_at).toLocaleString()}
                        </strong>
                        <small>
                          {r.state} · {seconds(r.duration_us ?? 0)}
                        </small>
                        <button
                          onClick={() =>
                            setSourceView({ recordingId: r.id, atUs: 0 })
                          }
                        >
                          Play source
                        </button>
                        <button
                          disabled={
                            busy ||
                            !["Captured", "Incomplete"].includes(r.state) ||
                            r.has_transcript
                          }
                          onClick={() =>
                            void act(
                              () =>
                                call("jobs.transcribe", {
                                  projectId: selected,
                                  recordingId: r.id,
                                  allowDownload: true,
                                }),
                              "Local transcription started. The first run downloads the speech model.",
                            )
                          }
                        >
                          Transcribe locally
                        </button>
                      </div>
                    ))
                  )}
                  <h3>Presenter team</h3>
                  <p>
                    {snapshot.presenters.map((p: any) => p.name).join(" · ") ||
                      "Add presenters when creating the project."}
                  </p>
                </section>
              </div>
            )}
            {tab === "evidence" && (
              <>
                <div className="wb-section-header">
                  <div>
                    <h2>Choose what tells the story</h2>
                    <button
                      disabled={busy || capture.state !== "Idle"}
                      onClick={() =>
                        void act(
                          () => call("jobs.scenes", { projectId: selected }),
                          "Local screenshot ranking started. All original images remain available.",
                        )
                      }
                    >
                      Rank screenshots locally
                    </button>
                    <p>
                      Inspect screenshots, crop details and mask sensitive areas
                      before cloud processing.
                    </p>
                  </div>
                  <button
                    disabled={busy || !snapshot.evidence.length}
                    onClick={() =>
                      void act(async () => {
                        const ids: string[] = [];
                        for (const e of snapshot.evidence) {
                          const existing = snapshot.derivatives
                            .filter((d: any) => d.evidence_id === e.id)
                            .at(-1);
                          if (existing) {
                            ids.push(existing.id);
                            continue;
                          }
                          const d = await call("evidence.derive", {
                            projectId: selected,
                            evidenceId: e.id,
                            plan: {
                              crop: {
                                x: 0,
                                y: 0,
                                width: e.width,
                                height: e.height,
                              },
                              masks: [],
                              fill: "#000000",
                              transformVersion: "1",
                            },
                          });
                          ids.push(d.id);
                        }
                        setSelectedImages((v) => [...new Set([...v, ...ids])]);
                      }, "Screenshot copies prepared. Review them before approval.")
                    }
                  >
                    Prepare copies on this page
                  </button>
                </div>
                <div className="wb-actions">
                  <span>
                    {snapshot.counts.evidence} screenshots · page{" "}
                    {Math.floor(pages.current.evidenceOffset / 100) + 1}
                  </span>
                  <button
                    disabled={pages.current.evidenceOffset === 0}
                    onClick={() => {
                      pages.current.evidenceOffset = Math.max(
                        0,
                        pages.current.evidenceOffset - 100,
                      );
                      void refresh();
                    }}
                  >
                    Previous screenshots
                  </button>
                  <button
                    disabled={
                      pages.current.evidenceOffset + 100 >=
                      snapshot.counts.evidence
                    }
                    onClick={() => {
                      pages.current.evidenceOffset += 100;
                      void refresh();
                    }}
                  >
                    Next screenshots
                  </button>
                </div>
                <div className="wb-evidence-grid">
                  {snapshot.evidence.map((e: any) => {
                    const d = snapshot.derivatives
                      .filter((x: any) => x.evidence_id === e.id)
                      .at(-1);
                    return (
                      <article className="wb-evidence" key={e.id}>
                        <AssetImage
                          projectId={selected!}
                          assetId={d?.asset_id ?? e.raw_asset_id}
                          onClick={() => {
                            setInspector(e);
                            setCropText(`0, 0, ${e.width}, ${e.height}`);
                            setMaskText("");
                          }}
                        />
                        <div>
                          <span>
                            {seconds(e.at_us)}
                            {JSON.parse(e.quality_json).recommended
                              ? " · Suggested"
                              : ""}
                          </span>
                          <button
                            onClick={() => {
                              setInspector(e);
                              setCropText(`0, 0, ${e.width}, ${e.height}`);
                              setMaskText("");
                            }}
                          >
                            Inspect / redact
                          </button>
                          {d && (
                            <label>
                              <input
                                type="checkbox"
                                checked={selectedImages.includes(d.id)}
                                onChange={(event) =>
                                  setSelectedImages((v) =>
                                    event.target.checked
                                      ? [...v, d.id]
                                      : v.filter((i) => i !== d.id),
                                  )
                                }
                              />
                              Include
                            </label>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <section className="wb-card">
                  <h2>Transcript</h2>
                  <p>
                    All passages are included in cloud evidence unless you
                    uncheck them. Review the complete payload before approving
                    it.
                  </p>
                  <div className="wb-actions">
                    <span>
                      {snapshot.counts.transcript} passages · page{" "}
                      {Math.floor(pages.current.transcriptOffset / 100) + 1}
                    </span>
                    <button
                      disabled={pages.current.transcriptOffset === 0}
                      onClick={() => {
                        pages.current.transcriptOffset = Math.max(
                          0,
                          pages.current.transcriptOffset - 100,
                        );
                        void refresh();
                      }}
                    >
                      Previous passages
                    </button>
                    <button
                      disabled={
                        pages.current.transcriptOffset + 100 >=
                        snapshot.counts.transcript
                      }
                      onClick={() => {
                        pages.current.transcriptOffset += 100;
                        void refresh();
                      }}
                    >
                      Next passages
                    </button>
                  </div>
                  {!snapshot.transcript.length ? (
                    <p>
                      Transcribe a recording to inspect and correct narration.
                    </p>
                  ) : (
                    snapshot.transcript.map((t: any) => (
                      <div className="wb-transcript" key={t.id}>
                        <button
                          onClick={() =>
                            setSourceView({
                              recordingId: t.recording_id,
                              atUs: t.start_us,
                            })
                          }
                        >
                          {seconds(t.start_us)} · Play
                        </button>
                        <label>
                          <input
                            type="checkbox"
                            checked={!excludedSpans.includes(t.id)}
                            onChange={(e) =>
                              setExcludedSpans((v) =>
                                e.target.checked
                                  ? v.filter((id) => id !== t.id)
                                  : [...v, t.id],
                              )
                            }
                          />
                          Include in AI evidence
                        </label>
                        <textarea
                          defaultValue={t.current_text}
                          key={t.id + t.current_text}
                          onBlur={(e) => {
                            if (e.target.value !== t.current_text)
                              void act(() =>
                                mutate("transcript.correct", {
                                  spanId: t.id,
                                  text: e.target.value,
                                }),
                              );
                          }}
                          aria-label={`Transcript at ${seconds(t.start_us)}`}
                        />
                      </div>
                    ))
                  )}
                </section>
                <div className="wb-actions">
                  <button
                    disabled={
                      busy || !snapshot.transcript.length || !configured
                    }
                    className="wb-primary"
                    onClick={() =>
                      void act(async () =>
                        setPreview(
                          await call("evidence.prepare", {
                            projectId: selected,
                            derivativeIds: selectedImages,
                            excludedSpanIds: excludedSpans,
                          }),
                        ),
                      )
                    }
                  >
                    Review cloud payload
                  </button>
                  <button
                    disabled={busy || !snapshot.transcript.length}
                    onClick={() =>
                      void act(async () => {
                        await mutate("script.manual", {});
                        setTab("script");
                      }, "Manual transcript draft created. No AI request was sent.")
                    }
                  >
                    Start a manual script
                  </button>
                </div>
              </>
            )}
            {tab === "script" &&
              (!draft ? (
                <section className="wb-empty">
                  <h2>Your script will appear here</h2>
                  <p>
                    Transcribe the rehearsal, then approve selected evidence for
                    AI drafting or create a manual script.
                  </p>
                  <button onClick={() => setTab("evidence")}>
                    Go to evidence
                  </button>
                </section>
              ) : (
                <div className="wb-editor">
                  <aside className="wb-outline">
                    <h3>Running order</h3>
                    <p>
                      Estimated {Math.ceil(timing(draft).total / 60)} min /
                      target{" "}
                      {Math.ceil(draft.context.targetDurationSeconds / 60)} min
                    </p>
                    {draft.presenters.map((p) => (
                      <small key={p.id}>
                        {p.name}:{" "}
                        {Math.ceil((timing(draft).presenters[p.id] ?? 0) / 60)}{" "}
                        min
                        <br />
                      </small>
                    ))}
                    {draft.sections.map((s, i) => (
                      <button
                        key={s.id}
                        className={sectionIndex === i ? "selected" : ""}
                        onClick={() => setSectionIndex(i)}
                      >
                        {i + 1}. {s.title}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        edit((d) =>
                          d.sections.push({
                            id: crypto.randomUUID(),
                            title: "New section",
                            presenterId: null,
                            assignment: "unassigned",
                            handoffToPresenterId: null,
                            blocks: [],
                          }),
                        )
                      }
                    >
                      + Section
                    </button>
                  </aside>
                  <section className="wb-script">
                    <div className="wb-section-header">
                      <span>
                        {dirty ? "Unsaved edits" : "Saved"} {base?.slice(0, 8)}
                      </span>
                      <button
                        disabled={busy || !dirty}
                        className="wb-primary"
                        onClick={() =>
                          void act(save, "Script saved as a new revision.")
                        }
                      >
                        Save revision
                      </button>
                    </div>
                    {section && (
                      <>
                        <input
                          className="wb-title-input"
                          value={section.title}
                          onChange={(e) =>
                            edit((d) => {
                              d.sections[sectionIndex].title = e.target.value;
                            })
                          }
                          aria-label="Section title"
                        />
                        <label>
                          Presenter
                          <select
                            value={section.presenterId ?? ""}
                            onChange={(e) =>
                              edit((d) => {
                                const s = d.sections[sectionIndex];
                                s.presenterId = e.target.value || null;
                                s.assignment = e.target.value
                                  ? "confirmed"
                                  : "unassigned";
                              })
                            }
                          >
                            <option value="">Unassigned</option>
                            {draft.presenters.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Handoff to
                          <select
                            value={section.handoffToPresenterId ?? ""}
                            onChange={(e) =>
                              edit((d) => {
                                d.sections[sectionIndex].handoffToPresenterId =
                                  e.target.value || null;
                              })
                            }
                          >
                            <option value="">No handoff</option>
                            {draft.presenters.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="wb-actions">
                          <button
                            disabled={sectionIndex === 0}
                            onClick={() =>
                              edit((d) => {
                                [
                                  d.sections[sectionIndex - 1],
                                  d.sections[sectionIndex],
                                ] = [
                                  d.sections[sectionIndex],
                                  d.sections[sectionIndex - 1],
                                ];
                                setSectionIndex(sectionIndex - 1);
                              })
                            }
                          >
                            Move up
                          </button>
                          <button
                            disabled={
                              sectionIndex === draft.sections.length - 1
                            }
                            onClick={() =>
                              edit((d) => {
                                [
                                  d.sections[sectionIndex + 1],
                                  d.sections[sectionIndex],
                                ] = [
                                  d.sections[sectionIndex],
                                  d.sections[sectionIndex + 1],
                                ];
                                setSectionIndex(sectionIndex + 1);
                              })
                            }
                          >
                            Move down
                          </button>
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  "Exclude this section from the script? Source evidence is retained.",
                                )
                              )
                                edit((d) => {
                                  d.sections.splice(sectionIndex, 1);
                                  setSectionIndex(
                                    Math.max(0, sectionIndex - 1),
                                  );
                                });
                            }}
                          >
                            Exclude section
                          </button>
                        </div>
                        {section.blocks.map((b, i) => (
                          <article className="wb-block" key={b.id}>
                            <div>
                              <select
                                aria-label="Block type"
                                value={b.kind}
                                onChange={(e) =>
                                  edit((d) => {
                                    d.sections[sectionIndex].blocks[i].kind = e
                                      .target.value as typeof b.kind;
                                  })
                                }
                              >
                                {[
                                  "say",
                                  "do",
                                  "show",
                                  "producer",
                                  "handoff",
                                ].map((k) => (
                                  <option key={k} value={k}>
                                    {k.toUpperCase()}
                                  </option>
                                ))}
                              </select>
                              <small>{b.provenance.replace("_", " ")}</small>
                            </div>
                            <textarea
                              value={b.text}
                              onChange={(e) =>
                                edit((d) => {
                                  d.sections[sectionIndex].blocks[i].text =
                                    e.target.value;
                                })
                              }
                              aria-label={`${b.kind} text`}
                            />
                            <div className="wb-block-meta">
                              <label>
                                Estimated seconds
                                <input
                                  type="number"
                                  min="0"
                                  value={b.durationSeconds ?? ""}
                                  placeholder="Auto for speech"
                                  onChange={(e) =>
                                    edit((d) => {
                                      d.sections[sectionIndex].blocks[
                                        i
                                      ].durationSeconds =
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value);
                                    })
                                  }
                                />
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={b.timingMode === "overlap"}
                                  disabled={i === 0}
                                  onChange={(e) =>
                                    edit((d) => {
                                      const blocks =
                                        d.sections[sectionIndex].blocks;
                                      blocks[i].timingMode = e.target.checked
                                        ? "overlap"
                                        : "serial";
                                      blocks[i].timingGroup = e.target.checked
                                        ? blocks[i - 1].timingGroup
                                        : crypto.randomUUID();
                                      if (e.target.checked)
                                        blocks[i - 1].timingMode = "overlap";
                                    })
                                  }
                                />
                                Overlap timing with previous block
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={!b.requiresTechnicalVerification}
                                  onChange={(e) =>
                                    edit((d) => {
                                      d.sections[sectionIndex].blocks[
                                        i
                                      ].requiresTechnicalVerification =
                                        !e.target.checked;
                                    })
                                  }
                                />
                                Technical details verified against source
                              </label>
                            </div>
                            {b.refs.map((r) => (
                              <small key={r.kind + r.id}>
                                {r.kind} ·{" "}
                                {r.source ? (
                                  <button
                                    onClick={() =>
                                      setSourceView({
                                        recordingId: r.source!.recordingId,
                                        atUs: r.source!.startUs,
                                      })
                                    }
                                  >
                                    {seconds(r.source.startUs)} · Verify source
                                  </button>
                                ) : (
                                  "user supplied"
                                )}
                              </small>
                            ))}
                            <label>
                              Screenshots
                              <select
                                multiple
                                value={b.imageDerivativeIds}
                                onChange={(e) => {
                                  const values = Array.from(
                                    e.target.selectedOptions,
                                  ).map((o) => o.value);
                                  edit((d) => {
                                    d.sections[sectionIndex].blocks[
                                      i
                                    ].imageDerivativeIds = values;
                                  });
                                }}
                              >
                                {snapshot.derivatives.map((d: any) => (
                                  <option key={d.id} value={d.id}>
                                    {seconds(
                                      snapshot.evidence.find(
                                        (e: any) => e.id === d.evidence_id,
                                      )?.at_us ?? 0,
                                    )}{" "}
                                    · {d.id.slice(0, 8)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {b.imageDerivativeIds.map((imageId) => {
                              const d = snapshot.derivatives.find(
                                (v: any) => v.id === imageId,
                              );
                              return d ? (
                                <AssetImage
                                  key={imageId}
                                  projectId={selected!}
                                  assetId={d.asset_id}
                                />
                              ) : null;
                            })}
                          </article>
                        ))}
                        <button
                          onClick={() =>
                            edit((d) =>
                              d.sections[sectionIndex].blocks.push({
                                id: crypto.randomUUID(),
                                kind: "say",
                                text: "",
                                provenance: "editorial",
                                refs: [],
                                stepRefs: [],
                                imageDerivativeIds: [],
                                timingGroup: crypto.randomUUID(),
                                timingMode: "serial",
                                durationSeconds: null,
                                requiresTechnicalVerification: false,
                              }),
                            )
                          }
                        >
                          + Editorial spoken block
                        </button>
                      </>
                    )}
                  </section>
                  <aside className="wb-review">
                    <h3>Review items</h3>
                    {snapshot.flags.length === 0 ? (
                      <p>No generated review flags.</p>
                    ) : (
                      snapshot.flags.map((f: any) => (
                        <div key={f.id}>
                          <strong>{f.code.replaceAll("_", " ")}</strong>
                          <p>{JSON.parse(f.detail_json).message}</p>
                          {f.decision ? (
                            <small>Resolved: {f.decision}</small>
                          ) : (
                            <small>
                              Update the script and save a revision, or verify
                              this issue.
                            </small>
                          )}
                          {!f.decision &&
                            ![
                              "PRESENTER_UNCONFIRMED",
                              "EMPTY_SCRIPT",
                              "EMPTY_SECTION",
                              "TAKE_UNRESOLVED",
                            ].includes(f.code) && (
                              <button
                                disabled={dirty || busy}
                                onClick={() => {
                                  const reason = prompt(
                                    "Describe how you checked this issue against the source (at least 10 characters).",
                                  );
                                  if (reason)
                                    void act(() =>
                                      mutate("review.resolve", {
                                        revisionId: base,
                                        flagId: f.id,
                                        decision: "verified",
                                        reason,
                                        refs: [],
                                      }),
                                    );
                                }}
                              >
                                Record verification
                              </button>
                            )}
                        </div>
                      ))
                    )}
                    {snapshot.takes
                      ?.filter((t: any) => !t.selected_step_id)
                      .map((t: any) => (
                        <div key={t.id}>
                          <h3>Choose a retake</h3>
                          <p>Compare the source timestamps before choosing.</p>
                          {JSON.parse(t.members_json).map(
                            (m: any, i: number) => (
                              <button
                                key={m.id}
                                disabled={dirty || busy}
                                onClick={() =>
                                  void act(async () => {
                                    const r = await mutate("take.select", {
                                      groupId: t.id,
                                      expectedGroupVersion: t.version,
                                      stepId: m.id,
                                      stepVersion: m.version,
                                    });
                                    setProposalId(r.proposedRevisionId);
                                  })
                                }
                              >
                                Use take {i + 1}
                              </button>
                            ),
                          )}
                        </div>
                      ))}
                    {snapshot.proposals.length > 0 && (
                      <>
                        <h3>AI proposals</h3>
                        <p>
                          Proposals never overwrite your edits. Merge with
                          explicit review.
                        </p>
                        {snapshot.proposals.map((p: any) => (
                          <button
                            key={p.id}
                            disabled={dirty || busy}
                            onClick={() => setProposalId(p.id)}
                          >
                            {new Date(p.created_at).toLocaleString()}
                          </button>
                        ))}
                      </>
                    )}
                  </aside>
                </div>
              ))}
            {tab === "export" && (
              <section className="wb-card wb-delivery">
                <h2>Deliver the team’s script</h2>
                <p>
                  Word includes editable speech, demonstration instructions,
                  presenter names, screenshots, and source timestamps.
                </p>
                <div className="wb-actions">
                  <button
                    disabled={busy || dirty || !draft}
                    onClick={() =>
                      void act(
                        () =>
                          call("jobs.export", {
                            projectId: selected,
                            revisionId: base,
                            mode: "draft",
                          }),
                        "Draft export is being prepared.",
                      )
                    }
                  >
                    Prepare draft Word
                  </button>
                  <button
                    disabled={busy || dirty || !draft}
                    onClick={() =>
                      void act(async () => {
                        const dep = await call("project.dependency", {
                          projectId: selected,
                          revisionId: base,
                        });
                        return mutate("script.approve", {
                          revisionId: base,
                          dependencyHash: dep.hash,
                        });
                      }, "This exact revision is approved.")
                    }
                  >
                    Approve revision
                  </button>
                  <button
                    disabled={busy || dirty || !snapshot.approval}
                    className="wb-primary"
                    onClick={() =>
                      void act(
                        () =>
                          call("jobs.export", {
                            projectId: selected,
                            revisionId: base,
                            mode: "ready",
                          }),
                        "Approved export is being prepared.",
                      )
                    }
                  >
                    Prepare approved Word
                  </button>
                </div>
                {dirty && <p>Save your script edits before exporting.</p>}
                {snapshot.jobs
                  .filter(
                    (j: any) => j.stage === "export" && j.state === "Succeeded",
                  )
                  .map((j: any) => (
                    <div className="wb-recording" key={j.id}>
                      <strong>Word document ready</strong>
                      <button
                        onClick={() =>
                          void act(async () => {
                            const output = await call("job.output", {
                              projectId: selected,
                              jobId: j.id,
                            });
                            return call("export.download", {
                              projectId: selected,
                              exportId: output.exportId,
                            });
                          }, "Word export saved.")
                        }
                      >
                        Save Word document
                      </button>
                    </div>
                  ))}
                <hr />
                <p>
                  Project budget: ${(snapshot.budgetMicrousd / 1e6).toFixed(2)}.
                  Unknown provider outcomes keep their reservation.
                </p>
                <button
                  className="wb-danger"
                  disabled={busy || capture.state !== "Idle"}
                  onClick={() => {
                    if (
                      confirm(
                        "Delete this project and its local recordings? Exported Word documents are kept.",
                      )
                    )
                      void act(async () => {
                        await mutate("project.delete", {
                          confirmProjectId: selected,
                        });
                        setSelected(null);
                        setSnapshot(null);
                      });
                  }}
                >
                  Delete project
                </button>
              </section>
            )}
          </>
        )}
      </main>
      {settingsOpen && snapshot && (
        <ProjectSettings
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void refresh()}
        />
      )}
      {sourceView && selected && (
        <SourcePlayer
          projectId={selected}
          {...sourceView}
          onClose={() => setSourceView(null)}
        />
      )}
      {proposalId && selected && draft && (
        <RevisionCompare
          projectId={selected}
          current={draft}
          proposalId={proposalId}
          onClose={() => setProposalId(null)}
          onMerge={async (document) => {
            const r = await mutate("script.merge", {
              baseRevisionId: base,
              proposedRevisionId: proposalId,
              resolvedDocument: document,
            });
            setDraft(r.document);
            setBase(r.id);
            headRef.current = r.id;
            setDirty(false);
            setProposalId(null);
            await refresh();
          }}
        />
      )}
      {billingOpen && <Billing onClose={() => setBillingOpen(false)} />}
      {creating && (
        <div className="wb-overlay">
          {error && (
            <div className="wb-modal-error" role="alert">
              {error}
            </div>
          )}
          <form
            className="wb-modal"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const created = await call("project.create", {
                  context: {
                    title,
                    narrator: names.split(",")[0].trim(),
                    audience,
                    objective,
                    targetDurationSeconds: Number(minutes) * 60,
                    language: "en",
                    glossary: [],
                  },
                  budgetMicrousd: Math.round(Number(budget) * 1e6),
                });
                const s = await call("project.snapshot", {
                  projectId: created.projectId,
                });
                await call(
                  "presenters.save",
                  envelope(s, {
                    presenters: names
                      .split(",")
                      .map((name) => ({
                        id: null,
                        name: name.trim(),
                        wordsPerMinute: 130,
                        active: true,
                      })),
                  }),
                );
                setSelected(created.projectId);
                setCreating(false);
              });
            }}
          >
            <h2>New webinar</h2>
            <label>
              Title
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Audience
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              />
            </label>
            <label>
              Learning objective
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </label>
            <label>
              Presenters, separated by commas
              <input
                required
                value={names}
                onChange={(e) => setNames(e.target.value)}
              />
            </label>
            <div className="wb-grid">
              <label>
                Target minutes
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
              <label>
                AI budget in USD
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </label>
            </div>
            <div className="wb-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button disabled={busy} className="wb-primary">
                Create webinar
              </button>
            </div>
          </form>
        </div>
      )}
      {providerOpen && (
        <ProviderConnection
          onClose={() => setProviderOpen(false)}
          onConnected={() => {
            setConfigured(true);
            setProviderOpen(false);
            setNotice("Gemini is connected. Your AI settings are ready.");
          }}
        />
      )}
      {inspector && (
        <div className="wb-overlay">
          {error && (
            <div className="wb-modal-error" role="alert">
              {error}
            </div>
          )}
          <div className="wb-modal wb-wide">
            <h2>Inspect original screenshot</h2>
            <AssetImage
              projectId={selected!}
              assetId={inspector.raw_asset_id}
            />
            <p>
              Dimensions: {inspector.width} × {inspector.height}. Masks use
              original image coordinates.
            </p>
            <button
              type="button"
              disabled={busy || capture.state !== "Idle"}
              onClick={() =>
                void act(async () => {
                  const result = await call("evidence.inspectText", {
                    projectId: selected,
                    evidenceId: inspector.id,
                  });
                  setMaskText((v) =>
                    [
                      v,
                      ...result.masks.map(
                        (r: any) => `${r.x}, ${r.y}, ${r.width}, ${r.height}`,
                      ),
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  );
                  setNotice(result.note);
                })
              }
            >
              Suggest sensitive-text masks locally
            </button>
            <label>
              Crop: x, y, width, height
              <input
                value={cropText}
                onChange={(e) => setCropText(e.target.value)}
              />
            </label>
            <label>
              Solid masks: one x, y, width, height per line
              <textarea
                value={maskText}
                onChange={(e) => setMaskText(e.target.value)}
                placeholder="Example: 100, 200, 300, 50"
              />
            </label>
            <div className="wb-actions">
              <button onClick={() => setInspector(null)}>Close</button>
              <button
                className="wb-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const rect = (text: string) => {
                      const [x, y, width, height] = text.split(",").map(Number);
                      return { x, y, width, height };
                    };
                    const r = await call("evidence.derive", {
                      projectId: selected,
                      evidenceId: inspector.id,
                      plan: {
                        crop: rect(cropText),
                        masks: maskText.trim()
                          ? maskText.trim().split("\n").map(rect)
                          : [],
                        fill: "#000000",
                        transformVersion: "1",
                      },
                    });
                    setSelectedImages((v) => [...v, r.id]);
                    setInspector(null);
                  }, "A new redacted copy was created. The original stays local.")
                }
              >
                Create reviewed copy
              </button>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <div className="wb-overlay">
          {error && (
            <div className="wb-modal-error" role="alert">
              {error}
            </div>
          )}
          <div className="wb-modal wb-wide">
            <h2>Review exactly what leaves this computer</h2>
            <p>
              {preview.images.length} selected images and {preview.texts.length}{" "}
              text passages. Raw audio and video are excluded.
            </p>
            <div className="wb-preview-grid">
              {preview.images.map((i) => {
                const d = snapshot.derivatives.find(
                  (d: any) => d.id === i.derivativeId,
                );
                return d ? (
                  <AssetImage
                    key={i.derivativeId}
                    projectId={selected!}
                    assetId={d.asset_id}
                  />
                ) : null;
              })}
            </div>
            {preview.texts.map((t) => (
              <pre className="wb-passage" key={t.textId}>
                {t.text}
              </pre>
            ))}
            <div className="wb-actions">
              <button onClick={() => setPreview(null)}>Back to evidence</button>
              <button
                className="wb-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const approved = await mutate("manifest.approve", {
                      candidateHash: preview.hash,
                    });
                    await call("jobs.generate", {
                      projectId: selected,
                      manifestId: approved.id,
                    });
                    setPreview(null);
                    setTab("script");
                  }, "Approved evidence sent for drafting. You can cancel from the progress panel.")
                }
              >
                Approve evidence and generate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
