import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Ocr, modelsCacheDir } from "../sensitive/ocr";
import { tessdataUrl, verifyTessdata } from "../sensitive/tessdata-source";
import { atomicFile, assert } from "./core";

// OCR is local assistance only. Its output never grants permission to upload.
export async function inspectText(filename: string) {
  const directory = modelsCacheDir(),
    file = path.join(directory, "eng.traineddata");
  if (!existsSync(file)) {
    const response = await fetch(tessdataUrl("eng"), {
      signal: AbortSignal.timeout(60000),
    });
    assert(
      response.ok && response.body,
      "MODEL_MISSING",
      "OCR model download failed.",
    );
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body as any) {
      length += chunk.length;
      assert(
        length <= 8 * 1024 * 1024,
        "MODEL_MISSING",
        "OCR model exceeds its size limit.",
      );
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyTessdata("eng", bytes);
    atomicFile(file, bytes);
  }
  verifyTessdata("eng", readFileSync(file));
  const ocr = new Ocr({ langPath: directory, poolSize: 1 });
  try {
    return await ocr.recognize(filename);
  } finally {
    await ocr.terminate();
  }
}
