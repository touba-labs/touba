// Model-response fixtures use the SDK's current structured transport envelope.
// Native catalogue decisions remain tool calls; structured catalogue selections
// keep their separate target/argument schema.
export function structuredModelObject(decision) {
  return ["answer_directly", "request_capabilities", "cannot_complete"].includes(decision?.action)
    ? { decision }
    : decision;
}
