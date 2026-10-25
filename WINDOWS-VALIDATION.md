# Windows x64 validation

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run check:lockfile` and `npm audit` after installation. Use npm 11.17.0 or newer for the lifecycle-policy check.

For a built application, set `WEBINAR_PLAYWRIGHT` to a separately installed Playwright package directory. `node scripts/webinar-smoke.mjs` checks a synthetic screen and audio tone, segment rotation, pause/resume, screenshot extraction, OCR masks, source playback, range requests, sandbox settings and forbidden IPC. `node scripts/webinar-provider-smoke.mjs` checks the key-only UI, dotted-key acceptance, encrypted storage and failed-key replacement using mocked provider responses.

Build with `npm run dist:portable:win`, then run `node scripts/verify-windows-package.mjs x64`. The architecture verifier checks the actual Electron, codec, Sharp and ONNX binaries as well as bundled notices. Set `WEBINAR_EXE` to `release/win-unpacked/nDimensions.AI Script Recorder.exe` for the packaged provider and speech checks.

The speech smoke requires a local `artifacts/asr-reference.wav` and downloaded checksum-verified model cache. The portable executable check is `./scripts/verify-webinar-portable.ps1`; it launches a fresh profile, checks project persistence and compares the extracted application payload to the verified unpacked build. Temporary data and all recordings remain excluded from Git.

Before a stable release, also check a real display and microphone, screen permissions, device changes, low disk space, shutdown during capture, sleep/lock interruption, a 60-minute rehearsal and source-to-screenshot alignment. Measure script coverage and editing time against human reference scripts. Synthetic tests do not establish those business outcomes.
