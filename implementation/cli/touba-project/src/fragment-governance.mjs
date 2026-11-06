import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const refPattern = /^tool:[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
const map = (value, limit = 4096, code = "BindingFragmentBaselineInvalid") => {
  if (!object(value) || Object.keys(value).length > limit || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) fail(code);
  return value;
};

// Only field fingerprints are retained: no handler arguments, secrets or host
// paths are duplicated in the author-owned configuration.
export function fragmentContract(binding) {
  const fields = Object.fromEntries(Object.entries(binding).map(([field, value]) => [field, digest(value)]));
  return { digest: digest(fields), fields };
}

export function normalizeFragmentBaselines(value = {}) {
  for (const [profile, records] of Object.entries(map(value, 64))) {
    if (!/^[a-z][a-z0-9_-]*$/.test(profile)) fail("BindingFragmentBaselineInvalid");
    for (const [ref, record] of Object.entries(map(records))) {
      if (!refPattern.test(ref) || !object(record) || Object.keys(record).sort().join() !== "digest,fields"
          || !digestPattern.test(record.digest)) fail("BindingFragmentBaselineInvalid");
      for (const [key, fingerprint] of Object.entries(map(record.fields, 64))) {
        if (!/^[a-z][a-z0-9_]*$/.test(key) || !digestPattern.test(fingerprint)) fail("BindingFragmentBaselineInvalid");
      }
      if (record.digest !== digest(record.fields)) fail("BindingFragmentBaselineInvalid");
    }
  }
  return structuredClone(value);
}

const display = (value, fingerprint) => typeof value === "number" || typeof value === "boolean" ? value : fingerprint ?? null;

// A source edit and a generated-manifest edit are different operations. Compare
// the latter against its last written projection before applying the former.
export function reconcileFragmentBindings({ baselines, profile, refs, current, expected, proposed, reviews = {}, mode }) {
  const profiles = normalizeFragmentBaselines(baselines);
  const records = Object.hasOwn(profiles, profile) ? profiles[profile] : {};
  map(reviews, 4096, "BindingFragmentReviewInvalid");
  for (const [ref, review] of Object.entries(reviews)) {
    if (!refs.has(ref) || !digestPattern.test(review)) fail("BindingFragmentReviewInvalid");
  }
  const actions = [], diagnostics = [];
  const error = (code, message, ref) => diagnostics.push({ severity: "error", code, message, tool_ref: ref });
  for (const ref of refs) {
    const next = fragmentContract(expected.bindings[ref]);
    const actual = current?.bindings?.[ref];
    const observed = actual === undefined ? null : fragmentContract(actual);
    const before = records[ref];
    const review = digest({ profile, tool_ref: ref, previous: before?.digest ?? null, current: observed?.digest ?? null, next: next.digest });
    if (reviews[ref] !== undefined && reviews[ref] !== review) {
      error("BindingFragmentReviewStale", "fragment review does not match the current plan; regenerate and review the plan", ref);
      continue;
    }
    if (before && current !== null && observed?.digest !== before.digest) {
      error("BindingFragmentManifestDrift", "generated binding differs from its recorded projection; restore the generated manifest before applying fragment changes", ref);
      continue;
    }
    if (!before && observed && observed.digest !== next.digest) {
      actions.push({ kind: "review_fragment_binding", tool_ref: ref, digest: review, before: observed.digest, after: next.digest,
        changed_fields: [...new Set([...Object.keys(observed.fields), ...Object.keys(next.fields)])].filter(key => observed.fields[key] !== next.fields[key]),
        reviewed: reviews[ref] === review });
      if (reviews[ref] !== review) {
        error("BindingFragmentManifestDrift", "no recorded projection: review this plan and select its digest in host decisions review_fragments", ref);
        continue;
      }
    }
    if (!before) actions.push({ kind: "adopt_fragment_binding", tool_ref: ref, digest: next.digest });
    const previous = before ?? observed;
    if (previous && previous.digest !== next.digest) {
      for (const field of [...new Set([...Object.keys(previous.fields), ...Object.keys(next.fields)])].sort()) {
        if (previous.fields[field] === next.fields[field]) continue;
        actions.push({ kind: mode === "write" ? "update_fragment_binding" : "would_update_fragment_binding", tool_ref: ref, field,
          before: display(actual?.[field], previous.fields[field]), after: display(expected.bindings[ref][field], next.fields[field]) });
      }
    }
    if (mode === "check" && (!before || before.digest !== next.digest)) {
      error(!before ? "BindingFragmentBaselineMissing" : "BindingFragmentChangePending", "review with prepare --mode plan, then apply with --mode write", ref);
    }
    proposed.bindings[ref] = structuredClone(expected.bindings[ref]);
  }
  return { actions, diagnostics };
}

export function updateFragmentBaselines({ baselines, profile, refs, manifest }) {
  const result = normalizeFragmentBaselines(baselines);
  if (refs.size === 0) return { baselines: result, changed: false };
  if (!Object.hasOwn(result, profile)) result[profile] = {};
  for (const ref of refs) result[profile][ref] = fragmentContract(manifest.bindings[ref]);
  normalizeFragmentBaselines(result);
  return { baselines: result, changed: !isDeepStrictEqual(result, baselines ?? {}) };
}
