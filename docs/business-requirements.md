> Historical design/review baseline. The [focused product amendment](publication-audit.md) supersedes references to the removed Copilot, terminal and builder features.

# Webinar Script Recorder Business Requirements

Version 0.1 | 25 October 2026 | Proposed baseline for product review

Project and document owners: nDimensions.AI and CharanTheAiGuy.

## 1 Business purpose

Build a desktop application that turns a narrated webinar rehearsal into an editable Word script with real screenshots, demonstration instructions, presenter assignments, timing estimates, and handoff cues. The primary use case is a LinkedIn Live webinar delivered by three or four presenters.

Today, the webinar lead demonstrates the entire session to the team, then manually reconstructs the script, captures screenshots, and divides responsibilities. This repeats work already performed during rehearsal and makes it easy for the written plan to drift from the actual demonstration.

The proposed product captures the rehearsal once and generates a script grounded in that recording. The team reviews and corrects the draft before using it live. Complete unattended accuracy is not a credible requirement; traceable evidence, visible uncertainty, and efficient correction are.

## 2 Confirmed needs and proposed boundaries

The user has confirmed that one person narrates the whole rehearsal, the final script is divided among three or four presenters, and the main deliverable is an editable Word document containing screenshots. Narration must preserve the presenter's explanation and teaching sequence rather than replace it with a generic webinar outline.

Proposed MVP boundaries are Windows 11, English narration, one selected display at a time, and rehearsals lasting 30 to 60 minutes. These boundaries remain subject to product review. Multiple applications on the selected display, including VS Code, a browser, slides, and a terminal, are in scope.

Live transcription is optional. The complete script is generated after recording stops. A single editor manages the project and distributes the Word document through the team's existing process.

## 3 Business outcomes and ownership

The main outcome is less manual preparation without losing important demonstration steps. The pilot will compare total hands-on preparation time against today's workflow, including review and correction time.

| Role | Responsibility |
| --- | --- |
| Webinar lead | Records the rehearsal, verifies technical accuracy, and owns the final script. |
| Presenters | Review their assigned sections, timing, and handoffs. |
| Producer or coordinator | Checks the overall running order and distribution of work; may be the webinar lead. |
| Product owner | Accepts scope, cost limits, and pilot results; an individual is to be nominated. |

<!-- pagebreak -->

## 4 Intended workflow

1. Create a webinar project with its title, audience, learning objective, planned duration, presenter names, and any preferred section assignments. Add a glossary for product names and technical terms when helpful.
2. Select the display and microphone. Run a short preview to verify sound and readable screen content before starting.
3. Record the complete demonstration while narrating naturally. Optionally mark important moments, section boundaries, retakes, or discussion that should be excluded.
4. Stop recording. The application saves the source material and shows whether audio and screen capture are complete.
5. Generate a draft. The application aligns narration with screen evidence, identifies sections, selects screenshots, and prepares spoken text and action instructions.
6. Review the draft beside its source recording. Correct words, replace screenshots, resolve uncertain details, remove rehearsal discussion, and assign sections to presenters.
7. Check estimated duration and handoffs. Approve a version and export an editable Word document with embedded images.

## 5 Capture requirements

All requirements marked Must are required for MVP acceptance. Should requirements may move to a later release if the core workflow meets its quality targets.

**BR01 Must — Project setup.** Store webinar context, presenter names, intended duration, and optional glossary. The narrator's identity and each live presenter's assignment are separate fields. Missing assignments remain visibly unassigned.

**BR02 Must — Complete rehearsal capture.** Record microphone audio and the selected screen using a shared timeline. Provide start, pause, resume, stop, and a visible recording indicator. Preserve timing across pauses. Do not capture unrelated displays automatically.

**BR03 Must — Capture health.** Check microphone input, screen availability, and storage before recording. Show capture failures during the session and mark affected intervals. Do not present an incomplete recording as complete; recovery must preserve usable material.

**BR04 Should — Lightweight markers.** Provide a shortcut to flag a screenshot-worthy moment or section boundary without blocking the demonstration. Markers help selection but are not required for successful script generation. Spoken retake or exclusion cues must be reviewable suggestions rather than irreversible deletions.

<!-- pagebreak -->

## 6 Script generation requirements

**BR05 Must — Timestamped transcription.** Produce editable narration linked to source intervals. Preserve technical terms, numbers, filenames, and command arguments. Flag unclear speech and missing audio. Glossary corrections must not silently change what a command does.

**BR06 Must — Demonstration sequence.** Identify the introduction, explanation, demonstration steps, observed results, transitions, and conclusion where present. Keep dependencies in order. Distinguish an action that was performed from one merely described or proposed.

**BR07 Must — Faithful spoken script.** Convert narration into natural spoken lines while preserving meaning and the presenter's teaching style. Remove filler and repetition where safe. Label newly suggested introductions, transitions, or closing text as editorial additions. Missing factual content must become a review item rather than an invented claim.

**BR08 Must — Rehearsal decisions and retakes.** Separate audience-facing narration from team discussion and production notes. Propose the intended take when a demo is repeated; allow the editor to choose. Keep original evidence so exclusions can be reversed. A failed action must not become a successful demonstration unless a later successful take supports it.

**BR09 Must — Real screenshots.** Select source frames that explain important actions and results. Use before-and-after images when they add meaning. Avoid redundant frames and transient menus unless relevant. Every image must retain a source recording identifier and timestamp. Never generate or reconstruct a screenshot as evidence.

**BR10 Must — Readable technical detail.** Allow full-size inspection, cropping, and replacement from nearby frames. Crops must retain a link to the original. Do not rely on OCR alone for exact code or commands; uncertain transcription must be flagged. Capture resolution and frame rate must be validated on real VS Code and terminal demonstrations.

**BR11 Must — Presenter assignment and timing.** Let the editor assign or reassign sections to three or four named presenters. Respect supplied assignments; otherwise show suggestions for confirmation. Generate handoff cues and estimated speaking, action, and waiting time. Keep rehearsal timestamps separate from the planned live schedule. Warn when the planned duration is exceeded without silently removing required steps.

<!-- pagebreak -->

## 7 Review and Word export requirements

**BR12 Must — Evidence review.** Selecting a script step or screenshot opens the relevant source interval. The editor can correct text, reorder sections, split or merge steps, exclude material, and replace images. Review flags explain their cause, such as missing audio, unreadable command, or conflicting takes; model self-confidence is not a verified accuracy score.

**BR13 Must — Safe revisions.** Save edits automatically and retain named script versions. Regenerating a section must preserve approved edits or present a reviewable replacement. Never silently overwrite the editor's work. Reopen a project without repeating completed processing unnecessarily.

**BR14 Must — Editable Word output.** Export a .docx file with native editable text, embedded screenshots, headings, a running order, presenter assignments, handoff cues, and captioned source timestamps. Screenshots must remain visible offline on another computer. Separate spoken lines from demonstration actions and producer notes. Code should remain legible and retain exact characters when verified.

**BR15 Must — Readiness status.** Allow draft exports with unresolved items clearly identified. A version may be marked Ready only after the lead resolves every blocking issue, acknowledges any remaining nonblocking caveats, confirms technical details and screenshots, and assigns required presenter sections. Save the approval with that version. Subsequent edits require renewed review of affected sections.

**BR16 Should — Presenter extracts.** Export each presenter's sections with surrounding handoffs. The full Word document remains the MVP deliverable. Word edits do not automatically synchronize back into the application in the first release; re-exporting must not overwrite a previously exported file without an explicit choice.

## 8 Required script content

The document begins with webinar context and a running order. Each section contains its objective, assigned presenter, estimated duration, spoken script, screen actions, observed result, screenshots, and handoff. Producer notes and unresolved questions are visually distinct from words intended for the audience.

Illustrative step structure, not content from an actual rehearsal:

- **Presenter:** Presenter B. **Planned duration:** 90 seconds.
- **Say:** Explain the purpose of the demonstrated command using the verified narration.
- **Do:** Open the demonstrated file in VS Code and run the verified command.
- **Show:** Embed the actual frame containing the relevant code and the actual result frame.
- **Evidence:** Link this step to its recording interval and both frame timestamps.
- **Handoff:** Introduce the next assigned presenter and section.

<!-- pagebreak -->

## 9 Accuracy and pilot acceptance

These are proposed targets, not measured performance or vendor guarantees. Evaluate on at least five representative rehearsals, including a 60-minute session, dense code, quick UI changes, corrections, technical names, pauses, and a failed demonstration followed by a retake. Include the team's actual accents and microphones.

Before scoring, the lead and one reviewer agree on the required steps, critical facts, correct takes, and useful screenshot moments. Score the untouched generated draft separately from the reviewed final script. Record median and worst-case results as well as each session's outcome; a small pilot does not establish production reliability.

| Measure | Proposed acceptance target |
| --- | --- |
| Preparation effort | At least 60% reduction in median hands-on preparation time against matched manual work, including corrections and export. |
| Required-step coverage | At least 95% of agreed required steps appear correctly in each generated draft; all critical steps are present or explicitly flagged as missing. |
| Screenshot alignment | At least 95% of selected draft images show the intended state for their associated step. Every final image is verified by the lead. |
| Technical accuracy | Every critical command, number, filename, and demonstrated outcome is checked before Ready. No unresolved critical factual error is accepted in the final script. |
| Source traceability | Every recorded action and screenshot has a valid source reference. Editorial additions and user-supplied content are explicitly distinguishable. |
| Draft latency | Target a reviewable draft within 10 minutes after a 30-minute rehearsal, excluding first-time setup. Record upload, queue, and processing time on agreed hardware and network. |
| Export integrity | All accepted test exports open in Microsoft Word, contain editable text and embedded images, and show no clipping or unreadable critical screenshots. |

Transcription word error rate and technical-term error counts are diagnostic measures, not substitutes for correct instructions and screenshots. Log unsupported assertions separately; an unsupported critical assertion prevents that pilot case from passing until the failure is addressed.

Capture testing must include microphone disconnection, storage exhaustion, interrupted processing, and application restart. A successful recovery preserves saved material, exposes gaps, and allows processing to resume without duplicate script sections. Timing drift should remain within one second at checkpoints through a 60-minute recording; image-to-step correctness remains a separate semantic check.

<!-- pagebreak -->

## 10 Operational and privacy requirements

**NFR01 Must — Usability and performance.** Recording must leave the demonstration usable without noticeable typing or cursor disruption on the agreed target machine. Benchmark CPU, memory, disk growth, and capture quality before selecting defaults. Show processing progress, cancel, retry, and actionable errors.

**NFR02 Must — Local source preservation.** Save recordings, transcripts, image references, project edits, and processing status durably. Recording must work offline after any required local setup. Cloud analysis may require connectivity, but a network failure must not discard the rehearsal.

**NFR03 Must — Controlled processing.** Explain what will be recorded and which provider receives any uploaded material. Upload only through the configured analysis workflow. Offer review and redaction before transmission and export. Apply exclusions consistently to images, transcripts, and any accompanying metadata. Automated secret detection is assistance, not a guarantee.

**NFR04 Must — Retention and deletion.** Provide project deletion covering local recordings and derived assets. Disclose any remote copies and provider retention behavior. User-exported Word copies are outside application deletion. Restrict credentials to secure storage and exclude them from logs. Cloud retention and permitted providers must be decided before the pilot uses sensitive material.

**NFR05 Must — Cost visibility.** Record processing usage and estimated cost per rehearsal, including retries. Support a configured spending limit; stop additional paid processing when it is reached and preserve completed work. Compare total processing expense and review time with manual preparation cost before wider rollout. No fixed cost claim is made in this BRD.

## 11 Scope excluded from the first release

Automatic recognition of multiple rehearsal speakers, remote participant audio capture, simultaneous recording across several computers, and automatic synchronization of separate recordings are deferred. The live script can still have multiple presenters because assignments are editorial decisions.

Direct LinkedIn broadcasting, meeting bots, automatic execution of demo commands, live teleprompting, video editing, voice cloning, and guaranteed autonomous publishing are outside the product's initial purpose. Google Docs synchronization, collaborative editing, translation, and existing-video import are candidates for later evaluation.

A model provider, implementation architecture, release date, and delivery budget are deliberately not selected by this business document. They follow technical validation and the pilot decision.

<!-- pagebreak -->

## 12 Existing foundation and feasibility

The local project is a copy of Skill Recorder. Its current purpose is to turn recorded work into reusable agent procedures. The following assessment comes from documentation and source inspection; the application has not been run or benchmarked for this BRD.

| Existing evidence | Implication for this product |
| --- | --- |
| Electron desktop capture and local sessions | A useful starting point for recording and storage; webinar reliability still needs validation. |
| Local narration transcription with session offsets | Reusable alignment foundation; domain vocabulary and long recordings need evaluation. |
| Frame extraction and source timestamps | Useful for selecting actual screenshots and navigating evidence. |
| Capture defaults of 1 fps and a maximum 1280 by 720 image | Fast UI actions and small editor text can be lost. Higher-quality capture must be evaluated against performance and storage. |
| Video capture is described as best effort | Missing video must become a visible blocking quality issue for screenshot-backed scripts. |
| Existing analysis generates intent and steps through Copilot | Webinar structure, presenter assignments, review, and Word export require a new product workflow. Provider suitability remains unvalidated. |
| Marker backend exists but its UI is removed | A nonblocking marker shortcut may reuse existing plumbing. |

Technical feasibility is supported by available components. Electron documents screen and window capture. Google documents video analysis that can refer to timestamps, while noting that its default one-frame-per-second processing can lose fast-action detail. These capabilities support a prototype; they do not establish the required accuracy on this team's demonstrations.

The proposed processing flow is capture, align narration and screen evidence, organize demonstration steps, select images, draft the script, review, and export. Capture quality and model sampling are separate decisions: recording more detail helps only if the analysis can inspect that detail when needed.

Begin with a short real rehearsal and compare the generated instructions and screenshots with the lead's expected script. Only then benchmark full sessions. Selection of speech and vision models should follow these results rather than a provider commitment made in advance.

<!-- pagebreak -->

## 13 Risks and delivery decisions

| Risk | Required response |
| --- | --- |
| Brief actions or small code are absent from usable frames | Validate capture quality; allow markers and alternate frames; flag evidence that cannot be recovered. |
| Narration says something different from the screen | Show the conflict to the editor rather than silently choosing a version. |
| Discussion or a failed take enters the live script | Preserve takes and exclusions, and require review of ambiguous selections. |
| Assignment suggestions misrepresent team responsibilities | Confirm every assignment before marking the script Ready. |
| Review takes as long as manual writing | Measure total hands-on time and improve the highest-cost corrections before expanding scope. |
| Cloud processing is too costly or restricted | Benchmark a permitted local or hybrid approach; retain source recordings for reprocessing. |

Delivery should proceed through three decision points. First, demonstrate evidence alignment and readable screenshots on a 5-to-10-minute real rehearsal. Second, complete the single-narrator workflow through reviewed Word export. Third, run the representative pilot and compare accuracy, preparation time, recording performance, and cost against the agreed targets. Expansion follows only if the core workflow proves useful.

Before implementation, the product owner should settle the proposed Windows and English scope, maximum recording duration, target hardware, permitted cloud processing, cost ceiling per rehearsal, and who accepts the pilot. If no existing script template is supplied, use the structure in section 8 for the prototype. Sample rehearsals and a manually approved comparison script are pilot inputs.

This BRD is ready for scope review. Approval of version 1.0 should record the agreed boundaries and any changed acceptance targets. Technical design and implementation planning are the next artifacts; this document does not authorize a release or claim the product is already implemented.

## 14 Evidence references

Local sources inspected on 25 October 2026:

- README.md — current product purpose, recording flow, local transcription, and cloud analysis behavior.
- electron/video/recorder.ts — capture defaults, dimensions, and best-effort video behavior.
- electron/narration/transcribe.ts — narration segments mapped to session time.
- electron/frames/extractor.ts — extraction and source frame sampling constraints.
- docs/future-features.md — retained marker backend and removed interface.

External technical documentation checked on 25 October 2026:

- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) — desktop capture capabilities.
- [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) — video analysis, timestamps, and sampling limitations.

These references establish available components and observed code behavior. Product accuracy, usability, cost, and performance remain subject to the pilot.
