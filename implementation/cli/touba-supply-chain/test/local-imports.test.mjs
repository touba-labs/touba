import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { localImportClosure } from "../src/local-imports.mjs";

test("transitive literal ESM/CJS imports include re-exports and cycles, never comments or string lookalikes", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-import-closure-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "main.mjs"), `import fs from 'node:fs'; import './a.mjs';
// import './missing.mjs';
const example = "require('./missing.cjs')";
export * from './b.mjs'; await import('./c.cjs');`);
  writeFileSync(join(root, "a.mjs"), "import './main.mjs';");
  writeFileSync(join(root, "b.mjs"), "export const x = 1;");
  writeFileSync(join(root, "c.cjs"), "require('./data.json');");
  writeFileSync(join(root, "data.json"), "{}");
  const main = join(root, "main.mjs");
  assert.deepEqual(localImportClosure(main).map(file => basename(file)).sort(), ["a.mjs", "b.mjs", "c.cjs", "data.json", "main.mjs"]);
  assert.throws(() => localImportClosure(main, { maxFiles: 2 }), { code: "HandlerImportInvalid" });
  writeFileSync(main, "await import('./' + process.argv[2]);");
  assert.throws(() => localImportClosure(main), { code: "HandlerImportDynamic" });
  writeFileSync(main, "import './absent.mjs';");
  assert.throws(() => localImportClosure(main), { code: "HandlerImportMissing" });
});
