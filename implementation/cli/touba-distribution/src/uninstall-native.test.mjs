import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { renderUninstallPowerShell } from "./package-release.mjs";

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(`archive uninstall preserves user data and refuses unsafe paths (${shell})`, { skip: process.platform !== "win32" }, async t => {
    const root = mkdtempSync(join(tmpdir(), "touba-uninstall-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, "uninstall.ps1");
    writeFileSync(script, renderUninstallPowerShell(), "utf8");
    const write = (path, content = "keep") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
    const invoke = prefix => spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Prefix", prefix], { encoding: "utf8", timeout: 30000 });
    const fixture = name => {
      const prefix = join(root, name);
      write(join(prefix, "bin/touba.cmd"), "owned");
      write(join(prefix, "touba-toolchain/bin/node.exe"), "fixture");
      write(join(prefix, "INSTALLATION.json"), JSON.stringify({
        installation_profile: "touba-local-release-install-experimental-v1", platform: "win32-x64",
        prefix, cli_path: join(prefix, "bin/touba.cmd"),
      }));
      return prefix;
    };
    await t.test("empty containers are removed without prompting", () => {
      const prefix = fixture("empty install");
      const result = invoke(prefix);
      assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(prefix), false);
      assert.equal(invoke(prefix).status, 0, "already absent is safe");
    });
    await t.test("literal brackets, spaces, saved builds and other files", () => {
      const prefix = fixture("kept [build] with spaces");
      for (const name of ["builds/old-build/payload", "bin/another-tool.cmd", "projects/customer/data"]) write(join(prefix, name));
      const result = invoke(prefix); assert.equal(result.status, 0, result.stderr);
      for (const name of ["builds/old-build/payload", "bin/another-tool.cmd", "projects/customer/data"]) assert.equal(readFileSync(join(prefix, name), "utf8"), "keep");
      for (const name of ["bin/touba.cmd", "touba-toolchain", "INSTALLATION.json"]) assert.equal(existsSync(join(prefix, name)), false);
    });
    await t.test("missing or mismatched metadata removes nothing", () => {
      for (const mode of ["missing", "mismatch"]) {
        const prefix = fixture(mode);
        if (mode === "missing") rmSync(join(prefix, "INSTALLATION.json"));
        else write(join(prefix, "INSTALLATION.json"), JSON.stringify({ installation_profile: "foreign" }));
        assert.notEqual(invoke(prefix).status, 0);
        assert.ok(existsSync(join(prefix, "bin/touba.cmd")));
        assert.ok(existsSync(join(prefix, "touba-toolchain/bin/node.exe")));
      }
    });
    await t.test("filesystem root and home are refused before inspection", () => {
      for (const prefix of [parse(root).root, process.env.USERPROFILE]) {
        const result = invoke(prefix); assert.notEqual(result.status, 0);
        assert.match(result.stderr, /filesystem root or home directory/);
      }
    });
    await t.test("junctions do not redirect removal", () => {
      const prefix = fixture("junction install"), external = join(root, "outside");
      write(join(external, "important"));
      symlinkSync(external, join(prefix, "touba-toolchain/linked"), "junction");
      const result = invoke(prefix); assert.notEqual(result.status, 0); assert.match(result.stderr, /reparse/);
      assert.equal(readFileSync(join(external, "important"), "utf8"), "keep");
      assert.ok(existsSync(join(prefix, "bin/touba.cmd")));
    });
  });
}
