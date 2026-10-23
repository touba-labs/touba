import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageCommand } from '../src/package-command.mjs';
import { submitCiPackage } from '../src/package-ci.mjs';
import { newPackage } from '../src/package-author.mjs';
import { packageDigest } from '../src/package-contract.mjs';

const id = 'a1234567-1234-1234-1234-123456789abc';
const registry = 'https://registry.example/registry';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function environment(t, values = {}) {
  const keys = ['GITHUB_ACTIONS', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-fixture', ...values });
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
}
async function author(t) {
  const root = mkdtempSync(join(tmpdir(), 'touba-ci-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (await newPackage('acme.example', { root, version: '1.0.0', publisher: 'Example', license: 'Apache-2.0' })).path;
}

test('CI submission binds audience, uploads exact canonical archive and never saves identity', async t => {
  environment(t); const path = await author(t); const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (new URL(url).hostname === 'pipelines.actions.githubusercontent.com') {
      assert.equal(new URL(url).searchParams.get('audience'), `${registry}/ci/drafts/${id}`);
      assert.equal(options.headers.Authorization, 'Bearer private-request-fixture');
      return json({ value: 'private-job-fixture' });
    }
    assert.equal(url, `${registry}/ci/drafts/${id}`);
    assert.equal(options.headers.Authorization, 'Bearer private-job-fixture');
    return json({ id, status: 'draft', name: 'acme.example', version: '1.0.0', archive_digest: packageDigest(options.body), preview: 'https://untrusted.invalid' });
  });
  const result = await submitCiPackage(path, { registry, ci: id });
  assert.equal(result.preview, `https://registry.example/cloud/library?draft=${id}`);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.ok(!existsSync(join(path, '.touba/package-draft.json')));
  assert.ok(!readFileSync(join(path, 'touba.package.json'), 'utf8').includes('private-'));
});

test('CI identity cannot be sent to arbitrary hosts or combined with interactive privileges', async t => {
  environment(t, { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/token' });
  const calls = t.mock.method(globalThis, 'fetch');
  await assert.rejects(submitCiPackage('/unused', { registry, ci: id }), { code: 'PackageCiIdentityUnavailable' });
  await assert.rejects(submitCiPackage('/unused', { registry, ci: id, draft: id }), { code: 'PackageCiConfigurationInvalid' });
  await assert.rejects(packageCommand(['publish', '--ci', id, '--registry', registry]), { code: 'PackageOptionInvalid' });
  await assert.rejects(packageCommand(['submit', '--ci', id, '--no-browser', '--registry', registry]), { code: 'PackageCiConfigurationInvalid' });
  assert.equal(calls.mock.callCount(), 0);
});

test('CI refuses failed identity, altered archive confirmation and unsafe diagnostics', async t => {
  environment(t); const path = await author(t);
  let mode = 'identity';
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('pipelines.actions')) return mode === 'identity' ? json({ error: 'private-request-fixture' }, 401) : json({ value: 'private-job-fixture' });
    return mode === 'digest' ? json({ id, status: 'draft', name: 'acme.example', version: '1.0.0', archive_digest: 'sha256:' + '0'.repeat(64) }) : json({ error: 'private-job-fixture unsafe' }, 401);
  });
  await assert.rejects(submitCiPackage(path, { registry, ci: id }), { code: 'PackageCiIdentityUnavailable' });
  mode = 'digest';
  await assert.rejects(submitCiPackage(path, { registry, ci: id }), { code: 'PackageCiResponseInvalid' });
  mode = 'refusal';
  await assert.rejects(submitCiPackage(path, { registry, ci: id }), error => error.code === 'PackageCiSubmissionRefused' && !error.message.includes('private-job'));
});
