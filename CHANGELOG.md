# Changelog

All notable public changes to Touba are summarized here. GitHub Release notes
remain the source of truth for downloadable artifacts, checksums and
platform-specific installation instructions.

## 0.1.0 - V1 Candidate

### Language And Runtime

- Added the V1 Touba language surface for typed `tool`, `skill`, `agent`,
  `strategy`, memory scopes, human approval, user interaction, triggers and
  imports.
- Added AIR generation and runtime execution with explicit authority checks,
  manifests, grants, secret handles, payload constraints and run budgets.
- Added structured traces, trace audit commands and supply-chain lock
  validation for handler integrity.

### Developer Workflow

- Added the `touba` CLI facade for compile, run, inspect, manifest, handler,
  prepare, registry, MCP import, REST scaffold, audit, supply-chain and version
  commands.
- Added JavaScript handler SDK support and project preparation workflows for
  generated handlers, manifests, run plans and local packages.
- Added VS Code language support artifacts for editing and local execution
  workflows.

### Distribution

- Prepared CI release artifacts for macOS Apple Silicon, macOS Intel, Linux x64
  and Windows x64.
- The V1 public distribution channel is GitHub Releases once the manual
  Go/No-Go gate passes.
- Current release artifacts are not signed, not notarized and do not provide a
  self-update channel.

### Ecosystem

- Added static registry metadata resolution into local locks.
- Added public skills-library and registry contracts for reusable skill packs
  and executable Touba packages.
- Added starter adoption surfaces for MCP import, REST/OpenAPI scaffolding,
  governed skills and package reuse.
