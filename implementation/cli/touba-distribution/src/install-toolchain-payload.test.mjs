import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installToolchainPayload } from "./install-toolchain-payload.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";

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
  symlinkSync(new URL(".", import.meta.url).pathname, alias, process.platform === "win32" ? "junction" : "dir");
  const report = JSON.parse(execFileSync(process.execPath, [join(alias, "install-toolchain-payload.mjs"),
    "--source", a.dir, "--prefix", join(root, "installed")], { encoding: "utf8" }));
  assert.equal(report.build_id, a.build.id);
  assert.equal(existsSync(join(report.install_root, "bin/touba-test.mjs")), true);
});
