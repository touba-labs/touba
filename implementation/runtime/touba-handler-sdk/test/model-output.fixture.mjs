// Model-response fixtures use the SDK's current structured transport envelope.
// Native catalogue decisions remain tool calls; structured decisions use the
// same envelope in orientation, catalogue and terminal finalization.
export function structuredModelObject(decision) {
  return { decision };
}
