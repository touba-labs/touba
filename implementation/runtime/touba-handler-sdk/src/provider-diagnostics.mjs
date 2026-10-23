/** Bounded, non-content diagnostics allowed across SDK process boundaries. */
export function providerDiagnosticDetails(value) {
  const details = {};
  if (!value || typeof value !== "object") return details;
  if (Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599) details.http_status = value.http_status;
  if (["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"].includes(value.finish_reason)) details.finish_reason = value.finish_reason;
  if (["max_output_tokens", "content_filter", "unknown"].includes(value.incomplete_reason)) details.incomplete_reason = value.incomplete_reason;
  return details;
}
