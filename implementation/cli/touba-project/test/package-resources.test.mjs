import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { newPackage, addPackage, packPackage } from '../src/packages.mjs';
import { initProject } from '../src/project.mjs';
import { resolvePackageResource } from '../../../runtime/touba-handler-sdk/src/index.mjs';
import { runProcessToolHandler } from '../../../runtime/touba-runtime/src/handler-protocol.mjs';

const sdk = fileURLToPath(new URL('../../../runtime/touba-python-sdk/src', import.meta.url));
const python = `import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom touba_sdk import resolve_package_resource,PackageDependencyError\ntry:\n print(json.dumps({'path':str(resolve_package_resource(*sys.argv[2:]))}))\nexcept PackageDependencyError as e:\n print(json.dumps({'code':e.code}))\n`;
function both(manifest, name, resource) {
  let js;
  try { js = { path: resolvePackageResource(pathToFileURL(manifest), name, resource) }; }
  catch (error) { js = { code: error.code }; }
  const result = spawnSync('python3', ['-B', '-c', python, sdk, manifest, name, resource], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), js);
  return js;
}

for (const schema of ['touba-package-v1', 'touba-package-v2']) test(`${schema}: JS/Python resolve declared resources from author, archive and relocated consumer with the same integrity refusals`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-dependency-resources-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = newPackage('fixture.shared', { root, publisher: 'Fixture', license: 'MIT' }).path;
  mkdirSync(join(shared, 'helpers'));
  writeFileSync(join(shared, 'helpers/value.mjs'), 'export const value = "shared";\n');
  writeFileSync(join(shared, 'helpers/value.py'), 'value = "shared"\n');
  const manifest = join(shared, 'touba.package.json'), document = JSON.parse(readFileSync(manifest));
  document.files.push('helpers'); writeFileSync(manifest, JSON.stringify(document));
  const owner = newPackage('fixture.owner', { root, publisher: 'Fixture', license: 'MIT' }).path;
  await addPackage(shared, { root: owner });
  if (schema === 'touba-package-v2') {
    const path = join(owner, 'touba.package.json'), document = JSON.parse(readFileSync(path));
    document.package_schema_version = schema;
    document.dependencies['fixture.shared'] = '>=0.1.0 <2.0.0';
    writeFileSync(path, JSON.stringify(document));
  }
  for (const resource of ['helpers/value.mjs', 'helpers/value.py']) {
    assert.equal(both(join(owner, 'touba.package.json'), 'fixture.shared', resource).path, join(owner, 'packages/fixture.shared', resource));
  }
  const archive = join(root, 'owner.tar.gz'); await packPackage(owner, { output: archive });
  let app = join(root, 'consumer'); initProject({ root: app });
  await addPackage(archive, { root: app });
  renameSync(app, join(root, 'relocated')); app = join(root, 'relocated');
  const ownManifest = join(app, 'packages/fixture.owner/touba.package.json');
  const target = join(app, 'packages/fixture.shared/helpers/value.mjs');
  const result = both(ownManifest, 'fixture.shared', 'helpers/value.mjs');
  assert.equal(result.path, target);
  assert.equal((await import(pathToFileURL(result.path))).value, 'shared');
  assert.equal(both(ownManifest, 'fixture.unknown', 'helpers/value.mjs').code, 'PackageDependencyUndeclared');
  assert.equal(both(ownManifest, 'fixture.shared', '../app.env').code, 'PackageResourceUndeclared');
  assert.equal(both(ownManifest, 'fixture.shared', 'not-exported.txt').code, 'PackageResourceUndeclared');
  const original = readFileSync(target);
  writeFileSync(target, 'altered');
  assert.equal(both(ownManifest, 'fixture.shared', 'helpers/value.mjs').code, 'PackageIntegrityMismatch');
  writeFileSync(target, original);
  const marker = join(app, '.touba-package-installing'); writeFileSync(marker, '{}');
  assert.equal(both(ownManifest, 'fixture.shared', 'helpers/value.mjs').code, 'PackageInstallationIncomplete');
  rmSync(marker);
  const lockPath = join(app, 'touba.packages.lock.json'), originalLock = readFileSync(lockPath);
  const lock = JSON.parse(originalLock);
  lock.packages.find(pkg => pkg.name === 'fixture.shared').version = '9.9.9';
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.equal(both(ownManifest, 'fixture.shared', 'helpers/value.mjs').code, 'PackageDependencyMissing');
  writeFileSync(lockPath, originalLock);
  if (process.platform !== 'win32') {
    renameSync(target, target + '.retained'); symlinkSync(target + '.retained', target);
    assert.equal(both(ownManifest, 'fixture.shared', 'helpers/value.mjs').code, 'PackageSymlinkForbidden');
    rmSync(target); renameSync(target + '.retained', target);
  }
  assert.equal(both(ownManifest, 'fixture.shared', 'helpers/value.mjs').path, target);
  if (process.platform === 'darwin') {
    const secret = join(app, 'private.env'); writeFileSync(secret, 'synthetic-private-data');
    const resolver = fileURLToPath(new URL('../../../runtime/touba-handler-sdk/src/package-resources.mjs', import.meta.url));
    const nodeHandler = join(app, 'read.mjs');
    writeFileSync(nodeHandler, `import {resolvePackageResource} from ${JSON.stringify(pathToFileURL(resolver).href)};
import {readFileSync} from 'node:fs';
const path=resolvePackageResource(${JSON.stringify(ownManifest)},'fixture.shared','helpers/value.mjs');
let denied=false;try{readFileSync(${JSON.stringify(secret)});}catch{denied=true;}
process.stdout.write(JSON.stringify({ok:true,value:denied&&readFileSync(path,'utf8').includes('shared')}));`);
    const lockedFiles = JSON.parse(readFileSync(lockPath)).packages.flatMap(pkg => pkg.files.map(file => join(app, 'packages', pkg.name, file.path)));
    const run = (handler, command, code) => runProcessToolHandler({ toolRef: 'tool:fixture.test/Read', secretHandles: [], request: { arguments: {} },
      binding: { handler: { command, args: [handler], cwd: app }, grants: [], secrets: [],
        sandbox: { required: true, code_paths: [...lockedFiles, lockPath, ...code] },
        limits: { timeout_ms: 10000, max_payload_bytes: 16384 } } });
    const constraints = fileURLToPath(new URL('../../../runtime/touba-handler-sdk/src/package-constraints.mjs', import.meta.url));
    assert.equal((await run(nodeHandler, process.execPath, [resolver, constraints])).value, true);
    // Removing the reviewed dependency inventory does not gain access through
    // the resolver. The whole project directory is never granted.
    await assert.rejects(runProcessToolHandler({ toolRef: 'tool:fixture.test/Read', secretHandles: [], request: { arguments: {} },
      binding: { handler: { command: process.execPath, args: [nodeHandler], cwd: app }, grants: [], secrets: [],
        sandbox: { required: true, code_paths: [resolver] }, limits: { timeout_ms: 10000, max_payload_bytes: 16384 } } }));

    const probe = spawnSync('python3', ['-I', '-S', '-c', 'import sys,sysconfig,json;print(json.dumps([sys.executable,sys.base_prefix,sysconfig.get_path("stdlib")]))'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const [interpreter, base, stdlib] = JSON.parse(probe.stdout), pythonCode = [];
    function inventory(directory) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (['__pycache__', 'site-packages', 'test', 'tests'].includes(item.name)) continue;
        const path = join(directory, item.name);
        if (item.isDirectory()) inventory(path);
        else if (item.isFile() && /\.(py|so|dylib)$/.test(item.name)) pythonCode.push(path);
      }
    }
    inventory(stdlib);
    pythonCode.push(join(base, 'Python'), join(base, 'Resources/Python.app/Contents/MacOS/Python'), join(sdk, 'touba_sdk/package_resources.py'));
    const pythonHandler = join(app, 'read.py');
    writeFileSync(pythonHandler, `import sys,json\nsys.path.insert(0,${JSON.stringify(join(sdk, 'touba_sdk'))})\nfrom package_resources import resolve_package_resource\npath=resolve_package_resource(${JSON.stringify(ownManifest)},'fixture.shared','helpers/value.py')\ndenied=False\ntry:\n open(${JSON.stringify(secret)},'rb').read()\nexcept PermissionError:\n denied=True\nprint(json.dumps({'ok':True,'value':denied and 'shared' in path.read_text()}))\n`);
    assert.equal((await run(pythonHandler, interpreter, pythonCode)).value, true);
  }
});
