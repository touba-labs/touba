# Changelog

All notable public changes to Touba are summarized here. Structured release
notes remain the source of truth for version deltas, validation evidence,
downloadable artifacts, checksums and platform-specific installation
instructions.

## Unreleased

- Added an opt-in native-call SDK interface while retaining structured decisions
  by default and runtime ownership of execution, authorization and budgets.
- Added effect identities and journals, bounded durable resume, expiring human
  waits and explicit compensation under declared contracts.
- Hardened typed agent inputs/results, repeated capability use, provider
  completion checks, observation history and serialized request limits.
- Enforced function purity at compilation and AIR admission; corrected
  sequential-loop continuation and checkpoint cursor handling.
- Aligned V1 machine contracts, editor renderers, public examples and the
  distinction between PAP requirements, the formal kernel and Touba.

These are source changes, not a new published binary release.

## 0.1.0 - Initial Public Release

Detailed release note: `implementation/release/notes/v0.1.0.md`.

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

- Published V1 CLI release archives for macOS Apple Silicon, macOS Intel, Linux
  x64 and Windows x64.
- Added release checksums through `SHA256SUMS` and `CHECKSUMS.json`.
- Hardened `touba update` as an update-policy diagnostic that reports the
  installed version, channel, platform, Touba Hub URL, expected archive and
  reinstall commands in text or JSON.

### Ecosystem

- Added static registry metadata resolution into local locks.
- Added public library and registry contracts for reusable skill packs
  and executable Touba packages.
- Added starter adoption surfaces for MCP import, REST/OpenAPI scaffolding,
  Touba Library resources and package reuse.
