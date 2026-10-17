import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runPassthrough } from "../src/passthrough.mjs";

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const listeners = () => signals.map(signal => process.listeners(signal));

test("passthrough preserves child exit codes and restores signal listeners", async () => {
  const before = listeners();
  for (const code of [0, 1, 2, 3, 4, 5, 42]) {
    const result = await runPassthrough(process.execPath, ["-e", `process.exitCode = ${code}`]);
    assert.deepEqual(result, { passthrough: true, exitCode: code, signal: null });
    assert.deepEqual(listeners(), before);
  }
});

test("passthrough reports launch failure and restores signal listeners", async () => {
  const before = listeners();
  await assert.rejects(runPassthrough(process.execPath, [], { cwd: `/touba-absent-cwd-${process.pid}` }), { code: "ENOENT" });
  assert.deepEqual(listeners(), before);
});

test("passthrough preserves a child's own terminating signal", { skip: process.platform === "win32" }, async () => {
  const before = listeners();
  const result = await runPassthrough(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']);
  assert.deepEqual(result, { passthrough: true, exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(listeners(), before);
});

test("passthrough waits for a child that handles SIGTERM and keeps its final output/code",
  { skip: process.platform === "win32", timeout: 10_000 }, async () => {
    const childProgram = `
      const timer = setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {
        setTimeout(() => {
          clearInterval(timer);
          process.stdout.write("CHILD_CLEANUP_DONE\\n");
          process.exitCode = 7;
        }, 100);
      });
      process.stdout.write("CHILD_READY\\n");
    `;
    const parentProgram = `
      import { runPassthrough } from ${JSON.stringify(new URL("../src/passthrough.mjs", import.meta.url).href)};
      const result = await runPassthrough(process.execPath, ["-e", ${JSON.stringify(childProgram)}]);
      process.stdout.write("PARENT_DONE\\n");
      process.exitCode = result.exitCode;
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentProgram],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorOutput = "", outcome;
    const exited = new Promise(resolve => parent.once("exit", (code, signal) => { outcome = { code, signal }; resolve(); }));
    parent.stdout.on("data", chunk => { output += chunk; });
    parent.stderr.on("data", chunk => { errorOutput += chunk; });
    try {
      for (let attempt = 0; attempt < 200 && !output.includes("CHILD_READY"); attempt++) {
        assert.equal(outcome, undefined, errorOutput);
        await delay(25);
      }
      assert.match(output, /CHILD_READY/u, errorOutput);
      parent.kill("SIGTERM");
      for (let attempt = 0; attempt < 200 && !outcome; attempt++) await delay(25);
      assert.deepEqual(outcome, { code: 7, signal: null });
      assert.match(output, /CHILD_CLEANUP_DONE\nPARENT_DONE\n/u);
    } finally {
      try { process.kill(-parent.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      await exited;
      parent.stdout.destroy(); parent.stderr.destroy();
    }
  });
