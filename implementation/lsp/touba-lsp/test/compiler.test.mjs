import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compilerCommandSpec, parseCompilerEnvelope, runToubaCompileJson } from "../src/server.mjs";

test("an incomplete compiler envelope cannot clear diagnostics", () => {
  for (const response of [
    null, {}, { ok: false, air: null, diagnostics: [] },
    { ok: true, air: null, diagnostics: [] }, { ok: true, air: {}, diagnostics: [] },
    { ok: false, air: null, diagnostics: [null] },
  ]) {
    assert.throws(() => parseCompilerEnvelope(JSON.stringify(response)), /Invalid Touba compiler response/);
  }
});

function implementationFixture(t, files = []) {
  const directory = mkdtempSync(join(tmpdir(), "touba-lsp-compiler-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "", "utf8");
  }
  return directory;
}

test("LSP prefers the explicitly configured compiler over bundle and Cargo", (t) => {
  const implementationDir = implementationFixture(t, ["bin/touba-compile"]);
  assert.deepEqual(compilerCommandSpec("/source space/source.tb", {
    implementationDir,
    env: { TOUBA_COMPILE_BIN: "/explicit/touba-compile", CARGO: "/unused/cargo" },
  }), { command: "/explicit/touba-compile", args: ["--json", "/source space/source.tb"] });
});

test("LSP uses the bundled native compiler without Cargo sources on every supported platform", (t) => {
  const implementationDir = implementationFixture(t, ["bin/touba-compile", "bin/touba-compile.exe"]);
  for (const platform of ["darwin", "linux", "win32"]) {
    const executable = platform === "win32" ? "touba-compile.exe" : "touba-compile";
    assert.deepEqual(compilerCommandSpec("source.tb", {
      implementationDir, platform, env: { CARGO: "/unused/cargo" },
    }), { command: join(implementationDir, "bin", executable), args: ["--json", "source.tb"] });
  }
});

test("LSP permits Cargo only when the selected implementation has local compiler sources", (t) => {
  const implementationDir = implementationFixture(t, [
    "Cargo.toml", "compiler/touba-compiler/Cargo.toml", "cli/touba-cli/Cargo.toml",
  ]);
  assert.deepEqual(compilerCommandSpec("source.tb", {
    implementationDir, env: { CARGO: "/explicit/cargo" },
  }), {
    command: "/explicit/cargo",
    args: ["run", "--manifest-path", join(implementationDir, "Cargo.toml"), "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", "--json", "source.tb"],
  });
});

test("LSP rejects an incomplete bundle rather than discovering another checkout", (t) => {
  const implementationDir = implementationFixture(t, ["Cargo.toml"]);
  assert.throws(() => compilerCommandSpec("source.tb", {
    implementationDir, env: { CARGO: "/unused/cargo" },
  }), /Touba compiler unavailable.*Cargo requires local compiler sources/);
});

test("LSP does not fall back when the explicitly selected compiler fails", (t) => {
  const implementationDir = implementationFixture(t, ["bin/touba-compile"]);
  const missingCompiler = join(implementationDir, "missing-compiler");
  assert.throws(() => runToubaCompileJson("source.tb", {
    implementationDir, env: { ...process.env, TOUBA_COMPILE_BIN: missingCompiler },
  }), (error) => error.code === "ENOENT" && error.path === missingCompiler);
});
