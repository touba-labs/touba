import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine, ToubaEngineError } from "../src/index.mjs";

test("real CLI and SDK distinguish completion, pauses, stops, human refusal, cancellation and errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-engine-outcomes-"));
  try {
    const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
      commandArgs: [fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url))] });
    const run = async (body, options = {}) => {
      writeFileSync(join(root, "program.tb"), `module outcomes\nstrategy Run\n    do\n${body}\n`);
      return engine.run({ source: "program.tb", ...options });
    };
    const success = await run('        show\n            with message as "Private business message"\n        give "done"');
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
    await assert.rejects(engine.run(nested), error => {
      assert.equal(error.details.reason, "HumanApprovalCheckpointUnsupportedScope");
      assert.equal(error.details.status, "failure");
      assert.equal(existsSync(join(root, "nested.checkpoint.json")), false);
      return true;
    });
    const unavailable = new ToubaEngine({ projectRoot: root, command: join(root, "missing-cli") });
    await assert.rejects(unavailable.run({ airJson: {} }), error => error instanceof ToubaEngineError && error.details.code === "ENOENT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK forwards an explicit durable journal, refuses unjournaled writes and preserves fresh-run identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-engine-effects-"));
  try {
    const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
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
    const effectJournal = join(root, "sdk.effect-journal.json");
    for (let index = 0; index < 2; index++) {
      assert.equal((await engine.run({ ...request, effectJournal })).result, "stored");
      assert.equal(existsSync(effectJournal + ".lock"), false);
    }
    assert.equal(readFileSync(marker, "utf8"), "record\nrecord\n");
    const entries = Object.values(JSON.parse(readFileSync(effectJournal, "utf8")).entries);
    assert.equal(new Set(entries.map(entry => entry.effect_scope_id)).size, 2);
    assert.deepEqual(entries.map(entry => entry.state), ["applied", "applied"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
