// Read credentials only from stdin. Never place real keys in arguments or files.
import { verifyProviderConnection } from '../electron/webinar/provider.ts';
let key = '';
try {
  for await (const chunk of process.stdin) {
    key += chunk.toString();
    if (key.length > 1100) throw new Error('Credential input exceeded its size limit.');
  }
  const result = await verifyProviderConnection(key.trim(), undefined, {checkEvidence: process.argv.includes('--evidence')});
  process.stdout.write(JSON.stringify({ passed: true, live: true, ...result }) + '\n');
} catch (error) {
  // Do not emit stacks, provider bodies, or raw input, even on validation errors.
  const safeMessage = error?.name === 'ZodError' ? 'Credential input was not valid.' : String(error?.message ?? 'Connection check failed.').replaceAll(key, '[REDACTED]');
  process.stdout.write(JSON.stringify({ passed: false, live: true, code: error?.code ?? 'VALIDATION', message: safeMessage }) + '\n');
  process.exitCode = 1;
} finally { key = ''; }
