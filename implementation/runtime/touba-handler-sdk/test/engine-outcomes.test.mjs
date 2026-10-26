import { readEffectJournalFixture } from "../../../tests/helpers/effect-journal.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine, ToubaEngineError } from "../src/index.mjs";

for (const executionMode of ["process", "persistent"]) {
test("SDK nested-loop checkpoints retain effect identities across three durable resumptions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-nested-"));
  try {
    writeFileSync(join(root, "source.tb"), readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/control-flow-v1/positive/nested-controls.tb", import.meta.url)));
    const marker = join(root, "writes.txt");
    writeFileSync(join(root, "handler.mjs"), `import { appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(${JSON.stringify(marker)}, request.arguments.value + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: 'stored', effect_receipt: {
  effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied'
}}));`);
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
      "tool:control.nested/Write": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")], cwd: root },
        grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
    } }));
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    const options = { source: "source.tb", manifest: "touba.manifest.json", entryRef: "strategy:control.nested/Review", effectJournal: "run.effect-journal.sqlite" };
    let result = await engine.run({ ...options, inputs: { rows: [[1, 2], [3]] }, humanCheckpointOut: "pause-0.json" });
    assert.equal(result.reason, "human_approval_pending");
    assert.equal(existsSync(marker), false);
    let runId;
    for (let i = 0; i < 3; i++) {
      const checkpoint = JSON.parse(readFileSync(join(root, `pause-${i}.json`), "utf8"));
      runId ??= checkpoint.run_id;
      assert.equal(checkpoint.run_id, runId);
      assert.deepEqual(checkpoint.context_values, [i + 1]);
      result = await engine.run({ ...options, humanResumeCheckpoint: `pause-${i}.json`,
        humanCheckpointOut: `pause-${i + 1}.json`, humanDecisions: { [checkpoint.approval_ref]: "approved" } });
      assert.equal(result.reason, i === 2 ? "completed" : "human_approval_pending");
      assert.equal(readFileSync(marker, "utf8"), Array.from({ length: i + 1 }, (_, n) => `${n + 1}\n`).join(""));
    }
    assert.equal(existsSync(join(root, "pause-3.json")), false);
    const entries = Object.values(readEffectJournalFixture(join(root, "run.effect-journal.sqlite")).entries);
    assert.equal(entries.length, 3);
    assert.ok(entries.every(entry => entry.state === "applied"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const delegated of [false, true]) test(`SDK ${delegated ? "agent-selected" : "source"} calls resume with durable checkpoints with one journal and unreplayed writes`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-call-stack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.tb"), readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-nested-human-continuation.tb", import.meta.url)));
  const marker = join(root, "writes.jsonl");
  writeFileSync(join(root, "handler.mjs"), `import { appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({value:request.arguments.value, effect_id:request.effect.effect_id}) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: request.arguments.value, effect_receipt: {
  effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied'
}}));`);
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:agent.continuation/Record": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")] },
      grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
    commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
  if (delegated) writeFileSync(join(root, "provider.mjs"), `import { appendFileSync } from "node:fs";
export function decideAgentCapability(request) {
  appendFileSync(${JSON.stringify(join(root, "decisions.jsonl"))}, JSON.stringify(request.step_index) + '\\n');
  return request.step_index === 0
    ? { target_ref: "strategy:agent.continuation/Work", arguments: { value: request.inputs.value } }
    : { action: "answer_directly", result: request.observations[0].value };
}`);
  const options = { source: "source.tb", manifest: "touba.manifest.json",
    entryRef: `strategy:agent.continuation/${delegated ? "RunDelegation" : "Run"}`,
    ...(delegated ? { agentDecisionProvider: "provider.mjs", agentDecisionProviderInitialMode: "capabilities" } : {}),
    effectJournal: "run.effect-journal.sqlite" };
  let result = await engine.run({ ...options, inputs: delegated ? { value: "delegated" } : { values: ["one", "two"] }, humanCheckpointOut: "pause-0.json" });
  let runId;
  for (let i = 0; i < (delegated ? 1 : 3); i++) {
    assert.equal(result.reason, "human_approval_pending");
    const checkpoint = JSON.parse(readFileSync(join(root, `pause-${i}.json`), "utf8"));
    runId ??= checkpoint.run_id;
    assert.equal(checkpoint.run_id, runId);
    assert.equal(checkpoint.call_stack.length, delegated ? 3 : i === 2 ? 0 : 2);
    result = await engine.run({ ...options, humanResumeCheckpoint: `pause-${i}.json`,
      humanCheckpointOut: `pause-${i + 1}.json`, humanDecisions: { [checkpoint.approval_ref]: "approved" } });
  }
  assert.equal(result.status, "success");
  assert.equal(result.result, delegated ? "delegated" : "done");
  const writes = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
  const expected = delegated ? ["before", "delegated"] : ["start", "before", "one", "before", "two"];
  assert.deepEqual(writes.map(item => item.value), expected);
  assert.equal(new Set(writes.map(item => item.effect_id)).size, expected.length);
  const entries = Object.values(readEffectJournalFixture(join(root, "run.effect-journal.sqlite")).entries);
  assert.equal(entries.length, expected.length);
  assert.ok(entries.every(entry => entry.state === "applied"));
  assert.equal(new Set(entries.map(entry => entry.effect_scope_id)).size, 1);
  if (delegated) assert.deepEqual(readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [0, 1]);
});

test("published request trigger accepts normalized event arguments and rejects missing data", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-guide-webhook-"));
  try {
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    // Core executes its canonical example in standalone checkouts. The site's
    // mandatory alignment tests compare both translations with these exact
    // source/manifest bytes; Core does not require a second private repository.
    {
      const docUrl = new URL("../../../../docs/guides/triggers-gouvernes.md", import.meta.url);
      const doc = readFileSync(docUrl, "utf8");
      writeFileSync(join(root, "source.tb"), doc.match(/```touba[^\n]*\n([\s\S]*?)```/)[1]);
      writeFileSync(join(root, "touba.manifest.json"), doc.match(/```json title="touba.manifest.json"\n([\s\S]*?)```/)[1]);
      const options = { source: "source.tb", manifest: "touba.manifest.json", triggerEvent: {
        trigger_ref: "trigger:examples.daily_research/DailyResearchWebhook", source_kind: "request", event_id: "guide-request", arguments: { topic: "Governed dataset review" },
      } };
      const result = await engine.run(options);
      assert.equal(result.status, "success");
      assert.equal(result.messages[0].text, "Daily research run: Governed dataset review");
      await assert.rejects(engine.run({ ...options, triggerEvent: { ...options.triggerEvent, arguments: {} } }),
        error => error instanceof ToubaEngineError && error.details.reason === "TriggerPayloadInvalid");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK runs a governed trigger with persistent deduplication and source validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-trigger-"));
  try {
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    writeFileSync(join(root, "program.tb"), `module sdk.trigger
strategy Run
    gives Text
    do
        give "done"
trigger Hourly
    on schedule "every 1h"
    runs strategy Run
    limits
        max_runs_per_day as 10
        timeout_ms as 30000
`);
    const triggerRef = "trigger:sdk.trigger/Hourly";
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {},
      triggers: { [triggerRef]: { enabled: true, source: { kind: "schedule" }, limits: { max_runs_per_day: 10, timeout_ms: 30000 } } } }));
    const options = { source: "program.tb", manifest: "touba.manifest.json", triggerState: "events.triggers.sqlite",
      triggerEvent: { trigger_ref: triggerRef, event_id: "sdk-event-1", source_kind: "schedule" } };
    const result = await engine.run(options);
    assert.equal(result.status, "success");
    assert.equal(result.result, "done");
    await assert.rejects(engine.run(options), error => error instanceof ToubaEngineError && error.details.reason === "TriggerReplayRejected");
    assert.ok(existsSync(join(root, "events.triggers.sqlite")));
    await assert.rejects(engine.run({ ...options, triggerEvent: { ...options.triggerEvent, event_id: "sdk-event-2", source_kind: "request" } }),
      error => error instanceof ToubaEngineError && /Source|Event/.test(error.details.reason));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real CLI and SDK distinguish completion, pauses, stops, human refusal, cancellation and errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-engine-outcomes-"));
  try {
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    const run = async (body, options = {}) => {
      writeFileSync(join(root, "program.tb"), `module outcomes\nstrategy Run\n    do\n${body}\n`);
      return engine.run({ source: "program.tb", ...options });
    };
    const success = await run('        show\n            with message as "Private business message"\n        give "done"', { humanCheckpointOut: "optional.checkpoint.json" });
    assert.equal(existsSync(join(root, "optional.checkpoint.json")), false);
    assert.equal(success.status, "success");
    assert.equal(success.reason, "completed");
    assert.equal(success.result, "done");
    assert.equal(success.messages[0].text, "Private business message");
    assert.doesNotMatch(JSON.stringify(success.trace), /Private business message/);
    const ask = await run('        ask\n            with prompt as "Private question?"\n            into answer\n        give answer');
    assert.equal(ask.status, "stopped");
    assert.equal(ask.reason, "user_input_pending");
    assert.equal(ask.pendingInteraction.prompt, "Private question?");
    assert.doesNotMatch(JSON.stringify(ask.trace), /Private question/);
    const stopped = await run("        stop");
    assert.equal(stopped.reason, "explicit_stop");
    const cancelled = await run('        give "not reached"', { cancelBeforeDispatch: true });
    assert.equal(cancelled.status, "cancelled");
    const approvalBody = '        human.approve\n            with context as "Review request"\n            into approval\n        give "approved"';
    const pending = await run(approvalBody);
    assert.equal(pending.reason, "human_approval_pending");
    const ref = pending.trace.events.find(event => event.kind === "human_approval_requested").payload.approval_ref;
    for (const decision of ["rejected", "expired", "cancelled"]) {
      const result = await run(approvalBody, { humanDecisions: { [ref]: decision } });
      assert.equal(result.reason, `human_approval_${decision}`);
      assert.equal(result.result, null);
    }
    await assert.rejects(run('        give "unused"', { inputs: { extra: "private" } }), error => {
      assert.ok(error instanceof ToubaEngineError);
      assert.equal(error.details.exitCode, 1);
      assert.equal(error.details.status, "failure");
      assert.equal(error.details.reason, "EntryInputSchemaInvalid");
      assert.doesNotMatch(JSON.stringify(error.details.trace), /private/);
      return true;
    });
    await assert.rejects(engine.run({ airJson: { module: { id: "PRIVATE_INVALID_MODULE" } } }), error => {
      assert.ok(error instanceof ToubaEngineError);
      assert.equal(error.details.exitCode, 1);
      assert.equal(error.details.status, "failure");
      assert.equal(error.details.reason, "AirInvalid");
      assert.deepEqual(error.details.messages, []);
      assert.deepEqual(error.details.trace.events.map(event => event.kind), ["admission_refused"]);
      assert.doesNotMatch(JSON.stringify(error.details.trace), /PRIVATE_INVALID_MODULE|run_started|run_completed/);
      return true;
    });
    writeFileSync(join(root, "nested.tb"), `module nested.approval
skill Review
    gives Text
    do
        human.approve
            with context as "Review"
            into decision
        give "approved"
strategy Run
    gives Text
    uses Review
    do
        Review
            into result
        give result
`);
    const nested = { source: "nested.tb", humanCheckpointOut: "nested.checkpoint.json" };
    const nestedPause = await engine.run(nested);
    assert.equal(nestedPause.reason, "human_approval_pending");
    const saved = JSON.parse(readFileSync(join(root, "nested.checkpoint.json"), "utf8"));
    assert.equal(saved.call_stack.length, 1);
    const nestedResult = await engine.run({ source: "nested.tb", humanResumeCheckpoint: "nested.checkpoint.json",
      humanDecisions: { [saved.approval_ref]: "approved" } });
    assert.equal(nestedResult.status, "success");
    assert.equal(nestedResult.result, "approved");
    const unavailable = new ToubaEngine({ executionMode, projectRoot: root, command: join(root, "missing-cli") });
    await assert.rejects(unavailable.run({ airJson: {} }), error => error instanceof ToubaEngineError && error.details.code === "ENOENT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK forwards an explicit durable journal, refuses unjournaled writes and preserves fresh-run identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-engine-effects-"));
  try {
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    writeFileSync(join(root, "write.tb"), `module sdk.effects
tool Write
    description "Appends one isolated test record."
    takes value as Text
    gives Text
strategy Run
    takes value as Text
    gives Text
    uses Write
    do
        Write
            with value as value
            into stored
        give stored
`);
    const marker = join(root, "records.txt");
    writeFileSync(join(root, "handler.mjs"), `import { appendFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (!request.effect || request.operation !== 'invoke') process.exit(2);
appendFileSync(${JSON.stringify(marker)}, request.arguments.value + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: 'stored', effect_receipt: {
  effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied'
}}));
`);
    const manifest = join(root, "touba.manifest.json");
    writeFileSync(manifest, JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
      "tool:sdk.effects/Write": { handler: { kind: "process", command: process.execPath,
        args: [join(root, "handler.mjs")], cwd: root }, grants: [], timeout_ms: 5000,
        max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
    } }));
    const request = { source: "write.tb", manifest, inputs: { value: "record" } };
    await assert.rejects(engine.run(request), error => error instanceof ToubaEngineError
      && ["EffectContextRequired", "EffectJournalRequired"].includes(error.details.reason));
    assert.equal(existsSync(marker), false);
    const effectJournal = join(root, "sdk.effect-journal.sqlite");
    for (let index = 0; index < 2; index++) {
      assert.equal((await engine.run({ ...request, effectJournal })).result, "stored");
      assert.equal(existsSync(effectJournal + ".lock"), false);
    }
    assert.equal(readFileSync(marker, "utf8"), "record\nrecord\n");
    const entries = Object.values(readEffectJournalFixture(effectJournal).entries);
    assert.equal(new Set(entries.map(entry => entry.effect_scope_id)).size, 2);
    assert.deepEqual(entries.map(entry => entry.state), ["applied", "applied"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK resumes successive durable approvals without replaying earlier instructions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-engine-successive-"));
  try {
    const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    writeFileSync(join(root, "program.tb"), `module sdk.successive
tool Write
    takes value as Text
    gives Text
strategy Run
    gives Text
    uses Write
    do
        Write
            with value as "before"
            into before
        show
            with message as "Before first approval"
        human.approve
            with context as "Manager review"
            into manager
        Write
            with value as "between"
            into between
        show
            with message as "Between approvals"
        human.approve
            with context as "Director review"
            into director
        Write
            with value as "after"
            into after
        show
            with message as "After both approvals"
        give "approved"
`);
    const marker = join(root, "writes.txt");
    writeFileSync(join(root, "handler.mjs"), `import { appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(${JSON.stringify(marker)}, request.arguments.value + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: 'stored', effect_receipt: {
  effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied'
}}));`);
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
      "tool:sdk.successive/Write": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")], cwd: root },
        grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
    } }));
    const options = { source: "program.tb", manifest: "touba.manifest.json", effectJournal: "run.effect-journal.sqlite" };
    const first = await engine.run({ ...options, humanCheckpointOut: "first.json" });
    assert.equal(first.reason, "human_approval_pending");
    assert.deepEqual(first.messages.map(message => message.text), ["Before first approval"]);
    assert.equal(readFileSync(marker, "utf8"), "before\n");
    const checkpoint = JSON.parse(readFileSync(join(root, "first.json"), "utf8"));
    const firstBytes = readFileSync(join(root, "first.json"), "utf8");
    await assert.rejects(engine.run({ ...options, humanResumeCheckpoint: "first.json", humanCheckpointOut: "wrong.json",
      humanDecisions: { "approval:foreign": "approved" } }), error => {
        assert.ok(error instanceof ToubaEngineError);
        assert.equal(error.details.reason, "UnknownApprovalReference", JSON.stringify(error.details));
        return true;
      });
    assert.equal(existsSync(join(root, "wrong.json")), false);
    assert.equal(readFileSync(marker, "utf8"), "before\n");
    const second = await engine.run({ ...options, humanResumeCheckpoint: "first.json",
      humanCheckpointOut: "second.json", humanDecisions: { [checkpoint.approval_ref]: "approved" } });
    assert.equal(second.reason, "human_approval_pending");
    assert.deepEqual(second.messages.map(message => message.text), ["Between approvals"]);
    assert.equal(readFileSync(marker, "utf8"), "before\nbetween\n");
    assert.equal(readFileSync(join(root, "first.json"), "utf8"), firstBytes);
    const next = JSON.parse(readFileSync(join(root, "second.json"), "utf8"));
    assert.notEqual(next.approval_ref, checkpoint.approval_ref);
    assert.equal(next.run_id, checkpoint.run_id);
    for (const decision of ["rejected", "approved"]) {
      const result = await engine.run({ ...options, humanResumeCheckpoint: "second.json",
        humanCheckpointOut: "third.json", humanDecisions: { [next.approval_ref]: decision } });
      assert.equal(result.reason, decision === "approved" ? "completed" : "human_approval_rejected");
      assert.deepEqual(result.messages.map(message => message.text), decision === "approved" ? ["After both approvals"] : []);
      assert.equal(existsSync(join(root, "third.json")), false);
      assert.equal(readFileSync(marker, "utf8"), decision === "approved" ? "before\nbetween\nafter\n" : "before\nbetween\n");
    }
    const entries = Object.values(readEffectJournalFixture(join(root, "run.effect-journal.sqlite")).entries);
    assert.equal(entries.length, 3);
    assert.ok(entries.every(entry => entry.state === "applied"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

}
