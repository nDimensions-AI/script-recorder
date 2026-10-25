// Only app paths are needed by the local OCR module in headless tests.
import os from 'node:os';
import path from 'node:path';
export const app = { getPath: name => path.join(os.tmpdir(), 'webinar-recorder-test', name) };
