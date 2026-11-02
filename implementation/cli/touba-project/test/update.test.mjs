import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { c, Header } from 'tar';
import { gzipSync } from 'node:zlib';
import { digest, chooseRelease, validatePolicy, verifyCatalogue } from '../src/update/protocol.mjs';
import { download, extractPayload, validateGzipSize } from '../src/update/transfer.mjs';
import { performUpdate, parseUpdateOptions } from '../src/update/command.mjs';
import { activeProcesses, ensureSpace, installation, readJson } from '../src/update/platform.mjs';
import { installToolchainPayload, withInstallationLock } from '../../touba-distribution/src/install-toolchain-payload.mjs';
import { toolchainBuildIdentity } from '../../touba-distribution/src/build-identity.mjs';
import { signUpdateCatalogue } from '../../touba-distribution/src/sign-update-catalogue.mjs';

const now = Date.parse('2026-11-01T12:00:00Z');
const platform = `${process.platform}-${process.arch}`;
function trust() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = { id: digest(publicKey.export({ type: 'spki', format: 'der' })), public_key: publicKey.export({ type: 'spki', format: 'pem' }) };
  return { privateKey, policy: { schema: 'touba-update-trust-v1', channel: 'validation', build_sequence: 1,
    catalogue_url: 'https://updates.example/downloads/touba/updates.json', keys: [key] } };
}
function envelope(catalogue, policy, privateKey) {
  const payload = Buffer.from(JSON.stringify(catalogue));
  return Buffer.from(JSON.stringify({ schema: 'touba-update-envelope-v1', key_id: policy.keys[0].id,
    payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
}
function basic() {
  const keys = trust();
  const release = { platform, version: '1.0.0', build_id: 'b'.repeat(64), build_sequence: 2,
    url: 'https://updates.example/downloads/touba/build.tar.gz', sha256: 'c'.repeat(64), size: 200, expanded_size: 500, notes: 'Correction.' };
  return { ...keys, release, catalogue: { schema: 'touba-update-catalogue-v1', channel: 'validation', sequence: 5,
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), releases: [release] } };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'touba-update-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { policy, privateKey } = trust();
  const prefix = join(root, 'installed');
  function payload(sequence, name) {
    const path = join(root, name, 'touba-toolchain');
    for (const dir of ['bin', 'sdk', 'lib/cli/touba-project/src/update']) mkdirSync(join(path, dir), { recursive: true });
    writeFileSync(join(path, 'bin/test.txt'), `build ${sequence}`);
    writeFileSync(join(path, 'lib/cli/touba-project/src/update/trust.json'), JSON.stringify({ ...policy, build_sequence: sequence }));
    const metadata = { touba_version: '1.0.0', platform, build: toolchainBuildIdentity(path) };
    writeFileSync(join(path, 'TOOLCHAIN.json'), JSON.stringify(metadata));
    return { path, metadata };
  }
  const old = payload(1, 'previous'), next = payload(2, `touba-v1.0.0-${platform}`);
  installToolchainPayload({ source: old.path, prefix });
  writeFileSync(join(prefix, 'INSTALLATION.json'), JSON.stringify({ prefix, platform, touba_version: '1.0.0', installation_profile: 'touba-desktop-install-v1' }));
  mkdirSync(join(prefix, 'projects'));
  writeFileSync(join(prefix, 'projects/keep.txt'), 'project SDKs and state untouched');
  const archive = join(root, 'candidate.tar.gz');
  c({ file: archive, gzip: true, sync: true, cwd: root, portable: true }, [`touba-v1.0.0-${platform}`]);
  const bytes = readFileSync(archive);
  const signed = await signUpdateCatalogue({ manifest: { sequence: 2, issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 86400000).toISOString(), artifacts: [{ archive, url: 'https://updates.example/downloads/touba/candidate.tar.gz' }] },
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), policy, now });
  const checked = verifyCatalogue(signed, policy, { now });
  const calls = [], validations = [];
  const dependencies = {
    now: () => now,
    idle() {},
    validate(path, expected) { validations.push(path); assert.equal(readJson(join(path, 'TOOLCHAIN.json')).build.id, expected.build_id); },
    fetcher: async (url, options) => { calls.push(url); assert.equal(options.redirect, 'error'); return new Response(url.endsWith('updates.json') ? signed : bytes); },
  };
  return { root, prefix, active: join(prefix, 'touba-toolchain'), old, next, archive, bytes, signed, checked, policy, privateKey, dependencies, calls, validations };
}

test('native installation receipt identifies the physical prefix', async t => {
  const f = await fixture(t);
  const metadata = readJson(join(f.active, 'TOOLCHAIN.json'));
  const receipt = readJson(join(f.prefix, 'INSTALLATION.json'));
  const paths = { receipt: realpathSync(receipt.prefix), parent: dirname(realpathSync(f.active)),
    nativeReceipt: realpathSync.native(receipt.prefix), nativeParent: dirname(realpathSync.native(f.active)),
    receiptPlatform: receipt.platform, payloadPlatform: metadata.platform, platform };
  assert.doesNotThrow(() => installation(f.active), JSON.stringify(paths));
  assert.doesNotThrow(() => installation(realpathSync.native(f.active)), JSON.stringify(paths));
});

test('signature, expiry, origin, bounds, duplicate targets and catalogue rollback are checked', () => {
  const f = basic();
  const verify = catalogue => verifyCatalogue(envelope(catalogue, f.policy, f.privateKey), f.policy, { now });
  const accepted = verify(f.catalogue);
  for (const mutate of [
    c => { c.expires_at = new Date(now).toISOString(); },
    c => { c.issued_at = new Date(now + 600000).toISOString(); },
    c => { c.expires_at = new Date(now + 15 * 86400000).toISOString(); },
    c => { c.releases.push(c.releases[0]); },
    c => { c.releases[0].platform = 'linux-arm64'; },
    c => { c.releases[0].url = 'https://evil.example/payload'; },
    c => { c.releases[0].url = 'http://updates.example/downloads/touba/x'; },
    c => { c.releases[0].url += '?token=secret'; },
    c => { c.releases[0].size = 2 ** 31; },
    c => { c.releases[0].expanded_size = -1; },
    c => { c.releases[0].extra = true; },
  ]) { const copy = structuredClone(f.catalogue); mutate(copy); assert.throws(() => verify(copy)); }
  const bytes = JSON.parse(envelope(f.catalogue, f.policy, f.privateKey));
  bytes.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => verifyCatalogue(Buffer.from(JSON.stringify(bytes)), f.policy, { now }), { code: 'UpdateSignatureInvalid' });
  assert.throws(() => verifyCatalogue(envelope({ ...f.catalogue, sequence: 4 }, f.policy, f.privateKey), f.policy,
    { now, previous: accepted.checkpoint }), { code: 'UpdateCatalogueRollback' });
  const changed = structuredClone(f.catalogue); changed.releases[0].notes = 'different';
  assert.throws(() => verifyCatalogue(envelope(changed, f.policy, f.privateKey), f.policy,
    { now, previous: accepted.checkpoint }), { code: 'UpdateCatalogueRollback' });
  assert.throws(() => validatePolicy({ ...f.policy, keys: [] }), { code: 'UpdateTrustUnavailable' });
});

test('same version new build works; stale sequence and semantic downgrades do not', () => {
  const f = basic(), installed = { platform, touba_version: '1.0.0', build: { id: 'a'.repeat(64) } };
  assert.equal(chooseRelease(f.catalogue, installed, f.policy).current, false);
  assert.throws(() => chooseRelease(f.catalogue, installed, f.policy, 3), { code: 'UpdateDowngradeRefused' });
  f.release.version = '0.9.0';
  assert.throws(() => chooseRelease(f.catalogue, installed, f.policy), { code: 'UpdateDowngradeRefused' });
  f.release.version = '1.0.0'; f.release.build_sequence = 1;
  assert.throws(() => chooseRelease(f.catalogue, installed, f.policy), { code: 'UpdateDowngradeRefused' });
  f.release.build_id = installed.build.id;
  assert.equal(chooseRelease(f.catalogue, installed, f.policy).current, true);
});

test('bounded downloads reject hash, size, HTTP failure and streamed overrun', async () => {
  const { policy, release } = basic();
  for (const response of [new Response('wrong'), new Response('error', { status: 503 }),
    new Response('x', { headers: { 'content-length': '9999999' } }), new Response('x'.repeat(201))]) {
    await assert.rejects(download(release.url, { policy, release, fetcher: async () => response }));
  }
  await assert.rejects(download(policy.catalogue_url, { policy, fetcher: async () => { throw new Error('network interrupted'); } }), /network interrupted/);
  assert.equal((await download(policy.catalogue_url, { policy, fetcher: async () => new Response('ok') })).toString(), 'ok');
});

test('decompressed padding is bounded even without TAR entries', async t => {
  const f = await fixture(t), file = join(f.root, 'padding.gz');
  writeFileSync(file, gzipSync(Buffer.alloc(4096)));
  await assert.rejects(validateGzipSize(file, 1024), { code: 'UpdateArchiveLimit' });
});

test('cancellation releases the install lock without replacing any bytes', async t => {
  const f = await fixture(t), abort = new AbortController();
  const pending = performUpdate(f.active, { yes: true }, { ...f.dependencies, signal: abort.signal,
    fetcher: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      abort.abort(new Error('cancelled by test'));
    }),
  });
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(existsSync(join(f.prefix, '.install.lock')), false);
  assert.deepEqual(toolchainBuildIdentity(f.active), f.old.metadata.build);
});

test('check changes no installed bytes and makes no archive request', async t => {
  const f = await fixture(t);
  const report = await performUpdate(f.active, { check: true }, f.dependencies);
  assert.equal(report.status, 'available'); assert.equal(f.calls.length, 1);
  assert.deepEqual(toolchainBuildIdentity(f.active), f.old.metadata.build);
  assert.equal(existsSync(join(f.prefix, '.install.lock')), false);
  assert.equal(readJson(join(f.prefix, '.update-state.json')).catalogue.sequence, 2);
});

test('isolated update preserves projects, passes both checks, and rolls back without network', async t => {
  const f = await fixture(t);
  const updated = await performUpdate(f.active, { yes: true }, f.dependencies);
  assert.equal(updated.status, 'updated'); assert.equal(f.validations.length, 2);
  assert.deepEqual(toolchainBuildIdentity(f.active), f.next.metadata.build);
  assert.equal(readFileSync(join(f.prefix, 'projects/keep.txt'), 'utf8'), 'project SDKs and state untouched');
  assert.deepEqual(toolchainBuildIdentity(updated.previous_build), f.old.metadata.build);
  assert.equal((await performUpdate(f.active, { check: true }, f.dependencies)).status, 'current');
  const rolled = await performUpdate(f.active, { rollback: true, yes: true }, { ...f.dependencies, fetcher: () => assert.fail('rollback must be offline') });
  assert.equal(rolled.status, 'restored'); assert.deepEqual(toolchainBuildIdentity(f.active), f.old.metadata.build);
  assert.equal(readJson(join(f.prefix, '.update-state.json')).highest_build, 2);
  assert.equal((await performUpdate(f.active, { yes: true }, f.dependencies)).status, 'updated');
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.touba-update-')), false);
});

test('post-install failure restores the payload and installation receipt', async t => {
  const f = await fixture(t), before = readJson(join(f.prefix, 'INSTALLATION.json'));
  let count = 0;
  await assert.rejects(performUpdate(f.active, { yes: true }, { ...f.dependencies,
    validate() { if (++count === 2) throw new Error('post-install failed'); } }), /post-install failed/);
  assert.equal(count, 2);
  assert.deepEqual(toolchainBuildIdentity(f.active), f.old.metadata.build);
  assert.deepEqual(readJson(join(f.prefix, 'INSTALLATION.json')), before);
  assert.equal(existsSync(join(f.prefix, '.install.lock')), false);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.touba-update-')), false);
});

test('confirmation, busy installation, disk space, changed bytes and concurrent installer stop updates', async t => {
  const f = await fixture(t);
  await assert.rejects(performUpdate(f.active, {}, f.dependencies), { code: 'UpdateConfirmationRequired' });
  for (const injected of [
    { idle() { throw new Error('running service'); } },
    { space() { ensureSpace(f.prefix, 1024, () => ({ bavail: 0n, bsize: 4096n })); } },
    { fetcher() { throw new Error('interrupted'); } },
  ]) await assert.rejects(performUpdate(f.active, { yes: true }, { ...f.dependencies, ...injected }));
  await withInstallationLock(f.prefix, async () => {
    await assert.rejects(performUpdate(f.active, { yes: true }, f.dependencies), { code: 'InstallationInProgress' });
  });
  writeFileSync(join(f.active, 'bin/changed'), 'altered');
  await assert.rejects(performUpdate(f.active, { yes: true }, f.dependencies), { code: 'UpdateInstallationModified' });
  assert.equal(readJson(join(f.active, 'TOOLCHAIN.json')).build.id, f.old.metadata.build.id);
});

test('rollback rejects path traversal and an altered retained build', async t => {
  const f = await fixture(t);
  await assert.rejects(performUpdate(f.active, { rollback: true, yes: true }, f.dependencies), { code: 'UpdateRollbackUnavailable' });
  await performUpdate(f.active, { yes: true }, f.dependencies);
  const state = readJson(join(f.prefix, '.update-state.json'));
  writeFileSync(join(f.prefix, state.previous.path, 'bin/altered'), 'tampered');
  await assert.rejects(performUpdate(f.active, { rollback: true, yes: true }, f.dependencies), { code: 'UpdateBuildIdentityMismatch' });
  state.previous.path = '../previous/touba-toolchain';
  writeFileSync(join(f.prefix, '.update-state.json'), JSON.stringify(state));
  await assert.rejects(performUpdate(f.active, { rollback: true, yes: true }, f.dependencies), { code: 'UpdateRollbackUnavailable' });
});

test('archive preflight rejects links, traversal, duplicate names and privileged modes before extraction', async t => {
  const f = await fixture(t), base = 'touba-v1.0.0-test';
  for (const [index, entries] of [
    [{ path: `${base}/touba-toolchain/link`, type: 'SymbolicLink', linkpath: '/tmp' }],
    [{ path: `${base}/../outside`, type: 'File' }],
    [{ path: `${base}/touba-toolchain/x`, type: 'File' }, { path: `${base}/touba-toolchain/X`, type: 'File' }],
    [{ path: `${base}/touba-toolchain/suid`, type: 'File', mode: 0o4755 }],
    [{ path: `${base}/touba-toolchain/CON`, type: 'File' }],
  ].entries()) {
    const blocks = entries.map(entry => { const header = new Header({ size: 0, mode: 0o644, ...entry }); header.encode(); return header.block; });
    const file = join(f.root, `unsafe-${index}.tgz`), destination = join(f.root, `unsafe-${index}`);
    writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
    await assert.rejects(extractPayload(file, destination));
    assert.equal(existsSync(destination), false);
  }
});

test('options reject ambiguity and unsigned URL override', () => {
  assert.deepEqual(parseUpdateOptions(['--check']), { check: true });
  for (const args of [['--url', 'https://evil.test'], ['--check', '--yes'], ['--check', '--rollback'], ['--yes', '--yes']]) {
    assert.throws(() => parseUpdateOptions(args), { code: 'UpdateOptionInvalid' });
  }
});

test('unmanaged paths and symlink receipts are refused', async t => {
  const f = await fixture(t);
  assert.throws(() => installation(f.root), { code: 'UpdateUnmanagedInstallation' });
  const receipt = join(f.prefix, 'INSTALLATION.json');
  cpSync(receipt, join(f.root, 'receipt.json')); rmSync(receipt);
  symlinkSync(join(f.root, 'receipt.json'), receipt);
  assert.throws(() => installation(f.active), { code: 'UpdatePathUnsafe' });
});

test('process inspection refuses an unavailable process list and identifies installed services', async t => {
  const f = await fixture(t);
  assert.throws(() => activeProcesses(f.active, () => ({ status: 1, stdout: '' })), { code: 'UpdateProcessCheckFailed' });
  const stdout = process.platform === 'win32'
    ? JSON.stringify([{ ProcessId: 999999, CommandLine: `${f.active}/bin/node service`, ExecutablePath: '' }])
    : `999999 ${f.active}/bin/node service\n${process.pid} ${f.active}/bin/node update\n`;
  assert.deepEqual(activeProcesses(f.active, () => ({ status: 0, stdout })), [999999]);
});
