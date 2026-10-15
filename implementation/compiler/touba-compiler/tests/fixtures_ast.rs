use touba_compiler::ast::{
    AstBinaryOperator, AstDeclaration, AstExpression, AstHumanApprovalMode, AstStatement,
    AstUnaryOperator, AstUserInteractionMode,
};
use touba_compiler::diagnostics::AstDiagnosticCode;
use touba_compiler::parse_source;

#[test]
fn lowers_nominal_record_constructor_to_ast() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/record-construction-v1/positive/tb-record-v1-p01-nominal.tb"
    );
    let result = parse_source("tb-record-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("record fixture should lower to AST");
    let expression = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) => function.body.as_ref(),
            _ => None,
        })
        .and_then(|body| body.statements.first())
        .and_then(|statement| match statement {
            AstStatement::Give(give) => give.expression.as_ref(),
            _ => None,
        })
        .expect("function should give a record");
    let AstExpression::Record {
        type_name, fields, ..
    } = expression
    else {
        panic!("expected record expression");
    };
    assert_eq!(type_name, "ReviewDecision");
    assert_eq!(
        fields
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["risk", "label", "approved"]
    );
}

#[test]
fn lowers_explicit_agent_interface_to_ast() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-interface-p01-strategy-call.tb"
    );
    let result = parse_source("tb-agent-interface-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let agent = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Agent(agent) => Some(agent),
            _ => None,
        })
        .expect("Reviewer agent should exist");
    assert_eq!(agent.signature.inputs.len(), 1);
    assert_eq!(agent.signature.inputs[0].name, "request");
    assert_eq!(agent.signature.inputs[0].type_ref.raw, "ReviewRequest");
    assert_eq!(
        agent
            .signature
            .output
            .as_ref()
            .map(|output| output.raw.as_str()),
        Some("ReviewResult")
    );
}

#[test]
fn lowers_linear_skill_fixture() {
    let source =
        include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb");

    let result = parse_source("tb-v01-001", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    assert_eq!(document.module.name, "examples.linear_skill");
    assert_eq!(document.declarations.len(), 7);
    assert_eq!(document.declarations[0].name(), "SourceRequest");

    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "BuildNote" => Some(skill),
            _ => None,
        })
        .expect("BuildNote skill should exist");

    assert_eq!(skill.uses.len(), 1);
    assert_eq!(skill.uses[0].target, "FetchSource");

    let body = skill.body.as_ref().expect("BuildNote should have a body");
    assert_eq!(body.statements.len(), 2);
    assert!(matches!(body.statements[0], AstStatement::Call(_)));
    assert!(matches!(
        &body.statements[1],
        AstStatement::Give(statement)
            if matches!(
                &statement.expression,
                Some(AstExpression::Record { type_name, .. }) if type_name == "SourceNote"
            )
    ));
}

#[test]
fn lowers_capability_descriptions() {
    let source = "\
module examples.described

tool FetchInbox
    description \"Reads inbox messages for user requested email summaries.\"
    gives Text
    requires network

skill ReadInbox
    description \"Reads the inbox item before producing a summary.\"
    gives Text
    do
        give \"inbox\"

agent Researcher
    description \"Selects declared reading or summarization capabilities for user goals.\"
    responsibility \"Select only declared reading or summarization capabilities for user goals.\"
    uses ReadInbox
    callable_by strategy RunResearch

strategy RunResearch
    description \"Runs one governed research request through Researcher.\"
    uses Researcher
    do
        Researcher
";

    let result = parse_source("described-capabilities", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let tool = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Tool(tool) if tool.name == "FetchInbox" => Some(tool),
            _ => None,
        })
        .expect("FetchInbox tool should exist");
    assert_eq!(
        tool.description.as_deref(),
        Some("Reads inbox messages for user requested email summaries.")
    );
    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "ReadInbox" => Some(skill),
            _ => None,
        })
        .expect("ReadInbox skill should exist");
    assert_eq!(
        skill.description.as_deref(),
        Some("Reads the inbox item before producing a summary.")
    );
    let agent = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Agent(agent) if agent.name == "Researcher" => Some(agent),
            _ => None,
        })
        .expect("Researcher agent should exist");
    assert_eq!(
        agent.description.as_deref(),
        Some("Selects declared reading or summarization capabilities for user goals.")
    );
    assert_eq!(
        agent.responsibility,
        "Select only declared reading or summarization capabilities for user goals."
    );
    let strategy = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Strategy(strategy) if strategy.name == "RunResearch" => Some(strategy),
            _ => None,
        })
        .expect("RunResearch strategy should exist");
    assert_eq!(
        strategy.description.as_deref(),
        Some("Runs one governed research request through Researcher.")
    );
}

#[test]
fn refuses_missing_duplicate_and_empty_agent_responsibility() {
    let cases = [
        (
            "missing-agent-responsibility",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/agent-responsibility-v1/negative/semantic/tb-agent-responsibility-n01-missing.tb"
            ),
            AstDiagnosticCode::MissingAgentResponsibility,
        ),
        (
            "duplicate-agent-responsibility",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/agent-responsibility-v1/negative/semantic/tb-agent-responsibility-n02-duplicate.tb"
            ),
            AstDiagnosticCode::DuplicateAgentResponsibility,
        ),
        (
            "empty-agent-responsibility",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/agent-responsibility-v1/negative/semantic/tb-agent-responsibility-n03-empty.tb"
            ),
            AstDiagnosticCode::InvalidAgentResponsibility,
        ),
    ];

    for (source_id, source, expected_code) in cases {
        let result = parse_source(source_id, source);
        assert!(
            result.document.is_none(),
            "{source_id} must not produce an AST"
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == expected_code),
            "{source_id} must report {expected_code:?}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn lowers_branch_fixture() {
    let source = include_str!("../../../grammar/tree-sitter-touba/examples/tb-v01-003-branch.tb");

    let result = parse_source("tb-v01-003", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "IsAcceptable" => Some(function),
            _ => None,
        })
        .expect("IsAcceptable function should exist");
    assert!(function.body.is_some(), "IsAcceptable should have a body");

    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "ReviewDraft" => Some(skill),
            _ => None,
        })
        .expect("ReviewDraft skill should exist");

    let body = skill.body.as_ref().expect("ReviewDraft should have a body");
    let branch = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::If(branch) => Some(branch),
            _ => None,
        })
        .expect("ReviewDraft should contain an if statement");

    assert_eq!(branch.then_branch.len(), 1);
    assert_eq!(branch.else_branch.len(), 1);
}

#[test]
fn reports_missing_function_body() {
    let source = "\
module missing.function.body

function IsAcceptable
    gives Boolean
";

    let result = parse_source("missing-function-body", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::MissingExecutableBody)
    );
}

#[test]
fn reports_missing_module() {
    let source = "type Draft\n    body is Text\n";

    let result = parse_source("missing-module", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::MissingModule)
    );
}

#[test]
fn rejects_tree_sitter_recovery_nodes_before_ast_lowering() {
    let source = "\
module recovered.syntax

@@@
";

    let result = parse_source("recovered-syntax", source);

    assert!(result.document.is_none());
    let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
        .expect("recovered syntax should produce a parse diagnostic");
    assert!(
        diagnostic.message.contains("ERROR") || diagnostic.message.contains("MISSING"),
        "diagnostic should name Tree-sitter recovery"
    );
}

#[test]
fn rejects_recovered_tree_sitter_nodes_across_syntax_boundaries() {
    for (source_id, source) in [
        (
            "missing-declaration-name",
            "\
module recovered.missing_name

function
",
        ),
        (
            "host-method-expression",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/syntax/tb-expr1-n07-host-method.tb"
            ),
        ),
        (
            "import-wildcard",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/syntax/tb-im1-n09-import-wildcard.tb"
            ),
        ),
        (
            "callable-by-list",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/syntax/tb-a2-auth-n06-list-syntax-rejected.tb"
            ),
        ),
        (
            "invalid-secret-handle",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/negative/syntax/tb-v1-tool-secrets-invalid-handle.tb"
            ),
        ),
        (
            "inline-memory-backend",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/syntax/tb-a2-mem-n10-inline-backend-rejected.tb"
            ),
        ),
    ] {
        let result = parse_source(source_id, source);

        assert!(
            result.document.is_none(),
            "{source_id} should not produce an AST"
        );
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
            .unwrap_or_else(|| panic!("{source_id} should produce a parse diagnostic"));
        assert!(
            diagnostic.message.contains("Tree-sitter")
                && (diagnostic.message.contains("ERROR")
                    || diagnostic.message.contains("MISSING")
                    || diagnostic.message.contains("recovery node")),
            "{source_id} diagnostic should identify Tree-sitter recovery: {}",
            diagnostic.message
        );
        assert!(
            diagnostic.source_ref.is_some(),
            "{source_id} parse diagnostic should keep source location"
        );
    }
}

#[test]
fn accepts_blank_and_comment_lines_inside_indented_block() {
    let source = "\
module indentation.comments

function IsReady
    gives Boolean
    do

        # comment inside the do block
        give true
";

    let result = parse_source("indentation-comments", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("source should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "IsReady" => Some(function),
            _ => None,
        })
        .expect("IsReady function should exist");
    let body = function.body.as_ref().expect("IsReady should have a body");
    assert_eq!(body.statements.len(), 1);
    assert!(matches!(body.statements[0], AstStatement::Give(_)));
}

#[test]
fn lowers_anneau1_call_arguments_and_result_binding() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/anneau-1/positive/tb-a1-p02-tool-result-binding.tb"
    );

    let result = parse_source("tb-a1-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "BuildSource" => Some(skill),
            _ => None,
        })
        .expect("BuildSource skill should exist");
    let body = skill.body.as_ref().expect("BuildSource should have a body");
    let call = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Call(call) if call.target == "FetchSource" => Some(call),
            _ => None,
        })
        .expect("FetchSource call should exist");

    assert_eq!(call.arguments.len(), 1);
    assert_eq!(call.arguments[0].name, "request");
    assert!(matches!(
        &call.arguments[0].value,
        AstExpression::Value { value, .. } if value == "request"
    ));
    assert_eq!(
        call.result_binding
            .as_ref()
            .map(|binding| binding.name.as_str()),
        Some("source")
    );
    assert!(call.arguments[0].source_ref.end_byte > call.arguments[0].source_ref.start_byte);
    assert!(
        call.result_binding
            .as_ref()
            .is_some_and(|binding| binding.source_ref.end_byte > binding.source_ref.start_byte)
    );
}

#[test]
fn lowers_explicit_failure_family() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/failure-flow-v1/positive/tb-failure-v1-p01-handler.tb"
    );
    let result = parse_source("tb-failure-v1-p01", source);
    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "Run" => Some(skill),
            _ => None,
        })
        .expect("Run skill should exist");
    assert_eq!(
        skill
            .failure_handler
            .as_ref()
            .map(|handler| handler.family.as_str()),
        Some("handler")
    );
}

#[test]
fn lowers_user_interaction_show_and_ask() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/user-interaction-v1/positive/tb-user-v1-p01-show-ask.tb"
    );

    let result = parse_source("tb-user-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let strategy = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Strategy(strategy) if strategy.name == "RunInteraction" => {
                Some(strategy)
            }
            _ => None,
        })
        .expect("RunInteraction strategy should exist");
    let body = strategy
        .body
        .as_ref()
        .expect("RunInteraction should have a body");

    let interactions = body
        .statements
        .iter()
        .filter_map(|statement| match statement {
            AstStatement::UserInteraction(interaction) => Some(interaction),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(interactions.len(), 3);
    assert_eq!(interactions[0].target, "show");
    assert_eq!(interactions[0].mode, AstUserInteractionMode::Show);
    assert_eq!(interactions[0].arguments[0].name, "message");
    assert_eq!(interactions[1].target, "ask");
    assert_eq!(interactions[1].mode, AstUserInteractionMode::Ask);
    assert_eq!(interactions[1].arguments[0].name, "prompt");
    assert_eq!(
        interactions[1]
            .result_binding
            .as_ref()
            .map(|binding| binding.name.as_str()),
        Some("query")
    );
}

#[test]
fn reports_duplicate_call_argument_inside_one_call() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/anneau-1/negative/semantic/tb-a1-n04-duplicate-argument.tb"
    );

    let result = parse_source("tb-a1-n04", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::DuplicateCallArgument)
    );
}

#[test]
fn reports_multiple_result_bindings_inside_one_call() {
    let source = "\
module calls.multiple_into

type SourceRequest
    query is Text

type SourceText
    body is Text

tool FetchSource
    takes request as SourceRequest
    gives SourceText

skill BrokenFlow
    takes request as SourceRequest
    gives SourceText
    uses FetchSource
    do
        FetchSource
            with request as request
            into source
            into duplicate
        give source
";

    let result = parse_source("multiple-into", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::MultipleCallResultBindings)
    );
}

#[test]
fn lowers_tool_required_capabilities() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/positive/tb-v1-tool-requires-network.tb"
    );

    let result = parse_source("tb-v1-tool-requires-network", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let tool = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Tool(tool) if tool.name == "FetchSource" => Some(tool),
            _ => None,
        })
        .expect("FetchSource tool should exist");

    assert_eq!(tool.required_capabilities.len(), 2);
    assert_eq!(tool.required_capabilities[0].name, "network");
    assert_eq!(tool.required_capabilities[1].name, "secret_read");
    assert!(
        tool.required_capabilities
            .iter()
            .all(|capability| capability.source_ref.end_byte > capability.source_ref.start_byte)
    );
}

#[test]
fn lowers_tool_required_secrets() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/positive/tb-v1-tool-secrets-env.tb"
    );

    let result = parse_source("tb-v1-tool-secrets-env", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let tool = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Tool(tool) if tool.name == "CallLLM" => Some(tool),
            _ => None,
        })
        .expect("CallLLM tool should exist");

    assert_eq!(tool.required_secrets.len(), 1);
    assert_eq!(tool.required_secrets[0].name, "OPENAI_API_KEY");
    assert!(
        tool.required_secrets
            .iter()
            .all(|secret| secret.source_ref.end_byte > secret.source_ref.start_byte)
    );
}

#[test]
fn lowers_human_approval_statement() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tb-human-v1-p01-required-approval.tb"
    );

    let result = parse_source("tb-human-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "ReviewAndApply" => Some(skill),
            _ => None,
        })
        .expect("ReviewAndApply skill should exist");
    let body = skill.body.as_ref().expect("skill should have a body");
    let approval = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::HumanApproval(approval) => Some(approval),
            _ => None,
        })
        .expect("skill should contain human approval");

    assert_eq!(approval.target, "human.approve");
    assert_eq!(approval.mode, AstHumanApprovalMode::RequiredApproval);
    assert_eq!(approval.arguments.len(), 1);
    assert_eq!(approval.arguments[0].name, "context");
    assert!(matches!(
        &approval.arguments[0].value,
        AstExpression::Value { value, .. } if value == "change"
    ));
    assert_eq!(
        approval
            .result_binding
            .as_ref()
            .map(|binding| binding.name.as_str()),
        Some("approval")
    );
}

#[test]
fn lowers_agent_callable_by_clause() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/positive/tb-a2-auth-p01-strategy-callable-by.tb"
    );

    let result = parse_source("tb-a2-auth-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let agent = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Agent(agent) if agent.name == "Engineer" => Some(agent),
            _ => None,
        })
        .expect("Engineer agent should exist");

    assert_eq!(agent.uses.len(), 1);
    assert_eq!(agent.uses[0].target, "MakeChange");
    assert_eq!(agent.callable_by.len(), 1);
    assert_eq!(agent.callable_by[0].caller_kind, "strategy");
    assert_eq!(agent.callable_by[0].caller, "RunChange");
    assert!(agent.callable_by[0].source_ref.end_byte > agent.callable_by[0].source_ref.start_byte);
}

#[test]
fn lowers_trigger_declaration() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p02-schedule-strategy-with-literal.tb"
    );

    let result = parse_source("tb-a2-trigger-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let trigger = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Trigger(trigger) if trigger.name == "DailyResearch" => Some(trigger),
            _ => None,
        })
        .expect("DailyResearch trigger should exist");

    let event = trigger.event.as_ref().expect("trigger should have event");
    assert_eq!(event.kind, "schedule");
    assert!(matches!(
        event.value.as_ref(),
        Some(AstExpression::StringLiteral { value, .. }) if value == "0 8 * * *"
    ));

    let target = trigger.target.as_ref().expect("trigger should have target");
    assert_eq!(target.kind, "strategy");
    assert_eq!(target.name, "RunResearch");
    assert_eq!(trigger.arguments.len(), 1);
    assert_eq!(trigger.arguments[0].name, "topic");
    assert!(matches!(
        &trigger.arguments[0].value,
        AstExpression::StringLiteral { value, .. } if value == "AI safety"
    ));

    let limits = trigger.limits.as_ref().expect("trigger should have limits");
    assert_eq!(limits.limits.len(), 2);
    assert!(
        limits
            .limits
            .iter()
            .any(|limit| limit.name == "max_runs_per_day"
                && matches!(limit.value, AstExpression::IntLiteral { .. }))
    );
    assert!(trigger.source_ref.end_byte > trigger.source_ref.start_byte);
}

#[test]
fn lowers_request_trigger_event_for_air_validation() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p05-request-strategy-webhook.tb"
    );

    let result = parse_source("tb-a2-trigger-p05", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let trigger = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Trigger(trigger) if trigger.name == "WebhookRun" => Some(trigger),
            _ => None,
        })
        .expect("WebhookRun trigger should exist");
    let event = trigger.event.as_ref().expect("trigger should have event");

    assert_eq!(event.kind, "request");
    assert_eq!(event.detail.as_deref(), Some("POST"));
    assert!(matches!(
        event.value.as_ref(),
        Some(AstExpression::StringLiteral { value, .. }) if value == "/webhook/run"
    ));
}

#[test]
fn lowers_memory_declarations_scopes_and_tool_accesses() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/positive/tb-a2-mem-p01-agent-read-memory.tb"
    );

    let result = parse_source("tb-a2-mem-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let memory = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Memory(memory) if memory.name == "ProjectKnowledge" => Some(memory),
            _ => None,
        })
        .expect("ProjectKnowledge memory should exist");
    assert!(memory.source_ref.end_byte > memory.source_ref.start_byte);

    let tool = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Tool(tool) if tool.name == "ReadProjectKnowledge" => Some(tool),
            _ => None,
        })
        .expect("ReadProjectKnowledge tool should exist");
    assert_eq!(tool.memory_accesses.len(), 1);
    assert_eq!(tool.memory_accesses[0].memory, "ProjectKnowledge");
    assert_eq!(tool.memory_accesses[0].access, "read");
    assert!(
        tool.memory_accesses[0].source_ref.end_byte > tool.memory_accesses[0].source_ref.start_byte
    );

    let agent = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Agent(agent) if agent.name == "Researcher" => Some(agent),
            _ => None,
        })
        .expect("Researcher agent should exist");
    assert_eq!(agent.memory_scopes.len(), 1);
    assert_eq!(agent.memory_scopes[0].memory, "ProjectKnowledge");
    assert_eq!(agent.memory_scopes[0].access, "read");
    assert!(
        agent.memory_scopes[0].source_ref.end_byte > agent.memory_scopes[0].source_ref.start_byte
    );
}

#[test]
fn keeps_invalid_memory_access_for_semantic_diagnostic() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/semantic/tb-a2-mem-n03-invalid-access.tb"
    );

    let result = parse_source("tb-a2-mem-n03", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let tool = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Tool(tool) if tool.name == "AuditProjectKnowledge" => Some(tool),
            _ => None,
        })
        .expect("AuditProjectKnowledge tool should exist");
    assert_eq!(tool.memory_accesses.len(), 1);
    assert_eq!(tool.memory_accesses[0].memory, "ProjectKnowledge");
    assert_eq!(tool.memory_accesses[0].access, "audit");
}

#[test]
fn reports_inline_memory_backend_as_parse_error() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/memory-scopes-anneau-2/negative/syntax/tb-a2-mem-n10-inline-backend-rejected.tb"
    );

    let result = parse_source("tb-a2-mem-n10", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
    );
}

#[test]
fn reports_specific_parse_hint_for_inline_show() {
    let source =
        "module examples.inline_show\n\nstrategy RunInlineShow\n    do\n        show \"test\"\n";

    let result = parse_source("inline-show", source);

    assert!(result.document.is_none());
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == AstDiagnosticCode::ParseError
            && diagnostic.message.contains("`show` is a block interaction")
    }));
}

#[test]
fn keeps_invalid_callable_by_kind_for_semantic_diagnostic() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/semantic/tb-a2-auth-n04-invalid-caller-kind-skill.tb"
    );

    let result = parse_source("tb-a2-auth-n04", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let agent = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Agent(agent) if agent.name == "Engineer" => Some(agent),
            _ => None,
        })
        .expect("Engineer agent should exist");

    assert_eq!(agent.callable_by.len(), 1);
    assert_eq!(agent.callable_by[0].caller_kind, "skill");
    assert_eq!(agent.callable_by[0].caller, "MakeChange");
}

#[test]
fn reports_callable_by_list_syntax_as_parse_error() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/agent-authority-anneau-2/negative/syntax/tb-a2-auth-n06-list-syntax-rejected.tb"
    );

    let result = parse_source("tb-a2-auth-n06", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
    );
}

#[test]
fn reports_invalid_tool_secret_handle_as_parse_error() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/tool-binding-v1/negative/syntax/tb-v1-tool-secrets-invalid-handle.tb"
    );

    let result = parse_source("tb-v1-tool-secrets-invalid-handle", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
    );
}

#[test]
fn reports_inconsistent_indentation_inside_block() {
    let source = "\
module indentation.bad

function Broken
    gives Boolean
    do
        give true
          stop
";

    let result = parse_source("indentation-bad", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::UnsupportedCstNode)
    );
}

#[test]
fn reports_tab_indentation_before_declaration_clause() {
    let source = "module indentation.tabs\n\nfunction Broken\n\tgives Boolean\n";

    let result = parse_source("indentation-tabs", source);

    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError)
    );
}

#[test]
fn lowers_expr1_int_arithmetic_precedence() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p01-int-arithmetic.tb"
    );

    let result = parse_source("tb-expr1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "ComputeTotal" => Some(function),
            _ => None,
        })
        .expect("ComputeTotal function should exist");
    let body = function.body.as_ref().expect("function should have a body");

    let expression = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Give(statement) => statement.expression.as_ref(),
            _ => None,
        })
        .expect("function should give an expression");

    let AstExpression::Binary {
        left,
        operator: AstBinaryOperator::Add,
        right,
        ..
    } = expression
    else {
        panic!("root expression should be addition: {expression:#?}");
    };
    assert!(matches!(
        left.as_ref(),
        AstExpression::Value { value, .. } if value == "count"
    ));
    assert!(matches!(
        right.as_ref(),
        AstExpression::Binary {
            operator: AstBinaryOperator::Multiply,
            ..
        }
    ));
}

#[test]
fn lowers_expr1_float_parentheses_and_literal_kind() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p02-float-average.tb"
    );

    let result = parse_source("tb-expr1-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "AverageScore" => Some(function),
            _ => None,
        })
        .expect("AverageScore function should exist");
    let body = function.body.as_ref().expect("function should have a body");
    let expression = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Give(statement) => statement.expression.as_ref(),
            _ => None,
        })
        .expect("function should give an expression");

    let AstExpression::Binary {
        left,
        operator: AstBinaryOperator::Divide,
        right,
        ..
    } = expression
    else {
        panic!("root expression should be division");
    };
    assert!(matches!(left.as_ref(), AstExpression::Parenthesized { .. }));
    assert!(matches!(
        right.as_ref(),
        AstExpression::FloatLiteral { value, .. } if value == "2.0"
    ));
}

#[test]
fn lowers_expr1_unary_boolean_and_numeric_comparison() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p03-boolean-comparison.tb"
    );

    let result = parse_source("tb-expr1-p03", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "ShouldEscalate" => {
                Some(function)
            }
            _ => None,
        })
        .expect("ShouldEscalate function should exist");
    let body = function.body.as_ref().expect("function should have a body");
    let expression = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Give(statement) => statement.expression.as_ref(),
            _ => None,
        })
        .expect("function should give an expression");

    let AstExpression::Binary {
        left,
        operator: AstBinaryOperator::Or,
        right,
        ..
    } = expression
    else {
        panic!("root expression should be boolean or");
    };
    assert!(matches!(
        left.as_ref(),
        AstExpression::Unary {
            operator: AstUnaryOperator::Not,
            ..
        }
    ));
    assert!(matches!(
        right.as_ref(),
        AstExpression::Binary {
            operator: AstBinaryOperator::LessThan,
            ..
        }
    ));
}

#[test]
fn lowers_expr1_call_argument_expression() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p06-call-argument-expression.tb"
    );

    let result = parse_source("tb-expr1-p06", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let skill = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Skill(skill) if skill.name == "ReviewScore" => Some(skill),
            _ => None,
        })
        .expect("ReviewScore skill should exist");
    let body = skill.body.as_ref().expect("skill should have a body");
    let call = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Call(call) if call.target == "StoreScore" => Some(call),
            _ => None,
        })
        .expect("StoreScore call should exist");

    assert_eq!(call.arguments.len(), 1);
    assert!(matches!(
        &call.arguments[0].value,
        AstExpression::Binary {
            operator: AstBinaryOperator::Add,
            ..
        }
    ));
}

#[test]
fn lowers_expr1_field_access_and_boolean_condition() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/expressions-v1/positive/tb-expr1-p07-conditional-field-score.tb"
    );

    let result = parse_source("tb-expr1-p07", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "IsAcceptedHighScore" => {
                Some(function)
            }
            _ => None,
        })
        .expect("IsAcceptedHighScore function should exist");
    let body = function.body.as_ref().expect("function should have a body");
    let expression = body
        .statements
        .iter()
        .find_map(|statement| match statement {
            AstStatement::Give(statement) => statement.expression.as_ref(),
            _ => None,
        })
        .expect("function should give an expression");

    let AstExpression::Binary {
        left,
        operator: AstBinaryOperator::And,
        right,
        ..
    } = expression
    else {
        panic!("root expression should be boolean and: {expression:#?}");
    };
    assert!(matches!(
        left.as_ref(),
        AstExpression::FieldAccess { field, .. } if field == "accepted"
    ));
    assert!(matches!(
        right.as_ref(),
        AstExpression::Binary {
            operator: AstBinaryOperator::GreaterThanOrEqual,
            ..
        }
    ));
}

#[test]
fn reports_host_expression_forms_as_parse_errors() {
    for (source_id, source) in [
        (
            "tb-expr1-n07",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/syntax/tb-expr1-n07-host-method.tb"
            ),
        ),
        (
            "tb-expr1-n08",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/expressions-v1/negative/syntax/tb-expr1-n08-host-eval.tb"
            ),
        ),
    ] {
        let result = parse_source(source_id, source);

        assert!(result.document.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError),
            "{source_id} should produce a parse error"
        );
    }
}

#[test]
fn lowers_bind_define_v1_to_ast() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p01-local-bind-function.tb"
    );

    let result = parse_source("tb-binddefine-v1-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let function = document
        .declarations
        .iter()
        .find_map(|declaration| match declaration {
            AstDeclaration::Function(function) if function.name == "ReviewScore" => Some(function),
            _ => None,
        })
        .expect("ReviewScore function should exist");
    let body = function.body.as_ref().expect("function should have a body");

    let binds: Vec<_> = body
        .statements
        .iter()
        .filter_map(|statement| match statement {
            AstStatement::Bind(statement) => Some(statement),
            _ => None,
        })
        .collect();

    assert_eq!(binds.len(), 2);
    assert_eq!(binds[0].name, "adjusted");
    assert_eq!(binds[0].type_ref.raw, "Float");
    assert!(matches!(
        &binds[0].value,
        AstExpression::Binary {
            operator: AstBinaryOperator::Divide,
            ..
        }
    ));
}

#[test]
fn lowers_module_define_v1_to_ast() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/bind-define-v1/positive/tb-binddefine-v1-p02-module-define-skill.tb"
    );

    let result = parse_source("tb-binddefine-v1-p02", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");
    let constants: Vec<_> = document
        .declarations
        .iter()
        .filter_map(|declaration| match declaration {
            AstDeclaration::Constant(constant) => Some(constant),
            _ => None,
        })
        .collect();

    assert_eq!(constants.len(), 2);
    assert_eq!(constants[0].name, "DefaultTopic");
    assert_eq!(constants[0].type_ref.raw, "Text");
    assert!(matches!(
        &constants[0].value,
        AstExpression::StringLiteral { value, .. } if value == "transport"
    ));
}

#[test]
fn lowers_imports_im1_to_ast_without_resolution() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/imports-im1/positive/tb-im1-p04-import-combined.tb"
    );

    let result = parse_source("tb-im1-p04", source);

    assert_eq!(result.diagnostics, []);
    let document = result.document.expect("fixture should lower to AST");

    assert_eq!(document.module.name, "examples.search");
    assert_eq!(document.imports.len(), 3);
    assert_eq!(document.imports[0].kind, "type");
    assert_eq!(document.imports[0].name, "SearchRequest");
    assert_eq!(document.imports[0].from_module, "examples.common");
    assert_eq!(document.imports[1].kind, "define");
    assert_eq!(document.imports[1].name, "DefaultRows");
    assert_eq!(document.imports[2].kind, "function");
    assert_eq!(document.imports[2].name, "NormalizeQuery");

    assert!(
        document.imports[0].source_ref.end_byte > document.imports[0].source_ref.start_byte,
        "import should preserve a concrete source ref"
    );
    assert!(
        document
            .declarations
            .iter()
            .any(|declaration| matches!(declaration, AstDeclaration::Function(function) if function.name == "BuildLabel")),
        "local declarations should remain separate from imports"
    );
}

#[test]
fn preserves_effectful_import_kinds_for_air_local() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/imports-im2/tool/positive/tb-im2a-p01-import-tool-air-local.tb"
    );

    let result = parse_source("tb-im2a-p01", source);

    assert_eq!(result.diagnostics, []);
    let document = result
        .document
        .expect("effectful import kind should lower to AST");
    assert_eq!(document.imports.len(), 1);
    assert_eq!(document.imports[0].kind, "tool");
    assert_eq!(document.imports[0].name, "SearchDatasets");
    assert_eq!(document.imports[0].from_module, "examples.data_tools");
}

#[test]
fn reports_import_placement_errors_in_ast() {
    for (source_id, source) in [
        (
            "tb-im1-n18",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/semantic/tb-im1-n18-import-before-module.tb"
            ),
        ),
        (
            "tb-im1-n19",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/semantic/tb-im1-n19-import-after-declaration.tb"
            ),
        ),
    ] {
        let result = parse_source(source_id, source);

        assert!(result.document.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ImportPlacementInvalid),
            "{source_id} should report invalid import placement"
        );
    }
}

#[test]
fn reports_import_syntax_forms_as_parse_errors() {
    for (source_id, source) in [
        (
            "tb-im1-n09",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/syntax/tb-im1-n09-import-wildcard.tb"
            ),
        ),
        (
            "tb-im1-n10",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/syntax/tb-im1-n10-import-alias.tb"
            ),
        ),
        (
            "tb-im1-n11",
            include_str!(
                "../../../grammar/tree-sitter-touba/examples/imports-im1/negative/syntax/tb-im1-n11-reexport-import.tb"
            ),
        ),
    ] {
        let result = parse_source(source_id, source);

        assert!(result.document.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == AstDiagnosticCode::ParseError),
            "{source_id} should produce a parse error"
        );
    }
}
