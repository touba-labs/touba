pub mod air;
pub mod ast;
pub mod diagnostics;

mod air_json;
mod capability_warnings;
pub use capability_warnings::capability_description_warnings;
mod ast_to_air;
mod cst_to_ast;
mod declaration_lowering;
mod field_contracts;
mod graph_lowering;
mod parser;
mod project_air;
mod resolution;
mod typecheck;

pub use air::{AirDiagnostic, AirDiagnosticCode};
pub use air_json::{AIR_JSON_PROFILE, deserialize_air_from_json, serialize_air_to_json};
pub use ast_to_air::{
    AirBuildResult, build_air, compile_module_sources, compile_project_sources,
    compile_source_to_air,
};
pub use cst_to_ast::{AstBuildResult, build_ast};
pub use diagnostics::{AstDiagnostic, AstDiagnosticCode, AstDiagnosticSeverity};
pub use parser::{parse_source, touba_language};
pub use project_air::{AirProjectBuildResult, assemble_project_air};
