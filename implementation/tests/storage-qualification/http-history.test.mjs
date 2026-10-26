import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

test("HTTP histories: fresh-process audits, repeated concurrent decisions and resumptions", { timeout: 6 * 60 * 60 * 1000 }, async t => {
  const name = `touba-http-qa-${randomUUID()}`;
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const frozen = mkdtempSync(join(tmpdir(), "touba-http-sources-"));
  t.after(() => rmSync(frozen, { recursive: true, force: true }));
  const counts = process.env.TOUBA_HTTP_HISTORY_COUNTS ?? "0,100,1000,10000";
  assert.match(counts, /^(?:0|[1-9][0-9]{0,3}|10000)(?:,(?:0|[1-9][0-9]{0,3}|10000)){0,3}$/);
  const retainEvidence = Boolean(process.env.TOUBA_HTTP_HISTORY_EVIDENCE_DIR);
  const evidence = retainEvidence
    ? mkdtempSync(join(resolve(process.env.TOUBA_HTTP_HISTORY_EVIDENCE_DIR), "http-history-")) : null;
  const args = ["run", ...(retainEvidence ? [] : ["--rm"]), "--pull", "never", "--name", name,
    "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", "--memory", "768m", "--cpus", "1", "--pids-limit", "128",
    "--workdir", "/source/implementation", "--env", `TOUBA_HTTP_HISTORY_COUNTS=${counts}`,
    "--env", "TOUBA_HTTP_HISTORY_MATRIX=1"];
  if (retainEvidence) {
    // Optional synthetic baseline retention happens inside the fixture only
    // after timed repetitions. Never copy or pause a live measurement.
    args.push("--env", "TOUBA_HTTP_HISTORY_EVIDENCE_DIR=/tmp/touba-http-evidence");
    t.diagnostic(`Synthetic baseline evidence: ${evidence}`);
  }
  // Mount only required source trees. No .env, credential, Git or personal
  // project is exposed. State lives on the disposable container's disk layer.
  for (const path of ["cli", "runtime", "contracts", "tools", "node_modules", "package.json", "tests/traces"]) {
    cpSync(join(source, path), join(frozen, path), { recursive: true, verbatimSymlinks: true,
      filter: file => !relative(source, file).split(sep).some(part =>
        [".git", ".env", ".venv", "__pycache__", "dist", "target"].includes(part)) });
    args.push("--mount", `type=bind,source=${join(frozen, path)},target=/source/implementation/${path},readonly`);
  }
  args.push("node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205",
    "node", "--max-old-space-size=512", "--test", "--test-name-pattern=WAIT [0-9]+ completed approvals",
    "cli/touba-project-server/test/durable-human-waits.test.mjs");
  const cleanup = () => {
    try { execFileSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 15000 }); }
    catch { /* --rm already removed this test container */ }
  };
  t.after(cleanup);
  t.signal.addEventListener("abort", cleanup, { once: true });
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], signal: t.signal });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (retainEvidence) {
    // Copy only after the test process exits, before removing its container.
    // The host evidence directory stays private and is never mounted writable.
    await promisify(execFile)("docker", ["cp", `${name}:/tmp/touba-http-evidence/.`, evidence], { timeout: 60000 });
  }
  assert.equal(code, 0, "HTTP matrix failed; retain preceding raw observations");
});
