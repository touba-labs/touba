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
| `touba-project-inspection-v1` | client | Project structure, generated artifacts, entrypoints, diagnostics. |
| `touba-project-refresh-request-v0.1` | client, CLI | Request a project refresh from the project server. |
| `touba-project-refresh-v0.1` | client | Project refresh result, artifact snapshot, changed files, diagnostics. |
| `touba-project-change-proposal-v0.1` | client | Reviewable project change proposal. |
| `touba-project-change-proposed-v0.1` | client | Accepted change proposal with validation evidence. |
| `touba-project-change-apply-v0.1` | client | Apply or refuse a pending change proposal. |
| `touba-project-change-result-v0.1` | client | Final applied/refused change result and evidence. |
| `touba-run-summary-v1` | client, Mobile | Compact run status, trace reference, budget usage, pending approvals. |
| `touba-trace-timeline-v1` | client | Ordered trace timeline for review and investigation. |
| `touba-trigger-status-v1` | client, Mobile | Trigger state, queue state, replay/rate-limit surface. |
| `touba-approval-request-v1` | client, Mobile | Human approval request before an effect proceeds. |
| `touba-approval-decision-v1` | Touba Engine | Human approval decision submitted by a client. |
| `touba-human-review-request-v1` | client, Mobile | Review request that asks for judgement without implying approval. |
| `touba-human-review-decision-v1` | Touba Engine | Structured review result submitted by a client. |
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
POST /changes/propose
POST /changes/apply
```

`/state` returns the current project server state. `/events` is the
server-sent event stream consumed by live clients. The named endpoints expose
project inspection, runs, trace timelines, triggers, pending human requests,
resources and alerts as versioned Touba contracts.

`/contracts` returns a machine-readable index of the contract set.
`/contracts/<schema_version>` returns the corresponding contract fixture.
`/decisions` accepts only `touba-approval-decision-v1` and
`touba-human-review-decision-v1` payloads that validate against their schemas,
stores them through the configured human decision backend and rejects replay for
the same `schema_version` and `request_id`.

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

The server does not grant authority or accept arbitrary UI state. It is the
project-facing control plane for client and Mobile adapters; Touba Engine
remains responsible for runtime authority and final decision acceptance.
