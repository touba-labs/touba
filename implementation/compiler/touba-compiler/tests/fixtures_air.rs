use touba_compiler::air::{
    AIR_SCHEMA_VERSION, AirDiagnosticCode, AirDocument, AirExpressionKind, AirExpressionOperator,
    AirFlowEdgeRole, AirFlowNodeKind, AirHumanApprovalMode, AirTraceAnchorKind,
    AirUserInteractionMode,
};
use touba_compiler::ast::{
    AstBody, AstCallableDeclaration, AstDeclaration, AstDocument, AstModule, AstSignature,
    AstTypeRef, SourceRef,
};
use touba_compiler::{
    AIR_JSON_PROFILE, assemble_project_air, build_air, compile_source_to_air,
    deserialize_air_from_json, serialize_air_to_json,
};

const REFERENCE_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-v01-001",
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb"),
    ),
    (
        "tb-v01-002",
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-002-fallback.tb"),
    ),
    (
        "tb-v01-003",
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-003-branch.tb"),
    ),
    (
        "tb-v01-004",
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-004-loop.tb"),
    ),
    (
        "tb-v01-005",
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-005-strategy-agents.tb"),
    ),
];

struct NegativeAirFixture {
    source_id: &'static str,
    source: &'static str,
    expected_code: AirDiagnosticCode,
}

const NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "invalid-duplicate",
        source: include_str!("fixtures/negative/air/duplicate-definition.tb"),
        expected_code: AirDiagnosticCode::DuplicateDefinition,
    },
    NegativeAirFixture {
        source_id: "invalid-signature",
        source: include_str!("fixtures/negative/air/missing-signature-output.tb"),
        expected_code: AirDiagnosticCode::MissingSignatureOutput,
    },
    NegativeAirFixture {
        source_id: "invalid-use",
        source: include_str!("fixtures/negative/air/unknown-use-reference.tb"),
        expected_code: AirDiagnosticCode::UnknownReference,
    },
    NegativeAirFixture {
        source_id: "invalid-call",
        source: include_str!("fixtures/negative/air/non-callable-call-target.tb"),
        expected_code: AirDiagnosticCode::UnknownReference,
    },
    NegativeAirFixture {
        source_id: "invalid-branch",
        source: include_str!("fixtures/negative/air/invalid-branch-condition.tb"),
        expected_code: AirDiagnosticCode::InvalidBranchCondition,
    },
    NegativeAirFixture {
        source_id: "invalid-loop",
        source: include_str!("fixtures/negative/air/invalid-loop-collection.tb"),
        expected_code: AirDiagnosticCode::InvalidLoopCollection,
    },
    NegativeAirFixture {
        source_id: "invalid-type-ref",
        source: include_str!("fixtures/negative/air/unknown-type-reference.tb"),
        expected_code: AirDiagnosticCode::UnknownTypeReference,
    },
    NegativeAirFixture {
        source_id: "invalid-missing-give",
        source: include_str!("fixtures/negative/air/missing-give-value.tb"),
        expected_code: AirDiagnosticCode::MissingGiveValue,
    },
    NegativeAirFixture {
        source_id: "invalid-give-value",
        source: include_str!("fixtures/negative/air/invalid-give-value.tb"),
        expected_code: AirDiagnosticCode::InvalidGiveValue,
    },
];

const ANNEAU1_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-a1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n01-implicit-result-consumed-by-if.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidBranchCondition,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n02-missing-explicit-argument.tb"
        ),
        expected_code: AirDiagnosticCode::MissingExplicitCallArgument,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n03-unknown-argument.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownCallArgument,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n04-duplicate-argument.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateCallArgument,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n05-duplicate-result-binding.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateResultBinding,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n06",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n06-use-before-binding.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidGiveValue,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n07",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n07-enriched-agent-call-blocked.tb"
        ),
        expected_code: AirDiagnosticCode::EnrichedAgentCallBlocked,
    },
    NegativeAirFixture {
        source_id: "tb-a1-n08",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n08-fallback-target-absent.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownReference,
    },
];

const EXPR1_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-expr1-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p01-int-arithmetic.tb"
        ),
    ),
    (
        "tb-expr1-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p02-float-average.tb"
        ),
    ),
    (
        "tb-expr1-p03",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p03-boolean-comparison.tb"
        ),
    ),
    (
        "tb-expr1-p04",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p04-text-concat.tb"
        ),
    ),
    (
        "tb-expr1-p05",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p05-field-access.tb"
        ),
    ),
    (
        "tb-expr1-p06",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p06-call-argument-expression.tb"
        ),
    ),
    (
        "tb-expr1-p07",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p07-conditional-field-score.tb"
        ),
    ),
    (
        "tb-expr1-p08",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p08-text-rendering.tb"
        ),
    ),
];

const IMPORTS_IM1_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-im1-n12",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/semantic/tb-im1-n12-import-name-collision.tb"
        ),
        expected_code: AirDiagnosticCode::ImportNameCollision,
    },
    NegativeAirFixture {
        source_id: "tb-im1-n13",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/semantic/tb-im1-n13-duplicate-import-name.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateImport,
    },
];

const IMPORTS_IM1_PROJECT_COMMON: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-common.tb"
);
const IMPORTS_IM1_PROJECT_SEARCH: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-search.tb"
);
const IMPORTS_IM1_PROJECT_MISSING_MODULE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-missing-module.tb"
);
const IMPORTS_IM1_PROJECT_MISSING_DECLARATION: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-missing-declaration.tb"
);
const IMPORTS_IM1_PROJECT_KIND_MISMATCH: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-kind-mismatch.tb"
);
const IMPORTS_IM1_PROJECT_CYCLE_A: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-cycle-a.tb"
);
const IMPORTS_IM1_PROJECT_CYCLE_B: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-cycle-b.tb"
);
const IMPORTS_IM1_PROJECT_IMPURE_SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-impure-source.tb"
);
const IMPORTS_IM1_PROJECT_IMPURE_IMPORTER: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im1/project/tb-im1-project-impure-importer.tb"
);
const IMPORTS_IM2A_TOOL_AIR_LOCAL: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/tool/positive/tb-im2a-p01-import-tool-air-local.tb"
);
const IMPORTS_IM2A_PROJECT_DATA_TOOLS: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/tool/project/tb-im2a-project-data-tools.tb"
);
const IMPORTS_IM2A_PROJECT_RESEARCH_APP: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/tool/project/tb-im2a-project-research-app.tb"
);
const IMPORTS_IM2B_FLOW_AIR_LOCAL: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/flow/positive/tb-im2b-p01-import-skill-strategy-air-local.tb"
);
const IMPORTS_IM2B_PROJECT_SHARED_FLOW: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/flow/project/tb-im2b-project-shared-flow.tb"
);
const IMPORTS_IM2B_PROJECT_FLOW_APP: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/flow/project/tb-im2b-project-flow-app.tb"
);
const IMPORTS_IM2C_AGENT_AIR_LOCAL: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/agent/positive/tb-im2c-p01-import-agent-air-local.tb"
);
const IMPORTS_IM2C_PROJECT_AGENT_POOL: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/agent/project/tb-im2c-project-agent-pool.tb"
);
const IMPORTS_IM2C_PROJECT_AGENT_APP: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/agent/project/tb-im2c-project-agent-app.tb"
);
const IMPORTS_IM2C_PROJECT_AGENT_APP_UNAUTHORIZED: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/agent/project/tb-im2c-project-agent-app-unauthorized.tb"
);
const IMPORTS_IM2D_MEMORY_AIR_LOCAL: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/memory/positive/tb-im2d-p01-import-memory-air-local.tb"
);
const IMPORTS_IM2D_PROJECT_SHARED_MEMORY: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/memory/project/tb-im2d-project-shared-memory.tb"
);
const IMPORTS_IM2D_PROJECT_MEMORY_TOOLS: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/memory/project/tb-im2d-project-memory-tools.tb"
);
const IMPORTS_IM2D_PROJECT_MEMORY_APP: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/memory/project/tb-im2d-project-memory-app.tb"
);
const IMPORTS_IM2D_PROJECT_MEMORY_APP_MISSING_SCOPE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/imports-im2/memory/project/tb-im2d-project-memory-app-missing-scope.tb"
);

const EXPR1_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-expr1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n01-text-plus.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidExpressionOperandType,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n02-unknown-field.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownExpressionField,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n03-static-division-zero.tb"
        ),
        expected_code: AirDiagnosticCode::StaticExpressionDivisionByZero,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n04-invalid-modulo-float.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidExpressionOperandType,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n05-text-order-comparison.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidExpressionOperandType,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n06",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n06-implicit-text-conversion.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidExpressionOperandType,
    },
    NegativeAirFixture {
        source_id: "tb-expr1-n09",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/semantic/tb-expr1-n09-text-render-local-type.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidExpressionOperandType,
    },
];

const BIND_DEFINE_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-binddefine-v1-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb"
        ),
    ),
    (
        "tb-binddefine-v1-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p02-module-define-skill.tb"
        ),
    ),
];

const BIND_DEFINE_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-binddefine-v1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/bind-define-v1/negative/semantic/tb-binddefine-v1-n01-duplicate-local-bind.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateLocalBinding,
    },
    NegativeAirFixture {
        source_id: "tb-binddefine-v1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/bind-define-v1/negative/semantic/tb-binddefine-v1-n02-define-non-literal.tb"
        ),
        expected_code: AirDiagnosticCode::UnsupportedModuleConstantExpression,
    },
    NegativeAirFixture {
        source_id: "tb-binddefine-v1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/bind-define-v1/negative/semantic/tb-binddefine-v1-n03-bind-type-mismatch.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
];

const TYPECHECK_V1_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-typecheck-v1-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p01-int-to-float-give.tb"
        ),
    ),
    (
        "tb-typecheck-v1-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p02-field-argument.tb"
        ),
    ),
    (
        "tb-typecheck-v1-p03-di-explicit-instruction-boundary",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p03-di-explicit-instruction-boundary.tb"
        ),
    ),
    (
        "tb-typecheck-v1-p04-di-authorized-instruction-input",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/tb-typecheck-v1-p04-di-authorized-instruction-input.tb"
        ),
    ),
];

const TYPECHECK_V1_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n01-give-int-to-text.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n02-with-text-to-int.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n03-if-text-condition.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n04-for-non-list.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidLoopCollection,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n05-unknown-field.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownExpressionField,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n06-di-source-to-instruction",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n06-di-source-to-instruction.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n07-di-text-to-instruction",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n07-di-text-to-instruction.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
    NegativeAirFixture {
        source_id: "tb-typecheck-v1-n08-di-instruction-to-source",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/negative/semantic/tb-typecheck-v1-n08-di-instruction-to-source.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
];

const CONTROL_FLOW_V1_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[(
    "tb-controlflow-v1-p01",
    include_str!(
        "../../../grammar/tree-sitter-touba/examples/control-flow-v1/positive/tb-controlflow-v1-p01-if-branches-give.tb"
    ),
)];

const CONTROL_FLOW_V1_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-controlflow-v1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/control-flow-v1/negative/semantic/tb-controlflow-v1-n01-give-then-give.tb"
        ),
        expected_code: AirDiagnosticCode::UnreachableStatement,
    },
    NegativeAirFixture {
        source_id: "tb-controlflow-v1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/control-flow-v1/negative/semantic/tb-controlflow-v1-n02-stop-then-show.tb"
        ),
        expected_code: AirDiagnosticCode::UnreachableStatement,
    },
    NegativeAirFixture {
        source_id: "tb-controlflow-v1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/control-flow-v1/negative/semantic/tb-controlflow-v1-n03-if-terminal-then-show.tb"
        ),
        expected_code: AirDiagnosticCode::UnreachableStatement,
    },
];

const TRIGGER_A2_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-a2-trigger-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb"
        ),
    ),
    (
        "tb-a2-trigger-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p02-schedule-strategy-with-literal.tb"
        ),
    ),
    (
        "tb-a2-trigger-p03",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p03-schedule-strategy-with-define.tb"
        ),
    ),
];

const TRIGGER_A2_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n01-runs-agent-rejected.tb"
        ),
        expected_code: AirDiagnosticCode::UnsupportedTriggerTargetKind,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n02-request-family-rejected.tb"
        ),
        expected_code: AirDiagnosticCode::UnsupportedTriggerEventKind,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n03-missing-limits.tb"
        ),
        expected_code: AirDiagnosticCode::MissingTriggerLimits,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n04-missing-timeout.tb"
        ),
        expected_code: AirDiagnosticCode::MissingTriggerLimit,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n05-non-positive-max-runs.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidTriggerLimit,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n06",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n06-non-positive-timeout.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidTriggerLimit,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n07",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n07-duplicate-trigger.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateDefinition,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n08",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n08-target-strategy-missing.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownTriggerTarget,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n09",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n09-duplicate-limit.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateTriggerLimit,
    },
    NegativeAirFixture {
        source_id: "tb-a2-trigger-n10",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/negative/semantic/tb-a2-trigger-n10-host-input-rejected.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidTriggerArgument,
    },
];

const HUMAN_APPROVAL_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-human-v1-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p01-required-approval.tb"
        ),
    ),
    (
        "tb-human-v1-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p02-agent-review-branch.tb"
        ),
    ),
    (
        "tb-human-v1-p03",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p03-strategy-approval.tb"
        ),
    ),
];

const HUMAN_APPROVAL_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-human-v1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/negative/semantic/tb-human-v1-n01-missing-context.tb"
        ),
        expected_code: AirDiagnosticCode::MissingHumanApprovalContextArgument,
    },
    NegativeAirFixture {
        source_id: "tb-human-v1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/negative/semantic/tb-human-v1-n02-missing-into.tb"
        ),
        expected_code: AirDiagnosticCode::MissingHumanApprovalDecisionBinding,
    },
    NegativeAirFixture {
        source_id: "tb-human-v1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/negative/semantic/tb-human-v1-n03-unknown-argument.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownHumanApprovalArgument,
    },
    NegativeAirFixture {
        source_id: "tb-human-v1-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/human-approval-v1/negative/semantic/tb-human-v1-n04-function-approval.tb"
        ),
        expected_code: AirDiagnosticCode::HumanApprovalInFunction,
    },
];

const USER_INTERACTION_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-user-v1-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb"
        ),
    ),
    (
        "tb-user-v1-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p02-show-text-rendering.tb"
        ),
    ),
];

const USER_INTERACTION_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-user-v1-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/negative/semantic/tb-user-v1-n01-ask-missing-into.tb"
        ),
        expected_code: AirDiagnosticCode::MissingUserInteractionResultBinding,
    },
    NegativeAirFixture {
        source_id: "tb-user-v1-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/negative/semantic/tb-user-v1-n02-show-in-function.tb"
        ),
        expected_code: AirDiagnosticCode::UserInteractionInFunction,
    },
    NegativeAirFixture {
        source_id: "tb-user-v1-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/negative/semantic/tb-user-v1-n03-show-unknown-argument.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownUserInteractionArgument,
    },
    NegativeAirFixture {
        source_id: "tb-user-v1-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/negative/semantic/tb-user-v1-n04-ask-non-text-prompt.tb"
        ),
        expected_code: AirDiagnosticCode::IncompatibleExpressionType,
    },
];

const AGENT_AUTHORITY_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[(
    "tb-a2-auth-p01",
    include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/positive/tb-a2-auth-p01-strategy-callable-by.tb"
    ),
)];

const AGENT_AUTHORITY_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-a2-auth-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n01-missing-callable-by.tb"
        ),
        expected_code: AirDiagnosticCode::AgentCallerNotAllowed,
    },
    NegativeAirFixture {
        source_id: "tb-a2-auth-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n02-strategy-not-authorized.tb"
        ),
        expected_code: AirDiagnosticCode::AgentCallerNotAllowed,
    },
    NegativeAirFixture {
        source_id: "tb-a2-auth-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n03-unknown-caller.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownCallableByCaller,
    },
    NegativeAirFixture {
        source_id: "tb-a2-auth-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n04-invalid-caller-kind-skill.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidCallableByCallerKind,
    },
    NegativeAirFixture {
        source_id: "tb-a2-auth-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n05-duplicate-caller.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateCallableByRule,
    },
];

const MEMORY_SCOPES_POSITIVE_AIR_FIXTURES: &[(&str, &str)] = &[
    (
        "tb-a2-mem-p01",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p01-agent-read-memory.tb"
        ),
    ),
    (
        "tb-a2-mem-p02",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p02-agent-write-memory.tb"
        ),
    ),
    (
        "tb-a2-mem-p03",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p03-skill-read-memory.tb"
        ),
    ),
    (
        "tb-a2-mem-p04",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p04-strategy-read-memory.tb"
        ),
    ),
];

const MEMORY_SCOPES_NEGATIVE_AIR_FIXTURES: &[NegativeAirFixture] = &[
    NegativeAirFixture {
        source_id: "tb-a2-mem-n01",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n01-owner-unknown-memory.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownMemoryReference,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n02",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n02-tool-unknown-memory.tb"
        ),
        expected_code: AirDiagnosticCode::UnknownMemoryReference,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n03",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n03-invalid-access.tb"
        ),
        expected_code: AirDiagnosticCode::InvalidMemoryAccess,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n04",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n04-duplicate-memory.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateMemoryDeclaration,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n05",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n05-duplicate-owner-scope.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateMemoryScope,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n06",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n06-duplicate-tool-access.tb"
        ),
        expected_code: AirDiagnosticCode::DuplicateToolMemoryAccess,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n07",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n07-missing-memory-read-capability.tb"
        ),
        expected_code: AirDiagnosticCode::MissingMemoryReadCapability,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n08",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n08-missing-memory-write-capability.tb"
        ),
        expected_code: AirDiagnosticCode::MissingMemoryWriteCapability,
    },
    NegativeAirFixture {
        source_id: "tb-a2-mem-n09",
        source: include_str!(
            "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n09-owner-scope-missing.tb"
        ),
        expected_code: AirDiagnosticCode::OwnerMemoryScopeMissing,
    },
];

#[test]
fn lowers_all_reference_fixtures_to_air() {
    for (source_id, source) in REFERENCE_FIXTURES {
        let result = compile_source_to_air(*source_id, source);
        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
    }
}

#[test]
fn lowers_linear_skill_fixture_to_air() {
    let source =
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb");

    let result = compile_source_to_air("tb-v01-001", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");
    assert_eq!(document.air_schema_version, AIR_SCHEMA_VERSION);
    assert_eq!(document.module.name, "examples.linear_skill");
    assert_eq!(document.definitions.types.len(), 3);
    assert_eq!(document.definitions.tools.len(), 1);
    assert_eq!(document.definitions.skills.len(), 1);
    assert_eq!(document.definitions.agents.len(), 1);
    assert_eq!(document.definitions.strategies.len(), 1);

    let skill_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.linear_skill/BuildNote")
        .expect("BuildNote graph should exist");
    assert!(
        skill_graph
            .nodes
            .iter()
            .any(|node| node.kind == AirFlowNodeKind::CallTool
                && node.target_ref.as_deref() == Some("tool:examples.linear_skill/FetchSource"))
    );
    assert!(
        document
            .trace_points
            .iter()
            .any(|point| point.owner_ref == skill_graph.id
                && point.anchor_kind == AirTraceAnchorKind::Call)
    );
}

#[test]
fn lowers_branch_fixture_with_explicit_condition_ref() {
    let source = include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-003-branch.tb");

    let result = compile_source_to_air("tb-v01-003", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");
    let skill_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.branch/ReviewDraft")
        .expect("ReviewDraft graph should exist");
    let branch = skill_graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::Branch)
        .expect("branch node should exist");

    assert_eq!(branch.condition_ref.as_deref(), Some("value:accepted"));
    assert!(
        skill_graph
            .edges
            .iter()
            .any(|edge| edge.from_node_id == branch.id && edge.role == AirFlowEdgeRole::True)
    );
    assert!(
        skill_graph
            .edges
            .iter()
            .any(|edge| edge.from_node_id == branch.id && edge.role == AirFlowEdgeRole::False)
    );
}

#[test]
fn lowers_loop_fixture_with_explicit_collection_handle() {
    let source = include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-004-loop.tb");

    let result = compile_source_to_air("tb-v01-004", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");
    let skill_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.loop/NormalizeItems")
        .expect("NormalizeItems graph should exist");
    let loop_node = skill_graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::Loop)
        .expect("loop node should exist");

    assert_eq!(
        loop_node.condition_ref.as_deref(),
        Some("loop_has_next:value:items")
    );
    assert!(
        loop_node
            .arguments
            .iter()
            .any(|argument| argument == "value:items")
    );
    assert!(skill_graph
        .edges
        .iter()
        .any(|edge| edge.from_node_id == loop_node.id && edge.role == AirFlowEdgeRole::LoopNext));
    assert!(skill_graph
        .edges
        .iter()
        .any(|edge| edge.from_node_id == loop_node.id && edge.role == AirFlowEdgeRole::LoopExit));
}

#[test]
fn lowers_fallback_fixture_with_failure_path() {
    let source = include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-002-fallback.tb");

    let result = compile_source_to_air("tb-v01-002", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");
    let skill = document
        .definitions
        .skills
        .iter()
        .find(|skill| skill.id == "skill:examples.fallback/BuildSource")
        .expect("BuildSource skill should exist");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.id == skill.flow_graph_ref)
        .expect("BuildSource graph should exist");

    assert_eq!(skill.failure_path_refs.len(), 1);
    assert_eq!(graph.failure_paths.len(), 1);
    assert!(
        graph
            .nodes
            .iter()
            .any(|node| node.kind == AirFlowNodeKind::Fallback
                && node.target_ref.as_deref()
                    == Some("skill:examples.fallback/BuildFallbackSource"))
    );
}

#[test]
fn reports_expected_diagnostics_for_negative_air_fixtures() {
    for fixture in NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_anneau1_enriched_calls_to_air_arguments_and_bindings() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/anneau-1/positive/tb-a1-p03-skill-composition-binding.tb"
    );

    let result = compile_source_to_air("tb-a1-p03", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("anneau 1 fixture should lower");
    let load_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.a1_skill_composition/LoadSource")
        .expect("LoadSource graph should exist");
    let fetch_call = load_graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::CallTool)
        .expect("FetchSource call should exist");

    assert_eq!(fetch_call.arguments, ["value:request"]);
    assert_eq!(fetch_call.result_binding.as_deref(), Some("source"));

    let run_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.a1_skill_composition/RunPipeline")
        .expect("RunPipeline graph should exist");
    let build_note_call = run_graph
        .nodes
        .iter()
        .find(|node| {
            node.kind == AirFlowNodeKind::CallSkill
                && node.target_ref.as_deref()
                    == Some("skill:examples.a1_skill_composition/BuildNote")
        })
        .expect("BuildNote call should exist");

    assert_eq!(build_note_call.arguments, ["value:source"]);
    assert_eq!(build_note_call.result_binding.as_deref(), Some("note"));
}

#[test]
fn reports_expected_diagnostics_for_anneau1_negative_air_fixtures() {
    for fixture in ANNEAU1_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_expr1_positive_fixtures_to_air() {
    for (source_id, source) in EXPR1_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert!(
            document
                .execution_graphs
                .iter()
                .any(|graph| !graph.expressions.is_empty()),
            "{source_id} should produce at least one AirExpression"
        );
    }
}

#[test]
fn lowers_imports_im1_to_air_refs_without_resolution() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/imports-im1/positive/tb-im1-p09-imports-air-only.tb"
    );

    let result = compile_source_to_air("tb-im1-p09", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");

    assert_eq!(document.imports.len(), 3);
    assert_eq!(document.imports[0].kind, "type");
    assert_eq!(document.imports[0].name, "SearchRequest");
    assert_eq!(document.imports[0].from_module, "examples.common");
    assert_eq!(
        document.imports[0].target_ref,
        "type:examples.common/SearchRequest"
    );
    assert_eq!(document.imports[1].kind, "define");
    assert_eq!(
        document.imports[1].target_ref,
        "constant:examples.common/DefaultRows"
    );
    assert_eq!(document.imports[2].kind, "function");
    assert_eq!(
        document.imports[2].target_ref,
        "function:examples.common/NormalizeQuery"
    );
}

#[test]
fn lowers_import_tool_to_air_local_ref_without_project_execution() {
    let result = compile_source_to_air("tb-im2a-p01", IMPORTS_IM2A_TOOL_AIR_LOCAL);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");

    assert_eq!(document.imports.len(), 1);
    assert_eq!(document.imports[0].kind, "tool");
    assert_eq!(document.imports[0].name, "SearchDatasets");
    assert_eq!(document.imports[0].from_module, "examples.data_tools");
    assert_eq!(
        document.imports[0].target_ref,
        "tool:examples.data_tools/SearchDatasets"
    );
    assert!(
        document.definitions.tools.is_empty(),
        "local AIR import should not create a local tool declaration"
    );
}

#[test]
fn project_air_assembles_imported_tools_with_declaring_refs() {
    let data_tools = compile_source_to_air("tb-im2a-project-data", IMPORTS_IM2A_PROJECT_DATA_TOOLS)
        .document
        .expect("source tool module should lower to AIR");
    let research_app =
        compile_source_to_air("tb-im2a-project-app", IMPORTS_IM2A_PROJECT_RESEARCH_APP)
            .document
            .expect("importing module should lower to local AIR");

    let result = assemble_project_air("examples.research_app", &[research_app, data_tools]);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("project assembly should include imported tool AIR");
    assert!(
        document
            .definitions
            .tools
            .iter()
            .any(|tool| tool.id == "tool:examples.data_tools/SearchDatasets"),
        "assembled AIR should include imported tool with declaring module ref"
    );
    assert!(
        document
            .definitions
            .types
            .iter()
            .any(|declaration| declaration.id == "type:examples.data_tools/DatasetSearchRequest"),
        "assembled AIR should include imported tool input type"
    );
    assert!(
        document.execution_graphs.iter().any(|graph| {
            graph.nodes.iter().any(|node| {
                node.target_ref.as_deref() == Some("tool:examples.data_tools/SearchDatasets")
            })
        }),
        "assembled AIR graph should call the imported tool ref"
    );
}

#[test]
fn lowers_imports_im2b_skill_strategy_to_air_local_refs() {
    let result = compile_source_to_air("tb-im2b-p01", IMPORTS_IM2B_FLOW_AIR_LOCAL);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");

    assert_eq!(document.imports.len(), 2);
    assert_eq!(document.imports[0].kind, "skill");
    assert_eq!(
        document.imports[0].target_ref,
        "skill:examples.shared_flow/NormalizeTopic"
    );
    assert_eq!(document.imports[1].kind, "strategy");
    assert_eq!(
        document.imports[1].target_ref,
        "strategy:examples.shared_flow/SharedTopicRun"
    );
    assert_eq!(
        document.definitions.triggers[0].target_ref,
        "strategy:examples.shared_flow/SharedTopicRun"
    );
}

#[test]
fn project_air_assembles_imported_skills_and_strategies_with_graphs() {
    let shared_flow =
        compile_source_to_air("tb-im2b-project-shared", IMPORTS_IM2B_PROJECT_SHARED_FLOW)
            .document
            .expect("shared flow module should lower to AIR");
    let flow_app = compile_source_to_air("tb-im2b-project-app", IMPORTS_IM2B_PROJECT_FLOW_APP)
        .document
        .expect("flow app module should lower to AIR");

    let result = assemble_project_air("examples.flow_app", &[flow_app, shared_flow]);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("project assembly should include imported flow AIR");
    assert!(
        document
            .definitions
            .skills
            .iter()
            .any(|skill| skill.id == "skill:examples.shared_flow/NormalizeTopic"),
        "assembled AIR should include imported skill with declaring module ref"
    );
    assert!(
        document
            .definitions
            .strategies
            .iter()
            .any(|strategy| strategy.id == "strategy:examples.shared_flow/SharedTopicRun"),
        "assembled AIR should include imported strategy with declaring module ref"
    );
    assert!(
        document
            .execution_graphs
            .iter()
            .any(|graph| graph.owner_ref == "strategy:examples.shared_flow/SharedTopicRun"),
        "assembled AIR should include imported strategy graph"
    );
}

#[test]
fn lowers_imports_im2c_agent_to_air_local_ref_without_authority_leak() {
    let result = compile_source_to_air("tb-im2c-p01", IMPORTS_IM2C_AGENT_AIR_LOCAL);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");

    assert_eq!(document.imports.len(), 1);
    assert_eq!(document.imports[0].kind, "agent");
    assert_eq!(
        document.imports[0].target_ref,
        "agent:examples.agent_pool/Reviewer"
    );
    assert!(
        document.definitions.agents.is_empty(),
        "local AIR import should not create a local agent declaration"
    );
}

#[test]
fn project_air_assembles_imported_agents_with_inter_module_callable_by() {
    let agent_pool = compile_source_to_air("tb-im2c-project-pool", IMPORTS_IM2C_PROJECT_AGENT_POOL)
        .document
        .expect("agent pool should lower to AIR");
    let agent_app = compile_source_to_air("tb-im2c-project-app", IMPORTS_IM2C_PROJECT_AGENT_APP)
        .document
        .expect("agent app should lower to AIR");

    let result = assemble_project_air("examples.agent_app", &[agent_app, agent_pool]);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("project assembly should include imported agent AIR");
    let agent = document
        .definitions
        .agents
        .iter()
        .find(|agent| agent.id == "agent:examples.agent_pool/Reviewer")
        .expect("assembled AIR should include imported agent");
    assert_eq!(
        agent.callable_by[0].caller_ref,
        "strategy:examples.agent_app/RunReview"
    );
}

#[test]
fn project_air_refuses_imported_agent_without_matching_callable_by() {
    let agent_pool = compile_source_to_air("tb-im2c-project-pool", IMPORTS_IM2C_PROJECT_AGENT_POOL)
        .document
        .expect("agent pool should lower to AIR");
    let agent_app = compile_source_to_air(
        "tb-im2c-project-app-unauthorized",
        IMPORTS_IM2C_PROJECT_AGENT_APP_UNAUTHORIZED,
    )
    .document
    .expect("unauthorized agent app should lower to local AIR");

    assert_project_air_diagnostic(
        "examples.agent_app_unauthorized",
        &[agent_app, agent_pool],
        AirDiagnosticCode::AgentCallerNotAllowed,
    );
}

#[test]
fn lowers_imports_im2d_memory_to_air_local_ref() {
    let result = compile_source_to_air("tb-im2d-p01", IMPORTS_IM2D_MEMORY_AIR_LOCAL);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AIR");

    assert!(
        document.imports.iter().any(|import| import.kind == "memory"
            && import.target_ref == "memory:examples.shared_memory/ProjectKnowledge"),
        "local AIR should preserve imported memory ref"
    );
}

#[test]
fn project_air_assembles_imported_memories_and_checks_scoped_access() {
    let shared_memory =
        compile_source_to_air("tb-im2d-project-memory", IMPORTS_IM2D_PROJECT_SHARED_MEMORY)
            .document
            .expect("shared memory should lower to AIR");
    let memory_tools =
        compile_source_to_air("tb-im2d-project-tools", IMPORTS_IM2D_PROJECT_MEMORY_TOOLS)
            .document
            .expect("memory tool module should lower to AIR");
    let memory_app = compile_source_to_air("tb-im2d-project-app", IMPORTS_IM2D_PROJECT_MEMORY_APP)
        .document
        .expect("memory app should lower to AIR");

    let result = assemble_project_air(
        "examples.memory_app",
        &[memory_app, memory_tools, shared_memory],
    );

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("project assembly should include imported memory AIR");
    assert!(
        document
            .definitions
            .memories
            .iter()
            .any(|memory| memory.id == "memory:examples.shared_memory/ProjectKnowledge"),
        "assembled AIR should include imported memory"
    );
    assert!(
        document
            .definitions
            .tools
            .iter()
            .any(|tool| tool.id == "tool:examples.memory_tools/ReadKnowledge"),
        "assembled AIR should include imported memory access tool"
    );
}

#[test]
fn project_air_refuses_imported_memory_tool_without_owner_scope() {
    let shared_memory =
        compile_source_to_air("tb-im2d-project-memory", IMPORTS_IM2D_PROJECT_SHARED_MEMORY)
            .document
            .expect("shared memory should lower to AIR");
    let memory_tools =
        compile_source_to_air("tb-im2d-project-tools", IMPORTS_IM2D_PROJECT_MEMORY_TOOLS)
            .document
            .expect("memory tool module should lower to AIR");
    let memory_app = compile_source_to_air(
        "tb-im2d-project-app-missing-scope",
        IMPORTS_IM2D_PROJECT_MEMORY_APP_MISSING_SCOPE,
    )
    .document
    .expect("memory app should lower to local AIR");

    assert_project_air_diagnostic(
        "examples.memory_app_missing_scope",
        &[memory_app, memory_tools, shared_memory],
        AirDiagnosticCode::OwnerMemoryScopeMissing,
    );
}

#[test]
fn reports_expected_diagnostics_for_imports_im1_negative_air_fixtures() {
    for fixture in IMPORTS_IM1_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        assert!(
            result.document.is_none(),
            "{} should fail",
            fixture.source_id
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == fixture.expected_code),
            "{} should report {:?}, got {:?}",
            fixture.source_id,
            fixture.expected_code,
            result.diagnostics
        );
    }
}

#[test]
fn assembles_imports_im1_project_air_from_explicit_modules() {
    let common = compile_air_fixture("im1-project-common", IMPORTS_IM1_PROJECT_COMMON);
    let search = compile_air_fixture("im1-project-search", IMPORTS_IM1_PROJECT_SEARCH);

    let result = assemble_project_air("examples.project_search", &[search.clone(), common.clone()]);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("project assembly should produce AIR");
    assert_eq!(document.module.name, "examples.project_search");
    assert!(
        document
            .definitions
            .types
            .iter()
            .any(|declaration| declaration.id == "type:examples.project_common/SearchRequest"),
        "assembled AIR should include imported type"
    );
    assert!(
        document.definitions.constants.iter().any(|declaration| {
            declaration.id == "constant:examples.project_common/DefaultRows"
        }),
        "assembled AIR should include imported define as constant"
    );
    assert!(
        document.definitions.functions.iter().any(|declaration| {
            declaration.id == "function:examples.project_common/NormalizeQuery"
        }),
        "assembled AIR should include imported function"
    );
    assert!(
        document
            .execution_graphs
            .iter()
            .any(|graph| { graph.owner_ref == "function:examples.project_common/NormalizeQuery" }),
        "assembled AIR should include imported function graph"
    );
}

#[test]
fn reports_project_air_import_resolution_diagnostics() {
    let common = compile_air_fixture("im1-project-common", IMPORTS_IM1_PROJECT_COMMON);

    assert_project_air_diagnostic(
        "examples.project_missing_module",
        &[compile_air_fixture(
            "im1-project-missing-module",
            IMPORTS_IM1_PROJECT_MISSING_MODULE,
        )],
        AirDiagnosticCode::ImportModuleNotFound,
    );

    assert_project_air_diagnostic(
        "examples.project_missing_declaration",
        &[
            compile_air_fixture(
                "im1-project-missing-declaration",
                IMPORTS_IM1_PROJECT_MISSING_DECLARATION,
            ),
            common.clone(),
        ],
        AirDiagnosticCode::ImportDeclarationNotFound,
    );

    assert_project_air_diagnostic(
        "examples.project_kind_mismatch",
        &[
            compile_air_fixture(
                "im1-project-kind-mismatch",
                IMPORTS_IM1_PROJECT_KIND_MISMATCH,
            ),
            common,
        ],
        AirDiagnosticCode::ImportKindMismatch,
    );
}

#[test]
fn reports_project_air_import_cycles() {
    let cycle_a = compile_air_fixture("im1-project-cycle-a", IMPORTS_IM1_PROJECT_CYCLE_A);
    let cycle_b = compile_air_fixture("im1-project-cycle-b", IMPORTS_IM1_PROJECT_CYCLE_B);

    assert_project_air_diagnostic(
        "examples.project_cycle_a",
        &[cycle_a, cycle_b],
        AirDiagnosticCode::ImportCycleDetected,
    );
}

#[test]
fn refuses_impure_function_imports_in_im1_project_air() {
    let source = compile_air_fixture(
        "im1-project-impure-source",
        IMPORTS_IM1_PROJECT_IMPURE_SOURCE,
    );
    let importer = compile_air_fixture(
        "im1-project-impure-importer",
        IMPORTS_IM1_PROJECT_IMPURE_IMPORTER,
    );

    assert_project_air_diagnostic(
        "examples.project_impure_importer",
        &[importer, source],
        AirDiagnosticCode::ImportFunctionNotPure,
    );
}

#[test]
fn lowers_expr1_function_expression_to_structured_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p01-int-arithmetic.tb"
    );

    let result = compile_source_to_air("tb-expr1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("expression fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "function:examples.expr1_int_arithmetic/ComputeTotal")
        .expect("ComputeTotal graph should exist");
    let give_node = graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::Give)
        .expect("give node should exist");

    assert_eq!(give_node.arguments.len(), 1);
    assert!(give_node.arguments[0].starts_with("expr:expression:"));
    assert_eq!(graph.expressions.len(), 2);

    let multiply = graph
        .expressions
        .iter()
        .find(|expression| expression.operator == Some(AirExpressionOperator::Multiply))
        .expect("multiplication expression should exist");
    assert_eq!(multiply.kind, AirExpressionKind::BinaryOp);
    assert_eq!(multiply.type_ref.as_deref(), Some("builtin:Int"));
    assert_eq!(multiply.operands, ["value:bonus", "literal:int:2"]);

    let add = graph
        .expressions
        .iter()
        .find(|expression| expression.operator == Some(AirExpressionOperator::Add))
        .expect("addition expression should exist");
    assert_eq!(add.kind, AirExpressionKind::BinaryOp);
    assert_eq!(add.type_ref.as_deref(), Some("builtin:Int"));
    assert_eq!(add.operands[0], "value:count");
    assert_eq!(add.operands[1], format!("expr:{}", multiply.id));
}

#[test]
fn lowers_expr1_call_argument_and_field_access_to_structured_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p06-call-argument-expression.tb"
    );

    let result = compile_source_to_air("tb-expr1-p06", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("expression fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| {
            graph.owner_ref == "skill:examples.expr1_call_argument_expression/ReviewScore"
        })
        .expect("ReviewScore graph should exist");
    let call = graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::CallTool)
        .expect("StoreScore call should exist");

    assert_eq!(call.arguments.len(), 1);
    assert!(call.arguments[0].starts_with("expr:expression:"));

    let field = graph
        .expressions
        .iter()
        .find(|expression| expression.kind == AirExpressionKind::FieldAccess)
        .expect("field access expression should exist");
    assert_eq!(field.field_name.as_deref(), Some("score"));
    assert_eq!(field.type_ref.as_deref(), Some("builtin:Float"));
    assert_eq!(field.operands, ["value:analysis"]);

    let add = graph
        .expressions
        .iter()
        .find(|expression| expression.operator == Some(AirExpressionOperator::Add))
        .expect("addition expression should exist");
    assert_eq!(add.type_ref.as_deref(), Some("builtin:Float"));
    assert_eq!(add.operands[0], format!("expr:{}", field.id));
    assert_eq!(add.operands[1], "value:bonus");
}

#[test]
fn lowers_expr1_text_rendering_to_structured_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p08-text-rendering.tb"
    );

    let result = compile_source_to_air("tb-expr1-p08", source);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("text rendering fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "function:examples.expr1_text_rendering/FormatSummary")
        .expect("FormatSummary graph should exist");
    let text_conversions: Vec<_> = graph
        .expressions
        .iter()
        .filter(|expression| expression.kind == AirExpressionKind::TextConversion)
        .collect();

    assert_eq!(text_conversions.len(), 4);
    assert!(
        text_conversions
            .iter()
            .all(|expression| expression.type_ref.as_deref() == Some("builtin:Text"))
    );
    assert!(
        text_conversions
            .iter()
            .any(|expression| expression.operands == ["value:age"])
    );
    assert!(
        text_conversions
            .iter()
            .any(|expression| expression.operands == ["value:score"])
    );
    assert!(
        text_conversions
            .iter()
            .any(|expression| expression.operands == ["value:next_age"])
    );
    assert!(
        text_conversions
            .iter()
            .any(|expression| expression.operands == ["value:active"])
    );
}

#[test]
fn reports_expected_diagnostics_for_expr1_negative_air_fixtures() {
    for fixture in EXPR1_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_bind_define_positive_fixtures_to_air() {
    for (source_id, source) in BIND_DEFINE_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
    }
}

#[test]
fn lowers_bind_and_define_to_explicit_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p02-module-define-skill.tb"
    );

    let result = compile_source_to_air("tb-binddefine-v1-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("bind/define fixture should lower");
    assert_eq!(document.definitions.constants.len(), 2);
    assert!(
        document
            .definitions
            .constants
            .iter()
            .any(|constant| constant.id
                == "constant:examples.binddefine_module_define/DefaultTopic"
                && constant.literal_text.as_deref() == Some("transport"))
    );

    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "function:examples.binddefine_module_define/IsAccepted")
        .expect("IsAccepted graph should exist");
    let give = graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::Give)
        .expect("give node should exist");
    assert!(give.arguments[0].starts_with("expr:"));
    assert!(
        graph
            .expressions
            .iter()
            .any(|expression| expression.operands
                == [
                    "value:score".to_string(),
                    "constant:examples.binddefine_module_define/ScoreLimit".to_string()
                ])
    );
}

#[test]
fn lowers_bind_statement_to_air_node() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb"
    );

    let result = compile_source_to_air("tb-binddefine-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("bind fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "function:examples.binddefine_local_bind/ReviewScore")
        .expect("ReviewScore graph should exist");
    let binds: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.kind == AirFlowNodeKind::Bind)
        .collect();
    assert_eq!(binds.len(), 2);
    assert_eq!(binds[0].result_binding.as_deref(), Some("adjusted"));
    assert_eq!(binds[1].result_binding.as_deref(), Some("accepted"));
    assert!(
        document
            .trace_points
            .iter()
            .any(|trace| trace.anchor_kind == AirTraceAnchorKind::Binding)
    );
}

#[test]
fn reports_expected_diagnostics_for_bind_define_negative_air_fixtures() {
    for fixture in BIND_DEFINE_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_typecheck_v1_positive_fixtures_to_air() {
    for (source_id, source) in TYPECHECK_V1_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
    }
}

#[test]
fn reports_expected_diagnostics_for_typecheck_v1_negative_air_fixtures() {
    for fixture in TYPECHECK_V1_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_control_flow_v1_positive_fixtures_to_air() {
    for (source_id, source) in CONTROL_FLOW_V1_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
    }
}

#[test]
fn reports_expected_diagnostics_for_control_flow_v1_negative_air_fixtures() {
    for fixture in CONTROL_FLOW_V1_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_trigger_a2_positive_fixtures_to_air() {
    for (source_id, source) in TRIGGER_A2_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert_eq!(
            document.definitions.triggers.len(),
            1,
            "{source_id} should produce one AirTrigger"
        );
    }
}

#[test]
fn lowers_trigger_schedule_to_air_contract() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p03-schedule-strategy-with-define.tb"
    );

    let result = compile_source_to_air("tb-a2-trigger-p03", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("trigger fixture should lower");
    let trigger = document
        .definitions
        .triggers
        .iter()
        .find(|trigger| trigger.id == "trigger:examples.a2_trigger_schedule_define/DailyResearch")
        .expect("DailyResearch trigger should exist");

    assert_eq!(trigger.name, "DailyResearch");
    assert_eq!(trigger.event.kind, "schedule");
    assert_eq!(trigger.event.value, "0 8 * * *");
    assert_eq!(
        trigger.target_ref,
        "strategy:examples.a2_trigger_schedule_define/RunResearch"
    );
    assert_eq!(trigger.target_kind, "strategy");
    assert_eq!(trigger.arguments.len(), 1);
    assert_eq!(trigger.arguments[0].input, "topic");
    assert_eq!(
        trigger.arguments[0].value_ref,
        "constant:examples.a2_trigger_schedule_define/ResearchTopic"
    );
    assert_eq!(trigger.limits.max_runs_per_day, 1);
    assert_eq!(trigger.limits.timeout_ms, 30000);
}

#[test]
fn lowers_trigger_literal_argument_without_host_payload() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p02-schedule-strategy-with-literal.tb"
    );

    let result = compile_source_to_air("tb-a2-trigger-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("trigger fixture should lower");
    let trigger = document
        .definitions
        .triggers
        .first()
        .expect("trigger should exist");
    assert_eq!(trigger.arguments[0].value_ref, "literal:string:AI safety");

    let json = serde_json::to_string(&document).expect("AIR should serialize");
    for forbidden in ["payload", "env", "secret", "handler", "adapter", "http"] {
        assert!(
            !json.contains(forbidden),
            "trigger AIR tranche 1 must not contain `{forbidden}`"
        );
    }
}

#[test]
fn reports_expected_diagnostics_for_trigger_a2_negative_air_fixtures() {
    for fixture in TRIGGER_A2_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_human_approval_positive_fixtures_to_air() {
    for (source_id, source) in HUMAN_APPROVAL_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert!(
            document.execution_graphs.iter().any(|graph| {
                graph
                    .nodes
                    .iter()
                    .any(|node| node.kind == AirFlowNodeKind::HumanApproval)
            }),
            "{source_id} should produce a human approval node"
        );
    }
}

#[test]
fn lowers_required_human_approval_to_air_node() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p01-required-approval.tb"
    );

    let result = compile_source_to_air("tb-human-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("human approval fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "skill:examples.human_required_approval/ReviewAndApply")
        .expect("ReviewAndApply graph should exist");
    let approval = graph
        .nodes
        .iter()
        .find(|node| node.kind == AirFlowNodeKind::HumanApproval)
        .expect("human approval node should exist");

    assert_eq!(
        approval.approval_mode,
        Some(AirHumanApprovalMode::RequiredApproval)
    );
    assert!(
        approval
            .approval_ref
            .as_ref()
            .is_some_and(|approval_ref| approval_ref.starts_with("approval:graph:"))
    );
    assert_eq!(approval.context_refs, ["value:change"]);
    assert_eq!(approval.result_binding.as_deref(), Some("approval"));
    assert!(document.trace_points.iter().any(|point| {
        point.owner_ref == graph.id && point.anchor_kind == AirTraceAnchorKind::HumanApproval
    }));
}

#[test]
fn reports_expected_diagnostics_for_human_approval_negative_air_fixtures() {
    for fixture in HUMAN_APPROVAL_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_user_interaction_positive_fixtures_to_air() {
    for (source_id, source) in USER_INTERACTION_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert!(
            document.execution_graphs.iter().any(|graph| {
                graph
                    .nodes
                    .iter()
                    .any(|node| node.kind == AirFlowNodeKind::UserInteraction)
            }),
            "{source_id} should produce a user interaction node"
        );
    }
}

#[test]
fn lowers_user_interaction_show_and_ask_to_air_nodes() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb"
    );

    let result = compile_source_to_air("tb-user-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("user interaction fixture should lower");
    let graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "strategy:examples.user_interaction/RunInteraction")
        .expect("RunInteraction graph should exist");
    let interactions = graph
        .nodes
        .iter()
        .filter(|node| node.kind == AirFlowNodeKind::UserInteraction)
        .collect::<Vec<_>>();

    assert_eq!(interactions.len(), 3);
    assert_eq!(
        interactions[0].interaction_mode,
        Some(AirUserInteractionMode::Show)
    );
    assert_eq!(
        interactions[0].arguments,
        vec!["literal:string:Touba ready".to_string()]
    );
    assert!(interactions[0].result_binding.is_none());
    assert_eq!(
        interactions[1].interaction_mode,
        Some(AirUserInteractionMode::Ask)
    );
    assert_eq!(
        interactions[1].arguments,
        vec!["literal:string:Search query?".to_string()]
    );
    assert_eq!(interactions[1].result_binding.as_deref(), Some("query"));
    assert!(
        interactions[1]
            .interaction_ref
            .as_ref()
            .is_some_and(|interaction_ref| interaction_ref.starts_with("interaction:graph:"))
    );
    assert!(document.trace_points.iter().any(|point| {
        point.owner_ref == graph.id && point.anchor_kind == AirTraceAnchorKind::UserInteraction
    }));
}

#[test]
fn reports_expected_diagnostics_for_user_interaction_negative_air_fixtures() {
    for fixture in USER_INTERACTION_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_agent_authority_positive_fixtures_to_air() {
    for (source_id, source) in AGENT_AUTHORITY_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert!(
            document
                .definitions
                .agents
                .iter()
                .any(|agent| !agent.callable_by.is_empty()),
            "{source_id} should lower at least one callable_by rule"
        );
    }
}

#[test]
fn lowers_agent_callable_by_to_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/positive/tb-a2-auth-p01-strategy-callable-by.tb"
    );

    let result = compile_source_to_air("tb-a2-auth-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("agent authority fixture should lower");
    let agent = document
        .definitions
        .agents
        .iter()
        .find(|agent| agent.id == "agent:examples.a2_auth_strategy_allowed/Engineer")
        .expect("Engineer agent should exist");

    assert_eq!(agent.callable_by.len(), 1);
    assert_eq!(
        agent.callable_by[0].caller_ref,
        "strategy:examples.a2_auth_strategy_allowed/RunChange"
    );
    assert_eq!(agent.callable_by[0].caller_kind, "strategy");
    assert!(agent.callable_by[0].source_ref.end_byte > agent.callable_by[0].source_ref.start_byte);

    let run_graph = document
        .execution_graphs
        .iter()
        .find(|graph| graph.owner_ref == "strategy:examples.a2_auth_strategy_allowed/RunChange")
        .expect("RunChange graph should exist");
    assert!(run_graph.nodes.iter().any(|node| {
        node.kind == AirFlowNodeKind::CallAgent
            && node.target_ref.as_deref()
                == Some("agent:examples.a2_auth_strategy_allowed/Engineer")
    }));
}

#[test]
fn reports_expected_diagnostics_for_agent_authority_negative_air_fixtures() {
    for fixture in AGENT_AUTHORITY_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn lowers_all_memory_scopes_positive_fixtures_to_air() {
    for (source_id, source) in MEMORY_SCOPES_POSITIVE_AIR_FIXTURES {
        let result = compile_source_to_air(*source_id, source);

        assert_eq!(
            result.diagnostics,
            [],
            "{source_id} should lower without AIR diagnostics"
        );
        let document = result
            .document
            .unwrap_or_else(|| panic!("{source_id} should produce AIR"));
        assert_air_ids_are_module_qualified(&document);
        assert_air_references_resolve(&document);
        assert!(
            !document.definitions.memories.is_empty(),
            "{source_id} should lower a memory declaration"
        );
    }
}

#[test]
fn lowers_memory_scopes_to_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p03-skill-read-memory.tb"
    );

    let result = compile_source_to_air("tb-a2-mem-p03", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("memory fixture should lower");
    assert_eq!(document.definitions.memories.len(), 1);
    assert_eq!(
        document.definitions.memories[0].id,
        "memory:examples.a2_memory_skill_read/ProjectKnowledge"
    );

    let tool = document
        .definitions
        .tools
        .iter()
        .find(|tool| tool.id == "tool:examples.a2_memory_skill_read/ReadProjectKnowledge")
        .expect("ReadProjectKnowledge tool should exist");
    assert_eq!(tool.required_capabilities, ["memory_read"]);
    assert_eq!(tool.memory_accesses.len(), 1);
    assert_eq!(
        tool.memory_accesses[0].memory_ref,
        "memory:examples.a2_memory_skill_read/ProjectKnowledge"
    );
    assert_eq!(tool.memory_accesses[0].access, "read");

    let skill = document
        .definitions
        .skills
        .iter()
        .find(|skill| skill.id == "skill:examples.a2_memory_skill_read/SummarizeKnowledge")
        .expect("SummarizeKnowledge skill should exist");
    assert_eq!(skill.memory_scopes.len(), 1);
    assert_eq!(
        skill.memory_scopes[0].memory_ref,
        "memory:examples.a2_memory_skill_read/ProjectKnowledge"
    );
    assert_eq!(skill.memory_scopes[0].access, "read");
}

#[test]
fn reports_expected_diagnostics_for_memory_scopes_negative_air_fixtures() {
    for fixture in MEMORY_SCOPES_NEGATIVE_AIR_FIXTURES {
        let result = compile_source_to_air(fixture.source_id, fixture.source);

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == fixture.expected_code)
            .unwrap_or_else(|| {
                panic!(
                    "{} should report {:?}; got {:?}",
                    fixture.source_id, fixture.expected_code, result.diagnostics
                )
            });
        assert!(
            result.document.is_none(),
            "{} should not produce AIR when diagnostics exist",
            fixture.source_id
        );
        assert_source_ref_present(diagnostic);
    }
}

#[test]
fn reports_invalid_expr1_numeric_literal() {
    let source = "\
module examples.expr1_invalid_numeric

function TooLarge
    gives Int
    do
        give 9007199254740992
";

    let result = compile_source_to_air("expr1-invalid-numeric", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == AirDiagnosticCode::InvalidNumericLiteral })
    );
}

#[test]
fn lowers_tool_required_capabilities_to_air() {
    let source = "\
module examples.tool_requires

type SourceRequest
    query is Text

type SourceText
    body is Text

tool FetchSource
    takes request as SourceRequest
    gives SourceText
    requires network, secret_read
";

    let result = compile_source_to_air("tool-requires", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("tool requires should lower");
    let tool = document
        .definitions
        .tools
        .iter()
        .find(|tool| tool.id == "tool:examples.tool_requires/FetchSource")
        .expect("FetchSource tool should exist");

    assert_eq!(tool.required_capabilities, ["network", "secret_read"]);
}

#[test]
fn lowers_tool_required_secrets_to_air() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/positive/tb-v1-tool-secrets-env.tb"
    );

    let result = compile_source_to_air("tool-secrets", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("tool secrets should lower");
    let tool = document
        .definitions
        .tools
        .iter()
        .find(|tool| tool.id == "tool:examples.v1_tool_secrets/CallLLM")
        .expect("CallLLM tool should exist");

    assert_eq!(tool.required_capabilities, ["network", "secret_read"]);
    assert_eq!(tool.required_secrets, ["OPENAI_API_KEY"]);
}

#[test]
fn serializes_tool_required_secrets_without_secret_values() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/positive/tb-v1-tool-secrets-env.tb"
    );

    let result = compile_source_to_air("tool-secrets", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("tool secrets should lower");
    let json = serde_json::to_string(&document).expect("AIR should serialize to JSON");

    assert!(json.contains("\"required_secrets\":[\"OPENAI_API_KEY\"]"));
    for forbidden in ["sk-", "ghp_", "SECRET_VALUE", "actual_secret"] {
        assert!(
            !json.contains(forbidden),
            "AIR JSON must not contain secret-like fixture value `{forbidden}`"
        );
    }
}

#[test]
fn reports_invalid_tool_required_capabilities() {
    let source = "\
module examples.bad_tool_requires

type SourceRequest
    query is Text

type SourceText
    body is Text

tool FetchSource
    takes request as SourceRequest
    gives SourceText
    requires network, network, unknown_capability
";

    let result = compile_source_to_air("bad-tool-requires", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AirDiagnosticCode::DuplicateToolCapability)
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AirDiagnosticCode::UnknownToolCapability)
    );
}

#[test]
fn reports_duplicate_tool_required_secrets() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/negative/semantic/tb-v1-tool-secrets-duplicate.tb"
    );

    let result = compile_source_to_air("duplicate-tool-secrets", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AirDiagnosticCode::DuplicateToolSecret)
    );
}

#[test]
fn reports_missing_secret_read_capability_for_tool_secrets() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/negative/semantic/tb-v1-tool-secrets-missing-secret-read.tb"
    );

    let result = compile_source_to_air("tool-secrets-missing-secret-read", source);

    assert!(result.document.is_none());
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == AirDiagnosticCode::MissingToolSecretReadCapability
    }));
}

#[test]
fn reports_empty_flow_graph_for_empty_ast_body_with_source_ref() {
    let source_ref = test_source_ref("invalid-empty-flow-ast");
    let document = AstDocument {
        module: AstModule {
            name: "invalid.empty_flow".to_string(),
            source_ref: source_ref.clone(),
        },
        imports: Vec::new(),
        declarations: vec![AstDeclaration::Function(AstCallableDeclaration {
            name: "Build".to_string(),
            signature: AstSignature {
                inputs: Vec::new(),
                output: Some(AstTypeRef {
                    raw: "Draft".to_string(),
                    source_ref: source_ref.clone(),
                }),
            },
            required_capabilities: Vec::new(),
            required_secrets: Vec::new(),
            memory_accesses: Vec::new(),
            body: Some(AstBody {
                statements: Vec::new(),
                source_ref: source_ref.clone(),
            }),
            source_ref: source_ref.clone(),
        })],
    };

    let result = build_air(&document);

    let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == AirDiagnosticCode::EmptyFlowGraph)
        .expect("empty AST body should be diagnosed at AIR level");
    assert!(result.document.is_none());
    assert_source_ref_present(diagnostic);
}

#[test]
fn serializes_air_document_to_bootstrap_json_profile() {
    let source =
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb");
    let result = compile_source_to_air("tb-v01-001", source);
    let document = result.document.expect("fixture should lower to AIR");

    let json = serialize_air_to_json(&document).expect("AIR should serialize to JSON");

    assert_eq!(AIR_JSON_PROFILE, "air-json-v0.1");
    assert!(json.starts_with("{\n  \"air_schema_version\": \"air-minimal-v0.1\""));
    assert!(json.contains("\"kind\": \"call_tool\""));
    assert!(json.contains("\"anchor_kind\": \"scope_entry\""));
    assert!(!json.contains("\"binding_ref\": null"));

    let decoded = deserialize_air_from_json(&json).expect("AIR JSON should deserialize");
    assert_eq!(decoded, document);
}

fn assert_source_ref_present(diagnostic: &touba_compiler::AirDiagnostic) {
    let source_ref = diagnostic
        .source_ref
        .as_ref()
        .expect("semantic diagnostic should carry a source_ref");
    assert!(source_ref.end_byte >= source_ref.start_byte);
}

fn test_source_ref(source_id: &str) -> SourceRef {
    SourceRef {
        source_id: source_id.to_string(),
        start_byte: 0,
        end_byte: 1,
        start_line: 0,
        start_column: 0,
        end_line: 0,
        end_column: 1,
    }
}

fn compile_air_fixture(source_id: &str, source: &str) -> AirDocument {
    let result = compile_source_to_air(source_id, source);
    assert_eq!(
        result.diagnostics,
        [],
        "{source_id} should compile before project assembly"
    );
    result
        .document
        .unwrap_or_else(|| panic!("{source_id} should produce AIR"))
}

fn assert_project_air_diagnostic(
    entry_module: &str,
    documents: &[AirDocument],
    expected_code: AirDiagnosticCode,
) {
    let result = assemble_project_air(entry_module, documents);
    assert!(
        result.document.is_none(),
        "{entry_module} should not assemble when {:?} is expected",
        expected_code
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == expected_code),
        "{entry_module} should report {:?}; got {:?}",
        expected_code,
        result.diagnostics
    );
}

#[test]
fn rejects_json_without_required_air_document_fields() {
    let error = deserialize_air_from_json("{}").expect_err("empty object is not an AirDocument");

    assert!(error.to_string().contains("air_schema_version"));
}

fn assert_air_references_resolve(document: &AirDocument) {
    use std::collections::{HashMap, HashSet};

    let definition_ids: HashSet<_> = document
        .definitions
        .types
        .iter()
        .map(|definition| definition.id.as_str())
        .chain(
            document
                .definitions
                .memories
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .constants
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .functions
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .tools
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .skills
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .agents
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .strategies
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .triggers
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .collect();
    let graph_ids: HashSet<_> = document
        .execution_graphs
        .iter()
        .map(|graph| graph.id.as_str())
        .collect();
    let trace_ids: HashSet<_> = document
        .trace_points
        .iter()
        .map(|trace_point| trace_point.id.as_str())
        .collect();
    let node_ids_by_graph: HashMap<_, HashSet<_>> = document
        .execution_graphs
        .iter()
        .map(|graph| {
            (
                graph.id.as_str(),
                graph
                    .nodes
                    .iter()
                    .map(|node| node.id.as_str())
                    .collect::<HashSet<_>>(),
            )
        })
        .collect();
    let expression_ids_by_graph: HashMap<_, HashSet<_>> = document
        .execution_graphs
        .iter()
        .map(|graph| {
            (
                graph.id.as_str(),
                graph
                    .expressions
                    .iter()
                    .map(|expression| expression.id.as_str())
                    .collect::<HashSet<_>>(),
            )
        })
        .collect();

    for function in &document.definitions.functions {
        assert!(graph_ids.contains(function.body_graph_ref.as_str()));
    }
    for skill in &document.definitions.skills {
        assert!(graph_ids.contains(skill.flow_graph_ref.as_str()));
        for used in &skill.uses {
            assert!(definition_ids.contains(used.as_str()));
        }
        for scope in &skill.memory_scopes {
            assert!(definition_ids.contains(scope.memory_ref.as_str()));
        }
    }
    for agent in &document.definitions.agents {
        for used in &agent.uses {
            assert!(definition_ids.contains(used.as_str()));
        }
        for rule in &agent.callable_by {
            assert!(definition_ids.contains(rule.caller_ref.as_str()));
            assert!(matches!(rule.caller_kind.as_str(), "strategy" | "agent"));
        }
        for scope in &agent.memory_scopes {
            assert!(definition_ids.contains(scope.memory_ref.as_str()));
        }
    }
    for strategy in &document.definitions.strategies {
        assert!(graph_ids.contains(strategy.flow_graph_ref.as_str()));
        for used in &strategy.uses {
            assert!(definition_ids.contains(used.as_str()));
        }
        for scope in &strategy.memory_scopes {
            assert!(definition_ids.contains(scope.memory_ref.as_str()));
        }
    }
    for tool in &document.definitions.tools {
        for access in &tool.memory_accesses {
            assert!(definition_ids.contains(access.memory_ref.as_str()));
            assert!(matches!(access.access.as_str(), "read" | "write"));
        }
    }
    for trigger in &document.definitions.triggers {
        assert!(definition_ids.contains(trigger.target_ref.as_str()));
        assert_eq!(trigger.target_kind, "strategy");
        assert_eq!(trigger.event.kind, "schedule");
    }

    for graph in &document.execution_graphs {
        assert!(definition_ids.contains(graph.owner_ref.as_str()));
        let node_ids = node_ids_by_graph
            .get(graph.id.as_str())
            .expect("graph should be indexed");
        assert!(node_ids.contains(graph.entry_node_id.as_str()));

        for node in &graph.nodes {
            if matches!(
                node.kind,
                AirFlowNodeKind::CallFunction
                    | AirFlowNodeKind::CallTool
                    | AirFlowNodeKind::CallSkill
                    | AirFlowNodeKind::CallAgent
                    | AirFlowNodeKind::Fallback
            ) {
                assert!(
                    node.target_ref
                        .as_ref()
                        .is_some_and(|target_ref| definition_ids.contains(target_ref.as_str()))
                );
            }
            if matches!(node.kind, AirFlowNodeKind::Branch | AirFlowNodeKind::Loop) {
                assert!(node.condition_ref.is_some());
            }
            let expression_ids = expression_ids_by_graph
                .get(graph.id.as_str())
                .expect("graph expressions should be indexed");
            for argument in &node.arguments {
                assert_expression_handle_resolves(argument, expression_ids);
            }
            for context_ref in &node.context_refs {
                assert_expression_handle_resolves(context_ref, expression_ids);
            }
            if let Some(condition_ref) = &node.condition_ref {
                assert_expression_handle_resolves(condition_ref, expression_ids);
            }
            for trace_point_ref in &node.trace_point_refs {
                assert!(trace_ids.contains(trace_point_ref.as_str()));
            }
        }

        let expression_ids = expression_ids_by_graph
            .get(graph.id.as_str())
            .expect("graph expressions should be indexed");
        for expression in &graph.expressions {
            for operand in &expression.operands {
                assert_expression_handle_resolves(operand, expression_ids);
            }
        }

        for edge in &graph.edges {
            assert!(node_ids.contains(edge.from_node_id.as_str()));
            assert!(node_ids.contains(edge.to_node_id.as_str()));
        }

        let failure_path_ids: HashSet<_> = graph
            .failure_paths
            .iter()
            .map(|failure_path| failure_path.id.as_str())
            .collect();
        for failure_path_ref in &graph.failure_path_refs {
            assert!(failure_path_ids.contains(failure_path_ref.as_str()));
        }
        for failure_path in &graph.failure_paths {
            assert_eq!(failure_path.scope_ref, graph.id);
            assert!(node_ids.contains(failure_path.trigger_node_id.as_str()));
            assert!(node_ids.contains(failure_path.target_node_id.as_str()));
        }
    }

    for trace_point in &document.trace_points {
        assert!(graph_ids.contains(trace_point.owner_ref.as_str()));
        if let Some(node_id) = &trace_point.node_id {
            assert!(
                node_ids_by_graph
                    .get(trace_point.owner_ref.as_str())
                    .is_some_and(|node_ids| node_ids.contains(node_id.as_str()))
            );
        }
    }
}

fn assert_expression_handle_resolves(
    handle: &str,
    expression_ids: &std::collections::HashSet<&str>,
) {
    if let Some(expression_id) = handle.strip_prefix("expr:") {
        assert!(
            expression_ids.contains(expression_id),
            "expression handle `{handle}` should resolve in graph expressions"
        );
    }
}

fn assert_air_ids_are_module_qualified(document: &AirDocument) {
    let module_prefix = format!("{}/", document.module.name);
    let declaration_ids = document
        .definitions
        .types
        .iter()
        .map(|definition| definition.id.as_str())
        .chain(
            document
                .definitions
                .memories
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .constants
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .functions
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .tools
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .skills
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .agents
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .strategies
                .iter()
                .map(|definition| definition.id.as_str()),
        )
        .chain(
            document
                .definitions
                .triggers
                .iter()
                .map(|definition| definition.id.as_str()),
        );

    for id in declaration_ids {
        assert!(
            id.contains(&module_prefix),
            "AIR id `{id}` should include module qualifier `{module_prefix}`"
        );
    }
}
