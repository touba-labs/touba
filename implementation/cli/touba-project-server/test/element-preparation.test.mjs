import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, newModule, prepareProject } from "../../touba-project/src/project.mjs";
import { buildElementAuthoringChangeSet } from "../src/element-authoring.mjs";
import { proposeProjectChangeSet, applyProjectChange } from "../src/serve.mjs";
import { createProjectPreparation } from "../src/project-preparation.mjs";
import { readPreparedProject } from "../src/prepared-project.mjs";

for (const language of ["javascript", "python"]) for (const withFragment of [false, true]) {
  test(`authored ${language} tool survives reviewed preparation (existing fragment: ${withFragment})`, async t => {
    const root = mkdtempSync(join(tmpdir(), "touba-authoring-prepared-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    initProject({ root, language });
    const module = newModule("test.authoring", { root });
    writeFileSync(module.source_path, 'module test.authoring\nstrategy Run\n    gives Text\n    do\n        give "ready"\n');
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath));
    config.entry = "strategy:test.authoring/Run";
    if (withFragment) {
      writeFileSync(join(root, "host.json"), JSON.stringify({ fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "project" }, bindings: {} }));
      config.configuration = { binding_fragments: ["host.json"] };
    }
    writeFileSync(configPath, JSON.stringify(config));
    assert.equal((await prepareProject({ root, mode: "write" })).status, "success");
    const request = { schema_version: "touba-element-authoring-request-v1", proposal_id: "add_lookup",
      module_ref: "test.authoring", requested_by: { kind: "user", id: "author" }, reason: "Reviewed host binding",
      element: { kind: "tool", name: "LookupRecord", description: "Looks up the selected record.",
        takes: [{ name: "value", type_ref: "Text" }], gives: "Text", requirements: [],
        handler: { effect_contract: { kind: "none" }, sandbox_required: false } } };
    const changeSet = buildElementAuthoringChangeSet({ projectRoot: root, request });
    assert.equal(changeSet.changes.some(change => change.path === "touba.manifest.json"), false);
    const store = join(root, ".touba/changes.sqlite");
    proposeProjectChangeSet({ projectRoot: root, changeProposalsPath: store, changeSet });
    const applied = applyProjectChange({ projectRoot: root, changeProposalsPath: store, applyRequest: {
      schema_version: "touba-project-change-apply-v1", proposal_id: request.proposal_id, decision: "apply",
      decided_by: { kind: "user", id: "owner" }, reason: "Reviewed source and binding" } });
    assert.equal(applied.status, "applied");
    const preparation = createProjectPreparation(root);
    const preview = await preparation.preview("owner");
    assert.equal(preview.can_apply, true, JSON.stringify(preview));
    assert.equal((await preparation.apply("owner", preview)).status, "success");
    const check = await prepareProject({ root, mode: "check" });
    assert.equal(check.status, "success", JSON.stringify(check.diagnostics));
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json")));
    const binding = manifest.bindings["tool:test.authoring/LookupRecord"];
    assert.equal(binding.handler.cwd, "../../..");
    assert.deepEqual(binding.grants, []);
    assert.deepEqual(binding.effect_contract, { kind: "none" });
    const stub = changeSet.changes.find(change => change.role === "handler_stub");
    assert.deepEqual(binding.handler.args, [stub.path]);
    assert.ok(existsSync(join(root, stub.path.replace(/\.handler\./, ".handler.contract.test."))), "canonical preparation creates the contract test");
    assert.match(readFileSync(join(root, stub.path), "utf8"), /HandlerNotImplemented/);
    assert.deepEqual(JSON.parse(readFileSync(configPath)).configuration.binding_fragments,
      withFragment ? ["host.json", "touba.bindings.json"] : ["touba.bindings.json"]);
    readPreparedProject(root);
  });
}
