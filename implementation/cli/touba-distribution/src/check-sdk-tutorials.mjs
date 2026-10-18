import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// Execute the published examples against SDK archives from an installed release.
// No provider, network service, source-tree SDK import or personal installation.
export function checkSdkTutorials({ root, temp }) {
  const binary = join(root, "bin", process.platform === "win32" ? "node.exe" : "node");
  const cli = join(root, "lib/cli/touba-project/src/main.mjs");
  const env = { ...process.env, PATH: join(root, "bin") + delimiter + process.env.PATH,
    npm_config_cache: join(temp, "npm-cache"),
    TOUBA_COMPILE_BIN: join(root, "bin", process.platform === "win32" ? "touba-compile.exe" : "touba-compile") };
  const docs = fileURLToPath(new URL("../../../../docs/tutoriels/", import.meta.url));
  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  }
  function blocks(document) {
    return [...document.matchAll(/```(\w+)(?: title="([^"]+)")?\n([\s\S]*?)\n```/g)]
      .map(([, language, title, body]) => ({ language, title, body }));
  }
  for (const language of ["javascript", "python"]) {
    const project = join(temp, `published-${language}`); mkdirSync(project);
    const command = (...args) => run(binary, [cli, ...args], project);
    command("sdk", "install", language);
    const python = join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const engine = readFileSync(join(docs, `engine-${language}.md`), "utf8");
    for (const { title, body } of blocks(engine).filter(block => block.title)) {
      writeFileSync(join(project, title), body + "\n");
      if (title.endsWith(".tb")) continue;
      assert.equal(run(language === "python" ? python : binary, [title], project),
        title.startsWith("refused.") ? "refused" : "Invoice 42", title);
    }
    if (language === "python") continue; // Python handler + transitive lock tested by the caller.
    command("init", "--language", language);
    const tutorial = readFileSync(join(docs, "handlers-javascript.md"), "utf8");
    const snippets = blocks(tutorial);
    mkdirSync(join(project, "src/sdk"), { recursive: true });
    writeFileSync(join(project, "src/sdk/handlers.tb"), snippets.find(block => block.language === "touba").body + "\n");
    const decisions = snippets.find(block => block.body.startsWith("touba prepare")).body.match(/--host-decisions-json '(.+)'/)[1];
    const prepared = JSON.parse(command("prepare", "--mode", "write", "--json", "--host-decisions-json", decisions));
    assert.equal(prepared.status, "success");
    const manifestPath = ".touba/build/dev/touba.manifest.json";
    const manifest = JSON.parse(readFileSync(join(project, manifestPath)));
    const handler = join(project, manifest.bindings["tool:sdk.handlers/Normalize"].handler.args[0]);
    const body = snippets.find(block => block.language === "js" && !block.title).body;
    const stub = readFileSync(handler, "utf8");
    const updated = stub.replace(/export async function run\([\s\S]*?(?=\nif \(process\.argv)/, body + "\n");
    assert.notEqual(updated, stub);
    writeFileSync(handler, updated);
    run(binary, ["--test", handler.replace(/\.handler\.mjs$/, ".handler.contract.test.mjs")], project);
    const application = snippets.find(block => block.title === "run.mjs");
    writeFileSync(join(project, application.title), application.body + "\n");
    assert.equal(run(binary, [application.title], project), "INVOICE 42");
    if (process.platform === "darwin") {
      const sandboxDecision = {bindings: {"tool:sdk.handlers/Normalize": {sandbox: {required: true}}}};
      const sandboxed = JSON.parse(command("prepare", "--mode", "write", "--json", "--host-decisions-json", JSON.stringify(sandboxDecision)));
      assert.equal(sandboxed.status, "success", JSON.stringify(sandboxed.diagnostics));
      assert.equal(run(binary, [application.title], project), "INVOICE 42");
      assert.equal(JSON.parse(command("prepare", "--mode", "check", "--json", "--host-decisions-json", JSON.stringify(sandboxDecision))).status, "success");
      // The following tutorial adds a helper module and tests supply-chain
      // admission separately. Do not silently allow it through the sandbox.
      sandboxDecision.bindings["tool:sdk.handlers/Normalize"].sandbox.required = false;
      command("prepare", "--mode", "write", "--json", "--host-decisions-json", JSON.stringify(sandboxDecision));
    }
    const helper = snippets.find(block => block.title?.endsWith("helpers.mjs"));
    writeFileSync(join(project, helper.title), helper.body + "\n");
    writeFileSync(handler, 'import { normalize } from "./helpers.mjs";\n' + updated.replace("return request.trim().toUpperCase();", "return normalize(request);"));
    const identity = JSON.parse(readFileSync(join(project, "package.json")));
    writeFileSync(join(project, "package.json"), JSON.stringify({ ...identity, name: "business-handlers", version: "0.1.0" }, null, 2) + "\n");
    assert.equal(run(binary, [application.title], project), "INVOICE 42");
    command("compile", "src/sdk/handlers.tb", "--out", "program.air.json");
    command("supply-chain", "generate", "--air", "program.air.json", "--manifest", manifestPath, "--out", "touba.lock.json");
    const checked = JSON.parse(command("supply-chain", "validate", "--air", "program.air.json", "--manifest", manifestPath, "--lock", "touba.lock.json", "--output", "json"));
    assert.notEqual(checked.status, "error");
    const lock = JSON.parse(readFileSync(join(project, "touba.lock.json")));
    assert.equal(lock.review.status, "pending");
    assert.ok(lock.handlers[0].handler_package.files.some(file => file.path === helper.title));
  }
}
