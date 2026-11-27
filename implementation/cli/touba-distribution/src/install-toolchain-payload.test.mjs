import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installToolchainPayload } from "./install-toolchain-payload.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";
import { fileURLToPath } from "node:url";


function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-install-preservation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function candidate(name) {
    const dir = join(root, name);
    for (const part of ["bin", "lib", "sdk"]) mkdirSync(join(dir, part), { recursive: true });
    writeFileSync(join(dir, "bin/touba-test.mjs"), `process.stdout.write(${JSON.stringify(name)});`);
    const build = toolchainBuildIdentity(dir);
    writeFileSync(join(dir, "TOOLCHAIN.json"), JSON.stringify({ build }));
    return { dir, build };
  }
  return { root, prefix: join(root, "installation"), candidate };
}

test("transition preserves an independently invocable prior build and its exact bytes", t => {
  const { candidate, prefix } = fixture(t);
  const a = candidate("build-a"), b = candidate("build-b");
  installToolchainPayload({ source: a.dir, prefix });
  assert.throws(() => installToolchainPayload({ source: b.dir, prefix }), { code: "InstallationExists" });
  const changed = installToolchainPayload({ source: b.dir, prefix, force: true });
  assert.equal(changed.preserved_build, join(prefix, "builds", a.build.id));
  assert.deepEqual(toolchainBuildIdentity(changed.preserved_build), a.build);
  assert.equal(execFileSync(process.execPath, [join(changed.preserved_build, "bin/touba-test.mjs")], { encoding: "utf8" }), "build-a");
  assert.equal(execFileSync(process.execPath, [join(changed.install_root, "bin/touba-test.mjs")], { encoding: "utf8" }), "build-b");
  assert.equal(installToolchainPayload({ source: b.dir, prefix, force: true }).unchanged, true);
  assert.deepEqual(toolchainBuildIdentity(changed.preserved_build), a.build);
});

test("candidate corruption, concurrent installation and unsafe targets leave the active build intact", t => {
  const { root, candidate, prefix } = fixture(t);
  const a = candidate("build-a"), b = candidate("build-b");
  installToolchainPayload({ source: a.dir, prefix });
  writeFileSync(join(b.dir, "lib/altered"), "unverified");
  assert.throws(() => installToolchainPayload({ source: b.dir, prefix, force: true }), { code: "InstallationBuildMismatch" });
  assert.deepEqual(toolchainBuildIdentity(join(prefix, "touba-toolchain")), a.build);
  writeFileSync(join(prefix, ".install.lock"), "another installer");
  assert.throws(() => installToolchainPayload({ source: a.dir, prefix, force: true }), { code: "InstallationInProgress" });
  assert.equal(readFileSync(join(prefix, ".install.lock"), "utf8"), "another installer");
  assert.throws(() => installToolchainPayload({ source: a.dir, prefix: join(a.dir, "nested") }), { code: "InstallationPathsOverlap" });
  assert.equal(existsSync(join(a.dir, "nested")), false);
  const unsafe = join(root, "unsafe"); mkdirSync(unsafe);
  symlinkSync(join(root, "absent"), join(unsafe, "touba-toolchain"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installToolchainPayload({ source: a.dir, prefix: unsafe, force: true }), { code: "InstallationPathUnsafe" });
});

test("installer command executes through a symlinked temporary parent", t => {
  const { root, candidate } = fixture(t);
  const a = candidate("candidate"), alias = join(root, "script-alias");
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), alias, process.platform === "win32" ? "junction" : "dir");
  const report = JSON.parse(execFileSync(process.execPath, [join(alias, "install-toolchain-payload.mjs"),
    "--source", a.dir, "--prefix", join(root, "installed")], { encoding: "utf8" }));
  assert.equal(report.build_id, a.build.id);
  assert.equal(existsSync(join(report.install_root, "bin/touba-test.mjs")), true);
});

test("commit failure restores the old payload; pre-activation failure never moves it", t => {
  const { candidate, prefix } = fixture(t);
  const a = candidate('previous'), b = candidate('candidate');
  installToolchainPayload({ source: a.dir, prefix });
  for (const hook of ['beforeActivate', 'commit']) {
    assert.throws(() => installToolchainPayload({ source: b.dir, prefix, force: true,
      [hook]() { throw new Error('injected failure'); } }), /injected failure/);
    assert.deepEqual(toolchainBuildIdentity(join(prefix, 'touba-toolchain')), a.build);
    assert.equal(existsSync(join(prefix, '.install.lock')), false);
  }
});

test("a failed first installation leaves no active payload and can be retried", t => {
  const { candidate, prefix } = fixture(t);
  const payload = candidate("first");
  const installRoot = join(prefix, "touba-toolchain");
  assert.throws(() => installToolchainPayload({
    source: payload.dir, prefix,
    commit() { throw new Error("injected first commit failure"); },
  }), /injected first commit failure/);
  assert.equal(existsSync(installRoot), false);
  assert.equal(existsSync(join(prefix, ".install.lock")), false);
  assert.equal(installToolchainPayload({ source: payload.dir, prefix }).build_id, payload.build.id);
});
