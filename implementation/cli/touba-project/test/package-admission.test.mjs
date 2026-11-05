import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { newPackage, addPackage, removePackage } from "../src/packages.mjs";
import { initProject, prepareProject, renderReport } from "../src/project.mjs";
import { readPackage } from "../src/package-contract.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { performance } from "node:perf_hooks";
import { verifyInstalledPackages } from "../src/package-store.mjs";
import { loadPreparedPackageAdmission } from "../../touba-project-server/src/prepared-project.mjs";
import { issuePackageAdmission, packageAdmissionEvidence, withSupplyChainAdmission } from "../../../contracts/package-admission.mjs";
import { createToubaProjectServer } from "../../touba-project-server/src/serve.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

test("package admission captures immutable host evidence and rejects a JSON substitute", () => {
  const metadata = { authority: "project_admission", packages: [{ name: "example.export", version: "1.0.0", tools: [] }] };
  const token = issuePackageAdmission(metadata);
  metadata.packages[0].version = "unverified";
  const captured = packageAdmissionEvidence(token);
  assert.equal(captured.packages[0].version, "1.0.0");
  assert.match(captured.admission_id, /^sha256:[a-f0-9]{64}$/);
  captured.packages[0].version = "forged";
  assert.equal(packageAdmissionEvidence(token).packages[0].version, "1.0.0");
  for (const forged of [captured, JSON.parse(JSON.stringify(token)), null]) {
    assert.throws(() => packageAdmissionEvidence(forged), { code: "PackageAdmissionInvalid" });
  }
  const verified = withSupplyChainAdmission(token, { state: "verified", required: true, digest: `sha256:${"a".repeat(64)}` });
  assert.notEqual(packageAdmissionEvidence(verified).admission_id, packageAdmissionEvidence(token).admission_id);
  assert.equal(packageAdmissionEvidence(token).supply_chain, undefined);
  assert.throws(() => issuePackageAdmission({ value: "x".repeat(1024 * 1024) }), /PackageAdmissionTooLarge/);
});

for (const operation of ["export", "deployment"]) test(`package ${operation}: retained approval, CLI/SDK admission, versioned trace and tamper diagnostics`, async t => {
  const name = `example.${operation}`, ref = `tool:${name}/Execute`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-admission-")));
  const engines = [];
  t.after(async () => { for (const engine of engines) await engine.close(); rmSync(root, { recursive: true, force: true }); });
  const source = newPackage(name, { root }).path;
  const packageFile = join(source, "touba.package.json");
  const packageDocument = json(packageFile);
  Object.assign(packageDocument, { publisher: "test", license: "MIT", exports: { tools: [ref] },
    handlers: [{ tool: ref, path: "handlers/export.mjs", protocol: "touba-tool-handler-v1" }] });
  save(packageFile, packageDocument);
  const declaration = approval => `module ${name}\ntool Execute\n    takes value as Text\n    gives Text\n${approval ? '    human.approve\n        with role as "reviewer"\n' : ''}`;
  const sourcePath = join(source, `src/example/${operation}.tb`);
  writeFileSync(sourcePath, declaration(true));
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/export.mjs"), `let text=''; for await(const c of process.stdin) text+=c; const request=JSON.parse(text); process.stdout.write(JSON.stringify({ok:true,value:request.arguments.value}));`);
  const project = join(root, "consumer"); mkdirSync(project); initProject({ root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main\nimport tool Execute from ${name}\nstrategy Run\n    takes value as Text\n    gives Text\n    uses Execute\n    do\n        Execute\n            with value as value\n            into result\n        give result\n`);
  await addPackage(source, { root: project });
  const options = { root: project, entryRef: "strategy:client.main/Run", mode: "write", hostDecisions: {
    bindings: { [ref]: { package_handler: name, effect_contract: { kind: "none" } } } } };
  let report = await prepareProject(options);
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  const configPath = join(project, "touba.project.json");
  assert.deepEqual(json(configPath).configuration.tool_policies[ref], { role: "reviewer" });

  // A publisher's new version removes approval. A remove/add and build cleanup
  // must not erase the application's persisted policy or implicitly accept it.
  await removePackage(name, { root: project });
  packageDocument.version = "0.1.1"; save(packageFile, packageDocument);
  writeFileSync(sourcePath, declaration(false));
  await addPackage(source, { root: project });
  rmSync(join(project, ".touba/build"), { recursive: true, force: true });
  const before = readFileSync(configPath, "utf8");
  report = await prepareProject(options);
  assert.ok(report.diagnostics.some(d => d.code === "PackageGovernanceReviewRequired"), JSON.stringify(report));
  assert.match(renderReport(report), /approval_policy:.*reviewer.*-> null/);
  assert.equal(readFileSync(configPath, "utf8"), before, "refused preparation must be atomic");
  const digest = readPackage(packageFile).digest;
  report = await prepareProject({ ...options, hostDecisions: { ...options.hostDecisions, review_packages: { [name]: digest } } });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  assert.deepEqual(json(join(project, ".touba/build/dev/touba.manifest.json")).bindings[ref].approval_policy, { role: "reviewer" });
  assert.equal((await prepareProject({ ...options, mode: "check" })).status, "success");
  const serverProof = packageAdmissionEvidence(loadPreparedPackageAdmission(project, ".touba/build/dev/air/client/main.air.json"));
  assert.equal(serverProof.packages[0].version, "0.1.1");
  const verifyStart = performance.now();
  for (let i = 0; i < 10; i++) verifyInstalledPackages(project, json(configPath).packages);
  t.diagnostic(JSON.stringify({ integrity_checks: 10, total_ms: +(performance.now()-verifyStart).toFixed(2) }));
  writeFileSync(join(project, "authority.mjs"), `export const initiatorRef="user:author"; export function attestHumanApproval({request,decision}) { return {request_id:request.request_id,run_id:request.run_id,decision,subject_ref:"user:reviewer",roles:["reviewer"]}; }`);

  for (const executionMode of ["process", "persistent"]) {
    const engine = new ToubaEngine({ projectRoot: project, executionMode, command: process.execPath, commandArgs: [cli] }); engines.push(engine);
    const common = { project, humanApprovalHost: "authority.mjs", humanCheckpointOut: `pending-${executionMode}.json` };
    const pending = await engine.run({ ...common, inputs: { value: `generic ${operation} request` } });
    assert.equal(pending.reason, "human_approval_pending");
    const checkpoint = json(join(project, common.humanCheckpointOut));
    const result = await engine.run({ ...common, humanResumeCheckpoint: common.humanCheckpointOut,
      humanDecisions: { [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "test" } } });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.result, `generic ${operation} request`);
    const evidence = result.trace.events.find(e => e.kind === "package_admission_verified").payload;
    assert.equal(evidence.packages[0].version, "0.1.1");
    assert.equal(evidence.packages[0].digest, digest);
    assert.match(evidence.package_lock_digest, /^sha256:/);
    const approval = result.trace.events.find(e => e.kind === "tool_approval_authorized");
    const admitted = result.trace.events.find(e => e.kind === "package_tool_admitted");
    assert.equal(admitted.payload.approval_request_id, approval.payload.request_id);
    assert.equal(admitted.payload.admission_id, evidence.admission_id);
    assert.ok(!JSON.stringify(evidence).includes(root));
    const signed = result.trace.events.find(e => e.kind === "human_approval_decided");
    assert.match(signed.payload.signer_ref, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result.trace).includes("user:reviewer"));
    assert.equal(signed.payload.request_id, approval.payload.request_id);
    t.diagnostic(JSON.stringify({ transport: executionMode, admission_bytes: Buffer.byteLength(JSON.stringify(evidence)), trace_events: result.trace.events.length }));
    await assert.rejects(engine.run({ ...common, humanResumeCheckpoint: common.humanCheckpointOut,
      humanDecisions: { [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "test" } } }), error => error.code === "HumanApprovalCheckpointAlreadyConsumed");
  }
  const stored = createSqliteTraceStore({filename:join(project, ".touba/traces.sqlite"), readOnly:true});
  try {
    const events = [...stored.segments()].flatMap(segment => [...stored.events(segment.id)]);
    const admitted = events.find(event => event.kind === "package_admission_verified");
    assert.equal(admitted.payload.packages[0].digest, digest);
    assert.equal(admitted.payload.packages[0].version, "0.1.1");
    const exported = [...stored.segments()].map(segment => JSON.parse([...stored.json(segment.id)].join("")));
    assert.ok(exported.some(trace => trace.events.some(event => event.kind === "package_tool_admitted" && event.payload.approval_request_id)));
  } finally { stored.close(); }
  // The HTTP server must enforce the consumer-only obligation too.
  if (operation === "export") {
    const service = createToubaProjectServer({ projectRoot: project, port: 0, quiet: true,
      humanApprovalAuthority: ({request, decision}) => ({request_id: request.request_id, run_id: request.run_id,
        decision, subject_ref: "user:reviewer", roles: ["reviewer"]}) });
    try {
      await service.start();
      const base = `http://127.0.0.1:${service.server.address().port}`;
      const post = (route, data) => fetch(base + route, {method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(data)});
      const response = await post("/runs/sandbox", {schema_version:"touba-sandbox-run-request-v1", execution_kind:"entrypoint",
        target_ref:"strategy:client.main/Run", inputs:{value:"HTTP export"}, effect_policy:"allow_declared_external_effects",
        requested_by:{kind:"service",id:"package-test"}, reason:"Verify retained package approval"});
      const pendingRun = await response.json();
      assert.equal(pendingRun.reason, "human_approval_pending", JSON.stringify(pendingRun));
      const pending = await (await fetch(base + "/approvals/pending/current")).json();
      const decision = await post("/decisions", {schema_version:"touba-approval-decision-v1", request_id:pending.request_id,
        run_id:pending.run_id, trace_ref:pending.trace_ref, user_ref:"user:reviewer", device_ref:"device:test", decision:"approve",
        decided_by:"user:reviewer", decided_at:new Date().toISOString(), comment:null, client_ref:"package-test", evidence_ref:"test"});
      assert.equal(decision.status, 202, await decision.clone().text());
      const resumed = await post("/runs/sandbox/resume", {request_id:pending.request_id});
      const done = await resumed.json();
      assert.equal(done.status, "success", JSON.stringify(done));
      assert.ok(done.trace.events.some(event => event.type === "package_admission_verified"));
      assert.ok(done.trace.events.some(event => event.type === "package_tool_admitted"));
    } finally { await service.stop(); }
  }
  // Even a same-contract update must not inherit an already paused approval.
  const engine = engines[0], checkpointName = "before-update.json";
  const paused = await engine.run({project, inputs:{value:"paused request"}, humanApprovalHost:"authority.mjs", humanCheckpointOut:checkpointName});
  assert.equal(paused.reason, "human_approval_pending");
  const checkpoint = json(join(project, checkpointName));
  await removePackage(name, {root:project});
  packageDocument.version = "0.1.2"; save(packageFile, packageDocument);
  await addPackage(source, {root:project});
  assert.equal((await prepareProject(options)).status, "success");
  await assert.rejects(engine.run({project, humanApprovalHost:"authority.mjs", humanResumeCheckpoint:checkpointName,
    humanDecisions:{[checkpoint.approval_ref]:{decision:"approved", evidence_ref:"test"}}}), error => {
      assert.equal(error.code, "HumanApprovalCheckpointIncompatible");
      assert.ok(!error.details.trace.events.some(event => event.kind === "tool_call_started"));
      return true;
    });
  const installed = join(project, `packages/${name}/handlers/export.mjs`);
  writeFileSync(installed, readFileSync(installed, "utf8") + "\n// tampered fixture\n");
  for (const engine of engines) await assert.rejects(engine.run({ project, inputs: { value: "no dispatch" } }), error => error.code === "PackageIntegrityMismatch");
  const python = spawnSync(process.env.TOUBA_HOST_PYTHON ?? process.env.TOUBA_TEST_PYTHON ?? "python3", ["-c", `import sys, asyncio
from touba_sdk import ToubaEngine, AsyncToubaEngine, ToubaEngineError
options = dict(command=sys.argv[2], command_args=[sys.argv[3]])
def sync_test():
    try:
        ToubaEngine(sys.argv[1], **options).run(project=sys.argv[1], inputs={"value":"no dispatch"})
    except ToubaEngineError as exc:
        assert exc.code == "PackageIntegrityMismatch", exc.code
        return
    raise AssertionError("tampered package accepted")
async def async_test():
    try:
        await AsyncToubaEngine(sys.argv[1], **options).run(project=sys.argv[1], inputs={"value":"no dispatch"})
    except ToubaEngineError as exc:
        assert exc.code == "PackageIntegrityMismatch", exc.code
        return
    raise AssertionError("tampered package accepted")
sync_test()
asyncio.run(async_test())
print("PackageIntegrityMismatch")
`, project, process.execPath, cli],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: process.env.TOUBA_HOST_PYTHON ? "" : fileURLToPath(new URL("../../../runtime/touba-python-sdk/src", import.meta.url)) } });
  assert.equal(python.status, 0, python.stdout + python.stderr);
  assert.equal(python.stdout.trim(), "PackageIntegrityMismatch");
});
