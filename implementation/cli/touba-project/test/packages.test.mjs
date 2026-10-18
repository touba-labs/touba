import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { newPackage, checkPackage, packPackage, addPackage, addRegistryPackage, unpackPackage, removePackage } from "../src/packages.mjs";
import { PACKAGE_MANIFEST, packageDigest, readPackage } from "../src/package-contract.mjs";
import { PACKAGE_LOCK, verifyInstalledPackages } from "../src/package-store.mjs";
import { initProject, prepareProject, compilerInputsForFile, resolveProjectRunArgs } from "../src/project.mjs";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
function workspace(t) { const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-unified-package-"))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function manifest(path, edit) { const file = join(path, PACKAGE_MANIFEST); const value = JSON.parse(readFileSync(file)); edit(value); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
function author(root, name = "example.echo", options = {}) { const pkg = newPackage(name, { root, ...options }); manifest(pkg.path, m => { m.publisher = "Package test author"; m.license = "MIT"; }); return pkg.path; }
function consumer(root) { const path = join(root, "consumer"); mkdirSync(path); initProject({ root: path }); return path; }

test("real compiler, archive, isolated install, typed import and runtime execution", async t => {
  const root = workspace(t), source = author(root), project = consumer(root);
  const archive = join(root, "echo.tar.gz");
  await packPackage(source, { output: archive });
  await addPackage(archive, { root: project });
  await addPackage(archive, { root: project }); // exact idempotent install
  mkdirSync(join(project, "src/client"), { recursive: true });
  const program = join(project, "src/client/main.tb");
  writeFileSync(program, `module client.main
import skill Echo from example.echo
strategy Run
    takes request as Text
    gives Text
    uses Echo
    do
        Echo
            with value as request
            into reply
        give reply
`);
  const prepared = await prepareProject({ root: project, mode: "write", entryRef: "strategy:client.main/Run" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  assert.equal(existsSync(join(project, "touba.manifest.json")), false);
  assert.equal(compilerInputsForFile(program).diagnostics.length, 0);
  assert.ok(resolveProjectRunArgs(["--project", project]).includes("--run-plan"));
  const engine = new ToubaEngine({ projectRoot: project, command: process.execPath, commandArgs: [cli] });
  const result = await engine.run({ air: ".touba/build/dev/air/client/main.air.json", inputs: { request: "Package import works" } });
  assert.equal(result.result, "Package import works");
  const directManifest = join(project, "direct.manifest.json");
  writeFileSync(directManifest, JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {} }));
  writeFileSync(join(project, "packages/example.echo/src/example/echo.tb"), "module example.echo\n");
  const refused = await prepareProject({ root: project, mode: "plan" });
  assert.ok(refused.diagnostics.some(d => d.code === "PackageIntegrityMismatch"));
  assert.ok(compilerInputsForFile(program).diagnostics.some(d => d.code === "PackageIntegrityMismatch"));
  const direct = spawnSync(process.execPath, [cli, "run", join(project, ".touba/build/dev/air/client/main.air.json"),
    "--manifest", directManifest, "--inputs-json", JSON.stringify({ request: "denied" }), "--output", "json"], { encoding: "utf8" });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /PackageIntegrityMismatch/);
});

test("a manually copied unregistered package gives a registration hint and is never loaded implicitly", async t => {
  const root = workspace(t), source = author(root), project = consumer(root);
  cpSync(source, join(project, "packages/example.echo"), { recursive: true });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main
import skill Echo from example.echo
strategy Run
    gives Text
    do
        Echo
            with value as "registered"
            into result
        give result
`);
  const before = await prepareProject({ root: project, mode: "plan", entryRef: "strategy:client.main/Run" });
  const diagnostic = before.diagnostics.find(item => item.code === "ImportModuleNotFound");
  assert.ok(diagnostic, JSON.stringify(before));
  assert.match(diagnostic.message, /touba package add/);
  await addPackage("example.echo", { root: project });
  const after = await prepareProject({ root: project, mode: "write", entryRef: "strategy:client.main/Run" });
  assert.equal(after.status, "success", JSON.stringify(after.diagnostics));
});

test("package handler selection is explicit, grants nothing and avoids unused stubs", async t => {
  const root = workspace(t), source = author(root, "example.connector"), project = consumer(root);
  writeFileSync(join(source, "src/example/connector.tb"), `module example.connector
tool Fetch
    takes value as Text
    gives Text
    requires network
`);
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/fetch.mjs"), `let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ ok: true, value: request.arguments.value }));
`);
  manifest(source, m => { m.exports = { tools: ["tool:example.connector/Fetch"] };
    m.handlers = [{ tool: "tool:example.connector/Fetch", path: "handlers/fetch.mjs", protocol: "touba-tool-handler-v1" }]; });
  await addPackage(source, { root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main
import tool Fetch from example.connector
strategy Run
    takes value as Text
    gives Text
    uses Fetch
    do
        Fetch
            with value as value
            into result
        give result
`);
  const options = { root: project, entryRef: "strategy:client.main/Run",
    hostDecisions: { bindings: { "tool:example.connector/Fetch": { package_handler: "example.connector" } } } };
  const plan = await prepareProject({ ...options, mode: "plan" });
  assert.ok(plan.actions.some(action => action.field === "handler"));
  assert.equal(existsSync(join(project, ".touba/build/dev/touba.manifest.json")), false);
  const prepared = await prepareProject({ ...options, mode: "write" });
  assert.notEqual(prepared.status, "error", JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.diagnostics.some(d => d.code === "ManifestGrantMissing"));
  const file = join(project, ".touba/build/dev/touba.manifest.json");
  const saved = JSON.parse(readFileSync(file));
  const binding = saved.bindings["tool:example.connector/Fetch"];
  assert.deepEqual(binding.grants, []);
  assert.deepEqual(binding.handler.args, ["packages/example.connector/handlers/fetch.mjs"]);
  assert.equal(prepared.actions.some(action => action.artifact_kind === "handler_stub" || action.kind === "create_handler_stub"), false);
  assert.equal(existsSync(join(project, "handlers/example/connector/fetch.handler.mjs")), false);
  const before = readFileSync(file, "utf8");
  const refused = await prepareProject({ ...options, mode: "write", hostDecisions: {
    bindings: { "tool:example.connector/Fetch": { package_handler: "not.installed" } } } });
  assert.ok(refused.diagnostics.some(d => d.code === "HostDecisionPackageHandlerUnknown"));
  assert.equal(readFileSync(file, "utf8"), before);
  // Execution still refuses the missing grant; selection is not permission.
  const result = spawnSync(process.execPath, [cli, "run", "--project", project, "--inputs-json", '{"value":"test"}', "--output", "json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  options.hostDecisions.bindings["tool:example.connector/Fetch"].grants = ["network"];
  options.hostDecisions.bindings["tool:example.connector/Fetch"].effect_contract = { kind: "none" };
  assert.equal((await prepareProject({ ...options, mode: "write" })).status, "success");
  const authorized = spawnSync(process.execPath, [cli, "run", "--project", project, "--inputs-json", '{"value":"test"}', "--output", "json"], { encoding: "utf8" });
  assert.equal(authorized.status, 0, authorized.stdout + authorized.stderr);
  assert.equal(JSON.parse(authorized.stdout).result, "test");
});

test("an exported strategy composes a packaged agent without widening its callers or capabilities", async t => {
  const root = workspace(t), source = author(root, "example.assist"), project = consumer(root);
  writeFileSync(join(source, "src/example/assist.tb"), `module example.assist
skill Echo
    description "Return the supplied value."
    takes value as Text
    gives Text
    do
        give value
agent Assistant
    responsibility "Return the supplied value using the authorized Echo skill."
    takes value as Text
    gives Text
    uses Echo
    callable_by strategy Serve
strategy Serve
    takes value as Text
    gives Text
    uses Assistant
    do
        Assistant
            with value as value
            into reply
        give reply
`);
  writeFileSync(join(source, "SKILL.md"), "# Review\nReturn evidence from the authorized capability.\n");
  manifest(source, m => { m.exports = { strategies: ["strategy:example.assist/Serve"], agents: ["agent:example.assist/Assistant"] }; m.contexts = [{ id: "review", description: "Review evidence.", procedure: "SKILL.md" }]; });
  const archive = join(root, "assistant.tar.gz");
  await packPackage(source, { output: archive });
  await addPackage(archive, { root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  const program = join(project, "src/client/main.tb");
  writeFileSync(program, `module client.main
import strategy Serve from example.assist
strategy Run
    takes value as Text
    gives Text
    uses Serve
    do
        Serve
            with value as value
            into reply
        give reply
`);
  const prepared = await prepareProject({ root: project, mode: "write", entryRef: "strategy:client.main/Run" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  const air = JSON.parse(readFileSync(join(project, ".touba/build/dev/air/client/main.air.json")));
  assert.deepEqual(air.definitions.agents[0].callable_by.map(caller => caller.caller_ref), ["strategy:example.assist/Serve"]);
  const calls = [];
  const result = await executeAirDocument(air, { entryRef: "strategy:client.main/Run", inputs: { value: "Real package composition" }, agentDecisionProvider(request) {
    calls.push(request.agent_ref);
    if (request.observations.length) return { action: "answer_directly", result: request.observations.at(-1).value };
    if (request.mode === "summary") return { action: "request_capabilities" };
    return { target_ref: "skill:example.assist/Echo", arguments: { value: request.inputs.value } };
  } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "Real package composition");
  assert.ok(calls.every(ref => ref === "agent:example.assist/Assistant"));
  assert.ok(result.trace.events.some(e => e.kind === "agent_invocation_authorized" && e.payload.caller_ref === "strategy:example.assist/Serve"));
  const refused = await executeAirDocument(air, { entryRef: "strategy:client.main/Run", inputs: { value: "private" }, agentDecisionProvider: () => ({ target_ref: "strategy:client.main/Run", arguments: { value: "private" } }) });
  assert.equal(refused.reason, "AgentCapabilityNotAllowed");
  removePackage("example.assist", { root: project });
  assert.throws(() => resolveProjectRunArgs(["--project", project]), { code: "PackagePreparationStale" });
});

test("one author manifest covers contextual and executable skills, CLI check and publication prerequisites", async t => {
  const root = workspace(t);
  const created = spawnSync(process.execPath, [cli, "package", "new", "example.review", "--context", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const path = JSON.parse(created.stdout).path;
  assert.equal(existsSync(join(path, "skill.json")), false);
  assert.equal(existsSync(join(path, "scripts")), false);
  const checked = spawnSync(process.execPath, [cli, "package", "check", path, "--json"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).packages[0].requirements.contexts[0], "review");
  await assert.rejects(packPackage(path, { output: join(root, "pack.tar.gz") }), { code: "PackagePublicationMetadataMissing" });
  const missing = join(root, "missing"); mkdirSync(missing);
  await assert.rejects(checkPackage(missing), { code: "PackageFileMissing" });
  for (const [field, value, code] of [["grants", ["network"], "PackageAuthorityFieldForbidden"], ["files", {}, "PackageSchemaMismatch"], ["dependencies", { "acme.dep": "^1.0.0" }, "PackageDependencyInvalid"]]) {
    manifest(path, m => { m[field] = value; });
    await assert.rejects(checkPackage(path), { code });
    manifest(path, m => { delete m[field]; });
  }
  const unknown = spawnSync(process.execPath, [cli, "package", "add", path, "--force"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.throws(() => newPackage("example.review", { root, context: true }), { code: "PackageAlreadyExists" });
});

test("supplied handlers and author tests are inert during check, pack and installation", async t => {
  const root = workspace(t), source = author(root, "example.effect"), project = consumer(root);
  const marker = join(root, "handler-ran");
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/touch.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "must not execute during installation");\n`);
  writeFileSync(join(source, "src/example/effect.tb"), `module example.effect
tool Touch
    description "Write the supplied text to a configured destination."
    takes value as Text
    gives Text
    requires filesystem_write
skill Apply
    takes value as Text
    gives Text
    uses Touch
    do
        Touch
            with value as value
            into reply
        give reply
`);
  manifest(source, m => { m.exports = { skills: ["skill:example.effect/Apply"] }; m.handlers = [{ tool: "tool:example.effect/Touch", path: "handlers/touch.mjs", protocol: "touba-tool-handler-v1" }]; m.contract_tests = ["handlers/touch.mjs"]; });
  const archive = join(root, "effect.tar.gz");
  await checkPackage(source);
  await packPackage(source, { output: archive });
  await addPackage(archive, { root: project });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(project, "touba.manifest.json")), false, "installation cannot create executable bindings");
  assert.ok(existsSync(join(project, "packages/example.effect/handlers/touch.mjs")));
  manifest(source, m => { m.handlers[0].tool = "tool:example.effect/Absent"; });
  await assert.rejects(checkPackage(source), /PackageHandlerInvalid/);
});

test("failed commit restores project state and removes the installation marker", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async t => {
  const root = workspace(t), source = author(root), project = consumer(root);
  const before = readFileSync(join(project, "touba.project.json"));
  assert.ok(existsSync(join(project, "packages")), "init creates the managed directory");
  chmodSync(join(project, "packages"), 0o500);
  try { await assert.rejects(addPackage(source, { root: project }), /EACCES|EPERM/); }
  finally { chmodSync(join(project, "packages"), 0o700); }
  assert.deepEqual(readFileSync(join(project, "touba.project.json")), before);
  assert.equal(existsSync(join(project, PACKAGE_LOCK)), false);
  assert.equal(existsSync(join(project, ".touba-package-installing")), false);
  assert.equal(existsSync(join(project, "packages/example.echo")), false);
  await addPackage(source, { root: project });
});

test("declared exports, compatibility and host requirements are actually verified", async t => {
  const root = workspace(t), path = author(root);
  manifest(path, m => { m.exports.skills = ["skill:example.echo/Absent"]; });
  await assert.rejects(checkPackage(path), /PackageExportUnknownRef/);
  manifest(path, m => { m.exports.skills = ["skill:example.echo/Echo"]; m.touba.runtime_compatibility = ">=99.0.0"; });
  await assert.rejects(checkPackage(path), { code: "PackageVersionIncompatible" });
  manifest(path, m => { m.touba.runtime_compatibility = ">=0.1.0"; m.engines = { node: ">=99.0.0" }; });
  await assert.rejects(checkPackage(path), { code: "PackageRequirementMissing" });
  manifest(path, m => { delete m.engines; m.exports.skills.push("skill:example.echo/Echo"); });
  await assert.rejects(checkPackage(path), { code: "PackageNameConflict" });
});

test("exact versions allow prerelease plus build metadata, never ranges or normalized aliases", async t => {
  const root = workspace(t), path = author(root);
  manifest(path, m => { m.version = "1.2.3-beta.1+build.7"; });
  assert.equal((await checkPackage(path)).version, "1.2.3-beta.1+build.7");
  for (const version of ["v1.2.3", "=1.2.3", "1.2", "01.2.3", "^1.2.3", " 1.2.3"]) {
    manifest(path, m => { m.version = version; });
    await assert.rejects(checkPackage(path), { code: "PackageSchemaMismatch" });
  }
});

test("dependency closure is exact, offline, bundled and rejects cycles/conflicts/missing versions", async t => {
  const root = workspace(t), a = author(root, "example.parent"), b = author(root, "example.child");
  manifest(a, m => { m.dependencies = { "example.child": "0.1.0" }; });
  await assert.rejects(checkPackage(a), { code: "PackageDependencyMissing" });
  assert.ok(existsSync(join(a, "packages"))); cpSync(b, join(a, "packages/example.child"), { recursive: true });
  const bundled = join(a, "packages/example.child");
  assert.equal((await checkPackage(a)).packages.length, 2);
  const archive = join(root, "closure.tar.gz"); await packPackage(a, { output: archive });
  const project = consumer(root); await addPackage(archive, { root: project });
  const config = JSON.parse(readFileSync(join(project, "touba.project.json")));
  assert.equal(config.packages.length, 2); assert.equal(verifyInstalledPackages(project, config.packages).packages.length, 2);
  assert.throws(() => removePackage("example.child", { root: project }), { code: "PackageInUse" });
  removePackage("example.parent", { root: project });
  assert.equal(existsSync(join(project, "packages/example.parent")), false);
  removePackage("example.child", { root: project });
  assert.equal(JSON.parse(readFileSync(join(project, PACKAGE_LOCK))).packages.length, 0);
  manifest(bundled, m => { m.version = "0.2.0"; });
  await assert.rejects(checkPackage(a), { code: "PackageDependencyConflict" });
  manifest(bundled, m => { m.version = "0.1.0"; m.dependencies = { "example.parent": "0.1.0" }; });
  // The parent is already in the selected closure; no ambient lookup required.
  await assert.rejects(checkPackage(a), { code: "PackageDependencyCycle" });
});

test("manual adoption, installed inventory, incomplete transactions and no implicit replacement", async t => {
  const root = workspace(t), project = consumer(root), authored = author(root);
  const source = join(project, "packages/example.echo");
  cpSync(authored, source, { recursive: true });
  await addPackage(source, { root: project });
  const config = JSON.parse(readFileSync(join(project, "touba.project.json")));
  assert.equal(verifyInstalledPackages(project, config.packages).packages.length, 1);
  const projectAlias = join(root, "project-alias"); symlinkSync(project, projectAlias);
  assert.equal(verifyInstalledPackages(projectAlias, config.packages).packages.length, 1, "host project aliases are canonicalized before checking contained package paths");
  assert.throws(() => verifyInstalledPackages(project, [{ ...config.packages[0], editable: true }]), { code: "PackageLockMismatch" });
  assert.throws(() => verifyInstalledPackages(project, [...config.packages, config.packages[0]]), { code: "PackageNameConflict" });
  writeFileSync(join(source, "hidden.tb"), "module evil.extra\n");
  assert.throws(() => verifyInstalledPackages(project, config.packages), { code: "PackageUnexpectedFile" });
  rmSync(join(source, "hidden.tb"));
  writeFileSync(join(project, ".touba-package-installing"), "interrupted transaction");
  await assert.rejects(addPackage(source, { root: project }), { code: "PackageInstallationIncomplete" });
  rmSync(join(project, ".touba-package-installing"));
  manifest(source, m => { m.version = "0.2.0"; });
  await assert.rejects(addPackage(source, { root: project }), { code: "PackageIntegrityMismatch" });
  assert.equal(JSON.parse(readFileSync(join(project, PACKAGE_LOCK))).packages[0].version, "0.1.0");
});

test("sensitive paths, traversal, links and case collisions cannot enter a package", async t => {
  const root = workspace(t), path = author(root, "example.context", { context: true });
  assert.throws(() => readPackage(join(path, "README.md")), { code: "PackagePathInvalid" });
  for (const bad of ["../outside", "/absolute", "a/../../b", ".env", "secrets.pem", "node_modules", "CON", "a\\b"]) {
    manifest(path, m => { m.files = [bad]; });
    assert.throws(() => readPackage(path), /PackagePathInvalid|PackageSensitivePath/);
  }
  manifest(path, m => { m.files = ["linked.md"]; });
  symlinkSync(join(path, "SKILL.md"), join(path, "linked.md"));
  assert.throws(() => readPackage(path), { code: "PackageSymlinkForbidden" });
  manifest(path, m => { m.files = ["SKILL.md", "skill.md"]; });
  // This must refuse on both case-sensitive and case-insensitive hosts.
  if (!existsSync(join(path, "skill.md"))) copyFileSync(join(path, "SKILL.md"), join(path, "skill.md"));
  assert.throws(() => readPackage(path), { code: "PackagePathCollision" });
});

test("concurrent additions cannot silently lose another installation", async t => {
  const root = workspace(t), a = author(root, "example.first"), b = author(root, "example.second"), project = consumer(root);
  const results = await Promise.allSettled([addPackage(a, { root: project }), addPackage(b, { root: project })]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      assert.match(results[i].reason.message, /PackageProjectChanged|PackageInstallationIncomplete|EEXIST/);
      await addPackage([a, b][i], { root: project });
    }
  }
  const config = JSON.parse(readFileSync(join(project, "touba.project.json")));
  assert.equal(verifyInstalledPackages(project, config.packages).packages.length, 2);
});

test("archive parser refuses traversal, symlinks, duplicate entries and oversized content before extraction", t => {
  const root = workspace(t);
  for (const [name, entries] of [
    ["traversal", [{ path: "package/../../outside", type: "File", size: 0 }]],
    ["symlink", [{ path: "package/link", type: "SymbolicLink", linkpath: "/tmp", size: 0 }]],
    ["hardlink", [{ path: "package/link", type: "Link", linkpath: "../outside", size: 0 }]],
    ["duplicate", [{ path: "package/a", type: "File", size: 0 }, { path: "package/a", type: "File", size: 0 }]],
  ]) {
    const blocks = entries.map(entry => { const header = new tar.Header({ ...entry, mode: 0o644 }); header.encode(); return header.block; });
    const archive = join(root, `${name}.tar.gz`); writeFileSync(archive, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
    const output = join(root, name);
    assert.throws(() => unpackPackage(archive, output), /PackagePathInvalid|PackageArchiveInvalid|PackagePathCollision/);
    assert.equal(existsSync(output), false);
  }
  const bomb = join(root, "bomb.tar.gz"); writeFileSync(bomb, gzipSync(Buffer.alloc(129 * 1024 * 1024)));
  assert.throws(() => unpackPackage(bomb, join(root, "bomb")), { code: "PackageArchiveInvalid" });
});

test("selected static registry installs the exact archive and rejects changed digests and yanked versions", async t => {
  const root = workspace(t), source = author(root), project = consumer(root), registry = join(root, "registry"); mkdirSync(registry);
  const packed = await packPackage(source, { output: join(registry, "echo.tar.gz") });
  const metadata = { schema_version: "touba-registry-package-v1", package_ref: "pkg:example.echo", namespace: "example", name: "echo", version: "0.1.0", kind: "touba_package", status: "validated", summary: "Contract test package", source: { type: "archive", url: "https://example.invalid/echo.tar.gz", path: "echo.tar.gz", revision: packed.digest }, compatibility: { touba: ">=0.1.0 <0.2.0", protocols: ["touba-package-v1"] }, artifacts: [{ kind: "package_archive", path: "echo.tar.gz", digest: packed.digest }] };
  const save = () => {
    const bytes = JSON.stringify(metadata); writeFileSync(join(registry, "package.json"), bytes);
    writeFileSync(join(registry, "index.json"), JSON.stringify({ index_schema_version: "touba-registry-index-v1", packages: [{ package_ref: metadata.package_ref, version: metadata.version, kind: metadata.kind, status: metadata.status, metadata_path: "package.json", metadata_digest: packageDigest(bytes) }] }));
  }; save();
  await addRegistryPackage("example.echo", { root: project, registry, version: "0.1.0" });
  metadata.compatibility.touba = ">=99.0.0"; save();
  await assert.rejects(addRegistryPackage("example.echo", { root: project, registry, version: "0.1.0" }), { code: "PackageVersionIncompatible" });
  metadata.compatibility.touba = ">=0.1.0 <0.2.0";
  metadata.artifacts[0].digest = `sha256:${"0".repeat(64)}`; save();
  await assert.rejects(addRegistryPackage("example.echo", { root: project, registry, version: "0.1.0" }), { code: "PackageIntegrityMismatch" });
  metadata.status = "yanked"; save();
  await assert.rejects(addRegistryPackage("example.echo", { root: project, registry, version: "0.1.0" }), /RegistryPackageYanked/);
});
