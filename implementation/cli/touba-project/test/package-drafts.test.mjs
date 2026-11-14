import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPackage } from '../src/package-author.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { checkoutPackageDraft, submitPackageDraft } from '../src/package-drafts.mjs';
import { checkPackageArchive, packPackage } from '../src/packages.mjs';
import { packageDigest } from '../src/package-contract.mjs';
import { publicationBytes } from '../src/package-publish-remote.mjs';

const registry = 'https://registry.example.test/registry', issuer = 'https://identity.example.test/realms/test';
const id = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222';
const options = { registry, 'no-browser': true, notify() {} };
function root(t) { const path = realpathSync(mkdtempSync(join(tmpdir(), 'touba-draft-test-'))); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
async function fixture(t) {
  const parent = root(t), author = newPackage('acme.example', { root: parent, license: 'MIT', publisher: 'Acme' });
  // A test marker would throw if checkout/check/pack executed author code.
  writeFileSync(join(author.path, 'tests/echo.test.mjs'), 'throw new Error("author code must not run during transport");');
  const packed = await packPackage(author.path, { output: join(parent, 'source.tar.gz') });
  return { parent, author: author.path, bytes: readFileSync(packed.output), row: { id, status: 'draft', name: 'acme.example', version: '0.1.0', revision: 1, archive_digest: packed.digest } };
}
function server(t, handler, { reuse = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url, opts });
    assert.equal(opts.redirect, 'error');
    if (url === registry + '/config.json') return json({ registry, features: { presentation_reuse: reuse }, authorization: { issuer, client_id: 'cli', scope: 'openid publish', acr: 'strong' } });
    if (url === issuer + '/.well-known/openid-configuration') return json({ issuer, device_authorization_endpoint: issuer + '/device', token_endpoint: issuer + '/token', revocation_endpoint: issuer + '/revoke' });
    if (url === issuer + '/device') return json({ device_code: 'test-device', user_code: 'TEST-CODE', expires_in: 10, interval: 1, verification_uri: issuer + '/activate' });
    if (url === issuer + '/token') return json({ access_token: 'unit-private-access', refresh_token: 'unit-private-refresh' });
    if (url === issuer + '/revoke') return new Response(null, { status: 204 });
    assert.equal(opts.headers.Authorization, 'Bearer unit-private-access');
    return handler(url, opts);
  });
  return calls;
}
const revoked = calls => assert.equal(calls.filter(call => call.url === issuer + '/revoke').length, 2);

test('checkout validates exact bytes, creates author folder without running code and excludes local link from archives', async t => {
  const f = await fixture(t), parent = root(t);
  const calls = server(t, url => url.endsWith('/archive') ? new Response(f.bytes, { headers: { 'X-Touba-Digest': f.row.archive_digest } }) : json(f.row));
  const result = await checkoutPackageDraft(id, { ...options, root: parent });
  assert.equal(result.path, join(parent, 'example'));
  const link = JSON.parse(readFileSync(join(result.path, '.touba/package-draft.json')));
  assert.equal(link.id, id); assert.equal(link.registry, registry);
  assert.ok(!JSON.stringify(link).includes('unit-private'));
  assert.deepEqual(readdirSync(parent), ['example']);
  const packed = await packPackage(result.path, { output: join(parent, 'checked.tar.gz') });
  assert.equal(packed.digest, f.row.archive_digest);
  await checkPackageArchive(packed.output, { publishing: true });
  revoked(calls);
});

test('checkout never replaces an existing folder and cleans altered archive staging', async t => {
  const f = await fixture(t), parent = root(t);
  const calls = server(t, url => url.endsWith('/archive') ? new Response(Buffer.from('altered'), { headers: { 'X-Touba-Digest': f.row.archive_digest } }) : json(f.row));
  mkdirSync(join(parent, 'example')); writeFileSync(join(parent, 'example/keep.txt'), 'keep');
  await assert.rejects(checkoutPackageDraft(id, { ...options, root: parent }), { code: 'PackageAlreadyExists' });
  assert.equal(readFileSync(join(parent, 'example/keep.txt'), 'utf8'), 'keep');
  const empty = root(t);
  await assert.rejects(checkoutPackageDraft(id, { ...options, root: empty }), { code: 'PackageDraftIntegrityMismatch' });
  assert.deepEqual(readdirSync(empty), []);
  assert.equal(calls.filter(call => call.url.endsWith('/archive')).length, 1);
});

test('submit links new draft, resubmits using fresh editorial revision and refuses changed code', async t => {
  const f = await fixture(t); let current = { ...f.row }, uploads = 0;
  const calls = server(t, (url, opts) => {
    if (!opts.method) return json(current);
    uploads++;
    assert.equal(opts.headers['X-Touba-Namespace'], 'acme');
    if (opts.method === 'PUT') { assert.equal(opts.headers['X-Touba-Draft-Revision'], '4'); current.id = nextId; }
    current.archive_digest = packageDigest(opts.body);
    return json(current, 201);
  });
  const first = await submitPackageDraft(f.author, options);
  assert.equal(first.draft, id); assert.equal(first.local_link_saved, true);
  current.revision = 4; // A Cloud presentation edit does not invalidate local source.
  const second = await submitPackageDraft(f.author, { 'no-browser': true, notify() {} });
  assert.equal(second.draft, nextId);
  assert.equal(second.preview, `https://registry.example.test/cloud/library?draft=${nextId}`);
  current.archive_digest = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(submitPackageDraft(f.author, options), { code: 'PackageDraftConflict' });
  assert.equal(uploads, 2);
  assert.equal(existsSync(join(f.author, '.touba/package-draft.lock')), false);
  assert.equal(calls.filter(call => call.url.endsWith('/revoke')).length, 6);
});

test('new-version presentation reuse is explicit and unavailable to machine credentials or replacement', async t => {
  const f = await fixture(t);
  let uploads = 0;
  server(t, () => { throw Error('Unsupported registry must receive no archive'); });
  await assert.rejects(submitPackageDraft(f.author, { ...options, 'presentation-from': nextId }), { code: 'PackagePresentationReuseUnavailable' });
  server(t, (url, opts) => {
    uploads++;
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['X-Touba-Presentation-From'], nextId);
    return json({ ...f.row, archive_digest: packageDigest(opts.body) }, 201);
  }, { reuse: true });
  for (const extra of [{ automation: true }, { ci: id }, { draft: id }, { 'presentation-from': '../bad' }]) {
    await assert.rejects(submitPackageDraft(f.author, { ...options, 'presentation-from': nextId, ...extra }), { code: 'PackageOptionInvalid' });
  }
  await submitPackageDraft(f.author, { ...options, 'presentation-from': nextId });
  await assert.rejects(submitPackageDraft(f.author, { ...options, 'presentation-from': nextId }), { code: 'PackageOptionInvalid' });
  assert.equal(uploads, 1);
});

test('invalid local links, symlinks, duplicate options and different remote identities fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(checkoutPackageDraft('../escape', options), { code: 'PackageDraftInvalid' });
  await assert.rejects(packageCommand(['submit', f.author, '--draft', id, '--draft', id]), { code: 'PackageOptionInvalid' });
  await assert.rejects(packageCommand(['checkout', id, '--draft', id]), { code: 'PackageOptionInvalid' });
  const folder = join(f.author, '.touba'); mkdirSync(folder, { recursive: true });
  symlinkSync(join(f.parent, 'absent'), join(folder, 'package-draft.json'));
  await assert.rejects(submitPackageDraft(f.author, options), { code: 'PackageDraftLinkInvalid' });
  rmSync(join(folder, 'package-draft.json'));
  server(t, () => json({ ...f.row, name: 'other.example' }));
  await assert.rejects(submitPackageDraft(f.author, { ...options, draft: id }), { code: 'PackageDraftTargetMismatch' });
  assert.equal(existsSync(join(folder, 'package-draft.lock')), false);
});

test('expired access and cancellation preserve source, clean locks and revoke acquired grants', async t => {
  const f = await fixture(t), controller = new AbortController(); let cancel = false;
  const calls = server(t, () => { if (cancel) { controller.abort(); throw new Error('aborted'); } return json({ error: 'publication_authentication_required' }, 401); });
  await assert.rejects(submitPackageDraft(f.author, options), { code: 'PackageDraftRefused' });
  assert.equal(existsSync(join(f.author, '.touba/package-draft.lock')), false);
  cancel = true;
  await assert.rejects(submitPackageDraft(f.author, { ...options, signal: controller.signal }), { code: 'PackageOperationCancelled' });
  assert.equal(existsSync(join(f.author, '.touba/package-draft.lock')), false);
  assert.ok(existsSync(join(f.author, 'touba.package.json')));
  assert.equal(calls.filter(call => call.url.endsWith('/revoke')).length, 4);
});

test('HTTP transport bounds response bytes and refuses redirect overrides', async t => {
  t.mock.method(globalThis, 'fetch', async (_, opts) => { assert.equal(opts.redirect, 'error'); return new Response('123456'); });
  await assert.rejects(publicationBytes(registry, { redirect: 'follow' }, 5), { code: 'PackagePublicationUnavailable' });
});
