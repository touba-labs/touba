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
