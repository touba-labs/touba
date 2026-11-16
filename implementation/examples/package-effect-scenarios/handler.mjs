import { handleToolRequest, createToolResult } from '@touba/sdk';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const result = await handleToolRequest(input, 'tool:example.effect_scenarios/Write', async context => {
  const endpoint = new URL(context.configuration.endpoint);
  // This example is deliberately limited to its synthetic loopback service.
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Synthetic service required');
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
    body: JSON.stringify({ key: context.effect.effect_id + (context.configuration.behavior === 'bad_key' ? ':' + context.effect.attempt_index : ''),
      digest: context.effect.request_digest, value: context.arguments.value }) });
  if (!response.ok) throw new Error('Synthetic service refused the write');
  const { value } = await response.json();
  if (context.configuration.behavior === 'missing_receipt') return value;
  return createToolResult(value, { effectReceipt: context.createEffectReceipt({ outcome: 'applied', receipt_ref: 'synthetic:record' }) });
});
process.stdout.write(JSON.stringify(result));
