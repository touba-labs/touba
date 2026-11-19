import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPackage } from '../src/package-author.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { checkoutPackageDraft, submitPackageDraft } from '../src/package-drafts.mjs';
import { addPackage, checkPackageArchive, packPackage } from '../src/packages.mjs';
import { submitPackageSuite } from '../src/package-suite.mjs';
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
    if (url === issuer + '/token') return json({ access_token: 'unit-private-access', refresh_token: 'unit-private-refresh', expires_in: 300, refresh_expires_in: 3600 });
    if (url === issuer + '/revoke') return new Response(null, { status: 204 });
    assert.equal(opts.headers.Authorization, 'Bearer unit-private-access');
    return handler(url, opts);
  });
  return calls;
}
const revoked = calls => assert.equal(calls.filter(call => call.url === issuer + '/revoke').length, 2);

test('a replaced draft requires explicit selection and never uploads or follows its successor', async t => {
  const f = await fixture(t);
  const calls = server(t, (url, opts) => {
    assert.equal(url, registry + '/drafts/' + id);
    assert.equal(opts.method, undefined);
    return json({ status: 'replaced', id, replacement_id: nextId, space_id: '33333333-3333-4333-8333-333333333333' });
  });
  await assert.rejects(submitPackageDraft(f.author, { ...options, draft: id }), { code: 'PackageDraftReplaced' });
  assert.equal(calls.filter(call => call.url.startsWith(registry + '/drafts/')).length, 1);
  assert.equal(existsSync(join(f.author, '.touba/package-draft.json')), false);
  revoked(calls);
});

test('a bounded suite orders dependencies, keeps individual drafts and resumes unchanged without uploading', async t => {
  const f = await fixture(t), dependent = newPackage('acme.dependent', { root: f.parent, license: 'MIT', publisher: 'Acme' }).path;
  await addPackage(f.author, { root: dependent });
  const suite = join(f.parent, 'suite.json'); writeFileSync(suite, JSON.stringify(['dependent', 'example']));
  const rows = new Map(), uploaded = [];
  const calls = server(t, async (url, opts) => {
    if (!opts.method) return json(rows.get(url.split('/').at(-1)));
    assert.equal(opts.method, 'POST');
    const path = join(f.parent, `upload-${uploaded.length}.tar.gz`); writeFileSync(path, opts.body);
    const checked = await checkPackageArchive(path, { publishing: true });
    const name = checked.manifest.name, draft = uploaded.length === 0 ? id : nextId;
    const row = { status: 'draft', id: draft, name, version: '0.1.0', archive_digest: packageDigest(opts.body), revision: 1, ready: true };
    rows.set(draft, row); uploaded.push(name); return json(row, 201);
  });
  const first = await submitPackageSuite(suite, { ...options, 'session-only': true });
  assert.equal(first.status, 'success');
  assert.deepEqual(uploaded, ['acme.example', 'acme.dependent']);
  assert.equal(calls.filter(call => call.url === issuer + '/device').length, 1);
  revoked(calls);
  const second = await submitPackageSuite(suite, { ...options, 'session-only': true });
  assert.equal(second.status, 'success'); assert.equal(uploaded.length, 2);
  assert.equal(second.results.every(row => row.unchanged), true);
  assert.equal(calls.filter(call => call.url === issuer + '/device').length, 2);
  assert.equal(calls.filter(call => call.url === issuer + '/revoke').length, 4);
  for (const folder of [f.author, dependent]) assert.ok(!readFileSync(join(folder, '.touba/package-draft.json'), 'utf8').includes('unit-private'));
});

test('suite preflight refuses count, byte, duplicate and directory errors before network', async t => {
  const f = await fixture(t), suite = join(f.parent, 'suite.json');
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network'); });
  for (const [paths, extra, code] of [
    [['example', 'example'], { 'max-packages': 1 }, 'PackageSuiteLimitExceeded'],
    [['example'], { 'max-bytes': 1 }, 'PackageSuiteLimitExceeded'],
    [['example', 'example'], {}, 'PackageSuiteConflict'],
    [['../outside'], {}, 'PackageSuiteInvalid'],
  ]) {
    writeFileSync(suite, JSON.stringify(paths));
    await assert.rejects(submitPackageSuite(suite, { ...options, ...extra }), { code });
  }
  assert.equal(calls, 0);
});

test('a submission suite preserves independent exact closures when another compatible version is selected', async t => {
  const f = await fixture(t), dependent = newPackage('acme.dependent', { root: f.parent, license: 'MIT', publisher: 'Acme' }).path;
  await addPackage(f.author, { root: dependent });
  const edit = (path, fields) => { const file = join(path, 'touba.package.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...fields })); };
  edit(dependent, { package_schema_version: 'touba-package-v2', dependencies: { 'acme.example': '>=0.1.0 <1.0.0' } });
  edit(f.author, { version: '0.2.0' });
  const suite = join(f.parent, 'suite.json'); writeFileSync(suite, JSON.stringify(['dependent', 'example']));
  const uploaded = [];
  server(t, async (url, opts) => {
    assert.equal(opts.method, 'POST');
    const path = join(f.parent, `independent-${uploaded.length}.tar.gz`); writeFileSync(path, opts.body);
    const checked = await checkPackageArchive(path, { publishing: true }); uploaded.push(checked);
    return json({ status: 'draft', id: uploaded.length === 1 ? id : nextId, name: checked.package, version: checked.version,
      archive_digest: packageDigest(opts.body), revision: 1, ready: true }, 201);
  });
  const result = await submitPackageSuite(suite, options);
  assert.equal(result.status, 'success');
  assert.equal(uploaded[0].packages.find(row => row.name === 'acme.example').version, '0.1.0');
  assert.equal(uploaded[1].version, '0.2.0');
});

test('suite stops on 429, preserves Retry-After and does not retry or visit later packages', async t => {
  const f = await fixture(t);
  newPackage('acme.second', { root: f.parent, license: 'MIT', publisher: 'Acme' });
  const suite = join(f.parent, 'suite.json'); writeFileSync(suite, JSON.stringify(['example', 'second']));
  let uploads = 0;
  const calls = server(t, () => {
    uploads++;
    return new Response(JSON.stringify({ error: 'submission_rate_reached' }), { status: 429, headers: { 'Retry-After': '75' } });
  });
  const result = await submitPackageSuite(suite, { ...options, lang: 'fr' });
  assert.equal(uploads, 1);
  assert.deepEqual(result.results, [{ package: 'acme.example', version: '0.1.0', status: 'error',
    code: 'PackageDraftRefused', reason: 'submission_rate_reached', retry_after: 75 }]);
  assert.match(result.notes[0], /^Lot arrêté/);
  assert.equal(existsSync(join(f.author, '.touba/package-draft.lock')), false);
  revoked(calls);
});

test('suite does not skip unqualified equal bytes and stops after cancellation', async t => {
  const f = await fixture(t), suite = join(f.parent, 'suite.json');
  newPackage('acme.second', { root: f.parent, license: 'MIT', publisher: 'Acme' });
  writeFileSync(suite, JSON.stringify(['example', 'second']));
  mkdirSync(join(f.author, '.touba'), { recursive: true });
  writeFileSync(join(f.author, '.touba/package-draft.json'), JSON.stringify({ ...f.row, registry }));
  const controller = new AbortController();
  let uploads = 0;
  server(t, (url, opts) => {
    if (!opts.method) return json({ ...f.row, ready: false });
    assert.equal(opts.method, 'PUT'); uploads++;
    controller.abort();
    return json({ ...f.row, revision: 2, archive_digest: packageDigest(opts.body), ready: true });
  });
  const result = await submitPackageSuite(suite, { ...options, signal: controller.signal });
  assert.equal(result.status, 'error');
  assert.equal(uploads, 1);
  assert.equal(result.results.at(-1).code, 'PackageOperationCancelled');
  assert.equal(existsSync(join(f.author, '.touba/package-draft.lock')), false);
});

test('suite preserves previous success and rejects edits made after preflight', async t => {
  const f = await fixture(t), second = newPackage('acme.second', { root: f.parent, license: 'MIT', publisher: 'Acme' }).path;
  const suite = join(f.parent, 'suite.json'); writeFileSync(suite, JSON.stringify(['example', 'second']));
  let uploads = 0;
  server(t, (url, opts) => {
    uploads++;
    writeFileSync(join(second, 'README.md'), '# Changed after review\n');
    return json({ ...f.row, archive_digest: packageDigest(opts.body), ready: true }, 201);
  });
  const result = await submitPackageSuite(suite, options);
  assert.equal(result.status, 'error'); assert.equal(uploads, 1);
  assert.equal(result.results[0].status, 'success');
  assert.equal(result.results[1].code, 'PackageProjectChanged');
  assert.equal(existsSync(join(f.author, '.touba/package-draft.json')), true);
  assert.equal(existsSync(join(second, '.touba/package-draft.json')), false);
});

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
  const first = await submitPackageDraft(f.author, { ...options, lang: 'fr' });
  assert.match(first.notes[0], /^Brouillon privé vérifié/);
  assert.doesNotMatch(first.notes.join(' '), /Private draft/);
  assert.equal(first.draft, id); assert.equal(first.local_link_saved, true);
  assert.equal(first.replacement, undefined);
  current.revision = 4; // A Cloud presentation edit does not invalidate local source.
  const second = await submitPackageDraft(f.author, { 'no-browser': true, notify() {} });
  assert.equal(second.draft, nextId);
  assert.equal(second.preview, `https://registry.example.test/cloud/library?draft=${nextId}`);
  assert.equal(second.replacement.previous_draft, id);
  assert.equal(second.replacement.previous_preview, `https://registry.example.test/cloud/library?draft=${id}`);
  assert.equal(second.replacement.preview, second.preview);
  assert.ok(second.notes.some(note => note.includes('Draft replaced:')));
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
