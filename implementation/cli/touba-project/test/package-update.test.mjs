import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, chmodSync } from "node:fs";
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../src/project.mjs";
import { newPackage, addPackage, updatePackage, reviewPackageUpdate, updateRegistryPackage, packPackage } from "../src/packages.mjs";
import { packageCommand } from '../src/package-command.mjs';
import { readPackageWorkspace, verifyInstalledPackages } from "../src/package-store.mjs";

async function fixture(t, withHandler = false, withSecret = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-update-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"); initProject({ root: consumer });
  const source = newPackage("fixture.update", { root, version: "1.0.0" }).path;
  if (withHandler) {
    const path = join(source, 'touba.package.json'), manifest = JSON.parse(readFileSync(path));
    manifest.exports = { tools: ['tool:fixture.update/Read'] };
    manifest.handlers = [{ tool: 'tool:fixture.update/Read', path: 'handlers/read.mjs', protocol: 'touba-tool-handler-v1' }];
    writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(join(source, 'src/fixture/update.tb'), 'module fixture.update\ntool Read\n    gives Text\n' + (withSecret ? '    requires secret_read\n    secrets API_KEY\n' : ''));
    mkdirSync(join(source, 'handlers'));
    writeFileSync(join(source, 'handlers/read.mjs'), 'throw new Error("Installation must never execute me");\n');
  }
  await addPackage(source, { root: consumer });
  const path = join(source, "touba.package.json");
  const version = value => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), version: value }));
  const lock = () => verifyInstalledPackages(consumer, readPackageWorkspace(consumer).records);
  return { root, consumer, source, version, lock };
}

test("explicit update changes only the selected package and keeps consumer governance", async t => {
  const f = await fixture(t);
  const configPath = join(f.consumer, "touba.project.json");
  const config = JSON.parse(readFileSync(configPath));
  config.governance = { retained: "consumer minimum must survive" };
  writeFileSync(configPath, JSON.stringify(config));
  f.version("1.1.0");
  await assert.rejects(addPackage(f.source, { root: f.consumer }), { code: "PackageDependencyConflict" });
  const result = await updatePackage(f.source, { root: f.consumer, name: "fixture.update" });
  assert.equal(result.command, "package update"); assert.equal(f.lock().packages[0].version, "1.1.0");
  assert.deepEqual(JSON.parse(readFileSync(configPath)).governance, config.governance);
  assert.equal(existsSync(join(f.consumer, ".touba-package-installing")), false);
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageVersionConflict" });
  f.version("1.0.0");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageVersionConflict" });
  assert.equal(f.lock().packages[0].version, "1.1.0");
});

test('review shows secret removal before and after and in the concise CLI output', async t => {
  const f = await fixture(t, true, true); f.version('1.1.0');
  const source = join(f.source, 'src/fixture/update.tb');
  writeFileSync(source, readFileSync(source, 'utf8').replace('    secrets API_KEY\n', ''));
  const plan = await reviewPackageUpdate(f.source, { root: f.consumer });
  assert.equal(plan.contract_changes.length, 1);
  const change = plan.contract_changes[0];
  assert.deepEqual(change.before.required_secrets, ['API_KEY']);
  assert.deepEqual(change.after.required_secrets, []);
  const text = (await packageCommand(['update', f.source, '--root', f.consumer])).text;
  assert.match(text, /required_secrets: \["API_KEY"\] -> \[\]/);
  assert.equal(f.lock().packages[0].version, '1.0.0');
  assert.equal((await reviewPackageUpdate(f.source, { root: f.consumer, accept: plan.review_digest })).status, 'success');
});

test('a code-only handler change is visible and binds the accepted review without granting capabilities', async t => {
  const f = await fixture(t, true); f.version('1.1.0');
  const handler = join(f.source, 'handlers/read.mjs');
  writeFileSync(handler, readFileSync(handler, 'utf8') + '// changed implementation\n');
  const plan = await reviewPackageUpdate(f.source, { root: f.consumer });
  assert.equal(plan.handlers.length, 1);
  assert.equal(plan.handlers[0].tool, 'tool:fixture.update/Read');
  assert.notEqual(plan.handlers[0].before.digest, plan.handlers[0].after.digest);
  assert.equal(plan.handlers[0].before.path, plan.handlers[0].after.path);
  assert.deepEqual(plan.contracts[0].tools['tool:fixture.update/Read'].required_capabilities, []);
  assert.equal(f.lock().packages[0].version, '1.0.0');
  writeFileSync(handler, readFileSync(handler, 'utf8') + '// another change\n');
  await assert.rejects(reviewPackageUpdate(f.source, { root: f.consumer, accept: plan.review_digest }), { code: 'PackageReviewChanged' });
  assert.equal(f.lock().packages[0].version, '1.0.0');
});

test('remote update verifies signed metadata and exact archive again before applying the accepted review', async t => {
  const f = await fixture(t); f.version('1.1.0');
  const manifestPath = join(f.source, 'touba.package.json'), manifest = JSON.parse(readFileSync(manifestPath));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, publisher: 'Fixture', license: 'MIT' }));
  const packed = await packPackage(f.source, { output: join(f.root, 'candidate.tar.gz') });
  let bytes = readFileSync(packed.output);
  const registry = 'https://registry.example.invalid', keys = generateKeyPairSync('ed25519');
  const trust = join(f.root, 'trust.json'), hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  writeFileSync(trust, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'fixture', status: 'active', public_key: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] }));
  let metadata = JSON.stringify({ schema_version: 'touba-registry-package-v1', package_ref: 'pkg:fixture.update', namespace: 'fixture', name: 'update',
    version: '1.1.0', kind: 'touba_package', status: 'validated', summary: 'Synthetic candidate',
    source: { type: 'archive', url: registry + '/archive.tar.gz', path: 'archive.tar.gz', revision: hash(bytes) },
    compatibility: { touba: manifest.touba.runtime_compatibility, protocols: ['touba-package-v1'] },
    artifacts: [{ kind: 'package_archive', path: 'archive.tar.gz', digest: hash(bytes) }] });
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = encode({ alg: 'EdDSA', kid: 'fixture', typ: 'touba-registry+jwt' }) + '.' + encode({ registry, iat: now, exp: now + 300, revision: 1,
    index: { index_schema_version: 'touba-registry-index-v1', packages: [{ package_ref: 'pkg:fixture.update', version: '1.1.0', kind: 'touba_package', status: 'validated',
      metadata_path: 'metadata.json', metadata_digest: hash(metadata) }] } });
  let jwt = message + '.' + sign(null, Buffer.from(message), keys.privateKey).toString('base64url');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    const path = String(url); requests.push(path);
    assert.ok(path.startsWith(registry + '/'));
    return new Response(path.endsWith('index.jwt') ? jwt : path.endsWith('metadata.json') ? metadata : bytes);
  });
  const options = { root: f.consumer, registry, trust, version: '1.1.0', 'no-browser': true };
  const plan = await updateRegistryPackage('fixture.update', options);
  assert.equal(plan.status, 'review_required'); assert.equal(f.lock().packages[0].version, '1.0.0');
  const original = bytes; bytes = Buffer.from('altered archive');
  await assert.rejects(updateRegistryPackage('fixture.update', { ...options, accept: plan.review_digest }), { code: 'PackageIntegrityMismatch' });
  assert.equal(f.lock().packages[0].version, '1.0.0');
  bytes = original;
  assert.equal((await updateRegistryPackage('fixture.update', { ...options, accept: plan.review_digest })).status, 'success');
  assert.equal(f.lock().packages[0].version, '1.1.0');
  assert.equal(requests.filter(url => url.endsWith('/index.jwt')).length, 3);
  // Even an explicitly requested downgrade cannot select a withdrawn version.
  metadata = JSON.stringify({ ...JSON.parse(metadata), version: '1.0.0', status: 'yanked',
    withdrawal: { reason: 'Synthetic safety review', changed_at: new Date().toISOString() } });
  const withdrawn = encode({ alg: 'EdDSA', kid: 'fixture', typ: 'touba-registry+jwt' }) + '.' + encode({
    registry, iat: now, exp: now + 300, revision: 2,
    index: { index_schema_version: 'touba-registry-index-v1', packages: [{ package_ref: 'pkg:fixture.update',
      version: '1.0.0', kind: 'touba_package', status: 'yanked', metadata_path: 'metadata.json', metadata_digest: hash(metadata) }] },
  });
  jwt = withdrawn + '.' + sign(null, Buffer.from(withdrawn), keys.privateKey).toString('base64url');
  requests.length = 0;
  await assert.rejects(updateRegistryPackage('fixture.update', { ...options, version: '1.0.0', 'allow-downgrade': true }), { code: 'RegistryPackageYanked' });
  assert.equal(f.lock().packages[0].version, '1.1.0');
  assert.equal(requests.some(url => url.endsWith('/archive.tar.gz')), false);
});

test("update refuses identity changes and tampered installed content before replacing it", async t => {
  const f = await fixture(t); f.version("1.1.0");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.missing" }), { code: "PackageNotInstalled" });
  const manifest = join(f.consumer, "packages/fixture.update/touba.package.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageIntegrityMismatch" });
  assert.equal(JSON.parse(readFileSync(manifest)).version, "1.0.0");
});

test('CLI update requires the exact current review and preserves installed state on stale acceptance', async t => {
  const f = await fixture(t); f.version('1.1.0');
  const preview = await packageCommand(['update', f.source, '--root', f.consumer, '--json']);
  const plan = JSON.parse(preview.text);
  assert.equal(plan.status, 'review_required');
  assert.equal(f.lock().packages[0].version, '1.0.0');
  await assert.rejects(reviewPackageUpdate(f.source, { root: f.consumer, accept: 'sha256:' + '0'.repeat(64) }), { code: 'PackageReviewChanged' });
  const applied = await packageCommand(['update', f.source, '--root', f.consumer, '--accept', plan.review_digest, '--json']);
  assert.equal(JSON.parse(applied.text).status, 'success');
  assert.equal(f.lock().packages[0].version, '1.1.0');
  f.version('1.2.0');
  const next = await reviewPackageUpdate(f.source, { root: f.consumer });
  const config = join(f.consumer, 'touba.project.json');
  writeFileSync(config, readFileSync(config, 'utf8') + '\n');
  await assert.rejects(reviewPackageUpdate(f.source, { root: f.consumer, accept: next.review_digest }), { code: 'PackageReviewChanged' });
  assert.equal(f.lock().packages[0].version, '1.1.0');
});

test('an older version requires explicit reviewed consent and preserves the consumer minimum', async t => {
  const f = await fixture(t, true); f.version('1.1.0');
  const up = await reviewPackageUpdate(f.source, { root: f.consumer });
  await reviewPackageUpdate(f.source, { root: f.consumer, accept: up.review_digest });
  const configPath = join(f.consumer, 'touba.project.json'), config = JSON.parse(readFileSync(configPath));
  config.configuration = { tool_policies: { 'tool:fixture.update/Read': { role: 'controller' } } };
  writeFileSync(configPath, JSON.stringify(config));
  const before = readFileSync(configPath, 'utf8');
  f.version('1.0.0');
  const command = ['update', f.source, '--root', f.consumer, '--allow-downgrade', '--json'];
  await assert.rejects(reviewPackageUpdate(f.source, { root: f.consumer }), { code: 'PackageVersionConflict' });
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: 'fixture.update', 'allow-downgrade': true }), { code: 'PackageReviewRequired' });
  const down = JSON.parse((await packageCommand(command)).text);
  assert.equal(down.direction, 'downgrade'); assert.equal(down.previous, '1.1.0'); assert.equal(down.version, '1.0.0');
  assert.equal(f.lock().packages[0].version, '1.1.0');
  await assert.rejects(packageCommand([...command, '--accept', up.review_digest]), { code: 'PackageReviewChanged' });
  const applied = JSON.parse((await packageCommand([...command, '--accept', down.review_digest])).text);
  assert.equal(applied.status, 'success'); assert.equal(f.lock().packages[0].version, '1.0.0');
  assert.deepEqual(JSON.parse(readFileSync(configPath)).configuration, JSON.parse(before).configuration);
  await assert.rejects(packageCommand(command), { code: 'PackageVersionConflict' });
});

test('explicit downgrade cannot break another installed package exact dependency', async t => {
  const f = await fixture(t); f.version('1.1.0');
  const up = await reviewPackageUpdate(f.source, { root: f.consumer });
  await reviewPackageUpdate(f.source, { root: f.consumer, accept: up.review_digest });
  const parent = newPackage('fixture.parent', { root: f.root, version: '1.0.0' }).path;
  await addPackage(f.source, { root: parent });
  await addPackage(parent, { root: f.consumer });
  const before = f.lock();
  f.version('1.0.0');
  await assert.rejects(packageCommand(['add', f.source, '--root', f.consumer, '--lang', 'fr']), error => {
    assert.equal(error.code, 'PackageDependencyConflict');
    assert.deepEqual(error.constraints, [{consumer:'fixture.parent',dependency:'fixture.update',constraint:'1.1.0',
      current_version:'1.1.0',version:'1.0.0',origin:'installed',blocking:true}]);
    return true;
  });
  const options = { root: f.consumer, 'allow-downgrade': true };
  await assert.rejects(reviewPackageUpdate(f.source, options), { code: 'PackageInUse' });
  await assert.rejects(reviewPackageUpdate(f.source, { ...options, accept: 'sha256:' + '0'.repeat(64) }), { code: 'PackageInUse' });
  assert.deepEqual(f.lock(), before);
  assert.equal(existsSync(join(f.consumer, '.touba-package-installing')), false);
});

test('a failed replacement preserves the previous code, lock and configuration', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t, true); f.version('1.1.0');
  const files = ['touba.project.json', 'touba.packages.lock.json', 'packages/fixture.update/handlers/read.mjs'];
  const before = files.map(path => readFileSync(join(f.consumer, path)));
  const plan = await reviewPackageUpdate(f.source, { root: f.consumer });
  chmodSync(join(f.consumer, 'packages'), 0o500);
  try { await assert.rejects(reviewPackageUpdate(f.source, { root: f.consumer, accept: plan.review_digest }), /EACCES|EPERM/); }
  finally { chmodSync(join(f.consumer, 'packages'), 0o700); }
  assert.deepEqual(files.map(path => readFileSync(join(f.consumer, path))), before);
  assert.equal(existsSync(join(f.consumer, '.touba-package-installing')), false);
  assert.equal(f.lock().packages[0].version, '1.0.0');
  assert.equal((await reviewPackageUpdate(f.source, { root: f.consumer, accept: plan.review_digest })).status, 'success');
});
