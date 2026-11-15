import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { scaffoldRestTool } from '../src/rest-scaffold.mjs';
import { openApiOperation } from '../src/openapi-operation.mjs';
import { runProcessToolHandler } from '../../../runtime/touba-runtime/src/handler-protocol.mjs';

const invoice = { type: 'object', properties: { invoiceId: { type: 'string' }, total: { type: 'number' }, note: { type: 'string' } }, required: ['invoiceId', 'total'] };
const ref = { $ref: '#/components/schemas/Invoice' };
const response = schema => ({ '200': { content: { 'application/json': { schema } } } });
const document = { openapi: '3.0.3', components: { schemas: { Invoice: invoice } }, paths: {
  '/invoices/{invoiceId}': { parameters: [{ in: 'path', name: 'invoiceId', required: true, schema: { type: 'string' } }],
    get: { operationId: 'getInvoice', responses: response(ref) } },
  '/invoices': {
    get: { operationId: 'listInvoices', responses: response({ type: 'array', items: ref }) },
    post: { operationId: 'createInvoice', requestBody: { content: { 'application/json': { schema: ref } } }, responses: response(ref) },
  },
} };

test('local references are bounded, acyclic and do not fetch external resources', () => {
  for (const bad of [{ $ref: 'https://example.invalid/schema' }, { $ref: '#/components/schemas/Invoice' }, { $ref: '#/missing' }]) {
    const input = structuredClone(document); input.components.schemas.Invoice = bad;
    assert.throws(() => openApiOperation(input, 'getInvoice'), /reference/i);
  }
  const input = structuredClone(document);
  input.paths['/invoices/{invoiceId}'].parameters[0].required = false;
  assert.throws(() => openApiOperation(input, 'getInvoice'), /required/);
  assert.equal(openApiOperation(document, 'listInvoices').output_array, true);
});

test('ordinary API imports compile and generated processes read, list and create with real HTTP', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-openapi-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const api = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    const value = { invoiceId: 'a/b ?', total: 25.5 };
    res.end(JSON.stringify(req.method === 'POST' ? JSON.parse(body) : req.url === '/invoices' ? [value] : value));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  mkdirSync(join(root, 'node_modules/@touba'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../../runtime/touba-handler-sdk', import.meta.url)), join(root, 'node_modules/@touba/sdk'), 'dir');
  const configPath = join(root, 'import.json');
  writeFileSync(configPath, JSON.stringify({ rest_scaffold_config_version: 'touba-rest-scaffold-config-v1',
    service: { name: 'invoices', base_url: `http://127.0.0.1:${api.address().port}` }, openapi: document,
    operation_ids: ['getInvoice', 'listInvoices', 'createInvoice'] }));
  const report = scaffoldRestTool({ root, configPath, moduleName: 'integrations.invoices', out: 'out', mode: 'write' });
  assert.equal(report.status, 'success', JSON.stringify(report.diagnostics));
  const compiled = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'compile',
    report.files.find(file => file.kind === 'source').path, '--out', join(root, 'module.air.json')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const limits = { timeout_ms: 5000, max_payload_bytes: 1048576 };
  async function invoke(name, args, grants = ['network']) {
    const toolRef = `tool:integrations.invoices/${name}`;
    const slug = name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
    const handler = report.files.find(file => file.kind === 'handler' && file.path.endsWith(`/${slug}.rest-handler.mjs`));
    return runProcessToolHandler({ toolRef, binding: { handler: { command: process.execPath, args: [handler.path], cwd: root }, grants, limits },
      request: { protocol: 'touba-tool-handler-v1', operation: 'invoke', tool_ref: toolRef, grants, secret_handles: [], limits, arguments: name === 'ListInvoices' ? {} : { request: args } }, secretHandles: [] });
  }
  await assert.rejects(invoke('GetInvoice', { invoice_id: 'a/b ?' }, []), error => error.details?.handlerErrorCode === 'MissingGrant');
  await assert.rejects(invoke('GetInvoice', { invoice_id: '..' }), error => error.details?.handlerErrorCode === 'InvalidArguments');
  assert.equal(calls.length, 0);
  const result = { invoice_id: 'a/b ?', total: 25.5, note: { present: false } };
  assert.deepEqual((await invoke('GetInvoice', { invoice_id: 'a/b ?' })).value, result);
  assert.equal(calls[0].path, '/invoices/a%2Fb%20%3F');
  assert.deepEqual((await invoke('ListInvoices', {})).value, { items: [result] });
  assert.deepEqual((await invoke('CreateInvoice', result)).value, result);
  assert.deepEqual(JSON.parse(calls[2].body), { invoiceId: 'a/b ?', total: 25.5 });
});
