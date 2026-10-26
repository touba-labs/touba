# Persistence qualification

These recipes use disposable local state and deterministic decisions. They
make no model API calls and never touch personal project data.

## Disk exhaustion

```sh
node --test tests/storage-qualification/validate.test.mjs
```

A 16 MiB Linux tmpfs is filled until the OS reports ENOSPC. The recipe checks
rollback, refusal before effects, and recovery after freeing its own filler.

## HTTP history and concurrency

```sh
node --test tests/storage-qualification/http-history.test.mjs
```

Requires the pinned Node image already present in Docker. The isolated
container has no external network, one CPU, 768 MiB RAM and a 512 MiB V8 heap.
It runs on the local Docker architecture, which is reported by the host; this
recipe does not qualify other native distribution targets.

The full run creates 0, 100, 1,000 and 10,000 completed approvals through HTTP.
For each history, it restores the same stopped fixture before each group:
three repetitions at concurrency 1, 8 and 32, each in a fresh Node process.
The first and warm waves each perform session creation, message submission,
three real process handlers, approval and resumption. The warm wave starts
with exactly C more completed records; `history_before` reports this explicitly.
No completed record is synthesized or silently removed from a live service.

Every sample is printed, with p50/p95/p99, throughput, CPU microseconds, sampled
RSS and event-loop delay. With three repetitions at concurrency 1, tail
percentiles are effectively maxima, not reliable population estimates.
Linux `/proc/self/io` reports parent-process disk bytes and syscall character
counts, excluding handler processes and unrelated VM activity. Warm means the
same application process, not a guarantee about the OS disk cache. Startup
includes the exhaustive audit, separately from request latency.

Prospective regression gates, fixed on 25 October before this matrix: no
functional errors, exact effect counts, RSS at most 512 MiB per worker,
startup at most 10 seconds, flow p95 at most 30 seconds and at least 0.5
completed flows/second. These local test gates are not a deployment SLA.
They do not retroactively qualify earlier measurements. All groups are kept
when a timing gate fails; functional failures stop that history immediately.

For a short recipe check:

```sh
TOUBA_HTTP_HISTORY_COUNTS=0 node --test tests/storage-qualification/http-history.test.mjs
```

The Docker recipe copies the required sources into a disposable, read-only
snapshot before testing. Concurrent edits to the working tree cannot change
the build identity halfway through the history.

The same HTTP matrix can run natively by setting `TOUBA_HTTP_HISTORY_MATRIX=1`
and `TOUBA_HTTP_HISTORY_COUNTS` when launching the server's
`durable-human-waits.test.mjs` with the `WAIT [0-9]+ completed approvals` filter.
Native macOS output leaves `process_io` empty rather than inventing disk-byte
measurements. Run performance qualification without competing test suites.

## Retained baselines and observer memory

Set `TOUBA_HTTP_HISTORY_EVIDENCE_DIR` to an existing private directory to keep
the stopped synthetic baselines. The recipe prints its generated evidence
directory and copies the baselines only after all timed processes have ended.
Their exact source-build identity and original temporary project paths remain
in `preservation.json` and `state-origin.json`.

To repeat all measurements with the same production code and baseline data:

```sh
TOUBA_HTTP_HISTORY_REPLAY_DIR=/absolute/private/evidence/http-history-XXXXXX \
  node --test tests/storage-qualification/http-history.test.mjs
```

The replay mounts that evidence read-only, requires matching production source
identity and counts, and refuses any existing target project. It restores only
the original temporary test path. It reuses the historical setup; the measured
HTTP waves and their effects are executed anew. Report it as a replay, keeping
the first measurements and their failures. It cannot qualify changed production
code by relabelling old outcomes.

The observer counts completed checkpoints directly in SQLite and changes only
the physical last record for its corruption probe. Every measured server still
performs its full admission audit. This keeps the observer from retaining the
whole historical JSON corpus beside the memory-limited worker. Observer RSS is
reported after each count, separately from worker RSS and the timing gates.
