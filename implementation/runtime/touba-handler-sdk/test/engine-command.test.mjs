import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveEngineCommand } from "../src/engine-command.mjs";

function fixture(t, installed) {
  const temp = mkdtempSync(join(tmpdir(), "touba-launch-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const prefix = join(temp, "Touba & équipe %PATH% !");
  const root = installed ? join(prefix, "touba-toolchain") : prefix;
  for (const file of ["bin/node.exe", "bin/touba-compile.exe", "lib/cli/touba-project/src/main.mjs"]) {
    mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), "not executed");
  }
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin/touba.cmd"), "This batch must never be interpreted");
  writeFileSync(join(root, "TOOLCHAIN.json"), JSON.stringify({ toolchain_profile: "touba-local-toolchain-v1", platform: "win32-x64" }));
  const env = { Path: join(prefix, "bin"), TOUBA_DISTRIBUTION_CHANNEL: "release-test", touba_compile_bin: "wrong" };
  return { root, prefix, env, args: ["--inputs-json", '{"text":"a & b | %TEMP% ! é"}'], cwd: temp, platform: "win32" };
}

for (const installed of [false, true]) test(`Windows discovery: ${installed ? "installed prefix" : "extracted bundle"}, exact argv and environment`, t => {
  const f = fixture(t, installed);
  for (const command of ["touba", join(f.prefix, "bin/touba.cmd")]) {
    const launch = resolveEngineCommand({ ...f, command });
    assert.equal(launch.command, join(f.root, "bin/node.exe"));
    assert.deepEqual(launch.args, [join(f.root, "lib/cli/touba-project/src/main.mjs"), ...f.args]);
    assert.equal(launch.env.TOUBA_COMPILE_BIN, join(f.root, "bin/touba-compile.exe"));
    assert.equal(launch.env.touba_compile_bin, undefined);
    assert.equal(launch.env.TOUBA_DISTRIBUTION_CHANNEL, "release-test");
    assert.equal(f.env.touba_compile_bin, "wrong");
  }
});

test("Windows discovery refuses incomplete/foreign batch wrappers and never falls back to a second PATH entry", t => {
  const f = fixture(t, true);
  const second = fixture(t, false);
  f.env.Path += `;${join(second.prefix, "bin")}`;
  for (const metadata of [null, {}, { toolchain_profile: "touba-local-toolchain-v1", platform: "darwin-arm64" }]) {
    writeFileSync(join(f.root, "TOOLCHAIN.json"), JSON.stringify(metadata));
    assert.throws(() => resolveEngineCommand({ ...f, command: "touba" }), { code: "EngineBatchLauncherUnsupported" });
  }
  writeFileSync(join(f.prefix, "bin/custom.cmd"), "exit /b 0");
  assert.throws(() => resolveEngineCommand({ ...f, command: "custom.cmd" }), { code: "EngineBatchLauncherUnsupported" });
});

test("Windows discovery uses the same case-insensitive PATH as the child process", t => {
  const f = fixture(t, true);
  const env = { ...f.env, Path: "not-the-installation", PATH: f.env.Path };
  const launch = resolveEngineCommand({ ...f, env, command: "touba" });
  assert.equal(launch.command, join(f.root, "bin/node.exe"));
  assert.equal(launch.env.Path, undefined);
  assert.match(launch.env.PATH, /touba-toolchain/);
});

test("Executable and non-Windows command transports stay shell-free and preserve arguments", t => {
  const f = fixture(t, true);
  writeFileSync(join(f.prefix, "bin/touba.exe"), "native");
  assert.equal(resolveEngineCommand({ ...f, command: "touba" }).command, join(f.prefix, "bin/touba.exe"));
  const launch = resolveEngineCommand({ ...f, command: "touba", platform: "darwin" });
  assert.equal(launch.command, "touba"); assert.deepEqual(launch.args, f.args);
  assert.deepEqual(launch.env, f.env);
});
