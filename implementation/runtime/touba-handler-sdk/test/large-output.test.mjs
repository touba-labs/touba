import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine, ToubaEngineError } from "../src/index.mjs";

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
