import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Ship the CommonJS preloads + hidden capture page verbatim (they run in the
 *  renderer's isolated world and must not go through the ESM main pipeline). */
function copyStaticAssets(): void {
  const out = path.join(rootDir, "dist-electron");
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(out, "webinar", "migrations"), { recursive: true });
  for (const file of [
    "preload.cjs",
    "capture-preload.cjs",
    "decoder-preload.cjs",
    "capture.html",
  ]) {
    copyFileSync(
      path.join(rootDir, "electron", "webinar", file),
      path.join(out, "webinar", file),
    );
  }
  for (const file of ["project.sql", "catalog.sql"]) {
    copyFileSync(
      path.join(rootDir, "electron", "webinar", "migrations", file),
      path.join(out, "webinar", "migrations", file),
    );
  }
  const icons = path.join(out, "assets", "icons");
  mkdirSync(icons, { recursive: true });
  const iconSrc = path.join(rootDir, "electron", "assets", "icons");
  for (const file of readdirSync(iconSrc)) {
    copyFileSync(path.join(iconSrc, file), path.join(icons, file));
  }
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: [
          "electron/main.ts",
          "electron/webinar/worker.ts",
          "electron/webinar/compute-worker.ts",
        ],
        onstart(args) {
          copyStaticAssets();
          // A parent Electron host (e.g. the launcher) can leak ELECTRON_RUN_AS_NODE,
          // which would start our process as a bare Node runtime instead of a GUI app.
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          void args.startup(["."], { env });
        },
        vite: {
          build: {
            outDir: "dist-electron",
            emptyOutDir: true,
            rolldownOptions: {
              output: {
                entryFileNames: (chunk) =>
                  chunk.name === "worker"
                    ? "webinar-worker.js"
                    : chunk.name === "compute-worker"
                      ? "webinar-compute.js"
                      : "[name].js",
              },
              // Keep native and large runtime dependencies outside the main bundle.
              external: [
                "electron",
                "sharp",
                "@huggingface/transformers",
                "onnxruntime-node",
                "tesseract.js",
                "docx",
              ],
            },
          },
          plugins: [
            {
              name: "copy-preload",
              closeBundle() {
                copyStaticAssets();
              },
            },
          ],
        },
      },
    ]),
  ],
});
