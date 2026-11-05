import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initProject, prepareProject } from "../src/project.mjs";
import { newPackage, addPackage } from "../src/packages.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { openCliEffectJournal } from "../../touba-run/src/effect-journal.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const sdk = new URL("../../../runtime/touba-handler-sdk/src/index.mjs", import.meta.url).href;
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-approval-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const origin of ["module", "package"]) test(`prepare preserves tool approval through direct and transitive ${origin} imports`, async t => {
  const root = workspace(t), project = join(root, "consumer");
  initProject({ root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  const module = "example.payments", ref = `tool:${module}/Pay`, plainRef = `tool:${module}/Status`;
  const source = `module ${module}\ntool Pay\n    gives Int\n    human.approve\n        with role as "finance"\n\ntool Status\n    gives Int\n\nskill Commit\n    gives Int\n    uses Pay\n    do\n        Pay\n            into result\n        give result\n`;
  if (origin === "package") {
    const author = newPackage(module, { root });
    writeFileSync(join(author.path, "src/example/payments.tb"), source);
    const metadata = JSON.parse(readFileSync(join(author.path, "touba.package.json")));
    metadata.exports = { tools: [ref, plainRef], skills: [`skill:${module}/Commit`] };
    json(join(author.path, "touba.package.json"), metadata);
    await addPackage(author.path, { root: project });
  } else {
    mkdirSync(join(project, "src/example"), { recursive: true });
    writeFileSync(join(project, "src/example/payments.tb"), source);
  }
  for (const [name, kind, target] of [["direct", "tool", "Pay"], ["transitive", "skill", "Commit"]]) {
    writeFileSync(join(project, `src/client/${name}.tb`), `module client.${name}\nimport ${kind} ${target} from ${module}\nlimits run\n    max_tool_calls as 1\nstrategy Run\n    gives Int\n    uses ${target}\n    do\n        ${target}\n            into result\n        give result\n`);
  }
  writeFileSync(join(project, "src/client/plain.tb"), `module client.plain\nimport tool Status from ${module}\nstrategy Run\n    gives Int\n    uses Status\n    do\n        Status\n            into result\n        give result\n`);
  const config = JSON.parse(readFileSync(join(project, "touba.project.json")));
  config.entry = "strategy:client.direct/Run"; config.entrypoints = ["strategy:client.transitive/Run", "strategy:client.plain/Run"];
  json(join(project, "touba.project.json"), config);
  const handler = join(project, "payment.mjs"), ledger = join(project, "payments.txt");
  const plainHandler = join(project, "status.mjs");
  writeFileSync(plainHandler, `import {defineTool} from ${JSON.stringify(sdk)};
await defineTool({toolRef:${JSON.stringify(plainRef)},run:()=>42});`);
  writeFileSync(handler, `import {defineTool,createToolResult} from ${JSON.stringify(sdk)};
import {appendFileSync} from 'node:fs';
await defineTool({toolRef:${JSON.stringify(ref)},run:async({context})=>{
appendFileSync(${JSON.stringify(ledger)},'paid\\n');
return createToolResult(7,{effectReceipt:context.createEffectReceipt({outcome:'applied'})});
}});`);
  const prepared = await prepareProject({ root: project, mode: "write", hostDecisions: { bindings: {
    [ref]: { handler: { kind: "process", command: process.execPath, args: [handler] },
      effect_contract: { kind: "external_write", retry_mode: "none" } },
    [plainRef]: { handler: { kind: "process", command: process.execPath, args: [plainHandler] },
      effect_contract: { kind: "none" } },
  } } });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  for (const name of ["direct", "transitive"]) {
    const air = JSON.parse(readFileSync(join(project, `.touba/build/dev/air/client/${name}.air.json`)));
    assert.deepEqual(air.required_features, ["tool_operation_approval"]);
    validateAirMachineContract(air);
  }
  assert.equal(JSON.parse(readFileSync(join(project, ".touba/build/dev/air/client/plain.air.json"))).required_features, undefined);
  writeFileSync(join(project, "authority.mjs"), `export function attestHumanApproval({request,decision}) {
return {request_id:request.request_id,run_id:request.run_id,decision,subject_ref:'reviewer',roles:['finance']};
}`);
  let effects = 0;
  for (const executionMode of ["process", "persistent"]) {
    const engine = new ToubaEngine({ projectRoot: project, command: process.execPath, commandArgs: [cli], executionMode });
    try {
      assert.equal((await engine.run({ project: ".", entryRef: "strategy:client.plain/Run" })).result, 42);
      for (const name of ["direct", "transitive"]) {
        const label = `${name}-${executionMode}`;
        const options = { project: ".", entryRef: `strategy:client.${name}/Run`, humanApprovalHost: "authority.mjs",
          humanCheckpointOut: `${label}.json`, effectJournal: `${label}.effect-journal.sqlite` };
        const pending = await engine.run(options);
        assert.equal(pending.reason, "human_approval_pending");
        assert.equal(existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0, effects);
        const checkpoint = JSON.parse(readFileSync(join(project, `${label}.json`)));
        const resume = { ...options, humanResumeCheckpoint: `${label}.json`, humanDecisions: {
          [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "test-proof" },
        } };
        assert.equal((await engine.run(resume)).result, 7);
        effects++;
        await assert.rejects(engine.run(resume), error => error.code === "HumanApprovalCheckpointAlreadyConsumed");
        assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, effects);
      }
    } finally { await engine.close(); }
  }
});

async function diagnosticProject(t) {
  const root = workspace(t);
  initProject({ root });
  mkdirSync(join(root, "src/client"), { recursive: true });
  writeFileSync(join(root, "src/client/main.tb"), "module client.main\nstrategy Allowed\n    gives Int\n    do\n        give 42\nstrategy Hidden\n    gives Int\n    do\n        give 99\n");
  const config = JSON.parse(readFileSync(join(root, "touba.project.json")));
  config.entry = "strategy:client.main/Allowed"; json(join(root, "touba.project.json"), config);
  const report = await prepareProject({ root, mode: "write" });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  return root;
}

for (const kind of ["entry", "journal"]) test(`${kind} admission preserves its code through CLI and JavaScript transports`, async t => {
  const root = await diagnosticProject(t), journal = join(root, "private-name.effect-journal.sqlite");
  const lease = kind === "journal" ? openCliEffectJournal(journal) : null;
  const expected = kind === "entry" ? "ProjectEntrypointNotAllowed" : "EffectJournalBusy";
  const options = { project: root, ...(kind === "entry" ? { entryRef: "strategy:client.main/Hidden" } : { effectJournal: journal }) };
  try {
    for (const output of ["json", "json-reference"]) {
      const result = spawnSync(process.execPath, [cli, "run", "--project", root, "--output", output,
        ...(kind === "entry" ? ["--entry", "strategy:client.main/Hidden"] : ["--effect-journal", journal])], { encoding: "utf8", cwd: root });
      assert.equal(result.status, kind === "entry" ? 2 : 1, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.reason, expected);
      assert.equal(envelope.trace.run.admission, "refused");
      assert.deepEqual(envelope.trace.events.map(e => e.kind), ["admission_refused"]);
      assert.equal(result.stdout.includes(root), false);
      assert.equal(result.stdout.includes("private-name"), false);
    }
    for (const executionMode of ["process", "persistent"]) {
      const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli], executionMode });
      try {
        await assert.rejects(engine.run(options), error => { assert.equal(error.code, expected); return true; });
      } finally { await engine.close(); }
    }
  } finally { lease?.close(); }
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli] });
  try { assert.equal((await engine.run({ project: root, effectJournal: journal })).result, 42); }
  finally { await engine.close(); }
});

test("installed Python sync and async SDKs preserve project and journal admission codes", { skip: !process.env.TOUBA_HOST_PYTHON }, async t => {
  const root = await diagnosticProject(t), journal = join(root, "python.effect-journal.sqlite");
  const lease = openCliEffectJournal(journal);
  try {
    const script = `import asyncio, sys
from touba_sdk import ToubaEngine, AsyncToubaEngine, ToubaEngineError
root, node, cli, journal = sys.argv[1:]
cases = [({'project':root,'entry_ref':'strategy:client.main/Hidden'},'ProjectEntrypointNotAllowed'),
         ({'project':root,'effect_journal':journal},'EffectJournalBusy')]
engine = ToubaEngine(project_root=root,command=node,command_args=[cli])
for options, code in cases:
    try: engine.run(**options)
    except ToubaEngineError as error: assert error.code == code, (error.code, code)
    else: raise AssertionError('expected admission refusal')
async def check():
    engine = AsyncToubaEngine(project_root=root,command=node,command_args=[cli])
    for options, code in cases:
        try: await engine.run(**options)
        except ToubaEngineError as error: assert error.code == code, (error.code, code)
        else: raise AssertionError('expected admission refusal')
asyncio.run(check())
`;
    const result = spawnSync(process.env.TOUBA_HOST_PYTHON, ["-I", "-B", "-c", script, root, process.execPath, cli, journal],
      { encoding: "utf8", cwd: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { lease.close(); }
});
