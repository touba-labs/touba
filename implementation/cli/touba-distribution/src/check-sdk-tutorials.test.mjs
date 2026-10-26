import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { engineTutorialFiles } from "./check-sdk-tutorials.mjs";

test("SDK recipe selects source files, not Terminal command blocks", () => {
  const document = '```sh title="Terminal"\ntouba sdk install javascript\n```\n'
    + '```sh title="not-a-program.mjs"\necho hello\n```\n'
    + '```touba title="program.tb"\nmodule test\n```\n'
    + '```js title="run.mjs"\nconsole.log("hello")\n```\n'
    + '```python title="run.py"\nprint("hello")\n```\n';
  assert.deepEqual(engineTutorialFiles(document, "javascript").map(file => file.title), ["program.tb", "run.mjs"]);
  assert.deepEqual(engineTutorialFiles(document, "python").map(file => file.title), ["program.tb", "run.py"]);
  assert.throws(() => engineTutorialFiles(document, "shell"), /unknown tutorial SDK/);
});

test("actual engine tutorials keep nominal and refusal programs in installed recipes", () => {
  for (const sdk of ["javascript", "python"]) {
    const document = readFileSync(new URL(`../../../../docs/tutoriels/engine-${sdk}.md`, import.meta.url), "utf8");
    const files = engineTutorialFiles(document, sdk);
    assert.ok(files.some(file => file.title.endsWith(".tb")));
    assert.ok(files.some(file => file.title === (sdk === "python" ? "run.py" : "run.mjs")));
    assert.ok(files.some(file => file.title.startsWith("refused.")));
    assert.ok(files.every(file => file.title !== "Terminal"));
  }
});
