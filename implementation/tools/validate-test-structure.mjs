#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
let checks = 0;

main();

function main() {
  const packageJson = readJson("package.json");

  check("tests directory map", () => {
    for (const file of [
      "cli/touba-supply-chain/package.json",
      "cli/touba-supply-chain/src/validate.mjs",
      "cli/touba-supply-chain/test/validate.test.mjs",
      "tests/agent-decision-provider-v1/package.json",
      "cli/touba-run/test/parallel.test.mjs",
      "cli/touba-run/test/parallel-process.test.mjs",
      "runtime/touba-handler-sdk/test/parallel-engine.test.mjs",
      "cli/touba-distribution/src/check-parallel-install.mjs",
      "examples/providers/ollama-decision.provider.mjs",
      "tests/memory-backend-host/backend/memory_backend_server.mjs",
      "tests/memory-backend-host/docker/Dockerfile.memory-backend",
      "tests/memory-backend-host/docker/docker-compose.memory-backend.yml",
      "tests/memory-backend-host/validate-docker.mjs",
      "tests/memory-postgres-rb2/source/memory-postgres-rb2.tb",
      "tests/memory-postgres-rb2/source/memory-postgres-rb2-read-only.tb",
      "tests/memory-postgres-rb2/source/memory-postgres-rb2-approval-write.tb",
      "tests/memory-postgres-rb2/source/memory-postgres-rb2-trigger-write.tb",
      "tests/memory-postgres-rb2/source/memory-postgres-rb2-missing-skill-scope.tb",
      "tests/memory-postgres-rb2/handlers/write_customer_memory.handler.mjs",
      "tests/memory-postgres-rb2/handlers/read_customer_memory.handler.mjs",
      "tests/memory-postgres-rb2/handlers/read_customer_memory_pi.handler.mjs",
      "tests/memory-postgres-rb2/handlers/write_trigger_memory.handler.mjs",
      "tests/memory-postgres-rb2/providers/postgres-memory-openai.provider.mjs",
      "tests/memory-postgres-rb2/backend/package.json",
      "tests/memory-postgres-rb2/backend/package-lock.json",
      "tests/memory-postgres-rb2/backend/postgres_memory_api.mjs",
      "tests/memory-postgres-rb2/docker/Dockerfile.memory-api",
      "tests/memory-postgres-rb2/docker/docker-compose.memory-postgres.yml",
      "tests/memory-postgres-rb2/validate.mjs",
      "tests/skills-first-v1/validate.mjs",
      "tests/skills-v1/validate.mjs",
      "tools/release-readiness.mjs",
      "tools/release-readiness.test.mjs",
      "tools/validate-tree-sitter-corpus.mjs",
      "tools/validate-trigger-parser.mjs",
      "tools/write-trigger-trace-fixtures.mjs",
    ]) {
      assertPath(file);
    }
  });

  check("source fixture families", () => {
    for (const file of [
      "grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p01-fonctions-metier-pures.tb",
      "grammar/tree-sitter-touba/examples/scenarios-v1/positive/tb-scenario-v1-p05-validation-avant-effet-externe.tb",
      "grammar/tree-sitter-touba/examples/scenarios-v1/negative/semantic/tb-scenario-v1-n03-agent-caller-non-autorise.tb",
      "grammar/tree-sitter-touba/examples/tool-binding-v1/positive/tb-v1-tool-requires-network.tb",
      "grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb",
      "grammar/tree-sitter-touba/examples/agent-authority-anneau-2/positive/tb-a2-auth-p01-strategy-callable-by.tb",
      "grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p01-agent-read-memory.tb",
      "grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb",
      "grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb",
      "grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n01-runs-agent-rejected.tb",
      "tests/traces/triggers-anneau-2/trigger-schedule-accepted.trace.json",
      "tests/traces/triggers-anneau-2/trigger-schedule-refused-source-mismatch.trace.json",
      "tests/traces/triggers-anneau-2/trigger-schedule-rate-limited.trace.json",
    ]) {
      assertPath(file);
    }
  });

  check("validation scripts", () => {
    assert.equal(packageJson.bin?.touba, "./cli/touba-project/src/main.mjs");
    assert.equal(packageJson.dependencies?.["@touba/project"], "workspace:*");
    assertScript(packageJson, "validate:test-structure");
    assertScript(packageJson, "release:readiness");
    assertScript(packageJson, "test:release-readiness");
    assertScript(packageJson, "validate:v1-local");
    assertScript(packageJson, "validate:tool-binding-dx");
    assertScript(packageJson, "validate:js-sdk-project");
    assertScript(packageJson, "validate:js-sdk-engine-project");
    assertScript(packageJson, "validate:agent-decision-provider-v1");
    assertScript(packageJson, "validate:parallel-v1");
    assertScript(packageJson, "validate:agentdojo-benchmark");
    assertScript(packageJson, "validate:team-multi-equipe");
    assertScript(packageJson, "validate:memory-backend-host");
    assertScript(packageJson, "validate:memory-backend-host:docker");
    assertScript(packageJson, "validate:memory-postgres-rb2");
    assertScript(packageJson, "validate:memory-postgres-rb2:openai-live");
    assertScript(packageJson, "validate:tool-binding-live:dry-run");
    assertScript(packageJson, "validate:tool-binding-live");
    assertScript(packageJson, "validate:donnees-quebec-agent-provider");
    assertScript(packageJson, "validate:donnees-quebec-agent:dry-run");
    assertScript(packageJson, "validate:donnees-quebec-agent:live");
    assertScript(packageJson, "validate:triggers-source-air");
    assertScript(packageJson, "write:trigger-trace-fixtures");
    assertScript(packageJson, "check:trigger-trace-fixtures");
    for (const family of ["authority", "trigger", "cancel", "budget"]) {
      assertScriptContains(
        packageJson,
        `check:${family}-trace-fixtures`,
        `node tools/write-${family}-trace-fixtures.mjs --check`,
      );
    }
    assertScript(packageJson, "validate:triggers-runtime");
    assertScript(packageJson, "validate:triggers-cli");
    assertScript(packageJson, "validate:triggers");
    assertScript(packageJson, "test:audit");
    assertScript(packageJson, "validate:trace-audit-ta1");
    assertScript(packageJson, "test:supply-chain");
    assertScript(packageJson, "validate:supply-chain-sc1");
    assertScript(packageJson, "validate:skills-v1");
    assertScript(packageJson, "validate:skills-first-v1");
    assertCommandsInclude(packageJson, "validate:triggers", [
      "pnpm validate:triggers-source-air",
      "pnpm validate:triggers-runtime",
      "pnpm validate:triggers-cli",
      "pnpm test:lsp",
      "pnpm test:inspect",
    ]);
    assertCommandsExclude(packageJson, "validate:triggers", [
      "pnpm validate:tool-binding-live",
      "pnpm validate:donnees-quebec-agent:live",
    ]);
    assertScriptContains(packageJson, "validate:v1-local", "pnpm validate:test-structure");
    assertIncludes(
      "examples/providers/ollama-decision.provider.mjs",
      "createOllamaDecisionProvider",
    );
    assertCommandsInclude(packageJson, "validate:tool-binding-dx", [
      "pnpm validate:js-sdk-project",
      "pnpm validate:js-sdk-engine-project",
      "pnpm validate:agent-decision-provider-v1",
      "pnpm validate:tool-binding-live:dry-run",
      "pnpm validate:donnees-quebec-agent-provider",
      "pnpm validate:donnees-quebec-agent:dry-run",
    ]);
    assertCommandsInclude(packageJson, "validate:v1-local", [
      "pnpm validate:js-sdk-project",
      "pnpm validate:js-sdk-engine-project",
      "pnpm validate:agent-decision-provider-v1",
      "pnpm validate:agentdojo-benchmark",
      "pnpm validate:team-multi-equipe",
      "pnpm validate:memory-backend-host",
      "pnpm validate:skills-v1",
      "pnpm validate:donnees-quebec-agent-provider",
      "pnpm test:audit",
      "pnpm test:supply-chain",
      "pnpm check:authority-trace-fixtures",
      "pnpm check:trigger-trace-fixtures",
      "pnpm check:cancel-trace-fixtures",
      "pnpm check:budget-trace-fixtures",
    ]);
    assertCommandsExclude(packageJson, "validate:v1-local", [
      "pnpm validate:tool-binding-live",
      "pnpm validate:donnees-quebec-agent:live",
      "pnpm validate:memory-backend-host:docker",
      "pnpm validate:memory-postgres-rb2",
      "pnpm validate:memory-postgres-rb2:openai-live",
    ]);
  });

  check("JavaScript SDK project integration scenario", () => {
    assertPath("tests/js-sdk-project/package.json");
    assertPath("tests/js-sdk-project/source/js-sdk-project.tb");
    assertPath("tests/js-sdk-project/handlers/build_greeting.handler.mjs");
    assertPath("tests/js-sdk-project/validate.mjs");
    assertIncludes(
      "tests/js-sdk-project/source/js-sdk-project.tb",
      "requires network, secret_read",
    );
    assertIncludes(
      "tests/js-sdk-project/source/js-sdk-project.tb",
      "secrets DEMO_API_KEY",
    );
    assertIncludes(
      "tests/js-sdk-project/handlers/build_greeting.handler.mjs",
      'from "@touba/sdk"',
    );
    assertIncludes(
      "tests/js-sdk-project/validate.mjs",
      "node_modules/@touba/sdk",
    );
    assertIncludes(
      "tests/js-sdk-project/validate.mjs",
      "generateManifestFromAirDocument",
    );
    assertIncludes(
      "tests/js-sdk-project/validate.mjs",
      "assertNoSecretLeak",
    );
  });

  check("JavaScript SDK engine project integration scenario", () => {
    assertPath("tests/js-sdk-engine-project/package.json");
    assertPath("tests/js-sdk-engine-project/source/js-sdk-engine-project.tb");
    assertPath("tests/js-sdk-engine-project/handlers/build_greeting.handler.mjs");
    assertPath("tests/js-sdk-engine-project/validate.mjs");
    assertIncludes(
      "tests/js-sdk-engine-project/source/js-sdk-engine-project.tb",
      "requires network, secret_read",
    );
    assertIncludes(
      "tests/js-sdk-engine-project/source/js-sdk-engine-project.tb",
      "secrets DEMO_API_KEY",
    );
    assertIncludes(
      "tests/js-sdk-engine-project/handlers/build_greeting.handler.mjs",
      'from "@touba/sdk"',
    );
    assertIncludes(
      "tests/js-sdk-engine-project/validate.mjs",
      "new ToubaEngine",
    );
    assertIncludes(
      "tests/js-sdk-engine-project/validate.mjs",
      "assertNoSecretLeak",
    );
  });

  check("Agent autonomy V1 integration scenario", () => {
    assertPath("tests/agent-autonomy-v1/package.json");
    assertPath("tests/agent-autonomy-v1/source/agent-autonomy-v1.tb");
    assertPath("tests/agent-autonomy-v1/validate.mjs");
    assertIncludes(
      "tests/agent-autonomy-v1/source/agent-autonomy-v1.tb",
      "agent Researcher",
    );
    assertIncludes(
      "tests/agent-autonomy-v1/source/agent-autonomy-v1.tb",
      "uses UseMemorySearch",
    );
    assertIncludes(
      "tests/agent-autonomy-v1/validate.mjs",
      "--agent-decisions-json",
    );
    assertIncludes(
      "tests/agent-autonomy-v1/validate.mjs",
      "AgentCapabilityNotAllowed",
    );
  });

  check("Agent decision provider V1 integration scenario", () => {
    assertPath("tests/agent-decision-provider-v1/package.json");
    assertPath("tests/agent-decision-provider-v1/source/agent-decision-provider-v1.tb");
    assertPath("tests/agent-decision-provider-v1/providers/catalog-first.provider.mjs");
    assertPath("tests/agent-decision-provider-v1/providers/refused.provider.mjs");
    assertPath("tests/agent-decision-provider-v1/providers/invalid-arguments.provider.mjs");
    assertPath("tests/agent-decision-provider-v1/validate.mjs");
    assertIncludes(
      "tests/agent-decision-provider-v1/source/agent-decision-provider-v1.tb",
      "agent DonneesQuebecResearcher",
    );
    assertIncludes(
      "tests/agent-decision-provider-v1/providers/catalog-first.provider.mjs",
      "request_capabilities",
    );
    assertIncludes(
      "tests/agent-decision-provider-v1/validate.mjs",
      "--agent-decision-provider",
    );
    assertIncludes(
      "tests/agent-decision-provider-v1/validate.mjs",
      "AgentCapabilityArgumentsInvalid",
    );
  });

  check("AgentDojo initial benchmark adapter", () => {
    assertPath("tests/agentdojo-benchmark/mapping.json");
    assertPath("tests/agentdojo-benchmark/source/agentdojo-benchmark.tb");
    assertPath("tests/agentdojo-benchmark/validate.mjs");
    assertIncludes(
      "tests/agentdojo-benchmark/mapping.json",
      "ADJ-TB-N01-email-hidden-capability",
    );
    assertIncludes(
      "tests/agentdojo-benchmark/source/agentdojo-benchmark.tb",
      "EXTERNAL_INJECTION_SELECT_HIDDEN_CAPABILITY",
    );
    assertIncludes(
      "tests/agentdojo-benchmark/validate.mjs",
      "agentDecisionProviderContentMode: \"opaque_refs\"",
    );
    assertIncludes(
      "tests/agentdojo-benchmark/validate.mjs",
      "AgentCapabilityNotAllowed",
    );
  });

  check("Trace audit TA-1 validation scenario", () => {
    assertPath("cli/touba-audit/package.json");
    assertPath("cli/touba-audit/src/audit.mjs");
    assertPath("cli/touba-audit/test/audit.test.mjs");
    assertIncludes(
      "cli/touba-audit/src/audit.mjs",
      "trace-audit-export-v1-local",
    );
    assertIncludes(
      "cli/touba-audit/src/audit.mjs",
      "TraceAuditSecretLeakDetected",
    );
    assertIncludes(
      "cli/touba-audit/test/audit.test.mjs",
      "TraceAuditDigestMismatch",
    );
    assertIncludes(
      "cli/touba-audit/test/audit.test.mjs",
      "TraceAuditUserInputLeakDetected",
    );
  });

  check("Supply chain SC-1 validation scenario", () => {
    assertPath("cli/touba-supply-chain/package.json");
    assertPath("cli/touba-supply-chain/src/validate.mjs");
    assertPath("cli/touba-supply-chain/test/validate.test.mjs");
    assertIncludes(
      "cli/touba-supply-chain/src/validate.mjs",
      "touba-supply-chain-validation-v1",
    );
    assertIncludes(
      "cli/touba-supply-chain/src/validate.mjs",
      "SupplyChainSecretLeakDetected",
    );
    assertIncludes(
      "cli/touba-supply-chain/test/validate.test.mjs",
      "reports missing handler",
    );
    assertIncludes(
      "cli/touba-supply-chain/test/validate.test.mjs",
      "reports changed handler digest",
    );
    assertIncludes(
      "cli/touba-supply-chain/test/validate.test.mjs",
      "reports unknown SDK metadata as warning",
    );
  });

  check("Donnees Quebec tool scenario", () => {
    assertPath("tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-live.tb");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/handlers/search_datasets.handler.mjs");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/validate.mjs");
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-live.tb",
      "requires network",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-live.tb",
      "show",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/handlers/search_datasets.handler.mjs",
      "defineTool",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate.mjs",
      "generateManifestFromAirDocument",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate.mjs",
      "handlerCwd: fixtureRoot",
    );
  });

  check("Donnees Quebec agent scenario", () => {
    assertPath("tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/handlers/search_agent_datasets.handler.mjs");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/handlers/summarize_datasets.handler.mjs");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/providers/donnees-quebec-researcher.provider.mjs");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/secrets/secret-handles.env.fixture.json");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/secrets/secret-handles.store.fixture.json");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/secrets/secret-handles.dotenv.fixture.json");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/validate-agent-provider.mjs");
    assertPath("tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs");
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
      "callable_by strategy RunDatasetResearch",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/source/donnees-quebec-agent-live.tb",
      "secrets OPENAI_API_KEY",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs",
      "agent_secret_scopes",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs",
      "--agent-decision-provider",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs",
      "missingEnvSecretsFor",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent-provider.mjs",
      "provider=ai-sdk",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent-provider.mjs",
      "generateObject",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent-provider.mjs",
      "request_human_review",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs",
      "observation_count",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/providers/donnees-quebec-researcher.provider.mjs",
      "openai_structured_output",
    );
    assertIncludes(
      "tests/tool-binding-v1/live-donnees-quebec/providers/donnees-quebec-researcher.provider.mjs",
      "createOpenAiDecisionProvider",
    );
  });

  check("Team multi-equipe scenario", () => {
    assertPath("tests/team-multi-equipe/project/src/examples/customer_review_app.tb");
    assertPath("tests/team-multi-equipe/project/packages/customer/touba.package.json");
    assertPath("tests/team-multi-equipe/project/touba.ownership.json");
    assertPath("tests/team-multi-equipe/project/touba.resources.json");
    assertPath("tests/team-multi-equipe/handlers/fetch_customer_profile.handler.mjs");
    assertPath("tests/team-multi-equipe/handlers/fetch_customer_profile_leaky_error.handler.mjs");
    assertPath("tests/team-multi-equipe/negative/touba.ownership.missing-review.json");
    assertPath("tests/team-multi-equipe/negative/touba.ownership.missing-run-plan-owner.json");
    assertPath("tests/team-multi-equipe/negative/touba.ownership.unknown-reviewer.json");
    assertPath("tests/team-multi-equipe/negative/touba.ownership.rejected-review.json");
    assertPath("tests/team-multi-equipe/negative/touba.ownership.authority-field.json");
    assertPath("tests/team-multi-equipe/negative/touba.resources.missing-grant.json");
    assertPath("tests/team-multi-equipe/validate.mjs");
    assertIncludes(
      "tests/team-multi-equipe/project/src/examples/customer_review_app.tb",
      "import tool FetchCustomerProfile from org.example.customer",
    );
    assertIncludes(
      "tests/team-multi-equipe/project/touba.ownership.json",
      "review_gates",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "ReviewGateMissing",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "OwnershipMissing",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "ReviewReviewerUnknown",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "ReviewRejected",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "OwnershipAuthorityFieldForbidden",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "ResourceBindingGrantMissing",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "RunPlanSupplyChainDrift|HandlerChanged",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "HandlerLockEntryMissing",
    );
    assertIncludes(
      "tests/team-multi-equipe/validate.mjs",
      "assertHandlerSecretRedaction",
    );
  });

  process.stdout.write(`test-structure: status=success checked=${checks}\n`);
}

function check(label, assertion) {
  try {
    assertion();
    checks += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`test-structure: status=failure step=${label}\n${message}\n`);
    process.exit(1);
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolvePath(relativePath), "utf8"));
}

function assertPath(relativePath) {
  assert.equal(existsSync(resolvePath(relativePath)), true, `missing ${relativePath}`);
}

function assertIncludes(relativePath, expected) {
  const content = readFileSync(resolvePath(relativePath), "utf8");
  assert.equal(
    content.includes(expected),
    true,
    `${relativePath} must include ${JSON.stringify(expected)}`,
  );
}

function assertScript(packageJson, scriptName) {
  assert.equal(
    typeof packageJson.scripts?.[scriptName],
    "string",
    `package.json scripts.${scriptName} is missing`,
  );
}

function assertScriptContains(packageJson, scriptName, fragment) {
  assertScript(packageJson, scriptName);
  assert.equal(
    packageJson.scripts[scriptName].includes(fragment),
    true,
    `scripts.${scriptName} must include ${fragment}`,
  );
}

function assertCommandsInclude(packageJson, scriptName, expectedCommands) {
  const commands = commandsOf(packageJson, scriptName);
  for (const command of expectedCommands) {
    assert.equal(
      commands.includes(command),
      true,
      `scripts.${scriptName} must include command ${command}`,
    );
  }
}

function assertCommandsExclude(packageJson, scriptName, rejectedCommands) {
  const commands = commandsOf(packageJson, scriptName);
  for (const command of rejectedCommands) {
    assert.equal(
      commands.includes(command),
      false,
      `scripts.${scriptName} must not include live opt-in command ${command}`,
    );
  }
}

function commandsOf(packageJson, scriptName) {
  assertScript(packageJson, scriptName);
  return packageJson.scripts[scriptName]
    .split("&&")
    .map((command) => command.trim())
    .filter(Boolean);
}

function resolvePath(relativePath) {
  return resolve(implementationRoot, relativePath);
}
