# Release packaging

The qualified target is Windows x64. Other platform configuration is retained as development groundwork and is not a claim of a tested release.

## Verify the source

Use Node 24.19.0 through 24.x and npm 11.17.0 or newer. Start from a clean, reviewed checkout:

```sh
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run check:lockfile
npm run electron:install-reviewed
npm run typecheck
npm test
npm audit
npm run build
```

Before publishing source, stage only intended project files and run `node scripts/publication-audit.mjs`. It scans the staged bytes, blocks credentials, runtime data, large files and retired dependencies, and requires all project license notices. Never add recordings, API keys, databases, model caches or generated installers to Git.

## Build Windows x64

```sh
npm run dist:portable:win
node scripts/verify-windows-package.mjs x64
```

For an NSIS installer use `npm run dist:win:x64` instead. Supported distribution commands generate the full compliance bundle before Electron Builder runs. The afterPack verifier checks it again, verifies the exact Electron notices, excludes unused Sharp WebAssembly payloads and rejects nested build outputs. Do not bypass the compliance step with direct Electron Builder invocation.

`third_party/compliance-policy.json` pins reviewed Electron archives, notices, native source revisions and hashes. `npm run compliance:review` obtains candidate review materials; review upstream provenance before accepting any new hashes. `npm run compliance:prepare` creates the complete license inventory, corresponding-source materials, source manifest and relinking instructions. `compliance:licenses` is only a developer shortcut and cannot pass release verification by itself.

## Runtime checks

Install Playwright in a separate developer tooling directory and point `WEBINAR_PLAYWRIGHT` to its package directory. Do not add browser automation dependencies to the desktop runtime.

```sh
node scripts/webinar-smoke.mjs
node scripts/webinar-provider-smoke.mjs
```

The first checks synthetic capture, pause/resume, OCR, playback and privacy boundaries. The second uses mocked Google responses and dummy keys to check account setup and encrypted storage. Neither needs a real API key. Set `WEBINAR_EXE` to an unpacked executable to run provider checks against a package.

The ASR and packaged speech checks also require `artifacts/asr-reference.wav` (16 kHz mono PCM16) and the approved speech-model cache at `artifacts/model-cache`. They are local developer fixtures, excluded from Git. Run `scripts/webinar-package-smoke.mjs` with `WEBINAR_EXE` set to the unpacked executable. See [Windows validation](WINDOWS-VALIDATION.md) for portable checks.

Live provider qualification tools read credentials from stdin and may incur provider charges. Use only synthetic public evidence. Never put a real key in source, command arguments, logs or issue attachments.

## Ship

Inspect packaged files, record SHA-256 checksums, and retain the complete `resources/compliance` bundle in every artifact. Preserve `LICENSE`, `third_party/licenses/microsoft-skill-recorder.txt`, `third_party/licenses/openai-whisper.txt` and `THIRD-PARTY-NOTICES.md`. The application is unsigned; code signing and automatic updates require separate setup. Source publication does not establish real rehearsal accuracy. Keep the release-candidate label until the remaining gates in [release qualification](docs/release-qualification.md) have passed.
