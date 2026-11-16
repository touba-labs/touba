# Explicit effect scenarios

This reusable test package uses a private loopback HTTP service backed by a fresh
SQLite database. It never contacts a commercial API. Run `touba package test`
in this directory with Touba 1.5.0 or later, after reviewing the tests.

The tests install the actual package into fresh consumers, compile its source,
select its handler explicitly and execute the runtime. The service, controlled
by the test rather than the handler, records requests and committed writes.
The tests reopen the same effect journal between executions.

Three optional scenarios are declared in `tests/effects.test.mjs`:

* `duplicate`: replay restores one completed effect without another request.
* `lost_reply`: a reply is lost after commit; the selected idempotency policy
  allows a second request, and the service's uniqueness constraint prevents
  another write. A further replay does not dispatch again.
* `reconciliation_required`: after the same interruption, the selected policy
  keeps the effect uncertain and refuses another dispatch.

Two negative controls check that a missing receipt and a changed idempotency
key are detected. Their tests pass only when the deficient handler fails the
scenario. They do not qualify that handler as safe.

`@touba/sdk/testing` exports `assertEffectScenario`; Python provides
`touba_sdk.testing.assert_effect_scenario` with the same JSON contract.
`touba package test` supplies the matching `@touba/sdk` and `@touba/runtime`
exports to author tests. No dependency is installed into the author's project.

These observations qualify the selected synthetic scenarios only. The service
emulates idempotency; a production provider must enforce its own contract.
Author test code can construct its own observations and is not an independent
certification source. Run untrusted tests in an isolated worker with networking
disabled. Local `package test` has a temporary directory and a filtered
environment, but is not an OS sandbox. No scenario executes when installing
or merely inspecting a package. No new manifest field is required: include
the test file in `contract_tests`, as for other explicit author tests.
