import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { ToubaEngine as SourceEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { createSqliteEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import { stateCommand } from "../src/state-command.mjs";

const cli = process.env.TOUBA_TEST_CLI ?? fileURLToPath(new URL("../src/main.mjs",import.meta.url));
const sdk = pathToFileURL(process.env.TOUBA_TEST_SDK ?? fileURLToPath(new URL("../../../runtime/touba-handler-sdk/src/index.mjs",import.meta.url))).href;
const ToubaEngine = process.env.TOUBA_TEST_SDK ? (await import(sdk)).ToubaEngine : SourceEngine;
const json = (path,value) => writeFileSync(path,JSON.stringify(value));
const command = (args,cwd) => spawnSync(process.execPath,[cli,...args],{cwd,encoding:"utf8"});
async function fixture(t, approval = false) {
  const root = mkdtempSync(join(tmpdir(),"touba-compensation-cli-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"payment.tb"),`module demo.payment
tool Pay
    gives Text
tool Refund
    gives Text
strategy Book
    gives Text
    uses Pay
    do
        Pay
            into receipt
        give receipt
strategy Undo
    gives Text
    uses Refund
    do
${approval ? '        human.approve\n            with context as "Refund invoice"\n            into approval\n' : ''}        Refund
            into result
        give result
`);
  const compiled = command(["compile","payment.tb","--out","payment.air.json"],root);
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const bindings = {};
  for (const name of ["Pay","Refund"]) {
    const tool = `tool:demo.payment/${name}`;
    writeFileSync(join(root,`${name}.mjs`),`import {defineTool,createToolResult} from ${JSON.stringify(sdk)};
import {appendFileSync} from "node:fs";
await defineTool({toolRef:${JSON.stringify(tool)},inputSignature:[],outputType:"builtin:Text",run:async ({context})=>{
appendFileSync(${JSON.stringify(join(root,"calls.txt"))},${JSON.stringify(name+"\n")});
return createToolResult("ok",{effectReceipt:context.createEffectReceipt({outcome:"applied",receipt_ref:"invoice:17"}),
...(context.compensation ? {compensationReceipt:context.createCompensationReceipt({result:"completed"})} : {})});
}});`);
    bindings[tool] = {handler:{kind:"process",command:process.execPath,args:[`${name}.mjs`],cwd:"."},grants:[],timeout_ms:5000,max_payload_bytes:65536,
      effect_contract:{kind:"external_write",retry_mode:"idempotency_key",...(name === "Pay" ? {compensation:{entry_ref:"strategy:demo.payment/Undo"}} : {})}};
  }
  json(join(root,"manifest.json"),{manifest_version:"touba-manifest-v1",bindings});
  const effectJournal = join(root,"effects.effect-journal.sqlite");
  const original = command(["run","payment.air.json","--entry","strategy:demo.payment/Book","--manifest","manifest.json","--effect-journal",effectJournal,"--output","json"],root);
  assert.equal(original.status,0,original.stdout+original.stderr);
  const entry = createSqliteEffectJournal(effectJournal,{readOnly:true}).page({limit:10}).items[0];
  assert.equal(entry.state,"applied");
  writeFileSync(join(root,"authority.mjs"),`import {appendFileSync} from "node:fs";
export function checkCompensationAuthority(request) {
appendFileSync(${JSON.stringify(join(root,"authority.txt"))},request.phase+"\\n");
return request.requester_ref === "principal:test" && request.journal_scope_ref === "effect-journal:test";
}`);
  const options = {air:join(root,"payment.air.json"),manifest:join(root,"manifest.json"),effectJournal,store:join(root,"compensations.sqlite"),authorityHost:join(root,"authority.mjs"),
    request:{compensation_request_id:"request:test",compensates_effect_id:entry.effect_id,requester_ref:"principal:test",journal_scope_ref:"effect-journal:test"}};
  return {root,options,entry,engine:new ToubaEngine({projectRoot:root,command:process.execPath,commandArgs:[cli]})};
}
const calls = root => readFileSync(join(root,"calls.txt"),"utf8").trim().split("\n");

test("documented JavaScript host example executes against an actual confirmed effect", async t => {
  const {root,options,engine} = await fixture(t);
  await engine.close();
  const guide = readFileSync(new URL("../../../../docs/guides/compensations-explicites.md",import.meta.url),"utf8");
  const snippet = guide.match(/```js title="create-compensation.mjs"\n([\s\S]*?)```/)[1]
    .replace('"@touba/sdk"',JSON.stringify(sdk))
    .replace('new ToubaEngine({projectRoot: "."})',`new ToubaEngine({projectRoot: ".",command:${JSON.stringify(process.execPath)},commandArgs:[${JSON.stringify(cli)}]})`);
  writeFileSync(join(root,"create-compensation.mjs"),snippet);
  json(join(root,"compensation-request.json"),options.request);
  const result = spawnSync(process.execPath,["create-compensation.mjs"],{encoding:"utf8",cwd:root});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(calls(root),["Pay","Refund"]);
  assert.equal(JSON.parse(readFileSync(join(root,"compensation-result.json"))).result,"completed");
});

test("public JS compensation API dispatches the inverse once, with three authority checks and durable replay", async t => {
  const {root,options,engine} = await fixture(t);
  options.traceStore = join(root,"compensation-traces.sqlite");
  const traceCount = () => {
    const db = new DatabaseSync(options.traceStore,{readOnly:true});
    try { return db.prepare("SELECT count(*) AS n FROM touba_trace_events").get().n; }
    finally { db.close(); }
  };
  try {
    const first = await engine.createCompensation(options);
    assert.equal(first.record.state,"terminal"); assert.equal(first.record.result,"completed");
    assert.deepEqual(calls(root),["Pay","Refund"]);
    assert.deepEqual(readFileSync(join(root,"authority.txt"),"utf8").trim().split("\n"),["lookup","resume","pre_spawn"]);
    const events = traceCount(); assert.ok(events > 0);
    assert.deepEqual((await engine.createCompensation(options)).record,first.record);
    assert.equal(traceCount(),events,"replaying the same command must not duplicate trace events");
    assert.deepEqual(calls(root),["Pay","Refund"]);
    await assert.rejects(engine.createCompensation({...options,request:{...options.request,compensation_request_id:"request:second"}}),{code:"CompensationRequestConflict"});
  } finally { await engine.close(); }
});

test("lookup refusal never opens a journal or creates stores, including authority timeout", async t => {
  const {root,options,engine} = await fixture(t);
  try {
    for (const host of ["refuse","timeout"]) {
      const authorityHost = join(root,`${host}.mjs`);
      writeFileSync(authorityHost,host === "refuse" ? "export function checkCompensationAuthority(){return false;}" : "export async function checkCompensationAuthority(){await new Promise(r=>setTimeout(r,100));return true;}");
      const result = engine.createCompensation({...options,authorityHost,authorityTimeoutMs:10,effectJournal:join(root,"absent.effect-journal.sqlite"),traceStore:join(root,"traces.sqlite")});
      await assert.rejects(result,{code:"CompensationAuthorityRefused"});
      assert.equal(existsSync(options.store),false); assert.equal(existsSync(join(root,"traces.sqlite")),false);
      assert.equal(existsSync(join(root,"absent.effect-journal.sqlite")),false);
    }
    assert.deepEqual(calls(root),["Pay"]);
  } finally { await engine.close(); }
});

test("authority revoked immediately before dispatch prevents the compensation effect", async t => {
  const {root,options,engine} = await fixture(t);
  writeFileSync(options.authorityHost,`export function checkCompensationAuthority(request) {return request.phase !== "pre_spawn";}`);
  try {
    const {record} = await engine.createCompensation(options);
    assert.equal(record.state,"action_required");
    assert.equal(record.blocker_code,"CompensationAuthorityRefused");
    assert.deepEqual(calls(root),["Pay"]);
  } finally { await engine.close(); }
});

test("concurrent host processes share a journal lease and cannot dispatch twice", async t => {
  const {root,options,engine} = await fixture(t);
  const ready = join(root,"authority-ready"), release = join(root,"authority-release");
  writeFileSync(options.authorityHost,`import {existsSync,writeFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
export async function checkCompensationAuthority(request) {
  if(request.phase === "pre_spawn") {
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while(!existsSync(${JSON.stringify(release)})) await delay(10);
  }
  return true;
}`);
  const running = engine.createCompensation({...options,authorityTimeoutMs:5000});
  // Attach immediately so a failed setup cannot leave an unhandled rejection.
  const outcome = running.then(value=>({value}),error=>({error}));
  try {
    for (let attempt=0;attempt<200 && !existsSync(ready);attempt++) await delay(10);
    assert.equal(existsSync(ready),true,"first process reached its pre-dispatch authority check");
    await assert.rejects(engine.createCompensation(options),{code:"EffectJournalBusy"});
    assert.deepEqual(calls(root),["Pay"]);
    writeFileSync(release,"release");
    const result = await running;
    assert.equal(result.record.result,"completed");
    assert.deepEqual(calls(root),["Pay","Refund"]);
    assert.deepEqual((await engine.createCompensation(options)).record,result.record);
    assert.deepEqual(calls(root),["Pay","Refund"]);
  } finally {
    writeFileSync(release,"release");
    await outcome;
    await engine.close();
  }
});

test("public resume requires current revision and explicit approval, then replay remains a read", async t => {
  const {root,options,engine} = await fixture(t,true);
  try {
    const {record} = await engine.createCompensation(options);
    assert.equal(record.state,"action_required"); assert.deepEqual(calls(root),["Pay"]);
    const request = {resume_request_id:"resume:one",compensation_id:record.compensation_id,compensates_effect_id:record.compensates_effect_id,
      expected_revision:record.revision,expected_record_digest:record.record_digest,requester_ref:"principal:test",journal_scope_ref:"effect-journal:test",
      approval_evidence:{schema_version:"touba-compensation-approval-v1",approval_id:"approval-evidence:test",approval_ref:record.approval.approval_ref,
        subject_ref:record.compensation_id,decision:"approved",decided_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}};
    await assert.rejects(engine.resumeCompensation({...options,request:{...request,expected_revision:record.revision+1}}),{code:"CompensationConflict"});
    const result = await engine.resumeCompensation({...options,request});
    assert.equal(result.record.result,"completed"); assert.deepEqual(calls(root),["Pay","Refund"]);
    assert.deepEqual((await engine.resumeCompensation({...options,request})).record,result.record);
    assert.deepEqual(calls(root),["Pay","Refund"]);
  } finally { await engine.close(); }
});

test("documented effect migration preserves applied/unknown records and permits CLI consumption", async t => {
  const {root,options,entry,engine} = await fixture(t);
  try {
    const source = join(root,"effects.json"), destination = join(root,"migrated.effect-journal.sqlite");
    const unknown = {...entry,effect_id:`effect:sha256:${"b".repeat(64)}`,state:"unknown",receipt:{...entry.receipt,effect_id:`effect:sha256:${"b".repeat(64)}`,outcome:"unknown"},result:null};
    delete unknown.result;
    const bytes = JSON.stringify({schema_version:"touba-effect-journal-v1",entries:{[entry.effect_id]:entry,[unknown.effect_id]:unknown}});
    writeFileSync(source,bytes);
    assert.equal(JSON.parse((await stateCommand(["migrate","effects",source,"--out",destination])).text).applied,false);
    assert.equal(existsSync(destination),false);
    await stateCommand(["migrate","effects",source,"--out",destination,"--apply"]);
    assert.equal(readFileSync(source,"utf8"),bytes);
    assert.deepEqual(createSqliteEffectJournal(destination,{readOnly:true}).readEntry(unknown.effect_id),unknown);
    await assert.rejects(stateCommand(["migrate","effects",source,"--out",destination,"--apply"]));
    const result = await engine.createCompensation({...options,effectJournal:destination});
    assert.equal(result.record.result,"completed");
    const bad = command(["run","payment.air.json","--manifest","manifest.json","--effect-journal",source],root);
    assert.notEqual(bad.status,0); assert.match(bad.stderr,/touba state migrate effects/); assert.match(bad.stderr,/--apply/);
    const run = command(["run","payment.air.json","--entry","strategy:demo.payment/Book","--manifest","manifest.json","--effect-journal",destination,"--output","json"],root);
    assert.equal(run.status,0,run.stderr); assert.equal(readFileSync(source,"utf8"),bytes);
  } finally { await engine.close(); }
});

test("installed Python sync/async SDK and Python authority host share compensation records", {skip:!process.env.TOUBA_HOST_PYTHON}, async t => {
  const {root,options,engine} = await fixture(t,true);
  await engine.close();
  writeFileSync(join(root,"authority.py"),`def check_compensation_authority(request):
    return request["requester_ref"] == "principal:test" and request["journal_scope_ref"] == "effect-journal:test"
`);
  const mapped = {air:options.air,manifest:options.manifest,effect_journal:options.effectJournal,store:options.store,authority_host:join(root,"authority.py"),request:options.request};
  const script = `import asyncio, json, sys
from datetime import datetime, timedelta, timezone
from touba_sdk import ToubaEngine, AsyncToubaEngine
options=json.loads(sys.argv[1])
engine=ToubaEngine(command=sys.argv[2],command_args=[sys.argv[3]])
first=engine.create_compensation(**options)["record"]
assert first["state"] == "action_required"
now=datetime.now(timezone.utc)
def timestamp(value): return value.isoformat(timespec="milliseconds").replace("+00:00","Z")
request={"resume_request_id":"resume:python", "compensation_id":first["compensation_id"],"compensates_effect_id":first["compensates_effect_id"],"expected_revision":first["revision"],"expected_record_digest":first["record_digest"],"requester_ref":"principal:test","journal_scope_ref":"effect-journal:test","approval_evidence":{"schema_version":"touba-compensation-approval-v1","approval_id":"approval-evidence:python","approval_ref":first["approval"]["approval_ref"],"subject_ref":first["compensation_id"],"decision":"approved","decided_at":timestamp(now-timedelta(seconds=1)),"expires_at":timestamp(now+timedelta(minutes=1))}}
options["request"]=request
async def run():
    async_engine=AsyncToubaEngine(command=sys.argv[2],command_args=[sys.argv[3]])
    result=await async_engine.resume_compensation(**options)
    assert result["record"]["result"] == "completed"
    assert await async_engine.resume_compensation(**options) == result
asyncio.run(run())
print("python compensation verified")
`;
  const result = spawnSync(process.env.TOUBA_HOST_PYTHON,["-I","-B","-c",script,JSON.stringify(mapped),process.execPath,cli],{encoding:"utf8",cwd:root});
  assert.equal(result.status,0,result.stderr+result.stdout); assert.deepEqual(calls(root),["Pay","Refund"]);
});
