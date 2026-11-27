import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { packageLocalToolchain } from "./package-local-toolchain.mjs";
import { installLocalToolchain } from "./install-local-toolchain.mjs";
import { runDocumentRecipe } from "./tutorial-recipe.mjs";
import { npmCommand } from "./npm-command.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The offline npm installation into a fresh cache can exceed a minute on
// Windows runners. Keep its longer child-process timeout local to this step.
const windows = process.platform === "win32";
const npmInstallTimeout = windows ? 180_000 : 60_000;

test("installed archive supplies an independent SDK, provider dependencies, licenses and a working project server", { timeout: 600_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba archive SDK "));
  try {
    const { toolchainRoot } = packageLocalToolchain({
      toolchainRoot: join(workspace, "toolchain"),
      quiet: true,
    });
    const prefix = join(workspace, process.platform === "win32" ? "custom %prefix" : "custom $prefix's");
    const installed = installLocalToolchain({ source: toolchainRoot, prefix });
    const node = join(installed.install_root, "bin", process.platform === "win32" ? "node.exe" : "node");
    const cli = join(installed.install_root, "lib/cli/touba-project/src/main.mjs");
    const version = JSON.parse(run(node, [cli, "version", "--json"], workspace));
    if (process.platform !== "win32") {
      const launcherVersion = JSON.parse(run(installed.cli_path, ["version", "--json"], workspace));
      assert.equal(launcherVersion.build.id, version.build.id);
    }
    const archive = version.distribution.sdk_archive;
    assert.ok(archive && realpathSync(archive).startsWith(realpathSync(installed.install_root)));
    const metadata = JSON.parse(readFileSync(join(installed.install_root, "TOOLCHAIN.json"), "utf8"));
    const aliases = join(installed.install_root, "lib/node_modules/@touba");
    assert.match(run(node, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {pathToFileURL} from 'node:url';
      const root = ${JSON.stringify(installed.install_root)};
      const canonical = await import(pathToFileURL(root + '/lib/runtime/touba-runtime/src/index.mjs'));
      const alias = await import(pathToFileURL(${JSON.stringify(aliases + "/runtime/entry-0.mjs")}));
      assert.equal(alias.executeAirDocument, canonical.executeAirDocument);
      await import(pathToFileURL(${JSON.stringify(aliases + "/supply-chain/entry-0.mjs")}));
      await import(pathToFileURL(${JSON.stringify(aliases + "/deployment/entry-0.mjs")}));
      console.log('CANONICAL_MODULES_OK');
    `], workspace), /CANONICAL_MODULES_OK/);
    assert.deepEqual(metadata.build, toolchainBuildIdentity(installed.install_root));
    assert.deepEqual(metadata.build, toolchainBuildIdentity(toolchainRoot));
    assert.equal(version.build.id, metadata.build.id);
    const fakeBuildEnv = { TOUBA_BUILD_ID: "spoofed-build", GITHUB_SHA: "a".repeat(40) };
    assert.equal(run(node, [cli, "version"], workspace, fakeBuildEnv), `touba ${version.cli}\nbuild ${metadata.build.id.slice(0, 12)}\n`);
    assert.equal(JSON.parse(run(node, [cli, "version", "--json"], workspace, fakeBuildEnv)).build.id, metadata.build.id);
    const metadataPath = join(installed.install_root, "TOOLCHAIN.json");
    try {
      for (const invalid of [undefined, { ...metadata.build, id: "not-a-hash" }, { ...metadata.build, id: [metadata.build.id] }, { ...metadata.build, algorithm: "other" }]) {
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, build: invalid }));
        assert.equal(JSON.parse(run(node, [cli, "version", "--json"], workspace, fakeBuildEnv)).build.id, "unknown");
      }
      rmSync(metadataPath);
      assert.equal(run(node, [cli, "version"], workspace, fakeBuildEnv), `touba ${version.cli}\nbuild unknown\n`);
      writeFileSync(metadataPath, "{invalid json");
      const corrupt = spawnSync(node, [cli, "version", "--json"], { cwd: workspace, encoding: "utf8", env: isolatedEnv() });
      assert.notEqual(corrupt.status, 0);
      assert.equal(corrupt.stdout, "");
    } finally { writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`); }
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), metadata.sdk.sha256);
    const pythonArchive = version.distribution.python_sdk_archive;
    assert.ok(pythonArchive && realpathSync(pythonArchive).startsWith(realpathSync(installed.install_root)));
    assert.equal(createHash("sha256").update(readFileSync(pythonArchive)).digest("hex"), metadata.python_sdk.sha256);
    const python = process.env.TOUBA_PYTHON_BUILD_BIN || "python3";
    const venv = join(workspace, "python client");
    run(python, ["-m", "venv", venv], workspace);
    const client = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    run(client, ["-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--no-deps", pythonArchive], workspace);
    writeFileSync(join(workspace, "python.tb"), 'module python_installed\nstrategy Echo\n    takes value as Text\n    gives Text\n    do\n        give value\n');
    assert.match(run(client, ["-c", `from touba_sdk import ToubaEngine
engine = ToubaEngine(project_root=${JSON.stringify(workspace)}, command=${JSON.stringify(node)}, command_args=[${JSON.stringify(cli)}])
assert engine.version()["build"]["id"] == ${JSON.stringify(metadata.build.id)}
assert engine.run(source="python.tb", inputs={"value":"installed-python-ok"}).result == "installed-python-ok"
run = engine.run(source="python.tb", inputs={"value":"installed-python-ok"}, trace_store="traces.sqlite", trace_mode="reference")
assert run.trace is None and run.result == "installed-python-ok"
count, after = 0, None
while True:
    page = engine.read_trace(trace_store="traces.sqlite", reference=run.trace_reference, after=after, limit=2)
    count += len(page["events"])
    after = page["next"]
    if page["done"]:
        break
assert count == run.trace_reference["event_count"]
print("PYTHON_ARCHIVE_OK")`], workspace, { PYTHONPATH: "" }), /PYTHON_ARCHIVE_OK/);
    if (process.platform !== "win32") {
      const implementationRoot = join(here, "../../..");
      for (const [locale, document] of [
        ["fr", join(implementationRoot, "../docs/tutoriels/skill-pack-script-tool.md")],
      ]) {
        const recipeRoot = join(workspace, `tutorial 5 ${locale}`);
        mkdirSync(recipeRoot);
        const recipe = runDocumentRecipe(document, recipeRoot, isolatedEnv({
          PATH: `${join(installed.install_root, "bin")}:${process.env.PATH}`,
          npm_config_cache: join(workspace, `empty tutorial cache ${locale}`),
        }));
        assert.equal(recipe.files, 7);
        const trace = JSON.parse(readFileSync(join(recipe.cwd, "trace.json"), "utf8"));
        assert.equal(trace.events.at(-1).payload.status, "success");
        for (const kind of ["skill_pack_discovery_listed", "skill_pack_activated", "skill_pack_resource_loaded", "skill_pack_resource_refused", "tool_binding_authorized"]) {
          assert.ok(trace.events.some(event => event.kind === kind), `${locale}: ${kind}`);
        }
        assert.match(recipe.outputs.join("\n"), /Montréal parks; Québec parks/);
        console.log(`INSTALLED_TUTORIAL_5_${locale.toUpperCase()}_OK commands=${recipe.commands} files=${recipe.files}`);
      }
      // These are the published files and commands, not harness-injected projects.
      for (const document of ["interaction-humaine-validation.md", "sdk-engine-provider-js.md", "supply-chain-handlers-sc1.md"]) {
        const root = join(workspace, document); mkdirSync(root);
        runDocumentRecipe(join(implementationRoot, "../docs/tutoriels", document), root, isolatedEnv({
          PATH: `${join(installed.install_root, "bin")}:${process.env.PATH}`,
          npm_config_cache: join(root, "empty cache"), TOUBA_TUTORIAL_LIVE: "0",
        }));
        console.log(`INSTALLED_GOVERNANCE_RECIPE_OK ${document}`);
      }
    }
    const projects = [];
    for (const label of ["first project", "second project"]) {
      const root = join(workspace, label); mkdirSync(root); projects.push(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: label.replaceAll(" ", "-"), private: true, scripts: { custom: "echo preserved" } }));
      const npm = npmCommand(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", archive]);
      const started = performance.now();
      run(npm.command, npm.args, root,
        { npm_config_cache: join(workspace, "empty npm cache") }, npmInstallTimeout);
      console.log(`INSTALLED_SDK_OFFLINE_OK project=${label.replaceAll(" ", "-")} duration_ms=${Math.round(performance.now() - started)}`);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      assert.equal(manifest.scripts.custom, "echo preserved");
      assert.ok(manifest.dependencies["@touba/sdk"].endsWith(".tgz"));
      const inventory = JSON.parse(readFileSync(join(root, "node_modules/@touba/sdk/DEPENDENCIES.json"), "utf8"));
      for (const name of ["ai", "@ai-sdk/openai", "zod"]) assert.ok(inventory.packages.some(item => item.name === name && item.license));
      assert.match(readFileSync(join(root, "node_modules/@touba/sdk/LICENSE"), "utf8"), /Apache License/);
      writeFileSync(join(root, "sdk-smoke.mjs"), readFileSync(join(here, "sdk-smoke-program.mjs")));
      assert.match(run(node, ["sdk-smoke.mjs", cli], root), /SDK_ARCHIVE_OK/);
    }
    const sdkPath = join(projects[0], "node_modules/@touba/sdk/src/index.mjs");
    const before = readFileSync(sdkPath, "utf8");
    installLocalToolchain({ source: toolchainRoot, prefix, force: true });
    assert.equal(readFileSync(sdkPath, "utf8"), before, "CLI reinstall must not mutate project SDK");
    assert.match(run(node, ["sdk-smoke.mjs", cli], projects[0]), /SDK_ARCHIVE_OK/);

    // Exercise the public host API through the installed archive and its SDKs.
    // In particular, this catches omitted shared contracts in the payload.
    run(node, ["--test", join(here, "../../touba-project/test/compensation-command.test.mjs")], workspace, {
      TOUBA_TEST_CLI: cli,
      TOUBA_TEST_SDK: sdkPath,
      TOUBA_HOST_PYTHON: client,
      PYTHONPATH: "",
      PATH: `${join(installed.install_root, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    });

    run(node, [cli, "init", "--root", projects[0]], workspace);
    const port = await freePort();
    const child = spawn(node, [cli, "serve", "--project-root", projects[0], "--host", "127.0.0.1", "--port", String(port)], {
      cwd: projects[0], detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(),
    });
    let serverError = "";
    child.stderr.on("data", chunk => { serverError = (serverError + chunk).slice(-8000); });
    child.stdout.resume();
    try {
      let health;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const response = await fetch(`http://127.0.0.1:${port}/health`); health = await response.json(); break; } catch { await delay(50); }
        if (child.exitCode !== null) throw new Error(`installed touba serve exited ${child.exitCode}: ${serverError}`);
      }
      assert.equal(health?.service, "touba-project-server");
      assert.equal(health?.status, "ok");
      const nativeContract = await fetch(`http://127.0.0.1:${port}/contracts/touba-run-trace-export-v1`);
      assert.equal(nativeContract.status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/runs/absent/trace`)).status, 404);
    } finally {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]);
    }
    const serve = join(installed.install_root, "lib/cli/touba-project-server/src/serve.mjs");
    renameSync(serve, `${serve}.test-backup`);
    try {
      const doctor = spawnSync(node, [cli, "doctor", "--json"], { cwd: workspace, encoding: "utf8", env: isolatedEnv() });
      assert.notEqual(doctor.status, 0);
      assert.match(doctor.stdout, /Missing public command scripts: serve/);
    } finally { renameSync(`${serve}.test-backup`, serve); }
    const runtimePackage = join(installed.install_root, "lib/runtime/touba-runtime/package.json");
    renameSync(runtimePackage, `${runtimePackage}.test-backup`);
    try {
      const version = JSON.parse(run(node, [cli, "version", "--json"], workspace));
      assert.equal(version.runtime, "unknown", "Missing metadata must not inherit an invented version");
      const doctor = spawnSync(node, [cli, "doctor", "--json"], { cwd: workspace, encoding: "utf8", env: isolatedEnv() });
      assert.equal(doctor.status, 1);
      assert.match(doctor.stdout, /Invalid component versions: runtime/);
    } finally { renameSync(`${runtimePackage}.test-backup`, runtimePackage); }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

function isolatedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["NODE_PATH", "TOUBA_IMPLEMENTATION_DIR", "TOUBA_COMPILE_BIN"]) delete env[name];
  return env;
}
function run(command, args, cwd, env = {}, timeout = 60_000) {
  const result = spawnSync(command, args, { cwd, env: isolatedEnv(env), encoding: "utf8", timeout });
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.slice(-8000);
  assert.equal(result.status, 0, result.error ? `${result.error.message}\n${output}` : output);
  return result.stdout;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
