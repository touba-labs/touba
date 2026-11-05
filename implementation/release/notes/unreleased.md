# Unreleased

## Package governance and audit evidence — 1.4.0 candidate

Assigned to the [1.4.0 candidate](v1.4.0.md). Version and private native
qualification authorized; publication remains a separate decision.

- The consuming project retains tool approval requirements across package
  removal, reinstallation and build cleanup. Changed contracts require an
  exact-digest review during preparation. Compatible source/consumer requirements
  use one operation approval; conflicting roles require an explicit resolution.
- Inspection and Explorer expose tool approval requirements. Prepared manifests
  enforce consumer policies on direct, skill, agent and resumed calls.
- Prepared executions retain verified package/lock provenance and correlate
  tool approvals, attested signer references and effects in traces.
- Package integrity failures retain their precise admission code through
  JavaScript process/persistent and Python SDK transports.
- Required macOS sandbox qualification covers Node and Python startup, scoped
  reads and network denial. Python module loading can enumerate selected code
  directories without permission to read unselected files. Windows confinement
  remains V2; trusted-handler execution remains available.

Regenerate prepared projects after installing the future candidate. Keep
`configuration.package_contracts` and `configuration.tool_policies` under
version control. New schema fields require the matching toolchain.
Published 1.3.1 archives remain unchanged. Native archive qualification and
independent retesting precede any new publication.

## Local candidate 1.3.1: retest corrections

Assigned to the [1.3.1 local candidate](v1.3.1.md).

- Project preparation retains `tool_operation_approval` when linking a protected
  tool directly, through a skill, or from an installed package. Regenerate prepared
  artifacts with `touba prepare --mode write` after updating the toolchain.
- A protected call consumes one `max_tool_calls` unit across approval and resume.
  A second call consumes its own unit. Cancellation, tighter host limits and
  shared parallel budgets still apply before dispatch.
- Project-entry refusal reaches the CLI and both SDKs as
  `ProjectEntrypointNotAllowed`; a held effect journal yields `EffectJournalBusy`.
  Wait for its owner to release the journal before retrying. No automatic retry
  or lease removal is introduced.

The source corrections are locally qualified. A new build identity and artifact
qualification are required before installation or publication. The existing
1.3.0 candidate and earlier archives are unchanged.

## Previous local candidate: operation-bound approval

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
