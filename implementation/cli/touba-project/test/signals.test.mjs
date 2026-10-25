import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// The same regression is also run against the extracted distribution launcher.
const command = process.env.TOUBA_SIGNAL_TEST_CLI ?? process.execPath;
const prefix = process.env.TOUBA_SIGNAL_TEST_CLI ? [] : [fileURLToPath(new URL("../src/main.mjs", import.meta.url))];
const posix = process.platform !== "win32";

for (const service of ["project", "trigger"]) {
  for (const [signal, group] of [["SIGTERM", false], ["SIGINT", false], ["SIGHUP", false], ["SIGINT", true]]) {
    test(`${service} service: ${signal} to ${group ? "group" : "launcher PID"} stops child and permits restart`,
      { skip: !posix, timeout: 25_000 }, async () => {
        const root = mkdtempSync(join(tmpdir(), "touba signal lifecycle "));
        const processes = [];
        try {
          const args = fixture(root, service);
          const first = await start(args, root, 0, processes);
          const pids = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
          assert.equal(pids.status, 0, pids.stderr);
          const childPids = pids.stdout.trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number))
            .filter(([, parent]) => parent === first.child.pid).map(([pid]) => pid);
          assert.equal(childPids.length, 1, "the public CLI must have one direct service child");
          process.kill(group ? -first.child.pid : first.child.pid, signal);
          const ended = await untilExit(first);
          assert.equal(ended.signal, signal, JSON.stringify(ended));
          assert.equal(await listening(first.port), false, "service still listening after launcher exit");
          for (const pid of childPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

          const restarted = await start(args, root, first.port, processes);
          assert.equal(restarted.port, first.port);
          restarted.child.kill("SIGTERM");
          assert.equal((await untilExit(restarted)).signal, "SIGTERM");
          assert.equal(await listening(first.port), false);
        } finally {
          // Cleanup is not the assertion: only our detached test groups are targeted.
          for (const state of processes) {
            try { process.kill(-state.child.pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
            state.child.stdout.destroy();
            state.child.stderr.destroy();
          }
          await Promise.all(processes.map(state => state.exited));
          rmSync(root, { recursive: true, force: true });
        }
      });
  }
}

function fixture(root, service) {
  if (service === "project") return ["serve", "--project-root", root];
  const source = join(root, "signals.tb");
  const air = join(root, "signals.air.json");
  const manifest = join(root, "touba.manifest.json");
  writeFileSync(source, `module signals
strategy Run
    gives Text
    do
        give "ready"
trigger Webhook
    on request POST "/run"
    runs strategy Run
    limits
        max_runs_per_day as 10
        timeout_ms as 30000
`);
  const compile = spawnSync(command, [...prefix, "compile", source, "--stdout"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  writeFileSync(air, compile.stdout);
  writeFileSync(manifest, JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {},
    triggers: { "trigger:signals/Webhook": { enabled: true, source: { kind: "request" },
      limits: { max_runs_per_day: 10, timeout_ms: 30000 } } } }));
  return ["trigger", "serve", air, "--manifest", manifest,
    "--state", join(root, "touba.triggers.sqlite"), "--queue", join(root, "touba.trigger-queue.sqlite")];
}

async function start(args, root, port, processes) {
  const child = spawn(command, [...prefix, ...args, "--host", "127.0.0.1", "--port", String(port)],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, output: "", error: "", outcome: null };
  state.exited = new Promise(resolve => child.once("exit", (code, signal) => {
    state.outcome = { code, signal }; resolve(state.outcome);
  }));
  child.stdout.on("data", chunk => { state.output += chunk; });
  child.stderr.on("data", chunk => { state.error += chunk; });
  processes.push(state);
  for (let attempt = 0; attempt < 200; attempt++) {
    const line = state.output.split("\n").find(text => text.includes('_started"'));
    if (line) {
      state.port = JSON.parse(line).port;
      assert.ok(await listening(state.port), state.output + state.error);
      return state;
    }
    assert.equal(state.outcome, null, state.output + state.error);
    await delay(25);
  }
  assert.fail(`No startup event: ${state.output} ${state.error}`);
}

async function untilExit(state) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (state.outcome) return state.outcome;
    await delay(25);
  }
  assert.fail(`Launcher did not exit: ${state.error}`);
}

async function listening(port) {
  try {
    // Even a 404 is a live HTTP service; do not mistake it for a stopped one.
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return false;
    throw error;
  }
}
