import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectPackageSurface } from "../src/package-surface.mjs";
import { newPackage, packPackage, unpackPackage, addPackage } from "../../touba-project/src/packages.mjs";
import { initProject, prepareProject } from "../../touba-project/src/project.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import previewSchema from "../../../contracts/product-surfaces/schemas/touba-project-package-preview-v1.schema.json" with { type: "json" };
import previewV2Schema from "../../../contracts/product-surfaces/schemas/touba-project-package-preview-v2.schema.json" with { type: "json" };
import inventorySchema from "../../../contracts/product-surfaces/schemas/touba-project-packages-v1.schema.json" with { type: "json" };
import removalSchema from "../../../contracts/product-surfaces/schemas/touba-project-package-removal-v1.schema.json" with { type: "json" };
import detailsSchema from '../../../contracts/product-surfaces/schemas/touba-package-details-v1.schema.json' with { type: 'json' };

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-studio-package-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"); mkdirSync(consumer);
  initProject({ root: consumer, language: "javascript" });
  const pkg = newPackage("fixture.echo", { root, publisher: "Fixture", description: "Isolated source check", license: "Apache-2.0", version: "1.0.0" });
  const packed = await packPackage(pkg.path, { output: join(root, "archive.tar.gz") });
  let time = Date.now();
  const surface = createProjectPackageSurface(consumer, { now: () => time });
  t.after(() => surface.close());
  return { surface, root: consumer, archive: packed.output, bytes: readFileSync(packed.output), advance: () => { time += 301000; } };
}

test("client package archive is checked, confirmed once, installed with canonical lock and no grants", async t => {
  const { surface, root, bytes } = await fixture(t);
  const before = readFileSync(join(root, "touba.project.json"));
  const preview = await surface.preview("alice", bytes);
  assert.deepEqual(validateObject(previewSchema, preview), []);
  assert.equal(preview.name, "fixture.echo");
  assert.deepEqual(readFileSync(join(root, "touba.project.json")), before);
  await assert.rejects(surface.apply("bob", preview), { code: "ToubaServePackagePreviewMissing" });
  await assert.rejects(surface.apply("alice", { ...preview, archive_digest: "sha256:forged" }), { code: "ToubaServePackageConflict" });
  const result = await surface.apply("alice", preview);
  assert.equal(result.status, "success");
  const inventory = surface.inventory();
  assert.deepEqual(validateObject(inventorySchema, inventory), []);
  assert.equal(inventory.packages.length, 1);
  assert.equal(inventory.packages[0].name, "fixture.echo");
  const details = await surface.details('fixture.echo');
  assert.deepEqual(validateObject(detailsSchema, details), []);
  assert.equal(details.name, 'fixture.echo'); assert.equal(details.contracts.length, 1);
  await assert.rejects(surface.details('../outside'), { code: 'ToubaServePackageInvalid' });
  await assert.rejects(surface.details('fixture.missing'), { code: 'PackageNotInstalled' });
  assert.match(inventory.packages[0].digest, /^sha256:/);
  const project = JSON.parse(readFileSync(join(root, "touba.project.json")));
  assert.equal(project.grants, undefined);
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackagePreviewMissing" });
});

test('a group of independent upgrades has one owner-bound review and a single final lock', async t => {
  const { surface, root, bytes } = await fixture(t);
  await surface.apply('alice', await surface.preview('alice', bytes));
  const source = join(root, 'author'); mkdirSync(source);
  const archives = [];
  for (const [name, version] of [['fixture.other', '1.0.0'], ['fixture.echo', '1.1.0'], ['fixture.other', '1.1.0']]) {
    const folder = join(source, `${name}-${version}`); mkdirSync(folder);
    const pkg = newPackage(name, { root: folder, publisher: 'Fixture', description: 'Synthetic update', license: 'Apache-2.0', version });
    const packed = await packPackage(pkg.path, { output: join(folder, 'archive.tar.gz') });
    const content = readFileSync(packed.output);
    if (version === '1.0.0') await surface.apply('alice', await surface.preview('alice', content));
    else archives.push(content.toString('base64'));
  }
  const upload = { schema_version: 'touba-package-update-upload-v1', archives };
  const preview = await surface.previewUpdates('alice', upload);
  assert.deepEqual(validateObject(previewSchema, preview), []);
  assert.equal(preview.roots.length, 2); assert.equal(preview.dependency_changes.length, 2);
  assert.deepEqual(surface.inventory().packages.map(row => row.version), ['1.0.0', '1.0.0']);
  await assert.rejects(surface.apply('bob', preview), { code: 'ToubaServePackagePreviewMissing' });
  await assert.rejects(surface.apply('alice', { ...preview, archive_digest: 'sha256:' + '0'.repeat(64) }), { code: 'ToubaServePackageConflict' });
  const result = await surface.apply('alice', preview);
  assert.equal(result.command, 'package update-set'); assert.equal(result.status, 'success');
  assert.equal(Object.hasOwn(result, 'review'), false);
  assert.equal(JSON.stringify(result).includes('touba-package-updates-'), false);
  assert.deepEqual(surface.inventory().packages.map(row => row.version), ['1.1.0', '1.1.0']);
  await assert.rejects(surface.apply('alice', preview), { code: 'ToubaServePackagePreviewMissing' });
  for (const malformed of [{ ...upload, path: '/outside' }, { ...upload, archives: [] }, { ...upload, archives: ['AAAA\n'] }, { ...upload, archives: Array(33).fill('AAAA') }]) {
    await assert.rejects(surface.previewUpdates('alice', malformed), { code: 'ToubaServePackageInvalid' });
  }
});

test('installation previews reuse compatible dependencies and mixed selections use the v2 contract', async t => {
  const { surface, root } = await fixture(t);
  const base = newPackage('fixture.base', { root, publisher: 'Fixture', license: 'MIT', version: '1.0.0' }).path;
  const parent = newPackage('fixture.parent', { root, publisher: 'Fixture', license: 'MIT', version: '1.0.0' }).path;
  await addPackage(base, { root: parent });
  const edit = (path, fields) => { const file = join(path, 'touba.package.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...fields })); };
  edit(parent, { package_schema_version: 'touba-package-v2', dependencies: { 'fixture.base': '>=1.0.0 <2.0.0' } });
  edit(base, { version: '1.1.0' });
  const bytes = async (path, name) => readFileSync((await packPackage(path, { output: join(root, name) })).output);
  const baseBytes = await bytes(base, 'base.tar.gz'), parentBytes = await bytes(parent, 'parent.tar.gz');
  await surface.apply('owner', await surface.preview('owner', baseBytes));
  const single = await surface.preview('owner', parentBytes);
  assert.deepEqual(validateObject(previewSchema, single), []);
  assert.equal(single.packages.find(p => p.name === 'fixture.base').version, '1.1.0');
  surface.cancel('owner', single.id);
  const group = await surface.previewUpdates('owner', { schema_version: 'touba-package-update-upload-v1', archives: [parentBytes, baseBytes].map(b => b.toString('base64')) });
  assert.deepEqual(validateObject(previewV2Schema, group), []);
  assert.deepEqual(group.roots.map(r => r.direction), ['keep', 'add']);
  assert.equal(surface.inventory().packages.length, 1);
  await surface.apply('owner', group);
  assert.equal(surface.inventory().packages.length, 2);
});

test("client package previews refuse malformed archive, stale project, expiry and wrong cancellation owner", async t => {
  const { surface, root, bytes, advance } = await fixture(t);
  await assert.rejects(surface.preview("alice", Buffer.from("not an archive")));
  const preview = await surface.preview("alice", bytes);
  assert.throws(() => surface.cancel("bob", preview.id), { code: "ToubaServePackagePreviewMissing" });
  const config = join(root, "touba.project.json");
  writeFileSync(config, readFileSync(config, "utf8") + "\n");
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackageConflict" });
  assert.equal(surface.cancel("alice", preview.id).status, "cancelled");
  const expired = await surface.preview("alice", bytes); advance();
  await assert.rejects(surface.apply("alice", expired), { code: "ToubaServePackagePreviewMissing" });
  assert.equal(surface.inventory().packages.length, 0);
});

test("removal is reviewed, principal bound, single use and preserves project source", async t => {
  const { surface, root, bytes } = await fixture(t);
  await surface.apply("owner", await surface.preview("owner", bytes));
  const preview = surface.previewRemoval("owner", "fixture.echo");
  assert.deepEqual(validateObject(removalSchema, preview), []);
  assert.equal(surface.inventory().packages.length, 1);
  assert.throws(() => surface.applyRemoval("other", preview), { code: "ToubaServePackagePreviewMissing" });
  await assert.rejects(surface.apply("owner", preview), { code: "ToubaServePackagePreviewMissing" });
  assert.throws(() => surface.applyRemoval("owner", { ...preview, package_digest: "sha256:changed" }), { code: "ToubaServePackageConflict" });
  const project = JSON.parse(readFileSync(join(root, "touba.project.json")));
  assert.equal(surface.applyRemoval("owner", preview).package, "fixture.echo");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "touba.project.json"))).source_roots, project.source_roots);
  assert.equal(surface.inventory().packages.length, 0);
  assert.throws(() => surface.applyRemoval("owner", preview), { code: "ToubaServePackagePreviewMissing" });
});

test("removal refuses stale, expired and tampered installations", async t => {
  const { surface, root, bytes, advance } = await fixture(t);
  await surface.apply("owner", await surface.preview("owner", bytes));
  const stale = surface.previewRemoval("owner", "fixture.echo");
  const config = join(root, "touba.project.json"); writeFileSync(config, readFileSync(config, "utf8") + "\n");
  assert.throws(() => surface.applyRemoval("owner", stale), { code: "ToubaServePackageConflict" });
  surface.cancel("owner", stale.id);
  const expired = surface.previewRemoval("owner", "fixture.echo"); advance();
  assert.throws(() => surface.applyRemoval("owner", expired), { code: "ToubaServePackagePreviewMissing" });
  const tampered = surface.previewRemoval("owner", "fixture.echo");
  writeFileSync(join(root, "packages/fixture.echo/extra.txt"), "unexpected");
  assert.throws(() => surface.applyRemoval("owner", tampered), { code: "PackageUnexpectedFile" });
});

test("local folder installation snapshots only a managed package, checks contracts and locks without publication metadata", async t => {
  const { surface, root, archive } = await fixture(t);
  const folder = unpackPackage(archive, join(root, "unpacked"));
  const target = join(root, "packages", "fixture.echo");
  cpSync(folder, target, { recursive: true });
  const manifestPath = join(target, "touba.package.json"), manifest = JSON.parse(readFileSync(manifestPath));
  delete manifest.publisher; delete manifest.description; delete manifest.license;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(join(root, "touba.project.json"));
  const preview = await surface.previewLocal("alice", "fixture.echo");
  assert.deepEqual(validateObject(previewSchema, preview), []);
  assert.deepEqual(readFileSync(join(root, "touba.project.json")), before);
  await surface.apply("alice", preview);
  assert.equal(surface.inventory().packages[0].name, "fixture.echo");
  assert.deepEqual(readFileSync(manifestPath), Buffer.from(JSON.stringify(manifest)), "the placed source is not rewritten");
});

test("local selection refuses arbitrary paths, directory links and mismatched package identity", async t => {
  const { surface, root, archive } = await fixture(t);
  for (const name of ["../fixture.echo", "/tmp/fixture.echo", "fixture.echo/file", "fixture.echo\\file", ""]) {
    await assert.rejects(surface.previewLocal("alice", name), { code: "ToubaServePackageInvalid" });
  }
  const folder = unpackPackage(archive, join(root, "unpacked"));
  symlinkSync(folder, join(root, "packages", "fixture.link"));
  await assert.rejects(surface.previewLocal("alice", "fixture.link"), { code: "PackageSymlinkForbidden" });
  cpSync(folder, join(root, "packages", "fixture.other"), { recursive: true });
  await assert.rejects(surface.previewLocal("alice", "fixture.other"), { code: "ToubaServePackageInvalid" });
  assert.equal(surface.inventory().packages.length, 0);
});

test("local content changed after preview cannot be installed under the old digest", async t => {
  const { surface, root, archive } = await fixture(t);
  const folder = unpackPackage(archive, join(root, "unpacked"));
  const target = join(root, "packages", "fixture.echo"); cpSync(folder, target, { recursive: true });
  const preview = await surface.previewLocal("alice", "fixture.echo");
  const manifest = join(target, "touba.package.json"); writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
  await assert.rejects(surface.apply("alice", preview), { code: "PackageAlreadyExists" });
  assert.equal(surface.inventory().packages.length, 0);
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackagePreviewMissing" });
});

test("package update preview exposes compiled rights, approval and handlers and retains the consumer floor", async t => {
  const { surface, root } = await fixture(t);
  const authorRoot = join(root, "authors"); mkdirSync(authorRoot);
  const source = newPackage("fixture.approved", { root: authorRoot, publisher: "Fixture", license: "Apache-2.0", description: "Synthetic approved operation", version: "1.0.0" }).path;
  const ref = "tool:fixture.approved/Pay";
  const sourcePath = join(source, "src/fixture/approved.tb");
  const manifestPath = join(source, "touba.package.json");
  const pkg = JSON.parse(readFileSync(manifestPath));
  pkg.exports = { tools: [ref] };
  pkg.handlers = [{ tool: ref, path: "handlers/pay.mjs", protocol: "touba-tool-handler-v1" }];
  writeFileSync(manifestPath, JSON.stringify(pkg)); mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/pay.mjs"), "throw new Error('preview must never execute this handler');\n");
  const declaration = 'module fixture.approved\ntool Pay\n    takes amount as Int\n    gives Int\n';
  writeFileSync(sourcePath, declaration + '    human.approve\n        with role as "controller"\n        with timeout_ms as 60000\n');
  const archive = join(root, "approved.tar.gz");
  await packPackage(source, { output: archive });
  const first = await surface.preview("owner", readFileSync(archive));
  assert.deepEqual(validateObject(previewSchema, first), []);
  assert.equal(first.contracts[0].tools[ref].approval_policy.role, "controller");
  assert.deepEqual(first.contracts[0].handlers, [{ tool: ref, entrypoint: "handlers/pay.mjs" }]);
  await surface.apply("owner", first);
  const configPath = join(root, "touba.project.json");
  mkdirSync(join(root, "src/client"), { recursive: true });
  writeFileSync(join(root, "src/client/main.tb"), 'module client.main\nimport tool Pay from fixture.approved\nstrategy Run\n    takes amount as Int\n    gives Int\n    uses Pay\n    do\n        Pay\n            with amount as amount\n            into result\n        give result\n');
  const config = JSON.parse(readFileSync(configPath));
  config.configuration = { ...config.configuration, binding_fragments: ["bindings.json"] };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(root, "bindings.json"), JSON.stringify({ fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: "fixture.approved" },
    bindings: { [ref]: { handler: { kind: "process", command: process.execPath, args: ["packages/fixture.approved/handlers/pay.mjs"], cwd: "." },
      grants: [], secrets: [], effect_contract: { kind: "none" }, timeout_ms: 5000, max_payload_bytes: 65536 } } }));
  const prepared = await prepareProject({ root, mode: "write", entryRef: "strategy:client.main/Run" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  assert.equal(JSON.parse(readFileSync(configPath)).configuration.tool_policies[ref].role, "controller");
  pkg.version = "1.1.0"; writeFileSync(manifestPath, JSON.stringify(pkg));
  writeFileSync(sourcePath, declaration);
  await packPackage(source, { output: join(root, "updated.tar.gz") });
  const next = await surface.preview("owner", readFileSync(join(root, "updated.tar.gz")));
  assert.equal(next.operation, "update"); assert.equal(next.previous_version, "1.0.0");
  assert.equal(next.contracts[0].tools[ref].approval_policy, undefined);
  assert.deepEqual(validateObject(previewSchema, next), []);
  assert.equal(next.contract_changes[0].before.approval_policy.role, 'controller');
  assert.equal(next.contract_changes[0].after.approval_policy, undefined);
  assert.equal(surface.inventory().packages[0].version, "1.0.0", "preview leaves the old version intact");
  await assert.rejects(surface.apply("other", next), { code: "ToubaServePackagePreviewMissing" });
  await surface.apply("owner", next);
  assert.equal(JSON.parse(readFileSync(configPath)).configuration.tool_policies[ref].role, "controller");
  const plan = await prepareProject({ root, mode: "plan", entryRef: "strategy:client.main/Run" });
  assert.ok(plan.diagnostics.some(item => item.code === "PackageGovernanceReviewRequired"));
  await assert.rejects(surface.apply("owner", next), { code: "ToubaServePackagePreviewMissing" });
});
