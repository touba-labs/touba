# Unreleased: operation-bound approval and duel regressions

Assigned to the local [1.3.0 candidate](v1.3.0.md).
Published 1.1.0 and archived 1.2.0 builds are unchanged.

The preceding local candidate is described in [1.2.0 notes](v1.2.0.md).
These changes require a new qualified build; they are not present in that archive.

- Tools can declare `human.approve` with a role, deadline and signer separation.
  Each invocation approves its exact arguments through the host's trusted identity
  adapter. Direct calls, skills, agents and imported tools retain the obligation.
- AIR declares `required_features: ["tool_operation_approval"]`. Older runtimes
  reject this field rather than ignoring the approval requirement. Recompile and
  update both SDKs with the matching distribution before using this contract.
- Handler context exposes runtime provenance: run, caller, active agent and agent
  invocation. Persist it with writes to distinguish published data from agent data.
- Python and JavaScript preserve CLI admission codes and safe transport failures.
  Unstructured stderr is not forwarded as a public SDK diagnostic.
- Python preparation explains linked or invalid `.venv` layouts precisely.
- `touba run --help` lists the durable effect-journal option.

Human checkpoints resume operation approval, including across a server restart.
The linear `RESUME-1` profile rejects these nested continuations before effects;
the server selects human-wait persistence for them. Recovery from an interrupted
external effect still requires reconciliation.

Synthetic SQLite service tests compare proposed vendor/amount with a trusted
order and atomically prevent duplicate invoices across overlapping runs. These
are application checks; a well-typed model proposal alone does not establish
business correctness. No banking rule has been inserted into the language.
