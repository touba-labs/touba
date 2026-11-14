import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readPreparedProject } from './prepared-project.mjs';

// Read the explicitly selected maintenance contract, never identity roles.
// This projection describes declarations; it does not attest a code review.
export function readOwnershipFile(projectRoot, path, limit = 1048576) {
    const root = realpathSync(projectRoot), absolute = realpathSync(resolve(root, path));
    const rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error();
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) throw new Error();
      const bytes = Buffer.alloc(limit + 1); let size = 0;
      while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
      if (size > limit) throw new Error();
      return JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } finally { closeSync(fd); }
}

export function readOwnershipReadiness(projectRoot) {
  const empty = status => ({ summary: { status, path: null, team_count: null, target_count: null, review_count: null }, owners: {}, reviews: [], details: null });
  const read = path => readOwnershipFile(projectRoot, path);
  let config;
  try { config = read('touba.project.json'); }
  catch (error) { return empty(error.code === 'ENOENT' ? 'not_configured' : 'unavailable'); }
  const path = config.configuration?.ownership;
  if (path === undefined) return empty('not_configured');
  try {
    if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) throw new Error();
    const doc = read(path);
    if (doc.ownership_schema_version !== 'touba-ownership-v1' || !object(doc.teams) || !object(doc.owners ?? {}) || !Array.isArray(doc.reviews ?? [])
      || Object.keys(doc.teams).length > 512 || Object.keys(doc.owners ?? {}).length > 4096 || (doc.reviews ?? []).length > 4096
      || Object.entries(doc.teams).some(([ref, team]) => !reference(ref, /^team:[^\s*]+$/u) || !object(team))) throw new Error();
    const owners = {};
    for (const [ref, teams] of Object.entries(doc.owners ?? {})) {
      if (!reference(ref, targetPattern)
        || !Array.isArray(teams) || !teams.length || teams.some(team => typeof team !== 'string' || !Object.hasOwn(doc.teams, team))) throw new Error();
      owners[ref] = [...new Set(teams)].sort();
    }
    if (doc.inherit_owners?.length) {
      const prepared = readPreparedProject(projectRoot);
      if (!prepared?.responsibilities) return empty('unavailable');
      for (const assignment of prepared.responsibilities.assignments) owners[assignment.target_ref] = assignment.teams;
    }
    for (const review of doc.reviews ?? []) if (!object(review) || !reference(review.review_id, /^review:[^\s*]+$/u)
      || !reference(review.target_ref, targetPattern) || !Object.hasOwn(doc.teams, review.reviewer)
      || !['approved', 'rejected'].includes(review.decision) || !reference(review.profile, /^[a-z][a-z0-9_-]*$/u)) throw new Error();
    // Do not project arbitrary notes, contacts, paths or evidence contents from
    // a project-authored document. A declared team is not an attested signer.
    const reviews = (doc.reviews ?? []).map(({ review_id, target_ref, reviewer, profile, decision }) =>
      ({ review_id, target_ref, reviewer, profile, decision }));
    return { summary: { status: 'declared', path, team_count: new Set(Object.values(owners).flat()).size,
      target_count: Object.keys(owners).length, review_count: reviews.length }, owners, reviews,
      details: { teams: Object.keys(doc.teams).sort(),
        assignments: Object.entries(owners).sort(([a], [b]) => a.localeCompare(b)).map(([target_ref, teams]) => ({ target_ref, teams })),
        reviews } };
  } catch { return empty('unavailable'); }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const targetPattern = /^(package|module|tool|skill|strategy|agent|memory|trigger|binding_fragment|resource_bindings|run_plan|policy|lock):[^*\s]+$/u;
const reference = (value, pattern) => typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value) && pattern.test(value);
