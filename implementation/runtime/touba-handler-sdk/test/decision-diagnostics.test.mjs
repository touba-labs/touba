import assert from "node:assert/strict";
import test from "node:test";
import { assertCompleteProviderResponse } from "../src/decision-contract.mjs";
import { providerDiagnosticDetails } from "../src/provider-diagnostics.mjs";

test("process bridges preserve only bounded diagnostics", () => {
  assert.deepEqual(providerDiagnosticDetails({ http_status: 404, finish_reason: "length",
    incomplete_reason: "max_output_tokens", secret: "private" }), {
    http_status: 404, finish_reason: "length", incomplete_reason: "max_output_tokens",
  });
  assert.deepEqual(providerDiagnosticDetails({ http_status: true, finish_reason: "private", incomplete_reason: "secret" }), {});
});

test("incomplete generations expose a bounded finish reason and never return partial results", () => {
  for (const reason of ["length", "content-filter", "error", "sensitive-provider-string"]) {
    const expected = reason === "sensitive-provider-string" ? "unknown" : reason;
    assert.throws(() => assertCompleteProviderResponse({ finishReason: reason, output: { partial: true } }, {}), error => {
      assert.equal(error.code, "IncompleteModelDecision");
      assert.equal(error.details.finish_reason, expected);
      assert(!JSON.stringify(error).includes("sensitive-provider-string"));
      return true;
    });
  }
  assert.doesNotThrow(() => assertCompleteProviderResponse({ finishReason: "stop" }, {}));
  assert.throws(() => assertCompleteProviderResponse({ finishReason: "stop", response: { body: {
    object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
  } } }, {}), /max_output_tokens/);
});
