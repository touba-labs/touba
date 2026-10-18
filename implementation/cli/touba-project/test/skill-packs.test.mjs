import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadSkillPack, loadProjectContexts } from "../src/skill-packs.mjs";
import { newPackage, addPackage } from "../src/packages.mjs";
import { initProject, prepareProject } from "../src/project.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";

test("configured project contexts are locked, explicit and enforced through Engine", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = newPackage("acme.review", { root, context: true });
  const project = join(root, "app"); initProject({ root: project });
  await addPackage(pkg.path, { root: project });
  const configFile = join(project, "touba.project.json");
  const config = JSON.parse(readFileSync(configFile));
  config.configuration = { ...config.configuration, contexts: [{ package: "acme.review", context: "review", active: true }] };
  writeFileSync(configFile, JSON.stringify(config));
  const projected = loadProjectContexts(project);
  assert.equal(projected.skillPacks[0].source, "project");
  assert.deepEqual(projected.activeSkillPackRefs, ["skill_pack:acme.review/review"]);
  assert.throws(() => loadSkillPack(pkg.path, undefined, { projectRoot: project }), { code: "PackageNotInstalled" });
  assert.equal(loadSkillPack(pkg.path).source, "author");
  mkdirSync(join(project, "src/app"));
  writeFileSync(join(project, "src/app/main.tb"), `module app.main
agent Reviewer
    responsibility "Review the request using the configured instructions."
    gives Text
    callable_by strategy Run
strategy Run
    gives Text
    uses Reviewer
    do
        Reviewer
            into answer
        give answer
`);
  writeFileSync(join(project, "provider.mjs"), `import assert from 'node:assert/strict';
export default function decide(request) {
  assert.equal(request.model_input.active_skill_packs[0].ref, 'skill_pack:acme.review/review');
  return { action: 'answer_directly', result: 'reviewed' };
}`);
  const prepared = await prepareProject({ root: project, mode: "write" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared));
  const engine = new ToubaEngine({ projectRoot: project, command: process.execPath,
    commandArgs: [fileURLToPath(new URL("../src/main.mjs", import.meta.url))] });
  const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const run = () => JSON.parse(execFileSync(process.execPath, [cli, "run", "--project", project,
    "--agent-decision-provider", join(project, "provider.mjs"), "--output", "json"], { cwd: project, encoding: "utf8" }));
  const result = run();
  assert.equal(result.result, "reviewed");
  writeFileSync(join(project, "packages/acme.review/SKILL.md"), "altered instructions");
  assert.throws(() => loadProjectContexts(project), { code: "PackageIntegrityMismatch" });
  await assert.rejects(engine.run({ source: "src/app/main.tb", entry: "strategy:app.main/Run", agentDecisionProvider: "provider.mjs",
    skillPacks: ["packages/acme.review#review"], activeSkillPackRefs: ["skill_pack:acme.review/review"] }));
});

test("explicit CLI/SDK pack selection preserves discovery, activation, resources and authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-pack-public-"));
  try {
    const created = newPackage("example-north.review-check", { root, context: true });
    const pack = { skill_pack_path: created.path, descriptor_path: join(created.path, "touba.package.json") };
    const manifest = JSON.parse(readFileSync(pack.descriptor_path, "utf8"));
    const descriptor = manifest.contexts[0];
    descriptor.resources = [];
    descriptor.execution_links = [];
    const script = "throw new Error('A pack must not execute this script');";
    mkdirSync(join(pack.skill_pack_path, "scripts"));
    writeFileSync(join(pack.skill_pack_path, "scripts/helper.mjs"), script);
    descriptor.resources.push({ name: "helper", description: "Non-executable helper source", path: "scripts/helper.mjs", kind: "script",
      loadable_as_context: false });
    descriptor.execution_links.push({ label: "Return the supplied text", target_ref: "skill:pack/Reply", description: "Use the declared reply skill." });
    const save = () => writeFileSync(pack.descriptor_path, JSON.stringify(manifest));
    save();
    writeFileSync(join(root, "program.tb"), `module pack
skill Reply
    description "Return the supplied text unchanged."
    takes request as Text
    gives Text
    do
        give request
agent Reviewer
    responsibility "Return the requested text after using the declared reply capability."
    takes request as Text
    gives Text
    uses Reply
    callable_by strategy Run
strategy Run
    takes request as Text
    gives Text
    uses Reviewer
    do
        Reviewer
            with request as request
            into reply
        give reply
`);
    writeFileSync(join(root, "provider.mjs"), `import assert from "node:assert/strict";
export default function decide(request) {
  assert.equal(request.model_input.skill_pack_hints.length, 1);
  const active = request.model_input.active_skill_packs;
  if (!active) return { action: "answer_directly", result: "discovery only" };
  assert.ok(active[0].resources.some(resource => resource.kind === "procedure" && resource.content));
  assert.equal(active[0].resources.find(resource => resource.kind === "script").content, undefined);
  if (request.observations?.length) return { action: "answer_directly", result: request.observations.at(-1).value };
  if (request.mode === "summary") return { action: "request_capabilities" };
  return { target_ref: "skill:pack/Reply", arguments: { request: request.inputs.request } };
}
`);
    const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../src/main.mjs", import.meta.url))] });
    const options = { source: "program.tb", inputs: { request: "business value" },
      agentDecisionProvider: "provider.mjs", skillPacks: ["review-check#review-check"] };
    const discovered = await engine.run(options);
    assert.equal(discovered.result, "discovery only");
    assert.equal(discovered.trace.events.some(event => event.kind === "skill_pack_activated"), false);
    const activeOptions = { ...options, activeSkillPackRefs: ["skill_pack:example-north.review-check/review-check"] };
    const activated = await engine.run(activeOptions);
    assert.equal(activated.result, "business value");
    for (const kind of ["skill_pack_discovery_listed", "skill_pack_activated", "skill_pack_resource_loaded", "skill_pack_resource_refused", "agent_capability_selected"]) {
      assert.ok(activated.trace.events.some(event => event.kind === kind), kind);
    }
    assert.doesNotMatch(JSON.stringify(activated.trace), /A pack must not execute|business value/);
    await assert.rejects(engine.run({ ...activeOptions, skillPackActivationMaxBytes: 1 }), error => error.details.reason === "SkillPackBudgetExceeded");
    await assert.rejects(engine.run({ ...activeOptions, activeSkillPackRefs: ["skill_pack:project/unknown"] }));
    descriptor.activation.user_invocable = false;
    save();
    await assert.rejects(engine.run(activeOptions), error => error.details.reason === "SkillPackActivationForbidden");
    descriptor.activation.user_invocable = true;
    save();
    descriptor.execution_links[0].target_ref = "skill:pack/Absent";
    save();
    await assert.rejects(engine.run(activeOptions), error => /SkillPackExecutionLinkUnauthorized/.test(error.details.stderr));
    descriptor.execution_links = [];
    descriptor.resources[0].loadable_as_context = true;
    save();
    assert.throws(() => loadSkillPack(pack.skill_pack_path), { code: "PackageContextInvalid" });
    descriptor.resources[0].loadable_as_context = false;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pack resources cannot escape through a parent-directory symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-pack-path-"));
  try {
    const created = newPackage("example-north.review-check", { root, context: true });
    const pack = { skill_pack_path: created.path, descriptor_path: join(created.path, "touba.package.json") };
    const manifest = JSON.parse(readFileSync(pack.descriptor_path, "utf8"));
    const descriptor = manifest.contexts[0];
    descriptor.resources = [];
    descriptor.execution_links = [];
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "document.md"), "outside content");
    symlinkSync(outside, join(pack.skill_pack_path, "linked"), "dir");
    descriptor.resources.push({ name: "escape", description: "Invalid linked resource", path: "linked/document.md", kind: "reference",
      loadable_as_context: true });
    writeFileSync(pack.descriptor_path, JSON.stringify(manifest));
    assert.throws(() => loadSkillPack(pack.skill_pack_path), { code: "PackageSymlinkForbidden" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
