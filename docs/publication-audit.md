# Focused product amendment and publication audit

Version: 0.8.0-rc.4. Review date: 2026-10-25. Owners: nDimensions.AI and CharanTheAiGuy.

## Approved scope

This release turns a single narrator's rehearsal into a webinar script divided among presenters, with reviewed source screenshots and editable Word export. The public repository is nDimensions-AI/script-recorder under MIT. The existing package identifier and data location remain stable for local upgrade compatibility.

This amendment supersedes legacy-feature retention statements in the original BRD/HLD/LLD and historical review documents. Legacy session **import** remains; the old recorder UI, Copilot analysis, skill builder, automation builder, embedded terminal, foreground-window tracking and broad legacy IPC have been removed. Persisted schema values used by older backups are retained for compatibility; they do not expose a terminal feature.

## Audit coverage and changes

Reviewed all retained application modules, their import graph, renderer routes, preload/IPC boundaries, filesystem access, network requests, credential storage, request accounting, source references, Word generation, dependency closure, packaging scripts, workflows, documentation and license notices.

- Removed 201 baseline files: obsolete application code/tests, retired installers and investigation helpers, old UI screenshots and outdated documentation. A source-only recovery copy remains outside source control.
- Removed seven direct runtime dependencies plus optional get-windows and one obsolete type package. The lockfile dropped from 621 to 465 resolved package entries across all platforms; the Windows install now contains 388 packages. The production compliance inventory now contains 116 packages.
- Replaced startup, tray and renderer routing with the webinar workspace. The former legacy preload is not copied or exposed.
- Fixed privacy scanner load/execution failures to block evidence preparation; added dotted Google key detection and regressions. Detection remains assistance: users must inspect the actual outgoing evidence.
- Fixed capture initialization failures to clear listeners, mark the attempt incomplete and release capture state so another recording can start.
- Bounded streamed speech-model ranges before writing, preserving pinned hashes and explicit download consent.
- Made production builds clear previous outputs; packaged verification rejects retired code/dependencies and requires original, upstream and model notices.
- Added a staged-source publication check that rejects credential patterns, private recordings/databases, caches, oversized files and retired dependencies without printing secret values.
- Replaced legacy CI and source installers with documented checkout setup, Windows source checks and a manual packaging workflow.

## Critique and limitations

The code now has one product workflow and narrower privileged entry points. Provider credentials remain opaque strings, so dotted Google keys are accepted. The app owns model and pricing selection; users supply only an account key. Only an approved manifest can enter cloud drafting. Unknown provider outcomes retain budget reservations rather than being replayed silently.

The release is still a candidate. Local OCR and speech transcription may miss or misread code. Synthetic fixtures and structural tests do not establish script accuracy across real webinars, 60-minute synchronization or preparation-time savings. Windows x64 is the tested target. The app is unsigned; signing, automatic updates and other platform qualification remain separate work. The full release qualification document records checks and remaining gates.

Third-party compliance remains enforced. Microsoft MIT attribution and downloaded model notices have not been removed or reassigned. The generated release bundle retains 49 corresponding-source materials and complete runtime notices.

## Final verification

96 retained tests passed. TypeScript, production build, strict install/lockfile policy, zero-vulnerability npm audit and full compliance preparation passed. The rebuilt Windows package passed native architecture and retired-code checks, actual local Whisper inference, encrypted provider setup and portable payload integrity checks. The portable executable is 572,113,115 bytes, compared with 721,498,923 bytes for rc.3; binaries remain outside source control.

The staged source scan found no credentials or retired dependencies. An independent offline secretlint pass scanned 166 source/document parts, including XML inside the Word design documents, with zero findings. Dummy credential fixtures are constructed explicitly in tests rather than stored as full key-shaped literals.
