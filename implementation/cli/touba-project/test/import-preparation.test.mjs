import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runProcessToolHandler } from '../../../runtime/touba-runtime/src/handler-protocol.mjs';
import { initProject, prepareProject } from "../src/project.mjs";
import { importMcpTools } from "../src/mcp-import.mjs";
import { scaffoldRestTool } from "../src/rest-scaffold.mjs";
import { renderJsonFieldAdapters } from "../src/import-field-adapters.mjs";

const schema = {
  type: "object", properties: { accountName: { type: "string" }, maxItems: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
  required: ["accountName"],
};
const configs = {
  mcp: { mcp_import_config_version: "touba-mcp-import-config-v1", server: { name: "demo", transport: "snapshot" }, tools: [{ name: "lookup", inputSchema: schema, outputSchema: schema }] },
  rest: { rest_scaffold_config_version: "touba-rest-scaffold-config-v1", service: { name: "demo", base_url: "https://example.invalid" }, operation: { name: "lookup", method: "POST", path: "/lookup", inputSchema: schema, outputSchema: schema } },
};

for (const [kind, generator] of [['mcp', importMcpTools], ['rest', scaffoldRestTool]]) test(`${kind} generated handler exchanges its real process protocol and refuses a missing grant`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-generated-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let http, requests = 0;
  const config = structuredClone(configs[kind]);
  if (kind === 'rest') {
    http = createServer(async (req, res) => { requests++; let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); assert.deepEqual(input, { accountName: 'A', tags: ['x'] });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(input)); });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => http.close(resolve)));
    config.service.base_url = `http://127.0.0.1:${http.address().port}`;
  }
  mkdirSync(join(root, 'node_modules/@touba'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../../runtime/touba-handler-sdk', import.meta.url)), join(root, 'node_modules/@touba/sdk'), 'dir');
  const configPath = join(root, 'import.json'); writeFileSync(configPath, JSON.stringify(config));
  const report = generator({ root, configPath, moduleName: 'integrations.demo', out: 'out', mode: 'write' });
  assert.equal(report.status, 'success');
  if (kind === 'mcp') {
    const fake = join(root, 'synthetic-server.mjs');
    writeFileSync(fake, `import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line); if (!request.id) continue;
        const result = request.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1.0.0' } }
          : { content: [], structuredContent: request.params.arguments, isError: false };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }`);
    const path = join(root, 'out/mcp.bridge.config.json'), bridge = JSON.parse(readFileSync(path));
    bridge.server.command = process.execPath; bridge.server.args = [fake]; writeFileSync(path, JSON.stringify(bridge));
  }
  const handler = report.files.find(file => ['handler', 'handler_bridge'].includes(file.kind));
  const toolRef = 'tool:integrations.demo/Lookup', limits = { timeout_ms: 5000, max_payload_bytes: 1048576 };
  const invoke = grants => runProcessToolHandler({ toolRef, binding: { handler: { command: process.execPath, args: [handler.path], cwd: root }, grants, limits },
    request: { protocol: 'touba-tool-handler-v1', operation: 'invoke', tool_ref: toolRef, grants, secret_handles: [], limits,
      arguments: { request: { account_name: 'A', max_items: { present: false }, tags: { present: true, value: ['x'] } } } }, secretHandles: [] });
  await assert.rejects(invoke([]), error => error.code === 'ToolHandlerReportedError' && error.details?.handlerErrorCode === 'MissingGrant');
  assert.equal(requests, 0);
  const result = await invoke(['network']);
  assert.deepEqual(result.value, { account_name: 'A', max_items: { present: false }, tags: { present: true, value: ['x'] } });
  if (kind === 'rest') assert.equal(requests, 1);
});

for (const [kind, generator] of [["mcp", importMcpTools], ["rest", scaffoldRestTool]]) {
  for (const language of ["javascript", "python"]) test(`${kind} generated fragment compiles and prepares once in a ${language} project`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touba-import-prepare-"));
    try {
      initProject({ root, language });
      const configPath = join(root, "import.json");
      writeFileSync(configPath, JSON.stringify(configs[kind]));
      const options = { root, configPath, moduleName: "integrations.demo", out: "integrations/demo" };
      assert.equal(generator({ ...options, mode: "plan" }).status, "success");
      assert.equal(existsSync(join(root, options.out)), false);
      assert.equal(generator({ ...options, mode: "write" }).status, "success");
      const source = join(root, options.out, "src/demo.tb");
      const fragment = join(root, options.out, "touba.manifest.fragment.json");
      const projectPath = join(root, "touba.project.json");
      const project = JSON.parse(readFileSync(projectPath, "utf8"));
      project.configuration = { binding_fragments: ["integrations/demo/touba.manifest.fragment.json"] };
      writeFileSync(projectPath, JSON.stringify(project));
      const generated = JSON.parse(readFileSync(fragment, "utf8"));
      const binding = generated.bindings["tool:integrations.demo/Lookup"];
      assert.equal(binding.handler.kind, "process");
      assert.equal(existsSync(join(root, binding.handler.args[0])), true);
      assert.equal(binding.handler_package, undefined);
      for (const mode of ["plan", "write", "check"]) {
        const result = await prepareProject({ root, mode, sourcePaths: [source] });
        assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics));
        if (mode !== "plan") assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
      }
      assert.equal(generator({ ...options, mode: "check" }).status, "success");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const shape of [{ type: ["string", "null"] }, { type: "string", enum: ["only"] }, { type: "object" }]) {
    test(`${kind} refuses an unsupported schema instead of weakening its contract: ${JSON.stringify(shape)}`, () => {
      const root = mkdtempSync(join(tmpdir(), "touba-import-refusal-"));
      try {
        const config = structuredClone(configs[kind]);
        (config.operation ?? config.tools[0]).inputSchema.properties.accountName = shape;
        const configPath = join(root, "import.json");
        writeFileSync(configPath, JSON.stringify(config));
        const report = generator({ root, configPath, moduleName: "integrations.demo", out: "out" });
        assert.ok(kind === "mcp" ? report.refused_tools.length === 1 : report.refused_operation);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test('multiple selected OpenAPI operations share a compilable module and remain idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'touba-rest-multiple-'));
  try {
    initProject({ root, language: 'python' });
    const config = { rest_scaffold_config_version: 'touba-rest-scaffold-config-v1', service: configs.rest.service,
      operation_ids: ['lookup', 'create'], openapi: { paths: Object.fromEntries(['lookup', 'create'].map(id => ['/' + id, { post: {
        operationId: id, requestBody: { content: { 'application/json': { schema } } }, responses: { '200': { content: { 'application/json': { schema } } } },
      } }])) } };
    const configPath = join(root, 'import.json');
    writeFileSync(configPath, JSON.stringify(config));
    const options = { root, configPath, moduleName: 'integrations.demo', out: 'integrations/demo' };
    const report = scaffoldRestTool({ ...options, mode: 'write' });
    assert.equal(report.status, 'success'); assert.equal(report.generated_tools.length, 2);
    assert.equal(report.files.filter(file => file.kind === 'handler').length, 2);
    for (const file of report.files.filter(file => file.kind === 'handler')) {
      const name = readFileSync(file.path, 'utf8').match(/import config from "\.\.\/([^"]+)"/)[1];
      assert.equal(existsSync(join(root, options.out, name)), true);
    }
    const projectPath = join(root, 'touba.project.json'), project = JSON.parse(readFileSync(projectPath));
    project.configuration = { binding_fragments: ['integrations/demo/touba.manifest.fragment.json'] };
    writeFileSync(projectPath, JSON.stringify(project));
    for (const mode of ['plan', 'write', 'check']) {
      const prepared = await prepareProject({ root, mode, sourcePaths: [join(root, options.out, 'src/demo.tb')] });
      assert.notEqual(prepared.status, 'error', JSON.stringify(prepared.diagnostics));
    }
    assert.equal(scaffoldRestTool({ ...options, mode: 'check' }).status, 'success');
    assert.equal(scaffoldRestTool({ ...options, mode: 'write' }).status, 'success');
    config.operation_ids = ['lookup', 'lookup']; writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => scaffoldRestTool(options), /distinct/);
    config.operation_ids = ['lookup']; config.openapi.paths['/duplicate'] = config.openapi.paths['/lookup'];
    writeFileSync(configPath, JSON.stringify(config));
    const ambiguous = scaffoldRestTool(options);
    assert.equal(ambiguous.status, 'error');
    assert.match(ambiguous.diagnostics[0].message, /ambiguous/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generated REST handler preserves optionals and bounds streamed UTF-8 bytes without redirects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'touba-rest-handler-'));
  try {
    const configPath = join(root, 'import.json'); writeFileSync(configPath, JSON.stringify(configs.rest));
    const options = { root, configPath, moduleName: 'integrations.demo', out: 'out', mode: 'write' };
    const report = scaffoldRestTool(options);
    const handlerSource = readFileSync(report.files.find(file => file.kind === 'handler').path, 'utf8');
    const config = JSON.parse(readFileSync(report.files.find(file => file.kind === 'rest_handler_config').path));
    let definition, sent, output = JSON.stringify({ accountName: 'A', tags: ['x', 'y'] });
    class ToubaHandlerError extends Error { constructor(code, message) { super(message); this.code = code; } }
    runInNewContext(handlerSource.replace(/import \{[\s\S]*?\} from "@touba\/sdk";/u, '')
      .replace(/import config from [^;]+;/u, '').replace('await defineTool(', 'defineTool('), {
      config, ToubaHandlerError, defineTool: value => { definition = value; }, URL, AbortController, Buffer, setTimeout, clearTimeout,
      fetch: async (url, init) => { sent = { url, init }; return new Response(output); },
    });
    const request = { account_name: 'A', max_items: { present: false }, tags: { present: true, value: ['x', 'y'] } };
    const result = JSON.parse(JSON.stringify(await definition.run({ request, context: { env: {} } })));
    assert.deepEqual(JSON.parse(sent.init.body), { accountName: 'A', tags: ['x', 'y'] });
    assert.equal(sent.init.redirect, 'error');
    assert.deepEqual(result.tags, { present: true, value: ['x', 'y'] });
    assert.deepEqual(result.max_items, { present: false });
    config.service.max_payload_bytes = 4; output = 'ééé';
    await assert.rejects(() => definition.run({ request, context: { env: {} } }), { code: 'RestPayloadTooLarge' });
    for (const path of ['//other.invalid/pay', '/\\other.invalid/pay', '/pay/{id}', '/pay?token=raw']) {
      const input = structuredClone(configs.rest); input.operation.path = path;
      writeFileSync(configPath, JSON.stringify(input));
      assert.equal(scaffoldRestTool({ ...options, mode: 'plan' }).status, 'error');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [kind, generator] of [['mcp', importMcpTools], ['rest', scaffoldRestTool]]) {
  test(`${kind} refuses file conflicts before creating anything and never follows symlinks`, () => {
    const root = mkdtempSync(join(tmpdir(), 'touba-import-files-'));
    try {
      const configPath = join(root, 'import.json'); writeFileSync(configPath, JSON.stringify(configs[kind]));
      const options = { root, configPath, moduleName: 'integrations.demo', out: 'out', mode: 'write' };
      mkdirSync(join(root, 'out')); writeFileSync(join(root, 'out/README.md'), 'existing user content');
      assert.throws(() => generator(options), /refusing to overwrite/);
      assert.equal(existsSync(join(root, 'out/src')), false);
      assert.equal(readFileSync(join(root, 'out/README.md'), 'utf8'), 'existing user content');
      mkdirSync(join(root, 'retained')); symlinkSync(join(root, 'retained'), join(root, 'linked'));
      assert.throws(() => generator({ ...options, out: 'linked', force: true }), /symbolic links/);
      assert.equal(existsSync(join(root, 'retained/src')), false);
      const config = structuredClone(configs[kind]);
      (config.operation ?? config.tools[0]).inputSchema.required.push('notDeclared');
      writeFileSync(configPath, JSON.stringify(config));
      const rejected = generator({ ...options, out: 'refused' });
      assert.equal(rejected.status, 'error'); assert.equal(existsSync(join(root, 'refused')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("generated adapters preserve wire names, omission, lists and reject implicit null", () => {
  const fields = [{ name: "account_name", originalName: "accountName", type: "Text", required: true }, { name: "max_items", originalName: "maxItems", type: "Int", required: false }];
  class ToubaHandlerError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const adapter = runInNewContext(`${renderJsonFieldAdapters({ inputFields: fields, outputFields: fields })}\n({ toJsonRequest, fromJsonResult })`, { ToubaHandlerError });
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(adapter.toJsonRequest({ account_name: "A", max_items: { present: false } })), { accountName: "A" });
  assert.deepEqual(plain(adapter.toJsonRequest({ account_name: "A", max_items: { present: true, value: 0 } })), { accountName: "A", maxItems: 0 });
  assert.deepEqual(plain(adapter.fromJsonResult({ accountName: "A" })), { account_name: "A", max_items: { present: false } });
  assert.deepEqual(plain(adapter.fromJsonResult({ accountName: "A", maxItems: 0 })), { account_name: "A", max_items: { present: true, value: 0 } });
  assert.throws(() => adapter.fromJsonResult({ accountName: "A", maxItems: null }), { code: "InvalidOutput" });
  assert.throws(() => adapter.fromJsonResult({}), { code: "InvalidOutput" });
  assert.throws(() => adapter.toJsonRequest({ account_name: "A", max_items: 4 }), { code: "InvalidArguments" });
});
