import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";
import { fileURLToPath } from "node:url";


test("compiled branches fall through and preserve early returns and typed caller results", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-branch-flow-"));
  try {
    const source = join(root, "flow.tb");
    writeFileSync(source, `module flow.check
function Pick
    takes x as Int
    gives Int
    do
        if x == 1
            give 10
        if x == 2
            give 20
        give 30
strategy Use
    takes x as Int
    gives Int
    do
        Pick
            with x as x
            into picked
        give picked + 1
`);
    const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
      fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", source], { encoding: "utf8" }));
    for (const [target, inputs, expected] of [
      ["function:flow.check/Pick", { x: 1 }, 10],
      ["function:flow.check/Pick", { x: 2 }, 20],
      ["function:flow.check/Pick", { x: 3 }, 30],
      ["strategy:flow.check/Use", { x: 3 }, 31],
    ]) {
      const result = await executeAirDocument(air, { entryRef: target, inputs });
      assert.equal(result.status, "success", JSON.stringify(result));
      assert.equal(result.result, expected, `${target}: ${JSON.stringify(inputs)}`);
    }
    // A malformed graph must not silently return null for a declared Int.
    const malformed = structuredClone(air);
    const graph = malformed.execution_graphs.find(graph => graph.owner_ref === "function:flow.check/Pick");
    graph.edges = graph.edges.filter(edge => edge.role !== "false");
    const refused = await executeAirDocument(malformed, { entryRef: "function:flow.check/Pick", inputs: { x: 3 } });
    assert.equal(refused.status, "failure");
    assert.match(JSON.stringify(refused.trace), /does not match builtin:Int/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
