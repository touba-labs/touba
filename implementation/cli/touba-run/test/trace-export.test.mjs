import { test } from "node:test";
import assert from "node:assert/strict";
import { traceExportOptions } from "../src/trace-export-command.mjs";
const flags = ["--store", "traces.sqlite", "--postgres-env", "TRACE_DB"];
test("export connection settings protect remote TLS and never expose credentials in errors", () => {
  const secret = "private-test-password";
  for (const suffix of ["?sslmode=disable", "?sslmode=require", "?sslrootcert=/tmp/ca", "?sslcert=/tmp/cert"]) {
    assert.throws(() => traceExportOptions(flags, { TRACE_DB: `postgres://user:${secret}@database.example/traces${suffix}` }), error => !error.message.includes(secret));
  }
  const options = traceExportOptions(flags, { TRACE_DB: `postgres://user:${secret}@database.example/traces` });
  assert.equal(new URL(options.connectionString).searchParams.get("sslmode"), "verify-full");
  assert.equal(traceExportOptions(flags, { TRACE_DB: "postgres://localhost/test?sslmode=disable" }).batchSize, 100);
  assert.throws(() => traceExportOptions([...flags, "--batch-size", "1001"], { TRACE_DB: "postgres://localhost/test" }));
  assert.throws(() => traceExportOptions([...flags, "--watch", "--max-batches", "5"], { TRACE_DB: "postgres://localhost/test" }));
  assert.throws(() => traceExportOptions([...flags, "--name", "one", "--name", "two"], { TRACE_DB: "postgres://localhost/test" }));
});
