import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import { assertEffectScenario } from '../src/testing.mjs';

const schema = name => JSON.parse(readFileSync(new URL(`../../../contracts/packages/${name}.schema.json`, import.meta.url)));
const resultSchema = schema('touba-effect-scenario-result-v1');
assert.equal(resultSchema.properties.scenario.$ref, 'touba-effect-scenario-v1.schema.json');
// Resolve the single explicit adjacent schema without network retrieval.
resultSchema.properties.scenario = schema('touba-effect-scenario-v1');

function fixture(kind) {
  const scenario = { schema_version: 'touba-effect-scenario-v1', id: kind.replaceAll('_', '-'), tool_ref: 'tool:example.test/Write', case: kind };
  const effect_id = 'effect:sha256:' + 'a'.repeat(64), request_digest = 'sha256:' + 'b'.repeat(64);
  const runs = [0, 1, 2].map(index => {
    const applied = kind === 'duplicate' || kind === 'lost_reply' && index > 0;
    const count = kind === 'lost_reply' && index > 0 ? 2 : 1;
    return { status: applied ? 'success' : 'failure', reason: applied ? 'completed' : index === 0 ? 'ToolHandlerTimeout' : 'EffectReconciliationRequired',
      effect: { tool_ref: scenario.tool_ref, effect_id, request_digest, state: applied ? 'applied' : 'unknown', attempt_count: count,
        ...(applied ? { receipt: { effect_id, request_digest, outcome: 'applied', receipt_ref: 'synthetic-private-provider-reference' } } : {}) },
      service: { calls: count, writes: 1 } };
  });
  return { scenario, observations: { before: { calls: 0, writes: 0 }, runs } };
}

const badCases = [];
for (const kind of ['duplicate', 'lost_reply', 'reconciliation_required']) {
  test(`declared ${kind} checks three exact observations and minimizes its result`, () => {
    const input = fixture(kind), before = structuredClone(input);
    const result = assertEffectScenario(input.scenario, input.observations);
    assert.equal(result.status, 'passed');
    assert.equal(result.scope, 'author_test_synthetic_service');
    assert.equal(result.observations.length, 3);
    assert.deepEqual(validateObject(resultSchema, result), []);
    assert.ok(validateObject(resultSchema, { ...result, arguments: { value: 'must not leave the test' } }).length);
    assert.deepEqual(input, before);
    assert.ok(!JSON.stringify(result).includes('synthetic-private-provider-reference'));
    assert.ok(!JSON.stringify(result).includes('effect:sha256:'));
  });
  for (const mutate of [
    v => { v.scenario.extra = true; },
    v => { v.scenario.case = 'automatically_retry'; },
    v => { v.observations.before.writes = 1; },
    v => { v.observations.runs.pop(); },
    v => { v.observations.runs[1].service.writes = 2; },
    v => { v.observations.runs[1].effect.effect_id = 'effect:sha256:' + 'c'.repeat(64); },
    v => { v.observations.runs[1].effect.request_digest = 'sha256:' + 'c'.repeat(64); },
    v => { v.observations.runs[0].effect.tool_ref = 'tool:other/Write'; },
    v => { v.observations.runs[0].effect.attempt_count = true; },
    v => { v.observations.runs[2].service.calls = 3; },
    v => { v.observations.runs[0].reason = 'CompileFailed'; },
  ]) { const value = fixture(kind); mutate(value); badCases.push(value); }
}
for (const kind of ['duplicate', 'lost_reply']) {
  for (const mutate of [
    v => { delete v.observations.runs[1].effect.receipt; },
    v => { v.observations.runs[1].effect.receipt.request_digest = 'sha256:' + 'c'.repeat(64); },
    v => { v.observations.runs[1].effect.receipt.unknown_field = true; },
  ]) { const value = fixture(kind); mutate(value); badCases.push(value); }
}
test('deficient handlers, extra effects, changed identity and incomplete evidence are refused', () => {
  for (const { scenario, observations } of badCases) assert.throws(() => assertEffectScenario(scenario, observations));
});

test('Python and JavaScript accept and refuse the same scenarios, also under python -O', () => {
  const python = process.env.TOUBA_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const inputs = ['duplicate', 'lost_reply', 'reconciliation_required'].map(fixture);
  const source = fileURLToPath(new URL('../../touba-python-sdk/src/', import.meta.url));
  const code = `import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom touba_sdk.testing import assert_effect_scenario\nfrom touba_sdk import ToubaHandlerError\nvalues=json.load(sys.stdin)\nresult=[]\nfor value in values:\n try: result.append(assert_effect_scenario(value['scenario'],value['observations']))\n except (AssertionError, ValueError, TypeError, ToubaHandlerError): result.append(None)\nprint(json.dumps(result))\n`;
  const result = spawnSync(python, ['-O', '-c', code, source], { input: JSON.stringify([...inputs, ...badCases]), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [...inputs.map(v => assertEffectScenario(v.scenario, v.observations)), ...badCases.map(() => null)]);
});
