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

const here = dirname(fileURLToPath(import.meta.url));

test("installed archive supplies an independent SDK, provider dependencies, licenses and a working project server", { timeout: 360000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba archive SDK "));
  try {
    const { toolchainRoot } = packageLocalToolchain({ quiet: true });
    const prefix = join(workspace, "custom prefix");
    const installed = installLocalToolchain({ source: toolchainRoot, prefix });
    const node = join(installed.install_root, "bin", process.platform === "win32" ? "node.exe" : "node");
    const cli = join(installed.install_root, "lib/cli/touba-project/src/main.mjs");
    const version = JSON.parse(run(node, [cli, "version", "--json"], workspace));
    const archive = version.distribution.sdk_archive;
    assert.ok(archive && realpathSync(archive).startsWith(realpathSync(installed.install_root)));
    const metadata = JSON.parse(readFileSync(join(installed.install_root, "TOOLCHAIN.json"), "utf8"));
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), metadata.sdk.sha256);
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
      run(npm.command, npm.args, root,
        { npm_config_cache: join(workspace, "empty npm cache") });
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
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: isolatedEnv(env), encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
