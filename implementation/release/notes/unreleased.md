# Unreleased

## Package workflow and handler configuration, local candidate

Package distributions retain their verified dependency closure without changing
transitive dependencies into direct dependencies. Generated tests use disposable
consumers. Explicit exported package entries do not require an application wrapper.
Update previews bind the exact replacement; downgrades require explicit review
and do not roll back application effects or consumer authority.

Signed registry status can be cached for offline audit. Expired cached status is
reported as expired and never authorizes installation. Handler effect recommendations
remain separate from host grants. SDK receipt assertions test correlation, not
the truth of an external service's claimed result.

Typed, bounded configuration can be reviewed for a selected package handler.
The JS and Python SDKs receive a private context copy, without populating the
environment or general traces. Configuration changes bind effect identities and
human approval compatibility. Existing descriptive configuration resources remain
supported; they do not enable runtime value transport. See the package reference.

These changes are candidates for local qualification, not a public release.
Automatic dependency resolution for handler code, security advisory subscriptions
and grouped submission accounting remain separate work.

## Project trigger reliability, source work after 1.5.0-rc.1

Assigned to the [local 1.5.0 candidate](v1.5.0.md). Installation and public
distribution require qualification of the exact archive.

- Webhook admission validates mapped input types before queueing. An exhausted
  daily quota returns 429; terminal duplicates return 409. A quota race after
  durable acceptance defers the event instead of losing it.
- Webhook signature v1 binds the timestamp, event identity, HTTP method,
  request target and exact body. Emitters must migrate from the old body-only
  signature. Missing mappings and duplicate enabled routes prevent startup.
- A revised schedule rechecks its quota. Authorized operators can pause future
  occurrences independently of pending approvals, with a reason and a reviewed
  state revision. Resuming does not replay missed occurrences.
- Fleet output includes project preparation causes and bounded, redacted child
  failure diagnostics. A missing service credential is distinguished from an
  identity-provider outage. Package errors identify required and installed
  versions while retaining strict prerelease compatibility.
- Trace run origins use a separate layout row to avoid overlapping identifiers.

Project-wide ingress now shares the configured approval hosts and queue review
described below. Existing autonomous queues remain separate and are not replayed.

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

## Project request ingress and queue review

- `touba serve --request-triggers --webhook-signature-secret-env NAME` receives
  authenticated events for all exposed, enabled request triggers in a verified
  project. Routes use `/_touba/events` and reload after reviewed preparation.
- Requests share the project's hosts, approvals, private dossiers, quotas and
  effects journal. Signed event identities cannot be changed without invalidating
  their HMAC. Duplicate terminal events return their durable state, not a new run.
- The paginated queue API exposes metadata only. Review actions require an exact
  digest and reason; uncertain effects cannot be retried automatically.
- Standalone queues are retained separately. Migrating an emitter does not import
  or replay existing pending work. Use the original host to resolve that work.
- Registry catalogue pages can verify signed compatibility metadata before any
  archive download, using the same strict runtime version ranges as installation.
