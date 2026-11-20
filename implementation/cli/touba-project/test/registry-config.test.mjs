import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { initProject } from '../src/project.mjs';
import { configureRegistry, configuredRegistry, registryOptions } from '../src/package-registry-config.mjs';
import { registryTrustState, trustedKeys } from '../src/registry-trust-state.mjs';
import { packageDiagnostic, publicationRefusal, retrySeconds } from '../src/package-diagnostics.mjs';

test('publication closure errors expose only safe dependency identities and translate the remedy', () => {
  const data = { error: 'package_dependencies_not_publishable', diagnostic: { phase: 'dependencies',
    code: 'package_dependencies_not_publishable', dependencies: [
      { name: 'acme.leaf', version: '1.0.0', reason: 'not_available', private: 'do-not-expose' },
    ] } };
  const error = publicationRefusal('PackagePublicationRefused', { data }, 'refused');
  for (const locale of ['fr', 'en']) {
    const rendered = packageDiagnostic(error, locale);
    assert.match(rendered, /acme.leaf@1.0.0/);
    assert.doesNotMatch(rendered, /do-not-expose/);
    assert.match(rendered, locale === 'fr' ? /brouillon est conservé/ : /draft is preserved/);
  }
  data.diagnostic.dependencies[0].name = 'unsafe\nterminal';
  assert.equal(publicationRefusal('PackagePublicationRefused', { data }, 'refused').dependencies, undefined);
});
import { packageCommand } from '../src/package-command.mjs';
import { newPackage } from '../src/package-author.mjs';
import { packPackage } from '../src/packages.mjs';

test('configured project installs a signed exact package without repeated registry options', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-configured-install-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = newPackage('acme.echo', { root, publisher: 'Acme', license: 'MIT', description: 'Synthetic fixture.' }).path;
  const packed = await packPackage(source, { output: join(root, 'echo.tar.gz') });
  const archive = readFileSync(join(root, 'echo.tar.gz'));
  const registry = 'https://registry.example.invalid/registry';
  const metadata = Buffer.from(JSON.stringify({ schema_version: 'touba-registry-package-v1',
    package_ref: 'pkg:acme.echo', namespace: 'acme', name: 'echo', version: '0.1.0', kind: 'touba_package', status: 'validated', summary: 'Synthetic fixture.',
    source: { type: 'archive', url: registry + '/echo.tar.gz', path: 'echo.tar.gz', revision: packed.digest },
    compatibility: { touba: '>=1.0.0 <2.0.0', protocols: ['touba-package-v1'] },
    artifacts: [{ kind: 'package_archive', path: 'echo.tar.gz', digest: packed.digest }] }));
  const digest = 'sha256:' + createHash('sha256').update(metadata).digest('hex');
  const index = { index_schema_version: 'touba-registry-index-v1', packages: [{ package_ref: 'pkg:acme.echo', version: '0.1.0', kind: 'touba_package', status: 'validated', metadata_path: 'package.json', metadata_digest: digest }] };
  const key = generateKeyPairSync('ed25519'), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const message = encode({ alg: 'EdDSA', kid: 'fixture', typ: 'touba-registry+jwt' }) + '.' + encode({ registry, iat: now, exp: now + 3600, revision: 1, index });
  const token = message + '.' + sign(null, Buffer.from(message), key.privateKey).toString('base64url');
  const trust = join(root, 'trust.json');
  writeFileSync(trust, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'fixture', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    const data = { [registry + '/index.jwt']: token, [registry + '/package.json']: metadata, [registry + '/echo.tar.gz']: archive }[String(url)];
    assert.ok(data, 'Only signed registry resources are fetched');
    return new Response(data);
  });
  const project = join(root, 'consumer'); initProject({ root: project });
  await packageCommand(['registry', registry, '--trust', trust, '--root', project]);
  const result = await packageCommand(['add', 'acme.echo@0.1.0', '--root', project, '--json']);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(join(project, 'packages/acme.echo/touba.package.json'))).version, '0.1.0');
  assert.ok(requests.includes(registry + '/echo.tar.gz'));
});

test('project registry setup preserves explicit overrides and trusted key continuity', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-registry-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root });
  assert.equal(configuredRegistry(root), null);
  const registry = 'https://registry.example.invalid/registry', file = join(root, 'trust.json');
  const key = generateKeyPairSync('ed25519');
  const trust = { schema_version: 'touba-registry-trust-v1', registry, keys: [{ id: 'fixture', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] };
  const save = () => writeFileSync(file, JSON.stringify(trust)); save();
  assert.throws(() => configureRegistry(registry, { root }), { code: 'RegistryTrustRequired' });
  configureRegistry(registry, { root, trust: file });
  assert.deepEqual(registryOptions({ root }), { root, registry, trust: file });
  assert.equal(registryOptions({ root, registry: 'https://other.invalid' }).trust, undefined);
  assert.equal(registryOptions({ root, trust: 'explicit.json' }).trust, 'explicit.json');
  const keys = trustedKeys(trust, registry), state = registryTrustState(file + '.sqlite', registry);
  state.accept({ revision: 7, digest: 'sha256:' + '1'.repeat(64), signingKey: 'fixture', keyFingerprint: keys[0].fingerprint });
  configureRegistry(registry, { root, trust: file });
  assert.throws(() => state.accept({ revision: 6, digest: 'sha256:' + '2'.repeat(64), signingKey: 'fixture', keyFingerprint: keys[0].fingerprint }), { code: 'RegistryRollbackRefused' });
  const before = readFileSync(join(root, '.touba/registry.json'), 'utf8');
  trust.keys[0].public_key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }); save();
  assert.throws(() => configureRegistry(registry, { root, trust: file }), { code: 'RegistryKeyConflict' });
  assert.equal(readFileSync(join(root, '.touba/registry.json'), 'utf8'), before);
  symlinkSync(file, join(root, 'linked.json'));
  assert.throws(() => configureRegistry(registry, { root, trust: join(root, 'linked.json') }), { code: 'RegistryConfigurationInvalid' });
});

test('human errors are translated without changing machine codes or trusting remote text', () => {
  const error = publicationRefusal('PackageDraftRefused', { data: { error: 'submission_rate_reached' }, headers: new Headers({ 'Retry-After': '423' }) }, 'refused');
  assert.equal(error.code, 'PackageDraftRefused');
  assert.match(packageDiagnostic(error, 'fr_CA.UTF-8'), /Réessayez dans 423 s/);
  assert.match(packageDiagnostic(error, 'en'), /Retry in 423 s/);
  assert.match(packageDiagnostic({ code: 'RegistryPackageYanked' }, 'fr'), /retirée/);
  assert.match(packageDiagnostic({ code: 'RegistryPackageYanked', withdrawalReason: 'Use 2.0.0' }, 'fr'), /Motif : Use 2.0.0/);
  const testFailure = publicationRefusal('PackageDraftRefused', { data: { error: 'package_tests_failed', diagnostic: {
    phase: 'tests', code: 'PackageTestsFailed', stdout: 'private-log', stderr: 'password=secret',
  } } }, 'refused');
  assert.deepEqual(testFailure.diagnostics, [{ phase: 'tests', code: 'PackageTestsFailed', message: 'package_tests_failed' }]);
  assert.match(packageDiagnostic(testFailure, 'fr'), /\[tests: PackageTestsFailed\]/);
  assert.doesNotMatch(packageDiagnostic(testFailure, 'en'), /private-log|secret/);
  assert.match(packageDiagnostic({ code: 'PackagePublicationTargetInvalid' }, 'fr'), /localhost/);
  const unsafe = publicationRefusal('PackageDraftRefused', { data: { error: '<script>secret</script>' } }, 'refused');
  assert.equal(unsafe.reason, 'refused'); assert.doesNotMatch(packageDiagnostic(unsafe, 'fr'), /secret/);
  for (const value of ['-1', 'nonsense', '1.2', '9999999999999999999']) assert.equal(retrySeconds(value), null);
  assert.equal(retrySeconds('Wed, 01 Jan 2025 00:00:07 GMT', Date.parse('2025-01-01T00:00:00Z')), 7);
});

test('shared registry configuration survives a clone without absolute paths or credential state', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-registry-shared-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); initProject({ root });
  const registry = 'https://registry.example.invalid/registry', file = join(root, 'trust.json');
  const key = generateKeyPairSync('ed25519');
  writeFileSync(file, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry, keys: [{ id: 'fixture', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  configureRegistry(registry, { root, trust: file, shared: true });
  const ignored = readFileSync(join(root, '.gitignore'), 'utf8');
  for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.status.sqlite', '.status.sqlite-wal', '.status.sqlite-shm']) assert.ok(ignored.includes('/trust.json' + suffix));
  assert.ok(!ignored.split('\n').includes('/trust.json'), 'The public key remains versionable');
  const config = JSON.parse(readFileSync(join(root, 'touba.registry.json')));
  assert.equal(config.trust, 'trust.json'); assert.equal(JSON.stringify(config).includes(root), false);
  const clone = join(root, 'clone'); mkdirSync(clone); initProject({ root: clone });
  for (const name of ['touba.registry.json', 'trust.json']) copyFileSync(join(root, name), join(clone, name));
  assert.deepEqual(configuredRegistry(clone), { registry, trust: join(clone, 'trust.json') });
  assert.throws(() => configureRegistry(registry, { root, trust: file }), { code: 'RegistrySharedConfigurationPresent' });
  config.trust = '../trust.json'; writeFileSync(join(clone, 'touba.registry.json'), JSON.stringify(config));
  assert.throws(() => configuredRegistry(clone), { code: 'PackagePathInvalid' });
});
