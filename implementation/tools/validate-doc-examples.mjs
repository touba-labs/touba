#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const toubaRoot = resolve(implementationRoot, "..");
const repoRoot = resolve(toubaRoot, "..");

const examples = [
  {
    id: "docs-concept-pap",
    doc: "touba/docs/concepts/paradigme-pap.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-concept-components",
    doc: "touba/docs/concepts/composants-touba.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
    compile: true,
  },
  {
    id: "docs-concept-function-pure",
    doc: "touba/docs/concepts/function.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p01-fonctions-metier-pures.tb",
    compile: true,
  },
  {
    id: "docs-concept-skill",
    doc: "touba/docs/concepts/skill.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-concept-agent",
    doc: "touba/docs/concepts/agent.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-concept-strategy",
    doc: "touba/docs/concepts/strategy.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-concept-tool",
    doc: "touba/docs/concepts/tool.md",
    fixture: "touba/implementation/tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
    compile: true,
  },
  {
    id: "docs-concept-handler",
    doc: "touba/docs/concepts/handler.md",
    fixture: "touba/implementation/tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
    compile: false,
  },
  {
    id: "docs-concept-manifest",
    doc: "touba/docs/concepts/manifest.md",
    fixture: "touba/implementation/tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
    compile: false,
  },
  {
    id: "docs-concept-autonomie",
    doc: "touba/docs/concepts/autonomie-bornee.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p04-memoire-scopee-agent.tb",
    compile: true,
  },
  {
    id: "docs-concept-validation-humaine",
    doc: "touba/docs/concepts/validation-humaine.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p02-agent-review-branch.tb",
    compile: true,
  },
  {
    id: "docs-concept-air-runtime-traces",
    doc: "touba/docs/concepts/air-runtime-traces.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-concept-memoire",
    doc: "touba/docs/concepts/memoire.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p04-memoire-scopee-agent.tb",
    compile: true,
  },
  {
    id: "docs-concept-trigger",
    doc: "touba/docs/concepts/trigger.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb",
    compile: true,
  },
  {
    id: "docs-first-program-show-ask",
    doc: "touba/docs/demarrer/premier-programme.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
    compile: true,
  },
  {
    id: "docs-guide-show-ask-reference",
    doc: "touba/docs/guides/show-ask.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
    compile: false,
  },
  {
    id: "docs-guide-project-prepare",
    doc: "touba/docs/guides/projet-touba-prepare.md",
    fixture: "touba/implementation/examples/v1-developer-project/src/program.tb",
    compile: true,
  },
  {
    id: "docs-guide-triggers",
    doc: "touba/docs/guides/triggers-gouvernes.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb",
    compile: true,
  },
  {
    id: "docs-guide-separation-di1",
    doc: "touba/docs/guides/separation-donnees-instructions.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p03-di-explicit-instruction-boundary.tb",
    compile: true,
  },
  {
    id: "docs-tool-binding-process",
    doc: "touba/docs/guides/tool-binding-handler-manifest.md",
    fixture: "touba/implementation/tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
    compile: true,
  },
  {
    id: "docs-donnees-quebec-live",
    doc: "touba/docs/tutoriels/donnees-quebec.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-live.tb",
    compile: true,
  },
  {
    id: "docs-donnees-quebec-agent-live",
    doc: "touba/docs/tutoriels/donnees-quebec.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-complete-vscode-javascript-project",
    doc: "touba/docs/tutoriels/projet-complet-vscode-javascript.md",
    fixture: "touba/implementation/tests/js-sdk-engine-project/source/js-sdk-engine-project.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-pure-functions",
    doc: "touba/docs/tutoriels/fonctions-metier-pures.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p01-fonctions-metier-pures.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-bind-define",
    doc: "touba/docs/tutoriels/valeurs-immuables-bind-define.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-change-review-agents",
    doc: "touba/docs/tutoriels/agent-strategy-revue-changement.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-governed-agent-decision",
    doc: "touba/docs/tutoriels/decision-agentique-gouvernee.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-human-interaction",
    doc: "touba/docs/tutoriels/interaction-humaine-validation.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p03-interaction-humaine-validation.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-memory-scope",
    doc: "touba/docs/tutoriels/memoire-scopee-agent.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p04-memoire-scopee-agent.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-memory-postgres-rb2",
    doc: "touba/docs/tutoriels/memoire-postgres-agent-scopes-rb2.md",
    fixture: "touba/implementation/tests/memory-postgres-rb2/source/memory-postgres-rb2.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-trigger-runner",
    doc: "touba/docs/tutoriels/trigger-revue-matinale.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p04-runner-revue-matinale.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-budgets-bq1",
    doc: "touba/docs/tutoriels/budgets-autonomie-bq1.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-cancel-kill-switch",
    doc: "touba/docs/tutoriels/cancel-kill-switch.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-trace-audit-ta1",
    doc: "touba/docs/tutoriels/audit-traces-ta1.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-supply-chain-sc1",
    doc: "touba/docs/tutoriels/supply-chain-handlers-sc1.md",
    fixture: "touba/implementation/tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-imports-im1",
    doc: "touba/docs/tutoriels/imports-multi-modules-im1.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/imports-im1/positive/tb-im1-p09-imports-air-only.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-separation-di1",
    doc: "touba/docs/tutoriels/separation-donnees-instructions-di1.md",
    fixture: "touba/implementation/grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p03-di-explicit-instruction-boundary.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-tool-sdk",
    doc: "touba/docs/tutoriels/tool-api-publique-sdk-touba.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-live.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-sdk-engine-provider-js",
    doc: "touba/docs/tutoriels/sdk-engine-provider-js.md",
    fixture: "touba/implementation/tests/js-sdk-engine-project/source/js-sdk-engine-project.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-secret-agent",
    doc: "touba/docs/tutoriels/secrets-agent-dedie.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
    compile: true,
  },
  {
    id: "docs-tutorial-governance-integrator",
    doc: "touba/docs/tutoriels/scenario-integrateur-gouvernance-v1.md",
    fixture: "touba/implementation/tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
    compile: true,
  },
  {
    id: "docs-v1-developer-project",
    doc: "touba/docs/demarrer/installation.md",
    fixture: "touba/implementation/examples/v1-developer-project/src/program.tb",
    compile: true,
  },
];

const cargo = process.env.CARGO ?? "cargo";
let compiled = 0;

for (const example of examples) {
  assertExists(resolve(repoRoot, example.doc), `${example.id} doc`);
  const fixturePath = resolve(repoRoot, example.fixture);
  assertExists(fixturePath, `${example.id} fixture`);

  if (example.compile) {
    compileFixture(example.id, fixturePath);
    compiled += 1;
  }
}

process.stdout.write(`docs-examples: status=success checked=${examples.length} compiled=${compiled}\n`);

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} missing: ${path}`);
  }
}

function compileFixture(id, fixturePath) {
  const result = spawnSync(
    cargo,
    [
      "run",
      "-p",
      "touba-cli",
      "--bin",
      "touba-compile",
      "--quiet",
      "--",
      fixturePath,
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `compile failed for ${id}: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }

  try {
    const air = JSON.parse(result.stdout);
    if (air.air_schema_version !== "air-minimal-v0.1") {
      throw new Error("unexpected AIR schema version");
    }
  } catch (error) {
    throw new Error(`compile output invalid for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
