import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newPackage, testPackage, versionPackage } from "../src/package-author.mjs";
import { packageSlug, readPackage } from "../src/package-contract.mjs";
import { addPackage, checkPackage, packPackage, removePackage } from "../src/packages.mjs";
import { initProject } from "../src/project.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
function workspace(t) { const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-author-"))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function command(cwd, ...args) { return spawnSync(process.execPath, [cli, "package", ...args], { cwd, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 }); }
function edit(root, fn) { const file = join(root, "touba.package.json"), data = JSON.parse(readFileSync(file)); fn(data); writeFileSync(file, JSON.stringify(data)); }

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
  const archive = await packPackage(undefined, { root: join(created.path, "src") });
  assert.equal(archive.output, join(created.path, "dist/atelier-nord.gestion-factures-0.1.0.tar.gz"));
  await assert.rejects(packPackage(created.path), { code: "PackageAlreadyExists" });
  assert.throws(() => newPackage("gestion-factures", { root, org: "Atelier Sud" }), { code: "PackageAlreadyExists" });
});

test("names cannot escape, use reserved paths or silently discard punctuation", t => {
  const root = workspace(t);
  for (const name of ["../escape", "a/b", "a\\b", "", "été", "a--b", "packages", "CON", "billing@1", "x".repeat(81)]) assert.throws(() => newPackage(name, { root, org: "acme" }));
  assert.equal(packageSlug("  Billing   tools "), "billing-tools");
  assert.equal(existsSync(join(root, "packages")), false);
  const noOrg = command(root, "new", "facturation", "--yes", "--json");
  assert.equal(noOrg.status, 2); assert.match(noOrg.stderr, /PackageOrganizationRequired/);
  assert.equal(command(root, "new", "acme.a", "--org", "x", "--org", "y").status, 2);
  assert.equal(command(root, "new", "acme.a", "--unexpected").status, 2);
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
    assert.throws(() => initProject({ root: project }), /PackagePathCollision|PackageSymlinkForbidden/);
    assert.equal(existsSync(join(project, "touba.project.json")), false);
  }
});
