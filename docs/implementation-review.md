> Historical design/review baseline. The [focused product amendment](publication-audit.md) supersedes references to the removed Copilot, terminal and builder features.

# Webinar implementation and critique log

Owner: nDimensions.AI and CharanTheAiGuy. Baseline: approved HLD and LLD 0.1.
Release: 0.8.0-rc.3, Windows x64, 25 October 2026.

The rehearsal-to-Word workflow is implemented and locally qualified as a release
candidate. Production qualification remains open for live-provider evaluation,
long-duration capture and five labeled team rehearsals. This log records the
critique applied after each implementation increment and the corrections made.

| Increment | Implemented behavior | Critique and correction | Evidence |
| --- | --- | --- | --- |
| 0 Platform | Sandboxed Electron UI/capture/decoder, utility workers, SQLite, pinned speech model | Legacy renderer privileges and whole-recording decoding were unsuitable. Added isolated preloads and bounded segments. Updated vulnerable dependencies and reviewed native materials. | Electron 43.8.3 smoke, SQLite 3.53.4, packaged Whisper inference, audit with zero findings |
| 1 Durable domain | Project/catalog storage, immutable assets/revisions, CAS receipts, leases, backup/restore, deletion ledger | Token-only leases allowed late results; deletion cancelled unrelated jobs; restore reused approval state. Added monotonic expiry, project-scoped cancellation and fresh restore namespaces with revoked approvals. | Real SQLite tests, stale lease and asset hash rejection, backup/restore workflow |
| 2 Capture and evidence | Separate screen/audio segments, measured overlap, pause/resume, clocks, native stills, local playback, ASR, crops/masks, OCR assistance | Playback needed HTTP range responses and CORS. Final recorder blobs could race sealing. Crash recovery needed sidecars. Pause retained device streams. Corrected each issue and reacquire the original devices on resume. | Synthetic real Electron recording/rotation/pause/resume, frame extraction, OCR email-mask detection, three capture fault tests |
| 3 Cloud drafting | Exact reviewed manifests, fixed provider endpoint, token preflight, reservations, extraction/composition, packet caches and proposals | Descendant summaries lacked approval lineage; responses lacked read bounds; oversized packets needed subdivision; neighboring context could duplicate steps. Added lineage/revocation, bounded responses, source-boundary splitting and owning-core checks. | Fixture provider tests, no audio/video in serialized payload, revoked manifest sends zero requests, uncertain charges remain reserved |
| 4 Review and Word | Suggested presenter turns, explicit confirmation, source links, technical review, retake selection, revision comparison, timing, Draft/Ready Word | SQLite row prototypes broke dependency hashing; export recovery lacked a pre-publication destination record; appendix references repeated. Normalize rows, persist hash-bound destination intent and deduplicate references. | Exact embedded-image validation, approval gating, export interruption recovery, native Word PDF visual inspection |
| 5 Packaging | Reviewed dependency closure, corresponding sources, retained MIT notices, Windows portable build | Audit initially contained 16 findings. Updated dependencies, reviewed distribution/source hashes and kept release verification enabled. Packaged inference must work independently of the source checkout. | 267 existing tests and 34 webinar tests; packaged app SQLite creation and actual local Whisper inference |

## Additional critique fixes

- Read-only RPCs no longer broadcast changes recursively.
- Transcript edits invalidate evidence approvals and require renewed technical verification.
- Source references must resolve to the same project's actual recording interval.
- API responses are bounded before JSON parsing; ambiguous outcomes keep their cost reservation.
- Scene novelty and stability use different adjacent-frame comparisons; suggestions appear in the image grid.
- Unsaved editor recovery copies survive restart; explicitly discarded edits are removed.
- OCR output only suggests masks. The user reviews the final derivative before approving uploads.
- Billing reconciliation remains available after project deletion and requires a recorded reason.
- Local processing is limited to one heavy job; recording waits for it to finish or be cancelled.
- Source recordings, transcript originals and accepted revisions are never replaced by regeneration.

## LLD implementation choices and qualification boundaries

The implementation consolidates the proposed backend modules under
`electron/webinar` rather than creating seven top-level directories. Capture uses
an authenticated MessagePort, 1 MiB fragments, per-track credit limits and writer
acknowledgments. Bounded copying passed runtime qualification; transferring an
ArrayBuffer did not preserve the request envelope in the tested runtime, so that
optimization remains disabled. No zero-copy claim is made.

The editor carries nonconflicting fields through a three-way merge and retains
current values for overlapping edits. Step, section and block identities remain
stable across regeneration of the same demonstrated action. The user resolves
remaining content and ordering conflicts explicitly.

Evidence and transcript readers are paged. Short transcript passages are grouped
into 90-second sections for manual drafts. Unchanged approved packet contents can
reuse validated local outputs after reapproval; changed packets get new keys.
Interrupted local jobs resume on restart, while remote composition packets with
uncertain outcomes wait for review. Initial migration failure rolls back; schema
checksums are verified and unsupported newer versions are rejected.

AI-requested evidence expansion retrieves at most two local candidates per packet.
New candidates do not enter outbound requests until the user selects, redacts and
approves them. Unresolved coverage remains a blocking review item. Cross-window
deduplication is conservative and reference-based; semantic reconciliation of
differently worded takes still requires human review.

Legacy imports preserve existing narration and original files. Long legacy audio
without a transcript is playable but is not accepted by the bounded ASR decoder;
record a new segmented rehearsal for that path. Future version-to-version migration
and installer upgrade drills require an actual successor schema/package. Only the
current initial schema, failure rollback, backup and fresh-namespace restore have
been exercised.

The full LLD acceptance remains open for exact provider/model qualification,
long-duration hardware tests and five labeled real rehearsals. No production
accuracy or productivity claim is made without those measurements. See
`release-qualification.md` for the evidence and outstanding pilot criteria.

## AI setup critique and correction

The first setup form wrongly asked users to supply a qualified model ID, a rate
card and token prices. Those are product engineering responsibilities. Release
0.8.0-rc.2 selects Gemini 3.8 Flash internally and exposes one API-key field with
**Connect and test**. The account check exercises model access, token counting,
vision, JSON and source attribution before saving encrypted credentials.

The critique also caught a false-positive test design: fixed numeric answers in
the text prompt or JSON schema would let a model pass without reading the image.
The answers now exist only in the synthetic screenshot; the response is checked
against a private test reference. Failed reconnection preserves the previous key,
and old manual profiles migrate without retaining their model/rate choices.

Model choice and settings are documented in `ai-model-decision.md`. Local tests
use fixture provider responses; live access checks run when an account connects.

## Auth key and live provider critique

Release 0.8.0-rc.3 fixes an incorrect character whitelist that rejected Google's
new dotted auth-key format before a network call. Keys are opaque printable
credentials; punctuation is accepted while embedded whitespace/control characters
remain invalid. A regression test covers the new format and the legacy format.

The supplied key was accepted by Google's model and token-count endpoints. Live
3.8 generation timed out, while 3.6 Flash passed the same visual evidence check.
The selected model is now Gemini 3.6 Flash, qualified with a live screenshot test
and a complete source-linked drafting/Word fixture. No credential is stored in
source or test artifacts.

Live drafting exposed another compatibility defect: large nested schema bounds
made Google's constrained decoder reject the request. The provider receives the
structural JSON shape; unchanged strict local Zod validation enforces all sizes,
reference membership and timing bounds. The live fixture then completed both
extraction and composition successfully.

Account connection now checks model access quickly without a billable generation
request. Vision/JSON qualification belongs to developer testing. Timeouts have a
separate error code. Temporary speech-polishing failures retain validated extracted
narration as an editable draft, add a blocking speech-review flag, and keep any
uncertain charge reservation. No uncertain request is replayed automatically.
