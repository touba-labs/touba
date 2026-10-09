import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node.js";
import { isMainModule } from "../src/server.mjs";

const serverUrl = new URL("../src/server.mjs", import.meta.url);

function symlinkedEntrypoint(t) {
  const directory = mkdtempSync(join(tmpdir(), "touba-lsp-entrypoint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const linkedSource = join(directory, "linked-source");
  symlinkSync(dirname(fileURLToPath(serverUrl)), linkedSource, process.platform === "win32" ? "junction" : "dir");
  return { directory, entry: join(linkedSource, "server.mjs") };
}

test("LSP entrypoint compares real files and does not classify an absent or different entry as main", (t) => {
  const { directory, entry } = symlinkedEntrypoint(t);
  assert.equal(isMainModule(serverUrl, entry), true);
  assert.equal(isMainModule(serverUrl, undefined), false);
  assert.equal(isMainModule(serverUrl, ""), false);
  assert.equal(isMainModule(serverUrl, join(directory, "absent.mjs")), false);
  assert.equal(isMainModule(serverUrl, fileURLToPath(import.meta.url)), false);
});

test("LSP really starts through a symlinked entrypoint and completes a stdio handshake", { timeout: 10000 }, async (t) => {
  const { entry } = symlinkedEntrypoint(t);
  const server = spawn(process.execPath, [entry, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const client = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  t.after(() => { client.dispose(); server.kill(); });
  client.listen();
  const initialized = await Promise.race([
    client.sendRequest("initialize", { processId: process.pid, rootUri: null, capabilities: {} }),
    exited.then((result) => { throw new Error(`LSP exited before initialize: ${JSON.stringify(result)} ${stderr}`); }),
  ]);
  assert.equal(initialized.capabilities.definitionProvider, true);
  assert.equal(initialized.capabilities.documentSymbolProvider, true);
  await client.sendNotification("initialized", {});
  await client.sendRequest("shutdown");
  await client.sendNotification("exit");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("importing the LSP through a symlink does not start a server", (t) => {
  const { directory, entry } = symlinkedEntrypoint(t);
  const source = `await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write("import-only\\n");`;
  const importer = join(directory, "importer.mjs");
  writeFileSync(importer, source, "utf8");
  for (const args of [[importer], ["--input-type=module", "--eval", source]]) {
    assert.equal(execFileSync(process.execPath, args, { encoding: "utf8", timeout: 5000 }), "import-only\n");
  }
});
