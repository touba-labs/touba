import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pythonSharedLibraryFiles } from "../src/sdk-sandbox.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-python-libraries-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "python"), libdir = join(base, "lib");
  mkdirSync(libdir, { recursive: true });
  const file = join(libdir, "libpython3.14.so.1.0");
  writeFileSync(file, "synthetic-library");
  return { root, base, libdir, file, metadata: { base_prefix: base, version: [3, 14], shared: 1,
    libdir, ldlibrary: "libpython3.14.so.1.0", instsoname: "libpython3.14.so.1.0" } };
}

test("Python inventory selects the exact shared library including its SONAME suffix", t => {
  const f = fixture(t);
  writeFileSync(join(f.libdir, "unrelated.txt"), "private-fixture");
  assert.deepEqual(pythonSharedLibraryFiles(f.metadata), [f.file]);
  assert.deepEqual(pythonSharedLibraryFiles({ ...f.metadata, shared: 0 }), []);
});

test("Python inventory rejects missing, traversing and foreign library metadata", t => {
  const f = fixture(t), invalid = { code: "SdkSandboxConfigurationInvalid" };
  for (const ldlibrary of ["../libpython3.14.so.1.0", "/libpython3.14.so.1.0", "libpython3.13.so", "libpython3.14.so\0", {}, "libpython3.14.so.9"]) {
    assert.throws(() => pythonSharedLibraryFiles({ ...f.metadata, ldlibrary }), invalid);
  }
  for (const libdir of [f.root, ".", join(f.root, "missing"), f.file]) {
    assert.throws(() => pythonSharedLibraryFiles({ ...f.metadata, libdir }), invalid);
  }
  assert.throws(() => pythonSharedLibraryFiles({ ...f.metadata, ldlibrary: null, instsoname: null }), invalid);
  assert.throws(() => pythonSharedLibraryFiles({ ...f.metadata, shared: "1" }), invalid);
});

test("Python inventory resolves in-prefix links and refuses links outside the installation", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  symlinkSync(f.file, join(f.libdir, "libpython3.14.so"));
  assert.deepEqual(pythonSharedLibraryFiles({ ...f.metadata, ldlibrary: "libpython3.14.so" }), [f.file]);
  const outside = join(f.root, "private.txt"); writeFileSync(outside, "private-fixture");
  symlinkSync(outside, join(f.libdir, "libpython3.14.so.2"));
  assert.throws(() => pythonSharedLibraryFiles({ ...f.metadata, ldlibrary: "libpython3.14.so.2" }), { code: "SdkSandboxConfigurationInvalid" });
});
