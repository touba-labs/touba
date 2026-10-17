use std::collections::BTreeMap;

use crate::ast::SourceRef;
use serde::{Deserialize, Serialize};

pub const AIR_SCHEMA_VERSION: &str = "touba-air-v1";
pub const AIR_CAPABILITY_PROFILE: &str = "touba-air-capabilities-v1";
pub const AIR_JSON_PROFILE: &str = "touba-air-json-canonical-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirDocument {
    pub air_schema_version: String,
    pub air_capability_profile: String,
    pub air_json_profile: String,
    pub module: AirModule,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub imports: Vec<AirImport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budgets: Option<AirBudgets>,
    pub definitions: AirDefinitions,
    pub execution_graphs: Vec<AirFlowGraph>,
    pub trace_points: Vec<AirTracePoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AirBudgets {
    pub run: BTreeMap<String, AirRunLimit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AirRunLimit {
    pub value: u64,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirModule {
    pub id: String,
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirImport {
    pub kind: String,
    pub name: String,
    pub from_module: String,
    pub target_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AirDefinitions {
    pub types: Vec<AirType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memories: Vec<AirMemory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constants: Vec<AirConstant>,
    pub functions: Vec<AirFunction>,
    pub tools: Vec<AirTool>,
    pub skills: Vec<AirSkill>,
    pub agents: Vec<AirAgent>,
    pub strategies: Vec<AirStrategy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<AirTrigger>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirConstant {
    pub id: String,
    pub name: String,
    pub type_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_boolean: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_int: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_float: Option<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirMemory {
    pub id: String,
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirType {
    pub id: String,
    pub name: String,
    pub fields: Vec<AirTypeField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<AirEnumVariant>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirEnumVariant {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTypeField {
    pub name: String,
    pub type_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirSignature {
    pub inputs: Vec<AirParameter>,
    pub output_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirParameter {
    pub name: String,
    pub type_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirFunction {
    pub id: String,
    pub name: String,
    pub signature: AirSignature,
    pub body_graph_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTool {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub signature: AirSignature,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_secrets: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_accesses: Vec<AirMemoryAccess>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_path_refs: Vec<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirUseRef {
    pub target_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirMemoryAccess {
    pub memory_ref: String,
    pub access: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirMemoryScope {
    pub memory_ref: String,
    pub access: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirSkill {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub signature: AirSignature,
    pub uses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub use_refs: Vec<AirUseRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_scopes: Vec<AirMemoryScope>,
    pub flow_graph_ref: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_path_refs: Vec<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirAgent {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub responsibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<AirSignature>,
    pub uses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub use_refs: Vec<AirUseRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub callable_by: Vec<AirCallableBy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_scopes: Vec<AirMemoryScope>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirCallableBy {
    pub caller_ref: String,
    pub caller_kind: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirStrategy {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub uses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub use_refs: Vec<AirUseRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_scopes: Vec<AirMemoryScope>,
    pub flow_graph_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<AirSignature>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTrigger {
    pub id: String,
    pub name: String,
    pub event: AirTriggerEvent,
    pub target_ref: String,
    pub target_kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<AirTriggerArgument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<AirTriggerPayloadContract>,
    pub limits: AirTriggerLimits,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTriggerEvent {
    pub kind: String,
    pub value: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTriggerArgument {
    pub input: String,
    pub value_ref: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTriggerPayloadContract {
    pub format: String,
    pub content_types: Vec<String>,
    pub max_bytes: u64,
    pub map: BTreeMap<String, String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTriggerLimits {
    pub max_runs_per_day: u64,
    pub timeout_ms: u64,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirFlowGraph {
    pub id: String,
    pub owner_ref: String,
    pub entry_node_id: String,
    pub nodes: Vec<AirFlowNode>,
    pub edges: Vec<AirFlowEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expressions: Vec<AirExpression>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_paths: Vec<AirFailurePath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_path_refs: Vec<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirFlowNode {
    pub id: String,
    pub kind: AirFlowNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<AirHumanApprovalMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_mode: Option<AirUserInteractionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_binding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_binding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_items: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace_point_refs: Vec<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirFlowNodeKind {
    CallFunction,
    CallTool,
    CallSkill,
    CallStrategy,
    CallAgent,
    ParallelCall,
    Bind,
    HumanApproval,
    UserInteraction,
    Branch,
    Loop,
    Give,
    Stop,
    Fallback,
}

impl AirFlowNodeKind {
    /// Closed allow-list shared by local lowering and imported-function checks.
    pub fn is_pure_function_node(self) -> bool {
        matches!(
            self,
            Self::CallFunction | Self::Bind | Self::Branch | Self::Loop | Self::Give | Self::Stop
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirHumanApprovalMode {
    RequiredApproval,
    AgentReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirUserInteractionMode {
    Show,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirFlowEdge {
    pub from_node_id: String,
    pub to_node_id: String,
    pub role: AirFlowEdgeRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirExpression {
    pub id: String,
    pub kind: AirExpressionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_boolean: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_int: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_float: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<AirExpressionOperator>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operands: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub record_fields: Vec<AirRecordField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_ref: Option<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirRecordField {
    pub name: String,
    pub value_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirExpressionKind {
    OptionalSome,
    OptionalNone,
    OptionalPresent,
    OptionalValue,
    EnumValue,
    ValueRef,
    LiteralText,
    LiteralBoolean,
    LiteralInt,
    LiteralFloat,
    TextConversion,
    FieldAccess,
    ConstructRecord,
    UnaryOp,
    BinaryOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirExpressionOperator {
    Not,
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
    TextConcat,
    Equal,
    NotEqual,
    LessThan,
    GreaterThan,
    LessThanOrEqual,
    GreaterThanOrEqual,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirFlowEdgeRole {
    Next,
    True,
    False,
    LoopNext,
    LoopExit,
    Failure,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirFailurePath {
    pub id: String,
    pub scope_ref: String,
    pub trigger_node_id: String,
    pub mode: AirFailureMode,
    pub failure_family: AirFailureFamily,
    pub target_node_id: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirFailureFamily {
    Business,
    Authority,
    Provider,
    Handler,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirFailureMode {
    Fallback,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirTracePoint {
    pub id: String,
    pub owner_ref: String,
    pub anchor_kind: AirTraceAnchorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<SourceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AirTraceAnchorKind {
    ScopeEntry,
    ScopeExit,
    Call,
    Branch,
    Loop,
    Binding,
    HumanApproval,
    UserInteraction,
    Failure,
    Fallback,
    Completion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AirDiagnostic {
    pub code: AirDiagnosticCode,
    pub message: String,
    pub source_ref: Option<SourceRef>,
}

impl AirDiagnostic {
    pub fn new(
        code: AirDiagnosticCode,
        message: impl Into<String>,
        source_ref: Option<SourceRef>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            source_ref,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AirDiagnosticCode {
    AstError,
    InvalidRunLimits,
    InvalidTextLiteral,
    DuplicateDefinition,
    MissingExecutableBody,
    MissingSignatureOutput,
    EmptyFlowGraph,
    UnknownReference,
    InvalidBranchCondition,
    InvalidLoopCollection,
    InvariantLoopCondition,
    UnknownTypeReference,
    MissingGiveValue,
    InvalidGiveValue,
    UnsupportedEnrichedCall,
    MissingExplicitCallArgument,
    UnknownCallArgument,
    DuplicateCallArgument,
    UnresolvedCallArgumentValue,
    DuplicateResultBinding,
    EnrichedAgentCallBlocked,
    StrategyInterfaceRequired,
    MissingAgentInterfaceOutput,
    MissingHumanApprovalContextArgument,
    MissingHumanApprovalDecisionBinding,
    UnknownHumanApprovalArgument,
    HumanApprovalInFunction,
    MissingUserInteractionMessageArgument,
    MissingUserInteractionPromptArgument,
    MissingUserInteractionResultBinding,
    UnexpectedUserInteractionResultBinding,
    UnknownUserInteractionArgument,
    UserInteractionInFunction,
    UnknownToolCapability,
    DuplicateToolCapability,
    DuplicateToolSecret,
    MissingToolSecretReadCapability,
    InvalidCallableByCallerKind,
    UnknownCallableByCaller,
    DuplicateCallableByRule,
    AgentCallerNotAllowed,
    UnknownMemoryReference,
    InvalidMemoryAccess,
    DuplicateMemoryDeclaration,
    DuplicateMemoryScope,
    DuplicateToolMemoryAccess,
    MissingMemoryReadCapability,
    MissingMemoryWriteCapability,
    OwnerMemoryScopeMissing,
    UnsupportedExpression,
    InvalidExpressionOperandType,
    UnknownExpressionField,
    UnknownRecordType,
    UnknownEnumVariant,
    DuplicateEnumVariant,
    MissingRecordField,
    UnknownRecordField,
    DuplicateRecordField,
    RecordFieldTypeMismatch,
    IncompatibleExpressionType,
    InvalidNumericLiteral,
    StaticExpressionDivisionByZero,
    UnsupportedModuleConstantExpression,
    DuplicateLocalBinding,
    UnreachableStatement,
    ImportKindUnsupported,
    DuplicateImport,
    ImportNameCollision,
    DuplicateProjectModule,
    ProjectEntryModuleNotFound,
    ImportModuleNotFound,
    ImportDeclarationNotFound,
    ImportKindMismatch,
    ImportCycleDetected,
    ImportFunctionNotPure,
    FunctionNotPure,
    MissingTriggerEvent,
    UnsupportedTriggerEventKind,
    InvalidTriggerEventValue,
    MissingTriggerTarget,
    UnsupportedTriggerTargetKind,
    UnknownTriggerTarget,
    MissingTriggerLimits,
    MissingTriggerLimit,
    DuplicateTriggerLimit,
    InvalidTriggerLimit,
    UnknownTriggerArgument,
    MissingTriggerArgument,
    DuplicateTriggerArgument,
    InvalidTriggerArgument,
}
