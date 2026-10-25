// Business adaptation fixture. Helpers come from installed real package archives.
import { pathToFileURL } from 'node:url';
import { defineTool, createToolResult } from '@touba/sdk';
import { createHttpClient } from '../packages/touba.http-api/javascript/client.mjs';
import { applyOnce } from '../packages/touba.sql-effects/javascript/ledger.mjs';

const [toolRef, pgPath, origin, behavior] = process.argv.slice(2);
const { Client } = (await import(pathToFileURL(pgPath))).default;
const connect = async context => {
  const client = new Client({ connectionString: context.env.PILOT_DATABASE,
    connectionTimeoutMillis: 2000, statement_timeout: 2000, lock_timeout: 1000 });
  await client.connect(); return client;
};
const writing = ['tool:pilot/CreateOrder', 'tool:pilot/ReleaseOrder'].includes(toolRef);
await defineTool({
  toolRef,
  inputSignature: toolRef === 'tool:touba.http_api/Read' ? [{ name: 'path', type_ref: 'builtin:Text' }]
    : toolRef === 'tool:pilot/ReleaseOrder' ? [] : [{ name: 'order_id', type_ref: 'builtin:Text' }],
  outputType: toolRef === 'tool:touba.http_api/Read' ? 'type:touba.http_api/Response'
    : toolRef === 'tool:pilot/CreateOrder' ? 'type:touba.sql_effects/WriteReceipt' : 'builtin:Text',
  requiredGrants: toolRef === 'tool:touba.http_api/Read' ? ['network'] : ['network', 'secret_read'],
  requiredSecretHandles: toolRef === 'tool:touba.http_api/Read' ? [] : ['PILOT_DATABASE'],
  async run({ request, context }) {
    if (toolRef === 'tool:touba.http_api/Read') return createHttpClient({ baseUrl: origin, allowLocal: true }).request(request);
    if (!writing) {
      const client = await connect(context);
      try { return (await client.query('SELECT status FROM orders WHERE id=$1', [request])).rows[0]?.status ?? 'absent'; }
      finally { await client.end(); }
    }
    const inverse = toolRef === 'tool:pilot/ReleaseOrder';
    const id = inverse ? context.compensation.original_effect_receipt.receipt_ref.slice('order:'.length) : request;
    const result = await applyOnce({ connect: () => connect(context), effect: context.effect,
      operation: inverse ? 'orders.release' : 'orders.create',
      write: async ({ query }) => {
        await query(inverse ? "UPDATE orders SET status='released' WHERE id=$1" : "INSERT INTO orders(id,status) VALUES ($1,'active')", [id]);
        return { value: inverse ? 'released' : { receipt_ref: `order:${id}`, replayed: false }, receipt_ref: `order:${id}` };
      },
    });
    if (!inverse && behavior === 'lose-first-receipt' && context.effect.attempt_index === 1) process.exit(9);
    return createToolResult(result.value, { effectReceipt: result.effect_receipt,
      ...(inverse ? { compensationReceipt: context.createCompensationReceipt({ result: 'completed' }) } : {}) });
  },
});
