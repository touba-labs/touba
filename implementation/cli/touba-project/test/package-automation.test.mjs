import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationIdentity, automationRequestId, requestPackagePublication } from '../src/package-automation.mjs';
import { submitPackageDraft } from '../src/package-drafts.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { newPackage } from '../src/package-author.mjs';
import { packageDigest } from '../src/package-contract.mjs';

const origin = 'https://automation.example.invalid', registry = origin + '/registry';
const key = 'tba_' + 'a'.repeat(32) + '_' + 'b'.repeat(43);
const id = '11111111-1111-4111-8111-111111111111';
function environment(t) {
  const previous = [process.env.TOUBA_CLOUD_ORIGIN, process.env.TOUBA_CLOUD_API_KEY];
  process.env.TOUBA_CLOUD_ORIGIN = origin; process.env.TOUBA_CLOUD_API_KEY = key;
  t.after(() => { for (const [i, name] of ['TOUBA_CLOUD_ORIGIN', 'TOUBA_CLOUD_API_KEY'].entries()) {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  } });
}

test('automation requires explicit trusted origin, never an author link or a key argument', async t => {
  environment(t);
  assert.equal(automationIdentity(registry, { registry }).api, origin + '/api/v1/automation');
  assert.throws(() => automationIdentity(registry), { code: 'PackageAutomationTargetRequired' });
  assert.throws(() => automationIdentity('https://attacker.invalid/registry', { registry }), { code: 'PackageAutomationTargetMismatch' });
  assert.throws(() => automationIdentity(origin + '/other', { registry }), { code: 'PackageAutomationTargetMismatch' });
  assert.throws(() => automationRequestId('short'), { code: 'PackageAutomationRequestRequired' });
  for (const args of [['publish', '--automation'], ['submit', '--api-key', key], ['submit', '--automation', '--ci', id], ['submit', '--request-id', 'abc00000000000000']]) {
    await assert.rejects(packageCommand(args), { code: 'PackageOptionInvalid' });
  }
});

test('submission reuses packing, secret stays out of persistent links and results', async t => {
  environment(t);
  const root = mkdtempSync(join(tmpdir(), 'touba-automation-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const author = newPackage('acme.example', { root, license: 'MIT', publisher: 'Acme' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, origin + '/api/v1/automation/drafts');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    assert.equal(options.headers['Idempotency-Key'], 'automation-test-0001');
    assert.equal(options.headers['X-Touba-Package'], 'acme.example');
    return new Response(JSON.stringify({ id, status: 'ready', name: 'acme.example', version: '0.1.0', revision: 1, archive_digest: packageDigest(options.body) }), { status: 201 });
  });
  const result = await submitPackageDraft(author.path, { automation: true, registry, 'request-id': 'automation-test-0001' });
  assert.equal(result.status, 'success'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!readFileSync(join(author.path, '.touba/package-draft.json'), 'utf8').includes(key));
});

test('review request does not invoke a publish endpoint or accept a redirect', async t => {
  environment(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, origin + `/api/v1/automation/drafts/${id}/publication-request`);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { revision: 2 });
    return new Response(JSON.stringify({ status: 'awaiting_human_review' }));
  });
  const result = await requestPackagePublication(id, { automation: true, registry, revision: '2', 'request-id': 'publication-test-001' });
  assert.equal(result.status, 'success');
  assert.ok(!JSON.stringify(result).includes(key));
});
