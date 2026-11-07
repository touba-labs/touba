import { prepareProject } from "../../touba-project/src/project.mjs";
import { readPreparedProject } from "./prepared-project.mjs";
import { randomUUID } from "node:crypto";
import { preparationChanges, preparationDecisions } from "./preparation-review.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const response = report => ({ schema_version: "touba-project-preparation-v1", status: report.status, profile: "dev",
  diagnostics: report.diagnostics.map(({ code, message, severity }) => ({ code, message, severity })),
  actions: report.actions.map(({ kind }) => kind) });

// Fixed development profile; no commands, paths, credentials or grants supplied
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
    async preview(principal) {
      claim();
      try {
        for (const [id, item] of pending) if (item.expires <= now() || item.principal === principal) pending.delete(id);
        if (pending.size >= 8) fail("ToubaServePreparationLimit", "Too many pending preparation reviews");
        const first = await prepareProject({ root, runProfile: "dev", mode: "plan" });
        const decisions = preparationDecisions(first.actions);
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
        // Single-use even on failure or a disconnected HTTP response.
        pending.delete(request.id);
        const report = await prepareProject({ root, runProfile: "dev", mode: "write",
          hostDecisions: item.decisions, expectedReviewDigest: item.digest });
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
