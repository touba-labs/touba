import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node.js";

async function startClient(t, env = process.env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url)), "--stdio"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const client = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  t.after(() => { client.dispose(); child.kill(); });
  client.listen();
  await client.sendRequest("initialize", { processId: process.pid, rootUri: null, capabilities: {} });
  await client.sendNotification("initialized", {});
  return client;
}

function nextDiagnostics(client, send) {
  return new Promise((resolve, reject) => {
    const subscription = client.onNotification("textDocument/publishDiagnostics", result => {
      subscription.dispose();
      resolve(result);
    });
    send().catch(reject);
  });
}

const uri = "file:///touba-diagnostics-session.tb";
const valid = 'module examples.diagnostics\n\nstrategy Run\n    do\n        show\n            with message as "ready"\n';
const invalid = 'module examples.diagnostics\n\nstrategy Run\n    do\n        show "test"\n';

test("real LSP compiles unsaved imported expressions and locates dependency errors separately", { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-lsp-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/examples"), { recursive: true });
  const commonPath = join(root, "src/examples/common.tb");
  const entryPath = join(root, "src/examples/search.tb");
  writeFileSync(commonPath, 'module examples.common\ntype Request\n    query is Text\n');
  const source = 'module examples.search\nimport type Request from examples.common\nfunction Label\n    takes request as Request\n    gives Text\n    do\n        give request.query ++ "!"\n';
  writeFileSync(entryPath, 'invalid disk content');
  const uri = pathToFileURL(entryPath).href;
  const client = await startClient(t);
  const result = await nextDiagnostics(client, () => client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "touba", version: 1, text: source },
  }));
  assert.deepEqual(result.diagnostics, []);
  const changed = await nextDiagnostics(client, () => client.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace("request.query", "request.missing") }],
  }));
  assert.ok(changed.diagnostics.some(d => d.code === "UnknownExpressionField" && d.range.start.line === 6));
  writeFileSync(commonPath, 'module examples.common\ntype Request\n    query is Missing\n');
  const dependency = await nextDiagnostics(client, () => client.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 }, contentChanges: [{ text: source }],
  }));
  assert.ok(dependency.diagnostics.some(d => d.relatedInformation?.[0].location.uri === pathToFileURL(realpathSync(commonPath)).href), JSON.stringify(dependency.diagnostics));
});

test("real LSP publishes syntax errors on open/change and clears them after correction/close", { timeout: 15000 }, async t => {
  const client = await startClient(t);
  const opened = await nextDiagnostics(client, () => client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "touba", version: 1, text: invalid },
  }));
  assert.equal(opened.uri, uri);
  assert.equal(opened.diagnostics.length, 1);
  assert.equal(opened.diagnostics[0].code, "AstError");
  assert.equal(opened.diagnostics[0].range.start.line, 4);
  assert.match(opened.diagnostics[0].message, /show.*block interaction/);

  for (const [version, text, errorCount] of [[2, valid, 0], [3, invalid, 1], [4, valid, 0]]) {
    const changed = await nextDiagnostics(client, () => client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version }, contentChanges: [{ text }],
    }));
    assert.equal(changed.diagnostics.length, errorCount);
  }
  const closed = await nextDiagnostics(client, () => client.sendNotification("textDocument/didClose", { textDocument: { uri } }));
  assert.deepEqual(closed.diagnostics, []);
});

test("an unavailable compiler produces an installation diagnostic, not a clean document", { timeout: 10000 }, async t => {
  const client = await startClient(t, { ...process.env, TOUBA_COMPILE_BIN: "/nonexistent/touba-diagnostics-test-compiler" });
  const result = await nextDiagnostics(client, () => client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "touba", version: 1, text: valid },
  }));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "CompilerUnavailable");
  assert.equal(result.diagnostics[0].severity, 1);
  const symbols = await client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
  assert.deepEqual(symbols, []);
});
