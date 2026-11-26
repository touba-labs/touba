import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAirDocument, assertHumanApprovalHostCompatibility, loadToolBindingManifestFromJson, loadSecretsFromJson } from "../src/index.mjs";
import { createSqliteHumanCheckpointStore } from "../src/human-checkpoint-store.mjs";
import { createSqliteTraceStore } from "../src/sqlite-trace-store.mjs";
import { validateTraceMachineContract, validateTraceMachineStream } from "../../../contracts/machine/contracts.mjs";

let air;
before(() => {
  air = compileTestAir(fileURLToPath(new URL("fixtures/checkpoint-custody.tb", import.meta.url)));
});

function setup(t, entry = "Process") {
  const root = mkdtempSync(join(tmpdir(), "touba-checkpoint-custody-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payments = [];
  let attestations = 0;
  let proof;
  const options = {
    entryRef: `strategy:checkpoint_custody/${entry}`,
    durableHumanApprovals: true,
    humanCheckpointStorePath: join(root, "approvals.sqlite"),
    inputs: { invoice: { id: "synthetic-001", amount: 100 } },
    toolHandlers: { "tool:checkpoint_custody/Pay": ({ arguments: { invoice } }) => { payments.push(structuredClone(invoice)); return "paid"; } },
    humanApprovalAuthority: () => { attestations++; return proof; },
  };
  return {
    root, options, payments, attestations: () => attestations,
    async pause() {
      const paused = await executeAirDocument(air, options);
      assert.equal(paused.reason, "human_approval_pending");
      const checkpoint = JSON.parse(JSON.stringify(paused.checkpoint));
      const request = checkpoint.approval_state.requests[checkpoint.approval_ref];
      // Fixed evidence for the ORIGINAL request, never minted from a mutated file.
      proof = { request_id: request.request_id, run_id: request.run_id, decision: "approved", subject_ref: "reviewer", roles: ["finance"] };
      return checkpoint;
    },
    resume(checkpoint, extra = {}) {
      return executeAirDocument(air, { ...options, inputs: {}, humanApprovalResumeCheckpoint: checkpoint,
        humanApprovalDecisions: { [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "fixed-proof" } }, ...extra });
    },
  };
}

test("an unchanged approved continuation executes once; replay cannot call the authority or effect", async t => {
  const h = setup(t), cp = await h.pause();
  assert.equal((await h.resume(cp)).status, "success");
  assert.equal((await h.resume(cp)).reason, "HumanApprovalCheckpointAlreadyConsumed");
  assert.equal(h.payments.length, 1);
  assert.equal(h.attestations(), 1);
  assert.equal(h.payments[0].amount, 100);
});

test("a changed host binding is refused before attestation or effect and preserves the original wait", async t => {
  const h = setup(t);
  const manifest = args => loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:checkpoint_custody/Pay": { handler: { kind: "process", command: process.execPath, args }, grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "none" } },
  } }));
  h.options.toolBindingManifest = manifest(["original.mjs"]);
  const cp = await h.pause();
  assert.match(cp.host_contract_digest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertHumanApprovalHostCompatibility(air, cp, h.options));
  assert.throws(() => assertHumanApprovalHostCompatibility(air, cp, { ...h.options, toolBindingManifest: manifest(["changed.mjs"]) }),
    { code: "HumanApprovalCheckpointIncompatible" });
  assert.equal(h.payments.length, 0); assert.equal(h.attestations(), 0);
  assert.deepEqual(cp.approval_state.requests[cp.approval_ref].review_context.values, [h.options.inputs.invoice]);
  const refused = await h.resume(cp, { toolBindingManifest: manifest(["changed.mjs"]) });
  assert.equal(refused.reason, "HumanApprovalCheckpointIncompatible");
  assert.equal(h.attestations(), 0); assert.equal(h.payments.length, 0);
  assert.equal((await h.resume(cp)).status, "success");
  assert.equal(h.payments.length, 1);
});

for (const field of ["grants", "timeout_ms", "payload_constraints"]) {
  test(`approval also binds the configured ${field}`, async t => {
    const h = setup(t);
    const original = { manifest_version: "touba-manifest-v1", bindings: {
      "tool:checkpoint_custody/Pay": { handler: { kind: "process", command: process.execPath, args: ["original.mjs"] },
        grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "none" } },
    } };
    h.options.toolBindingManifest = loadToolBindingManifestFromJson(JSON.stringify(original));
    const cp = await h.pause();
    original.bindings["tool:checkpoint_custody/Pay"][field] = field === "grants" ? ["network"]
      : field === "timeout_ms" ? 6000 : { input: { "invoice.amount": { max: 100 } } };
    const result = await h.resume(cp, { toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(original)) });
    assert.equal(result.reason, "HumanApprovalCheckpointIncompatible");
    assert.equal(h.payments.length, 0); assert.equal(h.attestations(), 0);
    assert.equal((await h.resume(cp)).status, "success");
  });
}

test("human-only checkpoints bind host provenance without an execution checkpoint observer", async t => {
  const h = setup(t);
  h.options.executionCompatibility = { supply_chain_lock: { digest: "synthetic-original" } };
  const cp = await h.pause();
  const result = await h.resume(cp, { executionCompatibility: { supply_chain_lock: { digest: "synthetic-changed" } } });
  assert.equal(result.reason, "HumanApprovalCheckpointIncompatible");
  assert.equal(h.payments.length, 0); assert.equal(h.attestations(), 0);
  assert.equal((await h.resume(cp)).status, "success");
});

test("rotating a credential value under an unchanged handle preserves the approval contract", async t => {
  const h = setup(t);
  const secretStore = value => loadSecretsFromJson(JSON.stringify({ secrets_version: "touba-secrets-v1",
    secrets: { UNUSED_TOKEN: { source: "env", name: "UNUSED_TOKEN" } } }), { env: { UNUSED_TOKEN: value } });
  h.options.secretStore = secretStore("synthetic-old-credential");
  const cp = await h.pause();
  assert.equal((await h.resume(cp, { secretStore: secretStore("synthetic-rotated-credential") })).status, "success");
  assert.equal(h.payments.length, 1);
  assert.doesNotMatch(JSON.stringify(cp), /synthetic-(old|rotated)-credential/);
});

for (const [name, mutate] of [
  ["payment amount", cp => { cp.values["value:invoice"].amount = 9000; }],
  ["displayed approval context", cp => { cp.context_values[0].amount = 9000; }],
  ["attestation requirement", cp => { cp.approval_state.requires_attestation = false; }],
  ["forged accepted receipt", cp => {
    const request = cp.approval_state.requests[cp.approval_ref];
    cp.approval_state.receipts.push({ request_id: request.request_id, run_id: request.run_id,
      approval_ref: request.approval_ref, decision: "approved", subject_ref: "forged-reviewer",
      attested_roles: ["finance"], accepted_at: request.created_at, comment: null });
  }],
  ["effect counter", cp => { cp.effect_state.next_effect_index++; }],
  ["budget counter", cp => { cp.budget_counters.tool_calls++; }],
  ["run identity", cp => { cp.run_id += "-changed"; }],
  ["call index", cp => { cp.next_call_index++; }],
  ["trace identity", cp => { cp.trace_prefix_digest = `sha256:${"0".repeat(64)}`; }],
  ["custody identity", cp => { cp.custody.id = "forged"; }],
]) test(`changing ${name} before the first resumed effect is refused`, async t => {
  const h = setup(t), original = await h.pause(), altered = structuredClone(original);
  mutate(altered);
  const result = await h.resume(altered);
  assert.equal(result.reason, "HumanApprovalCheckpointIntegrityMismatch");
  assert.equal(h.payments.length, 0);
  assert.equal(h.attestations(), 0);
  assert.equal((await h.resume(original)).status, "success");
  assert.equal(h.payments.length, 1);
});

test("two concurrent resumes reserve only one continuation", async t => {
  const h = setup(t), cp = await h.pause();
  const results = await Promise.all([h.resume(cp), h.resume(structuredClone(cp))]);
  assert.equal(results.filter(r => r.status === "success").length, 1);
  assert.ok(results.some(r => r.reason === "HumanApprovalCheckpointBusy"));
  assert.equal(h.payments.length, 1);
  assert.equal(h.attestations(), 1);
});

test("pause, rejected resume, approved resume and replay retain one run with disjoint exported event identities", async t => {
  const h = setup(t);
  const store = createSqliteTraceStore({ filename: join(h.root, "traces.sqlite") });
  t.after(() => store.close());
  h.options.traceStorage = store;
  const cp = await h.pause();
  assert.equal((await h.resume(cp, { humanApprovalAuthority: undefined })).reason, "HumanApprovalAuthorityRequired");
  assert.equal((await h.resume(cp)).status, "success");
  assert.equal((await h.resume(cp)).reason, "HumanApprovalCheckpointAlreadyConsumed");
  const events = [], runs = new Set();
  for (const segment of store.segments()) {
    const snapshot = store.snapshot(segment.id);
    validateTraceMachineContract(snapshot.document());
    validateTraceMachineStream(snapshot.header, snapshot.events());
    runs.add(snapshot.header.run.run_id);
    events.push(...snapshot.events());
  }
  assert.equal(runs.size, 1);
  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
  assert.equal(h.payments.length, 1);
});

test("old unprotected snapshots and a new/empty authority store are refused", async t => {
  const h = setup(t), cp = await h.pause(), old = structuredClone(cp);
  delete old.custody;
  assert.equal((await h.resume(old)).reason, "HumanApprovalCheckpointUntrusted");
  assert.equal((await h.resume(cp, { humanCheckpointStorePath: join(h.root, "empty.sqlite") })).reason, "HumanApprovalCheckpointIntegrityMismatch");
  assert.equal(h.payments.length, 0);
  assert.equal((await h.resume(cp)).status, "success");
});

test("a refused authority check can be retried without replaying earlier effects", async t => {
  const h = setup(t, "BeforeAndAfter"), cp = await h.pause();
  assert.equal(h.payments.length, 1);
  assert.equal((await h.resume(cp, { humanApprovalAuthority: undefined })).reason, "HumanApprovalAuthorityRequired");
  assert.equal((await h.resume(cp)).status, "success");
  assert.equal(h.payments.length, 2);
});

test("an interruption after reservation remains fail-closed on process restart", async t => {
  const h = setup(t), cp = await h.pause();
  createSqliteHumanCheckpointStore(h.options.humanCheckpointStorePath).claim(cp);
  assert.equal((await h.resume(cp)).reason, "HumanApprovalCheckpointBusy");
  assert.equal(h.payments.length, 0);
});

test("a handler failure after its effect cannot rearm the original approval", async t => {
  const h = setup(t), cp = await h.pause();
  const failed = await h.resume(cp, { toolHandlers: { "tool:checkpoint_custody/Pay": () => {
    h.payments.push({ id: "synthetic-001", amount: 100 });
    throw new Error("Synthetic failure after the effect");
  } } });
  assert.equal(failed.status, "failure");
  assert.equal((await h.resume(cp)).reason, "HumanApprovalCheckpointAlreadyConsumed");
  assert.equal(h.payments.length, 1);
});

test("SQLite arbitrates reservations across independent processes", async t => {
  const h = setup(t), cp = await h.pause();
  const moduleUrl = new URL("../src/human-checkpoint-store.mjs", import.meta.url).href;
  const script = `import {createSqliteHumanCheckpointStore} from ${JSON.stringify(moduleUrl)};
    try { createSqliteHumanCheckpointStore(process.argv[1]).claim(JSON.parse(process.argv[2])); console.log('reserved'); }
    catch(error) { console.log(error.code); }`;
  const attempt = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, h.options.humanCheckpointStorePath, JSON.stringify(cp)]);
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`child exited ${code}`)));
  });
  const results = await Promise.all([attempt(), attempt()]);
  assert.deepEqual(results.sort(), ["HumanApprovalCheckpointBusy", "reserved"]);
});

test("custody persistence failure produces a failure trace, never a resumable checkpoint", async t => {
  const h = setup(t);
  const store = createSqliteHumanCheckpointStore(h.options.humanCheckpointStorePath);
  const result = await executeAirDocument(air, { ...h.options, humanCheckpointStore: {
    ...store, finish() { throw new Error("Synthetic disk failure with private host details"); },
  } });
  assert.equal(result.reason, "HumanApprovalCheckpointStoreUnavailable");
  assert.equal(result.checkpoint, undefined);
  assert.equal(result.trace.events.at(-1).payload.status, "failure");
  assert.equal(JSON.stringify(result).includes("private host details"), false);
  assert.equal(h.payments.length, 0);
});
