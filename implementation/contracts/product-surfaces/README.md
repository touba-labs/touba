# Product Surface JSON Contracts

These contracts define the first stable JSON boundary between Touba Core,
project client, mobile client, and resource-facing surfaces such as the registry
and Hub.

client and Mobile must consume these contracts rather than parsing human CLI
output. A UI may introduce its own view model, but the adapter layer must keep a
lossless mapping to the source contract and its `schema_version`.

## Contracts

| Contract | Primary consumers | Purpose |
| --- | --- | --- |
| `touba-project-inspection-v1` | client | Project structure, generated artifacts, executable input contracts, entrypoints, installed packages, diagnostics. |
| `touba-project-refresh-request-v0.1` | client, CLI | Request a project refresh from the project server. |
| `touba-project-refresh-v0.1` | client | Project refresh result, artifact snapshot, changed files, diagnostics. |
| `touba-project-change-proposal-v0.1` | client | Reviewable project change proposal. |
| `touba-project-change-proposed-v0.1` | client | Accepted change proposal with validation evidence. |
| `touba-project-change-apply-v0.1` | client | Apply or refuse a pending change proposal. |
| `touba-project-change-result-v0.1` | client | Final applied/refused change result and evidence. |
| `touba-project-change-history-v0.1` | client | Read-only change proposal inbox with pending, applied and refused states. |
| `touba-project-change-detail-v0.1` | client | Detailed change proposal evidence without raw patch content. |
| `touba-project-event-stream-v0.1` | client, Mobile | Live event stream descriptor for project-server clients. |
| `touba-project-event-v0.1` | client, Mobile | Contracted event envelope emitted by the project server. |
| `touba-authority-graph-v0.1` | client | Project authority graph derived from Touba source, AIR and metadata artifacts. |
| `touba-product-identity-v0.1` | client, Mobile | Product identity surface for users, teams, devices, assignments and escalation policies. |
| `touba-run-summary-v1` | client, Mobile | Compact run status, trace reference, budget usage, pending approvals. |
| `touba-trace-timeline-v1` | client | Ordered trace timeline for review and investigation. |
| `touba-trigger-status-v1` | client, Mobile | Trigger state, queue state, replay/rate-limit surface. |
| `touba-approval-request-v1` | client, Mobile | Human approval request before an effect proceeds. |
| `touba-approval-decision-v1` | Touba Engine | Human approval decision submitted by a client. |
| `touba-human-review-request-v1` | client, Mobile | Review request that asks for judgement without implying approval. |
| `touba-human-review-decision-v1` | Touba Engine | Structured review result submitted by a client. |
| `touba-human-decision-history-v0.1` | client, Mobile | Read-only history of accepted approval and review decisions. |
| `touba-human-decision-detail-v0.1` | client, Mobile | Normalized accepted human decision detail by schema and request id. |
| `touba-registry-resource-v1` | client, Hub | Versioned resource metadata for skills, agents, integrations, workflows, packages. |
| `touba-alert-v1` | client, Mobile | Notification-only alert, separate from runtime decisions. |

## Validation

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

That command produces `touba-run-summary-v1` for client and Mobile adapters.
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

When the TA-1 validation report is `ok`, that command produces
`touba-trace-timeline-v1` for client investigation views. The projection keeps
event order, severity, source refs and redaction markers without copying raw
payloads, prompts, memory content or secret values.

The resource repositories currently emit:

```bash
https://raw.githubusercontent.com/pap-touba/touba-library/main/resources.json
https://raw.githubusercontent.com/pap-touba/touba-registry/main/resources.json
```

Those files contain arrays of `touba-registry-resource-v1` entries for Hub and
client resource browsers. `touba-library/resources.json` is generated from
`catalog.json`; `touba-registry/resources.json` is generated from `index.json`
and package metadata. They expose resource refs, type, version, status, digest,
source repository, description and tags.

The Touba project server exposes the live boundary for client and Mobile:

```bash
touba serve --human-decisions .touba/human-decisions.json
```

It serves:

```text
GET  /health
GET  /state
GET  /events
GET  /project
POST /project/refresh
GET  /authority/graph
GET  /identity
GET  /runs/current
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
```

`/state` returns the current project server state. `/authority/graph` returns
`touba-authority-graph-v0.1`, a graph of declared modules, packages, triggers,
strategies, agents, skills, functions, tools, human gates, memory scopes and
capability grants extracted from project artifacts. The server reports dangling
or inconsistent references as diagnostics instead of inventing implicit
authority.

`/identity` returns `touba-product-identity-v0.1`, the product identity surface
for users, teams, roles, paired devices, sessions, assignments and escalation
policies. This contract identifies human actors and product devices; it does
not grant runtime authority, which remains enforced by Touba Engine.

`/events` is the
server-sent event stream consumed by live clients. The stream is described by
`touba-project-event-stream-v0.1`; each emitted message is a
`touba-project-event-v0.1` envelope with `event_id`, monotonic `sequence`,
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

`GET /decisions` returns `touba-human-decision-history-v0.1`.
`GET /decisions/<schema_version>/<request_id>` returns
`touba-human-decision-detail-v0.1`. These routes expose a normalized, read-only
view of accepted human decisions for client and Mobile.

`/project/refresh` accepts `touba-project-refresh-request-v0.1` and returns
`touba-project-refresh-v0.1`. The refresh result includes a bounded artifact
snapshot, changed artifacts and diagnostics such as stale AIR.

`/changes/propose` accepts `touba-project-change-proposal-v0.1` and returns
`touba-project-change-proposed-v0.1`. The server refuses unsafe paths, internal
directories, unapproved target files, invalid Touba JSON metadata and `.tb`
patches that fail `touba compile --stdout`.

`/changes/apply` accepts `touba-project-change-apply-v0.1` and returns
`touba-project-change-result-v0.1`. It applies or refuses a pending proposal,
rejects replay and emits refresh/change events.

`/changes` returns `touba-project-change-history-v0.1`.
`/changes/<proposal_id>` returns `touba-project-change-detail-v0.1`. These
read-only routes expose status, target, actor, reason, content digest,
validations and write evidence. They do not expose the raw patch content.

When `touba serve` is configured with `--auth-token-env`, clients must send
`Authorization: Bearer <token>` on normal HTTP requests and on the streaming
`/events` request. client uses a fetch-based event stream client so the token
stays in request headers.

The server does not grant authority or accept arbitrary UI state. It is the
project-facing control plane for client and Mobile adapters; Touba Engine
remains responsible for runtime authority and final decision acceptance.
