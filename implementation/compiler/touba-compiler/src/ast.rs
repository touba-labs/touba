use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub source_id: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstDocument {
    pub module: AstModule,
    pub imports: Vec<AstImportDeclaration>,
    pub run_limits: Vec<AstRunLimit>,
    pub declarations: Vec<AstDeclaration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstRunLimit {
    pub name: String,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstModule {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstImportDeclaration {
    pub kind: String,
    pub name: String,
    pub from_module: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AstDeclaration {
    Constant(AstConstantDeclaration),
    Memory(AstMemoryDeclaration),
    Type(AstTypeDeclaration),
    Function(AstCallableDeclaration),
    Tool(AstCallableDeclaration),
    Skill(AstSkillDeclaration),
    Agent(AstAgentDeclaration),
    Strategy(AstStrategyDeclaration),
    Trigger(AstTriggerDeclaration),
}

impl AstDeclaration {
    pub fn name(&self) -> &str {
        match self {
            Self::Constant(declaration) => &declaration.name,
            Self::Memory(declaration) => &declaration.name,
            Self::Type(declaration) => &declaration.name,
            Self::Function(declaration) | Self::Tool(declaration) => &declaration.name,
            Self::Skill(declaration) => &declaration.name,
            Self::Agent(declaration) => &declaration.name,
            Self::Strategy(declaration) => &declaration.name,
            Self::Trigger(declaration) => &declaration.name,
        }
    }

    pub fn source_ref(&self) -> &SourceRef {
        match self {
            Self::Constant(declaration) => &declaration.source_ref,
            Self::Memory(declaration) => &declaration.source_ref,
            Self::Type(declaration) => &declaration.source_ref,
            Self::Function(declaration) | Self::Tool(declaration) => &declaration.source_ref,
            Self::Skill(declaration) => &declaration.source_ref,
            Self::Agent(declaration) => &declaration.source_ref,
            Self::Strategy(declaration) => &declaration.source_ref,
            Self::Trigger(declaration) => &declaration.source_ref,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstConstantDeclaration {
    pub name: String,
    pub type_ref: AstTypeRef,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMemoryDeclaration {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTypeDeclaration {
    pub name: String,
    pub fields: Vec<AstField>,
    pub variants: Vec<AstEnumVariant>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstEnumVariant {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstField {
    pub name: String,
    pub type_ref: AstTypeRef,
    pub constraints: Vec<AstFieldConstraint>,
    pub default: Option<AstExpression>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstFieldConstraint {
    pub kind: String,
    pub value: String,
    pub upper: Option<String>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AstSignature {
    pub inputs: Vec<AstParameter>,
    pub output: Option<AstTypeRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstParameter {
    pub name: String,
    pub type_ref: AstTypeRef,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTypeRef {
    pub raw: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstCallableDeclaration {
    pub name: String,
    pub description: Option<String>,
    pub signature: AstSignature,
    pub required_capabilities: Vec<AstCapabilityRequirement>,
    pub required_secrets: Vec<AstSecretRequirement>,
    pub approval: Option<AstHumanApprovalStatement>,
    pub memory_accesses: Vec<AstMemoryAccess>,
    pub body: Option<AstBody>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstCapabilityRequirement {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstSecretRequirement {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMemoryAccess {
    pub memory: String,
    pub access: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMemoryScope {
    pub memory: String,
    pub access: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstSkillDeclaration {
    pub name: String,
    pub description: Option<String>,
    pub signature: AstSignature,
    pub uses: Vec<AstUse>,
    pub memory_scopes: Vec<AstMemoryScope>,
    pub body: Option<AstBody>,
    pub failure_handler: Option<AstFailureHandler>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstAgentDeclaration {
    pub name: String,
    pub description: Option<String>,
    pub signature: AstSignature,
    pub responsibility: String,
    pub uses: Vec<AstUse>,
    pub callable_by: Vec<AstCallableBy>,
    pub memory_scopes: Vec<AstMemoryScope>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstCallableBy {
    pub caller_kind: String,
    pub caller: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstStrategyDeclaration {
    pub name: String,
    pub description: Option<String>,
    pub signature: AstSignature,
    pub uses: Vec<AstUse>,
    pub memory_scopes: Vec<AstMemoryScope>,
    pub body: Option<AstBody>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstUse {
    pub target: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTriggerDeclaration {
    pub name: String,
    pub event: Option<AstTriggerEvent>,
    pub target: Option<AstTriggerTarget>,
    pub arguments: Vec<AstCallArgument>,
    pub limits: Option<AstTriggerLimits>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTriggerEvent {
    pub kind: String,
    pub detail: Option<String>,
    pub value: Option<AstExpression>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTriggerTarget {
    pub kind: String,
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTriggerLimits {
    pub limits: Vec<AstTriggerLimit>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstTriggerLimit {
    pub name: String,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstBody {
    pub statements: Vec<AstStatement>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AstStatement {
    Bind(AstBindStatement),
    Call(AstCallStatement),
    Parallel(AstParallelStatement),
    HumanApproval(AstHumanApprovalStatement),
    UserInteraction(AstUserInteractionStatement),
    Give(AstGiveStatement),
    Stop(AstStopStatement),
    If(AstIfStatement),
    Match(AstMatchStatement),
    For(AstForStatement),
    While(AstWhileStatement),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstBindStatement {
    pub name: String,
    pub type_ref: AstTypeRef,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstHumanApprovalStatement {
    pub target: String,
    pub mode: AstHumanApprovalMode,
    pub arguments: Vec<AstCallArgument>,
    pub result_binding: Option<AstResultBinding>,
    pub expired_branch: Option<Vec<AstStatement>>,
    pub rejected_branch: Option<Vec<AstStatement>>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AstHumanApprovalMode {
    RequiredApproval,
    AgentReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstUserInteractionStatement {
    pub target: String,
    pub mode: AstUserInteractionMode,
    pub arguments: Vec<AstCallArgument>,
    pub result_binding: Option<AstResultBinding>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AstUserInteractionMode {
    Show,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstCallStatement {
    pub target: String,
    pub arguments: Vec<AstCallArgument>,
    pub result_binding: Option<AstResultBinding>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstParallelStatement {
    pub call: AstCallStatement,
    pub item: String,
    pub collection: AstExpression,
    pub max_concurrency: u64,
    pub max_items: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstCallArgument {
    pub name: String,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstResultBinding {
    pub name: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstGiveStatement {
    pub expression: Option<AstExpression>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstStopStatement {
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstIfStatement {
    pub condition: AstExpression,
    pub present_binding: Option<AstResultBinding>,
    pub then_branch: Vec<AstStatement>,
    pub else_branch: Vec<AstStatement>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstForStatement {
    pub item: String,
    pub collection: AstExpression,
    pub body: Vec<AstStatement>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMatchStatement {
    pub value: AstExpression,
    pub cases: Vec<AstMatchCase>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstMatchCase {
    pub type_name: String,
    pub variant: String,
    pub body: Vec<AstStatement>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstWhileStatement {
    pub condition: AstExpression,
    pub body: Vec<AstStatement>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AstExpression {
    ListComprehension {
        element: Box<AstExpression>,
        item: String,
        collection: Box<AstExpression>,
        condition: Option<Box<AstExpression>>,
        source_ref: SourceRef,
    },
    ListSum {
        values: Box<AstExpression>,
        source_ref: SourceRef,
    },
    ListSort {
        values: Box<AstExpression>,
        source_ref: SourceRef,
    },
    ListConcat {
        left: Box<AstExpression>,
        right: Box<AstExpression>,
        source_ref: SourceRef,
    },
    TextJoin {
        values: Box<AstExpression>,
        separator: Box<AstExpression>,
        source_ref: SourceRef,
    },
    List {
        elements: Vec<AstExpression>,
        source_ref: SourceRef,
    },
    OptionalSome {
        expression: Box<AstExpression>,
        source_ref: SourceRef,
    },
    OptionalNone {
        type_ref: AstTypeRef,
        source_ref: SourceRef,
    },
    Record {
        type_name: String,
        fields: Vec<AstRecordField>,
        source_ref: SourceRef,
    },
    RecordCopy {
        base: Box<AstExpression>,
        fields: Vec<AstRecordField>,
        source_ref: SourceRef,
    },
    Symbol {
        value: String,
        source_ref: SourceRef,
    },
    Value {
        value: String,
        source_ref: SourceRef,
    },
    StringLiteral {
        value: String,
        source_ref: SourceRef,
    },
    IntLiteral {
        value: String,
        source_ref: SourceRef,
    },
    FloatLiteral {
        value: String,
        source_ref: SourceRef,
    },
    BooleanLiteral {
        value: bool,
        source_ref: SourceRef,
    },
    TextConversion {
        expression: Box<AstExpression>,
        source_ref: SourceRef,
    },
    DateConversion {
        expression: Box<AstExpression>,
        source_ref: SourceRef,
    },
    FieldAccess {
        target: Box<AstExpression>,
        field: String,
        field_source_ref: SourceRef,
        source_ref: SourceRef,
    },
    Unary {
        operator: AstUnaryOperator,
        operand: Box<AstExpression>,
        source_ref: SourceRef,
    },
    Binary {
        left: Box<AstExpression>,
        operator: AstBinaryOperator,
        right: Box<AstExpression>,
        source_ref: SourceRef,
    },
    Parenthesized {
        expression: Box<AstExpression>,
        source_ref: SourceRef,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstRecordField {
    pub name: String,
    pub value: AstExpression,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AstUnaryOperator {
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AstBinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    IntegerDivide,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstFailureHandler {
    pub family: String,
    pub steps: Vec<AstFailureStep>,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AstFailureStep {
    Fallback {
        target: String,
        source_ref: SourceRef,
    },
    Stop {
        source_ref: SourceRef,
    },
}
