import assert from "node:assert/strict";
import test from "node:test";

import {
  extractToubaExamples,
  exampleModuleDependencies,
  validateExampleMetadata,
} from "./validate-doc-examples.mjs";

test("extracts displayed Touba blocks with explicit compile and fragment status", () => {
  const content = `
<!-- touba-example: compile -->
\`\`\`touba
module examples.valid
\`\`\`

<!-- touba-example: fragment -->
\`\`\`touba
uses Search
\`\`\`
`;
  const examples = extractToubaExamples(content, "docs/example.md");
  assert.deepEqual(examples.map((example) => example.marker), ["compile", "fragment"]);
  assert.equal(examples[0].source, "module examples.valid\n");
});

test("rejects unmarked blocks and the former responsibility drift", () => {
  const [unmarked] = extractToubaExamples("```touba\nmodule examples.unmarked\n```\n", "README.md");
  assert.match(validateExampleMetadata(unmarked)[0], /must be marked/);

  const [drift] = extractToubaExamples(`
<!-- touba-example: compile -->
\`\`\`touba
module examples.drift
agent Researcher
    description "Selects one capability."
\`\`\`
`, "README.md");
  assert.match(validateExampleMetadata(drift)[0], /exactly one responsibility/);
});

test("accepts an explicitly marked fragment without pretending it compiles", () => {
  const [fragment] = extractToubaExamples(`
<!-- touba-example: fragment -->
\`\`\`touba
responsibility "Review the change."
\`\`\`
`, "docs/fragment.md");
  assert.deepEqual(validateExampleMetadata(fragment), []);
});

 test("published module resolution is transitive, local to the document and never fabricated", () => {
  const block = (source, docPath = "recipe.md") => ({ source, docPath, marker: "compile" });
  const entry = block("module app\nimport function F from helpers\n");
  const helper = block("module helpers\nimport type T from types\n");
  const type = block("module types\ntype T\n    value is Text\n");
  assert.deepEqual(exampleModuleDependencies(entry, [entry, helper, type]), [helper, type]);
  assert.deepEqual(exampleModuleDependencies(entry, [entry, { ...helper, docPath: "other.md" }]), []);
  assert.throws(() => exampleModuleDependencies(entry, [entry, helper, block("module helpers\n")]), /ambiguous/);
});
