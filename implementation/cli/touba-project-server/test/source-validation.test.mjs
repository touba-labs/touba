import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProposedSources } from "../src/source-validation.mjs";
import { toolReviewFixture } from "./fixtures/tool-review-project.mjs";
import { proposeProjectChangeSet, applyProjectChange } from "../src/serve.mjs";

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
