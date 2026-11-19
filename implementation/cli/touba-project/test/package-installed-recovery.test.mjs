import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject, prepareProject } from '../src/project.mjs';
import { readPackage } from '../src/package-contract.mjs';
import { PACKAGE_LOCK_SCHEMA, inspectInstalledPackages, readPackageWorkspace, verifyInstalledPackages } from '../src/package-store.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { removePackage } from '../src/packages.mjs';
import { registryPackageStates } from '../src/registry.mjs';
import { auditPackageStatus } from '../src/package-status.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function fixture(t, name, module, dependencies = {}, metadata = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-installed-recovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root });
  const entries = [], records = [];
  function install(name, module, dependencies = {}, metadata = {}) {
    const manifest = `packages/${name}/touba.package.json`;
    const base = dirname(join(root, manifest));
    const document = { package_schema_version: 'touba-package-v1', name, version: '1.0.0',
      touba: { air_profile: 'touba-air-json-canonical-v1', runtime_compatibility: '>=1.0.0 <2.0.0' },
      exports: { skills: [`skill:${module}/Run`] }, dependencies, ...metadata };
    // Reconstruct an old lock from bytes, independently of the recovery reader.
    const content = { 'touba.package.json': json(document), [`src/${module.replaceAll('.', '/')}.tb`]: 'historical source, never executed\n' };
    if(metadata.readme)content[metadata.readme]='Historical text\u202e altered direction';
    const files = Object.entries(content).map(([path, bytes]) => {
      mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), bytes);
      return { path, size: Buffer.byteLength(bytes), digest: digest(bytes) };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    entries.push({ name, version: '1.0.0', manifest, files, digest: digest(JSON.stringify(files)) });
    records.push({ manifest, version: '1.0.0' });
    writeFileSync(join(root, 'touba.packages.lock.json'), json({ lock_schema_version: PACKAGE_LOCK_SCHEMA, packages: entries }));
    const project = JSON.parse(readFileSync(join(root, 'touba.project.json')));
    project.packages = records; writeFileSync(join(root, 'touba.project.json'), json(project));
    return base;
  }
  const base = install(name, module, dependencies, metadata);
  return { root, base, install, records };
}
const snapshot = f => ['touba.project.json', 'touba.packages.lock.json'].map(path => readFileSync(join(f.root, path), 'utf8'));

for(const metadata of [{description:'Hidden\u200b text'},{readme:'README.md'}])
test('historical unsafe presentation is inspectable and removable, never admitted',async t=>{
  const f=fixture(t,'legacy.tools','legacy.tools',{},metadata);
  assert.throws(()=>readPackage(f.base),{code:'PackageMetadataInvalid'});
  const listed=JSON.parse((await packageCommand(['list','--root',f.root,'--json'])).text);
  assert.equal(listed.packages[0].restrictions[0].code,'PackageMetadataInvalid');
  assert.equal(removePackage('legacy.tools',{root:f.root}).status,'success');
});

test('historical inspection still verifies signed catalogue continuity and cache',async t=>{
  const f=fixture(t,'legacy_team.tools','legacy_team.tools'),before=snapshot(f);
  const registry='https://registry.example.invalid',trust=join(f.root,'trust.json');
  const keys=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000);
  writeFileSync(trust,json({schema_version:'touba-registry-trust-v1',registry,
    keys:[{id:'fixture',status:'active',public_key:keys.publicKey.export({type:'spki',format:'pem'})}]}));
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload=encode({alg:'EdDSA',typ:'touba-registry+jwt',kid:'fixture'})+'.'+encode({registry,revision:1,iat:now,exp:now+600,
    index:{index_schema_version:'touba-registry-index-v1',packages:[{package_ref:'pkg:legacy_team.tools',version:'1.0.0',kind:'touba_package',status:'yanked',
      metadata_path:'metadata/item.json',metadata_digest:'sha256:'+'0'.repeat(64),withdrawal:{reason:'Historical version',changed_at:new Date().toISOString()}}]}});
  const signed=Buffer.from(payload+'.'+sign(null,Buffer.from(payload),keys.privateKey).toString('base64url'));
  await registryPackageStates({registry,trust,readBytes:async()=>signed});
  t.mock.method(globalThis,'fetch',()=>{throw Error('Offline audit must not contact a server');});
  const report=await auditPackageStatus({root:f.root,registry,trust,offline:true});
  assert.equal(report.verified_signature,true);assert.equal(report.source,'cache');
  assert.equal(report.packages[0].status,'yanked');assert.equal(report.packages[0].restrictions[0].code,'PackageNameInvalid');
  await assert.rejects(registryPackageStates({registry,trust,readBytes:async()=>Buffer.from(payload+'.'+Buffer.alloc(64).toString('base64url'))}),{code:'RegistrySignatureInvalid'});
  assert.deepEqual(snapshot(f),before);
});

for (const [name, module, code] of [
  ['legacy_team.tools', 'legacy_team.tools', 'PackageNameInvalid'],
  ['legacy.tools', 'other.tools', 'PackageModuleOwnershipMismatch'],
]) test(`historical ${code}: inspect, audit and remove without admitting or executing`, async t => {
  const f = fixture(t, name, module), before = snapshot(f);
  const other = f.install('acme.other', 'acme.other'), otherBefore = readFileSync(join(other, 'touba.package.json'));
  const stable = snapshot(f);
  assert.throws(() => readPackage(f.base), { code });
  assert.throws(() => verifyInstalledPackages(f.root, f.records), { code });
  const refused = await prepareProject({ root: f.root, mode: 'plan' });
  assert.equal(refused.status, 'error');
  assert.ok(refused.diagnostics.some(item => item.code === code));
  assert.ok(refused.diagnostics.some(item => item.package_name === name && item.message.includes('package remove')));
  assert.deepEqual(refused.sources, [], 'unsafe historical inputs must not produce unrelated compilation errors');
  const listed = JSON.parse((await packageCommand(['list', '--root', f.root, '--json'])).text);
  assert.equal(listed.status, 'attention');
  assert.equal(listed.packages[0].name, name);
  assert.equal(listed.packages[0].restrictions[0].code, code);
  const registry = join(f.root, 'registry'); mkdirSync(registry);
  writeFileSync(join(registry, 'index.json'), json({ index_schema_version: 'touba-registry-index-v1', packages: [] }));
  for (const lang of ['fr', 'en']) {
    for (const command of [['list'], ['audit', '--registry', registry]]) {
      const result = await packageCommand([...command, '--root', f.root, '--lang', lang]);
      assert.ok(result.text.includes(`${name}@1.0.0`));
      assert.ok(result.text.includes(`touba package remove ${name}`));
    }
  }
  assert.deepEqual(snapshot(f), stable);
  assert.throws(() => verifyInstalledPackages(f.root, f.records), { code });
  assert.equal(removePackage(name, { root: f.root }).status, 'success');
  assert.equal(existsSync(f.base), false);
  assert.deepEqual(readFileSync(join(other, 'touba.package.json')), otherBefore);
  assert.equal(readPackageWorkspace(f.root).records.length, 1);
  assert.notDeepEqual(snapshot(f), before);
});

test('historical name and foreign exports coexist and are removed by exact identity', async t => {
  const f=fixture(t,'legacy_team.tools','legacy_team.tools');
  const foreign=f.install('legacy.tools','other.tools');
  const healthy=f.install('acme.other','acme.other');
  const foreignBefore=readFileSync(join(foreign,'touba.package.json'));
  const healthyBefore=readFileSync(join(healthy,'touba.package.json'));
  const listed=JSON.parse((await packageCommand(['list','--root',f.root,'--json'])).text);
  assert.equal(listed.packages.length,3);
  assert.equal(listed.packages.find(item=>item.name==='legacy_team.tools').restrictions[0].code,'PackageNameInvalid');
  assert.equal(listed.packages.find(item=>item.name==='legacy.tools').restrictions[0].code,'PackageModuleOwnershipMismatch');
  assert.equal(removePackage('legacy_team.tools',{root:f.root}).status,'success');
  assert.deepEqual(readFileSync(join(foreign,'touba.package.json')),foreignBefore);
  assert.throws(()=>verifyInstalledPackages(f.root,readPackageWorkspace(f.root).records),{code:'PackageModuleOwnershipMismatch'});
  assert.equal(removePackage('legacy.tools',{root:f.root}).status,'success');
  assert.deepEqual(readFileSync(join(healthy,'touba.package.json')),healthyBefore);
  assert.equal(readPackageWorkspace(f.root).records.length,1);
  assert.doesNotThrow(()=>verifyInstalledPackages(f.root,readPackageWorkspace(f.root).records));
});

test('a dependent prevents removal of a historical package', t => {
  const f = fixture(t, 'legacy.tools', 'other.tools');
  f.install('acme.consumer', 'acme.consumer', { 'legacy.tools': '1.0.0' });
  const before = snapshot(f);
  assert.throws(() => removePackage('legacy.tools', { root: f.root }), { code: 'PackageInUse' });
  assert.deepEqual(snapshot(f), before); assert.ok(existsSync(f.base));
});

for (const [kind, expected] of [
  ['tampered', 'PackageIntegrityMismatch'], ['extra', 'PackageUnexpectedFile'],
  ['schema', 'PackageSchemaMismatch'], ['traversal', 'PackagePathInvalid'],
  ['symlink', 'PackageSymlinkForbidden'], ['transaction', 'PackageInstallationIncomplete'],
]) test(`recovery preserves ${kind} checks and leaves the installation unchanged`, async t => {
  const f = fixture(t, 'legacy.tools', 'other.tools');
  const manifest = join(f.base, 'touba.package.json');
  if (kind === 'tampered') writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n');
  if (kind === 'extra') writeFileSync(join(f.base, 'unexpected.txt'), 'not inventoried');
  if (kind === 'symlink') { rmSync(join(f.base, 'src/other/tools.tb')); symlinkSync('/etc/hosts', join(f.base, 'src/other/tools.tb')); }
  if (kind === 'transaction') writeFileSync(join(f.root, '.touba-package-installing'), '{}');
  if (kind === 'schema' || kind === 'traversal') {
    const document = JSON.parse(readFileSync(manifest));
    if (kind === 'schema') document.package_schema_version = 'unknown'; else document.files = ['../outside'];
    writeFileSync(manifest, json(document));
  }
  const before = snapshot(f);
  assert.throws(() => inspectInstalledPackages(f.root, f.records), { code: expected });
  assert.throws(() => removePackage('legacy.tools', { root: f.root }), { code: expected });
  await assert.rejects(packageCommand(['list', '--root', f.root]), { code: expected });
  assert.deepEqual(snapshot(f), before); assert.ok(existsSync(f.base));
});
