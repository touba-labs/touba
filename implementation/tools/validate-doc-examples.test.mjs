import assert from "node:assert/strict";
import test from "node:test";

import {
  extractToubaExamples,
  validateExampleMetadata,
  validatePublishedProofCounts,
  validateRepositoryReferences,
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

test("checks public proof counts against the machine source", () => {
  const documents = new Map([
    ["touba/README.md", "36 cases and 24 structural cases"],
    ["pap/README.md", "36 cases and 24 structural cases"],
  ]);
  const status = { benchmarks: { live_model_cases: 36, structural_cases: 24 } };
  assert.deepEqual(validatePublishedProofCounts(documents, status), []);
  documents.set("pap/README.md", "35 cases and 24 structural cases");
  assert.match(validatePublishedProofCounts(documents, status)[0], /live-model case count/);
});

test("rejects missing repository references in PAP documents", () => {
  const diagnostics = validateRepositoryReferences(
    "See `pap/pap-projet/source-absente.md`.",
    "pap/inventaire-fonctionnel.md",
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /broken repository reference/);
});
