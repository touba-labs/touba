import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillPack } from "../src/skill-packs.mjs";
import { newPackage } from "../src/packages.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";

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
      agentDecisionProvider: "provider.mjs", skillPacks: ["review-check#review"] };
    const discovered = await engine.run(options);
    assert.equal(discovered.result, "discovery only");
    assert.equal(discovered.trace.events.some(event => event.kind === "skill_pack_activated"), false);
    const activeOptions = { ...options, activeSkillPackRefs: ["skill_pack:example-north.review-check/review"] };
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
