use std::collections::HashSet;

use tree_sitter::Node;

use crate::ast::*;
use crate::diagnostics::{AstDiagnostic, AstDiagnosticCode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstBuildResult {
    pub document: Option<AstDocument>,
    pub diagnostics: Vec<AstDiagnostic>,
}

impl AstBuildResult {
    pub fn parser_failure(source_id: String) -> Self {
        Self {
            document: None,
            diagnostics: vec![AstDiagnostic::error(
                AstDiagnosticCode::ParseError,
                format!("parser did not produce a CST for source `{source_id}`"),
                None,
            )],
        }
    }
}

pub fn build_ast(source_id: String, source: &str, root: Node<'_>) -> AstBuildResult {
    if let Some(diagnostic) =
        crate::source_validation::validate_source_tree(&source_id, source, root)
    {
        return AstBuildResult {
            document: None,
            diagnostics: vec![diagnostic],
        };
    }
    let mut lowerer = AstLowerer {
        source_id,
        source,
        diagnostics: Vec::new(),
    };

    let document = lowerer.lower_source_file(root);
    let has_errors = lowerer.diagnostics.iter().any(AstDiagnostic::is_error);

    AstBuildResult {
        document: if has_errors { None } else { document },
        diagnostics: lowerer.diagnostics,
    }
}

struct AstLowerer<'a> {
    source_id: String,
    source: &'a str,
    diagnostics: Vec<AstDiagnostic>,
}

impl<'a> AstLowerer<'a> {
    fn lower_source_file(&mut self, root: Node<'_>) -> Option<AstDocument> {
        if root.has_error() {
            self.push_error(
                AstDiagnosticCode::ParseError,
                root,
                parse_error_message(self.source),
            );
            return None;
        }

        let mut module = None;
        let mut imports = Vec::new();
        let mut declarations = Vec::new();
        let mut run_limits = Vec::new();
        let mut saw_run_limits = false;
        let mut saw_non_import_declaration = false;

        for child in named_children(root) {
            match child.kind() {
                "module_declaration" => {
                    if module.is_some() {
                        self.push_error(
                            AstDiagnosticCode::DuplicateModule,
                            child,
                            "Touba accepts a single module declaration",
                        );
                    } else {
                        module = self.lower_module(child);
                    }
                }
                "import_declaration" => {
                    if module.is_none() {
                        self.push_error(
                            AstDiagnosticCode::ImportPlacementInvalid,
                            child,
                            "imports must appear after the module declaration",
                        );
                    }
                    if saw_non_import_declaration || saw_run_limits {
                        self.push_error(
                            AstDiagnosticCode::ImportPlacementInvalid,
                            child,
                            "imports must appear before local declarations",
                        );
                    }
                    if let Some(declaration) = self.lower_import_declaration(child) {
                        imports.extend(declaration);
                    }
                }
                "run_limits_declaration" => {
                    if module.is_none() || saw_non_import_declaration || saw_run_limits {
                        self.push_error(AstDiagnosticCode::InvalidRunLimits, child,
                            "a single limits run block must follow imports and precede declarations");
                    }
                    saw_run_limits = true;
                    for limit in named_children(child) {
                        if limit.kind() != "run_limit_clause" {
                            continue;
                        }
                        let value_node = self.required_field(limit, "value")?;
                        run_limits.push(AstRunLimit {
                            name: self.required_field_text(limit, "name")?,
                            value: self.lower_expression(value_node)?,
                            source_ref: self.source_ref(limit),
                        });
                    }
                    if run_limits.is_empty() {
                        self.push_error(
                            AstDiagnosticCode::InvalidRunLimits,
                            child,
                            "limits run requires at least one limit",
                        );
                    }
                }
                "define_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_constant_declaration(child) {
                        declarations.push(AstDeclaration::Constant(declaration));
                    }
                }
                "memory_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_memory_declaration(child) {
                        declarations.push(AstDeclaration::Memory(declaration));
                    }
                }
                "type_declaration" | "enum_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_type_declaration(child) {
                        declarations.push(AstDeclaration::Type(declaration));
                    }
                }
                "function_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) =
                        self.lower_callable_declaration(child, "function", true)
                    {
                        declarations.push(AstDeclaration::Function(declaration));
                    }
                }
                "tool_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_callable_declaration(child, "tool", false)
                    {
                        declarations.push(AstDeclaration::Tool(declaration));
                    }
                }
                "skill_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_skill_declaration(child) {
                        declarations.push(AstDeclaration::Skill(declaration));
                    }
                }
                "agent_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_agent_declaration(child) {
                        declarations.push(AstDeclaration::Agent(declaration));
                    }
                }
                "strategy_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_strategy_declaration(child) {
                        declarations.push(AstDeclaration::Strategy(declaration));
                    }
                }
                "trigger_declaration" => {
                    saw_non_import_declaration = true;
                    if let Some(declaration) = self.lower_trigger_declaration(child) {
                        declarations.push(AstDeclaration::Trigger(declaration));
                    }
                }
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported top-level CST node `{other}`"),
                ),
            }
        }

        let Some(module) = module else {
            self.diagnostics.push(AstDiagnostic::error(
                AstDiagnosticCode::MissingModule,
                "Touba source requires a module declaration",
                Some(self.source_ref(root)),
            ));
            return None;
        };

        Some(AstDocument {
            module,
            imports,
            run_limits,
            declarations,
        })
    }

    fn lower_module(&mut self, node: Node<'_>) -> Option<AstModule> {
        let name = self.required_field_text(node, "name")?;
        Some(AstModule {
            name,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_import_declaration(&mut self, node: Node<'_>) -> Option<Vec<AstImportDeclaration>> {
        let kind = self.required_field_text(node, "kind")?;
        let from_module = self.required_field_text(node, "from_module")?;
        let mut cursor = node.walk();
        Some(
            node.children_by_field_name("name", &mut cursor)
                .map(|name| AstImportDeclaration {
                    kind: kind.clone(),
                    name: self.text(name),
                    from_module: from_module.clone(),
                    source_ref: self.source_ref(node),
                })
                .collect(),
        )
    }

    fn lower_constant_declaration(&mut self, node: Node<'_>) -> Option<AstConstantDeclaration> {
        let type_node = self.required_field(node, "type")?;
        let value_node = self.required_field(node, "value")?;
        Some(AstConstantDeclaration {
            name: self.required_field_text(node, "name")?,
            type_ref: self.lower_type_ref(type_node)?,
            value: self.lower_expression(value_node)?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_type_declaration(&mut self, node: Node<'_>) -> Option<AstTypeDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let fields = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "field_declaration")
            .filter_map(|child| self.lower_field(child))
            .collect();

        Some(AstTypeDeclaration {
            name,
            fields,
            variants: named_children(node)
                .into_iter()
                .filter(|child| child.kind() == "enum_variant")
                .filter_map(|child| {
                    Some(AstEnumVariant {
                        name: self.required_field_text(child, "name")?,
                        source_ref: self.source_ref(child),
                    })
                })
                .collect(),
            source_ref: self.source_ref(node),
        })
    }

    fn lower_memory_declaration(&mut self, node: Node<'_>) -> Option<AstMemoryDeclaration> {
        Some(AstMemoryDeclaration {
            name: self.required_field_text(node, "name")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_field(&mut self, node: Node<'_>) -> Option<AstField> {
        let type_node = self.required_field(node, "type")?;
        let mut cursor = node.walk();
        let mut constraints = Vec::new();
        for child in node
            .named_children(&mut cursor)
            .filter(|child| child.kind() == "field_constraint")
        {
            let value = self.required_field(child, "value")?;
            constraints.push(AstFieldConstraint {
                kind: self.required_field_text(child, "kind")?,
                value: if value.kind() == "string" {
                    self.lower_text_literal(value)?
                } else {
                    self.text(value)
                },
                upper: child
                    .child_by_field_name("upper")
                    .map(|value| self.text(value)),
                source_ref: self.source_ref(child),
            });
        }
        let default = match node.child_by_field_name("default") {
            Some(value) => Some(self.lower_expression(value)?),
            None => None,
        };
        Some(AstField {
            name: self.required_field_text(node, "name")?,
            type_ref: self.lower_type_ref(type_node)?,
            constraints,
            default,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_callable_declaration(
        &mut self,
        node: Node<'_>,
        declaration_kind: &str,
        requires_body: bool,
    ) -> Option<AstCallableDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let mut description = None;
        let mut signature = AstSignature::default();
        let mut required_capabilities = Vec::new();
        let mut required_secrets = Vec::new();
        let mut approval = None;
        let mut memory_accesses = Vec::new();
        let mut body = None;

        for child in named_children(node) {
            match child.kind() {
                "description_clause" => description = self.lower_description_clause(child),
                "takes_clause" => signature.inputs.extend(self.lower_takes_clause(child)),
                "gives_clause" => signature.output = self.lower_gives_clause(child),
                "requires_clause" => {
                    required_capabilities.extend(self.lower_requires_clause(child));
                }
                "secrets_clause" => {
                    required_secrets.extend(self.lower_secrets_clause(child));
                }
                "human_approval_statement" => {
                    if approval.is_some() {
                        self.push_error(
                            AstDiagnosticCode::UnsupportedCstNode,
                            child,
                            "a tool has one human.approve requirement".to_string(),
                        );
                    } else {
                        approval = self.lower_human_approval_statement(child);
                    }
                }
                "tool_memory_access_clause" => {
                    if let Some(access) = self.lower_memory_access(child) {
                        memory_accesses.push(access);
                    }
                }
                "do_block" => body = self.lower_body(child),
                "symbol_identifier" => {}
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported callable CST node `{other}`"),
                ),
            }
        }

        if requires_body {
            self.require_executable_body(node, declaration_kind, &name, body.as_ref());
        }

        Some(AstCallableDeclaration {
            name,
            description,
            signature,
            required_capabilities,
            required_secrets,
            approval,
            memory_accesses,
            body,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_skill_declaration(&mut self, node: Node<'_>) -> Option<AstSkillDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let mut description = None;
        let mut signature = AstSignature::default();
        let mut uses = Vec::new();
        let mut memory_scopes = Vec::new();
        let mut body = None;
        let mut failure_handler = None;

        for child in named_children(node) {
            match child.kind() {
                "description_clause" => description = self.lower_description_clause(child),
                "takes_clause" => signature.inputs.extend(self.lower_takes_clause(child)),
                "gives_clause" => signature.output = self.lower_gives_clause(child),
                "uses_clause" => {
                    if let Some(usage) = self.lower_use(child) {
                        uses.push(usage);
                    }
                }
                "memory_scope_clause" => {
                    if let Some(scope) = self.lower_memory_scope(child) {
                        memory_scopes.push(scope);
                    }
                }
                "do_block" => body = self.lower_body(child),
                "on_failure_clause" => failure_handler = self.lower_failure_handler(child),
                "symbol_identifier" => {}
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported skill CST node `{other}`"),
                ),
            }
        }

        self.require_executable_body(node, "skill", &name, body.as_ref());

        Some(AstSkillDeclaration {
            name,
            description,
            signature,
            uses,
            memory_scopes,
            body,
            failure_handler,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_agent_declaration(&mut self, node: Node<'_>) -> Option<AstAgentDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let mut description = None;
        let mut signature = AstSignature::default();
        let mut responsibility = None;
        let mut responsibility_clause_seen = false;
        let mut uses = Vec::new();
        let mut callable_by = Vec::new();
        let mut memory_scopes = Vec::new();

        for child in named_children(node) {
            match child.kind() {
                "description_clause" => description = self.lower_description_clause(child),
                "takes_clause" => signature.inputs.extend(self.lower_takes_clause(child)),
                "gives_clause" => signature.output = self.lower_gives_clause(child),
                "responsibility_clause" => {
                    if responsibility_clause_seen {
                        self.push_error(
                            AstDiagnosticCode::DuplicateAgentResponsibility,
                            child,
                            format!("agent `{name}` must declare responsibility exactly once"),
                        );
                    } else {
                        responsibility_clause_seen = true;
                        responsibility = self.lower_agent_responsibility_clause(child, &name);
                    }
                }
                "uses_clause" => {
                    if let Some(usage) = self.lower_use(child) {
                        uses.push(usage);
                    }
                }
                "callable_by_clause" => {
                    if let Some(rule) = self.lower_callable_by(child) {
                        callable_by.push(rule);
                    }
                }
                "memory_scope_clause" => {
                    if let Some(scope) = self.lower_memory_scope(child) {
                        memory_scopes.push(scope);
                    }
                }
                "symbol_identifier" => {}
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported agent CST node `{other}`"),
                ),
            }
        }

        if !responsibility_clause_seen {
            self.push_error(
                AstDiagnosticCode::MissingAgentResponsibility,
                node,
                format!("agent `{name}` must declare a non-empty responsibility"),
            );
        }

        Some(AstAgentDeclaration {
            name,
            description,
            signature,
            responsibility: responsibility.unwrap_or_default(),
            uses,
            callable_by,
            memory_scopes,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_strategy_declaration(&mut self, node: Node<'_>) -> Option<AstStrategyDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let mut description = None;
        let mut signature = AstSignature::default();
        let mut uses = Vec::new();
        let mut memory_scopes = Vec::new();
        let mut body = None;

        for child in named_children(node) {
            match child.kind() {
                "description_clause" => description = self.lower_description_clause(child),
                "takes_clause" => signature.inputs.extend(self.lower_takes_clause(child)),
                "gives_clause" => signature.output = self.lower_gives_clause(child),
                "uses_clause" => {
                    if let Some(usage) = self.lower_use(child) {
                        uses.push(usage);
                    }
                }
                "memory_scope_clause" => {
                    if let Some(scope) = self.lower_memory_scope(child) {
                        memory_scopes.push(scope);
                    }
                }
                "do_block" => body = self.lower_body(child),
                "symbol_identifier" => {}
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported strategy CST node `{other}`"),
                ),
            }
        }

        self.require_executable_body(node, "strategy", &name, body.as_ref());

        Some(AstStrategyDeclaration {
            name,
            description,
            signature,
            uses,
            memory_scopes,
            body,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_trigger_declaration(&mut self, node: Node<'_>) -> Option<AstTriggerDeclaration> {
        let name = self.required_field_text(node, "name")?;
        let mut event = None;
        let mut target = None;
        let mut arguments = Vec::new();
        let mut limits = None;

        for child in named_children(node) {
            match child.kind() {
                "symbol_identifier" => {}
                "trigger_on_clause" => event = self.lower_trigger_on_clause(child),
                "trigger_runs_clause" => target = self.lower_trigger_runs_clause(child),
                "call_argument_clause" => {
                    if let Some(argument) = self.lower_call_argument_clause(child) {
                        arguments.push(argument);
                    }
                }
                "trigger_limits_block" => limits = self.lower_trigger_limits_block(child),
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported trigger CST node `{other}`"),
                ),
            }
        }

        Some(AstTriggerDeclaration {
            name,
            event,
            target,
            arguments,
            limits,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_trigger_on_clause(&mut self, node: Node<'_>) -> Option<AstTriggerEvent> {
        let value = self
            .optional_field(node, "value")
            .and_then(|child| self.lower_expression(child));

        Some(AstTriggerEvent {
            kind: self.required_field_text(node, "kind")?,
            detail: self
                .optional_field(node, "detail")
                .map(|child| self.text(child)),
            value,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_trigger_runs_clause(&mut self, node: Node<'_>) -> Option<AstTriggerTarget> {
        Some(AstTriggerTarget {
            kind: self.required_field_text(node, "target_kind")?,
            name: self.required_field_text(node, "target")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_trigger_limits_block(&mut self, node: Node<'_>) -> Option<AstTriggerLimits> {
        let limits = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "trigger_limit_clause")
            .filter_map(|child| self.lower_trigger_limit_clause(child))
            .collect();

        Some(AstTriggerLimits {
            limits,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_trigger_limit_clause(&mut self, node: Node<'_>) -> Option<AstTriggerLimit> {
        let value_node = self.required_field(node, "value")?;
        Some(AstTriggerLimit {
            name: self.required_field_text(node, "name")?,
            value: self.lower_expression(value_node)?,
            source_ref: self.source_ref(node),
        })
    }

    fn require_executable_body(
        &mut self,
        node: Node<'_>,
        declaration_kind: &str,
        name: &str,
        body: Option<&AstBody>,
    ) {
        if body.is_none() {
            self.push_error(
                AstDiagnosticCode::MissingExecutableBody,
                node,
                format!(
                    "{declaration_kind} `{name}` requires an explicit `do` block in executable Touba"
                ),
            );
        }
    }

    fn lower_takes_clause(&mut self, node: Node<'_>) -> Vec<AstParameter> {
        named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "parameter")
            .filter_map(|child| self.lower_parameter(child))
            .collect()
    }

    fn lower_parameter(&mut self, node: Node<'_>) -> Option<AstParameter> {
        let type_node = self.required_field(node, "type")?;
        Some(AstParameter {
            name: self.required_field_text(node, "name")?,
            type_ref: self.lower_type_ref(type_node)?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_gives_clause(&mut self, node: Node<'_>) -> Option<AstTypeRef> {
        let type_node = self.required_field(node, "type")?;
        self.lower_type_ref(type_node)
    }

    fn lower_description_clause(&mut self, node: Node<'_>) -> Option<String> {
        let value_node = self.required_field(node, "value")?;
        let value = self.lower_text_literal(value_node)?.trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    }

    fn lower_agent_responsibility_clause(
        &mut self,
        node: Node<'_>,
        agent_name: &str,
    ) -> Option<String> {
        let value_node = self.required_field(node, "value")?;
        let value = self.lower_text_literal(value_node)?.trim().to_string();
        if value.is_empty() {
            self.push_error(
                AstDiagnosticCode::InvalidAgentResponsibility,
                node,
                format!("agent `{agent_name}` responsibility must not be empty"),
            );
            None
        } else {
            Some(value)
        }
    }

    fn lower_requires_clause(&mut self, node: Node<'_>) -> Vec<AstCapabilityRequirement> {
        named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "value_identifier")
            .map(|child| AstCapabilityRequirement {
                name: self.text(child),
                source_ref: self.source_ref(child),
            })
            .collect()
    }

    fn lower_secrets_clause(&mut self, node: Node<'_>) -> Vec<AstSecretRequirement> {
        named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "secret_identifier")
            .map(|child| AstSecretRequirement {
                name: self.text(child),
                source_ref: self.source_ref(child),
            })
            .collect()
    }

    fn lower_memory_access(&mut self, node: Node<'_>) -> Option<AstMemoryAccess> {
        Some(AstMemoryAccess {
            memory: self.required_field_text(node, "memory")?,
            access: self.required_field_text(node, "access")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_memory_scope(&mut self, node: Node<'_>) -> Option<AstMemoryScope> {
        Some(AstMemoryScope {
            memory: self.required_field_text(node, "memory")?,
            access: self.required_field_text(node, "access")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_type_ref(&self, node: Node<'_>) -> Option<AstTypeRef> {
        Some(AstTypeRef {
            raw: self.text(node),
            source_ref: self.source_ref(node),
        })
    }

    fn lower_use(&mut self, node: Node<'_>) -> Option<AstUse> {
        Some(AstUse {
            target: self.required_field_text(node, "target")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_callable_by(&mut self, node: Node<'_>) -> Option<AstCallableBy> {
        Some(AstCallableBy {
            caller_kind: self.required_field_text(node, "caller_kind")?,
            caller: self.required_field_text(node, "caller")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_body(&mut self, node: Node<'_>) -> Option<AstBody> {
        let statements = named_children(node)
            .into_iter()
            .filter_map(|child| self.lower_statement(child))
            .collect();

        Some(AstBody {
            statements,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_failure_handler(&mut self, node: Node<'_>) -> Option<AstFailureHandler> {
        let family = self.required_field_text(node, "family")?;
        let steps = named_children(node)
            .into_iter()
            .filter_map(|child| match child.kind() {
                "failure_family" => None,
                "fallback_statement" => Some(AstFailureStep::Fallback {
                    target: self.required_field_text(child, "target")?,
                    source_ref: self.source_ref(child),
                }),
                "stop_statement" => Some(AstFailureStep::Stop {
                    source_ref: self.source_ref(child),
                }),
                other => {
                    self.push_error(
                        AstDiagnosticCode::UnsupportedCstNode,
                        child,
                        format!("unsupported failure CST node `{other}`"),
                    );
                    None
                }
            })
            .collect();

        Some(AstFailureHandler {
            family,
            steps,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_statement(&mut self, node: Node<'_>) -> Option<AstStatement> {
        match node.kind() {
            "bind_statement" => self.lower_bind_statement(node).map(AstStatement::Bind),
            "parallel_statement" => self
                .lower_parallel_statement(node)
                .map(AstStatement::Parallel),
            "call_statement" => self.lower_call_statement(node).map(AstStatement::Call),
            "human_approval_statement" => self
                .lower_human_approval_statement(node)
                .map(AstStatement::HumanApproval),
            "user_interaction_statement" => self
                .lower_user_interaction_statement(node)
                .map(AstStatement::UserInteraction),
            "give_statement" => Some(AstStatement::Give(AstGiveStatement {
                expression: named_children(node)
                    .into_iter()
                    .find(|child| child.kind() == "expression")
                    .and_then(|child| self.lower_expression(child)),
                source_ref: self.source_ref(node),
            })),
            "stop_statement" => Some(AstStatement::Stop(AstStopStatement {
                source_ref: self.source_ref(node),
            })),
            "if_statement" => self.lower_if_statement(node).map(AstStatement::If),
            "match_statement" => self.lower_match_statement(node).map(AstStatement::Match),
            "for_statement" => self.lower_for_statement(node).map(AstStatement::For),
            "while_statement" => self.lower_while_statement(node).map(AstStatement::While),
            other => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported statement CST node `{other}`"),
                );
                None
            }
        }
    }

    fn lower_bind_statement(&mut self, node: Node<'_>) -> Option<AstBindStatement> {
        let type_node = self.required_field(node, "type")?;
        let value_node = self.required_field(node, "value")?;
        Some(AstBindStatement {
            name: self.required_field_text(node, "name")?,
            type_ref: self.lower_type_ref(type_node)?,
            value: self.lower_expression(value_node)?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_match_statement(&mut self, node: Node<'_>) -> Option<AstMatchStatement> {
        let value = self.required_field(node, "value")?;
        let mut cases = Vec::new();
        for child in named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "match_case")
        {
            let body = named_children(child)
                .into_iter()
                .find(|child| child.kind() == "block")?;
            cases.push(AstMatchCase {
                type_name: self.required_field_text(child, "type")?,
                variant: self.required_field_text(child, "variant")?,
                body: self.lower_block_statements(body),
                source_ref: self.source_ref(child),
            });
        }
        Some(AstMatchStatement {
            value: self.lower_expression(value)?,
            cases,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_human_approval_statement(
        &mut self,
        node: Node<'_>,
    ) -> Option<AstHumanApprovalStatement> {
        let target = self.required_field_text(node, "target")?;
        let mode = match target.as_str() {
            "human.approve" => AstHumanApprovalMode::RequiredApproval,
            "human.review" => AstHumanApprovalMode::AgentReview,
            _ => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported human approval target `{target}`"),
                );
                return None;
            }
        };
        let mut arguments = Vec::new();
        let mut seen_arguments = HashSet::new();
        let mut result_binding = None;

        for child in named_children(node) {
            match child.kind() {
                "human_approval_target" => {}
                "approval_expired_clause" => {}
                "approval_rejected_clause" => {}
                "call_argument_clause" => {
                    if let Some(argument) = self.lower_call_argument_clause(child) {
                        if !seen_arguments.insert(argument.name.clone()) {
                            self.push_error(
                                AstDiagnosticCode::DuplicateCallArgument,
                                child,
                                format!(
                                    "human approval argument `{}` is provided more than once",
                                    argument.name
                                ),
                            );
                        }
                        arguments.push(argument);
                    }
                }
                "call_result_binding_clause" => {
                    if let Some(binding) = self.lower_call_result_binding_clause(child) {
                        if result_binding.is_some() {
                            self.push_error(
                                AstDiagnosticCode::MultipleCallResultBindings,
                                child,
                                "human approval accepts at most one `into` binding",
                            );
                        } else {
                            result_binding = Some(binding);
                        }
                    }
                }
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported human approval CST node `{other}`"),
                ),
            }
        }

        let expired_clauses: Vec<_> = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "approval_expired_clause")
            .collect();
        if expired_clauses.len() > 1 {
            self.push_error(
                AstDiagnosticCode::UnsupportedCstNode,
                node,
                "human approval accepts at most one on expired branch",
            );
        }
        let expired_branch = expired_clauses.first().map(|clause| {
            named_children(*clause)
                .into_iter()
                .filter_map(|statement| self.lower_statement(statement))
                .collect()
        });
        let rejected_clauses: Vec<_> = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "approval_rejected_clause")
            .collect();
        if rejected_clauses.len() > 1 {
            self.push_error(
                AstDiagnosticCode::UnsupportedCstNode,
                node,
                "human approval accepts at most one on rejected branch",
            );
        }
        let rejected_branch = rejected_clauses.first().map(|clause| {
            named_children(*clause)
                .into_iter()
                .filter_map(|statement| self.lower_statement(statement))
                .collect()
        });
        Some(AstHumanApprovalStatement {
            target,
            mode,
            arguments,
            result_binding,
            expired_branch,
            rejected_branch,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_user_interaction_statement(
        &mut self,
        node: Node<'_>,
    ) -> Option<AstUserInteractionStatement> {
        let target = self.required_field_text(node, "target")?;
        let mode = match target.as_str() {
            "show" => AstUserInteractionMode::Show,
            "ask" => AstUserInteractionMode::Ask,
            _ => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported user interaction target `{target}`"),
                );
                return None;
            }
        };
        let mut arguments = Vec::new();
        let mut seen_arguments = HashSet::new();
        let mut result_binding = None;

        for child in named_children(node) {
            match child.kind() {
                "user_interaction_target" => {}
                "call_argument_clause" => {
                    if let Some(argument) = self.lower_call_argument_clause(child) {
                        if !seen_arguments.insert(argument.name.clone()) {
                            self.push_error(
                                AstDiagnosticCode::DuplicateCallArgument,
                                child,
                                format!(
                                    "user interaction argument `{}` is provided more than once",
                                    argument.name
                                ),
                            );
                        }
                        arguments.push(argument);
                    }
                }
                "call_result_binding_clause" => {
                    if let Some(binding) = self.lower_call_result_binding_clause(child) {
                        if result_binding.is_some() {
                            self.push_error(
                                AstDiagnosticCode::MultipleCallResultBindings,
                                child,
                                "user interaction accepts at most one `into` binding",
                            );
                        } else {
                            result_binding = Some(binding);
                        }
                    }
                }
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported user interaction CST node `{other}`"),
                ),
            }
        }

        Some(AstUserInteractionStatement {
            target,
            mode,
            arguments,
            result_binding,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_parallel_statement(&mut self, node: Node<'_>) -> Option<AstParallelStatement> {
        let mut arguments = Vec::new();
        let mut result_binding = None;
        let mut each = None;
        let mut concurrency = None;
        let mut items = None;
        let mut seen = HashSet::new();
        for child in named_children(node) {
            let key = match child.kind() {
                "symbol_identifier" => continue,
                "call_argument_clause" => {
                    let argument = self.lower_call_argument_clause(child)?;
                    let key = format!("with:{}", argument.name);
                    arguments.push(argument);
                    key
                }
                "call_result_binding_clause" => {
                    result_binding = self.lower_call_result_binding_clause(child);
                    "into".to_string()
                }
                "parallel_each_clause" => {
                    let collection = self.required_field(child, "collection")?;
                    each = Some((
                        self.required_field_text(child, "item")?,
                        self.lower_expression(collection)?,
                    ));
                    "each".to_string()
                }
                "parallel_limit_clause" => {
                    let name = self.required_field_text(child, "name")?;
                    let value = self
                        .required_field_text(child, "value")?
                        .parse::<u64>()
                        .ok()
                        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991);
                    if value.is_none() {
                        self.push_error(
                            AstDiagnosticCode::UnsupportedCstNode,
                            child,
                            "parallel bounds must be positive safe integers",
                        );
                    }
                    if name == "max_concurrency" {
                        concurrency = value;
                    } else {
                        items = value;
                    }
                    name
                }
                _ => {
                    self.push_error(
                        AstDiagnosticCode::UnsupportedCstNode,
                        child,
                        "unsupported parallel clause",
                    );
                    continue;
                }
            };
            if !seen.insert(key) {
                self.push_error(
                    AstDiagnosticCode::DuplicateCallArgument,
                    child,
                    "duplicate parallel clause",
                );
            }
        }
        let (Some((item, collection)), Some(max_concurrency), Some(max_items), Some(binding)) =
            (each, concurrency, items, result_binding)
        else {
            self.push_error(
                AstDiagnosticCode::UnsupportedCstNode,
                node,
                "parallel requires each, max_concurrency, max_items and into",
            );
            return None;
        };
        if max_concurrency > max_items {
            self.push_error(
                AstDiagnosticCode::UnsupportedCstNode,
                node,
                "max_concurrency cannot exceed max_items",
            );
        }
        Some(AstParallelStatement {
            call: AstCallStatement {
                target: self.required_field_text(node, "target")?,
                arguments,
                result_binding: Some(binding),
                source_ref: self.source_ref(node),
            },
            item,
            collection,
            max_concurrency,
            max_items,
        })
    }

    fn lower_call_statement(&mut self, node: Node<'_>) -> Option<AstCallStatement> {
        let target = self.required_field_text(node, "target")?;
        let mut arguments = Vec::new();
        let mut seen_arguments = HashSet::new();
        let mut result_binding = None;

        for child in named_children(node) {
            match child.kind() {
                "symbol_identifier" => {}
                "call_argument_clause" => {
                    if let Some(argument) = self.lower_call_argument_clause(child) {
                        if !seen_arguments.insert(argument.name.clone()) {
                            self.push_error(
                                AstDiagnosticCode::DuplicateCallArgument,
                                child,
                                format!(
                                    "call argument `{}` is provided more than once",
                                    argument.name
                                ),
                            );
                        }
                        arguments.push(argument);
                    }
                }
                "call_result_binding_clause" => {
                    if let Some(binding) = self.lower_call_result_binding_clause(child) {
                        if result_binding.is_some() {
                            self.push_error(
                                AstDiagnosticCode::MultipleCallResultBindings,
                                child,
                                "call statement accepts at most one `into` binding",
                            );
                        } else {
                            result_binding = Some(binding);
                        }
                    }
                }
                other => self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    child,
                    format!("unsupported call CST node `{other}`"),
                ),
            }
        }

        Some(AstCallStatement {
            target,
            arguments,
            result_binding,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_call_argument_clause(&mut self, node: Node<'_>) -> Option<AstCallArgument> {
        let value_node = self.required_field(node, "value")?;
        Some(AstCallArgument {
            name: self.required_field_text(node, "name")?,
            value: self.lower_expression(value_node)?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_call_result_binding_clause(&mut self, node: Node<'_>) -> Option<AstResultBinding> {
        Some(AstResultBinding {
            name: self.required_field_text(node, "binding")?,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_if_statement(&mut self, node: Node<'_>) -> Option<AstIfStatement> {
        let condition_node = self.required_field(node, "condition")?;
        let (condition, present_binding) = if condition_node.kind() == "present_condition" {
            let value_node = self.required_field(condition_node, "value")?;
            let binding_node = self.required_field(condition_node, "binding")?;
            (
                self.lower_expression(value_node)?,
                Some(AstResultBinding {
                    name: self.text(binding_node),
                    source_ref: self.source_ref(binding_node),
                }),
            )
        } else {
            (self.lower_expression(condition_node)?, None)
        };
        let blocks: Vec<_> = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "block")
            .collect();
        let then_branch = blocks
            .first()
            .map(|block| self.lower_block_statements(*block))
            .unwrap_or_default();
        let else_branch = if let Some(branch) = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "if_statement")
        {
            vec![AstStatement::If(self.lower_if_statement(branch)?)]
        } else {
            blocks
                .get(1)
                .map(|block| self.lower_block_statements(*block))
                .unwrap_or_default()
        };

        Some(AstIfStatement {
            condition,
            present_binding,
            then_branch,
            else_branch,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_for_statement(&mut self, node: Node<'_>) -> Option<AstForStatement> {
        let collection_node = self.required_field(node, "collection")?;
        let collection = self.lower_expression(collection_node)?;
        let body = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "block")
            .map(|block| self.lower_block_statements(block))
            .unwrap_or_default();

        Some(AstForStatement {
            item: self.required_field_text(node, "item")?,
            collection,
            body,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_while_statement(&mut self, node: Node<'_>) -> Option<AstWhileStatement> {
        let condition_node = self.required_field(node, "condition")?;
        let condition = self.lower_expression(condition_node)?;
        let body = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "block")
            .map(|block| self.lower_block_statements(block))
            .unwrap_or_default();

        Some(AstWhileStatement {
            condition,
            body,
            source_ref: self.source_ref(node),
        })
    }

    fn lower_block_statements(&mut self, block: Node<'_>) -> Vec<AstStatement> {
        named_children(block)
            .into_iter()
            .filter_map(|child| self.lower_statement(child))
            .collect()
    }

    fn lower_text_literal(&mut self, node: Node<'_>) -> Option<String> {
        match serde_json::from_str::<String>(&self.text(node)) {
            Ok(value) => Some(value),
            Err(_) => {
                self.push_error(AstDiagnosticCode::InvalidTextLiteral, node,
                    "Text requires valid JSON escapes and no raw control characters; use \\n for a newline and \\\\ for a literal backslash");
                None
            }
        }
    }

    fn lower_interpolated_string(&mut self, node: Node<'_>) -> Option<AstExpression> {
        let mut value = AstExpression::StringLiteral {
            value: String::new(),
            source_ref: self.source_ref(node),
        };
        for child in named_children(node) {
            let part = if child.kind() == "interpolation" {
                let expression = self.required_field(child, "value")?;
                self.lower_expression(expression)?
            } else {
                let raw = self.text(child).replace("{{", "{").replace("}}", "}");
                let decoded = match serde_json::from_str::<String>(&format!("\"{raw}\"")) {
                    Ok(decoded) => decoded,
                    Err(_) => {
                        self.push_error(AstDiagnosticCode::InvalidTextLiteral, child,
                            "interpolated Text requires valid JSON escapes and no raw control characters");
                        return None;
                    }
                };
                AstExpression::StringLiteral {
                    value: decoded,
                    source_ref: self.source_ref(child),
                }
            };
            value = AstExpression::Binary {
                left: Box::new(value),
                operator: AstBinaryOperator::TextConcat,
                right: Box::new(part),
                source_ref: self.source_ref(child),
            };
        }
        Some(value)
    }

    fn lower_expression(&mut self, node: Node<'_>) -> Option<AstExpression> {
        if node.kind() == "expression" {
            let Some(child) = node.named_child(0) else {
                self.push_error(
                    AstDiagnosticCode::MissingRequiredChild,
                    node,
                    "expression requires a named child",
                );
                return None;
            };
            return self.lower_expression(child);
        }

        let source_ref = self.source_ref(node);
        let value = self.text(node);
        match node.kind() {
            "record_copy_expression" => {
                let base_node = self.required_field(node, "base")?;
                let base = self.lower_expression(base_node)?;
                let fields = named_children(node)
                    .into_iter()
                    .filter(|child| child.kind() == "record_field")
                    .map(|child| {
                        let value_node = self.required_field(child, "value")?;
                        Some(AstRecordField {
                            name: self.required_field_text(child, "name")?,
                            value: self.lower_expression(value_node)?,
                            source_ref: self.source_ref(child),
                        })
                    })
                    .collect::<Option<Vec<_>>>()?;
                Some(AstExpression::RecordCopy {
                    base: Box::new(base),
                    fields,
                    source_ref,
                })
            }
            "record_expression" => {
                let type_node = self.required_field(node, "type")?;
                let fields = named_children(node)
                    .into_iter()
                    .filter(|child| child.kind() == "record_field")
                    .filter_map(|field_node| {
                        let name_node = self.required_field(field_node, "name")?;
                        let value_node = self.required_field(field_node, "value")?;
                        Some(AstRecordField {
                            name: self.text(name_node),
                            value: self.lower_expression(value_node)?,
                            source_ref: self.source_ref(field_node),
                        })
                    })
                    .collect();
                Some(AstExpression::Record {
                    type_name: self.text(type_node),
                    fields,
                    source_ref,
                })
            }
            "symbol_identifier" => Some(AstExpression::Symbol { value, source_ref }),
            "value_identifier" => Some(AstExpression::Value { value, source_ref }),
            "string" => Some(AstExpression::StringLiteral {
                value: self.lower_text_literal(node)?,
                source_ref,
            }),
            "interpolated_string" => self.lower_interpolated_string(node),
            "integer" => Some(AstExpression::IntLiteral { value, source_ref }),
            "float" => Some(AstExpression::FloatLiteral { value, source_ref }),
            "boolean" => Some(AstExpression::BooleanLiteral {
                value: value == "true",
                source_ref,
            }),
            "parenthesized_expression" => {
                let value_node = self.required_field(node, "value")?;
                Some(AstExpression::Parenthesized {
                    expression: Box::new(self.lower_expression(value_node)?),
                    source_ref,
                })
            }
            "text_conversion_expression" => {
                let value_node = self.required_field(node, "value")?;
                Some(AstExpression::TextConversion {
                    expression: Box::new(self.lower_expression(value_node)?),
                    source_ref,
                })
            }
            "date_conversion_expression" => {
                let value_node = self.required_field(node, "value")?;
                Some(AstExpression::DateConversion {
                    expression: Box::new(self.lower_expression(value_node)?),
                    source_ref,
                })
            }
            "optional_some_expression" => {
                let value_node = self.required_field(node, "value")?;
                Some(AstExpression::OptionalSome {
                    expression: Box::new(self.lower_expression(value_node)?),
                    source_ref,
                })
            }
            "list_comprehension_expression" => {
                let element = self.required_field(node, "element")?;
                let item = self.required_field(node, "item")?;
                let collection = self.required_field(node, "collection")?;
                let condition = node.child_by_field_name("condition");
                Some(AstExpression::ListComprehension {
                    element: Box::new(self.lower_expression(element)?),
                    item: self.text(item),
                    collection: Box::new(self.lower_expression(collection)?),
                    condition: match condition {
                        Some(child) => Some(Box::new(self.lower_expression(child)?)),
                        None => None,
                    },
                    source_ref,
                })
            }
            "list_sum_expression" | "list_sort_expression" => {
                let field = self.required_field(node, "values")?;
                let values = Box::new(self.lower_expression(field)?);
                Some(if node.kind() == "list_sum_expression" {
                    AstExpression::ListSum { values, source_ref }
                } else {
                    AstExpression::ListSort { values, source_ref }
                })
            }
            "list_concat_expression" => {
                let left = self.required_field(node, "left")?;
                let right = self.required_field(node, "right")?;
                Some(AstExpression::ListConcat {
                    left: Box::new(self.lower_expression(left)?),
                    right: Box::new(self.lower_expression(right)?),
                    source_ref,
                })
            }
            "text_join_expression" => {
                let values = self.required_field(node, "values")?;
                let separator = self.required_field(node, "separator")?;
                Some(AstExpression::TextJoin {
                    values: Box::new(self.lower_expression(values)?),
                    separator: Box::new(self.lower_expression(separator)?),
                    source_ref,
                })
            }
            "list_expression" => {
                let mut cursor = node.walk();
                let elements = node
                    .named_children(&mut cursor)
                    .map(|child| self.lower_expression(child))
                    .collect::<Option<Vec<_>>>()?;
                Some(AstExpression::List {
                    elements,
                    source_ref,
                })
            }
            "optional_none_expression" => {
                let type_node = self.required_field(node, "type")?;
                Some(AstExpression::OptionalNone {
                    type_ref: self.lower_type_ref(type_node)?,
                    source_ref,
                })
            }
            "field_expression" => {
                let target_node = self.required_field(node, "target")?;
                let field_node = self.required_field(node, "field")?;
                Some(AstExpression::FieldAccess {
                    target: Box::new(self.lower_expression(target_node)?),
                    field: self.text(field_node),
                    field_source_ref: self.source_ref(field_node),
                    source_ref,
                })
            }
            "unary_expression" => {
                let operator_node = self.required_field(node, "operator")?;
                let operand_node = self.required_field(node, "operand")?;
                Some(AstExpression::Unary {
                    operator: self.lower_unary_operator(operator_node)?,
                    operand: Box::new(self.lower_expression(operand_node)?),
                    source_ref,
                })
            }
            "or_expression"
            | "and_expression"
            | "comparison_expression"
            | "additive_expression"
            | "multiplicative_expression" => {
                let left_node = self.required_field(node, "left")?;
                let operator_node = self.required_field(node, "operator")?;
                let right_node = self.required_field(node, "right")?;
                Some(AstExpression::Binary {
                    left: Box::new(self.lower_expression(left_node)?),
                    operator: self.lower_binary_operator(operator_node)?,
                    right: Box::new(self.lower_expression(right_node)?),
                    source_ref,
                })
            }
            other => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported expression CST node `{other}`"),
                );
                None
            }
        }
    }

    fn lower_unary_operator(&mut self, node: Node<'_>) -> Option<AstUnaryOperator> {
        let operator = self.text(node);
        match operator.trim() {
            "not" => Some(AstUnaryOperator::Not),
            other => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported unary operator `{other}`"),
                );
                None
            }
        }
    }

    fn lower_binary_operator(&mut self, node: Node<'_>) -> Option<AstBinaryOperator> {
        let operator = self.text(node);
        match operator.trim() {
            "+" => Some(AstBinaryOperator::Add),
            "-" => Some(AstBinaryOperator::Subtract),
            "*" => Some(AstBinaryOperator::Multiply),
            "/" => Some(AstBinaryOperator::Divide),
            "//" => Some(AstBinaryOperator::IntegerDivide),
            "%" => Some(AstBinaryOperator::Modulo),
            "++" => Some(AstBinaryOperator::TextConcat),
            "==" => Some(AstBinaryOperator::Equal),
            "!=" => Some(AstBinaryOperator::NotEqual),
            "<" => Some(AstBinaryOperator::LessThan),
            ">" => Some(AstBinaryOperator::GreaterThan),
            "<=" => Some(AstBinaryOperator::LessThanOrEqual),
            ">=" => Some(AstBinaryOperator::GreaterThanOrEqual),
            "and" => Some(AstBinaryOperator::And),
            "or" => Some(AstBinaryOperator::Or),
            other => {
                self.push_error(
                    AstDiagnosticCode::UnsupportedCstNode,
                    node,
                    format!("unsupported binary operator `{other}`"),
                );
                None
            }
        }
    }

    fn required_field<'b>(&mut self, node: Node<'b>, field: &str) -> Option<Node<'b>> {
        let field_node = node.child_by_field_name(field);
        if field_node.is_none() {
            self.push_error(
                AstDiagnosticCode::MissingRequiredChild,
                node,
                format!("CST node `{}` is missing field `{field}`", node.kind()),
            );
        }
        field_node
    }

    fn optional_field<'b>(&self, node: Node<'b>, field: &str) -> Option<Node<'b>> {
        node.child_by_field_name(field)
    }

    fn required_field_text(&mut self, node: Node<'_>, field: &str) -> Option<String> {
        let field_node = self.required_field(node, field)?;
        Some(self.text(field_node))
    }

    fn text(&self, node: Node<'_>) -> String {
        node.utf8_text(self.source.as_bytes())
            .unwrap_or_default()
            .to_string()
    }

    fn source_ref(&self, node: Node<'_>) -> SourceRef {
        let start = node.start_position();
        let end = node.end_position();
        SourceRef {
            source_id: self.source_id.clone(),
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            start_line: start.row,
            start_column: start.column,
            end_line: end.row,
            end_column: end.column,
        }
    }

    fn push_error(&mut self, code: AstDiagnosticCode, node: Node<'_>, message: impl Into<String>) {
        self.diagnostics.push(AstDiagnostic::error(
            code,
            message,
            Some(self.source_ref(node)),
        ));
    }
}

pub(crate) fn parse_error_message(source: &str) -> String {
    if source
        .lines()
        .any(|line| line.trim_start().starts_with("show \""))
        || source.trim_start().starts_with("show ")
    {
        return "`show` is a block interaction, not an inline print call. Use `show` inside a `strategy` or `skill` `do` block with `with message as \"...\"`; a `.tb` file also requires a `module` declaration.".to_string();
    }

    if source
        .lines()
        .any(|line| line.trim_start().starts_with("ask \""))
        || source.trim_start().starts_with("ask ")
    {
        return "`ask` is a block interaction, not an inline input call. Use `ask` inside a `strategy` or `skill` `do` block with `with prompt as \"...\"` and `into <binding>`; a `.tb` file also requires a `module` declaration.".to_string();
    }

    let mut declaration = "";
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("uses ") && trimmed.contains(',') {
            return "`uses` takes one capability per line. Repeat `uses <Name>` instead of a comma-separated list.".to_string();
        }
        if trimmed == line && !trimmed.is_empty() && !trimmed.starts_with('#') {
            declaration = trimmed.split_whitespace().next().unwrap_or("");
        }
        if declaration == "function" && trimmed.starts_with("uses ") {
            return "`function` is pure and does not accept a `uses` clause. Call pure functions directly in its `do` block; use a `skill` or `strategy` to compose governed capabilities.".to_string();
        }
        if declaration == "strategy" && trimmed.starts_with("on failure") {
            return "`on failure` belongs to a `skill`, not a `strategy`. Put the recoverable operation and its explicit failure-family handler in a skill.".to_string();
        }
        if declaration == "skill" && trimmed.starts_with("callable_by ") {
            return "`callable_by` declares agent invocation authority and belongs to an `agent`, not a `skill`.".to_string();
        }
    }
    "Tree-sitter CST contains a syntax error".to_string()
}

fn named_children<'b>(node: Node<'b>) -> Vec<Node<'b>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|child| child.kind() != "comment")
        .collect()
}
