import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newSkillPack, loadSkillPack, validateSkillPacks } from "../src/skill-packs.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";

test("explicit CLI/SDK pack selection preserves discovery, activation, resources and authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-pack-public-"));
  try {
    const pack = newSkillPack("review", { root });
    const descriptor = JSON.parse(readFileSync(pack.descriptor_path, "utf8"));
    const script = "throw new Error('A pack must not execute this script');";
    mkdirSync(join(pack.skill_pack_path, "scripts"));
    writeFileSync(join(pack.skill_pack_path, "scripts/helper.mjs"), script);
    descriptor.resources.push({ ref: "resource:review/helper", path: "scripts/helper.mjs", kind: "script",
      loadable_as_context: false, digest: `sha256:${createHash("sha256").update(script).digest("hex")}` });
    descriptor.execution_links.push({ label: "Return the supplied text", target_ref: "skill:pack/Reply" });
    const save = () => writeFileSync(pack.descriptor_path, JSON.stringify(descriptor));
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
      agentDecisionProvider: "provider.mjs", skillPacks: ["skills/review"] };
    const discovered = await engine.run(options);
    assert.equal(discovered.result, "discovery only");
    assert.equal(discovered.trace.events.some(event => event.kind === "skill_pack_activated"), false);
    const activeOptions = { ...options, activeSkillPackRefs: [descriptor.ref] };
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
    const unchecked = validateSkillPacks({ root, target: "review" });
    assert.equal(unchecked.skill_packs[0].execution_links_check, "not_checked_without_air");
    assert.match(unchecked.notes[0], /not checked against AIR/);
    descriptor.execution_links[0].target_ref = "skill:pack/Absent";
    save();
    await assert.rejects(engine.run(activeOptions), error => /SkillPackExecutionLinkUnauthorized/.test(error.details.stderr));
    descriptor.execution_links = [];
    descriptor.resources[1].loadable_as_context = true;
    save();
    assert.throws(() => loadSkillPack(pack.skill_pack_path), { code: "SkillPackScriptExecutionForbidden" });
    descriptor.resources[1].loadable_as_context = false;
    descriptor.resources[0].digest = `sha256:${"0".repeat(64)}`;
    save();
    assert.throws(() => loadSkillPack(pack.skill_pack_path), { code: "SkillPackDigestMismatch" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pack resources cannot escape through a parent-directory symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-pack-path-"));
  try {
    const pack = newSkillPack("review", { root });
    const descriptor = JSON.parse(readFileSync(pack.descriptor_path, "utf8"));
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "document.md"), "outside content");
    symlinkSync(outside, join(pack.skill_pack_path, "linked"), "dir");
    descriptor.resources.push({ ref: "resource:review/escape", path: "linked/document.md", kind: "reference",
      loadable_as_context: true, digest: `sha256:${createHash("sha256").update("outside content").digest("hex")}` });
    writeFileSync(pack.descriptor_path, JSON.stringify(descriptor));
    assert.throws(() => loadSkillPack(pack.skill_pack_path), { code: "SkillPackResourcePathInvalid" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
