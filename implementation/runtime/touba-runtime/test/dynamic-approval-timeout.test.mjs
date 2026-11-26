import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {compileTestAir} from '../../../tests/helpers/compile.mjs';import {executeAirDocument} from '../src/index.mjs';import {validateAirMachineContract} from '../../../contracts/machine/contracts.mjs';
function program(t){const root=mkdtempSync(join(tmpdir(),'touba-dynamic-deadline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'source.tb');writeFileSync(path,`module deadline
function Delay
    takes duration as Int
    gives Int
    do
        give duration
strategy Review
    takes duration as Int
    gives Approval
    do
        Delay
            with duration as duration
            into computed
        human.approve
            with context as "synthetic"
            with timeout_ms as computed
            into receipt
        give receipt
`);return compileTestAir(path);}

test('pure dynamic delay is validated before waiting and source plus resolved value survive resume',async t=>{
 const air=program(t);let now=Date.now();const dateNow=Date.now;Date.now=()=>now;t.after(()=>Date.now=dateNow);
 const options={entryRef:'strategy:deadline/Review',durableHumanApprovals:true};
 const first=await executeAirDocument(air,{...options,inputs:{duration:60000}});assert.equal(first.reason,'human_approval_pending',JSON.stringify(first));
 const ref=first.checkpoint.approval_ref,request=first.checkpoint.approval_state.requests[ref];assert.equal(request.policy.timeout_ms,60000);assert.equal(Date.parse(request.deadline_at)-Date.parse(request.created_at),60000);assert.equal(typeof request.source_policy.timeout_ms_ref,'string');
 now+=1000;
 const last=await executeAirDocument(air,{...options,humanApprovalResumeCheckpoint:structuredClone(first.checkpoint),humanApprovalDecisions:{[ref]:'approved'}});assert.equal(last.status,'success',JSON.stringify(last));assert.equal(last.result.decision,'approved');
 const damaged=structuredClone(first.checkpoint);damaged.approval_state.requests[ref].source_policy.timeout_ms_ref='literal:int:70000';await assert.rejects(executeAirDocument(air,{...options,humanApprovalResumeCheckpoint:damaged,humanApprovalDecisions:{[ref]:'approved'}}),{code:'HumanApprovalCheckpointIncompatible'});
});

test('invalid dynamic delays and forged AIR cannot create an approval request',async t=>{
 const air=program(t);
 for(const duration of [0,-1,2592000001]){const result=await executeAirDocument(air,{entryRef:'strategy:deadline/Review',inputs:{duration},durableHumanApprovals:true});assert.equal(result.reason,'InvalidHumanApprovalPolicy',JSON.stringify(result));assert.equal(result.checkpoint,undefined);}
 const altered=structuredClone(air);altered.execution_graphs.find(g=>g.owner_ref==='strategy:deadline/Review').nodes.find(n=>n.kind==='human_approval').approval_policy.timeout_ms=100;assert.throws(()=>validateAirMachineContract(altered));
});

test('dynamic timeout in a parallel branch is explicitly refused before creating a wait',async t=>{
 const root=mkdtempSync(join(tmpdir(),'touba-dynamic-parallel-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'source.tb');writeFileSync(path,`module parallel_deadline
skill Review
    takes duration as Int
    gives Approval
    do
        human.approve
            with context as "synthetic"
            with timeout_ms as duration
            into receipt
        give receipt
strategy Batch
    takes durations as List of Int
    gives List of Approval
    uses Review
    do
        parallel Review
            each duration in durations
            with duration as duration
            max_concurrency 2
            max_items 10
            into results
        give results
`);
 const result=await executeAirDocument(compileTestAir(path),{entryRef:'strategy:parallel_deadline/Batch',inputs:{durations:[1000,2000]},durableHumanApprovals:true});assert.notEqual(result.status,'success');assert.equal(result.trace.events.filter(x=>x.kind==='human_approval_requested').length,0);assert.match(JSON.stringify(result),/InvalidHumanApprovalPolicy/);
});
