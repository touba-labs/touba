import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {executeAirDocument} from "../../../runtime/touba-runtime/src/index.mjs";

test("published multi-agent guide executes single and parallel reviews with capability descriptions", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-composition-guide-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const guide = readFileSync(new URL("../../../../docs/guides/composition-multi-agents.md", import.meta.url), "utf8");
  const source = [...guide.matchAll(/```touba[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]).find(text => text.includes("function PrepareBrief"));
  assert.ok(source);
  const file = join(root, "review.tb"); writeFileSync(file, source);
  const compiler = fileURLToPath(new URL("../../../target/debug/touba-compile", import.meta.url));
  const air = JSON.parse(execFileSync(compiler, [file], {encoding: "utf8"}));
  const module = /module (\S+)/.exec(source)[1];
  const provider = request => request.mode === "summary" ? {action: "request_capabilities"}
    : request.observations.length ? {action: "answer_directly", result: request.observations.at(-1).value}
      : {action: "select_capability", target_ref: `function:${module}/PrepareBrief`, arguments: {brief: request.inputs.brief}};
  for (const [entry, inputs, expected] of [["ReviewOne", {brief: "one"}, "Review: one"], ["ReviewBatch", {briefs: ["one", "two"]}, ["Review: one", "Review: two"]]]) {
    const result = await executeAirDocument(air, {entryRef: `strategy:${module}/${entry}`, inputs, agentDecisionProvider: provider});
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(result.result, expected);
  }
  writeFileSync(file, source.replace(/^\s*description .*\n/m, "\n"));
  const old = JSON.parse(execFileSync(compiler, [file], {encoding: "utf8"}));
  const refused = await executeAirDocument(old, {entryRef: `strategy:${module}/ReviewOne`, inputs: {brief: "one"}, agentDecisionProvider: provider});
  assert.equal(refused.reason, "AgentCapabilityDescriptionRequired");
});
