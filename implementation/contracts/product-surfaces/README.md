# Product Surface JSON Contracts

Local project lifecycle uses the canonical `touba-project-fleet-v1` input,
`touba-project-fleet-plan-v1` review and the `touba-fleet-upgrade-plan-v1`,
`touba-fleet-upgrade-result-v1` and `touba-fleet-upgrade-receipt-v1` documents.
Plans bind sources, profiles and toolchain identity. Receipts preserve each
upgrade's archive and step outcome without carrying host secrets.

These contracts define the versioned JSON boundary between Touba Core and host applications, including project clients and package
catalogs.

Host applications must consume these contracts rather than parsing human CLI
output. A UI may introduce its own view model, but the adapter layer must keep a
lossless mapping to the source contract and its `schema_version`.

## Contracts

Declared input types retain their source meaning: enum type descriptors expose
`enum_values`, and `optional:<type_ref>` uses explicit presence envelopes
(`{"present":false}` or `{"present":true,"value":...}`). Optional fields remain
required; consumers must not substitute missing fields, null or empty strings.
Lists and optionals recursively retain reachable record/enum definitions.

| Contract | Primary consumers | Purpose |
| --- | --- | --- |
| `touba-project-explorer-v1` | CLI browser, VS Code webview | Read-only project graph compiled from a bounded source snapshot: inventory, source-defined flow, declared authority and relative source coordinates. |
| `touba-project-server-config-v1` | CLI, local operators | Explicit persistent server options, project-relative paths and credential environment names. Read on deliberate startup, with no implicit host activation from a cloned project. |
| `touba-project-webhooks-v1` | project clients | Bounded project ingress routes, queue counters and event metadata with revision-bound review actions. Private arguments are excluded; uncertain effects require reconciliation, never automatic replay. |
| `touba-validation-plan-review-v1` | CLI, authorized project clients | Before/after snapshots of selected host test suites, file fingerprints and a review digest. Generation and refresh never execute tests. |
| `touba-auth-session-v1` | host applications, project server | Authenticated human identity, organization membership, permissions and bounded session metadata. |
| `touba-identity-directory-v1` | project clients | Organization members and role definitions without devices, sessions or credentials. |
| `touba-device-pairing-v1` | host applications | One-time, expiring identity pairing issued for a specific user. |
| `touba-identity-audit-v1` | project clients | Bounded audit trail for identity and access-management actions. |
| `touba-project-inspection-v1` | project clients | Project structure, generated artifacts, agent responsibilities copied from AIR, executable input contracts including common agent-capability signatures, entrypoint effect-policy requirements, installed packages, diagnostics. |
| `touba-effective-project-v1` | CLI, Inspect, project clients | Deterministic non-authoritative projection of the effective project profile, declared inputs, derived artifacts and provenance without secret values or business payloads. |
| `touba-project-refresh-request-v1` | project clients, CLI | Request a project refresh from the project server. |
| `touba-project-refresh-v1` | project clients | Project refresh result, artifact snapshot, changed files, diagnostics. |
| `touba-project-change-proposal-v1` | project clients | Reviewable project change proposal. |
| `touba-project-change-proposed-v1` | project clients | Accepted change proposal with validation evidence. |
| `touba-project-change-apply-v1` | project clients | Apply or refuse a pending change proposal. |
| `touba-project-change-result-v1` | project clients | Final applied/refused change result and evidence. |
| `touba-project-change-history-v1` | project clients | Read-only change proposal inbox with pending, applied and refused states. |
| `touba-project-change-detail-v1` | project clients | Detailed change proposal evidence without raw patch content. |
| `touba-element-authoring-request-v1` | project clients, project server | Typed semantic intention for one Touba primitive; optionally binds submission to an exact preview digest. |
| `touba-element-authoring-preview-v1` | project clients | Read-only Core-rendered file diffs, validations, impact and digest before a proposal exists. |
| `touba-project-event-stream-v1` | host applications | Live event stream descriptor for project-server clients. |
| `touba-project-event-v1` | host applications | Contracted event envelope emitted by the project server. |
| `touba-authority-graph-v1` | project clients | Project authority graph derived from Touba source, AIR and metadata artifacts. |
| `touba-product-identity-v1` | host applications | Product identity surface for users, teams, devices, assignments and escalation policies. |
| `touba-run-summary-v1` | host applications | Compact run status, trace reference, budget usage, pending approvals. |
| `touba-operation-resume-request-v1` | project clients, CLI | Exact RESUME-1 checkpoint claim for one interrupted operation. |
| `touba-operation-recovery-v1` | project clients, CLI | Server-derived operation state, freshness, correlations, effect reconciliation class, allowed actions and refusal. |
| `touba-interaction-session-create-v1` | project clients | Creates a bounded interaction session for one executable project target and one effect policy. |
| `touba-interaction-message-request-v1` | project clients | Submits typed inputs and a display message to an interaction session. |
| `touba-interaction-resume-request-v1` | project clients | Resumes the durable human checkpoint associated with an interaction session. |
| `touba-interaction-session-v1` | project clients | Durable message and run history for one agent, function, skill, strategy, tool or trigger. |
| `touba-interaction-session-list-v1` | project clients | Bounded index used to restore project interaction sessions. |
| `touba-interaction-asset-v1` | project clients, project server | Opaque, digest-verified content handle without a client-visible storage path. |
| `touba-trace-timeline-v1` | project clients | Ordered trace timeline for review and investigation. |
| `touba-trace-storage-status-v1` | project clients | Measured SQLite logical usage, configured quota and pending export counts. No destination credentials or trace payloads. |
| `touba-run-trace-export-v1` | Authorized audit clients | Native per-invocation trace segments, local digest chain and explicit completeness; no AIR/source/checkpoint discovery. |
| `touba-native-trace-index-v1` | Authorized audit clients | Bounded segment metadata and durable references for paginated reads. |
| `touba-trigger-status-v1` | host applications | Trigger state, queue state, replay/rate-limit surface. |
| `touba-approval-request-v1` | host applications | Human approval request before an effect proceeds. |
| `touba-approval-decision-v1` | Touba Engine | Human approval decision submitted by a client. |
| `touba-human-review-request-v1` | host applications | Review request that asks for judgement without implying approval. |
| `touba-human-review-decision-v1` | Touba Engine | Structured review result submitted by a client. |
| `touba-human-decision-history-v1` | host applications | Read-only history of accepted approval and review decisions. |
| `touba-human-decision-detail-v1` | host applications | Normalized accepted human decision detail by schema and request id. |
| `touba-registry-resource-v1` | project clients, Hub | Versioned package metadata; skills, agents and workflows are package contents. |
| `touba-alert-v1` | host applications | Notification-only alert, separate from runtime decisions. |

## Validation

An operator can start a reviewed server profile with
`touba serve --config touba.server.json --project-root /path/to/project`.
The profile is limited to 32 KiB. Unknown fields, symbolic links, hard-linked
profiles, paths escaping the project and duplicate CLI/profile options are
refused. Credentials remain in the host secret manager; the profile names their
environment variables. A profile change takes effect at the next explicit
startup. Offline state checks read the profile without loading its host modules.

Clients check the exact advertised endpoint and its request/response contracts
before enabling an action. A supported run route does not imply support for
cancellation, package installation or human decisions. The server still enforces
the authenticated subject's grants on each request.

`GET /project/refresh` returns the retained refresh report with `projects.read`.
Only `POST /project/refresh` rebuilds the index and requires `projects.manage`.
Readers can refresh the UI without invoking a mutating refresh or downloading
the composite `/state` document again.

`GET /traces/storage` requires `executions.read`. Usage is the journal's logical
quota accounting, not the physical size of its SQLite/WAL files. Export backlog
comes from durable acknowledgements; a pending count alone does not establish
an exporter failure. `unavailable` has no storage measurement. Responses contain
no local path, connection string, source identity or business event.

Operation recovery may include `budgets` from the last retained checkpoint.
Each row gives a declared limit (null when absent), charged usage, its reserved
portion and remaining capacity. Reservations are already included in charged
usage. The projection grants no permission to resume and does not infer
per-agent spending from global counters. The runtime checks the actual claim.

A manifest requiring handler isolation is a configuration requirement, not
execution evidence. The project-server fallback reports `unknown` on supported
platforms until runtime evidence is available, and `unsupported` otherwise.

Server traces use `.touba/traces.sqlite` with a separate SQLite metadata index.
`GET /runs/{run_id}/trace?index=true` returns the index; `/trace/segments/{index}`
accepts `after` and `limit` (1–1000) and returns the Core `touba-trace-page-v1`
contract. Its reference and event checks live in `contracts/trace-reference.mjs`.
The initial page verifies the full segment digest. Subsequent pages verify the
events read. Plain `/trace` streams the existing complete export contract.
These routes require project execution-read access and refuse mobile tokens.

Sandbox and current-timeline previews retain the last 200 events. `event_count`
is the full count, `start_index` the segment's first sequence index and
`events_truncated` identifies a partial view. The sandbox `budget_usage` counts
the complete execution; bounded `approval_evidence` retains older events needed
to validate the resolved and pending approvals. It never duplicates a visible
event. Exported native traces retain their original ordering and content.

Whole-project archival keeps the trace journal, index, checkpoints and effects
together. Standalone trace archival refuses a server journal with linked state.

Run:

```bash
pnpm validate:product-surface-contracts
pnpm test:product-surface-contracts
```

The validator checks that every contract has a schema and a valid fixture. It
does not replace runtime validation; it keeps the product-facing boundary
versioned, testable, and reviewable.

## Current Producers

The runtime CLI currently emits:

```bash
touba run program.air.json --output run-summary
```

That command produces `touba-run-summary-v1` for host application adapters.
The same output mode is valid in `touba.run-plan.json` through
`outputs.mode = "run-summary"`.

The trigger service currently emits:

```bash
curl http://127.0.0.1:8787/status
```

That endpoint produces `touba-trigger-status-v1` with trigger refs, kinds,
status, limits, replay/quota state and queue counters. It does not expose auth
tokens, HMAC secrets or raw webhook payloads.

The audit CLI currently emits:

```bash
touba audit --trace trace.json --timeline-out trace.trace-timeline.json
```

When the trace-audit validation report is `ok`, that command produces
`touba-trace-timeline-v1` for investigation views in host applications. The
projection keeps
event order, severity, source refs and redaction markers without copying raw
payloads, prompts, memory content or secret values.

Library and Registry generate `resources.json` from their local catalogs.
The generated files contain arrays of `touba-registry-resource-v1` entries for
resource browsers. `touba-library/resources.json` is generated from
`catalog.json`; `touba-registry/resources.json` is generated from `index.json`
and package metadata. They expose resource refs, type, version, status, digest,
source repository, description and tags.

The Touba project server exposes the live boundary for host applications:

```bash
touba serve
```

It serves:

```text
GET  /health
GET  /state
GET  /events
GET  /project
GET  /project/refresh
POST /project/refresh
GET  /traces/storage
GET  /authority/graph
GET  /identity
GET  /runs/current
GET  /runs/<run_id>/trace
GET  /operations/incidents
GET  /operations/<operation_id>/recovery
POST /operations/<operation_id>/close
POST /runs/sandbox
POST /runs/sandbox/resume
GET  /interactions/sessions
POST /interactions/sessions
GET  /interactions/sessions/<session_id>
POST /interactions/sessions/<session_id>/messages
POST /interactions/sessions/<session_id>/resume
POST /interaction-assets
GET  /interaction-assets/<handle>
GET  /trace/current
GET  /triggers
GET  /approvals/pending/current
GET  /reviews/pending/current
GET  /resources/featured
GET  /alerts/current
GET  /contracts
GET  /contracts/<schema_version>
POST /decisions
GET  /decisions
GET  /decisions/<schema_version>/<request_id>
GET  /changes
GET  /changes/<proposal_id>
POST /changes/propose
POST /changes/apply
POST /elements/preview
POST /elements/propose
POST /project/prepare/preview
POST /project/prepare/apply
```

Preparation preview accepts `{}` and requires `governance.propose`. Its
`touba-project-preparation-preview-v1` response exposes contract changes,
diagnostics, a five-minute expiry and an opaque review digest. Core retains
the package/fragment decisions server-side, scoped to the authenticated session;
at most eight reviews are retained, with one per session. No files or handlers
are written or executed by preview.

Apply requires `governance.apply` and `touba-project-preparation-apply-v1`:
only `schema_version`, `id` and `review_digest`. It consumes the review once and
passes its expected digest to canonical preparation, checked before any write.
An expired/consumed review or changed plan returns 409. The response remains
`touba-project-preparation-v1`. Review accepts the selected package contract,
preserves consumer approval minima and grants no additional authority. Raw
handler arguments and host plans are not projected; fragment changes use Core's
redacted values. Oversized interactive reviews return 429 and require CLI review.
The legacy empty-object `/project/prepare` remains available, without an implicit
acceptance of package contract changes. Clients use only the reviewed routes.

Project mutation routes refuse active human waits, interrupted operations and
concurrent executions with `ToubaServeProjectOperationsActive`. An execution
cannot start during a governed mutation (`ToubaServeProjectMutationBusy`).
This gate belongs to the project server; external editors remain outside it.
Decision acceptance checks the current AIR and host contracts before and after
asynchronous attestation, before claiming the human decision. Runtime resume
retains its own compatibility and custody checks.

The two `pending/current` routes accept an optional `run_id` query parameter.
With it, the server returns only an undecided request for that exact run, or
`ToubaServePendingHumanRequestNotFound` (404). Without it, the first pending
request is preserved for existing clients. Reading a targeted request does not
consume or approve any queue entry; the client uses it for the active interaction.

For a tool-bound approval, `touba-approval-request-v1` additionally carries
`tool_operation`. Core derives it from the runtime checkpoint and the AIR,
manifest and package admission used for that execution. It identifies the tool,
caller, active agent when present, policy origin (`source`, `consumer` or
`source_and_consumer`) and verified package version/fingerprints when applicable.
Operation and argument commitments identify the bound values without projecting
their contents. The argument commitment is scoped to the run and request.
The summary of a tool request never serializes its input arguments. Existing
explicit continuation contexts retain their bounded, private projection.

`prior_signers` contains at most eight earlier approved receipts from this run,
using the same run-scoped signer pseudonym as the runtime trace and at most eight
attested roles per receipt. Truncation is explicit. These are previous approvals,
not evidence that the pending operation has been approved. No identity is
inferred from a Cloud role, and no receipt is fabricated for an anonymous signer.
All metadata stays on authenticated request routes; it is not copied to public
progress notifications. The decision POST still accepts only its canonical
decision schema, never an operation, package policy or replacement arguments.
Old request documents remain valid. Distribute updated strict consumers with
this producer: clients carrying an older closed schema cannot read the new field.

`GET /operations/<operation_id>/recovery` projects the durable checkpoint,
human wait and effect journal without exposing receipts, handler payloads or
secret values. `allowed_actions` is computed by the server: an interrupted
checkpoint is resumable only while an ambiguous effect is retry-safe; a
`reconcile` or `none` ambiguity is exposed as a structured refusal. Human
waits expose `submit_decision` only before expiration. The route requires
`executions.read`; advertised actions still require their own
`executions.run` or `decisions.act` permission.

`GET /operations/incidents` requires `executions.read` and returns the bounded
`touba-operation-incidents-v1` projection of durable human waits and interrupted
executions, including direct and scheduled runs. Follow `next_cursor` until null;
each page contains at most 100 entries. No arguments, secrets or receipts are
included. Archiving a conversation does not remove a runtime incident.

`POST /operations/<operation_id>/close` requires `executions.run`, a current
`state_digest`, and a nonempty reason in `touba-operation-close-request-v1`.
Only interrupted interaction operations without a runtime checkpoint or any
recorded effect can be closed online. Stale, concurrent or repeated closure is
refused. The original message and operation remain recorded as cancelled;
no handler runs and no approval receipt is invented. Application credentials
cannot invoke this route.

New RESUME-1 clients send `touba-operation-resume-request-v1` to
`POST /runs/sandbox/resume`. The server continues to accept the same five
legacy fields without `schema_version` for existing local clients. Revision,
digest and request identity are checked server-side; a stale or concurrent
claim is never resolved by UI state.

`/state` returns the current project server state. `/authority/graph` returns
`touba-authority-graph-v1`, a graph of declared modules, packages, triggers,
strategies, agents, skills, functions, tools, human gates, memory scopes and
capability grants extracted from project artifacts. The server reports dangling
or inconsistent references as diagnostics instead of inventing implicit
authority.

`/identity` returns `touba-product-identity-v1`, the product identity surface
for users, teams, roles, paired devices, sessions, assignments and escalation
policies. This contract identifies human actors and product devices; it does
not grant runtime authority, which remains enforced by Touba Engine.

`/events` is the
server-sent event stream consumed by live clients. The stream is described by
`touba-project-event-stream-v1`; each emitted message is a
`touba-project-event-v1` envelope with `event_id`, monotonic `sequence`,
`type`, `source`, `emitted_at` and the versioned payload. The server writes an
`id: <event_id>` SSE field and keeps a bounded `.touba/project-events.jsonl`
journal. A reconnecting client may send `Last-Event-ID`; retained events after
that id are replayed before the new ready event. If the requested id is outside
the retained window, the server emits `touba.server.resync_required` so the
client can reload `/state`. The named endpoints expose project inspection,
runs, trace timelines, triggers, pending human requests, resources and alerts as
versioned Touba contracts.

`/contracts` returns a machine-readable index of the contract set.
`/contracts/<schema_version>` returns the corresponding contract fixture.
`/decisions` accepts only `touba-approval-decision-v1` and
`touba-human-review-decision-v1` payloads that validate against their schemas,
stores them through the configured human decision backend and rejects replay for
the same `schema_version` and `request_id`.

`GET /decisions?limit=50` returns `touba-human-decision-history-v1`, with up to
50 decisions by default (1–100 allowed), newest recorded first. Its `summary`
counts the whole history. Follow `pagination.next_cursor` as the next request's
`cursor`; `null` marks the last page. The cursor is an exclusive storage key,
so a new decision does not shift subsequent pages. Refresh the first page to
see new records. Each response is a current observation, not a transaction
spanning all pages. SQLite reads only the selected bodies, bounded to 16 MiB.
`GET /decisions/<schema_version>/<request_id>` returns
`touba-human-decision-detail-v1`. These routes expose a normalized, read-only
view of accepted human decisions for host applications.

The optional `request_id` query filters pending, recorded and terminal decisions
to that exact request. Unknown IDs return an empty selection. Pagination keeps
the same filter; there is no fallback to another request.

`/project/refresh` accepts `touba-project-refresh-request-v1` and returns
`touba-project-refresh-v1`. The refresh result includes a bounded artifact
snapshot, changed artifacts and diagnostics such as stale AIR.

`POST /elements/preview` and `POST /elements/propose` accept the same typed
`touba-element-authoring-request-v1` intention. Preview renders and validates
the exact source, manifest and guarded handler-stub targets without writing a
file or a pending proposal. It returns `touba-element-authoring-preview-v1`.
The client sends its `preview_digest` with the subsequent proposal; the server
recomputes current target digests and rejects stale previews before persistence.

Python tools requesting confinement require a reviewed interpreter and file
inventory. Authoring preview refuses them with
`ToubaServeElementSandboxInventoryRequired`; use `touba sdk sandbox python
--handler <file>` to prepare the explicit binding fragment. The preview does
not execute an interpreter or change files to manufacture this inventory.

`/project` includes an interaction profile for each executable target. The
profile derives a presentation mode, primary text path, structured context and
accepted content kinds from the compiled input contract. Ambiguous signatures
remain structured; the server does not invent a text field or media capability.

Sandbox results carry `messages` separately from `result`, in runtime
order, with a `messages_truncated` flag. The server retains the first 100
messages within 16 KiB total text and 4 KiB per message, preserving UTF-8.
Messages are business content: authorized result/session routes expose them,
never the public progress SSE or minimized trace. A continuation contains only
new messages; persisted checkpoint results retain earlier messages without
replaying them. The current development contract requires both fields;
incomplete stored human-wait results are refused without rewriting private history.

`/interactions/sessions` creates and restores bounded project interaction
sessions. A message executes through the same sandbox request, manifest,
authority and trace path as a direct run. `message_id` replay is idempotent
after completion and rejected while inconsistent with the stored session.
When a run stops at a durable human checkpoint,
`/interactions/sessions/<session_id>/resume` verifies that the decision and
resumed `run_id` belong to the latest stopped run in that session before
recording the continuation.

The runtime's `stopped` status is not itself a pending human decision. A durable
open checkpoint is projected as operation `awaiting_human` and summary
`approval_pending` or `review_pending`. A terminal human rejection or expiration
keeps the sandbox result `stopped`, but projects to operation/session `failed`
and summary `refused`, with a completion time and no pending approval. A terminal
human cancellation projects to operation/summary `cancelled`; the session is
open again. These terminal sessions can be archived. Structured diagnostic codes
`ToubaSandboxHumanDecisionRejected`, `ToubaSandboxHumanDecisionExpired` and
`ToubaSandboxHumanDecisionCancelled` distinguish the causes without parsing
diagnostic prose or changing the runtime result contract.

Each distinct checkpoint result and terminal result is retained in interaction
history. Retrying the same result does not duplicate it. Retrying a checkpoint
already replaced by a later checkpoint returns its recorded continuation rather
than executing it again; the interaction endpoint preserves the current
operation. At startup, the server can repair an older interaction incorrectly
left `awaiting_human`, but only when a matching completed durable checkpoint has
a valid terminal result and a terminal human event in its trace. It does not
accept a trace whose own run or entrypoint reference belongs to another run or
target, even when the surrounding result matches the session. It does not
infer decisions from missing requests, rerun effects, or repair history whose
terminal evidence is absent. A current run summary is repaired only for the same
run. Generated approval requests still allow only `approve` and `reject`; this
projection correction does not add a client cancellation permission or an
automatic expiration scheduler.

`/interaction-assets` accepts only bounded media types declared by the target's
canonical handle type. The server verifies the SHA-256 digest, stores the bytes
outside messages and traces, and returns an opaque handle. Resolving that handle
remains the responsibility of a declared target capability; the interaction
profile does not imply model-level image, audio or document support.

`/changes/propose` accepts `touba-project-change-proposal-v1` and returns
`touba-project-change-proposed-v1`. The server refuses unsafe paths, internal
directories, unapproved target files, invalid Touba JSON metadata and `.tb`
patches that fail `touba compile --stdout`.

`/changes/apply` accepts `touba-project-change-apply-v1` and returns
`touba-project-change-result-v1`. It applies or refuses a pending proposal,
rejects replay and emits refresh/change events.

`/changes` returns `touba-project-change-history-v1`, with 50 rows by default
and at most 100 (`limit`). `cursor` follows decreasing SQLite storage keys;
`status=all|pending|applied|refused` filters the full history. Summary counters
remain global. `pagination.next_cursor=null` marks the last page. New proposals
appear after refreshing the first page. Each stored page is capped at 16 MiB
before projection; proposal content is never included in the response.
Clients consume one page and search text within that page.
Current clients require this pagination metadata and must be paired with the
corresponding Core. The local store is `project-change-proposals.sqlite`;
old JSON needs the explicit `touba state migrate changes` maintenance command.
`/changes/<proposal_id>` returns `touba-project-change-detail-v1`. These
read-only routes expose status, target, actor, reason, content digest,
validations and write evidence. They do not expose the raw patch content.

When `touba serve` is configured with `--auth-token-env`, clients must send
`Authorization: Bearer <token>` on normal HTTP requests and on the streaming
`/events` request. The client uses a fetch-based event stream client so the token
stays in request headers.

The server does not grant authority or accept arbitrary UI state. It is the
project-facing interface for host applications; Touba Engine
remains responsible for runtime authority and final decision acceptance.
