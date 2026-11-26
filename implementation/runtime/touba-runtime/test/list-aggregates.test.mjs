import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTestAir} from '../../../tests/helpers/compile.mjs';
import {executeAirDocument} from '../src/index.mjs';
import {validateAirMachineContract} from '../../../contracts/machine/contracts.mjs';
import { fileURLToPath } from "node:url";

const air=compileTestAir(fileURLToPath(new URL('../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-aggregates.tb',import.meta.url)));
const run=(name,inputs={},options={})=>executeAirDocument(air,{entryRef:`function:aggregates/${name}`,inputs,...options});

test('sum uses typed empty identity, ordered additions and checked numeric bounds',async()=>{
  for(const values of [[],[1,2,-3],[Number.MAX_SAFE_INTEGER]])assert.equal((await run('Total',{values})).result,values.reduce((a,b)=>a+b,0));
  assert.equal((await run('Empty')).result,0);
  assert.equal((await run('TotalFloat',{values:[0.25,0.5]})).result,0.75);
  for(const [name,values] of [['Total',[Number.MAX_SAFE_INTEGER,1]],['TotalFloat',[Number.MAX_VALUE,Number.MAX_VALUE]]])assert.equal((await run(name,{values})).status,'failure');
});

test('sort is stable, deterministic and leaves input intact',async()=>{
  const values=[3,1,2,1],copy=[...values];assert.deepEqual((await run('Ordered',{values})).result,[1,1,2,3]);assert.deepEqual(values,copy);
  const texts=['z','aa','a','😀','\uE000'];assert.deepEqual((await run('OrderedText',{values:texts})).result,['a','aa','z','😀','\uE000']);
  assert.deepEqual((await run('EmptySort')).result,[]);
  assert.deepEqual((await run('Ordered',{values:[1,2,3]})).result,[1,2,3]);
});

test('list work is bounded and cannot bypass cancellation, call ceilings or AIR types',async()=>{
  for(const name of ['Total','Ordered'])assert.equal((await run(name,{values:[3,2,1]},{maxLoopIterations:2})).reason,'LoopIterationLimitExceeded');
  const limits={max_tool_calls:0,max_agent_invocations:0,max_provider_calls:0};assert.equal((await run('Total',{values:[1,2]},{runLimits:limits})).result,3);
  const altered=structuredClone(air);const graph=altered.execution_graphs.find(g=>g.owner_ref==='function:aggregates/Total');const operation=graph.expressions.find(e=>e.kind==='list_sum');operation.type_ref='builtin:Text';assert.throws(()=>validateAirMachineContract(altered));
  const wrong=structuredClone(air);const sum=wrong.execution_graphs.find(g=>g.owner_ref==='function:aggregates/Total').expressions.find(e=>e.kind==='list_sum');sum.operands=[];assert.throws(()=>validateAirMachineContract(wrong));
});
