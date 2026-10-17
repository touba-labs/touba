use crate::ast::SourceRef;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AstDiagnostic {
    pub code: AstDiagnosticCode,
    pub severity: AstDiagnosticSeverity,
    pub message: String,
    pub source_ref: Option<SourceRef>,
}

impl AstDiagnostic {
    pub fn error(
        code: AstDiagnosticCode,
        message: impl Into<String>,
        source_ref: Option<SourceRef>,
    ) -> Self {
        Self {
            code,
            severity: AstDiagnosticSeverity::Error,
            message: message.into(),
            source_ref,
        }
    }

    pub fn is_error(&self) -> bool {
        self.severity == AstDiagnosticSeverity::Error
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AstDiagnosticSeverity {
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AstDiagnosticCode {
    ParseError,
    InvalidTextLiteral,
    MissingModule,
    DuplicateModule,
    MissingRequiredChild,
    MissingExecutableBody,
    MissingAgentResponsibility,
    DuplicateAgentResponsibility,
    InvalidAgentResponsibility,
    ImportPlacementInvalid,
    InvalidRunLimits,
    DuplicateCallArgument,
    MultipleCallResultBindings,
    UnsupportedCstNode,
}
