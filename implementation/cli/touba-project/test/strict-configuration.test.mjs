import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareProject } from "../src/project.mjs";
import { loadToolBindingManifestFromJson } from "../../../runtime/touba-runtime/src/index.mjs";

const ref = "tool:demo.checks/Read", trigger = "trigger:demo.checks/Daily";
const write = (path, document) => writeFileSync(path, JSON.stringify(document));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-strict-config-"));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  mkdirSync(join(root,"src/demo"),{recursive:true});
  writeFileSync(join(root,"src/demo/checks.tb"), `module demo.checks
tool Read
    gives Text
strategy Run
    do
        show
            with message as "scheduled"
trigger Daily
    on schedule "0 8 * * *"
    runs strategy Run
    limits
        max_runs_per_day as 2
        timeout_ms as 30000
`);
  return root;
}
const manifestAt = root => join(root,".touba/build/dev/touba.manifest.json");
const review = {bindings:{[ref]:{effect_contract:{kind:"none"}}}};
const fragment = () => ({fragment_schema_version:"touba-binding-fragment-v1",source:{kind:"module",module:"demo.checks"},bindings:{[ref]:{
  handler:{kind:"process",command:"node",args:[]},grants:[],timeout_ms:5000,max_payload_bytes:65536,effect_contract:{kind:"none"}}}});

test("unknown fragment fields refuse plan/write/check without replacing prepared artifacts", async t => {
  const root = fixture(t);
  write(join(root,"fragment.json"),fragment());
  const initial = await prepareProject({root,mode:"write",bindingFragmentPaths:["fragment.json"]});
  assert.equal(initial.status,"success",JSON.stringify(initial.diagnostics));
  const before = readFileSync(manifestAt(root),"utf8");
  assert.equal(JSON.parse(before).bindings[ref].timeout_ms,5000);
  const mutations = [f=>f.typo=true, f=>f.source.typo=true, f=>f.bindings[ref].typo=true,
    f=>f.bindings[ref].timout_ms=5000,
    f=>{delete f.bindings[ref].timeout_ms; f.bindings[ref].timout_ms=5000;},
    f=>f.bindings[ref].handler.env={}, f=>f.bindings[ref].sandbox={required:false,typo:true},
    f=>f.bindings[ref].payload_constraints={input:{value:{max_lenght:4}}},
    f=>f.bindings[ref].memories=[{ref:"memory:checks/Notes",access:"read",typo:true}]];
  for (const mutate of mutations) for (const mode of ["plan","write","check"]) {
    const value = fragment(); mutate(value); write(join(root,"fragment.json"),value);
    const result = await prepareProject({root,mode,bindingFragmentPaths:["fragment.json"]});
    assert.equal(result.status,"error",JSON.stringify(result));
    assert.ok(result.diagnostics.some(d=>d.code === "ManifestFieldUnknown"),JSON.stringify(result.diagnostics));
    assert.equal(readFileSync(manifestAt(root),"utf8"),before);
  }
});

test("unknown manifest fields refuse direct runtime and preparation", async t => {
  const root = fixture(t);
  await prepareProject({root,mode:"write",hostDecisions:review});
  const original = JSON.parse(readFileSync(manifestAt(root)));
  for (const mutate of [m=>m.typo=true,m=>m.run_limits={max_step:2},m=>m.bindings[ref].handler.env={},
    m=>m.triggers[trigger].enabeld=true,m=>m.triggers[trigger].source.typo=true,
    m=>m.triggers[trigger].limits.typo=1,m=>m.triggers[trigger].payload={format:"json",typo:1}]) {
    const value = structuredClone(original); mutate(value); write(manifestAt(root),value);
    assert.throws(()=>loadToolBindingManifestFromJson(JSON.stringify(value)),{code:"InvalidToolBindingManifest"});
    const before = readFileSync(manifestAt(root),"utf8");
    assert.equal((await prepareProject({root,mode:"write"})).status,"error");
    assert.equal(readFileSync(manifestAt(root),"utf8"),before);
  }
});

test("triggers require an explicit host decision, preserve lowered limits and reject expansion", async t => {
  const root = fixture(t);
  const decisions = {triggers:{[trigger]:{enabled:true,limits:{max_runs_per_day:1,timeout_ms:5000}}}};
  const initial = await prepareProject({root,mode:"write",hostDecisions:review});
  assert.equal(initial.status,"success",JSON.stringify(initial.diagnostics));
  const before = readFileSync(manifestAt(root),"utf8");
  assert.equal(JSON.parse(before).triggers[trigger].enabled,false);
  const cli = fileURLToPath(new URL("../src/main.mjs",import.meta.url));
  const fire = eventId => {
    const result = spawnSync(process.execPath,[cli,"run",join(root,".touba/build/dev/air/demo/checks.air.json"),
      "--manifest",manifestAt(root),"--state",join(root,"state.triggers.sqlite"),"--output","json",
      "--trigger-event-json",JSON.stringify({trigger_ref:trigger,event_id:eventId,source_kind:"schedule"})],{encoding:"utf8"});
    return JSON.parse(result.stdout);
  };
  assert.equal(fire("event-one").reason,"TriggerDisabled");
  const plan = await prepareProject({root,mode:"plan",hostDecisions:decisions});
  assert.notEqual(plan.status,"error",JSON.stringify(plan.diagnostics));
  assert.equal(readFileSync(manifestAt(root),"utf8"),before);
  assert.equal((await prepareProject({root,mode:"write",hostDecisions:decisions})).status,"success");
  const after = readFileSync(manifestAt(root),"utf8");
  assert.equal(JSON.parse(after).triggers[trigger].enabled,true);
  assert.equal((await prepareProject({root,mode:"check",hostDecisions:decisions})).status,"success");
  assert.equal((await prepareProject({root,mode:"write"})).status,"success");
  assert.equal(readFileSync(manifestAt(root),"utf8"),after);
  assert.equal(fire("event-one").status,"success");
  assert.equal(fire("event-one").reason,"TriggerReplayRejected");
  const exhausted = fire("event-two");
  assert.equal(exhausted.status,"failure");
  assert.equal(exhausted.trace.events.some(event=>event.kind === "trigger_execution_started"),false);
  for (const patch of [{enabled:"true"},{source:{kind:"request"}},{limits:{max_runs_per_day:3}},{limits:{timeout_ms:30001}},{limits:{typo:1}}]) {
    const result = await prepareProject({root,mode:"write",hostDecisions:{triggers:{[trigger]:patch}}});
    assert.equal(result.status,"error"); assert.equal(readFileSync(manifestAt(root),"utf8"),after);
  }
  assert.equal(existsSync(join(root,".touba/build/dev/touba.run-plan.json")),true);
});
