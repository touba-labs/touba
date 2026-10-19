import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [page, expected] of [["guides/couts-fournisseurs", "10000000"], ["tutoriels/budget-financier", "BUDGET_OK"]]) {
  test(`${page}: execute the published JavaScript ledger example`, t => {
    const content = readFileSync(new URL(`../../../../docs/${page}.md`, import.meta.url), "utf8");
    const code = content.match(/```javascript\n([\s\S]*?)```/)[1];
    const cwd = mkdtempSync(join(tmpdir(), "touba-cost-doc-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const source = code.replaceAll('"@touba/sdk/budget/sqlite"', JSON.stringify(new URL("../src/sqlite-provider-budget.mjs", import.meta.url).href));
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd, encoding: "utf8", timeout: 10000 });
    assert.equal(output.trim(), expected);
  });
}
