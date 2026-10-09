import assert from "node:assert/strict";
import test from "node:test";

import {
  extractToubaExamples,
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
