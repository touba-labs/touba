# Changelog

All notable public changes to Touba are summarized here. Structured release
notes remain the source of truth for version deltas, validation evidence,
downloadable artifacts, checksums and platform-specific installation
instructions.

## 1.1.0 - Release preparation

- Verified `touba update`, availability checks and offline rollback.
- Approval checkpoint integrity, host-contract binding and durable replay checks.
- Improved project Explorer details and navigation.
- Clearer JavaScript/Python SDK errors, authority scope and trace metadata.
- Graphical trace reader hidden while it matures; execution traces retained.
- Correct Windows short/long installation path handling.

See [migration and release notes](implementation/release/notes/v1.1.0.md).
Existing approvals and project data are not migrated automatically.

## 1.0.0 - Initial distribution and qualification history

Core, compiler, runtime, CLI and both SDKs share a distribution version. The editor extension
has its own release cycle.
Package authors keep independent package versions and declare compatibility
with Touba `>=1.0.0 <2.0.0`. The withdrawn private prototype is not a public
download or a supported alternative installation path.

Release preparation now requires four native archives and four graphical
installers in the exact candidate checksum manifest. Installed SDK commands on
Windows resolve the bundled CLI without evaluating batch scripts. Release gates
cover both SDKs, native GUI sessions, the current FR/EN tutorial inventory,
industrial qualification, security/signatures and production restoration.
These gates remain open until their actual evidence is supplied.

### Package diagnostics and recovery recipes, 26 October 2026

- Package checks preserve compiler diagnostics and source locations in JSON.
 Failed compilation no longer cascades into misleading missing-export errors.
- Durable time-budget refusals expose accounted time, the requested reservation
 and remaining budget. Interrupted reservations remain consumed.
- Executable documentation covers lost HTTP responses and explicit recovery,
 handler callbacks, bounded loops and pure collection recipes. Tutorial
 archives retain their documentation version, sources and validation command.

### Durable state and trace export, 25 October 2026

- Python Engine and MCP transports close their owned pipes before disposing
 of the event loop, including after cancellation and timeout. Native tests
 distinguish normal host cleanup from forced process-tree termination.
- Checkpoint audits use bounded physical-order pages; API cursors retain their
 identifier order. A bounded SHA-256 witness cache reuses pure validation of
 the current JSON text without retaining documents or authorization. Objects
 being written are always validated before serialization.
- SQLite is the default for execution traces, trigger admission/queues, effects
 and compensations. Paged reads and explicit retention preserve active,
 uncertain and unacknowledged records. JSON migration writes a validated new
 store with an exact backup; existing project data is never converted on open.
- A separate trace exporter sends bounded batches to PostgreSQL. Durable
 acknowledgements, idempotent replay and lease epochs protect recovery after
 network loss or a worker crash. JavaScript and Python expose the same trace
 references and paged reading workflow.
- Signed Registry snapshots carry a monotone revision. Local trust pins signing
 keys and retains observed revocations and index revisions across restarts.
 Older or conflicting signed snapshots are refused.
- Bundled dependencies preserve resolvable peer cycles without substituting
 another version. PostgreSQL export is tested with the assembled CLI.

### Native distribution qualification, 20 October 2026

- Parallel checkpoints retain file flushing and atomic replacement on Windows;
 directory flushing is performed on POSIX, where it is supported.
- Installed Python SDK tests write Unicode fixtures as UTF-8 and synchronize
 descendant-process checks with an explicit gate instead of a child timer.
- Candidate archives and installers are verified on their native platforms
 and retained in private storage with their source commit and checksums.
- Offline npm installation has a five-minute bound and a separate import
 check. Installation errors identify the failed phase.
- macOS graphical installers target macOS 13.5, matching the bundled Node
 binary, instead of inheriting the OS version of the build machine.

### Provider accounting, Python adapters and Linux confinement, 19 October 2026

- Dated host token-tariff adapters support OpenAI Responses/Chat, Anthropic
 Messages and Gemini content generation. Reservations and usage correlate with
 Core invocations and `provider_cost_recorded` trace events. Unknown usage keeps
 its reservation; no vendor price or model-specific business logic is embedded.
- Python host modules, structured/native providers and RAM/SQLite history reuse
 the shipped decision backend. Python MCP handlers enforce bounded stdio and
 explicit secret forwarding. A dedicated installed-wheel tutorial covers a
 Python provider and durable history without a paid API call.
- Linux x64 required confinement combines bubblewrap, seccomp and Landlock.
 Native Ubuntu checks cover read/write separation, child restrictions, Node,
 Python and descendant termination on timeout. Exact Unix socket permissions
 require Landlock ABI 9. Windows native confinement remains in progress.

### Durable host-side provider budgets, 18 October 2026

- JavaScript and Python share an exact, integer micro-unit SQLite ledger.
 Reservations precede dispatch; restarts retain them and reopening only
 tightens a ceiling. Unknown/estimated usage never frees reserved funds.
- The JavaScript HTTP wrapper covers each fetch attempt, including retries,
 refuses unknown upper bounds and prevents automatic redirects. Reported
 usage above its bound is recorded and blocks further calls.
- Host tariff adapters must establish the actual request bound and interpret
 provider usage. No provider price is embedded, no new language syntax is
 introduced, and this ledger does not imply complete Python provider parity.

### Distribution preparation, 18 October 2026

- Updated active repository links to the renamed `touba-labs` organization.
- Native installer packaging preserves previous output, records artifact size
 and checksum, and verifies disk-image integrity on macOS. Isolated installation
 tests read the payload version instead of assuming a development version.
- The manual candidate workflow supports one target at a time with short artifact
 retention. A built candidate remains unsigned and is not a published release;
 graphical installation and platform-specific signing require qualification.

### Industrial report closure, 18 October 2026

- Added exhaustive enum `match`/`case`, typed `f"…"` templates,
 canonical `text(enum)`, and integer `//` truncating toward zero. Type
 names cannot be returned as values; construct a record or return a binding.
 Function descriptions now survive compilation and imports into agent catalogues.
- Source approvals can require a host-attested role, a distinct signer and
 a deadline. Explicit terminal `on expired` branches can escalate; expiration
 never approves an effect. CLI, both JS Engine modes, Python and the server
 preserve the same durable occurrence and signer history.
- Added opt-in persistent JS Engine workers and a typed sync/async Python SDK,
 shipped as an offline wheel. The default JS process mode remains unchanged.
 Warm workers keep host modules loaded; recreate them after host-code changes.
- Fixed parallel ask resume, checkpoint diagnostics, local history error
 classification and private SQLite history files.
- Package checks resolve transitive dependencies; author projects prepare and
 test with imports. Contexts are bound to their installed lock and configurable
 in serve. Direct AIR admission checks package handlers, and generated locks
 include literal local JS imports. Host selection can use a proposed package
 handler without inheriting grants. Local draft registry publication, actionable
 diagnostics and migration from retired context packs are documented.
- macOS handler sandboxing now confines data reads/writes, descendants and
 named Unix sockets. Unqualified Linux/Windows required sandboxes fail closed.
 Removed inactive box configuration and unknown profile names; the hardened
 macOS probe launches a real bounded sandbox command.
- Installers preserve prior content-identified builds. `serve --check-state`
 validates private copies without recovery; known project/build mismatches
 refuse. A real pending operation resumes using the preserved build with one
 external test effect. No user state is migrated automatically.

These are development-build changes under 0.1.0, not a public release.
Existing human/execution checkpoints missing the required approval-state fields
are refused unchanged. Retired `skill.json` must be recreated as an explicit
package context. A same-version project SDK is checked against toolchain source
identity; the digest-named archive must be installed explicitly after an update.

- Unified package authoring uses one manifest and a confirmed questionnaire.
 Organization and name compose a qualified identity; the author directory
 uses the normalized short name. Explicit check/test/version/pack commands
 discover their root, and applications manage dependencies under reserved
 `packages/`. Installed copies cannot be edited through author commands.
 Registry continuity checks preserve published identities and version contents.
 FR/EN guides and tutorials cover offline sharing and the native Explorer badge.

- Conversation retention is independent from the sent context window. Complete
 retained exchanges survive compaction, within explicit storage/TTL limits.
 Official provider token preflights count the serialized request and reserve
 output before generation; unavailable counts fail closed. Optional host
 summaries remain untrusted data with provenance, never runtime authority.
 Dedicated SQLite and context-compaction tutorials cover FR/EN configuration.

- Both decision interfaces can return a typed result at the catalogue stage;
 the native `touba_finish` control never executes a business effect. Structured
 model outputs use a `decision` envelope in every mode. Native and structured
 state counters are aligned, and stateless observations no longer invent
 provider call IDs. Free prose and partial responses remain invalid proposals.

- Decision providers retain bounded, invocation-isolated conversation history
 in RAM by default. A transactional host store and the SQLite adapter support
 persistence. Original inline provider metadata and call IDs are retained;
 opaque content projection, runtime authority and effect checks still apply.
 Agent invocation identity survives human and parallel continuations.
- Invalid SDK decisions are reported as decision-schema failures, not provider
 outages. No benchmark outcome is inferred from these implementation changes.

- Decision providers accept `temperature: null` to omit sampling and
 `nativeToolChoice: "auto"` for APIs that reject forced calls. Defaults remain
 zero temperature and required native selection. Missing, multiple or invalid
 proposals still fail before runtime dispatch; no authority contract changes.

- Added native bounded `parallel` over typed lists in skills and strategies:
 agents, subworkflows, functions and tools; ordered all-join, isolated scopes,
 shared budgets, nested groups and local memory read/write admission.
 Human approvals have branch-specific continuations; completed work is not
 dispatched again on resume. CLI/SDK atomic private checkpoints, causal traces,
 editor support and FR/EN examples are aligned. Uncertain external outcomes
 require journal evidence, not blind retries. Local transport limits retain
 permits until actual completion. This is local async concurrency, not CPU
 worker threads, distributed scheduling or monetary budget enforcement.

- Human checkpoints now preserve complete source-call stacks through typed
 strategies and skills, including recursive calls, parent loop cursors and
 agent-requested reviews. Resume restores callers and declared failure paths
 without redispatching completed calls or resetting budgets. The current
 development format requires `call_stack` and complete scopes; incomplete
 checkpoints are refused unchanged, without a legacy reader. Agent-selected
 capabilities now retain pending selections, observations and step ceilings;
 mixed source/agent stacks resume without repeating completed decisions.
 Single host selections stay call/return, and human decisions are consumed
 once per occurrence. Session handoffs remain open; native parallel scheduling is described above.
 Invocation depth is bounded to 64; resolved secrets are refused in ancestor
 scopes and escaped strings too.

- Added explicit typed strategy calls with `with` / `into`, including imported
 subworkflows and bounded revision cycles carrying typed state. `call_strategy`
 preserves the current run, budgets and caller checks; pure functions cannot
 invoke strategies.

- Isolated invocation-local values and control state while preserving shared
 run budgets, cancellation and call IDs. Provider requests are independent
 snapshots on every attempt; mutating a catalog cannot expand `uses` or
 change decision mode. Handler/provider arguments and returned values no
 longer alias parent inputs or retained runtime observations. This is not
 an OS sandbox or delivery of parallel branch scheduling.

- Added source-level `limits run` for the five existing autonomy counters.
 Compiler and project assembly preserve the most restrictive imported limits
 and their source provenance. Calls, subagents and human-pause resumes share
 run counters; repeated authorized capability use remains allowed. Hardened
 CLI admission now returns precise fixed error codes. Monetary ceilings and
 concurrent financial reservation are not provided by this syntax tranche.

- Human-pause checkpoints now retain elapsed active time and effective host
 ceilings as well as every run counter, including previously unlimited usage.
 Resume cannot widen a previous ceiling or erase consumption; human wait time
 is excluded. Incomplete development checkpoints are refused unchanged.

- Replaced whole-history JSON rewrites in the project server with indexed
 SQLite persistence for checkpoints, effects, human requests/decisions,
 sessions and asset metadata. Short synchronized transactions check revisions;
 startup retains full validation. Previous stores are refused unchanged,
 without migration or historical-state deletion. The bounded interaction
 projection keeps its existing retention policy. Industrial load qualification
 remains tracked in ; no distributed exactly-once claim.

- Added opt-in private handler diagnostics for explicit local dev run plans
 on POSIX: bounded exception class/source position and call correlation,
 without error messages, raw stderr, payloads or secret values. Production
 and hardened profiles refuse the option; non-zero stderr is no longer
 copied into public runtime failures.

- Added explicit host decisions to `prepare` with read-only plan/check, a
 field-level diff and idempotent write. Source requirements never grant
 authority; fragment conflicts and manifest drift are refused.

- Added `@touba/sdk/testing`: explicit scripted provider steps and assertions
 for real Engine outcomes and trace event counts. Generated admission tests
 identify missing business coverage. Engine now relays validated provider
 initial/content modes; no helper grants capabilities or simulates effects.

- Fixed project decision assignments to check exact run/trace correlation
 and the server-time validity window before accepting a human decision.
 Global human-decision roles remain independent explicit authority.

- Added explicit `Optional of T`, `some`, `none` and guarded `if present`
 bindings, composable with records, enums and nested lists. Strict JSON
 envelopes distinguish absence, empty values and missing fields. Handler,
 agent and checkpoint validation retain the contract; client requires an
 explicit presence choice. No implicit null, default or unchecked unwrap.

- Added nominal business enums with qualified members, immutable constants,
 imports, records and lists. Unknown members and implicit Text conversions
 fail compilation; host/tool/agent values are checked against declared members.
 Structured and native agent schemas, human resumes, LSP member navigation
 and client choice inputs share this contract; no default member is invented.

- Retained native per-run server trace segments through human and durable
 continuations, with authorized export, local digest chains and explicit
 incomplete evidence after interruption. Storage is private and bounded;
 neither missing history nor raw checkpoints are presented as native traces.

- Added bounded, UTF-8-safe `show` messages to sandbox results and interaction
 sessions, separately from the business return value. client renders ordered
 messages and explicit truncation; retries and restart retain output without
 duplication. Messages are not copied into progress SSE or trace summaries.
 The development result contract requires `messages` and `messages_truncated`;
 incomplete stored human-wait results fail closed without rewriting history.

- Reused pure server-store integrity checks only for identical current content,
 with bounded memory and fresh snapshots; permissions, deadlines and changed
 records remain checked. Added eight concurrent three-handler sessions after
 100 completed approvals, retaining history and the same handler timeouts.
- Batched synchronous interaction progress before persistence and SSE, keeping
 event counts and the bounded window without rewriting history per event.
 Effect journals and approval checkpoints retain independent durable writes.

- Added `else if` chains and nested `if`/`for`/`while`, typed nested lists,
 block-local bindings and independent iteration cursors. Normal exit at the
 exact loop limit is allowed; exceeding it still fails before another body.
- Human approval decisions now authorize one occurrence, not future iterations
 of the same source statement. Nested-loop checkpoints retain their cursors.

- Reduced repeated durable-history scans during server recovery without
 dropping checkpoints or skipping their integrity checks.
- Enabled successive human approval checkpoints through CLI and SDK without
 replaying earlier effects; each compiled approval site now has one graph node.
- Added explicit multi-source trace audit, a canonical `sources_digest` and
 `artifacts.sources` export collection; missing or ambiguous sources fail closed.
- Added JSON escapes in Text literals and dedicated invalid-text diagnostics.
 Literal backslashes must now be escaped as `\\`.
- Clarified SDK archive updates, project entry selection, serve path diagnostics
 and the distinction between current-run timelines and full native trace audit.

- Simplified `touba version` to the Touba version and a short content-derived
 build identity. Full component, schema and distribution details remain in
 `--json`; packaged build identity can no longer be overridden by environment.
- Fixed durable-wait restart after bounded interaction-history eviction,
 optional checkpoint output on completed paths, conditional fallthrough and
 declared return-type enforcement for functions, skills and strategies.
- Added verified prepared-project loading to the project server, explicit
 identity configuration and private approval context; decision views require
 decision-read authority when the control plane is enabled.
- Added normalized trigger events and persistent trigger-state options to the
 SDK, and supply-chain locks covering explicitly listed AIR modules.
- Improved preparation drift diagnostics and safe handler failure messages;
 added server API and outbound-agent guides with executable examples.
- Updated SDK provider dependencies and preserved distinct transitive versions
 when packaging SDK and editor artifacts.
- Fixed POSIX signal forwarding for delegated CLI commands, including project
 and trigger servers: stopping the launcher now stops its direct child while
 preserving streaming output and the child's exit code or terminating signal.
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
