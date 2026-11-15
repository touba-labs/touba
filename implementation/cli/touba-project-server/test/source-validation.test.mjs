import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProposedSources } from "../src/source-validation.mjs";
import { toolReviewFixture } from "./fixtures/tool-review-project.mjs";
import { proposeProjectChangeSet, applyProjectChange } from "../src/serve.mjs";
import {requestRouteConflicts} from '../../../contracts/trigger-routes.mjs';

test('request route uniqueness includes distinct modules but deduplicates imported definitions', () => {
  const a={id:'trigger:a.main/One',event:{kind:'request',value:'POST /shared'}};
  const b={id:'trigger:b.main/Two',event:{kind:'request',value:'POST /shared'}};
  const docs=[{definitions:{triggers:[a]}},{definitions:{triggers:[a,b]}}];
  assert.equal(requestRouteConflicts(docs).length,1);
  assert.deepEqual(requestRouteConflicts(docs,new Set([a.id])),[]);
  assert.deepEqual(requestRouteConflicts(docs).at(0).details.trigger_refs,[a.id,b.id]);
});

test('source review refuses a duplicate webhook path before writing source', t => {
  const root=mkdtempSync(join(tmpdir(),'touba-route-review-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));
  const strategy='module route.test\nstrategy Work\n    gives Int\n    do\n        give 1\n';
  const trigger=name=>`trigger ${name}\n    on request POST "/shared"\n    runs strategy Work\n    limits\n        max_runs_per_day as 5\n        timeout_ms as 5000\n`;
  const original=strategy+trigger('First');
  writeFileSync(join(root,'src/test.tb'),original);
  const result=compileProposedSources({projectRoot:root,targets:[{path:'src/test.tb',content:original+trigger('Second')}]});
  assert.ok(result.diagnostics.some(item=>item.code==='TriggerRouteConflict'),JSON.stringify(result.diagnostics));
  assert.equal(readFileSync(join(root,'src/test.tb'),'utf8'),original);
});

test("review compiles imports and reverse dependants without changing active sources", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-source-review-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ project_version: "touba-project-v1", language: "javascript", sdk: "@touba/sdk", artifact_layout: "touba-artifacts-v1" }));
  const text = `module lib
function Echo
    takes value as Text
    gives Text
    do
        give value
`;
  const main = `module main
import function Echo from lib
strategy Run
    takes value as Text
    gives Text
    uses Echo
    do
        Echo
            with value as value
            into output
        give output
`;
  writeFileSync(join(root, "src/lib.tb"), text);
  writeFileSync(join(root, "src/main.tb"), main);
  const review = (path, content) => compileProposedSources({ projectRoot: root, targets: [{ path, content }] });
  assert.deepEqual(review("src/main.tb", main).diagnostics, []);
  const broken = review("src/lib.tb", text.replace("function Echo", "function Renamed"));
  assert.equal(broken.air, null);
  assert.ok(broken.diagnostics.length);
  assert.match(JSON.stringify(broken.diagnostics), /Echo/);
  assert.doesNotMatch(JSON.stringify(broken.diagnostics), /touba-source-review-|private\/var/);
  const together = compileProposedSources({ projectRoot: root, targets: [
    { path: "src/lib.tb", content: text.replace("function Echo", "function Renamed") },
    { path: "src/main.tb", content: main.replaceAll("Echo", "Renamed") },
  ] });
  assert.deepEqual(together.diagnostics, []);
  assert.equal(readFileSync(join(root, "src/lib.tb"), "utf8"), text);
  const changeProposalsPath = join(root, ".touba/changes.sqlite");
  proposeProjectChangeSet({ projectRoot: root, changeProposalsPath, changeSet: {
    proposal_id: "rename_together", requested_by: { kind: "studio", id: "review-test" }, reason: "Rename an imported function",
    changes: [{ path: "src/lib.tb", content: text.replace("function Echo", "function Renamed") },
      { path: "src/main.tb", content: main.replaceAll("Echo", "Renamed") }],
  } });
  const applied = applyProjectChange({ projectRoot: root, changeProposalsPath, applyRequest: {
    schema_version: "touba-project-change-apply-v1", proposal_id: "rename_together", decision: "apply",
    decided_by: { kind: "user", id: "reviewer" }, reason: "Reviewed both modules",
  } });
  assert.equal(applied.status, "applied");
  assert.match(readFileSync(join(root, "src/main.tb"), "utf8"), /import function Renamed/);
});

test("review admits intact imported packages and refuses modified package inputs", async t => {
  const f = await toolReviewFixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const path = "src/client/main.tb", content = readFileSync(join(f.root, path), "utf8");
  assert.deepEqual(compileProposedSources({ projectRoot: f.root, targets: [{ path, content }] }).diagnostics, []);
  writeFileSync(join(f.root, "packages/example.review/src/example/review.tb"), "module altered\n");
  const refused = compileProposedSources({ projectRoot: f.root, targets: [{ path, content }] });
  assert.equal(refused.air, null);
  assert.ok(refused.diagnostics.some(item => item.code === "PackageIntegrityMismatch"));
});
