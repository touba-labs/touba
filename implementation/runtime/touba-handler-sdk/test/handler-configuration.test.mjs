import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeHandlerConfiguration, normalizeHandlerConfigurationSchema, normalizeHandlerConfigurationValues } from '../src/handler-configuration.mjs';
import { handleToolRequest, createToolHandler } from '../src/index.mjs';

const schema = { schema_version: 'touba-handler-configuration-v1', fields: {
  endpoint: { type: 'string', required: true, max_bytes: 64 },
  enabled: { type: 'boolean' }, retries: { type: 'integer', min: 0, max: 5 }, threshold: { type: 'number', min: 0, max: 1 },
} };
const valid = { endpoint: 'https://example.invalid/private-marker', enabled: true, retries: 2, threshold: 0.5 };
const request = configuration => JSON.stringify({ protocol: 'touba-tool-handler-v1', operation: 'invoke', tool_ref: 'tool:example/Use',
  ...(configuration === undefined ? {} : { configuration }), arguments: {} });

test('typed configuration is closed, bounded, immutable and has no defaults', () => {
  const normalized = normalizeHandlerConfiguration({ schema, values: valid });
  assert.deepEqual(normalized.values, valid);
  assert.notEqual(normalized.values, valid);
  assert.ok(Object.isFrozen(normalized.values));
  for (const values of [{}, { ...valid, endpoint: null }, { ...valid, enabled: 1 }, { ...valid, retries: 0.5 },
    { ...valid, retries: 6 }, { ...valid, other: 'private-marker' }, { ...valid, endpoint: 'é'.repeat(33) },
    { ...valid, threshold: NaN }, { ...valid, threshold: Infinity }]) {
    assert.throws(() => normalizeHandlerConfiguration({ schema, values }), error => error.code === 'HandlerConfigurationInvalid' && !error.message.includes('private-marker'));
  }
  for (const rule of [{ type: 'secret' }, { type: 'string', default: 'x' }, { type: 'string', min: 2 },
    { type: 'number', max_bytes: 2 }, { type: 'integer', min: 0.5 }, { type: 'string', required: 'yes' }]) {
    assert.throws(() => normalizeHandlerConfigurationSchema({ ...schema, fields: { value: rule } }), { code: 'HandlerConfigurationInvalid' });
  }
  assert.throws(() => normalizeHandlerConfiguration({ schema, values: valid, grants: ['network'] }), { code: 'HandlerConfigurationInvalid' });
});

const invalid = [null, [], { endpoint: '\0private-marker' }, { endpoint: '\ud800' }, { endpoint: 'é'.repeat(2049) },
  { nested: { endpoint: 'private-marker' } }, { unsafe: 9007199254740992 }, JSON.parse('{"__proto__":"private-marker"}'),
  { constructor: 'private-marker' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`v${i}`, true])),
  Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`v${i}`, 'x'.repeat(4096)]))];

test('JavaScript SDK keeps values private to a copied context and rejects malformed values before calling the handler', async () => {
  let called = 0;
  const handler = createToolHandler({ toolRef: 'tool:example/Use', run: ({ context }) => {
    called++;
    if (context.configuration) {
      assert.deepEqual(context.configuration, valid);
      context.request.configuration.endpoint = 'changed';
      assert.equal(context.configuration.endpoint, valid.endpoint);
      assert.equal(process.env.endpoint, undefined);
    }
    return 7;
  } });
  assert.deepEqual(await handleToolRequest(request(valid), 'tool:example/Use', handler), { ok: true, value: 7 });
  assert.deepEqual(await handleToolRequest(request(undefined), 'tool:example/Use', handler), { ok: true, value: 7 });
  for (const values of invalid) {
    assert.throws(() => normalizeHandlerConfigurationValues(values), { code: 'HandlerConfigurationInvalid' });
    const response = await handleToolRequest(request(values), 'tool:example/Use', handler);
    assert.equal(response.error.code, 'HandlerConfigurationInvalid');
    assert.ok(!JSON.stringify(response).includes('private-marker'));
  }
  assert.equal(called, 2);
});

test('Python SDK accepts and rejects the same wire configuration and isolates its context copy', () => {
  const script = `import asyncio,json,sys
from touba_sdk.handlers import handle_tool_request,create_tool_handler
calls=0
def run(request,context):
 global calls
 calls+=1
 value=context['configuration']
 if value is not None:
  assert value == ${JSON.stringify(valid).replaceAll('true', 'True')}
  context['request']['configuration']['endpoint']='changed'
  assert value['endpoint'].endswith('private-marker')
 return 7
handler=create_tool_handler(tool_ref='tool:example/Use',run=run)
results=[asyncio.run(handle_tool_request(raw,'tool:example/Use',handler)) for raw in json.load(sys.stdin)]
print(json.dumps({'calls':calls,'results':results}))`;
  const result = spawnSync('python3', ['-B', '-c', script], { encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../touba-python-sdk/src', import.meta.url)) },
    input: JSON.stringify([request(valid), request(undefined), ...invalid.map(request)]) });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.calls, 2);
  assert.deepEqual(parsed.results.slice(0, 2), [{ ok: true, value: 7 }, { ok: true, value: 7 }]);
  for (const response of parsed.results.slice(2)) {
    assert.equal(response.error.code, 'HandlerConfigurationInvalid');
    assert.ok(!JSON.stringify(response).includes('private-marker'));
  }
});
