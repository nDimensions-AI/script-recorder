// Resolve extensionless TypeScript imports for headless Node tests.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true };
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL && !path.extname(specifier)) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
