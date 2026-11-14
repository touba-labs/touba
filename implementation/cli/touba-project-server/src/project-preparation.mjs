import { prepareProject } from "../../touba-project/src/project.mjs";
import { readPreparedProject } from "./prepared-project.mjs";
import { randomUUID, createHash } from "node:crypto";
import { preparationChanges, preparationDecisions } from "./preparation-review.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const response = report => ({ schema_version: "touba-project-preparation-v1", status: report.status, profile: "dev",
  diagnostics: report.diagnostics.map(({ code, message, severity }) => ({ code, message, severity })),
  actions: report.actions.map(({ kind }) => kind) });

// Fixed development profile; no commands, paths, credentials or tool grants supplied
// by the HTTP client. Canonical prepare compiles, but never runs tool handlers.
export function createProjectPreparation(root, { now = Date.now } = {}) {
  let busy = false;
  const pending = new Map();
  const claim = () => {
    if (busy) fail("ToubaServePreparationBusy", "Project preparation is already running");
    busy = true;
  };
  return {
    get busy() { return busy; },
    async preview(principal, request = {}) {
      if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some(key => key !== "triggers")) fail("ToubaServePreparationInvalid", "Only explicit trigger configuration is accepted");
      const triggers = request.triggers ?? {};
      if (!triggers || typeof triggers !== "object" || Array.isArray(triggers) || Object.keys(triggers).length > 64
        || Object.entries(triggers).some(([ref, value]) => !/^trigger:[a-z][a-z0-9_.]*\/[A-Za-z][A-Za-z0-9_]*$/.test(ref)
          || !value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length
          || Object.keys(value).some(key => !['enabled', 'limits'].includes(key))
          || Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean'
          || Object.hasOwn(value, 'limits') && (!value.limits || typeof value.limits !== 'object' || Array.isArray(value.limits)
            || !Object.keys(value.limits).length || Object.entries(value.limits).some(([key, limit]) =>
              !['max_runs_per_day', 'timeout_ms'].includes(key) || !Number.isSafeInteger(limit) || limit <= 0)))) {
        fail("ToubaServePreparationInvalid", "Trigger configuration requires a boolean enabled field or positive integer limits");
      }
      claim();
      try {
        for (const [id, item] of pending) if (item.expires <= now() || item.principal === principal) pending.delete(id);
        if (pending.size >= 8) fail("ToubaServePreparationLimit", "Too many pending preparation reviews");
        const first = await prepareProject({ root, runProfile: "dev", mode: "plan" });
        const decisions = preparationDecisions(first.actions);
        for (const [ref, change] of Object.entries(triggers)) {
          decisions.triggers[ref] = { ...decisions.triggers[ref], ...structuredClone(change) };
        }
        const report = Object.values(decisions).some(value => Object.keys(value).length)
          ? await prepareProject({ root, runProfile: "dev", mode: "plan", hostDecisions: decisions }) : first;
        const id = randomUUID(), expires = now() + 300000;
        const changes = preparationChanges(report.actions);
        const canApply = !report.diagnostics.some(item => item.severity === "error");
        if (canApply) pending.set(id, { principal, expires, digest: report.review_digest, decisions });
        return { ...response(report), schema_version: "touba-project-preparation-preview-v1", id,
          review_digest: report.review_digest, expires_at: new Date(expires).toISOString(), can_apply: canApply, changes };
      } finally { busy = false; }
    },
    async apply(principal, request) {
      claim();
      try {
        const item = pending.get(request.id);
        if (!item || item.principal !== principal || item.expires <= now()) {
          fail("ToubaServePreparationReviewMissing", "Preparation review is unavailable or expired; preview again");
        }
        if (request.review_digest !== item.digest) fail("ProjectPreparationReviewStale", "Preparation digest differs from the reviewed plan");
        if (Object.keys(item.decisions.restore_fragments).length) {
          if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 1000) fail('ToubaServePreparationInvalid', 'Restoration requires a reason');
          for (const entry of Object.values(item.decisions.restore_fragments)) entry.reason = request.reason.trim();
        }
        // Single-use even on failure or a disconnected HTTP response.
        pending.delete(request.id);
        const report = await prepareProject({ root, runProfile: "dev", mode: "write",
          hostDecisions: item.decisions, expectedReviewDigest: item.digest,
          restorationActor: `sha256:${createHash('sha256').update(principal).digest('hex')}` });
        if (report.status === "success") readPreparedProject(root);
        return response(report);
      } finally { busy = false; }
    },
    async prepare() {
      claim();
      try {
        const report = await prepareProject({ root, runProfile: "dev", mode: "write" });
        if (report.status === "success") readPreparedProject(root);
        return response(report);
      } finally { busy = false; }
    },
  };
}
