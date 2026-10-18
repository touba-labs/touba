import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

for (const imported of [false, true]) test(`function capability preserves its source description (${imported ? "imported" : "local"})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-function-capability-"));
  try {
    const declaration = `function Double
    description "Double the supplied integer without external effects."
    takes n as Int
    gives Int
    do
        give n * 2
`;
    writeFileSync(join(root, "math.tb"), `module math\n${declaration}`);
    const source = join(root, "app.tb");
    writeFileSync(source, `module app
${imported ? "import function Double from math\n" : declaration}
agent Calculator
    responsibility "Calculate using the declared arithmetic capability."
    takes n as Int
    gives Int
    uses Double
    callable_by strategy Run
strategy Run
    takes n as Int
    gives Int
    uses Calculator
    do
        Calculator
            with n as n
            into result
        give result
`);
    const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
      new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
      "--source-root", root, source], { encoding: "utf8" }));
    const target = `function:${imported ? "math" : "app"}/Double`;
    for (const code of ["DecisionHistoryLimitExceeded", "DecisionHistorySummaryInvalid", "ProviderContextWindowExceeded"]) {
      let calls = 0;
      const result = await executeAirDocument(air, { entryRef: "strategy:app/Run", inputs: { n: 21 },
        agentDecisionProviderMaxRetries: 2,
        agentDecisionProvider() { calls++; throw Object.assign(new Error("Local provider preparation refused"), { name: "ToubaAgentDecisionProviderError", code }); } });
      assert.equal(result.reason, code);
      assert.equal(calls, 1, "local refusals must not trigger transport retries");
      assert.equal(result.trace.events.findLast(e => e.kind === "failure_detected").payload.failure_family, "authority");
    }
    for (const direct of [false, true]) {
      let calls = 0;
      const result = await executeAirDocument(air, { entryRef: "strategy:app/Run", inputs: { n: 21 },
        agentDecisionProviderInitialMode: "capabilities",
        agentDecisionProvider(request) {
          calls++;
          if (request.mode === "capabilities") {
            assert.equal(request.capabilities[0].description, "Double the supplied integer without external effects.");
          }
          if (direct || request.observations.length) return { action: "answer_directly", result: direct ? 42 : request.observations[0].value };
          return { target_ref: target, arguments: { n: request.inputs.n } };
        } });
      assert.equal(result.status, "success", JSON.stringify(result.trace));
      assert.equal(result.result, 42);
      assert.equal(calls, direct ? 1 : 2);
    }
    delete air.definitions.functions.find(item => item.id === target).description;
    let calls = 0;
    const refused = await executeAirDocument(air, { entryRef: "strategy:app/Run", inputs: { n: 21 },
      agentDecisionProvider() { calls++; return { action: "answer_directly", result: 42 }; } });
    assert.equal(refused.reason, "AgentCapabilityDescriptionRequired");
    assert.equal(calls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
