import test from "node:test";
import assert from "node:assert/strict";
import { SymbolKind } from "vscode-languageserver/node.js";

import {
  completionForPosition,
  definitionForPosition,
  extractSymbols,
  findHoverCall,
  hoverForPosition,
  renderHoverCall,
  toLspDiagnostic,
  tryParseCompilerEnvelopeFromExecError,
} from "../src/server.mjs";

test("parses compiler JSON diagnostics from a non-zero exec error stdout", () => {
  const error = new Error("compiler exited with status 1");
  error.stdout = JSON.stringify({
    ok: false,
    diagnostics: [
      {
        code: "AstError",
        message: "missing body",
        source_ref: null,
      },
    ],
    air: null,
  });

  const result = tryParseCompilerEnvelopeFromExecError(error);

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      {
        code: "AstError",
        message: "missing body",
        source_ref: null,
      },
    ],
    air: null,
  });
});

test("extractSymbols returns numeric LSP symbol kinds", () => {
  const symbols = extractSymbols(
    {
      module: {
        name: "examples.demo",
        source_ref: {
          start_line: 0,
          start_column: 0,
          end_line: 0,
          end_column: 20,
        },
      },
      definitions: {
        constants: [
          {
            name: "ScoreLimit",
            source_ref: {
              start_line: 1,
              start_column: 0,
              end_line: 2,
              end_column: 0,
            },
          },
        ],
        types: [
          {
            name: "Draft",
            source_ref: {
              start_line: 2,
              start_column: 0,
              end_line: 3,
              end_column: 0,
            },
          },
        ],
      },
    },
    "file:///demo.tb",
  );

  assert.equal(symbols.length, 3);
  assert.equal(symbols[0].name, "examples.demo");
  assert.equal(typeof symbols[0].kind, "number");
  assert.equal(symbols[0].kind, SymbolKind.Module);
  assert.equal(symbols[1].name, "ScoreLimit");
  assert.equal(typeof symbols[1].kind, "number");
  assert.equal(symbols[1].kind, SymbolKind.Constant);
  assert.equal(symbols[2].name, "Draft");
  assert.equal(typeof symbols[2].kind, "number");
  assert.equal(symbols[2].kind, SymbolKind.Struct);
});

test("extractSymbols exposes IM-1 import declarations separately from local declarations", () => {
  const symbols = extractSymbols(hoverFixtureAir(), "file:///demo.tb");
  const importSymbol = symbols.find((symbol) => symbol.name === "function NormalizeQuery");
  const importedToolSymbol = symbols.find((symbol) => symbol.name === "tool SearchDatasets");

  assert.ok(importSymbol);
  assert.equal(importSymbol.kind, SymbolKind.Namespace);
  assert.deepEqual(importSymbol.location.range.start, { line: 36, character: 0 });
  assert.ok(importedToolSymbol);
  assert.equal(importedToolSymbol.kind, SymbolKind.Namespace);
  assert.deepEqual(importedToolSymbol.location.range.start, { line: 37, character: 0 });
});

test("toLspDiagnostic preserves compiler source ranges", () => {
  const diagnostic = toLspDiagnostic({
    code: "MissingSignatureOutput",
    message: "tool requires an explicit gives type",
    source_ref: {
      start_line: 4,
      start_column: 2,
      end_line: 6,
      end_column: 0,
    },
  });

  assert.deepEqual(diagnostic.range, {
    start: { line: 4, character: 2 },
    end: { line: 6, character: 0 },
  });
  assert.equal(diagnostic.code, "MissingSignatureOutput");
  assert.equal(diagnostic.source, "touba");
});

test("toLspDiagnostic relays expression diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "InvalidExpressionOperandType",
    message: "operator `+` expects Int or Float operands",
    source_ref: {
      start_line: 7,
      start_column: 13,
      end_line: 7,
      end_column: 27,
    },
  });

  assert.equal(diagnostic.code, "InvalidExpressionOperandType");
  assert.equal(diagnostic.message, "operator `+` expects Int or Float operands");
  assert.equal(diagnostic.source, "touba");
});

test("toLspDiagnostic relays anneau 1 diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "MissingExplicitCallArgument",
    message: "call to `FetchDraft` is missing argument `request`",
    source_ref: {
      start_line: 16,
      start_column: 8,
      end_line: 18,
      end_column: 16,
    },
  });

  assert.equal(diagnostic.code, "MissingExplicitCallArgument");
  assert.equal(diagnostic.message, "call to `FetchDraft` is missing argument `request`");
  assert.deepEqual(diagnostic.range.start, { line: 16, character: 8 });
});

test("toLspDiagnostic relays human approval diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "MissingHumanApprovalContextArgument",
    message: "human approval requires `with context as <expression>`",
    source_ref: {
      start_line: 12,
      start_column: 8,
      end_line: 14,
      end_column: 20,
    },
  });

  assert.equal(diagnostic.code, "MissingHumanApprovalContextArgument");
  assert.equal(diagnostic.message, "human approval requires `with context as <expression>`");
  assert.equal(diagnostic.source, "touba");
});

test("toLspDiagnostic relays TYPECHECK-1 diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "IncompatibleExpressionType",
    message: "give expects `builtin:Text`, got `builtin:Int`",
    source_ref: {
      start_line: 6,
      start_column: 13,
      end_line: 6,
      end_column: 18,
    },
  });

  assert.equal(diagnostic.code, "IncompatibleExpressionType");
  assert.equal(diagnostic.message, "give expects `builtin:Text`, got `builtin:Int`");
  assert.deepEqual(diagnostic.range.start, { line: 6, character: 13 });
});

test("toLspDiagnostic relays unreachable control-flow diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "UnreachableStatement",
    message: "statement is unreachable because a previous `give` terminates this execution path",
    source_ref: {
      start_line: 6,
      start_column: 8,
      end_line: 6,
      end_column: 21,
    },
  });

  assert.equal(diagnostic.code, "UnreachableStatement");
  assert.equal(
    diagnostic.message,
    "statement is unreachable because a previous `give` terminates this execution path",
  );
  assert.deepEqual(diagnostic.range.start, { line: 6, character: 8 });
});

test("toLspDiagnostic relays IM-1 import diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "ImportModuleNotFound",
    message: "import source module `examples.missing` is not part of the explicit project AIR set",
    source_ref: {
      start_line: 2,
      start_column: 0,
      end_line: 2,
      end_column: 49,
    },
  });

  assert.equal(diagnostic.code, "ImportModuleNotFound");
  assert.match(diagnostic.message, /explicit project AIR set/);
  assert.deepEqual(diagnostic.range.start, { line: 2, character: 0 });
});

test("toLspDiagnostic relays workspace package authority diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "ResourceBindingMissing",
    message: "resource binding is missing for memory:examples.memory/ProjectKnowledge",
    source_ref: {
      source_id: "workspace.tb",
      start_line: 7,
      start_column: 4,
      end_line: 7,
      end_column: 20,
    },
  });

  assert.equal(diagnostic.code, "ResourceBindingMissing");
  assert.equal(
    diagnostic.message,
    "resource binding is missing for memory:examples.memory/ProjectKnowledge",
  );
  assert.equal(diagnostic.source, "touba");
  assert.deepEqual(diagnostic.range.start, { line: 7, character: 4 });
});

test("toLspDiagnostic relays TEAM-1 ownership diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "ReviewGateMissing",
    message: "ownership target tool:examples.data_app/Search requires an approved prod review for required_secret",
    source_ref: {
      source_id: "touba.ownership.json",
      start_line: 14,
      start_column: 4,
      end_line: 14,
      end_column: 22,
    },
  });

  assert.equal(diagnostic.code, "ReviewGateMissing");
  assert.match(diagnostic.message, /approved prod review/);
  assert.equal(diagnostic.source, "touba");
  assert.deepEqual(diagnostic.range.start, { line: 14, character: 4 });
});

test("toLspDiagnostic relays callable_by diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "AgentCallerNotAllowed",
    message: "`strategy:examples.hover/RunDraft` cannot call agent `agent:examples.hover/Writer`",
    source_ref: {
      start_line: 27,
      start_column: 8,
      end_line: 27,
      end_column: 14,
    },
  });

  assert.equal(diagnostic.code, "AgentCallerNotAllowed");
  assert.match(diagnostic.message, /cannot call agent/);
  assert.equal(diagnostic.source, "touba");
});

test("toLspDiagnostic relays agent interface diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "MissingAgentInterfaceOutput",
    message: "agent `Reviewer` declares `takes` and must also declare `gives`",
    source_ref: sourceRef(18),
  });

  assert.equal(diagnostic.code, "MissingAgentInterfaceOutput");
  assert.match(diagnostic.message, /must also declare `gives`/);
  assert.equal(diagnostic.source, "touba");
});

test("toLspDiagnostic relays record construction diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "MissingRecordField",
    message: "record type `ReviewDecision` requires field `risk`",
    source_ref: sourceRef(5),
  });

  assert.equal(diagnostic.code, "MissingRecordField");
  assert.match(diagnostic.message, /requires field `risk`/);
  assert.deepEqual(diagnostic.range.start, { line: 5, character: 0 });
});

test("toLspDiagnostic relays invariant loop diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "InvariantLoopCondition",
    message: "while condition is invariant",
    source_ref: { start_line: 4, start_column: 8, end_line: 4, end_column: 18 },
  });
  assert.equal(diagnostic.code, "InvariantLoopCondition");
  assert.equal(diagnostic.message, "while condition is invariant");
});

test("toLspDiagnostic relays memory scope diagnostics without local reinterpretation", () => {
  const diagnostic = toLspDiagnostic({
    code: "OwnerMemoryScopeMissing",
    message: "owner `skill:examples.hover/BuildDraft` lacks memory scope `memory:examples.hover/ProjectKnowledge` read",
    source_ref: {
      start_line: 16,
      start_column: 8,
      end_line: 16,
      end_column: 18,
    },
  });

  assert.equal(diagnostic.code, "OwnerMemoryScopeMissing");
  assert.match(diagnostic.message, /lacks memory scope/);
  assert.equal(diagnostic.source, "touba");
});

test("hoverForPosition renders declaration data from AIR only", () => {
  const air = hoverFixtureAir();

  assert.match(hoverForPosition(air, { line: 0, character: 1 }), /module examples\.hover/);
  assert.match(hoverForPosition(air, { line: 1, character: 1 }), /define ScoreLimit/);
  assert.match(hoverForPosition(air, { line: 1, character: 1 }), /literal: 0.75/);
  assert.match(hoverForPosition(air, { line: 2, character: 1 }), /fields:\n- body: builtin:Text/);
  assert.match(hoverForPosition(air, { line: 5, character: 1 }), /function Normalize/);
  assert.match(hoverForPosition(air, { line: 9, character: 1 }), /tool FetchDraft/);
  assert.match(
    hoverForPosition(air, { line: 9, character: 1 }),
    /required_capabilities:\n- network\n- secret_read/,
  );
  assert.match(hoverForPosition(air, { line: 9, character: 1 }), /required_secrets:\n- API_KEY/);
  assert.match(
    hoverForPosition(air, { line: 9, character: 1 }),
    /memory_accesses:\n- memory:examples\.hover\/ProjectKnowledge read/,
  );
  assert.match(hoverForPosition(air, { line: 11, character: 1 }), /memory ProjectKnowledge/);
  assert.match(hoverForPosition(air, { line: 13, character: 1 }), /skill BuildDraft/);
  assert.match(
    hoverForPosition(air, { line: 13, character: 1 }),
    /memory_scopes:\n- memory:examples\.hover\/ProjectKnowledge read/,
  );
  assert.match(hoverForPosition(air, { line: 18, character: 1 }), /agent Writer/);
  assert.match(
    hoverForPosition(air, { line: 18, character: 1 }),
    /takes:\n- request: type:examples\.hover\/Draft\ngives: type:examples\.hover\/Draft/,
  );
  assert.match(
    hoverForPosition(air, { line: 18, character: 1 }),
    /responsibility: Produce governed drafts using only declared capabilities/,
  );
  assert.match(
    hoverForPosition(air, { line: 18, character: 1 }),
    /callable_by:\n- strategy:examples\.hover\/RunDraft/,
  );
  assert.match(hoverForPosition(air, { line: 21, character: 1 }), /strategy RunDraft/);
  assert.match(hoverForPosition(air, { line: 30, character: 1 }), /trigger DailyRun/);
  assert.match(hoverForPosition(air, { line: 30, character: 1 }), /event: schedule 0 8 \* \* \*/);
  assert.match(
    hoverForPosition(air, { line: 30, character: 1 }),
    /target_ref: strategy:examples\.hover\/RunDraft/,
  );
  assert.match(hoverForPosition(air, { line: 30, character: 1 }), /limits: max_runs_per_day=1 timeout_ms=30000/);
});

test("hoverForPosition renders IM-1 import data from AIR only", () => {
  const rendered = hoverForPosition(hoverFixtureAir(), { line: 36, character: 3 });

  assert.match(rendered, /import function NormalizeQuery/);
  assert.match(rendered, /from_module: examples\.common/);
  assert.match(rendered, /target_ref: function:examples\.common\/NormalizeQuery/);
  assert.match(rendered, /status: resolved/);
});

test("hoverForPosition renders IM-2A imported tool data from AIR only", () => {
  const rendered = hoverForPosition(hoverFixtureAir(), { line: 37, character: 3 });

  assert.match(rendered, /import tool SearchDatasets/);
  assert.match(rendered, /from_module: examples\.data_tools/);
  assert.match(rendered, /target_ref: tool:examples\.data_tools\/SearchDatasets/);
  assert.match(rendered, /status: resolved/);
  assert.doesNotMatch(rendered, /handler|grant|secret value|auto-discovery/i);
});

test("hoverForPosition renders anneau 1 call data from AIR only", () => {
  const air = hoverFixtureAir();
  const call = findHoverCall(air, { line: 16, character: 8 });

  assert.ok(call);
  assert.match(renderHoverCall(call), /call FetchDraft/);
  assert.match(hoverForPosition(air, { line: 16, character: 8 }), /arguments:\n- value:request/);
  assert.match(hoverForPosition(air, { line: 16, character: 8 }), /result_binding: draft/);
});

test("hoverForPosition renders human approval data from AIR only", () => {
  const rendered = hoverForPosition(hoverFixtureAir(), { line: 24, character: 8 });

  assert.match(rendered, /human approval/);
  assert.match(rendered, /approval_ref: approval:examples\.hover:required/);
  assert.match(rendered, /mode: required_approval/);
  assert.match(rendered, /context_refs:\n- value:draft/);
  assert.match(rendered, /decision_binding: approval/);
});

test("hoverForPosition renders user interaction data from AIR only", () => {
  const rendered = hoverForPosition(hoverFixtureAir(), { line: 26, character: 8 });

  assert.match(rendered, /user interaction/);
  assert.match(rendered, /interaction_ref: interaction:examples\.hover:ask/);
  assert.match(rendered, /mode: ask/);
  assert.match(rendered, /arguments:\n- expr:prompt/);
  assert.match(rendered, /result_binding: answer/);
});

test("hoverForPosition renders bind data from AIR only", () => {
  const rendered = hoverForPosition(hoverFixtureAir(), { line: 28, character: 8 });

  assert.match(rendered, /bind accepted/);
  assert.match(rendered, /arguments:\n- expr:accepted/);
  assert.match(rendered, /result_binding: accepted/);
});

test("hoverForPosition stays absent outside supported declaration headers", () => {
  const air = hoverFixtureAir();

  assert.equal(hoverForPosition(air, { line: 3, character: 4 }), null);
  assert.equal(hoverForPosition(air, { line: 15, character: 8 }), null);
  assert.equal(hoverForPosition({ definitions: {} }, { line: 1, character: 0 }), null);
});

test("definitionForPosition resolves uses and do calls through AIR source refs", () => {
  const air = hoverFixtureAir();

  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 14, character: 10 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 9, character: 0 },
      end: { line: 10, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 16, character: 8 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 9, character: 0 },
      end: { line: 10, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 20, character: 4 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 21, character: 0 },
      end: { line: 22, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 10, character: 14 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 11, character: 0 },
      end: { line: 12, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 15, character: 14 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 11, character: 0 },
      end: { line: 12, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 32, character: 16 }), {
    uri: "file:///demo.tb",
    range: {
      start: { line: 21, character: 0 },
      end: { line: 22, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 36, character: 3 }), {
    uri: "file:///tmp/touba-common.tb",
    range: {
      start: { line: 44, character: 0 },
      end: { line: 46, character: 0 },
    },
  });
  assert.deepEqual(definitionForPosition(air, "file:///demo.tb", { line: 37, character: 3 }), {
    uri: "file:///tmp/touba-data-tools.tb",
    range: {
      start: { line: 12, character: 0 },
      end: { line: 18, character: 0 },
    },
  });
});

test("definitionForPosition stays absent for unresolved positions and non-local refs", () => {
  const air = hoverFixtureAir();

  assert.equal(definitionForPosition(air, "file:///demo.tb", { line: 14, character: 25 }), null);
  assert.equal(definitionForPosition({ definitions: {}, execution_graphs: [] }, "file:///demo.tb", {
    line: 1,
    character: 1,
  }), null);
});

test("completionForPosition returns deterministic keywords and local declarations", () => {
  const labels = completionForPosition(hoverFixtureAir(), "    us", {
    line: 0,
    character: 6,
  }).map((item) => item.label);

  assert.ok(labels.includes("uses"));
  assert.ok(labels.includes("define"));
  assert.ok(labels.includes("bind"));
  assert.ok(labels.includes("with"));
  assert.ok(labels.includes("into"));
  assert.ok(labels.includes("requires"));
  assert.ok(labels.includes("secrets"));
  assert.ok(labels.includes("responsibility"));
  assert.ok(labels.includes("memory"));
  assert.ok(labels.includes("callable_by"));
  assert.ok(labels.includes("human.approve"));
  assert.ok(labels.includes("human.review"));
  assert.ok(labels.includes("show"));
  assert.ok(labels.includes("ask"));
  assert.ok(labels.includes("text"));
  assert.ok(labels.includes("trigger"));
  assert.ok(labels.includes("schedule"));
  assert.ok(labels.includes("runs"));
  assert.ok(labels.includes("limits"));
  assert.ok(labels.includes("max_runs_per_day"));
  assert.ok(labels.includes("timeout_ms"));
  assert.ok(labels.includes("ScoreLimit"));
  assert.ok(labels.includes("FetchDraft"));
  assert.ok(labels.includes("ProjectKnowledge"));
  assert.ok(labels.includes("BuildDraft"));
  assert.ok(labels.includes("DailyRun"));
  assert.ok(labels.includes("NormalizeQuery"));
  assert.ok(labels.includes("SearchDatasets"));
});

test("completionForPosition stays silent in unsupported contexts", () => {
  assert.deepEqual(completionForPosition(hoverFixtureAir(), "    # us", {
    line: 0,
    character: 8,
  }), []);
  assert.deepEqual(completionForPosition(hoverFixtureAir(), '    give "dr', {
    line: 0,
    character: 12,
  }), []);
});

function hoverFixtureAir() {
  return {
    module: {
      id: "module:examples.hover",
      name: "examples.hover",
      source_ref: sourceRef(0),
    },
    definitions: {
      constants: [
        {
          id: "constant:examples.hover/ScoreLimit",
          name: "ScoreLimit",
          type_ref: "Float",
          literal_float: 0.75,
          source_ref: sourceRef(1),
        },
      ],
      types: [
        {
          id: "type:examples.hover/Draft",
          name: "Draft",
          fields: [
            {
              name: "body",
              type_ref: "builtin:Text",
              source_ref: sourceRef(3, 4),
            },
          ],
          source_ref: sourceRef(2),
        },
      ],
      functions: [
        {
          id: "function:examples.hover/Normalize",
          name: "Normalize",
          signature: signature("draft", "type:examples.hover/Draft", "type:examples.hover/Draft"),
          body_graph_ref: "graph:function:examples.hover/Normalize",
          source_ref: sourceRef(5),
        },
        {
          id: "function:examples.common/NormalizeQuery",
          name: "NormalizeQuery",
          signature: signature("query", "builtin:Text", "builtin:Text"),
          body_graph_ref: "graph:function:examples.common/NormalizeQuery",
          source_ref: sourceRefWithSource("/tmp/touba-common.tb", 44, 0, 0, 46),
        },
      ],
      tools: [
        {
          id: "tool:examples.hover/FetchDraft",
          name: "FetchDraft",
          signature: signature("request", "builtin:Text", "type:examples.hover/Draft"),
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["API_KEY"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.hover/ProjectKnowledge",
              access: "read",
              source_ref: sourceRef(10, 4, 28, 10),
            },
          ],
          source_ref: sourceRef(9),
        },
        {
          id: "tool:examples.data_tools/SearchDatasets",
          name: "SearchDatasets",
          signature: signature(
            "request",
            "type:examples.data_tools/DatasetSearchRequest",
            "type:examples.data_tools/DatasetSearchResult",
          ),
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["API_KEY"],
          source_ref: sourceRefWithSource("/tmp/touba-data-tools.tb", 12, 0, 0, 18),
        },
      ],
      memories: [
        {
          id: "memory:examples.hover/ProjectKnowledge",
          name: "ProjectKnowledge",
          source_ref: sourceRef(11),
        },
      ],
      skills: [
        {
          id: "skill:examples.hover/BuildDraft",
          name: "BuildDraft",
          signature: signature("request", "builtin:Text", "type:examples.hover/Draft"),
          uses: ["tool:examples.hover/FetchDraft"],
          use_refs: [
            {
              target_ref: "tool:examples.hover/FetchDraft",
              source_ref: sourceRef(14, 4, 20, 14),
            },
          ],
          memory_scopes: [
            {
              memory_ref: "memory:examples.hover/ProjectKnowledge",
              access: "read",
              source_ref: sourceRef(15, 4, 28, 15),
            },
          ],
          flow_graph_ref: "graph:skill:examples.hover/BuildDraft",
          source_ref: sourceRef(13),
        },
      ],
      agents: [
        {
          id: "agent:examples.hover/Writer",
          name: "Writer",
          signature: signature("request", "type:examples.hover/Draft", "type:examples.hover/Draft"),
          responsibility: "Produce governed drafts using only declared capabilities.",
          uses: ["skill:examples.hover/BuildDraft"],
          use_refs: [
            {
              target_ref: "skill:examples.hover/BuildDraft",
              source_ref: sourceRef(19, 4, 20, 19),
            },
          ],
          callable_by: [
            {
              caller_ref: "strategy:examples.hover/RunDraft",
              caller_kind: "strategy",
              source_ref: sourceRef(20, 4, 34, 20),
            },
          ],
          source_ref: sourceRef(18),
        },
      ],
      strategies: [
        {
          id: "strategy:examples.hover/RunDraft",
          name: "RunDraft",
          uses: ["agent:examples.hover/Writer"],
          use_refs: [
            {
              target_ref: "agent:examples.hover/Writer",
              source_ref: sourceRef(22, 4, 16, 22),
            },
          ],
          flow_graph_ref: "graph:strategy:examples.hover/RunDraft",
          source_ref: sourceRef(21),
        },
      ],
      triggers: [
        {
          id: "trigger:examples.hover/DailyRun",
          name: "DailyRun",
          event: {
            kind: "schedule",
            value: "0 8 * * *",
            source_ref: sourceRef(31, 4, 27, 31),
          },
          target_ref: "strategy:examples.hover/RunDraft",
          target_kind: "strategy",
          limits: {
            max_runs_per_day: 1,
            timeout_ms: 30000,
            source_ref: sourceRef(33, 4, 26, 35),
          },
          source_ref: sourceRef(30, 0, 26, 35),
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.hover/BuildDraft",
        nodes: [
          {
            id: "n1",
            target_ref: "tool:examples.hover/FetchDraft",
            arguments: ["value:request"],
            result_binding: "draft",
            source_ref: sourceRef(16, 8, 18, 16),
          },
          {
            id: "n2",
            kind: "human_approval",
            approval_ref: "approval:examples.hover:required",
            approval_mode: "required_approval",
            context_refs: ["value:draft"],
            result_binding: "approval",
            source_ref: sourceRef(24, 8, 26, 24),
          },
          {
            id: "n3",
            kind: "user_interaction",
            interaction_ref: "interaction:examples.hover:ask",
            interaction_mode: "ask",
            arguments: ["expr:prompt"],
            result_binding: "answer",
            source_ref: sourceRef(26, 8, 16, 26),
          },
          {
            id: "n4",
            kind: "bind",
            arguments: ["expr:accepted"],
            result_binding: "accepted",
            source_ref: sourceRef(28, 8, 20, 28),
          },
        ],
      },
    ],
    imports: [
      {
        kind: "function",
        name: "NormalizeQuery",
        from_module: "examples.common",
        target_ref: "function:examples.common/NormalizeQuery",
        source_ref: sourceRef(36, 0, 60, 36),
      },
      {
        kind: "tool",
        name: "SearchDatasets",
        from_module: "examples.data_tools",
        target_ref: "tool:examples.data_tools/SearchDatasets",
        source_ref: sourceRef(37, 0, 58, 37),
      },
    ],
  };
}

function signature(inputName, inputType, outputType) {
  return {
    inputs: [
      {
        name: inputName,
        type_ref: inputType,
        source_ref: sourceRef(0),
      },
    ],
    output_type: outputType,
  };
}

function sourceRef(line, column = 0, endColumn = 0, endLine = line + 1) {
  return {
    start_line: line,
    start_column: column,
    end_line: endLine,
    end_column: endColumn,
  };
}

function sourceRefWithSource(sourceId, line, column = 0, endColumn = 0, endLine = line + 1) {
  return {
    ...sourceRef(line, column, endColumn, endLine),
    source_id: sourceId,
  };
}
