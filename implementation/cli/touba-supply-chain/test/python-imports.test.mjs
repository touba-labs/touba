import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pythonImportClosure } from "../src/python-imports.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-python-imports-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); return target; };
  write("pyproject.toml", '[project]\nname = "business-handlers"\nversion = "0.1.0"\n');
  const scan = (options = {}) => pythonImportClosure(join(root, "main.py"), { packageRoot: root, ...options });
  return { root, write, scan };
}

test("Python closure follows packages, relative imports, namespace portions and cycles without executing code", t => {
  const { root, write, scan } = fixture(t);
  const marker = join(root, "MUST-NOT-EXIST");
  write("main.py", `import json\nfrom pathlib import Path\nfrom business import normalize, LABEL\nimport extra.formatting\nPath(${JSON.stringify(marker)}).write_text("executed")\n# import absent\nexample = "import absent"\n`);
  write("business/__init__.py", 'from . import normalize\nLABEL = "ok"\n');
  write("business/normalize.py", "from .detail import values\nfrom . import LABEL\n");
  write("business/detail/__init__.py", "from .. import normalize\n");
  write("business/detail/values.py", "VALUE = 42\n");
  write("extra/formatting.py", "import decimal\n");
  const result = scan();
  assert.deepEqual(result.files.map(file => relative(root, file)).sort(), ["business/__init__.py", "business/detail/__init__.py", "business/detail/values.py", "business/normalize.py", "extra/formatting.py", "main.py", "pyproject.toml"]);
  assert.equal(result.name, "business-handlers");
  assert.equal(result.has_dependencies, false);
  assert.equal(existsSync(marker), false);
});

test("Python scanner ignores PYTHONPATH and sitecustomize", t => {
  const { root, write, scan } = fixture(t);
  const marker = join(root, "MUST-NOT-EXIST");
  write("sitecustomize.py", `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  write("main.py", "import json\n");
  const previous = process.env.PYTHONPATH;
  try { process.env.PYTHONPATH = root; scan(); }
  finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
  assert.equal(existsSync(marker), false);
});

test("Python closure rejects dynamic loading and import path mutation including aliases", t => {
  const { write, scan } = fixture(t);
  for (const source of [
    '__import__("helper")',
    'import importlib as loader\nloader.import_module("helper")',
    'from importlib import import_module as load\nload("helper")',
    'exec("import helper")',
    'import sys as system\nsystem.path.append("elsewhere")',
    'from sys import path as lookup\nlookup.insert(0, "elsewhere")',
    'import sys\nsys.path[0] = "elsewhere"',
    'import sys\nsys.modules["helper"] = object()',
  ]) {
    write("main.py", source);
    assert.throws(() => scan(), { code: "HandlerImportDynamic" }, source);
  }
});

test("Python closure refuses absent local modules, invalid relative roots and malformed code", t => {
  const { write, scan } = fixture(t);
  write("pkg/__init__.py", "");
  for (const source of ["from pkg.missing import value", "from . import helper", "import pkg.missing"]) {
    write("main.py", source);
    assert.throws(() => scan(), { code: "HandlerImportMissing" });
  }
  write("main.py", "def broken(:");
  assert.throws(() => scan(), { code: "HandlerImportInvalid" });
});

test("Python identity/dependencies are static and TOML is not evaluated", t => {
  const { write, scan } = fixture(t);
  write("main.py", "import touba_sdk\n");
  write("pyproject.toml", '[project]\nname = "python-handlers"\nversion = "0.1.0"\n[project.optional-dependencies]\ntests = ["pytest==8.0.0"]\n');
  assert.equal(scan().has_dependencies, true);
  for (const text of [
    '[project]\nname = "x"\ndynamic = ["version"]\n',
    '[project]\nname = "x"\nversion = "1"\ndynamic = ["dependencies"]\n',
    '[project]\nname = "x"\nversion = "1"\ndependencies = [42]\n',
  ]) {
    write("pyproject.toml", text);
    assert.throws(() => scan(), { code: "HandlerPackageInvalid" });
  }
});

test("Python inventory includes local stdlib-name shadows and respects module/package precedence", t => {
  const { root, write, scan } = fixture(t);
  write("main.py", "import json\nimport pkg\nimport namespace\n");
  write("json.py", "VALUE = 1\n");
  write("pkg/__init__.py", "");
  write("pkg.py", "exec('must not parse this shadowed module')\n");
  write("namespace.py", "VALUE = 2\n");
  mkdirSync(join(root, "namespace"));
  assert.deepEqual(scan().files.map(file => relative(root, file)).sort(), ["json.py", "main.py", "namespace.py", "pkg/__init__.py", "pyproject.toml"]);
});

test("Python file/byte budgets, unavailable interpreter and symlink escapes fail closed", t => {
  const { root, write, scan } = fixture(t);
  write("main.py", "VALUE = 1\n");
  assert.throws(() => scan({ maxFiles: 1 }), { code: "HandlerImportInvalid" });
  assert.throws(() => scan({ maxBytes: 10 }), { code: "HandlerImportInvalid" });
  assert.throws(() => scan({ python: join(root, "absent-python") }), { code: "HandlerImportInvalid" });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "touba-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.py"), "VALUE = 1\n");
  symlinkSync(join(outside, "secret.py"), join(root, "escape.py"));
  write("main.py", "import escape\n");
  assert.throws(() => scan(), { code: "HandlerImportInvalid" });
});

test("Python root aliases preserve caller paths and source encodings", t => {
  const { root, write } = fixture(t);
  write("main.py", Buffer.from('# coding: latin-1\nTEXT = "caf\xe9"\n', "latin1"));
  const aliasRoot = realpathSync(mkdtempSync(join(tmpdir(), "touba-alias-")));
  t.after(() => rmSync(aliasRoot, { recursive: true, force: true }));
  const alias = join(aliasRoot, "project");
  symlinkSync(root, alias, "dir");
  const result = pythonImportClosure(join(alias, "main.py"), { packageRoot: alias });
  assert.deepEqual(result.files, [join(alias, "main.py"), join(alias, "pyproject.toml")]);
});
