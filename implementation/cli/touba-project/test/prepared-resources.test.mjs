import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initProject, prepareProject, resolveProjectRunArgs } from "../src/project.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { loadPreparedResourceBindings } from "../../touba-project-server/src/prepared-project.mjs";
import { createToubaProjectServer } from "../../touba-project-server/src/serve.mjs";
import { executeAirDocument, loadToolBindingManifestFromJson } from "../../../runtime/touba-runtime/src/index.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const sdk = new URL("../../../runtime/touba-handler-sdk/src/index.mjs", import.meta.url).href;
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
async function fixture(t, approval = false) {
  const root = mkdtempSync(join(tmpdir(), "touba-prepared-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({root}); mkdirSync(join(root, "src/demo"), {recursive:true});
  for (const name of ["first", "second"]) writeFileSync(join(root, `src/demo/${name}.tb`), `module demo.${name}
memory Notes
tool Read
    gives Int
    uses memory Notes read
    requires memory_read
strategy Run
    gives Int
    uses Read
    memory Notes read
    do
${approval ? '        human.approve\n            with context as "Read notes"\n            into approval\n' : ''}        Read
            into count
        give count
`);
  const configPath = join(root, "touba.project.json"), config = JSON.parse(readFileSync(configPath));
  config.entry = "strategy:demo.first/Run"; config.entrypoints = ["strategy:demo.second/Run"];
  config.configuration = {resource_bindings: ["first.json", "second.json"]}; json(configPath, config);
  const bindings = {};
  for (const name of ["first", "second"]) {
    json(join(root, `${name}.json`), {resource_bindings_schema_version:"touba-resource-bindings-v1",
      required_resources: [`memory:demo.${name}/Notes`], resources:{[`memory:demo.${name}/Notes`]: {
        kind:"memory_backend", provider:"host.local", grants:["memory.read", "memory.write"], secrets:[], config:{table:"private_table"}}}});
    const ref = `tool:demo.${name}/Read`, handler = join(root, `handlers/${name}.mjs`);
    writeFileSync(handler, `import {defineTool} from ${JSON.stringify(sdk)};
await defineTool({toolRef:${JSON.stringify(ref)},inputSignature:[],outputType:"builtin:Int",run:async ({context})=>{
if(context.resourceBindings.length !== 1 || context.resourceBindings[0].grants.join() !== "memory.read") throw new Error("incorrect projection");
return context.resourceBindings.length;
}});`);
    bindings[ref] = {handler:{kind:"process",command:process.execPath,args:[handler],cwd:root},grants:["memory_read"],
      memories:[{ref:`memory:demo.${name}/Notes`,access:"read"}],effect_contract:{kind:"none"}};
  }
  const report = await prepareProject({root, mode:"write",hostDecisions:{bindings}});
  assert.equal(report.status,"success",JSON.stringify(report.diagnostics));
  return {root, configPath, config};
}

test("prepared resources reach CLI and JS process/persistent SDKs for every declared module", async t => {
  const {root} = await fixture(t);
  for (const name of ["first","second"]) {
    const entry = `strategy:demo.${name}/Run`;
    const result = spawnSync(process.execPath,[cli,"run","--project",root,"--entry",entry,"--output","json"],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).result,1);
    assert.equal(result.stdout.includes("private_table"), false);
    for (const executionMode of ["process","persistent"]) {
      const engine = new ToubaEngine({projectRoot:root,command:process.execPath,commandArgs:[cli],executionMode});
      try { assert.equal((await engine.run({project:".",entryRef:entry})).result,1); }
      finally { await engine.close(); }
    }
    const document = JSON.parse(readFileSync(join(root,`.touba/build/dev/air/demo/${name}.air.json`)));
    const manifest = JSON.parse(readFileSync(join(root,".touba/build/dev/touba.manifest.json")));
    const resources = loadPreparedResourceBindings(root, document);
    const served = await executeAirDocument(document,{entryRef:entry,toolBindingManifest:loadToolBindingManifestFromJson(JSON.stringify(manifest)),resourceBindings:resources});
    assert.equal(served.status,"success",JSON.stringify(served)); assert.equal(served.result,1);
  }
});

test("prepared resources reach HTTP serve for each module", async t => {
  const {root} = await fixture(t);
  const service = createToubaProjectServer({projectRoot:root,port:0,quiet:true});
  try {
    await service.start();
    for (const name of ["first","second"]) {
      const response = await fetch(`http://127.0.0.1:${service.server.address().port}/runs/sandbox`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
        schema_version:"touba-sandbox-run-request-v1",execution_kind:"entrypoint",target_ref:`strategy:demo.${name}/Run`,inputs:{},effect_policy:"allow_declared_external_effects",
        requested_by:{kind:"service",id:"resource-test"},reason:"Verify prepared resource transport"})});
      const result = await response.json();
      assert.equal(response.status,200,JSON.stringify(result)); assert.equal(result.result,1,JSON.stringify(result));
      assert.equal(JSON.stringify(result).includes("private_table"),false);
    }
  } finally { await service.stop(); }
});

test("prepared resources survive a human pause and refuse changed bindings on resume", async t => {
  const {root} = await fixture(t,true);
  const engine = new ToubaEngine({projectRoot:root,command:process.execPath,commandArgs:[cli]});
  writeFileSync(join(root,"approval.mjs"),`export const initiatorRef="principal:requester";
export function attestHumanApproval({request,decision,evidenceRef}) {
if(evidenceRef !== "evidence:local-test") throw new Error("unknown evidence");
return {request_id:request.request_id,run_id:request.run_id,decision,subject_ref:"principal:reviewer",roles:[]};
}`);
  try {
    const options = {project:root,humanCheckpointOut:"waiting.json",humanApprovalHost:"approval.mjs"};
    const paused = await engine.run(options);
    assert.equal(paused.reason,"human_approval_pending");
    const checkpoint = JSON.parse(readFileSync(join(root,"waiting.json")));
    const resumed = {...options,humanResumeCheckpoint:"waiting.json",humanDecisions:{[checkpoint.approval_ref]:{decision:"approved",evidence_ref:"evidence:local-test"}}};
    const original = readFileSync(join(root,"first.json"),"utf8");
    writeFileSync(join(root,"first.json"),original+"\n");
    await assert.rejects(engine.run(resumed));
    writeFileSync(join(root,"first.json"),original);
    assert.equal((await engine.run(resumed)).result,1);
    await assert.rejects(engine.run(resumed));
  } finally { await engine.close(); }
});

test("resource grants cannot expand read authority and missing backend secret contracts refuse before dispatch", async t => {
  const {root} = await fixture(t);
  const original = JSON.parse(readFileSync(join(root,"first.json")));
  for (const patch of [{grants:["memory.write"]},{secrets:["PRIVATE"],required_secrets:["PRIVATE"]}]) {
    const document = structuredClone(original); Object.assign(document.resources["memory:demo.first/Notes"],patch);
    json(join(root,"override.json"),document);
    const result = spawnSync(process.execPath,[cli,"run","--project",root,"--resource-bindings",join(root,"override.json"),"--output","json"],{encoding:"utf8"});
    assert.notEqual(result.status,0,result.stdout);
    const trace = JSON.parse(result.stdout).trace;
    assert.equal(trace.events.some(event=>event.kind === "call_completed"),false);
    assert.equal(result.stdout.includes("private_table"),false);
  }
});

test("installed Python SDK uses a prepared project outside its working directory", {skip:!process.env.TOUBA_HOST_PYTHON}, async t => {
  const {root} = await fixture(t);
  const script = `import asyncio,sys
from touba_sdk import ToubaEngine,AsyncToubaEngine
engine=ToubaEngine(command=sys.argv[2],command_args=[sys.argv[3]])
assert engine.run(project=sys.argv[1],entry_ref="strategy:demo.first/Run").result == 1
async def check():
    engine=AsyncToubaEngine(command=sys.argv[2],command_args=[sys.argv[3]])
    assert (await engine.run(project=sys.argv[1],entry_ref="strategy:demo.second/Run")).result == 1
asyncio.run(check())
`;
  const result = spawnSync(process.env.TOUBA_HOST_PYTHON,["-I","-B","-c",script,root,process.execPath,cli],{encoding:"utf8",cwd:tmpdir()});
  assert.equal(result.status,0,result.stderr+result.stdout);
});

test("resource file drift, duplicate refs and changed project selections refuse; explicit override replaces", async t => {
  const {root,configPath,config} = await fixture(t);
  const resources = JSON.parse(readFileSync(join(root,"first.json")));
  const override = join(root,"override.json"); json(override,{resource_bindings_schema_version:"touba-resource-bindings-v1",resources:{}});
  const command = [cli,"run","--project",root,"--output","json"];
  json(join(root,"first.json"),{...resources,resources:{}});
  const stale = spawnSync(process.execPath,command,{encoding:"utf8"});
  assert.notEqual(stale.status,0); assert.match(stale.stderr,/ResourceBindingsPreparationStale/);
  assert.throws(()=>loadPreparedResourceBindings(root,{}),{code:"ToubaServePreparedProjectInvalid"});
  const replaced = spawnSync(process.execPath,[...command,"--resource-bindings",override],{encoding:"utf8"});
  assert.doesNotMatch(replaced.stderr,/ResourceBindingsPreparationStale/);
  config.configuration.resource_bindings = []; json(configPath,config);
  assert.throws(()=>resolveProjectRunArgs(["--project",root]),{code:"ResourceBindingsPreparationStale"});
  json(join(root,"first.json"),resources); json(join(root,"second.json"),resources);
  config.configuration.resource_bindings = ["first.json","second.json"]; json(configPath,config);
  const before = readFileSync(join(root,".touba/build/dev/touba.run-plan.json"),"utf8");
  const report = await prepareProject({root,mode:"write"});
  assert.equal(report.status,"error"); assert.ok(report.diagnostics.some(d=>d.code === "ResourceBindingDuplicate"));
  assert.equal(readFileSync(join(root,".touba/build/dev/touba.run-plan.json"),"utf8"),before);
});
