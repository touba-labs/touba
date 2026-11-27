import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileTestAir } from '../../../tests/helpers/compile.mjs';
import { executeAirDocument, loadToolBindingManifestFromJson } from '../src/index.mjs';

const toolRef = 'tool:operation_approval/Pay';
const source = fileURLToPath(new URL('../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tool-approval.tb', import.meta.url));
const schema = { schema_version: 'touba-handler-configuration-v1', fields: { region: { type: 'string', required: true } } };
const sdkJs = new URL('../../touba-handler-sdk/src/index.mjs', import.meta.url).href;
const sdkPy = fileURLToPath(new URL('../../touba-python-sdk/src', import.meta.url));
const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();

for (const language of ['javascript', 'python']) test(`${language} configuration stays with its handler and binds human approval`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-handler-configuration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'calls'), handler = join(root, language === 'python' ? 'handler.py' : 'handler.mjs');
  writeFileSync(handler, language === 'javascript' ? `import {defineTool} from ${JSON.stringify(sdkJs)};
import {appendFileSync} from 'node:fs';
await defineTool({toolRef:${JSON.stringify(toolRef)},inputSignature:[{name:'amount',type_ref:'builtin:Int'}],outputType:'builtin:Int',run:({context})=>{
 if(context.configuration.region!=='private-config-marker'||context.env.region)throw new Error('bad configuration');
 appendFileSync(${JSON.stringify(marker)},'called\\n');return 7;
}});` : `import sys
sys.path.insert(0,${JSON.stringify(sdkPy)})
import asyncio
from touba_sdk.handlers import define_tool
def run(request,context):
 assert context['configuration']['region']=='private-config-marker'
 assert 'region' not in context['env']
 with open(${JSON.stringify(marker)},'a') as stream: stream.write('called\\n')
 return 7
asyncio.run(define_tool(tool_ref=${JSON.stringify(toolRef)},run=run,input_signature=[{'name':'amount','type_ref':'builtin:Int'}],output_type='builtin:Int'))
`);
  const manifest = { manifest_version: 'touba-manifest-v1', bindings: { [toolRef]: {
    handler: { kind: 'process', command: language === 'python' ? python : process.execPath, args: [handler], cwd: root },
    configuration: { schema, values: { region: 'private-config-marker' } },
    grants: [], secrets: [], effect_contract: { kind: 'none' }, timeout_ms: 5000, max_payload_bytes: 16384,
  } } };
  const air = compileTestAir(source);
  const options = { entryRef: toolRef, toolBindingManifest: manifest, durableHumanApprovals: true,
    humanCheckpointStorePath: join(root, 'approvals.sqlite'), humanApprovalInitiator: 'employee:initiator',
    humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id, run_id: request.run_id,
      decision, subject_ref: 'employee:reviewer', roles: ['finance'] }) };
  const pending = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  assert.equal(pending.reason, 'human_approval_pending', JSON.stringify(pending));
  assert.ok(!JSON.stringify(pending).includes('private-config-marker'));
  assert.equal(existsSync(marker), false);
  const changed = structuredClone(manifest); changed.bindings[toolRef].configuration.values.region = 'another-config-marker';
  const decisions = { [pending.checkpoint.approval_ref]: { decision: 'approved', evidence_ref: 'test-proof' } };
  const refused = await executeAirDocument(air, { ...options, toolBindingManifest: changed,
    humanApprovalResumeCheckpoint: pending.checkpoint, humanApprovalDecisions: decisions });
  assert.equal(refused.reason, 'HumanApprovalCheckpointIncompatible', JSON.stringify(refused));
  assert.equal(existsSync(marker), false);
  const fresh = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const result = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: fresh.checkpoint,
    humanApprovalDecisions: { [fresh.checkpoint.approval_ref]: { decision: 'approved', evidence_ref: 'test-proof' } } });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.result, 7);
  assert.match(readFileSync(marker, 'utf8'), /^called\r?\n$/);
  assert.ok(!JSON.stringify(result).includes('private-config-marker'));
  const invalid = structuredClone(manifest); invalid.bindings[toolRef].configuration.values.region = null;
  assert.throws(() => loadToolBindingManifestFromJson(JSON.stringify(invalid)), { code: 'HandlerConfigurationInvalid' });
});
