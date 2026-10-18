import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { packageLocalToolchain } from "./package-local-toolchain.mjs";

// Runs the published tutorial's actual source files with a copied distribution,
// outside the checkout. No provider credentials or model calls are involved.
test("isolated distribution supports package creation, archive installation and the contextual-tool tutorial", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-consumer-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { toolchainRoot } = packageLocalToolchain();
  const isolated = join(root, "toolchain");
  cpSync(toolchainRoot, isolated, { recursive: true });
  const binary = join(isolated, "bin", process.platform === "win32" ? "touba.cmd" : "touba");
  const node = join(isolated, "bin", process.platform === "win32" ? "node.exe" : "node");
  const env = { PATH: [join(isolated, "bin"), "/usr/bin", "/bin"].join(delimiter), TMPDIR: root };
  function command(executable, args, cwd, expected = 0) {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, expected, `${executable} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  }
  const author = join(root, "author"), consumer = join(root, "consumer");
  mkdirSync(author); mkdirSync(consumer);
  command(binary, ["package", "new", "example.echo"], author);
  const manifestPath = join(author, "echo/touba.package.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  Object.assign(manifest, { publisher: "Distribution test", license: "MIT" });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  command(binary, ["package", "check", "--publishing"], join(author, "echo/src"));
  command(binary, ["package", "test"], join(author, "echo/src"));
  command(binary, ["package", "version", "patch"], join(author, "echo/src"));
  command(binary, ["package", "pack"], join(author, "echo/src"));
  command(binary, ["init"], consumer);
  command(binary, ["package", "add", join(author, "echo/dist/example.echo-0.1.1.tar.gz")], consumer);
  const dependencies = JSON.parse(command(binary, ["package", "list", "--json"], join(consumer, "src")));
  assert.deepEqual(dependencies.packages.map(p => [p.name, p.version]), [["example.echo", "0.1.1"]]);
  assert.ok(existsSync(join(consumer, "touba.packages.lock.json")));

  const reusable = join(root, "reusable-tutorial"); mkdirSync(reusable);
  command(binary, ["package", "new", "echo", "--org", "acme", "--license", "MIT", "--yes"], reusable);
  const echo = join(reusable, "echo");
  const sourceTutorial = readFileSync(new URL("../../../../docs/tutoriels/package-reutilisable.md", import.meta.url), "utf8");
  const examples = [...sourceTutorial.matchAll(/```touba title="([^"]+)"\n([\s\S]*?)\n```/g)];
  assert.equal(examples.length, 2);
  assert.equal(readFileSync(join(echo, examples[0][1]), "utf8").trim(), examples[0][2].trim());
  command(binary, ["package", "check", "--publishing"], echo);
  command(binary, ["package", "test"], echo);
  command(binary, ["package", "pack"], echo);
  const firstArchive = readFileSync(join(echo, "dist/acme.echo-0.1.0.tar.gz"));
  const client = join(reusable, "consumer"); mkdirSync(client);
  command(binary, ["init"], client);
  command(binary, ["package", "add", "../echo/dist/acme.echo-0.1.0.tar.gz"], client);
  mkdirSync(dirname(join(client, examples[1][1])), { recursive: true });
  writeFileSync(join(client, examples[1][1]), examples[1][2] + "\n");
  command(binary, ["prepare", "--mode", "write", "--entry", "strategy:client.main/Run"], client);
  const imported = JSON.parse(command(binary, ["run", "--project", ".", "--inputs-json", JSON.stringify({ request: "Package import works" }), "--output", "json"], client));
  assert.equal(imported.result, "Package import works");
  command(binary, ["package", "version", "patch"], join(echo, "src"));
  command(binary, ["package", "test"], join(echo, "src"));
  command(binary, ["package", "pack"], join(echo, "src"));
  assert.ok(existsSync(join(echo, "dist/acme.echo-0.1.1.tar.gz")));
  assert.deepEqual(readFileSync(join(echo, "dist/acme.echo-0.1.0.tar.gz")), firstArchive);

  const project = join(root, "tutorial"); mkdirSync(project);
  command(binary, ["init"], project);
  command(binary, ["package", "new", "acme.dataset", "--context"], project);
  const version = JSON.parse(command(binary, ["version", "--json"], project));
  const npm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
  assert.ok(npm, "npm is required for the offline SDK tutorial");
  command(npm, ["install", "--offline", "--ignore-scripts", "--save-exact", "--cache", join(root, "npm-cache"), version.distribution.sdk_archive], project);
  const tutorial = readFileSync(new URL("../../../../docs/tutoriels/skill-pack-script-tool.md", import.meta.url), "utf8");
  let files = 0;
  for (const match of tutorial.matchAll(/```(?:js|json|touba) title="([^"]+)"\n([\s\S]*?)\n```/g)) {
    const file = join(project, match[1]); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, match[2] + "\n"); files++;
  }
  assert.equal(files, 7, "every documented tutorial file is exercised");
  command(node, ["configure-pack.mjs"], project);
  command(binary, ["package", "check", "dataset"], project);
  command(binary, ["package", "add", "./dataset"], project);
  command(binary, ["compile", "dataset_brief.tb", "--out", "dataset_brief.air.json"], project);
  const args = ["run", "dataset_brief.air.json", "--manifest", "touba.manifest.json", "--agent-decision-provider", "providers/dataset-provider.mjs", "--skill-pack", "packages/acme.dataset", "--activate-skill-pack", "skill_pack:acme.dataset/dataset-brief", "--skill-pack-discovery-max-bytes", "4096", "--skill-pack-activation-max-bytes", "16384", "--agent-model-input-max-bytes", "65536", "--inputs-json", JSON.stringify({ request: { query: "public parks", max_rows: 5 } }), "--trace-out", "trace.json", "--output", "json"];
  const result = JSON.parse(command(binary, args, project));
  assert.deepEqual(result.result, { title: "public parks", summary: "Montréal parks; Québec parks" });
  const trace = JSON.parse(readFileSync(join(project, "trace.json")));
  assert.ok(trace.events.some(e => e.kind === "skill_pack_activated"));
  assert.ok(trace.events.some(e => e.kind === "tool_binding_authorized"));
  const bindings = JSON.parse(readFileSync(join(project, "touba.manifest.json")));
  bindings.bindings["tool:examples.dataset/RenderDatasetBrief"].grants = [];
  writeFileSync(join(project, "touba.manifest.json"), JSON.stringify(bindings));
  const refused = command(binary, args, project, 1);
  assert.match(refused, /ToolCapabilityNotGranted/);
});
