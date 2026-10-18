use std::collections::{BTreeMap, HashMap, HashSet};

use crate::air::*;
use crate::ast::*;
use crate::declaration_lowering::{lower_memory_declaration, lower_type_declaration};
use crate::diagnostics::{AstDiagnostic, AstDiagnosticCode};
use crate::graph_lowering::{FlowFragment, PendingExit, SequenceFragment, connect_pending_exits};
use crate::parse_source;
use crate::resolution::*;
use crate::typecheck::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AirBuildResult {
    pub document: Option<AirDocument>,
    pub diagnostics: Vec<AirDiagnostic>,
}

pub fn compile_source_to_air(source_id: impl Into<String>, source: &str) -> AirBuildResult {
    let ast_result = parse_source(source_id, source);
    let ast_diagnostics = ast_result.diagnostics;
    let Some(document) = ast_result.document else {
        return AirBuildResult {
            document: None,
            diagnostics: ast_diagnostics
                .into_iter()
                .map(map_ast_diagnostic)
                .collect(),
        };
    };

    let mut result = build_air(&document);
    result
        .diagnostics
        .extend(ast_diagnostics.into_iter().map(map_ast_diagnostic));
    if result.diagnostics.is_empty() {
        result
    } else {
        AirBuildResult {
            document: None,
            diagnostics: result.diagnostics,
        }
    }
}

pub fn build_air(document: &AstDocument) -> AirBuildResult {
    let mut lowerer = AirLowerer::new(document);
    // An isolated AST cannot supply the contracts of imported modules. The
    // project/module APIs require those sources explicitly before lowering.
    if !document.imports.is_empty() {
        lowerer.resolve_import_contracts(document, &[]);
        return AirBuildResult {
            document: None,
            diagnostics: lowerer.diagnostics,
        };
    }
    lowerer.lower_document(document)
}

/// Compile an explicitly supplied set of source modules, resolving contracts
/// before lowering expressions. Filesystem discovery belongs to the host.
pub fn compile_project_sources(entry_source: &str, sources: &[(String, String)]) -> AirBuildResult {
    compile_sources(entry_source, sources, true)
}

/// Produce a typed module for project linking, after checking the complete
/// source context. This is not an unchecked single-source compilation path.
pub fn compile_module_sources(entry_source: &str, sources: &[(String, String)]) -> AirBuildResult {
    compile_sources(entry_source, sources, false)
}

fn compile_sources(entry_source: &str, sources: &[(String, String)], link: bool) -> AirBuildResult {
    let mut documents = Vec::new();
    let mut diagnostics = Vec::new();
    let mut entry_module = None;
    let mut names = HashSet::new();
    for (source_id, source) in sources {
        let parsed = parse_source(source_id.clone(), source);
        diagnostics.extend(parsed.diagnostics.into_iter().map(map_ast_diagnostic));
        if let Some(document) = parsed.document {
            if source_id == entry_source {
                entry_module = Some(document.module.name.clone());
            }
            if !names.insert(document.module.name.clone()) {
                diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateProjectModule,
                    format!("duplicate source module `{}`", document.module.name),
                    Some(document.module.source_ref.clone()),
                ));
            }
            documents.push(document);
        }
    }
    if !diagnostics.is_empty() {
        return AirBuildResult {
            document: None,
            diagnostics,
        };
    }
    let Some(entry_module) = entry_module else {
        return AirBuildResult {
            document: None,
            diagnostics: vec![AirDiagnostic::new(
                AirDiagnosticCode::ProjectEntryModuleNotFound,
                "entry source is absent from explicit project inputs",
                None,
            )],
        };
    };
    let contexts: Vec<_> = documents.iter().map(AirLowerer::new).collect();
    let mut modules = Vec::new();
    for document in &documents {
        let mut lowerer = AirLowerer::new(document);
        lowerer.resolve_import_contracts(document, &contexts);
        // A missing contract is the primary cause, not an unknown operand type.
        if !lowerer.diagnostics.is_empty() {
            diagnostics.extend(lowerer.diagnostics);
            continue;
        }
        let result = lowerer.lower_document(document);
        diagnostics.extend(result.diagnostics);
        if let Some(module) = result.document {
            modules.push(module);
        }
    }
    if !diagnostics.is_empty() {
        return AirBuildResult {
            document: None,
            diagnostics,
        };
    }
    let result = crate::assemble_project_air(&entry_module, &modules);
    let document = if result.document.is_some() && !link {
        modules
            .into_iter()
            .find(|module| module.module.name == entry_module)
    } else {
        result.document
    };
    AirBuildResult {
        document,
        diagnostics: result.diagnostics,
    }
}

fn map_ast_diagnostic(diagnostic: AstDiagnostic) -> AirDiagnostic {
    let code = match diagnostic.code {
        AstDiagnosticCode::DuplicateCallArgument => AirDiagnosticCode::DuplicateCallArgument,
        AstDiagnosticCode::InvalidTextLiteral => AirDiagnosticCode::InvalidTextLiteral,
        AstDiagnosticCode::InvalidRunLimits => AirDiagnosticCode::InvalidRunLimits,
        _ => AirDiagnosticCode::AstError,
    };
    AirDiagnostic::new(code, diagnostic.message, diagnostic.source_ref)
}

struct AirLowerer {
    module_name: String,
    symbols: HashMap<String, SymbolRef>,
    type_fields: HashMap<String, HashMap<String, TypeFieldRef>>,
    type_variants: HashMap<String, HashSet<String>>,
    agent_authority: HashMap<String, Vec<AirCallableBy>>,
    tool_memory_accesses: HashMap<String, Vec<AirMemoryAccess>>,
    effectful_symbols: HashSet<String>,
    diagnostics: Vec<AirDiagnostic>,
}

impl AirLowerer {
    fn resolve_import_contracts(&mut self, document: &AstDocument, contexts: &[AirLowerer]) {
        for context in contexts {
            self.type_fields.extend(context.type_fields.clone());
            self.type_variants.extend(context.type_variants.clone());
            self.agent_authority.extend(context.agent_authority.clone());
            self.tool_memory_accesses
                .extend(context.tool_memory_accesses.clone());
        }
        for import in &document.imports {
            let Some(context) = contexts
                .iter()
                .find(|c| c.module_name == import.from_module)
            else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportModuleNotFound,
                    format!(
                        "import `{}` references missing module `{}`. If it belongs to a package copied into packages/, validate and register it with touba package add <organization.name>; copying alone does not activate imports.",
                        import.name, import.from_module
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            };
            let Some(contract) = context.symbols.get(&import.name).filter(|s| !s.imported) else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportDeclarationNotFound,
                    format!(
                        "module `{}` does not declare `{}`",
                        import.from_module, import.name
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            };
            let Some(imported) = self.symbols.get_mut(&import.name).filter(|s| s.imported) else {
                continue; // Local collisions are diagnosed by lower_imports.
            };
            if imported.kind != contract.kind {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportKindMismatch,
                    format!(
                        "import `{}` requests a different declaration kind",
                        import.name
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            }
            imported.signature_inputs = contract.signature_inputs.clone();
            imported.output_type = contract.output_type.clone();
            imported.contract_resolved = true;
        }
    }

    fn new(document: &AstDocument) -> Self {
        let mut lowerer = Self {
            module_name: document.module.name.clone(),
            symbols: HashMap::new(),
            type_fields: HashMap::new(),
            type_variants: HashMap::new(),
            agent_authority: HashMap::new(),
            tool_memory_accesses: HashMap::new(),
            effectful_symbols: HashSet::new(),
            diagnostics: Vec::new(),
        };
        lowerer.register_symbols(document);
        lowerer.register_import_symbols(document);
        lowerer.register_symbol_signatures(document);
        lowerer.register_type_fields(document);
        lowerer.register_agent_authority(document);
        lowerer.register_tool_memory_accesses(document);
        lowerer.effectful_symbols = lowerer.compute_effectful_symbols(document);
        lowerer
    }

    fn lower_document(&mut self, document: &AstDocument) -> AirBuildResult {
        let module = AirModule {
            id: module_id(&self.module_name),
            name: document.module.name.clone(),
            source_ref: document.module.source_ref.clone(),
        };

        let mut definitions = AirDefinitions::default();
        let mut execution_graphs = Vec::new();
        let mut trace_points = Vec::new();
        let imports = self.lower_imports(&document.imports);
        let budgets = self.lower_run_limits(&document.run_limits);

        for declaration in &document.declarations {
            match declaration {
                AstDeclaration::Constant(declaration) => {
                    if let Some(constant) = self.lower_constant(declaration) {
                        definitions.constants.push(constant);
                    }
                }
                AstDeclaration::Memory(declaration) => {
                    definitions.memories.push(self.lower_memory(declaration));
                }
                AstDeclaration::Type(declaration) => {
                    definitions.types.push(self.lower_type(declaration));
                }
                AstDeclaration::Function(declaration) => {
                    if let Some((function, graph, graph_trace_points)) =
                        self.lower_function(declaration)
                    {
                        definitions.functions.push(function);
                        trace_points.extend(graph_trace_points);
                        execution_graphs.push(graph);
                    }
                }
                AstDeclaration::Tool(declaration) => {
                    if let Some(tool) = self.lower_tool(declaration) {
                        definitions.tools.push(tool);
                    }
                }
                AstDeclaration::Skill(declaration) => {
                    if let Some((skill, graph, graph_trace_points)) = self.lower_skill(declaration)
                    {
                        definitions.skills.push(skill);
                        trace_points.extend(graph_trace_points);
                        execution_graphs.push(graph);
                    }
                }
                AstDeclaration::Agent(declaration) => {
                    definitions.agents.push(self.lower_agent(declaration));
                }
                AstDeclaration::Strategy(declaration) => {
                    if let Some((strategy, graph, graph_trace_points)) =
                        self.lower_strategy(declaration)
                    {
                        definitions.strategies.push(strategy);
                        trace_points.extend(graph_trace_points);
                        execution_graphs.push(graph);
                    }
                }
                AstDeclaration::Trigger(declaration) => {
                    if let Some(trigger) = self.lower_trigger(declaration) {
                        definitions.triggers.push(trigger);
                    }
                }
            }
        }

        let has_errors = !self.diagnostics.is_empty();
        AirBuildResult {
            document: if has_errors {
                None
            } else {
                Some(AirDocument {
                    air_schema_version: AIR_SCHEMA_VERSION.to_string(),
                    air_capability_profile: AIR_CAPABILITY_PROFILE.to_string(),
                    air_json_profile: AIR_JSON_PROFILE.to_string(),
                    module,
                    imports,
                    budgets,
                    definitions,
                    execution_graphs,
                    trace_points,
                })
            },
            diagnostics: self.diagnostics.clone(),
        }
    }

    fn lower_run_limits(&mut self, limits: &[AstRunLimit]) -> Option<AirBudgets> {
        let mut run = BTreeMap::new();
        let mut seen = HashSet::new();
        for limit in limits {
            let allowed = matches!(
                limit.name.as_str(),
                "max_run_ms"
                    | "max_steps"
                    | "max_tool_calls"
                    | "max_agent_invocations"
                    | "max_provider_calls"
            );
            let value = match &limit.value {
                AstExpression::IntLiteral { value, .. } => value
                    .parse::<u64>()
                    .ok()
                    .filter(|value| (1..=9_007_199_254_740_991).contains(value)),
                _ => None,
            };
            if !allowed || !seen.insert(limit.name.clone()) || value.is_none() {
                self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::InvalidRunLimits,
                    format!("run limit `{}` must be a unique supported kind with an Int literal in 1..=9007199254740991", limit.name),
                    Some(limit.source_ref.clone())));
                continue;
            }
            run.insert(
                limit.name.clone(),
                AirRunLimit {
                    value: value.unwrap(),
                    source_ref: limit.source_ref.clone(),
                },
            );
        }
        if run.is_empty() {
            None
        } else {
            Some(AirBudgets { run })
        }
    }

    fn lower_imports(&mut self, imports: &[AstImportDeclaration]) -> Vec<AirImport> {
        let mut lowered = Vec::new();
        let mut seen_names = HashSet::new();

        for import in imports {
            let Some(target_ref) = self.import_target_ref(import) else {
                continue;
            };

            if self
                .symbols
                .get(&import.name)
                .is_some_and(|symbol| !symbol.imported)
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportNameCollision,
                    format!(
                        "import `{}` collides with a local declaration of the same name",
                        import.name
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            }

            if !seen_names.insert(import.name.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateImport,
                    format!("duplicate import name `{}`", import.name),
                    Some(import.source_ref.clone()),
                ));
                continue;
            }

            lowered.push(AirImport {
                kind: import.kind.clone(),
                name: import.name.clone(),
                from_module: import.from_module.clone(),
                target_ref,
                source_ref: import.source_ref.clone(),
            });
        }

        lowered
    }

    fn import_target_ref(&mut self, import: &AstImportDeclaration) -> Option<String> {
        match import.kind.as_str() {
            "type" => Some(type_id(&import.from_module, &import.name)),
            "define" => Some(constant_id(&import.from_module, &import.name)),
            "function" => Some(function_id(&import.from_module, &import.name)),
            "tool" => Some(tool_id(&import.from_module, &import.name)),
            "skill" => Some(skill_id(&import.from_module, &import.name)),
            "agent" => Some(agent_id(&import.from_module, &import.name)),
            "strategy" => Some(strategy_id(&import.from_module, &import.name)),
            "memory" => Some(memory_id(&import.from_module, &import.name)),
            other => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportKindUnsupported,
                    format!(
                        "import kind `{other}` is outside the supported import kinds; expected `type`, `define`, `function`, `tool`, `skill`, `agent`, `strategy` or `memory`"
                    ),
                    Some(import.source_ref.clone()),
                ));
                None
            }
        }
    }

    fn register_symbols(&mut self, document: &AstDocument) {
        for declaration in &document.declarations {
            let symbol = match declaration {
                AstDeclaration::Constant(declaration) => SymbolRef::new(
                    constant_id(&self.module_name, &declaration.name),
                    SymbolKind::Constant,
                ),
                AstDeclaration::Memory(declaration) => SymbolRef::new(
                    memory_id(&self.module_name, &declaration.name),
                    SymbolKind::Memory,
                ),
                AstDeclaration::Type(declaration) => SymbolRef::new(
                    type_id(&self.module_name, &declaration.name),
                    SymbolKind::Type,
                ),
                AstDeclaration::Function(declaration) => SymbolRef::new(
                    function_id(&self.module_name, &declaration.name),
                    SymbolKind::Function,
                ),
                AstDeclaration::Tool(declaration) => SymbolRef::new(
                    tool_id(&self.module_name, &declaration.name),
                    SymbolKind::Tool,
                ),
                AstDeclaration::Skill(declaration) => SymbolRef::new(
                    skill_id(&self.module_name, &declaration.name),
                    SymbolKind::Skill,
                ),
                AstDeclaration::Agent(declaration) => SymbolRef::new(
                    agent_id(&self.module_name, &declaration.name),
                    SymbolKind::Agent,
                ),
                AstDeclaration::Strategy(declaration) => SymbolRef::new(
                    strategy_id(&self.module_name, &declaration.name),
                    SymbolKind::Strategy,
                ),
                AstDeclaration::Trigger(declaration) => SymbolRef::new(
                    trigger_id(&self.module_name, &declaration.name),
                    SymbolKind::Trigger,
                ),
            };

            if let Some(previous) = self.symbols.insert(declaration.name().to_string(), symbol) {
                let code = if matches!(declaration, AstDeclaration::Memory(_))
                    && previous.kind == SymbolKind::Memory
                {
                    AirDiagnosticCode::DuplicateMemoryDeclaration
                } else {
                    AirDiagnosticCode::DuplicateDefinition
                };
                self.diagnostics.push(AirDiagnostic::new(
                    code,
                    format!("duplicate Touba declaration `{}`", declaration.name()),
                    Some(declaration.source_ref().clone()),
                ));
            }
        }
    }

    fn register_import_symbols(&mut self, document: &AstDocument) {
        let mut seen_names = HashSet::new();

        for import in &document.imports {
            if !seen_names.insert(import.name.clone()) {
                continue;
            }
            if self
                .symbols
                .get(&import.name)
                .is_some_and(|symbol| !symbol.imported)
            {
                continue;
            }
            let Some(symbol) = self.import_symbol(import) else {
                continue;
            };
            self.symbols.insert(import.name.clone(), symbol);
        }
    }

    fn import_symbol(&self, import: &AstImportDeclaration) -> Option<SymbolRef> {
        match import.kind.as_str() {
            "type" => Some(SymbolRef::imported(
                type_id(&import.from_module, &import.name),
                SymbolKind::Type,
            )),
            "define" => Some(SymbolRef::imported(
                constant_id(&import.from_module, &import.name),
                SymbolKind::Constant,
            )),
            "function" => Some(SymbolRef::imported(
                function_id(&import.from_module, &import.name),
                SymbolKind::Function,
            )),
            "tool" => Some(SymbolRef::imported(
                tool_id(&import.from_module, &import.name),
                SymbolKind::Tool,
            )),
            "skill" => Some(SymbolRef::imported(
                skill_id(&import.from_module, &import.name),
                SymbolKind::Skill,
            )),
            "agent" => Some(SymbolRef::imported(
                agent_id(&import.from_module, &import.name),
                SymbolKind::Agent,
            )),
            "strategy" => Some(SymbolRef::imported(
                strategy_id(&import.from_module, &import.name),
                SymbolKind::Strategy,
            )),
            "memory" => Some(SymbolRef::imported(
                memory_id(&import.from_module, &import.name),
                SymbolKind::Memory,
            )),
            _ => None,
        }
    }

    fn register_symbol_signatures(&mut self, document: &AstDocument) {
        for declaration in &document.declarations {
            let signature = match declaration {
                AstDeclaration::Function(declaration) | AstDeclaration::Tool(declaration) => {
                    Some(&declaration.signature)
                }
                AstDeclaration::Skill(declaration) => Some(&declaration.signature),
                AstDeclaration::Agent(declaration) => Some(&declaration.signature),
                AstDeclaration::Strategy(declaration) => Some(&declaration.signature),
                AstDeclaration::Constant(_)
                | AstDeclaration::Memory(_)
                | AstDeclaration::Type(_)
                | AstDeclaration::Trigger(_) => None,
            };
            if let AstDeclaration::Constant(declaration) = declaration {
                let output_type = self.lower_type_ref_raw_silent(&declaration.type_ref.raw);
                if let Some(symbol) = self.symbols.get_mut(&declaration.name) {
                    symbol.output_type = output_type;
                }
            }
            let Some(signature) = signature else {
                continue;
            };
            let inputs = signature
                .inputs
                .iter()
                .map(|input| SymbolInputRef {
                    name: input.name.clone(),
                    type_ref: self.lower_type_ref_raw_silent(&input.type_ref.raw),
                })
                .collect();
            let output_type = signature
                .output
                .as_ref()
                .and_then(|type_ref| self.lower_type_ref_raw_silent(&type_ref.raw));
            if let Some(symbol) = self.symbols.get_mut(declaration.name()) {
                symbol.signature_inputs = inputs;
                symbol.output_type = output_type;
            }
        }
    }

    fn register_type_fields(&mut self, document: &AstDocument) {
        for declaration in &document.declarations {
            let AstDeclaration::Type(declaration) = declaration else {
                continue;
            };
            if !declaration.variants.is_empty() {
                let mut variants = HashSet::new();
                for variant in &declaration.variants {
                    if !variants.insert(variant.name.clone()) {
                        self.diagnostics.push(AirDiagnostic::new(
                            AirDiagnosticCode::DuplicateEnumVariant,
                            format!("duplicate enum member `{}`", variant.name),
                            Some(variant.source_ref.clone()),
                        ));
                    }
                }
                self.type_variants
                    .insert(type_id(&self.module_name, &declaration.name), variants);
                continue;
            }
            let fields = declaration
                .fields
                .iter()
                .map(|field| {
                    (
                        field.name.clone(),
                        TypeFieldRef {
                            type_ref: self.lower_type_ref_raw_silent(&field.type_ref.raw),
                            source_ref: field.source_ref.clone(),
                        },
                    )
                })
                .collect();
            self.type_fields
                .insert(type_id(&self.module_name, &declaration.name), fields);
        }
    }

    fn register_agent_authority(&mut self, document: &AstDocument) {
        for declaration in &document.declarations {
            let AstDeclaration::Agent(declaration) = declaration else {
                continue;
            };
            let id = agent_id(&self.module_name, &declaration.name);
            let callable_by = self.lower_callable_by_rules(declaration);
            self.agent_authority.insert(id, callable_by);
        }
    }

    fn register_tool_memory_accesses(&mut self, document: &AstDocument) {
        for declaration in &document.declarations {
            let AstDeclaration::Tool(declaration) = declaration else {
                continue;
            };
            let id = tool_id(&self.module_name, &declaration.name);
            let accesses = self.lower_tool_memory_accesses(declaration);
            self.tool_memory_accesses.insert(id, accesses);
        }
    }

    fn compute_effectful_symbols(&self, document: &AstDocument) -> HashSet<String> {
        let mut effectful = HashSet::new();
        for symbol in self.symbols.values() {
            if symbol.kind == SymbolKind::Tool
                || symbol.kind == SymbolKind::Agent
                || (symbol.imported
                    && matches!(symbol.kind, SymbolKind::Skill | SymbolKind::Strategy))
            {
                effectful.insert(symbol.id.clone());
            }
        }

        loop {
            let mut changed = false;
            for declaration in &document.declarations {
                let Some((symbol_id, body)) = self.declaration_body_ref(declaration) else {
                    continue;
                };
                if effectful.contains(&symbol_id) {
                    continue;
                }
                if self.body_contains_effectful_call(body, &effectful) {
                    changed |= effectful.insert(symbol_id);
                }
            }
            if !changed {
                return effectful;
            }
        }
    }

    fn declaration_body_ref<'b>(
        &self,
        declaration: &'b AstDeclaration,
    ) -> Option<(String, &'b AstBody)> {
        match declaration {
            AstDeclaration::Function(declaration) => declaration
                .body
                .as_ref()
                .map(|body| (function_id(&self.module_name, &declaration.name), body)),
            AstDeclaration::Skill(declaration) => declaration
                .body
                .as_ref()
                .map(|body| (skill_id(&self.module_name, &declaration.name), body)),
            AstDeclaration::Strategy(declaration) => declaration
                .body
                .as_ref()
                .map(|body| (strategy_id(&self.module_name, &declaration.name), body)),
            AstDeclaration::Constant(_)
            | AstDeclaration::Memory(_)
            | AstDeclaration::Type(_)
            | AstDeclaration::Tool(_)
            | AstDeclaration::Agent(_)
            | AstDeclaration::Trigger(_) => None,
        }
    }

    fn body_contains_effectful_call(&self, body: &AstBody, effectful: &HashSet<String>) -> bool {
        self.statements_contain_effectful_call(&body.statements, effectful)
    }

    fn statements_contain_effectful_call(
        &self,
        statements: &[AstStatement],
        effectful: &HashSet<String>,
    ) -> bool {
        statements
            .iter()
            .any(|statement| self.statement_contains_effectful_call(statement, effectful))
    }

    fn statement_contains_effectful_call(
        &self,
        statement: &AstStatement,
        effectful: &HashSet<String>,
    ) -> bool {
        match statement {
            AstStatement::Parallel(parallel) => self
                .symbols
                .get(&parallel.call.target)
                .is_some_and(|symbol| effectful.contains(&symbol.id)),
            AstStatement::Call(call) => self
                .symbols
                .get(&call.target)
                .is_some_and(|symbol| effectful.contains(&symbol.id)),
            AstStatement::If(statement) => {
                self.statements_contain_effectful_call(&statement.then_branch, effectful)
                    || self.statements_contain_effectful_call(&statement.else_branch, effectful)
            }
            AstStatement::Match(statement) => statement.cases.iter().any(|case| {
                self.statements_contain_effectful_call(&case.body, effectful)
            }),
            AstStatement::For(statement) => {
                self.statements_contain_effectful_call(&statement.body, effectful)
            }
            AstStatement::While(statement) => {
                self.statements_contain_effectful_call(&statement.body, effectful)
            }
            AstStatement::HumanApproval(statement) => statement.expired_branch.as_ref()
                .is_some_and(|body| self.statements_contain_effectful_call(body, effectful)),
            AstStatement::Bind(_)
            | AstStatement::UserInteraction(_)
            | AstStatement::Give(_)
            | AstStatement::Stop(_) => false,
        }
    }

    fn lower_callable_by_rules(&mut self, declaration: &AstAgentDeclaration) -> Vec<AirCallableBy> {
        let mut lowered = Vec::new();
        let mut seen = HashSet::new();

        for rule in &declaration.callable_by {
            let expected_kind = match rule.caller_kind.as_str() {
                "strategy" => SymbolKind::Strategy,
                "agent" => SymbolKind::Agent,
                _ => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::InvalidCallableByCallerKind,
                        format!(
                            "`callable_by` caller kind `{}` is not allowed; expected `strategy` or `agent`",
                            rule.caller_kind
                        ),
                        Some(rule.source_ref.clone()),
                    ));
                    continue;
                }
            };

            if let Some(caller_ref) = inter_module_caller_ref(&rule.caller_kind, &rule.caller) {
                if !seen.insert(caller_ref.clone()) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::DuplicateCallableByRule,
                        format!(
                            "`{}` is declared more than once in `callable_by` for agent `{}`",
                            rule.caller, declaration.name
                        ),
                        Some(rule.source_ref.clone()),
                    ));
                    continue;
                }
                lowered.push(AirCallableBy {
                    caller_ref,
                    caller_kind: rule.caller_kind.clone(),
                    source_ref: rule.source_ref.clone(),
                });
                continue;
            }

            let Some(symbol) = self.symbols.get(&rule.caller) else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownCallableByCaller,
                    format!(
                        "`callable_by {}` references unknown caller `{}`",
                        rule.caller_kind, rule.caller
                    ),
                    Some(rule.source_ref.clone()),
                ));
                continue;
            };

            if symbol.kind != expected_kind {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownCallableByCaller,
                    format!(
                        "`callable_by {}` cannot reference `{}` because it is not a {}",
                        rule.caller_kind, rule.caller, rule.caller_kind
                    ),
                    Some(rule.source_ref.clone()),
                ));
                continue;
            }

            if !seen.insert(symbol.id.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateCallableByRule,
                    format!(
                        "`{}` is declared more than once in `callable_by` for agent `{}`",
                        rule.caller, declaration.name
                    ),
                    Some(rule.source_ref.clone()),
                ));
                continue;
            }

            lowered.push(AirCallableBy {
                caller_ref: symbol.id.clone(),
                caller_kind: rule.caller_kind.clone(),
                source_ref: rule.source_ref.clone(),
            });
        }

        lowered
    }

    fn lower_type(&mut self, declaration: &AstTypeDeclaration) -> AirType {
        let fields = declaration
            .fields
            .iter()
            .map(|field| AirTypeField {
                name: field.name.clone(),
                type_ref: self.lower_type_ref(&field.type_ref),
                source_ref: field.source_ref.clone(),
            })
            .collect();
        lower_type_declaration(&self.module_name, declaration, fields)
    }

    fn lower_constant(&mut self, declaration: &AstConstantDeclaration) -> Option<AirConstant> {
        let type_ref = self.lower_type_ref(&declaration.type_ref);
        let enum_value = if let AstExpression::FieldAccess {
            target,
            field,
            field_source_ref,
            ..
        } = &declaration.value
            && let AstExpression::Symbol { value, .. } = target.as_ref()
            && let Some(symbol) = self
                .symbols
                .get(value)
                .filter(|symbol| symbol.kind == SymbolKind::Type)
            && let Some(variants) = self.type_variants.get(&symbol.id)
        {
            if !variants.contains(field) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownEnumVariant,
                    format!("unknown member `{field}` on enum `{value}`"),
                    Some(field_source_ref.clone()),
                ));
            }
            Some((symbol.id.clone(), field.clone()))
        } else {
            None
        };
        let actual_type = enum_value
            .as_ref()
            .map(|(type_ref, _)| type_ref.clone())
            .or_else(|| literal_expression_type(&declaration.value).map(str::to_string));
        if actual_type.is_none() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnsupportedModuleConstantExpression,
                "`define` V1 accepts scalar literals and qualified enum members",
                Some(expression_source_ref(&declaration.value)),
            ));
        }
        if let Some(actual_type) = actual_type {
            self.check_constant_type(&actual_type, &type_ref, &declaration.value);
        }

        let mut constant = AirConstant {
            id: constant_id(&self.module_name, &declaration.name),
            name: declaration.name.clone(),
            type_ref,
            literal_text: enum_value.map(|(_, member)| member),
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            source_ref: declaration.source_ref.clone(),
        };

        match &declaration.value {
            AstExpression::StringLiteral { value, .. } => {
                constant.literal_text = Some(value.clone())
            }
            AstExpression::BooleanLiteral { value, .. } => constant.literal_boolean = Some(*value),
            AstExpression::IntLiteral { value, source_ref } => {
                self.validate_int_literal(value, source_ref);
                constant.literal_int = Some(value.clone());
            }
            AstExpression::FloatLiteral { value, source_ref } => {
                self.validate_float_literal(value, source_ref);
                constant.literal_float = Some(value.clone());
            }
            _ => {}
        }

        Some(constant)
    }

    fn check_constant_type(
        &mut self,
        actual_type: &str,
        expected_type: &str,
        expression: &AstExpression,
    ) {
        if !is_assignable_to(actual_type, expected_type) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::IncompatibleExpressionType,
                format!("define expects `{expected_type}`, got `{actual_type}`"),
                Some(expression_source_ref(expression)),
            ));
        }
    }

    fn validate_int_literal(&mut self, value: &str, source_ref: &SourceRef) -> Option<i128> {
        match value.parse::<i128>() {
            Ok(parsed) if parsed <= MAX_SAFE_INT => Some(parsed),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidNumericLiteral,
                    format!(
                        "Int literal `{value}` is outside the supported V1 domain [-{MAX_SAFE_INT}, {MAX_SAFE_INT}]"
                    ),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }

    fn validate_float_literal(&mut self, value: &str, source_ref: &SourceRef) -> Option<f64> {
        match value.parse::<f64>() {
            Ok(parsed) if parsed.is_finite() => Some(parsed),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidNumericLiteral,
                    format!("Float literal `{value}` is not finite or not representable"),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }

    fn lower_memory(&mut self, declaration: &AstMemoryDeclaration) -> AirMemory {
        lower_memory_declaration(&self.module_name, declaration)
    }

    fn lower_function(
        &mut self,
        declaration: &AstCallableDeclaration,
    ) -> Option<(AirFunction, AirFlowGraph, Vec<AirTracePoint>)> {
        let id = function_id(&self.module_name, &declaration.name);
        let body = self.required_body("function", &declaration.name, &declaration.body)?;
        let signature = self.lower_required_signature(
            "function",
            &declaration.name,
            &declaration.signature,
            &declaration.source_ref,
        )?;
        let graph_id = graph_id(&id);
        let (graph, trace_points) = self.lower_graph(&id, &graph_id, body, &signature, &[]);

        for node in &graph.nodes {
            if !node.kind.is_pure_function_node() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::FunctionNotPure,
                    format!(
                        "function `{id}` must be pure; {:?} is not permitted",
                        node.kind
                    ),
                    Some(node.source_ref.clone()),
                ));
            }
        }

        Some((
            AirFunction {
                id,
                name: declaration.name.clone(),
                description: declaration.description.clone(),
                signature,
                body_graph_ref: graph_id,
                source_ref: declaration.source_ref.clone(),
            },
            graph,
            trace_points,
        ))
    }

    fn lower_tool(&mut self, declaration: &AstCallableDeclaration) -> Option<AirTool> {
        let signature = self.lower_required_signature(
            "tool",
            &declaration.name,
            &declaration.signature,
            &declaration.source_ref,
        )?;

        let required_capabilities =
            self.lower_required_capabilities(&declaration.required_capabilities);
        let required_secrets =
            self.lower_required_secrets(&declaration.required_secrets, &required_capabilities);
        let tool_id = tool_id(&self.module_name, &declaration.name);
        let memory_accesses = self
            .tool_memory_accesses
            .get(&tool_id)
            .cloned()
            .unwrap_or_default();

        Some(AirTool {
            id: tool_id,
            name: declaration.name.clone(),
            description: declaration.description.clone(),
            signature,
            binding_ref: None,
            required_capabilities,
            required_secrets,
            memory_accesses,
            failure_path_refs: Vec::new(),
            source_ref: declaration.source_ref.clone(),
        })
    }

    fn lower_required_capabilities(
        &mut self,
        requirements: &[AstCapabilityRequirement],
    ) -> Vec<String> {
        let mut capabilities = Vec::new();
        let mut seen = HashSet::new();

        for requirement in requirements {
            if !is_v1_capability_label(&requirement.name) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownToolCapability,
                    format!("unknown Touba tool capability `{}`", requirement.name),
                    Some(requirement.source_ref.clone()),
                ));
                continue;
            }

            if !seen.insert(requirement.name.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateToolCapability,
                    format!(
                        "tool capability `{}` is required more than once",
                        requirement.name
                    ),
                    Some(requirement.source_ref.clone()),
                ));
                continue;
            }

            capabilities.push(requirement.name.clone());
        }

        capabilities
    }

    fn lower_required_secrets(
        &mut self,
        requirements: &[AstSecretRequirement],
        required_capabilities: &[String],
    ) -> Vec<String> {
        let mut secrets = Vec::new();
        let mut seen = HashSet::new();

        for requirement in requirements {
            if !seen.insert(requirement.name.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateToolSecret,
                    format!(
                        "tool secret `{}` is required more than once",
                        requirement.name
                    ),
                    Some(requirement.source_ref.clone()),
                ));
                continue;
            }

            secrets.push(requirement.name.clone());
        }

        if !secrets.is_empty()
            && !required_capabilities
                .iter()
                .any(|capability| capability == "secret_read")
        {
            let source_ref = requirements
                .first()
                .map(|requirement| requirement.source_ref.clone());
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingToolSecretReadCapability,
                "`secrets` requires explicit `requires secret_read` on the tool".to_string(),
                source_ref,
            ));
        }

        secrets
    }

    fn lower_tool_memory_accesses(
        &mut self,
        declaration: &AstCallableDeclaration,
    ) -> Vec<AirMemoryAccess> {
        let mut accesses = Vec::new();
        let mut seen = HashSet::new();
        let required_capabilities: HashSet<&str> = declaration
            .required_capabilities
            .iter()
            .map(|capability| capability.name.as_str())
            .collect();

        for access in &declaration.memory_accesses {
            let Some(memory_ref) = self.resolve_memory_ref(&access.memory, &access.source_ref)
            else {
                continue;
            };
            if !is_memory_access_label(&access.access) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidMemoryAccess,
                    format!(
                        "memory access `{}` is not supported; expected `read` or `write`",
                        access.access
                    ),
                    Some(access.source_ref.clone()),
                ));
                continue;
            }
            if !seen.insert((memory_ref.clone(), access.access.clone())) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateToolMemoryAccess,
                    format!(
                        "tool `{}` declares memory `{}` access `{}` more than once",
                        declaration.name, access.memory, access.access
                    ),
                    Some(access.source_ref.clone()),
                ));
                continue;
            }
            match access.access.as_str() {
                "read" if !required_capabilities.contains("memory_read") => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::MissingMemoryReadCapability,
                        "`uses memory ... read` requires explicit `requires memory_read` on the tool",
                        Some(access.source_ref.clone()),
                    ));
                }
                "write" if !required_capabilities.contains("memory_write") => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::MissingMemoryWriteCapability,
                        "`uses memory ... write` requires explicit `requires memory_write` on the tool",
                        Some(access.source_ref.clone()),
                    ));
                }
                _ => {}
            }
            accesses.push(AirMemoryAccess {
                memory_ref,
                access: access.access.clone(),
                source_ref: access.source_ref.clone(),
            });
        }

        accesses
    }

    fn lower_memory_scopes(&mut self, scopes: &[AstMemoryScope]) -> Vec<AirMemoryScope> {
        let mut lowered = Vec::new();
        let mut seen = HashSet::new();

        for scope in scopes {
            let Some(memory_ref) = self.resolve_memory_ref(&scope.memory, &scope.source_ref) else {
                continue;
            };
            if !is_memory_access_label(&scope.access) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidMemoryAccess,
                    format!(
                        "memory scope `{}` is not supported; expected `read` or `write`",
                        scope.access
                    ),
                    Some(scope.source_ref.clone()),
                ));
                continue;
            }
            if !seen.insert((memory_ref.clone(), scope.access.clone())) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateMemoryScope,
                    format!(
                        "memory `{}` scope `{}` is declared more than once",
                        scope.memory, scope.access
                    ),
                    Some(scope.source_ref.clone()),
                ));
                continue;
            }
            lowered.push(AirMemoryScope {
                memory_ref,
                access: scope.access.clone(),
                source_ref: scope.source_ref.clone(),
            });
        }

        lowered
    }

    fn lower_skill(
        &mut self,
        declaration: &AstSkillDeclaration,
    ) -> Option<(AirSkill, AirFlowGraph, Vec<AirTracePoint>)> {
        let id = skill_id(&self.module_name, &declaration.name);
        let body = self.required_body("skill", &declaration.name, &declaration.body)?;
        let signature = self.lower_required_signature(
            "skill",
            &declaration.name,
            &declaration.signature,
            &declaration.source_ref,
        )?;
        let memory_scopes = self.lower_memory_scopes(&declaration.memory_scopes);
        let graph_id = graph_id(&id);
        let mut graph_builder = FlowGraphBuilder::new(
            self.flow_graph_environment(),
            FlowGraphSpec {
                owner_memory_scopes: &memory_scopes,
                owner_ref: &id,
                graph_id: &graph_id,
                body,
                signature: &signature,
            },
        );
        graph_builder.lower_body(body);
        graph_builder.lower_failure_handler(declaration.failure_handler.as_ref());
        let graph_result = graph_builder.finish();
        self.diagnostics.extend(graph_result.diagnostics);
        let (uses, use_refs) = self.lower_uses(&declaration.uses);

        Some((
            AirSkill {
                id,
                name: declaration.name.clone(),
                description: declaration.description.clone(),
                signature,
                uses,
                use_refs,
                memory_scopes,
                flow_graph_ref: graph_id,
                failure_path_refs: graph_result.graph.failure_path_refs.clone(),
                source_ref: declaration.source_ref.clone(),
            },
            graph_result.graph,
            graph_result.trace_points,
        ))
    }

    fn lower_agent(&mut self, declaration: &AstAgentDeclaration) -> AirAgent {
        let id = agent_id(&self.module_name, &declaration.name);
        let (uses, use_refs) = self.lower_uses(&declaration.uses);
        let callable_by = self.agent_authority.get(&id).cloned().unwrap_or_default();
        let memory_scopes = self.lower_memory_scopes(&declaration.memory_scopes);
        // Every catalog entry is selectable. Reject locally resolved contracts
        // that this agent can never satisfy, even before a model makes a choice.
        for target in &uses {
            if let Some(callers) = self.agent_authority.get(target) {
                if !callers.iter().any(|caller| caller.caller_ref == id) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::AgentCallerNotAllowed,
                        format!("agent `{id}` cannot select `{target}` without a matching `callable_by` rule"),
                        Some(declaration.source_ref.clone()),
                    ));
                }
            }
            if let Some(accesses) = self.tool_memory_accesses.get(target) {
                for access in accesses {
                    if !memory_scopes.iter().any(|scope| {
                        scope.memory_ref == access.memory_ref && scope.access == access.access
                    }) {
                        self.diagnostics.push(AirDiagnostic::new(
                            AirDiagnosticCode::OwnerMemoryScopeMissing,
                            format!(
                                "agent `{id}` cannot select `{target}` without scope `{}` `{}`",
                                access.memory_ref, access.access
                            ),
                            Some(declaration.source_ref.clone()),
                        ));
                    }
                }
            }
        }
        let signature =
            if declaration.signature.inputs.is_empty() && declaration.signature.output.is_none() {
                None
            } else if declaration.signature.output.is_none() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingAgentInterfaceOutput,
                    format!(
                        "agent `{}` declares an interface with `takes` but no `gives`",
                        declaration.name
                    ),
                    Some(declaration.source_ref.clone()),
                ));
                None
            } else {
                self.lower_optional_signature(&declaration.signature)
            };
        AirAgent {
            id,
            name: declaration.name.clone(),
            description: declaration.description.clone(),
            responsibility: declaration.responsibility.clone(),
            signature,
            uses,
            use_refs,
            callable_by,
            memory_scopes,
            source_ref: declaration.source_ref.clone(),
        }
    }

    fn lower_strategy(
        &mut self,
        declaration: &AstStrategyDeclaration,
    ) -> Option<(AirStrategy, AirFlowGraph, Vec<AirTracePoint>)> {
        let id = strategy_id(&self.module_name, &declaration.name);
        let body = self.required_body("strategy", &declaration.name, &declaration.body)?;
        let signature = self.lower_optional_signature(&declaration.signature);
        let graph_id = graph_id(&id);
        let graph_signature = signature.clone().unwrap_or(AirSignature {
            inputs: Vec::new(),
            output_type: None,
        });
        let memory_scopes = self.lower_memory_scopes(&declaration.memory_scopes);
        let (graph, trace_points) =
            self.lower_graph(&id, &graph_id, body, &graph_signature, &memory_scopes);
        let (uses, use_refs) = self.lower_uses(&declaration.uses);

        Some((
            AirStrategy {
                id,
                name: declaration.name.clone(),
                description: declaration.description.clone(),
                uses,
                use_refs,
                memory_scopes,
                flow_graph_ref: graph_id,
                signature,
                source_ref: declaration.source_ref.clone(),
            },
            graph,
            trace_points,
        ))
    }

    fn lower_trigger(&mut self, declaration: &AstTriggerDeclaration) -> Option<AirTrigger> {
        let id = trigger_id(&self.module_name, &declaration.name);
        let event = self.lower_trigger_event(declaration)?;
        let target = self.lower_trigger_target(declaration)?;
        let limits = self.lower_trigger_limits(declaration)?;
        let (arguments, payload) = self.lower_trigger_arguments(declaration, &target, &event);

        Some(AirTrigger {
            id,
            name: declaration.name.clone(),
            event,
            target_ref: target.id,
            target_kind: "strategy".to_string(),
            arguments,
            payload,
            limits,
            source_ref: declaration.source_ref.clone(),
        })
    }

    fn lower_trigger_event(
        &mut self,
        declaration: &AstTriggerDeclaration,
    ) -> Option<AirTriggerEvent> {
        let Some(event) = declaration.event.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingTriggerEvent,
                format!(
                    "trigger `{}` requires an `on schedule <Text>` or `on request <METHOD> <Path>` clause",
                    declaration.name
                ),
                Some(declaration.source_ref.clone()),
            ));
            return None;
        };

        if event.kind == "schedule" {
            return self.lower_schedule_trigger_event(event);
        }

        if event.kind == "request" {
            return self.lower_request_trigger_event(event);
        }

        self.diagnostics.push(AirDiagnostic::new(
            AirDiagnosticCode::UnsupportedTriggerEventKind,
            format!(
                "trigger event family `{}` is outside V1; expected `schedule` or `request`",
                event.kind
            ),
            Some(event.source_ref.clone()),
        ));
        None
    }

    fn lower_schedule_trigger_event(&mut self, event: &AstTriggerEvent) -> Option<AirTriggerEvent> {
        if event.detail.is_some() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on schedule` accepts exactly one Text literal value",
                Some(event.source_ref.clone()),
            ));
            return None;
        }

        let Some(AstExpression::StringLiteral { value, source_ref }) = event.value.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on schedule` requires a non-empty Text literal",
                Some(event.source_ref.clone()),
            ));
            return None;
        };

        if value.trim().is_empty() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on schedule` requires a non-empty Text literal",
                Some(source_ref.clone()),
            ));
            return None;
        }

        Some(AirTriggerEvent {
            kind: event.kind.clone(),
            value: value.clone(),
            source_ref: event.source_ref.clone(),
        })
    }

    fn lower_request_trigger_event(&mut self, event: &AstTriggerEvent) -> Option<AirTriggerEvent> {
        let Some(method) = event.detail.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on request` requires an HTTP method before the path",
                Some(event.source_ref.clone()),
            ));
            return None;
        };
        let normalized_method = method.trim().to_ascii_uppercase();
        if !matches!(
            normalized_method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on request` supports GET, POST, PUT, PATCH and DELETE",
                Some(event.source_ref.clone()),
            ));
            return None;
        }
        let Some(AstExpression::StringLiteral { value, source_ref }) = event.value.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on request` requires a non-empty path literal",
                Some(event.source_ref.clone()),
            ));
            return None;
        };

        let path = value.trim();
        if !path.starts_with('/') || path.contains(char::is_whitespace) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerEventValue,
                "`on request` path must start with `/` and contain no whitespace",
                Some(source_ref.clone()),
            ));
            return None;
        }

        Some(AirTriggerEvent {
            kind: event.kind.clone(),
            value: format!("{} {}", normalized_method, path),
            source_ref: event.source_ref.clone(),
        })
    }

    fn lower_trigger_target(&mut self, declaration: &AstTriggerDeclaration) -> Option<SymbolRef> {
        let Some(target) = declaration.target.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingTriggerTarget,
                format!(
                    "trigger `{}` requires `runs strategy <Name>`",
                    declaration.name
                ),
                Some(declaration.source_ref.clone()),
            ));
            return None;
        };

        if target.kind != "strategy" {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnsupportedTriggerTargetKind,
                format!(
                    "trigger target kind `{}` is outside tranche 1; expected `strategy`",
                    target.kind
                ),
                Some(target.source_ref.clone()),
            ));
            return None;
        }

        match self.symbols.get(&target.name) {
            Some(symbol) if symbol.kind == SymbolKind::Strategy => Some(symbol.clone()),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownTriggerTarget,
                    format!("trigger target strategy `{}` is not declared", target.name),
                    Some(target.source_ref.clone()),
                ));
                None
            }
        }
    }

    fn lower_trigger_limits(
        &mut self,
        declaration: &AstTriggerDeclaration,
    ) -> Option<AirTriggerLimits> {
        let Some(limits) = declaration.limits.as_ref() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingTriggerLimits,
                format!(
                    "trigger `{}` requires a `limits` block with `max_runs_per_day` and `timeout_ms`",
                    declaration.name
                ),
                Some(declaration.source_ref.clone()),
            ));
            return None;
        };

        let mut seen = HashSet::new();
        let mut max_runs_per_day = None;
        let mut timeout_ms = None;
        let mut max_runs_per_day_seen = false;
        let mut timeout_ms_seen = false;

        for limit in &limits.limits {
            if !seen.insert(limit.name.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateTriggerLimit,
                    format!("trigger limit `{}` is declared more than once", limit.name),
                    Some(limit.source_ref.clone()),
                ));
                continue;
            }

            let parsed = self.parse_positive_trigger_limit(limit);
            match limit.name.as_str() {
                "max_runs_per_day" => {
                    max_runs_per_day_seen = true;
                    max_runs_per_day = parsed;
                }
                "timeout_ms" => {
                    timeout_ms_seen = true;
                    timeout_ms = parsed;
                }
                _ => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::InvalidTriggerLimit,
                        format!(
                            "trigger limit `{}` is not supported; expected `max_runs_per_day` or `timeout_ms`",
                            limit.name
                        ),
                        Some(limit.source_ref.clone()),
                    ));
                }
            }
        }

        if !max_runs_per_day_seen {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingTriggerLimit,
                "trigger limits require `max_runs_per_day`",
                Some(limits.source_ref.clone()),
            ));
        }
        if !timeout_ms_seen {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingTriggerLimit,
                "trigger limits require `timeout_ms`",
                Some(limits.source_ref.clone()),
            ));
        }

        Some(AirTriggerLimits {
            max_runs_per_day: max_runs_per_day?,
            timeout_ms: timeout_ms?,
            source_ref: limits.source_ref.clone(),
        })
    }

    fn parse_positive_trigger_limit(&mut self, limit: &AstTriggerLimit) -> Option<u64> {
        let AstExpression::IntLiteral { value, source_ref } = &limit.value else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerLimit,
                format!("trigger limit `{}` requires an Int literal", limit.name),
                Some(expression_source_ref(&limit.value)),
            ));
            return None;
        };

        let parsed = self.validate_int_literal(value, source_ref)?;
        if parsed <= 0 {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerLimit,
                format!("trigger limit `{}` must be strictly positive", limit.name),
                Some(source_ref.clone()),
            ));
            return None;
        }

        u64::try_from(parsed).ok()
    }

    fn lower_trigger_arguments(
        &mut self,
        declaration: &AstTriggerDeclaration,
        target: &SymbolRef,
        event: &AirTriggerEvent,
    ) -> (Vec<AirTriggerArgument>, Option<AirTriggerPayloadContract>) {
        let mut payload_map = BTreeMap::new();
        let mut payload_source_ref: Option<SourceRef> = None;

        if !target.contract_resolved {
            let mut lowered = Vec::new();
            let mut seen = HashSet::new();
            for argument in &declaration.arguments {
                if !seen.insert(argument.name.as_str()) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::DuplicateTriggerArgument,
                        format!(
                            "trigger argument `{}` is provided more than once",
                            argument.name
                        ),
                        Some(argument.source_ref.clone()),
                    ));
                    continue;
                }
                match self.lower_trigger_argument_value(argument, event) {
                    Some(LoweredTriggerArgumentValue::Static { value_ref, .. }) => {
                        lowered.push(AirTriggerArgument {
                            input: argument.name.clone(),
                            value_ref,
                            source_ref: argument.source_ref.clone(),
                        });
                    }
                    Some(LoweredTriggerArgumentValue::Payload { json_path }) => {
                        if payload_source_ref.is_none() {
                            payload_source_ref = Some(argument.source_ref.clone());
                        }
                        payload_map.insert(argument.name.clone(), json_path);
                    }
                    None => {}
                }
            }
            return (
                lowered,
                trigger_payload_contract(payload_map, payload_source_ref),
            );
        }

        let signature_inputs: HashSet<&str> = target.signature_input_names().collect();
        let mut by_name: HashMap<&str, &AstCallArgument> = HashMap::new();

        for argument in &declaration.arguments {
            if !signature_inputs.contains(argument.name.as_str()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownTriggerArgument,
                    format!(
                        "trigger argument `{}` does not match target strategy `{}`",
                        argument.name, target.id
                    ),
                    Some(argument.source_ref.clone()),
                ));
                continue;
            }

            if by_name.insert(argument.name.as_str(), argument).is_some() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateTriggerArgument,
                    format!(
                        "trigger argument `{}` is provided more than once",
                        argument.name
                    ),
                    Some(argument.source_ref.clone()),
                ));
            }
        }

        let mut lowered = Vec::new();
        for input in &target.signature_inputs {
            if let Some(argument) = by_name.get(input.name.as_str()) {
                match self.lower_trigger_argument_value(argument, event) {
                    Some(LoweredTriggerArgumentValue::Static {
                        value_ref,
                        actual_type,
                    }) => {
                        self.check_trigger_argument_type(
                            actual_type.as_deref(),
                            input.type_ref.as_deref(),
                            argument,
                        );
                        lowered.push(AirTriggerArgument {
                            input: argument.name.clone(),
                            value_ref,
                            source_ref: argument.source_ref.clone(),
                        });
                    }
                    Some(LoweredTriggerArgumentValue::Payload { json_path }) => {
                        if payload_source_ref.is_none() {
                            payload_source_ref = Some(argument.source_ref.clone());
                        }
                        payload_map.insert(argument.name.clone(), json_path);
                    }
                    None => {}
                }
            } else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingTriggerArgument,
                    format!(
                        "trigger `{}` must provide strategy argument `{}`",
                        declaration.name, input.name
                    ),
                    Some(declaration.source_ref.clone()),
                ));
            }
        }

        (
            lowered,
            trigger_payload_contract(payload_map, payload_source_ref),
        )
    }

    fn lower_trigger_argument_value(
        &mut self,
        argument: &AstCallArgument,
        event: &AirTriggerEvent,
    ) -> Option<LoweredTriggerArgumentValue> {
        if let Some(json_path) = self.lower_trigger_payload_argument(argument, event) {
            return Some(LoweredTriggerArgumentValue::Payload { json_path });
        }

        match &argument.value {
            AstExpression::StringLiteral { .. } => Some(LoweredTriggerArgumentValue::Static {
                value_ref: expression_handle(&argument.value),
                actual_type: Some(builtin_text()),
            }),
            AstExpression::BooleanLiteral { .. } => Some(LoweredTriggerArgumentValue::Static {
                value_ref: expression_handle(&argument.value),
                actual_type: Some(builtin_boolean()),
            }),
            AstExpression::IntLiteral { value, source_ref } => {
                self.validate_int_literal(value, source_ref);
                Some(LoweredTriggerArgumentValue::Static {
                    value_ref: expression_handle(&argument.value),
                    actual_type: Some(builtin_int()),
                })
            }
            AstExpression::FloatLiteral { value, source_ref } => {
                self.validate_float_literal(value, source_ref);
                Some(LoweredTriggerArgumentValue::Static {
                    value_ref: expression_handle(&argument.value),
                    actual_type: Some(builtin_float()),
                })
            }
            AstExpression::Symbol { value, source_ref } => {
                match self
                    .symbols
                    .get(value)
                    .filter(|symbol| symbol.kind == SymbolKind::Constant)
                {
                    Some(symbol) => Some(LoweredTriggerArgumentValue::Static {
                        value_ref: symbol.id.clone(),
                        actual_type: symbol.output_type.clone(),
                    }),
                    None => {
                        self.diagnostics.push(AirDiagnostic::new(
                            AirDiagnosticCode::InvalidTriggerArgument,
                            format!(
                                "trigger argument `{}` must use a literal or module `define`, got `{value}`",
                                argument.name
                            ),
                            Some(source_ref.clone()),
                        ));
                        None
                    }
                }
            }
            AstExpression::Value { source_ref, .. }
            | AstExpression::OptionalSome { source_ref, .. }
            | AstExpression::OptionalNone { source_ref, .. }
            | AstExpression::Record { source_ref, .. }
            | AstExpression::TextConversion { source_ref, .. }
            | AstExpression::FieldAccess { source_ref, .. }
            | AstExpression::Unary { source_ref, .. }
            | AstExpression::Binary { source_ref, .. }
            | AstExpression::Parenthesized { source_ref, .. } => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidTriggerArgument,
                    format!(
                        "trigger argument `{}` accepts only a literal or module `define`; host or graph values are not allowed",
                        argument.name
                    ),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }

    fn lower_trigger_payload_argument(
        &mut self,
        argument: &AstCallArgument,
        event: &AirTriggerEvent,
    ) -> Option<String> {
        let path = payload_path_segments(&argument.value)?;
        let source_ref = expression_source_ref(&argument.value);
        if event.kind != "request" {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerArgument,
                format!(
                    "trigger argument `{}` can map `payload.<field>` only on `on request` triggers",
                    argument.name
                ),
                Some(source_ref),
            ));
            return None;
        }
        if path.is_empty() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerArgument,
                format!(
                    "trigger argument `{}` must map a JSON field as `payload.<field>`",
                    argument.name
                ),
                Some(source_ref),
            ));
            return None;
        }

        Some(format!("$.{}", path.join(".")))
    }

    fn check_trigger_argument_type(
        &mut self,
        actual_type: Option<&str>,
        expected_type: Option<&str>,
        argument: &AstCallArgument,
    ) {
        let (Some(actual_type), Some(expected_type)) = (actual_type, expected_type) else {
            return;
        };
        if !is_assignable_to(actual_type, expected_type) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::IncompatibleExpressionType,
                format!(
                    "trigger argument `{}` expects `{expected_type}`, got `{actual_type}`",
                    argument.name
                ),
                Some(argument.source_ref.clone()),
            ));
        }
    }

    fn lower_uses(&mut self, uses: &[AstUse]) -> (Vec<String>, Vec<AirUseRef>) {
        let mut resolved_uses = Vec::new();
        let mut use_refs = Vec::new();
        for usage in uses {
            if let Some(target_ref) = self.resolve_use(&usage.target, &usage.source_ref) {
                resolved_uses.push(target_ref.clone());
                use_refs.push(AirUseRef {
                    target_ref,
                    source_ref: usage.source_ref.clone(),
                });
            }
        }
        (resolved_uses, use_refs)
    }

    fn lower_graph(
        &mut self,
        owner_ref: &str,
        graph_id: &str,
        body: &AstBody,
        signature: &AirSignature,
        memory_scopes: &[AirMemoryScope],
    ) -> (AirFlowGraph, Vec<AirTracePoint>) {
        let mut graph_builder = FlowGraphBuilder::new(
            self.flow_graph_environment(),
            FlowGraphSpec {
                owner_memory_scopes: memory_scopes,
                owner_ref,
                graph_id,
                body,
                signature,
            },
        );
        graph_builder.lower_body(body);
        let graph_result = graph_builder.finish();
        self.diagnostics.extend(graph_result.diagnostics);
        (graph_result.graph, graph_result.trace_points)
    }

    fn flow_graph_environment(&self) -> FlowGraphEnvironment<'_> {
        FlowGraphEnvironment {
            symbols: &self.symbols,
            type_fields: &self.type_fields,
            type_variants: &self.type_variants,
            agent_authority: &self.agent_authority,
            tool_memory_accesses: &self.tool_memory_accesses,
            effectful_symbols: &self.effectful_symbols,
        }
    }

    fn lower_required_signature(
        &mut self,
        declaration_kind: &str,
        name: &str,
        signature: &AstSignature,
        source_ref: &SourceRef,
    ) -> Option<AirSignature> {
        let output_type = signature
            .output
            .as_ref()
            .map(|type_ref| self.lower_type_ref(type_ref));
        if output_type.is_none() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingSignatureOutput,
                format!("{declaration_kind} `{name}` requires an explicit `gives` type for AIR"),
                Some(source_ref.clone()),
            ));
            return None;
        }

        Some(AirSignature {
            inputs: self.lower_parameters(&signature.inputs),
            output_type,
        })
    }

    fn lower_optional_signature(&mut self, signature: &AstSignature) -> Option<AirSignature> {
        if signature.inputs.is_empty() && signature.output.is_none() {
            None
        } else {
            Some(AirSignature {
                inputs: self.lower_parameters(&signature.inputs),
                output_type: signature
                    .output
                    .as_ref()
                    .map(|type_ref| self.lower_type_ref(type_ref)),
            })
        }
    }

    fn lower_parameters(&mut self, parameters: &[AstParameter]) -> Vec<AirParameter> {
        parameters
            .iter()
            .map(|parameter| AirParameter {
                name: parameter.name.clone(),
                type_ref: self.lower_type_ref(&parameter.type_ref),
                source_ref: parameter.source_ref.clone(),
            })
            .collect()
    }

    fn lower_type_ref(&mut self, type_ref: &AstTypeRef) -> String {
        self.lower_type_ref_raw(&type_ref.raw, &type_ref.source_ref)
    }

    fn lower_type_ref_raw(&mut self, raw: &str, source_ref: &SourceRef) -> String {
        if let Some(inner) = raw.strip_prefix("Optional of ") {
            format!("optional:{}", self.lower_type_ref_raw(inner, source_ref))
        } else if let Some(inner) = raw.strip_prefix("List of ") {
            format!("list:{}", self.lower_type_ref_raw(inner, source_ref))
        } else if self
            .symbols
            .get(raw)
            .is_some_and(|symbol| symbol.kind == SymbolKind::Type)
        {
            self.symbols
                .get(raw)
                .map(|symbol| symbol.id.clone())
                .unwrap_or_else(|| type_id(&self.module_name, raw))
        } else if is_builtin_type_ref(raw) {
            format!("builtin:{raw}")
        } else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnknownTypeReference,
                format!("unknown Touba type reference `{raw}`"),
                Some(source_ref.clone()),
            ));
            format!("unresolved:type:{raw}")
        }
    }

    fn lower_type_ref_raw_silent(&self, raw: &str) -> Option<String> {
        if let Some(inner) = raw.strip_prefix("Optional of ") {
            self.lower_type_ref_raw_silent(inner)
                .map(|inner_ref| format!("optional:{inner_ref}"))
        } else if let Some(inner) = raw.strip_prefix("List of ") {
            self.lower_type_ref_raw_silent(inner)
                .map(|inner_ref| format!("list:{inner_ref}"))
        } else if self
            .symbols
            .get(raw)
            .is_some_and(|symbol| symbol.kind == SymbolKind::Type)
        {
            self.symbols.get(raw).map(|symbol| symbol.id.clone())
        } else if is_builtin_type_ref(raw) {
            Some(format!("builtin:{raw}"))
        } else {
            None
        }
    }

    fn required_body<'a>(
        &mut self,
        declaration_kind: &str,
        name: &str,
        body: &'a Option<AstBody>,
    ) -> Option<&'a AstBody> {
        let Some(body) = body else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingExecutableBody,
                format!("{declaration_kind} `{name}` requires an explicit `do` block for AIR"),
                None,
            ));
            return None;
        };
        Some(body)
    }

    fn resolve_use(&mut self, target: &str, source_ref: &SourceRef) -> Option<String> {
        self.symbols
            .get(target)
            .map(|symbol| symbol.id.clone())
            .or_else(|| {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownReference,
                    format!("unknown Touba reference `{target}`"),
                    Some(source_ref.clone()),
                ));
                None
            })
    }

    fn resolve_memory_ref(&mut self, target: &str, source_ref: &SourceRef) -> Option<String> {
        match self.symbols.get(target) {
            Some(symbol) if symbol.kind == SymbolKind::Memory => Some(symbol.id.clone()),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownMemoryReference,
                    format!("unknown Touba memory `{target}`"),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }
}

struct FlowGraphEnvironment<'a> {
    symbols: &'a HashMap<String, SymbolRef>,
    type_fields: &'a HashMap<String, HashMap<String, TypeFieldRef>>,
    type_variants: &'a HashMap<String, HashSet<String>>,
    agent_authority: &'a HashMap<String, Vec<AirCallableBy>>,
    tool_memory_accesses: &'a HashMap<String, Vec<AirMemoryAccess>>,
    effectful_symbols: &'a HashSet<String>,
}

struct FlowGraphSpec<'a> {
    owner_memory_scopes: &'a [AirMemoryScope],
    owner_ref: &'a str,
    graph_id: &'a str,
    body: &'a AstBody,
    signature: &'a AirSignature,
}

struct FlowGraphBuilder<'a> {
    symbols: &'a HashMap<String, SymbolRef>,
    type_fields: &'a HashMap<String, HashMap<String, TypeFieldRef>>,
    type_variants: &'a HashMap<String, HashSet<String>>,
    agent_authority: &'a HashMap<String, Vec<AirCallableBy>>,
    tool_memory_accesses: &'a HashMap<String, Vec<AirMemoryAccess>>,
    effectful_symbols: &'a HashSet<String>,
    owner_memory_scopes: HashSet<(String, String)>,
    owner_ref: &'a str,
    graph_id: &'a str,
    graph_source_ref: SourceRef,
    nodes: Vec<AirFlowNode>,
    edges: Vec<AirFlowEdge>,
    expressions: Vec<AirExpression>,
    failure_paths: Vec<AirFailurePath>,
    trace_points: Vec<AirTracePoint>,
    diagnostics: Vec<AirDiagnostic>,
    local_values: HashSet<String>,
    local_value_types: HashMap<String, String>,
    output_type: Option<String>,
    node_counter: usize,
    expression_counter: usize,
    trace_counter: usize,
    first_call_node_id: Option<String>,
    external_effect_possible: bool,
}

impl<'a> FlowGraphBuilder<'a> {
    fn new(environment: FlowGraphEnvironment<'a>, spec: FlowGraphSpec<'a>) -> Self {
        let mut local_values = HashSet::new();
        let mut local_value_types = HashMap::new();
        for input in &spec.signature.inputs {
            local_values.insert(input.name.clone());
            local_value_types.insert(input.name.clone(), input.type_ref.clone());
        }
        let owner_memory_scopes = spec
            .owner_memory_scopes
            .iter()
            .map(|scope| (scope.memory_ref.clone(), scope.access.clone()))
            .collect();

        let mut builder = Self {
            symbols: environment.symbols,
            type_fields: environment.type_fields,
            type_variants: environment.type_variants,
            agent_authority: environment.agent_authority,
            tool_memory_accesses: environment.tool_memory_accesses,
            effectful_symbols: environment.effectful_symbols,
            owner_memory_scopes,
            owner_ref: spec.owner_ref,
            graph_id: spec.graph_id,
            graph_source_ref: spec.body.source_ref.clone(),
            nodes: Vec::new(),
            edges: Vec::new(),
            expressions: Vec::new(),
            failure_paths: Vec::new(),
            trace_points: Vec::new(),
            diagnostics: Vec::new(),
            local_values,
            local_value_types,
            output_type: spec.signature.output_type.clone(),
            node_counter: 0,
            expression_counter: 0,
            trace_counter: 0,
            first_call_node_id: None,
            external_effect_possible: false,
        };
        builder.push_trace(AirTraceAnchorKind::ScopeEntry, None, None);
        builder.push_trace(AirTraceAnchorKind::ScopeExit, None, None);
        builder
    }

    fn lower_body(&mut self, body: &AstBody) {
        self.lower_statement_sequence(&body.statements);
    }

    fn lower_failure_handler(&mut self, handler: Option<&AstFailureHandler>) {
        let Some(handler) = handler else {
            return;
        };
        let Some(trigger_node_id) = self.first_call_node_id.clone() else {
            return;
        };

        for step in &handler.steps {
            match step {
                AstFailureStep::Fallback { target, source_ref } => {
                    let Some(target_symbol) = self.symbols.get(target) else {
                        self.diagnostics.push(AirDiagnostic::new(
                            AirDiagnosticCode::UnknownReference,
                            format!("unknown fallback target `{target}`"),
                            Some(source_ref.clone()),
                        ));
                        continue;
                    };
                    let fallback_node_id = self.next_node_id();
                    let failure_trace = self.push_trace(
                        AirTraceAnchorKind::Failure,
                        Some(trigger_node_id.clone()),
                        Some(source_ref.clone()),
                    );
                    let fallback_trace = self.push_trace(
                        AirTraceAnchorKind::Fallback,
                        Some(fallback_node_id.clone()),
                        Some(source_ref.clone()),
                    );
                    let failure_path_id =
                        format!("failure:{}:{}", self.graph_id, self.failure_paths.len() + 1);

                    self.edges.push(AirFlowEdge {
                        from_node_id: trigger_node_id.clone(),
                        to_node_id: fallback_node_id.clone(),
                        role: AirFlowEdgeRole::Failure,
                        source_ref: Some(source_ref.clone()),
                    });
                    self.edges.push(AirFlowEdge {
                        from_node_id: trigger_node_id.clone(),
                        to_node_id: fallback_node_id.clone(),
                        role: AirFlowEdgeRole::Fallback,
                        source_ref: Some(source_ref.clone()),
                    });
                    self.nodes.push(AirFlowNode {
                        collection_ref: None,
                        item_binding: None,
                        max_concurrency: None,
                        max_items: None,
                        id: fallback_node_id.clone(),
                        kind: AirFlowNodeKind::Fallback,
                        approval_ref: None,
                        approval_mode: None,
            approval_policy: None,
                        context_refs: Vec::new(),
                        interaction_ref: None,
                        interaction_mode: None,
                        target_ref: Some(target_symbol.id.clone()),
                        arguments: Vec::new(),
                        result_binding: None,
                        condition_ref: None,
                        trace_point_refs: vec![fallback_trace],
                        source_ref: source_ref.clone(),
                    });
                    if let Some(node) = self
                        .nodes
                        .iter_mut()
                        .find(|node| node.id == trigger_node_id)
                    {
                        node.trace_point_refs.push(failure_trace);
                    }
                    self.failure_paths.push(AirFailurePath {
                        id: failure_path_id,
                        scope_ref: self.graph_id.to_string(),
                        trigger_node_id: trigger_node_id.clone(),
                        mode: AirFailureMode::Fallback,
                        failure_family: failure_family(&handler.family),
                        target_node_id: fallback_node_id,
                        source_ref: source_ref.clone(),
                    });
                }
                AstFailureStep::Stop { source_ref } => {
                    let stop_node_id = self.next_node_id();
                    let completion_trace = self.push_trace(
                        AirTraceAnchorKind::Completion,
                        Some(stop_node_id.clone()),
                        Some(source_ref.clone()),
                    );
                    self.edges.push(AirFlowEdge {
                        from_node_id: trigger_node_id.clone(),
                        to_node_id: stop_node_id.clone(),
                        role: AirFlowEdgeRole::Failure,
                        source_ref: Some(source_ref.clone()),
                    });
                    self.nodes.push(AirFlowNode {
                        collection_ref: None,
                        item_binding: None,
                        max_concurrency: None,
                        max_items: None,
                        id: stop_node_id.clone(),
                        kind: AirFlowNodeKind::Stop,
                        approval_ref: None,
                        approval_mode: None,
            approval_policy: None,
                        context_refs: Vec::new(),
                        interaction_ref: None,
                        interaction_mode: None,
                        target_ref: None,
                        arguments: Vec::new(),
                        result_binding: None,
                        condition_ref: None,
                        trace_point_refs: vec![completion_trace],
                        source_ref: source_ref.clone(),
                    });
                    self.failure_paths.push(AirFailurePath {
                        id: format!("failure:{}:{}", self.graph_id, self.failure_paths.len() + 1),
                        scope_ref: self.graph_id.to_string(),
                        trigger_node_id: trigger_node_id.clone(),
                        mode: AirFailureMode::Stop,
                        failure_family: failure_family(&handler.family),
                        target_node_id: stop_node_id,
                        source_ref: source_ref.clone(),
                    });
                }
            }
        }
    }

    fn finish(mut self) -> GraphBuildResult {
        if self.nodes.is_empty() && self.diagnostics.is_empty() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::EmptyFlowGraph,
                format!("AIR graph `{}` has no executable node", self.graph_id),
                Some(self.graph_source_ref.clone()),
            ));
        }

        let entry_node_id = self
            .nodes
            .first()
            .map(|node| node.id.clone())
            .unwrap_or_else(|| "missing-entry".to_string());
        let failure_path_refs = self
            .failure_paths
            .iter()
            .map(|failure_path| failure_path.id.clone())
            .collect();

        GraphBuildResult {
            graph: AirFlowGraph {
                id: self.graph_id.to_string(),
                owner_ref: self.owner_ref.to_string(),
                entry_node_id,
                nodes: self.nodes,
                edges: self.edges,
                expressions: self.expressions,
                failure_paths: self.failure_paths,
                failure_path_refs,
                source_ref: self.graph_source_ref,
            },
            trace_points: self.trace_points,
            diagnostics: self.diagnostics,
        }
    }

    fn lower_statement_sequence(&mut self, statements: &[AstStatement]) -> SequenceFragment {
        let mut pending_exits: Vec<PendingExit> = Vec::new();
        let mut terminal_reason: Option<&'static str> = None;
        for statement in statements {
            if let Some(reason) = terminal_reason {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnreachableStatement,
                    format!(
                        "statement is unreachable because a previous `{reason}` terminates this execution path"
                    ),
                    Some(statement_source_ref(statement)),
                ));
                continue;
            }

            let fragment = self.lower_statement(statement);
            if let Some(entry_node_id) = fragment.entry_node_id {
                self.edges.extend(connect_pending_exits(
                    &mut pending_exits,
                    &entry_node_id,
                    statement_source_ref(statement),
                ));
                pending_exits = fragment.exits;
                terminal_reason = fragment.terminal_reason;
            }
        }
        SequenceFragment {
            exits: pending_exits,
            terminal_reason,
            external_effect_possible: self.external_effect_possible,
        }
    }

    fn lower_statement(&mut self, statement: &AstStatement) -> FlowFragment {
        match statement {
            AstStatement::Bind(statement) => self.lower_bind(statement),
            AstStatement::Call(statement) => self.lower_call(statement),
            AstStatement::Parallel(statement) => self.lower_parallel(statement),
            AstStatement::HumanApproval(statement) => self.lower_human_approval(statement),
            AstStatement::UserInteraction(statement) => self.lower_user_interaction(statement),
            AstStatement::Give(statement) => self.lower_give(statement),
            AstStatement::Stop(statement) => self.lower_stop(statement),
            AstStatement::If(statement) => self.lower_if(statement),
            AstStatement::Match(statement) => self.lower_match(statement),
            AstStatement::For(statement) => self.lower_for(statement),
            AstStatement::While(statement) => self.lower_while(statement),
        }
    }

    fn lower_bind(&mut self, statement: &AstBindStatement) -> FlowFragment {
        let binding_type = self.lower_type_ref(&statement.type_ref);
        let value_ref = self
            .lower_expression_handle(
                &statement.value,
                Some(binding_type.as_str()),
                ExpressionContext::Binding,
            )
            .handle;
        self.lower_typed_binding(
            &statement.name,
            binding_type,
            value_ref,
            &statement.source_ref,
        )
    }

    fn lower_typed_binding(
        &mut self,
        name: &str,
        binding_type: String,
        value_ref: String,
        source_ref: &SourceRef,
    ) -> FlowFragment {
        let node_id = self.next_node_id();
        let result_binding = self.declare_local_binding(
            name,
            source_ref,
            Some(binding_type),
            AirDiagnosticCode::DuplicateLocalBinding,
            "local binding",
        );
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Binding,
            Some(node_id.clone()),
            Some(source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Bind,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: vec![value_ref],
            result_binding,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: source_ref.clone(),
        });
        FlowFragment::linear(node_id)
    }

    fn lower_parallel(&mut self, statement: &AstParallelStatement) -> FlowFragment {
        let Some(output_type) = self
            .symbols
            .get(&statement.call.target)
            .and_then(|symbol| symbol.output_type.clone())
        else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::StrategyInterfaceRequired,
                "parallel requires a callable with an explicit gives interface",
                Some(statement.call.source_ref.clone()),
            ));
            return FlowFragment::empty();
        };
        let Some((collection, item_type)) = self.collection_handle(&statement.collection) else {
            return FlowFragment::empty();
        };
        let outer_values = self.local_values.clone();
        let outer_types = self.local_value_types.clone();
        let item_binding = self.declare_local_binding(
            &statement.item,
            &statement.call.source_ref,
            Some(item_type),
            AirDiagnosticCode::DuplicateResultBinding,
            "parallel item",
        );
        let mut call = statement.call.clone();
        call.result_binding = None;
        // Unlike historical implicit calls, a fan-out always has an explicit
        // interface, including the zero-argument spelling.
        if call.arguments.is_empty() {
            if let Some(symbol) = self.symbols.get(&call.target).cloned() {
                self.lower_call_arguments(&call, &symbol);
            }
        }
        let count = self.nodes.len();
        let fragment = self.lower_call(&call);
        self.local_values = outer_values;
        self.local_value_types = outer_types;
        let result_binding = statement.call.result_binding.as_ref().and_then(|binding| {
            self.lower_result_binding(binding, Some(format!("list:{output_type}")))
        });
        if self.nodes.len() > count {
            let node = self.nodes.last_mut().unwrap();
            node.kind = AirFlowNodeKind::ParallelCall;
            node.collection_ref = Some(collection);
            node.item_binding = item_binding.map(|name| format!("value:{name}"));
            node.max_concurrency = Some(statement.max_concurrency);
            node.max_items = Some(statement.max_items);
            node.result_binding = result_binding;
        }
        fragment
    }

    fn lower_call(&mut self, statement: &AstCallStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        let Some(symbol) = self.symbols.get(&statement.target).cloned() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnknownReference,
                format!("unknown call target `{}`", statement.target),
                Some(statement.source_ref.clone()),
            ));
            return FlowFragment::empty();
        };
        let enriched = !statement.arguments.is_empty() || statement.result_binding.is_some();
        let kind = match symbol.kind {
            SymbolKind::Function => AirFlowNodeKind::CallFunction,
            SymbolKind::Tool => AirFlowNodeKind::CallTool,
            SymbolKind::Skill => AirFlowNodeKind::CallSkill,
            SymbolKind::Strategy if symbol.output_type.is_none() => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::StrategyInterfaceRequired,
                    "a called strategy must declare an explicit takes/gives interface with gives",
                    Some(statement.source_ref.clone()),
                ));
                return FlowFragment::empty();
            }
            SymbolKind::Strategy => AirFlowNodeKind::CallStrategy,
            SymbolKind::Agent if enriched && symbol.output_type.is_none() => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::EnrichedAgentCallBlocked,
                    "calls to an `agent` with `with` or `into` require an explicit, resolved `takes` / `gives` interface",
                    Some(statement.source_ref.clone()),
                ));
                return FlowFragment::empty();
            }
            SymbolKind::Agent => {
                if symbol.contract_resolved && !self.is_agent_call_authorized(&symbol.id) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::AgentCallerNotAllowed,
                        format!(
                            "`{}` cannot call agent `{}` without a matching `callable_by` rule",
                            self.owner_ref, symbol.id
                        ),
                        Some(statement.source_ref.clone()),
                    ));
                    return FlowFragment::empty();
                }
                AirFlowNodeKind::CallAgent
            }
            SymbolKind::Constant | SymbolKind::Memory | SymbolKind::Type | SymbolKind::Trigger => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownReference,
                    format!("`{}` is not callable in Touba V1", statement.target),
                    Some(statement.source_ref.clone()),
                ));
                return FlowFragment::empty();
            }
        };
        self.check_tool_memory_accesses(&symbol, &statement.source_ref);
        let requires_explicit_agent_inputs =
            matches!(symbol.kind, SymbolKind::Agent | SymbolKind::Strategy)
                && symbol.contract_resolved
                && !symbol.signature_inputs.is_empty();
        let arguments = if enriched || requires_explicit_agent_inputs {
            self.lower_call_arguments(statement, &symbol)
        } else {
            Vec::new()
        };
        let result_binding = statement
            .result_binding
            .as_ref()
            .and_then(|binding| self.lower_result_binding(binding, symbol.output_type.clone()));
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Call,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        if self.first_call_node_id.is_none() {
            self.first_call_node_id = Some(node_id.clone());
        }
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: Some(symbol.id.clone()),
            arguments,
            result_binding,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        if self.effectful_symbols.contains(&symbol.id) {
            self.external_effect_possible = true;
        }
        FlowFragment::linear(node_id)
    }

    fn check_tool_memory_accesses(&mut self, symbol: &SymbolRef, source_ref: &SourceRef) {
        if symbol.kind != SymbolKind::Tool {
            return;
        }
        let Some(accesses) = self.tool_memory_accesses.get(&symbol.id) else {
            return;
        };
        for access in accesses {
            if !self
                .owner_memory_scopes
                .contains(&(access.memory_ref.clone(), access.access.clone()))
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::OwnerMemoryScopeMissing,
                    format!(
                        "`{}` cannot access `{}` with `{}` without an explicit memory scope",
                        self.owner_ref, access.memory_ref, access.access
                    ),
                    Some(source_ref.clone()),
                ));
            }
        }
    }

    fn is_agent_call_authorized(&self, target_agent_ref: &str) -> bool {
        self.agent_authority
            .get(target_agent_ref)
            .is_some_and(|callers| {
                callers
                    .iter()
                    .any(|caller| caller.caller_ref == self.owner_ref)
            })
    }

    fn lower_human_approval(&mut self, statement: &AstHumanApprovalStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        if self.owner_ref.starts_with("function:") {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::HumanApprovalInFunction,
                "human approval is not allowed inside `function`; functions must remain pure",
                Some(statement.source_ref.clone()),
            ));
            return FlowFragment::empty();
        }
        let context_refs = self.lower_human_approval_context_refs(statement);
        let approval_policy = self.lower_human_approval_policy(statement);
        let result_binding = statement
            .result_binding
            .as_ref()
            .and_then(|binding| self.lower_result_binding(binding, None));
        if statement.result_binding.is_none() {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::MissingHumanApprovalDecisionBinding,
                "`human.approve` and `human.review` require an explicit `into` decision binding",
                Some(statement.source_ref.clone()),
            ));
        }

        let trace_point = self.push_trace(
            AirTraceAnchorKind::HumanApproval,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::HumanApproval,
            approval_ref: Some(format!("approval:{}:{}", self.graph_id, node_id)),
            approval_mode: Some(match statement.mode {
                AstHumanApprovalMode::RequiredApproval => AirHumanApprovalMode::RequiredApproval,
                AstHumanApprovalMode::AgentReview => AirHumanApprovalMode::AgentReview,
            }),
            approval_policy,
            context_refs,
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: Vec::new(),
            result_binding,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        if let Some(body) = &statement.expired_branch {
            let branch = self.lower_branch(&node_id, AirFlowEdgeRole::Expired, body);
            if !branch.exits.is_empty() || branch.terminal_reason.is_none() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::HumanApprovalExpirationMustTerminate,
                    "on expired must terminate explicitly on every path; it cannot authorize the protected continuation",
                    Some(statement.source_ref.clone()),
                ));
            }
        }
        FlowFragment::linear(node_id)
    }

    fn lower_human_approval_policy(&mut self, statement: &AstHumanApprovalStatement) -> Option<AirApprovalPolicy> {
        let mut policy = AirApprovalPolicy::default();
        for argument in &statement.arguments {
            let valid = match (argument.name.as_str(), &argument.value) {
                ("role", AstExpression::StringLiteral { value, .. }) if !value.is_empty() && value.trim() == value && value.len() <= 128 && !value.chars().any(char::is_control) => {
                    policy.role = Some(value.clone()); true
                }
                ("timeout_ms", AstExpression::IntLiteral { value, .. }) => {
                    policy.timeout_ms = value.parse::<u64>().ok().filter(|n| *n > 0 && *n <= 2_592_000_000);
                    policy.timeout_ms.is_some()
                }
                ("distinct_from", AstExpression::StringLiteral { value, .. })
                    if ["initiator", "previous", "initiator_and_previous"].contains(&value.as_str()) => {
                    policy.distinct_from = Some(value.clone()); true
                }
                ("context", _) => true,
                ("role" | "timeout_ms" | "distinct_from", _) => false,
                _ => continue,
            };
            if !valid {
                self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::InvalidHumanApprovalPolicy,
                    format!("human approval {} requires a valid static literal", argument.name),
                    Some(argument.source_ref.clone())));
            }
        }
        if policy == AirApprovalPolicy::default() { None } else { Some(policy) }
    }

    fn lower_human_approval_context_refs(
        &mut self,
        statement: &AstHumanApprovalStatement,
    ) -> Vec<String> {
        let mut context_ref = None;
        for argument in &statement.arguments {
            if ["role", "timeout_ms", "distinct_from"].contains(&argument.name.as_str()) { continue; }
            if argument.name != "context" {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownHumanApprovalArgument,
                    format!(
                        "human approval argument `{}` is not supported; expected context, role, timeout_ms or distinct_from",
                        argument.name
                    ),
                    Some(argument.source_ref.clone()),
                ));
                continue;
            }
            context_ref = Some(
                self.lower_expression_handle(
                    &argument.value,
                    None,
                    ExpressionContext::CallArgument,
                )
                .handle,
            );
        }

        match context_ref {
            Some(context_ref) => vec![context_ref],
            None => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingHumanApprovalContextArgument,
                    "human approval requires `with context as <expression>`",
                    Some(statement.source_ref.clone()),
                ));
                Vec::new()
            }
        }
    }

    fn lower_user_interaction(&mut self, statement: &AstUserInteractionStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        if self.owner_ref.starts_with("function:") {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UserInteractionInFunction,
                "`show` and `ask` are not allowed inside `function`; functions must remain pure",
                Some(statement.source_ref.clone()),
            ));
            return FlowFragment::empty();
        }

        let argument = self.lower_user_interaction_argument(statement);
        let result_binding = match statement.mode {
            AstUserInteractionMode::Show => {
                if let Some(binding) = statement.result_binding.as_ref() {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::UnexpectedUserInteractionResultBinding,
                        "`show` does not produce a value and must not use `into`",
                        Some(binding.source_ref.clone()),
                    ));
                }
                None
            }
            AstUserInteractionMode::Ask => {
                let result_binding = statement
                    .result_binding
                    .as_ref()
                    .and_then(|binding| self.lower_result_binding(binding, Some(builtin_text())));
                if statement.result_binding.is_none() {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::MissingUserInteractionResultBinding,
                        "`ask` requires an explicit `into` Text binding",
                        Some(statement.source_ref.clone()),
                    ));
                }
                result_binding
            }
        };

        let trace_point = self.push_trace(
            AirTraceAnchorKind::UserInteraction,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::UserInteraction,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: Some(format!("interaction:{}:{}", self.graph_id, node_id)),
            interaction_mode: Some(match statement.mode {
                AstUserInteractionMode::Show => AirUserInteractionMode::Show,
                AstUserInteractionMode::Ask => AirUserInteractionMode::Ask,
            }),
            target_ref: None,
            arguments: argument.into_iter().collect(),
            result_binding,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        FlowFragment::linear(node_id)
    }

    fn lower_user_interaction_argument(
        &mut self,
        statement: &AstUserInteractionStatement,
    ) -> Option<String> {
        let expected_name = match statement.mode {
            AstUserInteractionMode::Show => "message",
            AstUserInteractionMode::Ask => "prompt",
        };
        let mut argument_ref = None;

        for argument in &statement.arguments {
            if argument.name != expected_name {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownUserInteractionArgument,
                    format!(
                        "`{}` argument `{}` is not supported; V1 accepts only `{}`",
                        statement.target, argument.name, expected_name
                    ),
                    Some(argument.source_ref.clone()),
                ));
                continue;
            }
            argument_ref = Some(
                self.lower_expression_handle(
                    &argument.value,
                    Some(BUILTIN_TEXT),
                    ExpressionContext::UserInteraction,
                )
                .handle,
            );
        }

        if argument_ref.is_none() {
            let code = match statement.mode {
                AstUserInteractionMode::Show => {
                    AirDiagnosticCode::MissingUserInteractionMessageArgument
                }
                AstUserInteractionMode::Ask => {
                    AirDiagnosticCode::MissingUserInteractionPromptArgument
                }
            };
            self.diagnostics.push(AirDiagnostic::new(
                code,
                format!(
                    "`{}` requires `with {} as <Text expression>`",
                    statement.target, expected_name
                ),
                Some(statement.source_ref.clone()),
            ));
        }

        argument_ref
    }

    fn lower_call_arguments(
        &mut self,
        statement: &AstCallStatement,
        symbol: &SymbolRef,
    ) -> Vec<String> {
        if !symbol.contract_resolved {
            let mut lowered = Vec::new();
            let mut seen_names = HashSet::new();
            for argument in &statement.arguments {
                if !seen_names.insert(argument.name.as_str()) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::DuplicateCallArgument,
                        format!(
                            "call argument `{}` is provided more than once",
                            argument.name
                        ),
                        Some(argument.source_ref.clone()),
                    ));
                    continue;
                }
                lowered.push(self.call_argument_handle(argument, None));
            }
            return lowered;
        }

        let mut by_name: HashMap<&str, &AstCallArgument> = HashMap::new();
        let signature_inputs: HashSet<&str> = symbol.signature_input_names().collect();

        for argument in &statement.arguments {
            if !signature_inputs.contains(argument.name.as_str()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownCallArgument,
                    format!(
                        "call argument `{}` does not match the signature of `{}`",
                        argument.name, statement.target
                    ),
                    Some(argument.source_ref.clone()),
                ));
                continue;
            }

            if by_name.insert(argument.name.as_str(), argument).is_some() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateCallArgument,
                    format!(
                        "call argument `{}` is provided more than once",
                        argument.name
                    ),
                    Some(argument.source_ref.clone()),
                ));
            }
        }

        let mut lowered = Vec::new();
        for input in &symbol.signature_inputs {
            if let Some(argument) = by_name.get(input.name.as_str()) {
                lowered.push(self.call_argument_handle(argument, input.type_ref.as_deref()));
            } else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingExplicitCallArgument,
                    format!(
                        "call to `{}` requires explicit argument `{}`",
                        statement.target, input.name
                    ),
                    Some(statement.source_ref.clone()),
                ));
            }
        }

        lowered
    }

    fn call_argument_handle(
        &mut self,
        argument: &AstCallArgument,
        expected_type: Option<&str>,
    ) -> String {
        self.lower_expression_handle(
            &argument.value,
            expected_type,
            ExpressionContext::CallArgument,
        )
        .handle
    }

    fn lower_result_binding(
        &mut self,
        binding: &AstResultBinding,
        binding_type: Option<String>,
    ) -> Option<String> {
        self.declare_local_binding(
            &binding.name,
            &binding.source_ref,
            binding_type,
            AirDiagnosticCode::DuplicateResultBinding,
            "result binding",
        )
    }

    fn declare_local_binding(
        &mut self,
        name: &str,
        source_ref: &SourceRef,
        binding_type: Option<String>,
        diagnostic_code: AirDiagnosticCode,
        label: &str,
    ) -> Option<String> {
        if self.local_values.contains(name) {
            self.diagnostics.push(AirDiagnostic::new(
                diagnostic_code,
                format!("{label} `{name}` is already visible in this scope"),
                Some(source_ref.clone()),
            ));
            return None;
        }

        self.local_values.insert(name.to_string());
        if let Some(binding_type) = binding_type {
            self.local_value_types
                .insert(name.to_string(), binding_type);
        }
        Some(name.to_string())
    }

    fn lower_give(&mut self, statement: &AstGiveStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        let arguments = self.give_arguments(statement);
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Completion,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Give,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments,
            result_binding: None,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        FlowFragment::terminal(node_id, "give")
    }

    fn give_arguments(&mut self, statement: &AstGiveStatement) -> Vec<String> {
        let Some(expression) = statement.expression.as_ref() else {
            if self.output_type.is_some() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingGiveValue,
                    "`give` requires an explicit value when the graph declares an output",
                    Some(statement.source_ref.clone()),
                ));
            }
            return Vec::new();
        };

        match expression {
            AstExpression::Value { value, source_ref } => {
                if self.local_values.contains(value) {
                    let handle = format!("value:{value}");
                    let actual_type = self.local_value_types.get(value).cloned();
                    let expected_type = self.output_type.clone();
                    self.check_expression_context_type(
                        actual_type.as_deref(),
                        expected_type.as_deref(),
                        ExpressionContext::Give,
                        source_ref,
                    );
                    vec![handle]
                } else {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::InvalidGiveValue,
                        format!("give value `{value}` is not explicit in the local graph scope"),
                        Some(source_ref.clone()),
                    ));
                    vec![format!("unresolved:value:{value}")]
                }
            }
            AstExpression::Symbol { value, source_ref } => match self.symbols.get(value) {
                Some(symbol) if symbol.kind == SymbolKind::Constant => {
                    let handle = symbol.id.clone();
                    self.check_expression_context_type(
                        symbol.output_type.as_deref(),
                        self.output_type.clone().as_deref(),
                        ExpressionContext::Give,
                        source_ref,
                    );
                    vec![handle]
                }
                Some(symbol) if symbol.kind == SymbolKind::Type => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::InvalidGiveValue,
                        format!("`{value}` is a type, not a value; construct a `record {value}` or return a bound value"),
                        Some(source_ref.clone()),
                    ));
                    vec![format!("unresolved:symbol:{value}")]
                }
                _ => {
                    self.diagnostics.push(AirDiagnostic::new(
                            AirDiagnosticCode::InvalidGiveValue,
                            format!(
                                "give symbol `{value}` must reference a module constant; a type is not a value"
                            ),
                            Some(source_ref.clone()),
                        ));
                    vec![format!("unresolved:symbol:{value}")]
                }
            },
            AstExpression::StringLiteral { .. }
            | AstExpression::OptionalSome { .. }
            | AstExpression::OptionalNone { .. }
            | AstExpression::Record { .. }
            | AstExpression::IntLiteral { .. }
            | AstExpression::FloatLiteral { .. }
            | AstExpression::BooleanLiteral { .. }
            | AstExpression::TextConversion { .. }
            | AstExpression::FieldAccess { .. }
            | AstExpression::Unary { .. }
            | AstExpression::Binary { .. }
            | AstExpression::Parenthesized { .. } => vec![
                self.lower_expression_handle(
                    expression,
                    self.output_type.clone().as_deref(),
                    ExpressionContext::Give,
                )
                .handle,
            ],
        }
    }

    fn lower_expression_handle(
        &mut self,
        expression: &AstExpression,
        expected_type: Option<&str>,
        context: ExpressionContext,
    ) -> LoweredExpression {
        let lowered = self.lower_expression_atom_or_air(expression, context);
        self.check_expression_context_type(
            lowered.type_ref.as_deref(),
            expected_type,
            context,
            &expression_source_ref(expression),
        );
        lowered
    }

    fn lower_expression_atom_or_air(
        &mut self,
        expression: &AstExpression,
        context: ExpressionContext,
    ) -> LoweredExpression {
        match expression {
            AstExpression::OptionalSome {
                expression,
                source_ref,
            } => {
                let operand = self.lower_expression_atom_or_air(expression, context);
                let type_ref = format!(
                    "optional:{}",
                    operand.type_ref.as_deref().unwrap_or("unresolved:optional")
                );
                self.lower_optional_expression(
                    AirExpressionKind::OptionalSome,
                    vec![operand.handle],
                    type_ref,
                    source_ref,
                )
            }
            AstExpression::OptionalNone {
                type_ref,
                source_ref,
            } => {
                let inner = self.lower_type_ref(type_ref);
                self.lower_optional_expression(
                    AirExpressionKind::OptionalNone,
                    Vec::new(),
                    format!("optional:{inner}"),
                    source_ref,
                )
            }
            AstExpression::Record {
                type_name,
                fields,
                source_ref,
            } => self.lower_record_expression(type_name, fields, source_ref),
            AstExpression::Value { value, source_ref } => self.lower_value_expression(
                value,
                source_ref,
                context.unresolved_value_code(),
                context.unresolved_value_message(value),
            ),
            AstExpression::StringLiteral { .. } => LoweredExpression {
                handle: expression_handle(expression),
                type_ref: Some(builtin_text()),
                literal_zero: false,
            },
            AstExpression::IntLiteral { value, source_ref } => {
                let parsed = self.validate_int_literal(value, source_ref);
                LoweredExpression {
                    handle: expression_handle(expression),
                    type_ref: Some(builtin_int()),
                    literal_zero: parsed == Some(0),
                }
            }
            AstExpression::FloatLiteral { value, source_ref } => {
                let parsed = self.validate_float_literal(value, source_ref);
                LoweredExpression {
                    handle: expression_handle(expression),
                    type_ref: Some(builtin_float()),
                    literal_zero: parsed == Some(0.0),
                }
            }
            AstExpression::BooleanLiteral { .. } => LoweredExpression {
                handle: expression_handle(expression),
                type_ref: Some(builtin_boolean()),
                literal_zero: false,
            },
            AstExpression::Symbol { value, source_ref } => {
                if let Some(symbol) = self
                    .symbols
                    .get(value)
                    .filter(|symbol| symbol.kind == SymbolKind::Constant)
                {
                    LoweredExpression {
                        handle: symbol.id.clone(),
                        type_ref: symbol.output_type.clone(),
                        literal_zero: false,
                    }
                } else {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::UnsupportedExpression,
                        format!("symbol `{value}` is not a value expression in `EXPR-1`"),
                        Some(source_ref.clone()),
                    ));
                    LoweredExpression::untyped(expression_handle(expression))
                }
            }
            AstExpression::Parenthesized { expression, .. } => {
                self.lower_expression_atom_or_air(expression, context)
            }
            AstExpression::TextConversion {
                expression,
                source_ref,
            } => self.lower_text_conversion_expression(expression, source_ref),
            AstExpression::FieldAccess {
                target,
                field,
                field_source_ref,
                source_ref,
            } => self.lower_field_access_expression(target, field, field_source_ref, source_ref),
            AstExpression::Unary {
                operator,
                operand,
                source_ref,
            } => self.lower_unary_expression(*operator, operand, source_ref),
            AstExpression::Binary {
                left,
                operator,
                right,
                source_ref,
            } => self.lower_binary_expression(left, *operator, right, source_ref),
        }
    }

    fn lower_value_expression(
        &mut self,
        value: &str,
        source_ref: &SourceRef,
        diagnostic_code: AirDiagnosticCode,
        diagnostic_message: String,
    ) -> LoweredExpression {
        if self.local_values.contains(value) {
            LoweredExpression {
                handle: format!("value:{value}"),
                type_ref: self.local_value_types.get(value).cloned(),
                literal_zero: false,
            }
        } else {
            self.diagnostics.push(AirDiagnostic::new(
                diagnostic_code,
                diagnostic_message,
                Some(source_ref.clone()),
            ));
            LoweredExpression::untyped(format!("unresolved:value:{value}"))
        }
    }

    fn lower_optional_expression(
        &mut self,
        kind: AirExpressionKind,
        operands: Vec<String>,
        type_ref: String,
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        let id = self.next_expression_id();
        self.push_air_expression(AirExpression {
            id,
            kind,
            operands,
            type_ref: Some(type_ref),
            source_ref: source_ref.clone(),
            value_ref: None,
            literal_text: None,
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            operator: None,
            field_name: None,
            record_fields: Vec::new(),
        })
    }

    fn lower_text_conversion_expression(
        &mut self,
        expression: &AstExpression,
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        let operand = self.lower_expression_atom_or_air(expression, ExpressionContext::Expression);
        if let Some(type_ref) = operand.type_ref.as_deref()
            && !is_text_renderable_type(type_ref)
            && !self.type_variants.contains_key(type_ref)
        {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidExpressionOperandType,
                format!("text(...) accepts only Text, Boolean, Int, Float or an enum, got `{type_ref}`"),
                Some(source_ref.clone()),
            ));
        }

        let expression_id = self.next_expression_id();
        self.push_air_expression(AirExpression {
            id: expression_id,
            kind: AirExpressionKind::TextConversion,
            value_ref: None,
            literal_text: None,
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            operator: None,
            operands: vec![operand.handle],
            field_name: None,
            record_fields: Vec::new(),
            type_ref: Some(builtin_text()),
            source_ref: source_ref.clone(),
        })
    }

    fn lower_record_expression(
        &mut self,
        type_name: &str,
        fields: &[AstRecordField],
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        let Some((target_type, expected_fields)) = self
            .symbols
            .get(type_name)
            .filter(|symbol| symbol.kind == SymbolKind::Type)
            .and_then(|symbol| {
                self.type_fields
                    .get(&symbol.id)
                    .map(|fields| (symbol.id.clone(), fields.clone()))
            })
        else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnknownRecordType,
                format!("unknown local record type `{type_name}`"),
                Some(source_ref.clone()),
            ));
            return LoweredExpression::untyped(format!(
                "unresolved:record:{type_name}:{}",
                source_ref.start_byte
            ));
        };

        let mut provided = BTreeMap::new();
        for field in fields {
            if !expected_fields.contains_key(&field.name) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownRecordField,
                    format!(
                        "unknown field `{}` on record type `{type_name}`",
                        field.name
                    ),
                    Some(field.source_ref.clone()),
                ));
                continue;
            }
            if provided.insert(field.name.clone(), field).is_some() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateRecordField,
                    format!("record field `{}` is provided more than once", field.name),
                    Some(field.source_ref.clone()),
                ));
            }
        }

        let mut record_fields = Vec::new();
        let mut canonical_expected: Vec<_> = expected_fields.into_iter().collect();
        canonical_expected.sort_by(|left, right| left.0.cmp(&right.0));
        for (name, expected) in canonical_expected {
            let Some(field) = provided.get(&name) else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingRecordField,
                    format!("record type `{type_name}` requires field `{name}`"),
                    Some(source_ref.clone()),
                ));
                continue;
            };
            let lowered =
                self.lower_expression_atom_or_air(&field.value, ExpressionContext::Expression);
            if let (Some(actual), Some(expected)) =
                (lowered.type_ref.as_deref(), expected.type_ref.as_deref())
                && !is_assignable_to(actual, expected)
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::RecordFieldTypeMismatch,
                    format!(
                        "record field `{name}` expects `{expected}` but expression produces `{actual}`"
                    ),
                    Some(expression_source_ref(&field.value)),
                ));
            }
            record_fields.push(AirRecordField {
                name,
                value_ref: lowered.handle,
            });
        }

        let expression_id = self.next_expression_id();
        self.push_air_expression(AirExpression {
            id: expression_id,
            kind: AirExpressionKind::ConstructRecord,
            value_ref: None,
            literal_text: None,
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            operator: None,
            operands: Vec::new(),
            field_name: None,
            record_fields,
            type_ref: Some(target_type),
            source_ref: source_ref.clone(),
        })
    }

    fn lower_field_access_expression(
        &mut self,
        target: &AstExpression,
        field: &str,
        field_source_ref: &SourceRef,
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        if let AstExpression::Symbol { value, .. } = target
            && let Some(symbol) = self
                .symbols
                .get(value)
                .filter(|symbol| symbol.kind == SymbolKind::Type)
            && let Some(variants) = self.type_variants.get(&symbol.id)
        {
            if !variants.contains(field) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownEnumVariant,
                    format!("unknown member `{field}` on enum `{value}`"),
                    Some(field_source_ref.clone()),
                ));
            }
            let type_ref = symbol.id.clone();
            let expression_id = self.next_expression_id();
            return self.push_air_expression(AirExpression {
                id: expression_id,
                kind: AirExpressionKind::EnumValue,
                literal_text: Some(field.to_string()),
                type_ref: Some(type_ref),
                value_ref: None,
                literal_boolean: None,
                literal_int: None,
                literal_float: None,
                operator: None,
                operands: Vec::new(),
                field_name: None,
                record_fields: Vec::new(),
                source_ref: source_ref.clone(),
            });
        }
        let target = self.lower_expression_atom_or_air(target, ExpressionContext::Expression);
        let Some(target_type) = target.type_ref.as_deref() else {
            return self.push_field_access_expression(
                target.handle,
                field,
                None,
                source_ref.clone(),
            );
        };
        let Some(fields) = self.type_fields.get(target_type) else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidExpressionOperandType,
                format!("field access requires a resolved structured type, got `{target_type}`"),
                Some(source_ref.clone()),
            ));
            return self.push_field_access_expression(
                target.handle,
                field,
                None,
                source_ref.clone(),
            );
        };
        let Some(field_ref) = fields.get(field) else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnknownExpressionField,
                format!("unknown field `{field}` on type `{target_type}`"),
                Some(field_source_ref.clone()),
            ));
            return self.push_field_access_expression(
                target.handle,
                field,
                None,
                source_ref.clone(),
            );
        };
        self.push_field_access_expression(
            target.handle,
            field,
            field_ref.type_ref.clone(),
            source_ref.clone(),
        )
    }

    fn push_field_access_expression(
        &mut self,
        target_handle: String,
        field: &str,
        type_ref: Option<String>,
        source_ref: SourceRef,
    ) -> LoweredExpression {
        let expression_id = self.next_expression_id();
        self.push_air_expression(AirExpression {
            id: expression_id,
            kind: AirExpressionKind::FieldAccess,
            value_ref: None,
            literal_text: None,
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            operator: None,
            operands: vec![target_handle],
            field_name: Some(field.to_string()),
            record_fields: Vec::new(),
            type_ref,
            source_ref,
        })
    }

    fn lower_unary_expression(
        &mut self,
        operator: AstUnaryOperator,
        operand: &AstExpression,
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        let operand = self.lower_expression_atom_or_air(operand, ExpressionContext::Expression);
        match operator {
            AstUnaryOperator::Not => {
                self.require_operand_type(
                    operand.type_ref.as_deref(),
                    &builtin_boolean(),
                    "operator `not` expects a Boolean operand",
                    source_ref,
                );
                let expression_id = self.next_expression_id();
                self.push_air_expression(AirExpression {
                    id: expression_id,
                    kind: AirExpressionKind::UnaryOp,
                    value_ref: None,
                    literal_text: None,
                    literal_boolean: None,
                    literal_int: None,
                    literal_float: None,
                    operator: Some(AirExpressionOperator::Not),
                    operands: vec![operand.handle],
                    field_name: None,
                    record_fields: Vec::new(),
                    type_ref: Some(builtin_boolean()),
                    source_ref: source_ref.clone(),
                })
            }
        }
    }

    fn lower_binary_expression(
        &mut self,
        left: &AstExpression,
        operator: AstBinaryOperator,
        right: &AstExpression,
        source_ref: &SourceRef,
    ) -> LoweredExpression {
        let left = self.lower_expression_atom_or_air(left, ExpressionContext::Expression);
        let right = self.lower_expression_atom_or_air(right, ExpressionContext::Expression);
        let result_type = self.binary_result_type(&left, operator, &right, source_ref);
        let operator = air_binary_operator(operator);
        let expression_id = self.next_expression_id();
        self.push_air_expression(AirExpression {
            id: expression_id,
            kind: AirExpressionKind::BinaryOp,
            value_ref: None,
            literal_text: None,
            literal_boolean: None,
            literal_int: None,
            literal_float: None,
            operator: Some(operator),
            operands: vec![left.handle, right.handle],
            field_name: None,
            record_fields: Vec::new(),
            type_ref: result_type,
            source_ref: source_ref.clone(),
        })
    }

    fn binary_result_type(
        &mut self,
        left: &LoweredExpression,
        operator: AstBinaryOperator,
        right: &LoweredExpression,
        source_ref: &SourceRef,
    ) -> Option<String> {
        let left_type = left.type_ref.as_deref();
        let right_type = right.type_ref.as_deref();
        // Unknown types already have a primary resolution/type diagnostic.
        // Do not turn one missing field into errors for every enclosing `++`.
        // A literal zero is independent evidence and must still be reported.
        if left_type.is_none() || right_type.is_none() {
            if right.literal_zero
                && matches!(
                    operator,
                    AstBinaryOperator::Divide | AstBinaryOperator::IntegerDivide | AstBinaryOperator::Modulo
                )
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::StaticExpressionDivisionByZero,
                    "division or modulo by zero is statically detectable",
                    Some(source_ref.clone()),
                ));
            }
            return None;
        }
        match operator {
            AstBinaryOperator::Add | AstBinaryOperator::Subtract | AstBinaryOperator::Multiply => {
                if is_numeric_pair(left_type, right_type) {
                    if left_type == Some(BUILTIN_INT) && right_type == Some(BUILTIN_INT) {
                        Some(builtin_int())
                    } else {
                        Some(builtin_float())
                    }
                } else {
                    self.invalid_operand_type(
                        "numeric operator expects Int or Float operands",
                        source_ref,
                    );
                    None
                }
            }
            AstBinaryOperator::Divide => {
                if right.literal_zero {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::StaticExpressionDivisionByZero,
                        "division by zero is statically detectable",
                        Some(source_ref.clone()),
                    ));
                }
                if is_numeric_pair(left_type, right_type) {
                    Some(builtin_float())
                } else {
                    self.invalid_operand_type(
                        "operator `/` expects Int or Float operands",
                        source_ref,
                    );
                    None
                }
            }
            AstBinaryOperator::Modulo | AstBinaryOperator::IntegerDivide => {
                if right.literal_zero {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::StaticExpressionDivisionByZero,
                        "integer division or modulo by zero is statically detectable",
                        Some(source_ref.clone()),
                    ));
                }
                if left_type == Some(BUILTIN_INT) && right_type == Some(BUILTIN_INT) {
                    Some(builtin_int())
                } else {
                    self.invalid_operand_type("operators `%` and `//` expect Int operands", source_ref);
                    None
                }
            }
            AstBinaryOperator::TextConcat => {
                if left_type == Some(BUILTIN_TEXT) && right_type == Some(BUILTIN_TEXT) {
                    Some(builtin_text())
                } else {
                    self.invalid_operand_type("operator `++` expects Text operands", source_ref);
                    None
                }
            }
            AstBinaryOperator::Equal | AstBinaryOperator::NotEqual => {
                if ![left_type, right_type]
                    .iter()
                    .flatten()
                    .any(|value| value.starts_with("optional:"))
                    && are_equality_compatible(left_type, right_type)
                {
                    Some(builtin_boolean())
                } else {
                    self.invalid_operand_type(
                        "equality operators expect compatible operand types",
                        source_ref,
                    );
                    None
                }
            }
            AstBinaryOperator::LessThan
            | AstBinaryOperator::GreaterThan
            | AstBinaryOperator::LessThanOrEqual
            | AstBinaryOperator::GreaterThanOrEqual => {
                if is_numeric_pair(left_type, right_type) {
                    Some(builtin_boolean())
                } else {
                    self.invalid_operand_type(
                        "order comparisons in `EXPR-1` expect Int or Float operands",
                        source_ref,
                    );
                    None
                }
            }
            AstBinaryOperator::And | AstBinaryOperator::Or => {
                if left_type == Some(BUILTIN_BOOLEAN) && right_type == Some(BUILTIN_BOOLEAN) {
                    Some(builtin_boolean())
                } else {
                    self.invalid_operand_type(
                        "boolean operators expect Boolean operands",
                        source_ref,
                    );
                    None
                }
            }
        }
    }

    fn check_expression_context_type(
        &mut self,
        actual_type: Option<&str>,
        expected_type: Option<&str>,
        context: ExpressionContext,
        source_ref: &SourceRef,
    ) {
        let (Some(actual_type), Some(expected_type)) = (actual_type, expected_type) else {
            return;
        };
        if !is_assignable_to(actual_type, expected_type) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::IncompatibleExpressionType,
                format!(
                    "{} expects `{expected_type}`, got `{actual_type}`",
                    context.label()
                ),
                Some(source_ref.clone()),
            ));
        }
    }

    fn require_operand_type(
        &mut self,
        actual_type: Option<&str>,
        expected_type: &str,
        message: &str,
        source_ref: &SourceRef,
    ) {
        if actual_type.is_some_and(|actual_type| actual_type != expected_type) {
            self.invalid_operand_type(message, source_ref);
        }
    }

    fn invalid_operand_type(&mut self, message: &str, source_ref: &SourceRef) {
        self.diagnostics.push(AirDiagnostic::new(
            AirDiagnosticCode::InvalidExpressionOperandType,
            message.to_string(),
            Some(source_ref.clone()),
        ));
    }

    fn validate_int_literal(&mut self, value: &str, source_ref: &SourceRef) -> Option<i128> {
        match value.parse::<i128>() {
            Ok(parsed) if parsed <= MAX_SAFE_INT => Some(parsed),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidNumericLiteral,
                    format!(
                        "Int literal `{value}` is outside the supported V1 domain [-{MAX_SAFE_INT}, {MAX_SAFE_INT}]"
                    ),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }

    fn validate_float_literal(&mut self, value: &str, source_ref: &SourceRef) -> Option<f64> {
        match value.parse::<f64>() {
            Ok(parsed) if parsed.is_finite() => Some(parsed),
            _ => {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidNumericLiteral,
                    format!("Float literal `{value}` is not finite or not representable"),
                    Some(source_ref.clone()),
                ));
                None
            }
        }
    }

    fn push_air_expression(&mut self, expression: AirExpression) -> LoweredExpression {
        let id = expression.id.clone();
        let handle = format!("expr:{id}");
        let type_ref = expression.type_ref.clone();
        self.expressions.push(expression);
        LoweredExpression {
            handle,
            type_ref,
            literal_zero: false,
        }
    }

    fn lower_stop(&mut self, statement: &AstStopStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Completion,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Stop,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: Vec::new(),
            result_binding: None,
            condition_ref: None,
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        FlowFragment::terminal(node_id, "stop")
    }

    fn lower_match(&mut self, statement: &AstMatchStatement) -> FlowFragment {
        let value = self.lower_expression_atom_or_air(&statement.value, ExpressionContext::Condition);
        let Some(variants) = value.type_ref.as_ref().and_then(|kind| self.type_variants.get(kind)).cloned() else {
            self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::MatchRequiresEnum,
                "match requires a nominal enum value", Some(statement.source_ref.clone())));
            return FlowFragment::empty();
        };
        let mut seen = HashSet::new();
        let mut valid = true;
        for case in &statement.cases {
            let kind = self.symbols.get(&case.type_name).filter(|symbol| symbol.kind == SymbolKind::Type);
            if kind.map(|symbol| symbol.id.as_str()) != value.type_ref.as_deref() {
                valid = false;
                self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::MatchCaseTypeMismatch,
                    format!("case {}.{} does not belong to the matched enum", case.type_name, case.variant), Some(case.source_ref.clone())));
            } else if !variants.contains(&case.variant) {
                valid = false;
                self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::UnknownEnumVariant,
                    format!("unknown enum member {}.{}", case.type_name, case.variant), Some(case.source_ref.clone())));
            } else if !seen.insert(case.variant.clone()) {
                valid = false;
                self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::DuplicateMatchCase,
                    format!("duplicate case {}.{}", case.type_name, case.variant), Some(case.source_ref.clone())));
            }
        }
        let mut missing: Vec<_> = variants.difference(&seen).cloned().collect();
        missing.sort();
        if !missing.is_empty() {
            valid = false;
            self.diagnostics.push(AirDiagnostic::new(AirDiagnosticCode::NonExhaustiveMatch,
                format!("match is missing cases: {}", missing.join(", ")), Some(statement.source_ref.clone())));
        }
        if !valid { return FlowFragment::empty(); }
        // Names containing ':' cannot be written in source. The snapshot is
        // evaluated once and cannot collide with a user binding.
        let name = format!("match:temporary:{}", self.nodes.len());
        let outer_values = self.local_values.clone();
        let outer_types = self.local_value_types.clone();
        let mut snapshot = self.lower_typed_binding(&name, value.type_ref.unwrap(), value.handle, &statement.source_ref);
        let mut branches = statement.cases.last().unwrap().body.clone();
        for case in statement.cases.iter().rev().skip(1) {
            let member = AstExpression::FieldAccess {
                target: Box::new(AstExpression::Symbol { value: case.type_name.clone(), source_ref: case.source_ref.clone() }),
                field: case.variant.clone(), field_source_ref: case.source_ref.clone(), source_ref: case.source_ref.clone(),
            };
            branches = vec![AstStatement::If(AstIfStatement {
                condition: AstExpression::Binary {
                    left: Box::new(AstExpression::Value { value: name.clone(), source_ref: statement.source_ref.clone() }),
                    operator: AstBinaryOperator::Equal, right: Box::new(member), source_ref: case.source_ref.clone(),
                },
                present_binding: None, then_branch: case.body.clone(), else_branch: branches, source_ref: case.source_ref.clone(),
            })];
        }
        let first_node = self.nodes.len();
        let lowered = self.lower_statement_sequence(&branches);
        if let Some(entry) = self.nodes.get(first_node) {
            self.edges.extend(connect_pending_exits(&mut snapshot.exits, &entry.id, statement.source_ref.clone()));
        }
        self.local_values = outer_values;
        self.local_value_types = outer_types;
        FlowFragment { entry_node_id: snapshot.entry_node_id, exits: lowered.exits,
            terminal_reason: lowered.terminal_reason.map(|_| "match") }
    }

    fn lower_if(&mut self, statement: &AstIfStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        let (condition_ref, present_binding) = if let Some(binding) = &statement.present_binding {
            let operand = self
                .lower_expression_atom_or_air(&statement.condition, ExpressionContext::Condition);
            let inner = operand
                .type_ref
                .as_deref()
                .and_then(|value| value.strip_prefix("optional:"));
            if inner.is_none() {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidExpressionOperandType,
                    "if present requires Optional of T",
                    Some(statement.source_ref.clone()),
                ));
            }
            let inner = inner.unwrap_or("unresolved:optional").to_string();
            let condition = self.lower_optional_expression(
                AirExpressionKind::OptionalPresent,
                vec![operand.handle.clone()],
                builtin_boolean(),
                &statement.source_ref,
            );
            let value = self.lower_optional_expression(
                AirExpressionKind::OptionalValue,
                vec![operand.handle],
                inner.clone(),
                &binding.source_ref,
            );
            (
                condition.handle,
                Some((
                    binding.name.clone(),
                    inner,
                    value.handle,
                    binding.source_ref.clone(),
                )),
            )
        } else {
            (self.condition_handle(&statement.condition), None)
        };
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Branch,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Branch,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: Vec::new(),
            result_binding: None,
            condition_ref: Some(condition_ref),
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });

        let then_branch = self.lower_branch_with_binding(
            &node_id,
            AirFlowEdgeRole::True,
            &statement.then_branch,
            present_binding,
        );
        let else_branch =
            self.lower_branch(&node_id, AirFlowEdgeRole::False, &statement.else_branch);
        self.external_effect_possible = self.external_effect_possible
            || then_branch.external_effect_possible
            || else_branch.external_effect_possible;
        let terminal_reason =
            if then_branch.terminal_reason.is_some() && else_branch.terminal_reason.is_some() {
                Some("if")
            } else {
                None
            };
        FlowFragment {
            entry_node_id: Some(node_id),
            exits: [then_branch.exits, else_branch.exits].concat(),
            terminal_reason,
        }
    }

    fn lower_for(&mut self, statement: &AstForStatement) -> FlowFragment {
        let node_id = self.next_node_id();
        let Some((collection_handle, item_type)) = self.collection_handle(&statement.collection)
        else {
            return FlowFragment::empty();
        };
        let item_handle = format!("value:{}", statement.item);
        let outer_values = self.local_values.clone();
        let outer_value_types = self.local_value_types.clone();
        if self
            .declare_local_binding(
                &statement.item,
                &statement.source_ref,
                Some(item_type),
                AirDiagnosticCode::DuplicateResultBinding,
                "loop item",
            )
            .is_none()
        {
            return FlowFragment::empty();
        }
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Loop,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Loop,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: vec![collection_handle.clone(), item_handle],
            result_binding: None,
            condition_ref: Some(format!("loop_has_next:{collection_handle}")),
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });

        let body = self.lower_branch(&node_id, AirFlowEdgeRole::LoopNext, &statement.body);
        self.local_values = outer_values;
        self.local_value_types = outer_value_types;
        self.external_effect_possible =
            self.external_effect_possible || body.external_effect_possible;
        for exit in body.exits {
            self.edges.push(AirFlowEdge {
                from_node_id: exit.node_id,
                to_node_id: node_id.clone(),
                role: if exit.role == AirFlowEdgeRole::Next {
                    AirFlowEdgeRole::LoopNext
                } else {
                    exit.role
                },
                source_ref: Some(statement.source_ref.clone()),
            });
        }

        FlowFragment {
            entry_node_id: Some(node_id.clone()),
            exits: vec![PendingExit {
                node_id,
                role: AirFlowEdgeRole::LoopExit,
            }],
            terminal_reason: None,
        }
    }

    fn lower_while(&mut self, statement: &AstWhileStatement) -> FlowFragment {
        if matches!(&statement.condition, AstExpression::BooleanLiteral { .. }) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvariantLoopCondition,
                "while condition is a manifestly invariant Boolean literal",
                Some(statement.source_ref.clone()),
            ));
        }
        let node_id = self.next_node_id();
        let condition_ref = self.condition_handle(&statement.condition);
        let trace_point = self.push_trace(
            AirTraceAnchorKind::Loop,
            Some(node_id.clone()),
            Some(statement.source_ref.clone()),
        );
        self.nodes.push(AirFlowNode {
            collection_ref: None,
            item_binding: None,
            max_concurrency: None,
            max_items: None,
            id: node_id.clone(),
            kind: AirFlowNodeKind::Loop,
            approval_ref: None,
            approval_mode: None,
            approval_policy: None,
            context_refs: Vec::new(),
            interaction_ref: None,
            interaction_mode: None,
            target_ref: None,
            arguments: Vec::new(),
            result_binding: None,
            condition_ref: Some(condition_ref),
            trace_point_refs: vec![trace_point],
            source_ref: statement.source_ref.clone(),
        });
        let body = self.lower_branch(&node_id, AirFlowEdgeRole::LoopNext, &statement.body);
        self.external_effect_possible =
            self.external_effect_possible || body.external_effect_possible;
        for exit in body.exits {
            self.edges.push(AirFlowEdge {
                from_node_id: exit.node_id,
                to_node_id: node_id.clone(),
                role: if exit.role == AirFlowEdgeRole::Next {
                    AirFlowEdgeRole::LoopNext
                } else {
                    exit.role
                },
                source_ref: Some(statement.source_ref.clone()),
            });
        }
        FlowFragment {
            entry_node_id: Some(node_id.clone()),
            exits: vec![PendingExit {
                node_id,
                role: AirFlowEdgeRole::LoopExit,
            }],
            terminal_reason: None,
        }
    }

    fn lower_branch(
        &mut self,
        from_node_id: &str,
        role: AirFlowEdgeRole,
        statements: &[AstStatement],
    ) -> SequenceFragment {
        self.lower_branch_with_binding(from_node_id, role, statements, None)
    }

    fn lower_branch_with_binding(
        &mut self,
        from_node_id: &str,
        role: AirFlowEdgeRole,
        statements: &[AstStatement],
        binding: Option<(String, String, String, SourceRef)>,
    ) -> SequenceFragment {
        // An absent else is a fallthrough from the branch node, not an empty
        // terminal path. Keep its role until the enclosing sequence connects it.
        if statements.is_empty() && binding.is_none() {
            return SequenceFragment {
                exits: vec![PendingExit {
                    node_id: from_node_id.to_string(),
                    role,
                }],
                terminal_reason: None,
                external_effect_possible: self.external_effect_possible,
            };
        }
        let outer_values = self.local_values.clone();
        let outer_value_types = self.local_value_types.clone();
        let outer_external_effect_possible = self.external_effect_possible;
        let first_node_before = self.nodes.len();
        let prefix = binding.map(|(name, type_ref, handle, source_ref)| {
            self.lower_typed_binding(&name, type_ref, handle, &source_ref)
        });
        let body_first = self.nodes.len();
        let fragment = self.lower_statement_sequence(statements);
        if let Some(prefix) = prefix.as_ref() {
            if let Some(body) = self.nodes.get(body_first) {
                self.edges.push(AirFlowEdge {
                    from_node_id: prefix.entry_node_id.clone().expect("binding has an entry"),
                    to_node_id: body.id.clone(),
                    role: AirFlowEdgeRole::Next,
                    source_ref: statements.first().map(statement_source_ref),
                });
            }
        }
        let branch_external_effect_possible = self.external_effect_possible;
        if let Some(entry_node_id) = self
            .nodes
            .get(first_node_before)
            .map(|node| node.id.clone())
        {
            self.edges.push(AirFlowEdge {
                from_node_id: from_node_id.to_string(),
                to_node_id: entry_node_id,
                role,
                source_ref: statements.first().map(statement_source_ref),
            });
        }
        self.local_values = outer_values;
        self.local_value_types = outer_value_types;
        self.external_effect_possible = outer_external_effect_possible;
        SequenceFragment {
            exits: if statements.is_empty() {
                prefix.map(|value| value.exits).unwrap_or_default()
            } else {
                fragment.exits
            },
            terminal_reason: fragment.terminal_reason,
            external_effect_possible: branch_external_effect_possible,
        }
    }

    fn condition_handle(&mut self, expression: &AstExpression) -> String {
        match expression {
            AstExpression::Value { value, source_ref } => {
                if self.local_values.contains(value) {
                    let actual_type = self.local_value_types.get(value).cloned();
                    self.check_expression_context_type(
                        actual_type.as_deref(),
                        Some(BUILTIN_BOOLEAN),
                        ExpressionContext::Condition,
                        source_ref,
                    );
                    format!("value:{value}")
                } else {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::InvalidBranchCondition,
                        format!("condition `{value}` is not explicit in the local graph scope"),
                        Some(source_ref.clone()),
                    ));
                    format!("unresolved:{value}")
                }
            }
            AstExpression::BooleanLiteral { value, source_ref } => {
                self.check_expression_context_type(
                    Some(BUILTIN_BOOLEAN),
                    Some(BUILTIN_BOOLEAN),
                    ExpressionContext::Condition,
                    source_ref,
                );
                format!("literal:bool:{value}")
            }
            AstExpression::FieldAccess { .. }
            | AstExpression::OptionalSome { .. }
            | AstExpression::OptionalNone { .. }
            | AstExpression::Record { .. }
            | AstExpression::TextConversion { .. }
            | AstExpression::Unary { .. }
            | AstExpression::Binary { .. }
            | AstExpression::Parenthesized { .. }
            | AstExpression::StringLiteral { .. }
            | AstExpression::IntLiteral { .. }
            | AstExpression::FloatLiteral { .. }
            | AstExpression::Symbol { .. } => {
                self.lower_expression_handle(
                    expression,
                    Some(BUILTIN_BOOLEAN),
                    ExpressionContext::Condition,
                )
                .handle
            }
        }
    }

    fn collection_handle(&mut self, expression: &AstExpression) -> Option<(String, String)> {
        let lowered =
            self.lower_expression_handle(expression, None, ExpressionContext::LoopCollection);
        if let Some(item_type) = lowered
            .type_ref
            .as_deref()
            .and_then(|t| t.strip_prefix("list:"))
        {
            Some((lowered.handle, item_type.to_string()))
        } else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidLoopCollection,
                "for loop collection must be a List value in `EXPR-1`",
                Some(expression_source_ref(expression)),
            ));
            None
        }
    }

    fn lower_type_ref(&mut self, type_ref: &AstTypeRef) -> String {
        self.lower_type_ref_raw(&type_ref.raw, &type_ref.source_ref)
    }

    fn lower_type_ref_raw(&mut self, raw: &str, source_ref: &SourceRef) -> String {
        if let Some(inner) = raw.strip_prefix("Optional of ") {
            format!("optional:{}", self.lower_type_ref_raw(inner, source_ref))
        } else if let Some(inner) = raw.strip_prefix("List of ") {
            format!("list:{}", self.lower_type_ref_raw(inner, source_ref))
        } else if let Some(symbol) = self
            .symbols
            .get(raw)
            .filter(|symbol| symbol.kind == SymbolKind::Type)
        {
            symbol.id.clone()
        } else if is_builtin_type_ref(raw) {
            format!("builtin:{raw}")
        } else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::UnknownTypeReference,
                format!("unknown Touba type reference `{raw}`"),
                Some(source_ref.clone()),
            ));
            format!("unresolved:type:{raw}")
        }
    }

    fn next_node_id(&mut self) -> String {
        self.node_counter += 1;
        format!("node:{}:{}", self.graph_id, self.node_counter)
    }

    fn next_expression_id(&mut self) -> String {
        self.expression_counter += 1;
        format!("expression:{}:{}", self.graph_id, self.expression_counter)
    }

    fn push_trace(
        &mut self,
        anchor_kind: AirTraceAnchorKind,
        node_id: Option<String>,
        source_ref: Option<SourceRef>,
    ) -> String {
        self.trace_counter += 1;
        let id = format!("trace:{}:{}", self.graph_id, self.trace_counter);
        self.trace_points.push(AirTracePoint {
            id: id.clone(),
            owner_ref: self.graph_id.to_string(),
            anchor_kind,
            node_id,
            source_ref,
        });
        id
    }
}

struct GraphBuildResult {
    graph: AirFlowGraph,
    trace_points: Vec<AirTracePoint>,
    diagnostics: Vec<AirDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SymbolRef {
    id: String,
    kind: SymbolKind,
    signature_inputs: Vec<SymbolInputRef>,
    output_type: Option<String>,
    imported: bool,
    contract_resolved: bool,
}

impl SymbolRef {
    fn new(id: String, kind: SymbolKind) -> Self {
        Self {
            id,
            kind,
            signature_inputs: Vec::new(),
            output_type: None,
            imported: false,
            contract_resolved: true,
        }
    }

    fn imported(id: String, kind: SymbolKind) -> Self {
        Self {
            id,
            kind,
            signature_inputs: Vec::new(),
            output_type: None,
            imported: true,
            contract_resolved: false,
        }
    }

    fn signature_input_names(&self) -> impl Iterator<Item = &str> {
        self.signature_inputs
            .iter()
            .map(|input| input.name.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SymbolInputRef {
    name: String,
    type_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TypeFieldRef {
    type_ref: Option<String>,
    source_ref: SourceRef,
}

const MAX_SAFE_INT: i128 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
struct LoweredExpression {
    handle: String,
    type_ref: Option<String>,
    literal_zero: bool,
}

impl LoweredExpression {
    fn untyped(handle: String) -> Self {
        Self {
            handle,
            type_ref: None,
            literal_zero: false,
        }
    }
}

#[derive(Debug, Clone)]
enum LoweredTriggerArgumentValue {
    Static {
        value_ref: String,
        actual_type: Option<String>,
    },
    Payload {
        json_path: String,
    },
}

#[derive(Debug, Clone, Copy)]
enum ExpressionContext {
    CallArgument,
    Binding,
    Give,
    Condition,
    LoopCollection,
    UserInteraction,
    Expression,
}

impl ExpressionContext {
    fn unresolved_value_code(self) -> AirDiagnosticCode {
        match self {
            Self::CallArgument => AirDiagnosticCode::UnresolvedCallArgumentValue,
            Self::Binding => AirDiagnosticCode::InvalidGiveValue,
            Self::Give | Self::Expression => AirDiagnosticCode::InvalidGiveValue,
            Self::Condition => AirDiagnosticCode::InvalidBranchCondition,
            Self::LoopCollection => AirDiagnosticCode::InvalidLoopCollection,
            Self::UserInteraction => AirDiagnosticCode::UnresolvedCallArgumentValue,
        }
    }

    fn unresolved_value_message(self, value: &str) -> String {
        match self {
            Self::CallArgument => {
                format!("call argument value `{value}` is not available in this graph scope")
            }
            Self::Binding => {
                format!("bind value `{value}` is not available in this graph scope")
            }
            Self::Give | Self::Expression => {
                format!("give value `{value}` is not explicit in the local graph scope")
            }
            Self::Condition => {
                format!("condition `{value}` is not explicit in the local graph scope")
            }
            Self::LoopCollection => {
                format!("loop collection `{value}` is not explicit in the local graph scope")
            }
            Self::UserInteraction => {
                format!("user interaction value `{value}` is not available in this graph scope")
            }
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::CallArgument => "call argument",
            Self::Binding => "bind",
            Self::Give => "give",
            Self::Condition => "condition",
            Self::LoopCollection => "loop collection",
            Self::UserInteraction => "user interaction",
            Self::Expression => "expression",
        }
    }
}

fn trigger_payload_contract(
    map: BTreeMap<String, String>,
    source_ref: Option<SourceRef>,
) -> Option<AirTriggerPayloadContract> {
    if map.is_empty() {
        return None;
    }
    Some(AirTriggerPayloadContract {
        format: "json".to_string(),
        content_types: vec!["application/json".to_string()],
        max_bytes: 65_536,
        map,
        source_ref: source_ref.unwrap_or(SourceRef {
            source_id: "<generated>".to_string(),
            start_byte: 0,
            end_byte: 0,
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 1,
        }),
    })
}

fn payload_path_segments(expression: &AstExpression) -> Option<Vec<String>> {
    match expression {
        AstExpression::Value { value, .. } if value == "payload" => Some(Vec::new()),
        AstExpression::FieldAccess { target, field, .. } => {
            let mut segments = payload_path_segments(target)?;
            segments.push(field.clone());
            Some(segments)
        }
        AstExpression::Parenthesized { expression, .. } => payload_path_segments(expression),
        _ => None,
    }
}

fn air_binary_operator(operator: AstBinaryOperator) -> AirExpressionOperator {
    match operator {
        AstBinaryOperator::Add => AirExpressionOperator::Add,
        AstBinaryOperator::Subtract => AirExpressionOperator::Subtract,
        AstBinaryOperator::Multiply => AirExpressionOperator::Multiply,
        AstBinaryOperator::Divide => AirExpressionOperator::Divide,
        AstBinaryOperator::IntegerDivide => AirExpressionOperator::IntegerDivide,
        AstBinaryOperator::Modulo => AirExpressionOperator::Modulo,
        AstBinaryOperator::TextConcat => AirExpressionOperator::TextConcat,
        AstBinaryOperator::Equal => AirExpressionOperator::Equal,
        AstBinaryOperator::NotEqual => AirExpressionOperator::NotEqual,
        AstBinaryOperator::LessThan => AirExpressionOperator::LessThan,
        AstBinaryOperator::GreaterThan => AirExpressionOperator::GreaterThan,
        AstBinaryOperator::LessThanOrEqual => AirExpressionOperator::LessThanOrEqual,
        AstBinaryOperator::GreaterThanOrEqual => AirExpressionOperator::GreaterThanOrEqual,
        AstBinaryOperator::And => AirExpressionOperator::And,
        AstBinaryOperator::Or => AirExpressionOperator::Or,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SymbolKind {
    Constant,
    Memory,
    Type,
    Function,
    Tool,
    Skill,
    Agent,
    Strategy,
    Trigger,
}

fn expression_handle(expression: &AstExpression) -> String {
    match expression {
        AstExpression::Record { source_ref, .. } => {
            format!("unsupported:record:expression:{}", source_ref.start_byte)
        }
        AstExpression::Symbol { value, .. } => format!("symbol:{value}"),
        AstExpression::Value { value, .. } => format!("value:{value}"),
        AstExpression::StringLiteral { value, .. } => format!("literal:string:{value}"),
        AstExpression::IntLiteral { value, .. } => format!("literal:int:{value}"),
        AstExpression::FloatLiteral { value, .. } => format!("literal:float:{value}"),
        AstExpression::BooleanLiteral { value, .. } => format!("literal:bool:{value}"),
        AstExpression::FieldAccess { source_ref, .. }
        | AstExpression::OptionalSome { source_ref, .. }
        | AstExpression::OptionalNone { source_ref, .. }
        | AstExpression::TextConversion { source_ref, .. }
        | AstExpression::Unary { source_ref, .. }
        | AstExpression::Binary { source_ref, .. }
        | AstExpression::Parenthesized { source_ref, .. } => {
            format!("unsupported:expression:{}", source_ref.start_byte)
        }
    }
}

fn literal_expression_type(expression: &AstExpression) -> Option<&'static str> {
    match expression {
        AstExpression::StringLiteral { .. } => Some(BUILTIN_TEXT),
        AstExpression::BooleanLiteral { .. } => Some(BUILTIN_BOOLEAN),
        AstExpression::IntLiteral { .. } => Some(BUILTIN_INT),
        AstExpression::FloatLiteral { .. } => Some(BUILTIN_FLOAT),
        _ => None,
    }
}

fn failure_family(value: &str) -> AirFailureFamily {
    match value {
        "business" => AirFailureFamily::Business,
        "authority" => AirFailureFamily::Authority,
        "provider" => AirFailureFamily::Provider,
        "handler" => AirFailureFamily::Handler,
        _ => unreachable!("grammar only admits known failure families"),
    }
}

fn expression_source_ref(expression: &AstExpression) -> SourceRef {
    match expression {
        AstExpression::Symbol { source_ref, .. }
        | AstExpression::OptionalSome { source_ref, .. }
        | AstExpression::OptionalNone { source_ref, .. }
        | AstExpression::Record { source_ref, .. }
        | AstExpression::Value { source_ref, .. }
        | AstExpression::StringLiteral { source_ref, .. }
        | AstExpression::IntLiteral { source_ref, .. }
        | AstExpression::FloatLiteral { source_ref, .. }
        | AstExpression::BooleanLiteral { source_ref, .. }
        | AstExpression::FieldAccess { source_ref, .. }
        | AstExpression::TextConversion { source_ref, .. }
        | AstExpression::Unary { source_ref, .. }
        | AstExpression::Binary { source_ref, .. }
        | AstExpression::Parenthesized { source_ref, .. } => source_ref.clone(),
    }
}

fn statement_source_ref(statement: &AstStatement) -> SourceRef {
    match statement {
        AstStatement::Bind(statement) => statement.source_ref.clone(),
        AstStatement::Call(statement) => statement.source_ref.clone(),
        AstStatement::Parallel(statement) => statement.call.source_ref.clone(),
        AstStatement::HumanApproval(statement) => statement.source_ref.clone(),
        AstStatement::UserInteraction(statement) => statement.source_ref.clone(),
        AstStatement::Give(statement) => statement.source_ref.clone(),
        AstStatement::Stop(statement) => statement.source_ref.clone(),
        AstStatement::If(statement) => statement.source_ref.clone(),
        AstStatement::Match(statement) => statement.source_ref.clone(),
        AstStatement::For(statement) => statement.source_ref.clone(),
        AstStatement::While(statement) => statement.source_ref.clone(),
    }
}
