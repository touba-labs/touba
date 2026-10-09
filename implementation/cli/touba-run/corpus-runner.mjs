import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAirFromJson, executeAirDocument } from "@touba/runtime";

const __dir = dirname(fileURLToPath(import.meta.url));
export const implementationDir = join(__dir, "../..");
const cargoManifest = join(implementationDir, "Cargo.toml");
const fixturesDir = join(implementationDir, "grammar/tree-sitter-touba/examples");
const anneau1FixturesDir = join(fixturesDir, "anneau-1");
const expressionsFixturesDir = join(fixturesDir, "expressions-v1");
const bindDefineFixturesDir = join(fixturesDir, "bind-define-v1");
const normalizedImplementationPrefix = `${implementationDir.replaceAll("\\", "/")}/`;

// Set CARGO=/path/to/cargo if cargo is not in PATH.
const CARGO = process.env.CARGO ?? "cargo";

// FetchPrimarySource is absent: the runtime emits RuntimeFailure("missing tool binding")
// which triggers the on-failure fallback path. BuildFallbackSource ends with stop,
// so fixture 002 exits with status "stopped".
const CORPUS_STUBS = {
  "tool:examples.linear_skill/FetchSource": () => ({ content: "[corpus-stub] source text" }),
  "tool:examples.strategy_agents/ApplyChange": () => ({ summary: "[corpus-stub] change applied" }),
};

export const FIXTURES = [
  {
    id: "tb-v01-001-linear-skill",
    file: "tb-v01-001-linear-skill.tb",
    inputs: { request: { topic: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-v01-002-fallback",
    file: "tb-v01-002-fallback.tb",
    inputs: { request: { topic: "source" } },
    expectStatus: "stopped",
  },
  { id: "tb-v01-003-branch", file: "tb-v01-003-branch.tb", inputs: { accepted: true }, expectStatus: "success" },
  { id: "tb-v01-004-loop", file: "tb-v01-004-loop.tb", inputs: { items: ["item-1", "item-2"] }, expectStatus: "success" },
  {
    id: "tb-v01-005-strategy-agents",
    file: "tb-v01-005-strategy-agents.tb",
    // Legacy untyped agents do not implicitly pass one agent's output to another.
    inputs: { request: { summary: "change" }, change: { summary: "review input" } },
    expectStatus: "success",
  },
];

export const ANNEAU1_POSITIVE_FIXTURES = [
  {
    id: "tb-a1-p01-tool-with-argument",
    file: "positive/tb-a1-p01-tool-with-argument.tb",
    inputs: { request: { query: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p02-tool-result-binding",
    file: "positive/tb-a1-p02-tool-result-binding.tb",
    inputs: { request: { query: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p03-skill-composition-binding",
    file: "positive/tb-a1-p03-skill-composition-binding.tb",
    inputs: { request: { query: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p04-branch-on-bound-value",
    file: "positive/tb-a1-p04-branch-on-bound-value.tb",
    inputs: { request: { query: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p05-loop-explicit-item-call",
    file: "positive/tb-a1-p05-loop-explicit-item-call.tb",
    inputs: { requests: [{ query: "one" }, { query: "two" }] },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p06-fallback-resolved-with-binding",
    file: "positive/tb-a1-p06-fallback-resolved-with-binding.tb",
    inputs: { request: { query: "source" } },
    expectStatus: "success",
  },
  {
    id: "tb-a1-p07-simple-agent-calls-no-enriched-dispatch",
    file: "positive/tb-a1-p07-simple-agent-calls-no-enriched-dispatch.tb",
    inputs: { request: { summary: "change" }, change: { summary: "review input" } },
    expectStatus: "success",
  },
];

export const ANNEAU1_NEGATIVE_FIXTURES = [
  {
    id: "tb-a1-n01-implicit-result-consumed-by-if",
    file: "negative/semantic/tb-a1-n01-implicit-result-consumed-by-if.tb",
    expectedDiagnostic: "InvalidBranchCondition",
  },
  {
    id: "tb-a1-n02-missing-explicit-argument",
    file: "negative/semantic/tb-a1-n02-missing-explicit-argument.tb",
    expectedDiagnostic: "MissingExplicitCallArgument",
  },
  {
    id: "tb-a1-n03-unknown-argument",
    file: "negative/semantic/tb-a1-n03-unknown-argument.tb",
    expectedDiagnostic: "UnknownCallArgument",
  },
  {
    id: "tb-a1-n04-duplicate-argument",
    file: "negative/semantic/tb-a1-n04-duplicate-argument.tb",
    expectedDiagnostic: "DuplicateCallArgument",
  },
  {
    id: "tb-a1-n05-duplicate-result-binding",
    file: "negative/semantic/tb-a1-n05-duplicate-result-binding.tb",
    expectedDiagnostic: "DuplicateResultBinding",
  },
  {
    id: "tb-a1-n06-use-before-binding",
    file: "negative/semantic/tb-a1-n06-use-before-binding.tb",
    expectedDiagnostic: "InvalidGiveValue",
  },
  {
    id: "tb-a1-n07-enriched-agent-call-blocked",
    file: "negative/semantic/tb-a1-n07-enriched-agent-call-blocked.tb",
    expectedDiagnostic: "EnrichedAgentCallBlocked",
  },
  {
    id: "tb-a1-n08-fallback-target-absent",
    file: "negative/semantic/tb-a1-n08-fallback-target-absent.tb",
    expectedDiagnostic: "UnknownReference",
  },
];

export const EXPR1_POSITIVE_FIXTURES = [
  {
    id: "tb-expr1-p01-int-arithmetic",
    file: "positive/tb-expr1-p01-int-arithmetic.tb",
    inputs: { count: 3, bonus: 2 },
    expectStatus: "success",
    expectResult: 7,
  },
  {
    id: "tb-expr1-p02-float-average",
    file: "positive/tb-expr1-p02-float-average.tb",
    inputs: { score: 0.8, bonus: 1.0 },
    expectStatus: "success",
    expectResult: 0.9,
  },
  {
    id: "tb-expr1-p03-boolean-comparison",
    file: "positive/tb-expr1-p03-boolean-comparison.tb",
    inputs: { accepted: false, score: 0.4, threshold: 0.5 },
    expectStatus: "success",
    expectResult: true,
  },
  {
    id: "tb-expr1-p04-text-concat",
    file: "positive/tb-expr1-p04-text-concat.tb",
    inputs: { prefix: "Dr. ", title: "Touba" },
    expectStatus: "success",
    expectResult: "Dr. Touba",
  },
  {
    id: "tb-expr1-p05-field-access",
    file: "positive/tb-expr1-p05-field-access.tb",
    inputs: { analysis: { score: 0.75, accepted: true } },
    expectStatus: "success",
    expectResult: 0.75,
  },
  {
    id: "tb-expr1-p06-call-argument-expression",
    file: "positive/tb-expr1-p06-call-argument-expression.tb",
    inputs: { analysis: { score: 0.7 }, bonus: 0.2 },
    expectStatus: "success",
    expectResult: { approved: true },
  },
  {
    id: "tb-expr1-p07-conditional-field-score",
    file: "positive/tb-expr1-p07-conditional-field-score.tb",
    inputs: { analysis: { score: 0.9, accepted: true }, threshold: 0.8 },
    expectStatus: "success",
    expectResult: { score: 0.9, accepted: true },
  },
  {
    id: "tb-expr1-p08-text-rendering",
    file: "positive/tb-expr1-p08-text-rendering.tb",
    inputs: { age: 42, score: 0.875, active: true },
    expectStatus: "success",
    expectResult: "age=42, next=43, score=0.875, active=true",
  },
];

export const EXPR1_NEGATIVE_FIXTURES = [
  {
    id: "tb-expr1-n01-text-plus",
    file: "negative/semantic/tb-expr1-n01-text-plus.tb",
    expectedDiagnostic: "InvalidExpressionOperandType",
  },
  {
    id: "tb-expr1-n02-unknown-field",
    file: "negative/semantic/tb-expr1-n02-unknown-field.tb",
    expectedDiagnostic: "UnknownExpressionField",
  },
  {
    id: "tb-expr1-n03-static-division-zero",
    file: "negative/semantic/tb-expr1-n03-static-division-zero.tb",
    expectedDiagnostic: "StaticExpressionDivisionByZero",
  },
  {
    id: "tb-expr1-n04-invalid-modulo-float",
    file: "negative/semantic/tb-expr1-n04-invalid-modulo-float.tb",
    expectedDiagnostic: "InvalidExpressionOperandType",
  },
  {
    id: "tb-expr1-n05-text-order-comparison",
    file: "negative/semantic/tb-expr1-n05-text-order-comparison.tb",
    expectedDiagnostic: "InvalidExpressionOperandType",
  },
  {
    id: "tb-expr1-n06-implicit-text-conversion",
    file: "negative/semantic/tb-expr1-n06-implicit-text-conversion.tb",
    expectedDiagnostic: "InvalidExpressionOperandType",
  },
  {
    id: "tb-expr1-n07-host-method",
    file: "negative/syntax/tb-expr1-n07-host-method.tb",
    expectedDiagnostic: "AstError",
  },
  {
    id: "tb-expr1-n08-host-eval",
    file: "negative/syntax/tb-expr1-n08-host-eval.tb",
    expectedDiagnostic: "AstError",
  },
  {
    id: "tb-expr1-n09-text-render-local-type",
    file: "negative/semantic/tb-expr1-n09-text-render-local-type.tb",
    expectedDiagnostic: "InvalidExpressionOperandType",
  },
];

export const BIND_DEFINE_POSITIVE_FIXTURES = [
  {
    id: "tb-binddefine-v1-p01-local-bind-function",
    file: "positive/tb-binddefine-v1-p01-local-bind-function.tb",
    inputs: { score: 1.0, bonus: 0.8 },
    expectStatus: "success",
    expectResult: "accepted",
    expectBindings: ["adjusted", "accepted"],
  },
  {
    id: "tb-binddefine-v1-p02-module-define-skill",
    file: "positive/tb-binddefine-v1-p02-module-define-skill.tb",
    compileOnly: true,
    expectConstants: ["DefaultTopic", "ScoreLimit"],
  },
];

export const BIND_DEFINE_NEGATIVE_FIXTURES = [
  {
    id: "tb-binddefine-v1-n01-duplicate-local-bind",
    file: "negative/semantic/tb-binddefine-v1-n01-duplicate-local-bind.tb",
    expectedDiagnostic: "DuplicateLocalBinding",
  },
  {
    id: "tb-binddefine-v1-n02-define-non-literal",
    file: "negative/semantic/tb-binddefine-v1-n02-define-non-literal.tb",
    expectedDiagnostic: "UnsupportedModuleConstantExpression",
  },
  {
    id: "tb-binddefine-v1-n03-bind-type-mismatch",
    file: "negative/semantic/tb-binddefine-v1-n03-bind-type-mismatch.tb",
    expectedDiagnostic: "IncompatibleExpressionType",
  },
];

export class CorpusFixtureError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = "CorpusFixtureError";
    this.stage = stage;
  }
}

export async function executeCorpusFixture(fixture) {
  const sourcePath = join(fixturesDir, fixture.file);
  return executeFixtureAtPath(sourcePath, fixture, CORPUS_STUBS);
}

export async function executeAnneau1Fixture(fixture) {
  const sourcePath = join(anneau1FixturesDir, fixture.file);
  const handlers = anneau1HandlersForFixture(fixture);
  return executeFixtureAtPath(sourcePath, fixture, handlers);
}

export async function executeExpressionFixture(fixture) {
  const sourcePath = join(expressionsFixturesDir, fixture.file);
  const handlers = expressionHandlersForFixture(fixture);
  return executeFixtureAtPath(sourcePath, fixture, handlers);
}

export async function executeBindDefineFixture(fixture) {
  const sourcePath = join(bindDefineFixturesDir, fixture.file);
  return executeFixtureAtPath(sourcePath, fixture, {});
}

export function compileBindDefinePositiveFixture(fixture) {
  return compileFixtureWithAirAtPath(join(bindDefineFixturesDir, fixture.file));
}

export function compileAnneau1NegativeFixture(fixture) {
  return compileFixtureAtPath(join(anneau1FixturesDir, fixture.file));
}

export function compileExpressionNegativeFixture(fixture) {
  return compileFixtureAtPath(join(expressionsFixturesDir, fixture.file));
}

export function compileBindDefineNegativeFixture(fixture) {
  return compileFixtureAtPath(join(bindDefineFixturesDir, fixture.file));
}

function compileFixtureWithAirAtPath(sourcePath) {
  try {
    const stdout = execFileSync(
      CARGO,
      [
        "run",
        "--manifest-path",
        cargoManifest,
        "-p",
        "touba-cli",
        "--bin",
        "touba-compile",
        "--quiet",
        "--",
        sourcePath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      ok: true,
      stdout,
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? e.message,
    };
  }
}

function compileFixtureAtPath(sourcePath) {
  try {
    execFileSync(
      CARGO,
      [
        "run",
        "--manifest-path",
        cargoManifest,
        "-p",
        "touba-cli",
        "--bin",
        "touba-compile",
        "--quiet",
        "--",
        sourcePath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    return {
      ok: false,
      stderr: e.stderr?.trim() ?? e.message,
    };
  }

  return {
    ok: true,
    stderr: "",
  };
}

async function executeFixtureAtPath(sourcePath, fixture, toolHandlers) {
  let airJson;
  try {
    airJson = execFileSync(
      CARGO,
      [
        "run",
        "--manifest-path",
        cargoManifest,
        "-p",
        "touba-cli",
        "--bin",
        "touba-compile",
        "--quiet",
        "--",
        sourcePath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    throw new CorpusFixtureError("compile", e.stderr?.trim() ?? e.message);
  }

  let document;
  try {
    document = loadAirFromJson(airJson);
  } catch (e) {
    throw new CorpusFixtureError("load AIR JSON", e.message);
  }

  try {
    const result = await executeAirDocument(document, {
      toolHandlers,
      inputs: fixture.inputs,
    });
    const normalizedDocument = normalizeFixtureArtifact(document);
    const normalizedResult = normalizeFixtureArtifact(result);
    return {
      sourcePath,
      airJson: `${JSON.stringify(normalizedDocument, null, 2)}\n`,
      document: normalizedDocument,
      result: normalizedResult,
    };
  } catch (e) {
    throw new CorpusFixtureError("execute", e.message);
  }
}

function normalizeFixtureArtifact(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFixtureArtifact(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeFixtureArtifact(entry)]),
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(normalizedImplementationPrefix)
    ? normalized.slice(normalizedImplementationPrefix.length)
    : value;
}

function anneau1HandlersForFixture(fixture) {
  if (fixture.id === "tb-a1-p06-fallback-resolved-with-binding") {
    return {
      "tool:examples.a1_fallback_binding/FetchSource": () => {
        throw new Error("bounded anneau 1 fallback trigger");
      },
    };
  }

  return {
    "tool:examples.a1_tool_argument/FetchSource": createAnneau1FetchSourceHandler(),
    "tool:examples.a1_tool_binding/FetchSource": createAnneau1FetchSourceHandler(),
    "tool:examples.a1_skill_composition/FetchSource": createAnneau1FetchSourceHandler(),
    "tool:examples.a1_branch_binding/FetchSource": createAnneau1FetchSourceHandler(),
    "tool:examples.a1_loop_binding/FetchSource": createAnneau1FetchSourceHandler(),
    "tool:examples.a1_simple_agents/ApplyChange": ({ arguments: args }) => ({
      summary: args.request?.summary ?? "bounded anneau 1 change",
    }),
  };
}

function createAnneau1FetchSourceHandler() {
  return ({ arguments: args }) => ({
    body: args.request?.query ?? "bounded anneau 1 source",
  });
}

function expressionHandlersForFixture(fixture) {
  if (fixture.id !== "tb-expr1-p06-call-argument-expression") {
    return {};
  }

  return {
    "tool:examples.expr1_call_argument_expression/StoreScore": ({ arguments: args }) => ({
      approved: args.score >= 0.8,
    }),
  };
}

export function validateTraceResult(fixture, result) {
  const errors = [];
  if (result.status !== fixture.expectStatus) {
    errors.push(`expected status "${fixture.expectStatus}", got "${result.status}"`);
  }

  const events = result.trace?.events ?? [];
  if (events.length === 0) errors.push("trace has no events");
  if (events[0]?.kind !== "run_started") {
    errors.push(`first event should be run_started, got "${events[0]?.kind}"`);
  }
  if (events.at(-1)?.kind !== "run_completed") {
    errors.push(`last event should be run_completed, got "${events.at(-1)?.kind}"`);
  }

  return errors;
}
