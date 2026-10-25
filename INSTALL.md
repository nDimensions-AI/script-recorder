# Installation

The supported release candidate is Windows x64. Source: [nDimensions-AI/script-recorder](https://github.com/nDimensions-AI/script-recorder).

## Run from source

Install Git, Node.js 24.19.0 or newer within 24.x, and npm 11.17.0 or newer. If needed, update npm with `npm install --global npm@11.17.0`.

```sh
git clone https://github.com/nDimensions-AI/script-recorder.git
cd script-recorder
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run check:lockfile
npm run electron:install-reviewed
npm run compliance:licenses
npm run dev
```

The reviewed Electron installer checks the pinned archive hash. The launcher checks the installed runtime before starting it. Do not use a downloaded runtime from an unknown mirror or bypass these checks.

To run a production source build:

```sh
npm run build
npm start
```

Local speech transcription downloads approximately 252 MB of pinned model files after you approve the download. OCR downloads its pinned English language data on first use. These models are not embedded in the application installer.

For cloud drafting, open **Connect AI** and paste a Google AI Studio API key. The application manages the model and estimates. Review selected evidence before uploading it. Manual scripts do not need a cloud account.

## Local project data

The internal package identifier stays `skill-recorder` for compatibility. Projects are stored below Electron's user-data directory in `webinar/`; the application does not upload the project database or raw recordings. Use the app's backup and restore actions rather than copying a live SQLite database.

## Package

Follow [RELEASING.md](RELEASING.md). A redistributable build must contain the generated complete compliance bundle. Development `compliance:licenses` output alone is insufficient for distribution.
