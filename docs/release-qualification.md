# Release qualification

Version **0.8.0-rc.4**, Windows x64. Maintainers: nDimensions.AI and CharanTheAiGuy. The focused product scope and code-audit findings are recorded in [publication audit](publication-audit.md).

## Verified for this revision

| Check | Result |
| --- | --- |
| TypeScript and production build | Pass |
| Retained privacy, capture, persistence, workflow, provider, export and compliance regressions | 96 tests pass |
| Clean dependency installation | Pass with npm 11.17.0 strict lifecycle policy |
| Lockfile portability and lifecycle allowlist | Pass |
| npm dependency audit | Zero reported vulnerabilities |
| Third-party compliance preparation | 116 production package licenses and 49 source materials |
| Electron synthetic capture | Capture failure recovery, segment rotation, pause/resume, OCR mask suggestions, source playback, range requests and sandbox checks pass |
| Windows portable package | Native x64 payloads, full compliance and no retired code pass |
| Packaged local speech | Real q8 Whisper inference passes in Electron 43.8.3 |
| Packaged account setup | Encryption, dotted keys and replacement recovery pass |
| Delivered portable executable | Fresh-profile project creation and extracted payload hashes pass |
| Staged source credentials | Zero findings; offline scan includes Word design XML |
| AI account setup | One key field, dotted-key acceptance, encryption, failed replacement recovery and legacy settings migration pass with deterministic provider responses |

The publication workflow additionally verifies the rebuilt Windows package, packaged local inference and delivered portable payload. The source audit scans staged bytes and excludes API credentials, raw recordings, project databases, model caches, generated binaries and local artifacts from the public repository.

## Evidence limits

The capture smoke uses a synthetic screen and tone, short segment rotations, pause and resume. It does not establish 60-minute real-display drift or microphone quality. Local inference uses synthetic narration and proves model loading and inference, not accuracy across accents or technical terminology.

Earlier candidate qualification exercised a live Gemini 3.6 Flash screenshot/JSON fixture and extraction/composition/Word fixture. No real rehearsal was used. The cleanup revision uses deterministic provider tests; no further billable requests were made for this publication. Account access is checked during setup; model suitability remains a developer responsibility.

Word tests verify ZIP integrity, embedded images, source references, approval invalidation and exact reviewed image hashes. The earlier candidate also underwent visual inspection of a synthetic reference export in Word. The current export format is unchanged.

## Required before a stable release

1. Run at least five real rehearsals and annotate human reference scripts. Measure script coverage, screenshot alignment, technical correctness, presenter handoffs and preparation-time savings.
2. Include a 60-minute real display/microphone session and check synchronization, device changes, sleep/lock interruption and low disk space.
3. Validate live generation and accounting against provider billing for supported accounts. Confirm current model availability and published pricing before release.
4. Exercise the entire review/export workflow with the actual presenter team and inspect resulting Word layouts.
5. Configure code signing and a release/update policy before claiming signed, automatically updated production distribution.

The application remains a release candidate. Windows x64 is the tested target; other configured platforms require separate qualification. Generated installers and local test evidence are excluded from Git. Preserve the complete compliance materials with every distributed executable.
