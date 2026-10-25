import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.WEBINAR_PLAYWRIGHT ?? 'playwright');
const root = process.cwd(), userData = mkdtempSync(path.join(tmpdir(), 'webinar-provider-'));
const env = { ...process.env, WEBINAR_DATA_DIR: userData }; delete env.ELECTRON_RUN_AS_NODE;
const packaged = !!process.env.WEBINAR_EXE;
const app = await electron.launch({ executablePath: process.env.WEBINAR_EXE ?? path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [root], env, timeout: 60000 });
try {
  // Replace only this test process's main-world network boundary. There is no app
  // flag or packaged test backdoor, and no real key or user evidence is involved.
  await app.evaluate(() => {
    globalThis.__providerTest = { fail: false, requests: [] };
    globalThis.fetch = async (url, options) => {
      const state = globalThis.__providerTest, endpoint = String(url);
      if (!endpoint.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash')) throw new Error('Unexpected network destination');
      const body = options?.body ? JSON.parse(options.body) : null;
      state.requests.push({ endpoint, body });
      if (state.fail) return new Response('untrusted server error containing credentials', { status: 403 });
      if (!body) return new Response(JSON.stringify({ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }));
      if (endpoint.endsWith(':countTokens')) return new Response('{"totalTokens":1400}');
      return new Response(JSON.stringify({ modelVersion: 'gemini-3.6-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ originalValue: 41, correctedValue: 42, firstAttempt: 'failed', secondAttempt: 'succeeded', screenshotSourceId: 'sample-screen', transcriptSourceId: 'sample-transcript' }) }] } }] }));
    };
  });
  const page = await app.waitForEvent('window', { predicate: page => page.url().includes('#webinar'), timeout: 30000 }).catch(() => app.windows().find(page => page.url().includes('#webinar')));
  assert(page); await page.waitForSelector('.webinar-app');
  await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your AI account' });
  await dialog.waitFor();
  assert.equal(await dialog.locator('input').count(), 1);
  assert.equal(await dialog.locator('input[type=password]').count(), 1);
  assert(await dialog.getByText('Gemini 3.6 Flash', { exact: true }).isVisible());
  assert(!/qualified model ID|rate card|million.*tokens/i.test(await dialog.innerText()));
  await page.screenshot({ path: 'artifacts/provider-setup.png', fullPage: true });
  await dialog.screenshot({path:'artifacts/provider-setup-dialog.png'});

  await dialog.getByLabel('Google AI Studio API key').fill(('AQ.' + 'DummyConnectionFixture_1234567890.with-period'));
  await dialog.getByRole('button', { name: 'Connect and test', exact: true }).click();
  await page.getByRole('button', { name: 'Gemini connected ✓', exact: true }).waitFor();
  const recordFile = path.join(userData, 'webinar/provider.json');
  assert(existsSync(recordFile)); const saved = readFileSync(recordFile, 'utf8'), record = JSON.parse(saved);
  assert.equal(record.schemaVersion, 2); assert.equal(record.settings, undefined);
  assert.equal(record.verification.modelId, 'gemini-3.6-flash'); assert(!saved.includes('fixture-provider-key'));
  const status = await page.evaluate(() => window.webinar.invoke('provider.status', {}));
  assert.equal(status.value.configured, true); assert.equal(status.value.settings, undefined);

  // A rejected replacement key must leave the working encrypted connection intact.
  await app.evaluate(() => { globalThis.__providerTest.fail = true; });
  await page.getByRole('button', { name: 'Gemini connected ✓', exact: true }).click();
  await dialog.getByLabel('Google AI Studio API key').fill('fixture-replacement-key-12345');
  await dialog.getByRole('button', { name: 'Connect and test', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'permissions' }).waitFor();
  assert.equal(readFileSync(recordFile, 'utf8'), saved);
  assert(!(await dialog.getByRole('alert').innerText()).includes('untrusted'));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  // An old hand-entered profile keeps its key but must use the product-owned model.
  delete record.verification; record.settings = { modelId: 'old-user-entered-model', inputMicrousdPerMillion: 0 };
  writeFileSync(recordFile, JSON.stringify(record));
  await app.evaluate(() => { globalThis.__providerTest.fail = false; });
  await page.getByRole('button', { name: 'Gemini connected ✓', exact: true }).click();
  await dialog.getByText('Your saved API key will be kept.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Connect and test', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const migrated = JSON.parse(readFileSync(recordFile, 'utf8'));
  assert.equal(migrated.verification.modelId, 'gemini-3.6-flash'); assert.equal(migrated.settings, undefined);
  const requests = await app.evaluate(() => globalThis.__providerTest.requests);
  assert.equal(requests.filter(r => r.endpoint.endsWith(':generateContent')).length, 0);
  assert(requests.every(r => !r.endpoint.includes('old-user-entered-model')));
  await page.screenshot({ path: 'artifacts/provider-connected.png', fullPage: true });
  writeFileSync('artifacts/provider-smoke.json', JSON.stringify({ passed: true, packaged, modelId: 'gemini-3.6-flash', inputCount: 1, authKeyPunctuationSupported: true, noBillableGenerationDuringSetup: true, credentialEncryption: true, failureKeepsExistingKey: true, legacyKeyMigrated: true, syntheticProviderCalls: requests.length, network: 'deterministic fixture; no live credentials' }, null, 2));
  console.log('AI connection UI passed: one key field, managed model, encrypted storage, failure recovery and legacy migration.');
} finally { await app.close(); }
