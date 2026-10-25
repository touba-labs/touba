import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine, ToubaEngineError } from "../src/index.mjs";
import { createSqliteTraceStore } from "../../touba-runtime/src/sqlite-trace-store.mjs";

test("reference mode returns a small business result when a real trace exceeds the SDK transport limit", { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-large-reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Long binding names make the trace large without enlarging business output.
  // Execute the actual compiler, runtime and SDK; do not substitute a fake trace.
  const binding = "value_" + "x".repeat(40000);
  writeFileSync(join(root, "large.tb"), `module large.reference\nstrategy Run\n    takes batches as List of Int\n    takes items as List of Int\n    gives Text\n    do\n        for batch in batches\n            for item in items\n                bind ${binding} as Int = item\n        give "done"\n`);
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath,
    commandArgs: ["--max-old-space-size=48", cli] });
  t.after(() => engine.close());
  const result = await engine.run({ source: "large.tb", inputs: {
    batches: Array.from({ length: 10 }, (_, i) => i), items: Array.from({ length: 90 }, (_, i) => i) },
    traceStore: "traces.sqlite", traceMode: "reference" });
  assert.equal(result.result, "done"); assert.equal(result.trace, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  const store = createSqliteTraceStore({ filename: join(root, "traces.sqlite"), readOnly: true });
  try {
    const [segment] = [...store.segments()];
    assert.ok(segment.bytes > 32 * 1024 * 1024, `${segment.bytes} bytes`);
    let count = 0, after;
    while (true) {
      const page = await engine.readTrace({ traceStore: "traces.sqlite", reference: result.traceReference, after, limit: 1000 });
      assert.ok(Buffer.byteLength(JSON.stringify(page.events)) < 1024 * 1024 + 2000);
      count += page.events.length; after = page.next;
      if (page.done) break;
    }
    assert.equal(count, result.traceReference.event_count);
    t.diagnostic(`${segment.bytes} serialized bytes; ${count} events; Core heap limit 48 MiB`);
  } finally { store.close(); }
});

const cli = fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url));

test("large UTF-8 results survive the real CLI, redirected files and SDK for every terminal outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-large-output-"));
  try {
    // Larger than both a pipe's buffer and spawnSync's default output buffer.
    const payload = "é🙂".repeat(200_000);
    const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli] });
    const cases = [
      ["success", "        give Payload", [], {}, 0, "success"],
      ["failure", "        give 1 / divisor", [], {}, 1, "failure"],
      ["pause", '        ask\n            with prompt as "Continue?"\n            into answer', [], {}, 3, "stopped"],
      ["stop", "        stop", [], {}, 4, "stopped"],
      ["cancel", '        ask\n            with prompt as "Continue?"\n            into answer', ["--cancel-on-pause"], { cancelOnPause: true }, 5, "cancelled"],
    ];
    for (const [name, tail, flags, sdkOptions, exitCode, status] of cases) {
      const source = `${name}.tb`;
      writeFileSync(join(root, source), `module large.${name}\ndefine Payload as Text = ${JSON.stringify(payload)}\nstrategy Run\n    takes divisor as Int\n    do\n        show\n            with message as Payload\n${tail}\n`);
      const { airJson } = await engine.compile({ source });
      writeFileSync(join(root, `${name}.air.json`), airJson);
      const args = [cli, "run", `${name}.air.json`, "--inputs-json", '{"divisor":0}', "--output", "json", ...flags];
      for (const redirected of [false, true]) {
        const outputPath = join(root, `${name}.json`);
        const fd = redirected ? openSync(outputPath, "w") : null;
        let child;
        try {
          child = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", fd ?? "pipe", "pipe"] });
        } finally { if (fd !== null) closeSync(fd); }
        assert.ifError(child.error);
        assert.equal(child.status, exitCode, child.stderr);
        const output = redirected ? readFileSync(outputPath, "utf8") : child.stdout;
        assert.ok(Buffer.byteLength(output) > 1024 * 1024);
        const envelope = JSON.parse(output);
        assert.equal(envelope.status, status);
        assert.equal(envelope.messages[0].text, payload);
        if (status === "success") assert.equal(envelope.result, payload);
      }
      const running = engine.run({ airJson, inputs: { divisor: 0 }, ...sdkOptions });
      if (status === "failure") {
        await assert.rejects(running, error => {
          assert.ok(error instanceof ToubaEngineError);
          assert.equal(error.details.exitCode, 1);
          assert.equal(error.details.status, "failure");
          assert.equal(error.details.messages[0].text, payload);
          return true;
        });
      } else {
        const result = await running;
        assert.equal(result.status, status);
        assert.equal(result.messages[0].text, payload);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
