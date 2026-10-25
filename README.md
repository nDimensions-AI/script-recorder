# nDimensions.AI Script Recorder

Turn one narrated rehearsal into an editable webinar script for a team of presenters, with screenshots from the actual demonstration.

Maintained by **nDimensions.AI and CharanTheAiGuy**. Version **0.8.0-rc.4** targets **Windows x64**. This is a release candidate: real rehearsal accuracy and preparation-time savings still need measurement.

## How it works

1. Create a webinar, describe the audience and objective, and add your presenters.
2. Select a display and microphone. Rehearse with pause, resume and moment markers.
3. Transcribe on your computer using a checksum-verified Whisper model downloaded on first use.
4. Review the narration and source playback. Select screenshots, crop details and mask sensitive areas. Local OCR can suggest masks.
5. Connect your Google AI Studio account with one API key. The app selects **Gemini 3.6 Flash** and manages settings and price estimates. Review the exact text and screenshot copies before approving an upload.
6. Review the draft, confirm presenter assignments and handoffs, resolve retakes, and save revisions. Manual drafting also works without AI.
7. Export an editable Word document with embedded screenshots. Draft exports show review issues; Ready exports require approval of the current revision.

Recordings and transcription remain local. Only approved text and screenshot derivatives are eligible for cloud requests. Automatic redaction can miss sensitive details: review the upload preview. Windows encrypts saved API keys. The app records request costs and retains uncertain reservations until reconciled against provider billing.

Use **Back up project** and **Restore backup** for project copies. Restore creates a new project and revokes earlier approvals. Legacy Skill Recorder session import remains available. The old recording UI, Copilot builders, terminal and automation builder have been removed.

## Develop

Install Node.js **24.19.0 through 24.x** and npm **11.17.0 or newer**, then:

```sh
git clone https://github.com/nDimensions-AI/script-recorder.git
cd script-recorder
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run electron:install-reviewed
npm run compliance:licenses
npm run dev
```

The internal package name stays `skill-recorder` to preserve existing Electron user-data locations. It is not an integration with Copilot.

```sh
npm run check:lockfile
npm run typecheck
npm test
npm run build
npm audit
```

See [installation](INSTALL.md), [release packaging](RELEASING.md), [Windows validation](WINDOWS-VALIDATION.md), and [release qualification](docs/release-qualification.md). CI checks the source on Windows x64; packaging runs through a separate manual workflow. No signing or automatic update channel is configured.

## Design and audit

The [BRD](docs/business-requirements.md), [HLD](docs/high-level-design.md) and [LLD](docs/low-level-design.md) describe the original design. The [focused product amendment and publication audit](docs/publication-audit.md) records the current scope and supersedes references to retired features. [Implementation critique](docs/implementation-review.md) records earlier decisions and qualification limits.

## License and support

Original contributions: Copyright (c) 2026 **nDimensions.AI and CharanTheAiGuy**, [MIT](LICENSE).

Derived from [Microsoft Skill Recorder](https://github.com/microsoft/skill-recorder). Reused upstream code retains its Microsoft MIT notice in [LICENSE-UPSTREAM](LICENSE-UPSTREAM). Preserve [model licensing](LICENSE-MODEL) and [third-party notices](THIRD-PARTY-NOTICES.md) with distributions. The upstream project does not sponsor or support this fork.

Report ordinary bugs in [this repository's issues](https://github.com/nDimensions-AI/script-recorder/issues). See [security reporting](SECURITY.md), [contributing](CONTRIBUTING.md), and the [code of conduct](CODE_OF_CONDUCT.md).
