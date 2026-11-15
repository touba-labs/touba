import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newPackage, testPackage, versionPackage } from "../src/package-author.mjs";
import { PACKAGE_RUNTIME_VERSION, packageSlug, readPackage, validatePackageDocument } from "../src/package-contract.mjs";
import semver from "semver";
import { addPackage, checkPackage, checkPackageArchive, packPackage, snapshotPackage, unpackPackage, removePackage } from "../src/packages.mjs";
import { readPackageWorkspace, verifyInstalledPackages } from "../src/package-store.mjs";
import { initProject, prepareProject } from "../src/project.mjs";
import { publishPackage } from "../src/package-publish.mjs";
import { publishRemotePackage } from "../src/package-publish-remote.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
function workspace(t) { const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-author-"))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function command(cwd, ...args) { return spawnSync(process.execPath, [cli, "package", ...args], { cwd, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 }); }
function edit(root, fn) { const file = join(root, "touba.package.json"), data = JSON.parse(readFileSync(file)); fn(data); writeFileSync(file, JSON.stringify(data)); }

test('new packages opt into the candidate without weakening existing compatibility ranges', t => {
  const pkg = newPackage('fixture.candidate', { root: workspace(t) });
  const document = readPackage(pkg.path).document;
  assert.equal(document.touba.runtime_compatibility,
    semver.prerelease(PACKAGE_RUNTIME_VERSION) ? PACKAGE_RUNTIME_VERSION : '>=1.0.0 <2.0.0');
  validatePackageDocument(document, { runtimeVersion: PACKAGE_RUNTIME_VERSION });
  const stable = structuredClone(document); stable.touba.runtime_compatibility = '>=1.0.0 <2.0.0';
  assert.throws(() => validatePackageDocument(stable, { runtimeVersion: '1.5.0-rc.1' }), error => {
    assert.equal(error.code,'PackageVersionIncompatible');
    assert.ok(error.message.includes(`${stable.name}@${stable.version}`));
    assert.match(error.message,/requires Touba >=1.0.0 <2.0.0; installed 1.5.0-rc.1; prereleases require explicit compatibility/);
    return true;
  });
  validatePackageDocument(stable, { runtimeVersion: '1.4.0' });
});

test('French starter preserves the supplied purpose and a runnable translated example', async t => {
  const root = workspace(t);
  const created = newPackage('fixture.fr', { root, lang: 'fr', description: 'Vérifier des échéances.', publisher: 'Fixture', license: 'MIT' });
  const readme = readFileSync(join(created.path, 'README.md'), 'utf8');
  assert.match(readme, /Vérifier des échéances/); assert.match(readme, /exemple de départ/);
  assert.match(readFileSync(join(created.path, 'src/fixture/fr.tb'), 'utf8'), /Renvoyer le texte fourni/);
  assert.equal((await checkPackage(created.path)).status, 'success');
  assert.throws(() => newPackage('fixture.bad', { root, lang: 'bad' }), { code: 'PackageLanguageInvalid' });
  assert.equal(existsSync(join(root, 'bad')), false);
});

test('new publications reject Python bytecode without changing legacy installed inventories', async t => {
  const root = workspace(t), pkg = newPackage('fixture.clean', { root, publisher: 'Fixture', license: 'MIT' });
  const cache = join(pkg.path, 'src', '__pycache__'); mkdirSync(cache);
  writeFileSync(join(cache, 'handler.cpython-314.pyc'), 'synthetic-cache');
  const original = readPackage(pkg.path);
  assert.ok(original.files.some(file => file.path.endsWith('.pyc')));
  assert.throws(() => readPackage(pkg.path, { publishing: true }), { code: 'PackageGeneratedFileForbidden' });
  await assert.rejects(packPackage(pkg.path, { output: join(root, 'forbidden.tar.gz') }), { code: 'PackageGeneratedFileForbidden' });
  assert.equal(existsSync(join(root, 'forbidden.tar.gz')), false);
  assert.equal(readPackage(pkg.path).digest, original.digest);
});

test('generated test helper accepts reviewed tool decisions without changing the author project', async t => {
  const root = workspace(t), pkg = newPackage('fixture.toolbox', { root });
  const ref = 'tool:fixture.toolbox/Read';
  edit(pkg.path, manifest => {
    manifest.exports = { strategies: ['strategy:fixture.toolbox/Run'], tools: [ref] };
    manifest.handlers = [{ tool: ref, path: 'handlers/read.mjs', protocol: 'touba-tool-handler-v1', effect_contract: { kind: 'none' } }];
  });
  mkdirSync(join(pkg.path, 'handlers'));
  writeFileSync(join(pkg.path, 'handlers/read.mjs'), `for await (const chunk of process.stdin) {}\nprocess.stdout.write(JSON.stringify({ok:true,value:'Package contract'}));\n`);
  writeFileSync(join(pkg.path, 'src/fixture/toolbox.tb'), `module fixture.toolbox
tool Read
    gives Text
strategy Run
    takes value as Text
    gives Text
    uses Read
    do
        Read
            into result
        give result
`);
  const testFile = join(pkg.path, 'tests/echo.test.mjs');
  const template = readFileSync(testFile, 'utf8');
  const decisions = { bindings: { [ref]: { package_handler: 'fixture.toolbox', effect_contract: { kind: 'none' } } } };
  writeFileSync(testFile, template.replace('skill:fixture.toolbox/Echo', 'strategy:fixture.toolbox/Run')
    .replace('{ value: "Package contract" });', `{ value: "Package contract" }, ${JSON.stringify({ hostDecisions: decisions, effectJournal: true })});`));
  const before = readPackage(pkg.path).digest;
  const report = await testPackage(pkg.path);
  assert.equal(report.status, 'success', report.stdout + report.stderr);
  assert.equal(readPackage(pkg.path).digest, before);
  assert.equal(existsSync(join(pkg.path, 'touba.project.json')), false);
  assert.equal(existsSync(join(pkg.path, 'effects.effect-journal.sqlite')), false);
});

test("Cloud presentation can follow packing, while direct publication requires a README", async t => {
  const root = workspace(t), pkg = newPackage("acme.presentation", { root, publisher: "Acme", license: "MIT" });
  edit(pkg.path, manifest => { delete manifest.readme; });
  const checked = await checkPackage(pkg.path, { publishing: true });
  assert.equal(checked.publishing.ready, true);
  const packed = await packPackage(pkg.path, { output: join(root, 'package.tar.gz') });
  assert.equal(packed.status, 'success');
  await assert.rejects(publishPackage(pkg.path, { registry: join(root, 'registry') }), { code: 'PackagePresentationRequired' });
  await assert.rejects(publishRemotePackage(pkg.path, { registry: 'http://127.0.0.1:4180/registry' }), { code: 'PackagePresentationRequired' });
});

test("author identity normalizes spaces, keeps organization scope and creates the short directory", async t => {
  const root = workspace(t);
  const result = command(root, "new", " Gestion  factures ", "--org", " Atelier Nord ", "--description", "Invoice checks", "--license", "MIT", "--yes", "--json");
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout);
  assert.equal(created.path, join(root, "gestion-factures"));
  const pkg = readPackage(created.path);
  assert.equal(pkg.document.name, "atelier-nord.gestion-factures");
  assert.equal(pkg.document.publisher, "Atelier Nord");
  assert.equal(pkg.document.exports.skills[0], "skill:atelier_nord.gestion_factures/Echo");
  assert.ok(existsSync(join(created.path, "packages")));
  assert.equal((await checkPackage(created.path)).publishing.ready, true);
  const tested = await testPackage(created.path);
  assert.equal(tested.status, "success", JSON.stringify(tested));
  assert.equal(tested.tests, 1);
  assert.equal(existsSync(join(created.path, "touba.project.json")), false);
  assert.equal(existsSync(join(created.path, ".touba")), false);
  assert.equal((await testPackage(created.path)).status, "success");
  assert.equal(readPackageWorkspace(created.path).author, true);
  const archive = await packPackage(undefined, { root: join(created.path, "src") });
  assert.equal(archive.output, join(created.path, "dist/atelier-nord.gestion-factures-0.1.0.tar.gz"));
  await assert.rejects(packPackage(created.path), { code: "PackageAlreadyExists" });
  assert.throws(() => newPackage("gestion-factures", { root, org: "Atelier Sud" }), { code: "PackageAlreadyExists" });
});

test("names cannot escape, use reserved paths or silently discard punctuation", t => {
  const root = workspace(t);
  for (const name of ["../escape", "a/b", "a\\b", "", "a--b", "packages", "CON", "billing@1", "x".repeat(81)]) assert.throws(() => newPackage(name, { root, org: "acme" }));
  assert.equal(packageSlug("  Billing   tools "), "billing-tools");
  assert.equal(existsSync(join(root, "packages")), false);
  const noOrg = command(root, "new", "facturation", "--yes", "--json");
  assert.equal(noOrg.status, 2); assert.equal(JSON.parse(noOrg.stdout).diagnostics[0].code, "PackageOrganizationRequired");
  assert.equal(noOrg.stderr, "");
  assert.equal(command(root, "new", "acme.a", "--org", "x", "--org", "y").status, 2);
  assert.equal(command(root, "new", "acme.a", "--unexpected").status, 2);
});

test("accented labels compose a portable identity and a package-specific context", t => {
  const pkg = newPackage("Été à Québec", { root: workspace(t), org: "Équipe Nord", context: true });
  const { document } = readPackage(pkg.path);
  assert.equal(document.name, "equipe-nord.ete-a-quebec");
  assert.equal(document.contexts[0].id, "ete-a-quebec");
});

test("transitive installed dependencies can be listed, checked and prepared in author and consumer projects", async t => {
  const root = workspace(t), base = newPackage("acme.base", { root }), mid = newPackage("acme.mid", { root });
  const childFile = join(base.path, "src/acme/base.tb");
  writeFileSync(childFile, readFileSync(childFile, "utf8").replace("skill Echo", "skill BaseEcho"));
  edit(base.path, m => { m.exports.skills = ["skill:acme.base/BaseEcho"]; });
  await addPackage(base.path, { root: mid.path });
  writeFileSync(join(mid.path, "src/acme/mid.tb"), `module acme.mid
import skill BaseEcho from acme.base
skill Echo
    description "Return the text through the declared dependency."
    takes value as Text
    gives Text
    uses BaseEcho
    do
        BaseEcho
            with value as value
            into answer
        give answer
`);
  // No prior preparation may hide missing distribution metadata.
  const tested = await testPackage(mid.path);
  assert.equal(tested.status, "success", JSON.stringify(tested));
  const archive = await snapshotPackage(mid.path, { output: join(root, 'composed.tar.gz') });
  assert.equal((await checkPackageArchive(archive.output)).status, 'success');
  const extracted = unpackPackage(archive.output, join(root, 'fresh'));
  assert.equal((await testPackage(extracted)).status, 'success');
  const app = join(root, "consumer"); initProject({ root: app });
  await addPackage(archive.output, { root: app });
  assert.equal(existsSync(join(app, 'packages/acme.mid/touba.packages.lock.json')), false);
  for (const action of ["list", "check"]) {
    const result = command(app, action, "--json");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).packages.map(p => p.name).sort(), ["acme.base", "acme.mid"]);
  }
});

test('test distribution ignores author residue and never modifies author manifests', async t => {
  const root = workspace(t), pkg = newPackage('fixture.pristine', { root });
  const manifest = readFileSync(join(pkg.path, 'touba.package.json'));
  writeFileSync(join(pkg.path, 'residue.txt'), 'not distributed');
  writeFileSync(join(pkg.path, 'tests/echo.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
test('only distributed inputs', () => { assert.equal(existsSync('residue.txt'), false); assert.equal(existsSync('touba.project.json'), false); writeFileSync('touba.project.json', '{}'); });`);
  for (let i = 0; i < 2; i++) assert.equal((await testPackage(pkg.path)).status, 'success');
  assert.deepEqual(readFileSync(join(pkg.path, 'touba.package.json')), manifest);
  assert.equal(existsSync(join(pkg.path, 'touba.project.json')), false);
});

test('author lock keeps transitive packages without turning them into direct dependencies', async t => {
  const root = workspace(t);
  const leaf = newPackage('fixture.leaf', { root, context: true });
  const middle = newPackage('fixture.middle', { root, context: true });
  const top = newPackage('fixture.top', { root, context: true });
  await addPackage(leaf.path, { root: middle.path });
  await addPackage(middle.path, { root: top.path });
  assert.deepEqual(readPackage(top.path).document.dependencies, { 'fixture.middle': '0.1.0' });
  assert.equal(verifyInstalledPackages(top.path, readPackageWorkspace(top.path).records).packages.length, 2);
  const archive = await snapshotPackage(top.path, { output: join(root, 'top.tar.gz') });
  assert.equal((await checkPackageArchive(archive.output)).packages.length, 3);
  const app = join(root, 'app'); initProject({ root: app });
  await addPackage(archive.output, { root: app });
  assert.equal(command(app, 'list', '--json').status, 0);
  removePackage('fixture.middle', { root: top.path });
  assert.deepEqual(readPackage(top.path).document.dependencies, {});
  assert.equal(command(top.path, 'list', '--json').status, 0);
});

test('generated tests support multiple exported entries without freezing the author project', async t => {
  const root = workspace(t), pkg = newPackage('fixture.multientry', { root });
  const source = join(pkg.path, 'src/fixture/multientry.tb');
  const content = readFileSync(source, 'utf8');
  writeFileSync(source, content + '\n' + content.slice(content.indexOf('skill Echo')).replace('skill Echo', 'skill Second'));
  edit(pkg.path, manifest => manifest.exports.skills.push('skill:fixture.multientry/Second'));
  const tests = join(pkg.path, 'tests/echo.test.mjs');
  writeFileSync(tests, readFileSync(tests, 'utf8') + `\ntest('Second is independently prepared', () => {
    const result = runEntry('skill:fixture.multientry/Second', { value: 'second entry' });
    assert.equal(result.status, 'success'); assert.equal(result.result, 'second entry');
  });\n`);
  const before = readPackage(pkg.path).digest;
  const tested = await testPackage(pkg.path);
  assert.equal(tested.status, 'success', JSON.stringify(tested));
  assert.equal(tested.tests, 2);
  assert.equal(readPackage(pkg.path).digest, before);
  for (const file of ['touba.project.json', '.touba', 'handlers']) assert.equal(existsSync(join(pkg.path, file)), false);
});

test('transport locks cannot silently replace inventoried locks or ignore tampered dependency digests', async t => {
  const root = workspace(t), leaf = newPackage('fixture.lockleaf', { root, context: true });
  const parent = newPackage('fixture.lockparent', { root, context: true });
  await addPackage(leaf.path, { root: parent.path });
  edit(parent.path, manifest => manifest.files.push('touba.packages.lock.json'));
  await assert.rejects(snapshotPackage(parent.path, { output: join(root, 'bad-lock.tar.gz') }), { code: 'PackageLockDistributionConflict' });
  assert.equal(existsSync(join(root, 'bad-lock.tar.gz')), false);
  edit(parent.path, manifest => { manifest.files = manifest.files.filter(file => file !== 'touba.packages.lock.json'); });
  const lockPath = join(parent.path, 'touba.packages.lock.json');
  const lock = JSON.parse(readFileSync(lockPath));
  lock.packages[0].digest = 'sha256:' + '0'.repeat(64);
  writeFileSync(lockPath, JSON.stringify(lock));
  await assert.rejects(snapshotPackage(parent.path, { output: join(root, 'tampered.tar.gz') }), { code: 'PackageIntegrityMismatch' });
  assert.equal(existsSync(join(root, 'tampered.tar.gz')), false);
});

test("package checks reject absent resources and unresolved execution links without raw paths", async t => {
  const root = workspace(t), pkg = newPackage("acme.context", { root, context: true });
  edit(pkg.path, m => { m.contexts[0].procedure = "missing.md"; });
  const missing = command(pkg.path, "check", "--json");
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).diagnostics[0].code, "PackageFileMissing");
  assert.ok(!missing.stdout.includes(root));
  edit(pkg.path, m => { m.contexts[0].procedure = "SKILL.md"; m.contexts[0].execution_links = [{ label: "Missing", description: "Review the item.", target_ref: "skill:acme.context/Missing" }]; });
  await assert.rejects(checkPackage(pkg.path), /PackageContextTargetMissing/);
  edit(pkg.path, m => { m.contexts[0].execution_links[0].target_ref = "skill:consumer/Review"; });
  await checkPackage(pkg.path); // Verified later against the consumer AIR, not invented here.
});

test("version is canonical, monotone, local and discoverable from a subdirectory", t => {
  const root = workspace(t), pkg = newPackage("acme.billing", { root });
  assert.equal(versionPackage("patch", { root: join(pkg.path, "src") }).version, "0.1.1");
  assert.equal(versionPackage("minor", { root: pkg.path }).version, "0.2.0");
  assert.equal(versionPackage("major", { root: pkg.path }).version, "1.0.0");
  assert.equal(versionPackage("2.1.0", { root: pkg.path }).version, "2.1.0");
  for (const value of ["2.1.0", "1.0.0", "latest", "^3.0.0", "v3.0.0"]) assert.throws(() => versionPackage(value, { root: pkg.path }), { code: "PackageVersionInvalid" });
  assert.equal(readPackage(pkg.path).document.name, "acme.billing");
  assert.equal(command(pkg.path, "version", "--json").status, 2);
  assert.equal(existsSync(join(pkg.path, ".git")), false);
  writeFileSync(join(pkg.path, ".touba-package-installing"), "active");
  assert.throws(() => versionPackage("patch", { root: pkg.path }), /EEXIST/);
  assert.equal(readPackage(pkg.path).document.version, "2.1.0");
});

test("tests execute real assertions, expose failures and absence, and require selected environment", async t => {
  const root = workspace(t), pkg = newPackage("acme.tests", { root });
  const path = join(pkg.path, "tests/echo.test.mjs");
  writeFileSync(path, 'import test from "node:test"; import assert from "node:assert/strict"; test("failure", () => assert.equal(1, 2));');
  assert.equal((await testPackage(pkg.path)).status, "error");
  writeFileSync(path, "// No tests yet\n");
  assert.equal((await testPackage(pkg.path)).status, "error");
  writeFileSync(path, 'import test from "node:test"; test.skip("not implemented", () => {});');
  assert.equal((await testPackage(pkg.path)).status, "error");
  const key = "TOUBA_PACKAGE_TEST_SECRET"; process.env[key] = "test-only-secret-value";
  t.after(() => delete process.env[key]);
  writeFileSync(path, `import test from "node:test"; import assert from "node:assert/strict"; test("explicit environment", () => { assert.equal(process.env.${key}, undefined); });`);
  assert.equal((await testPackage(pkg.path)).status, "success");
  writeFileSync(path, `import test from "node:test"; import assert from "node:assert/strict"; test("explicit environment", () => { assert.equal(process.env.${key}, "test-only-secret-value"); console.log(process.env.${key}); });`);
  const selected = await testPackage(pkg.path, { env: [key] });
  assert.equal(selected.status, "success"); assert.ok(!selected.stdout.includes("test-only-secret-value"));
  await assert.rejects(testPackage(pkg.path, { env: ["NODE_OPTIONS"] }), { code: "PackageTestEnvironmentInvalid" });
  edit(pkg.path, m => { delete m.contract_tests; });
  assert.equal((await testPackage(pkg.path)).status, "no_tests");
  assert.equal(command(pkg.path, "test", "--json").status, 1);
  const context = newPackage("acme.context", { root, context: true });
  assert.equal((await testPackage(context.path)).status, "no_tests");
});

test("managed dependencies work in author projects and applications without parent paths", async t => {
  const root = workspace(t), dependency = newPackage("other.data", { root }), author = newPackage("acme.app", { root });
  await addPackage(dependency.path, { root: join(author.path, "src") });
  assert.equal(readPackage(author.path).document.dependencies["other.data"], "0.1.0");
  assert.equal((await checkPackage(author.path)).packages.length, 2);
  assert.equal(JSON.parse(command(join(author.path, "src"), "list", "--json").stdout).packages[0].name, "other.data");
  removePackage("other.data", { root: join(author.path, "src") });
  assert.deepEqual(readPackage(author.path).document.dependencies, {});
  const project = join(root, "consumer"); initProject({ root: project });
  const manual = join(project, "packages/other.data"); cpSync(dependency.path, manual, { recursive: true });
  await addPackage("other.data", { root: join(project, "src") });
  assert.equal(command(join(project, "src"), "check", "--json").status, 0);
  assert.throws(() => versionPackage("patch", { root: manual }), { code: "PackageInstalledReadOnly" });
  await assert.rejects(testPackage(manual), { code: "PackageInstalledReadOnly" });
  edit(manual, m => { m.publisher = "Test"; m.license = "MIT"; });
  await assert.rejects(packPackage(manual), { code: "PackageInstalledReadOnly" });
  writeFileSync(join(manual, "extra.txt"), "undeclared");
  assert.equal(command(join(project, "src"), "check").status, 2);
});

test("packages is reserved at the root, including case aliases and dangling links", t => {
  const root = workspace(t);
  for (const [index, kind] of ["file", "case", "link"].entries()) {
    const project = join(root, String(index)); mkdirSync(project);
    if (kind === "file") writeFileSync(join(project, "packages"), "business data");
    if (kind === "case") mkdirSync(join(project, "Packages"));
    if (kind === "link") symlinkSync(join(root, "absent"), join(project, "packages"), "dir");
    assert.throws(() => initProject({ root: project }), { code: kind === "file" ? "PackageDirectoryRequired" : kind === "case" ? "PackagePathCollision" : "PackageSymlinkForbidden" });
    assert.equal(existsSync(join(project, "touba.project.json")), false);
  }
});
