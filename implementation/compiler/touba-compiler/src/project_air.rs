use std::collections::{HashMap, HashSet};

use crate::air::*;
use crate::ast::SourceRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AirProjectBuildResult {
    pub document: Option<AirDocument>,
    pub diagnostics: Vec<AirDiagnostic>,
}

pub fn assemble_project_air(
    entry_module: impl AsRef<str>,
    documents: &[AirDocument],
) -> AirProjectBuildResult {
    let mut assembler = ProjectAirAssembler::new(entry_module.as_ref(), documents);
    assembler.assemble()
}

struct ProjectAirAssembler<'a> {
    entry_module: &'a str,
    modules: HashMap<String, &'a AirDocument>,
    diagnostics: Vec<AirDiagnostic>,
}

impl<'a> ProjectAirAssembler<'a> {
    fn new(entry_module: &'a str, documents: &'a [AirDocument]) -> Self {
        let mut modules = HashMap::new();
        let mut diagnostics = Vec::new();

        for document in documents {
            if modules
                .insert(document.module.name.clone(), document)
                .is_some()
            {
                diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateProjectModule,
                    format!(
                        "duplicate AIR module `{}` in explicit project input",
                        document.module.name
                    ),
                    Some(document.module.source_ref.clone()),
                ));
            }
        }

        Self {
            entry_module,
            modules,
            diagnostics,
        }
    }

    fn assemble(&mut self) -> AirProjectBuildResult {
        let Some(entry) = self.modules.get(self.entry_module).copied() else {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::ProjectEntryModuleNotFound,
                format!(
                    "entry module `{}` is not present in explicit project input",
                    self.entry_module
                ),
                None,
            ));
            return self.finish(None);
        };

        let mut active_stack = Vec::new();
        let mut visited_modules = HashSet::new();
        self.validate_module_imports(entry, &mut active_stack, &mut visited_modules);

        if !self.diagnostics.is_empty() {
            return self.finish(None);
        }

        let mut assembled = entry.clone();
        let mut collector = ProjectAirCollector::new(&self.modules, &mut assembled);
        collector.collect_module_imports(entry);
        collector.collect_graph_dependencies(entry);
        self.diagnostics.extend(collector.diagnostics);

        if self.diagnostics.is_empty() {
            self.finish(Some(assembled))
        } else {
            self.finish(None)
        }
    }

    fn validate_module_imports(
        &mut self,
        document: &'a AirDocument,
        active_stack: &mut Vec<String>,
        visited_modules: &mut HashSet<String>,
    ) {
        if active_stack.contains(&document.module.name) {
            return;
        }
        if !visited_modules.insert(document.module.name.clone()) {
            return;
        }

        active_stack.push(document.module.name.clone());

        for import in &document.imports {
            if !matches!(
                import.kind.as_str(),
                "type" | "define" | "function" | "tool" | "skill" | "agent" | "strategy" | "memory"
            ) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportKindUnsupported,
                    format!(
                        "project AIR assembly for import kind `{}` is outside supported project imports",
                        import.kind
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            }

            let Some(source_module) = self.modules.get(&import.from_module).copied() else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportModuleNotFound,
                    format!(
                        "import `{}` references missing module `{}`",
                        import.name, import.from_module
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            };

            if active_stack.contains(&source_module.module.name) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportCycleDetected,
                    format!(
                        "import `{}` creates an unsupported IM-1 module cycle through `{}`",
                        import.name, source_module.module.name
                    ),
                    Some(import.source_ref.clone()),
                ));
                continue;
            }

            self.validate_import_target(import, source_module);
            self.validate_module_imports(source_module, active_stack, visited_modules);
        }

        active_stack.pop();
    }

    fn validate_import_target(&mut self, import: &AirImport, source_module: &AirDocument) {
        if declaration_exists(
            source_module,
            import.kind.as_str(),
            import.target_ref.as_str(),
        ) {
            return;
        }

        if declaration_name_exists(source_module, import.name.as_str()) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::ImportKindMismatch,
                format!(
                    "import `{}` from `{}` requests kind `{}` but the source declaration has a different kind",
                    import.name, import.from_module, import.kind
                ),
                Some(import.source_ref.clone()),
            ));
            return;
        }

        self.diagnostics.push(AirDiagnostic::new(
            AirDiagnosticCode::ImportDeclarationNotFound,
            format!(
                "import `{}` references no `{}` declaration in module `{}`",
                import.name, import.kind, import.from_module
            ),
            Some(import.source_ref.clone()),
        ));
    }

    fn finish(&self, document: Option<AirDocument>) -> AirProjectBuildResult {
        AirProjectBuildResult {
            document,
            diagnostics: self.diagnostics.clone(),
        }
    }
}

struct ProjectAirCollector<'a, 'b> {
    modules: &'a HashMap<String, &'a AirDocument>,
    assembled: &'b mut AirDocument,
    seen_imports: HashSet<String>,
    seen_definitions: HashSet<String>,
    seen_graphs: HashSet<String>,
    seen_traces: HashSet<String>,
    active_refs: Vec<String>,
    diagnostics: Vec<AirDiagnostic>,
}

impl<'a, 'b> ProjectAirCollector<'a, 'b> {
    fn new(modules: &'a HashMap<String, &'a AirDocument>, assembled: &'b mut AirDocument) -> Self {
        let seen_imports = assembled
            .imports
            .iter()
            .map(|import| import.target_ref.clone())
            .collect();
        let seen_definitions = local_definition_ids(&assembled.definitions);
        let seen_graphs = assembled
            .execution_graphs
            .iter()
            .map(|graph| graph.id.clone())
            .collect();
        let seen_traces = assembled
            .trace_points
            .iter()
            .map(|trace| trace.id.clone())
            .collect();

        Self {
            modules,
            assembled,
            seen_imports,
            seen_definitions,
            seen_graphs,
            seen_traces,
            active_refs: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn collect_module_imports(&mut self, document: &AirDocument) {
        for import in &document.imports {
            if self.seen_imports.insert(import.target_ref.clone()) {
                self.assembled.imports.push(import.clone());
            }
            self.include_ref(import.target_ref.as_str(), Some(&import.source_ref));
            if let Some(source_module) = self.modules.get(&import.from_module).copied() {
                self.collect_module_imports(source_module);
            }
        }
    }

    fn collect_graph_dependencies(&mut self, document: &AirDocument) {
        for graph in &document.execution_graphs {
            self.include_graph_dependencies(graph);
        }
        for trigger in &document.definitions.triggers {
            self.include_ref(trigger.target_ref.as_str(), Some(&trigger.source_ref));
            self.validate_trigger_arguments(trigger);
        }
    }

    fn include_ref(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        if self.seen_definitions.contains(target_ref) {
            return;
        }
        if self.active_refs.iter().any(|active| active == target_ref) {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::ImportCycleDetected,
                format!("definition dependency cycle detected at `{target_ref}`"),
                source_ref.cloned(),
            ));
            return;
        }

        self.active_refs.push(target_ref.to_string());
        match declaration_kind_from_ref(target_ref) {
            Some("type") => self.include_type(target_ref, source_ref),
            Some("constant") => self.include_constant(target_ref, source_ref),
            Some("function") => self.include_function(target_ref, source_ref),
            Some("tool") => self.include_tool(target_ref, source_ref),
            Some("skill") => self.include_skill(target_ref, source_ref),
            Some("agent") => self.include_agent(target_ref, source_ref),
            Some("strategy") => self.include_strategy(target_ref, source_ref),
            Some("memory") => self.include_memory(target_ref, source_ref),
            _ => {}
        }
        self.active_refs.pop();
    }

    fn include_type(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_type(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        for field in &declaration.fields {
            self.include_type_ref(field.type_ref.as_str(), Some(&field.source_ref));
        }

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled.definitions.types.push(declaration.clone());
        }
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_constant(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_constant(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        self.include_type_ref(declaration.type_ref.as_str(), Some(&declaration.source_ref));

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled
                .definitions
                .constants
                .push(declaration.clone());
        }
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_function(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_function(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        if let Some(output_type) = declaration.signature.output_type.as_deref() {
            self.include_type_ref(output_type, Some(&declaration.source_ref));
        }
        for input in &declaration.signature.inputs {
            self.include_type_ref(input.type_ref.as_str(), Some(&input.source_ref));
        }

        let graph = self.modules.get(module_name.as_str()).and_then(|document| {
            document
                .execution_graphs
                .iter()
                .find(|graph| graph.id == declaration.body_graph_ref)
                .cloned()
        });
        let Some(graph) = graph else {
            self.push_missing_dependency(
                declaration.body_graph_ref.as_str(),
                Some(&declaration.source_ref),
            );
            return;
        };

        self.validate_pure_imported_function(&declaration, &graph);
        self.include_graph_dependencies(&graph);

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled
                .definitions
                .functions
                .push(declaration.clone());
        }
        self.include_graph(&graph);
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_tool(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_tool(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        self.include_signature(&declaration.signature, Some(&declaration.source_ref));
        self.include_memory_accesses(&declaration.memory_accesses);

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled.definitions.tools.push(declaration.clone());
        }
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_skill(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_skill(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        self.include_signature(&declaration.signature, Some(&declaration.source_ref));
        self.include_use_refs(&declaration.use_refs);
        self.include_memory_scopes(&declaration.memory_scopes);

        let graph = self.modules.get(module_name.as_str()).and_then(|document| {
            document
                .execution_graphs
                .iter()
                .find(|graph| graph.id == declaration.flow_graph_ref)
                .cloned()
        });
        let Some(graph) = graph else {
            self.push_missing_dependency(
                declaration.flow_graph_ref.as_str(),
                Some(&declaration.source_ref),
            );
            return;
        };
        self.include_graph_dependencies(&graph);

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled.definitions.skills.push(declaration.clone());
        }
        self.include_graph(&graph);
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_agent(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_agent(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        self.include_use_refs(&declaration.use_refs);
        self.include_memory_scopes(&declaration.memory_scopes);
        self.validate_callable_by_refs(&declaration);

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled.definitions.agents.push(declaration.clone());
        }
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_strategy(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_strategy(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        if let Some(signature) = declaration.signature.as_ref() {
            self.include_signature(signature, Some(&declaration.source_ref));
        }
        self.include_use_refs(&declaration.use_refs);
        self.include_memory_scopes(&declaration.memory_scopes);

        let graph = self.modules.get(module_name.as_str()).and_then(|document| {
            document
                .execution_graphs
                .iter()
                .find(|graph| graph.id == declaration.flow_graph_ref)
                .cloned()
        });
        let Some(graph) = graph else {
            self.push_missing_dependency(
                declaration.flow_graph_ref.as_str(),
                Some(&declaration.source_ref),
            );
            return;
        };
        self.include_graph_dependencies(&graph);

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled
                .definitions
                .strategies
                .push(declaration.clone());
        }
        self.include_graph(&graph);
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_memory(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        let Some((module_name, declaration)) = self.find_memory(target_ref) else {
            self.push_missing_dependency(target_ref, source_ref);
            return;
        };

        if self.seen_definitions.insert(declaration.id.clone()) {
            self.assembled
                .definitions
                .memories
                .push(declaration.clone());
        }
        self.collect_module_imports_by_name(module_name.as_str());
    }

    fn include_signature(&mut self, signature: &AirSignature, source_ref: Option<&SourceRef>) {
        if let Some(output_type) = signature.output_type.as_deref() {
            self.include_type_ref(output_type, source_ref);
        }
        for input in &signature.inputs {
            self.include_type_ref(input.type_ref.as_str(), Some(&input.source_ref));
        }
    }

    fn include_use_refs(&mut self, use_refs: &[AirUseRef]) {
        for usage in use_refs {
            self.include_ref(usage.target_ref.as_str(), Some(&usage.source_ref));
        }
    }

    fn include_memory_scopes(&mut self, scopes: &[AirMemoryScope]) {
        for scope in scopes {
            self.include_ref(scope.memory_ref.as_str(), Some(&scope.source_ref));
        }
    }

    fn include_memory_accesses(&mut self, accesses: &[AirMemoryAccess]) {
        for access in accesses {
            self.include_ref(access.memory_ref.as_str(), Some(&access.source_ref));
        }
    }

    fn validate_callable_by_refs(&mut self, declaration: &AirAgent) {
        for caller in &declaration.callable_by {
            if !declaration_exists_by_ref(self.modules, caller.caller_ref.as_str()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::ImportDeclarationNotFound,
                    format!(
                        "agent `{}` declares callable_by caller `{}` that is not present in the assembled project",
                        declaration.id, caller.caller_ref
                    ),
                    Some(caller.source_ref.clone()),
                ));
            }
        }
    }

    fn validate_agent_call_authority(
        &mut self,
        caller_ref: &str,
        agent_ref: &str,
        source_ref: Option<&SourceRef>,
    ) {
        let Some((_, agent)) = self.find_agent(agent_ref) else {
            return;
        };
        let allowed = agent
            .callable_by
            .iter()
            .any(|rule| rule.caller_ref == caller_ref);
        if !allowed {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::AgentCallerNotAllowed,
                format!(
                    "`{caller_ref}` cannot call agent `{agent_ref}` without a matching `callable_by` rule"
                ),
                source_ref.cloned(),
            ));
        }
    }

    fn validate_pure_imported_function(&mut self, declaration: &AirFunction, graph: &AirFlowGraph) {
        for node in &graph.nodes {
            match node.kind {
                AirFlowNodeKind::CallFunction
                | AirFlowNodeKind::Bind
                | AirFlowNodeKind::Branch
                | AirFlowNodeKind::Loop
                | AirFlowNodeKind::Give
                | AirFlowNodeKind::Stop => {}
                AirFlowNodeKind::CallTool
                | AirFlowNodeKind::CallSkill
                | AirFlowNodeKind::CallAgent
                | AirFlowNodeKind::HumanApproval
                | AirFlowNodeKind::UserInteraction
                | AirFlowNodeKind::Fallback => {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::ImportFunctionNotPure,
                        format!(
                            "imported function `{}` is not pure enough for IM-1 because its graph contains `{}`",
                            declaration.id,
                            flow_node_kind_label(node.kind)
                        ),
                        Some(node.source_ref.clone()),
                    ));
                }
            }
        }
    }

    fn include_graph_dependencies(&mut self, graph: &AirFlowGraph) {
        for node in &graph.nodes {
            if let Some(target_ref) = node.target_ref.as_deref() {
                if node.kind == AirFlowNodeKind::CallAgent {
                    self.validate_agent_call_authority(
                        graph.owner_ref.as_str(),
                        target_ref,
                        Some(&node.source_ref),
                    );
                }
                if node.kind == AirFlowNodeKind::CallTool {
                    self.validate_tool_memory_access(
                        graph.owner_ref.as_str(),
                        target_ref,
                        Some(&node.source_ref),
                    );
                }
                self.include_ref(target_ref, Some(&node.source_ref));
            }
            for argument in &node.arguments {
                self.include_value_ref(argument, Some(&node.source_ref));
            }
            if let Some(condition_ref) = node.condition_ref.as_deref() {
                self.include_value_ref(condition_ref, Some(&node.source_ref));
            }
        }
        for expression in &graph.expressions {
            if let Some(value_ref) = expression.value_ref.as_deref() {
                self.include_value_ref(value_ref, Some(&expression.source_ref));
            }
            if let Some(type_ref) = expression.type_ref.as_deref() {
                self.include_type_ref(type_ref, Some(&expression.source_ref));
            }
            for operand in &expression.operands {
                self.include_value_ref(operand, Some(&expression.source_ref));
            }
        }
    }

    fn include_graph(&mut self, graph: &AirFlowGraph) {
        if self.seen_graphs.insert(graph.id.clone()) {
            self.assembled.execution_graphs.push(graph.clone());
        }
        for trace in self
            .modules
            .values()
            .flat_map(|document| document.trace_points.iter())
            .filter(|trace| trace.owner_ref == graph.id)
        {
            if self.seen_traces.insert(trace.id.clone()) {
                self.assembled.trace_points.push(trace.clone());
            }
        }
    }

    fn include_type_ref(&mut self, type_ref: &str, source_ref: Option<&SourceRef>) {
        if let Some(inner) = type_ref.strip_prefix("list:") {
            self.include_type_ref(inner, source_ref);
            return;
        }
        if type_ref.starts_with("type:") {
            self.include_ref(type_ref, source_ref);
        }
    }

    fn include_value_ref(&mut self, value_ref: &str, source_ref: Option<&SourceRef>) {
        if value_ref.starts_with("constant:")
            || value_ref.starts_with("function:")
            || value_ref.starts_with("type:")
            || value_ref.starts_with("tool:")
            || value_ref.starts_with("skill:")
            || value_ref.starts_with("agent:")
            || value_ref.starts_with("strategy:")
            || value_ref.starts_with("memory:")
        {
            self.include_ref(value_ref, source_ref);
        }
    }

    fn collect_module_imports_by_name(&mut self, module_name: &str) {
        if let Some(document) = self.modules.get(module_name).copied() {
            self.collect_module_imports(document);
        }
    }

    fn find_type(&self, id: &str) -> Option<(String, AirType)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .types
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_constant(&self, id: &str) -> Option<(String, AirConstant)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .constants
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_function(&self, id: &str) -> Option<(String, AirFunction)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .functions
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_tool(&self, id: &str) -> Option<(String, AirTool)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .tools
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn owner_memory_scopes(&self, owner_ref: &str) -> Vec<AirMemoryScope> {
        self.modules
            .values()
            .find_map(|document| {
                document
                    .definitions
                    .skills
                    .iter()
                    .find(|declaration| declaration.id == owner_ref)
                    .map(|declaration| declaration.memory_scopes.clone())
                    .or_else(|| {
                        document
                            .definitions
                            .agents
                            .iter()
                            .find(|declaration| declaration.id == owner_ref)
                            .map(|declaration| declaration.memory_scopes.clone())
                    })
                    .or_else(|| {
                        document
                            .definitions
                            .strategies
                            .iter()
                            .find(|declaration| declaration.id == owner_ref)
                            .map(|declaration| declaration.memory_scopes.clone())
                    })
            })
            .unwrap_or_default()
    }

    fn validate_tool_memory_access(
        &mut self,
        owner_ref: &str,
        tool_ref: &str,
        source_ref: Option<&SourceRef>,
    ) {
        let Some((_, tool)) = self.find_tool(tool_ref) else {
            return;
        };
        if tool.memory_accesses.is_empty() {
            return;
        }
        let owner_scopes = self.owner_memory_scopes(owner_ref);
        for access in &tool.memory_accesses {
            let allowed = owner_scopes.iter().any(|scope| {
                scope.memory_ref == access.memory_ref && scope.access == access.access
            });
            if !allowed {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::OwnerMemoryScopeMissing,
                    format!(
                        "`{owner_ref}` cannot access `{}` with `{}` without an explicit memory scope",
                        access.memory_ref, access.access
                    ),
                    source_ref.cloned(),
                ));
            }
        }
    }

    fn validate_trigger_arguments(&mut self, trigger: &AirTrigger) {
        let Some((_, strategy)) = self.find_strategy(trigger.target_ref.as_str()) else {
            return;
        };
        let signature = strategy.signature.unwrap_or(AirSignature {
            inputs: Vec::new(),
            output_type: None,
        });
        let mut by_name: HashSet<String> = HashSet::new();

        if let Some(payload) = &trigger.payload
            && trigger.event.kind != "request"
        {
            self.diagnostics.push(AirDiagnostic::new(
                AirDiagnosticCode::InvalidTriggerArgument,
                "trigger payload mappings are only valid for request triggers",
                Some(payload.source_ref.clone()),
            ));
        }

        for argument in &trigger.arguments {
            if !by_name.insert(argument.input.clone()) {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::DuplicateTriggerArgument,
                    format!(
                        "trigger argument `{}` is provided more than once",
                        argument.input
                    ),
                    Some(argument.source_ref.clone()),
                ));
            }
            if !signature
                .inputs
                .iter()
                .any(|input| input.name == argument.input)
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::UnknownTriggerArgument,
                    format!(
                        "trigger argument `{}` does not match target strategy `{}`",
                        argument.input, trigger.target_ref
                    ),
                    Some(argument.source_ref.clone()),
                ));
            }
        }

        if let Some(payload) = &trigger.payload {
            for input_name in payload.map.keys() {
                if !by_name.insert(input_name.clone()) {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::DuplicateTriggerArgument,
                        format!("trigger argument `{input_name}` is provided more than once"),
                        Some(payload.source_ref.clone()),
                    ));
                }
                if !signature
                    .inputs
                    .iter()
                    .any(|input| input.name == *input_name)
                {
                    self.diagnostics.push(AirDiagnostic::new(
                        AirDiagnosticCode::UnknownTriggerArgument,
                        format!(
                            "trigger argument `{input_name}` does not match target strategy `{}`",
                            trigger.target_ref
                        ),
                        Some(payload.source_ref.clone()),
                    ));
                }
            }
        }

        for input in &signature.inputs {
            if trigger
                .payload
                .as_ref()
                .is_some_and(|payload| payload.map.contains_key(&input.name))
            {
                continue;
            }

            let Some(argument) = trigger.arguments.iter().find(|arg| arg.input == input.name)
            else {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::MissingTriggerArgument,
                    format!(
                        "trigger `{}` must provide strategy argument `{}`",
                        trigger.name, input.name
                    ),
                    Some(trigger.source_ref.clone()),
                ));
                continue;
            };
            if let Some(actual_type) = trigger_value_ref_type(argument.value_ref.as_str())
                && !trigger_argument_assignable(actual_type, input.type_ref.as_str())
            {
                self.diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::InvalidTriggerArgument,
                    format!(
                        "trigger argument `{}` has type `{actual_type}` but target strategy expects `{}`",
                        input.name, input.type_ref
                    ),
                    Some(argument.source_ref.clone()),
                ));
            }
        }
    }

    fn find_skill(&self, id: &str) -> Option<(String, AirSkill)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .skills
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_agent(&self, id: &str) -> Option<(String, AirAgent)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .agents
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_strategy(&self, id: &str) -> Option<(String, AirStrategy)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .strategies
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn find_memory(&self, id: &str) -> Option<(String, AirMemory)> {
        self.modules.values().find_map(|document| {
            document
                .definitions
                .memories
                .iter()
                .find(|declaration| declaration.id == id)
                .map(|declaration| (document.module.name.clone(), declaration.clone()))
        })
    }

    fn push_missing_dependency(&mut self, target_ref: &str, source_ref: Option<&SourceRef>) {
        self.diagnostics.push(AirDiagnostic::new(
            AirDiagnosticCode::ImportDeclarationNotFound,
            format!("project AIR assembly cannot resolve dependency `{target_ref}`"),
            source_ref.cloned(),
        ));
    }
}

fn declaration_exists(document: &AirDocument, kind: &str, target_ref: &str) -> bool {
    match kind {
        "type" => document
            .definitions
            .types
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "define" => document
            .definitions
            .constants
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "function" => document
            .definitions
            .functions
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "tool" => document
            .definitions
            .tools
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "skill" => document
            .definitions
            .skills
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "agent" => document
            .definitions
            .agents
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "strategy" => document
            .definitions
            .strategies
            .iter()
            .any(|declaration| declaration.id == target_ref),
        "memory" => document
            .definitions
            .memories
            .iter()
            .any(|declaration| declaration.id == target_ref),
        _ => false,
    }
}

fn declaration_exists_by_ref(modules: &HashMap<String, &AirDocument>, target_ref: &str) -> bool {
    modules
        .values()
        .any(|document| match declaration_kind_from_ref(target_ref) {
            Some("type") => document
                .definitions
                .types
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("constant") => document
                .definitions
                .constants
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("function") => document
                .definitions
                .functions
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("tool") => document
                .definitions
                .tools
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("skill") => document
                .definitions
                .skills
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("agent") => document
                .definitions
                .agents
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("strategy") => document
                .definitions
                .strategies
                .iter()
                .any(|declaration| declaration.id == target_ref),
            Some("memory") => document
                .definitions
                .memories
                .iter()
                .any(|declaration| declaration.id == target_ref),
            _ => false,
        })
}

fn declaration_name_exists(document: &AirDocument, name: &str) -> bool {
    document
        .definitions
        .types
        .iter()
        .any(|declaration| declaration.name == name)
        || document
            .definitions
            .constants
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .functions
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .tools
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .skills
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .agents
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .strategies
            .iter()
            .any(|declaration| declaration.name == name)
        || document
            .definitions
            .memories
            .iter()
            .any(|declaration| declaration.name == name)
}

fn local_definition_ids(definitions: &AirDefinitions) -> HashSet<String> {
    let mut ids = HashSet::new();
    ids.extend(
        definitions
            .types
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .constants
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .functions
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .tools
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .skills
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .agents
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .strategies
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .memories
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids.extend(
        definitions
            .triggers
            .iter()
            .map(|declaration| declaration.id.clone()),
    );
    ids
}

fn declaration_kind_from_ref(target_ref: &str) -> Option<&str> {
    target_ref.split_once(':').map(|(kind, _)| kind)
}

fn trigger_value_ref_type(value_ref: &str) -> Option<&'static str> {
    if value_ref.starts_with("literal:string:") {
        Some("builtin:Text")
    } else if value_ref.starts_with("literal:bool:") {
        Some("builtin:Boolean")
    } else if value_ref.starts_with("literal:int:") {
        Some("builtin:Int")
    } else if value_ref.starts_with("literal:float:") {
        Some("builtin:Float")
    } else {
        None
    }
}

fn trigger_argument_assignable(actual_type: &str, expected_type: &str) -> bool {
    actual_type == expected_type
        || (actual_type == "builtin:Int" && expected_type == "builtin:Float")
}

fn flow_node_kind_label(kind: AirFlowNodeKind) -> &'static str {
    match kind {
        AirFlowNodeKind::CallFunction => "call_function",
        AirFlowNodeKind::CallTool => "call_tool",
        AirFlowNodeKind::CallSkill => "call_skill",
        AirFlowNodeKind::CallAgent => "call_agent",
        AirFlowNodeKind::Bind => "bind",
        AirFlowNodeKind::HumanApproval => "human_approval",
        AirFlowNodeKind::UserInteraction => "user_interaction",
        AirFlowNodeKind::Branch => "branch",
        AirFlowNodeKind::Loop => "loop",
        AirFlowNodeKind::Give => "give",
        AirFlowNodeKind::Stop => "stop",
        AirFlowNodeKind::Fallback => "fallback",
    }
}
