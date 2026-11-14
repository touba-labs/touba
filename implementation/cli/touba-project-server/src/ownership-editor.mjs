import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prepareProject } from '../../touba-project/src/project.mjs';
import { validateImportFiles } from '../../touba-project/src/import-files.mjs';
import { readOwnershipFile } from './ownership-readiness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => `sha256:${hash(JSON.stringify(value))}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const teamPattern = /^team:[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const membersValid = members => Array.isArray(members) && members.length <= 256 && new Set(members).size === members.length
  && members.every(ref => typeof ref === 'string' && /^user:[A-Za-z0-9_.@-]{1,200}$/.test(ref));
const initial = () => ({ ownership_schema_version: 'touba-ownership-v1', teams: {}, owners: {}, reviews: [] });

function selectedDocument(root) {
  const config = readOwnershipFile(root, 'touba.project.json');
  const selected = config.configuration?.ownership;
  if (selected !== undefined && (typeof selected !== 'string' || !selected.endsWith('.json'))) fail('OwnershipEditorInvalid');
  const path = selected ?? 'touba.ownership.json';
  validateImportFiles(root, [{ path: join(root, path) }], { mode: 'plan' });
  let document;
  try { document = readOwnershipFile(root, path); if (selected === undefined) fail('OwnershipEditorSelectionRequired'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if (selected !== undefined) fail('OwnershipEditorMissing'); document = initial(); }
  if (!object(document) || document.ownership_schema_version !== 'touba-ownership-v1'
    || !object(document.teams) || !object(document.owners ?? {}) || !Array.isArray(document.reviews ?? [])
    || Object.values(document.teams).some(team => !object(team)) || (document.reviews ?? []).some(review => !object(review))
    || Object.keys(document.teams).length > 512 || Object.keys(document.owners ?? {}).length > 4096 || (document.reviews ?? []).length > 4096) fail('OwnershipEditorInvalid');
  return { config, path, document };
}

function recordedReview(root, review) {
  if (!/^ownership-[a-f0-9-]{36}$/.test(review.receipt_id ?? '')) return false;
  try {
    const receipt = readOwnershipFile(root, `.touba/change-transactions/${review.receipt_id}/journal.json`, 16384);
    return receipt.status === 'committed' && receipt.transaction_id === review.receipt_id
      && isDeepStrictEqual(receipt.review_evidence, review);
  } catch { return false; }
}

function view(root, document, report, path) {
  return { path, revision: report.ownership?.review_scope_digest ?? null,
    teams: Object.entries(document.teams).map(([ref, metadata]) => ({ ref, members: membersValid(metadata.members ?? []) ? metadata.members ?? [] : [] })),
    assignments: report.ownership?.effective_owners ?? [], inherit_owners: document.inherit_owners ?? [],
    targets: report.ownership?.target_refs ?? [], profiles: Object.keys(document.review_gates ?? {}),
    reviews: (document.reviews ?? []).map(review => ({ review_id: review.review_id, target_ref: review.target_ref,
      reviewer: review.reviewer, profile: review.profile, decision: review.decision,
      revision: review.revision ?? null, actor_ref: recordedReview(root, review) ? review.actor_ref : null,
      recorded_at: recordedReview(root, review) ? review.recorded_at : null,
      evidence: recordedReview(root, review) ? 'server_recorded' : 'declared',
      state: report.ownership?.review_states?.find(item => item.review_id === review.review_id)?.state ?? 'declared' })),
  };
}

export function createOwnershipEditor(projectRoot, { apply, now = Date.now }) {
  const root = realpathSync(projectRoot), pending = new Map();
  let busy = false;
  const claim = () => { if (busy) fail('OwnershipEditorBusy'); busy = true; };
  async function inspect(profile = 'dev') {
    const selected = selectedDocument(root);
    const report = await prepareProject({ root, mode: 'plan', runProfile: profile, ownershipPath: selected.path, ownershipDocument: selected.document });
    return { selected, report };
  }
  async function plan(request, userRef, id, recordedAt) {
    if (!object(request) || Object.keys(request).some(key => !['action', 'target_ref', 'teams', 'team_ref', 'members', 'sources', 'profile', 'reviewer', 'decision'].includes(key))
      || !['assign', 'team', 'inherit', 'review'].includes(request.action)
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(request.profile ?? 'dev')) fail('OwnershipEditorInvalid');
    const { selected, report: previous } = await inspect(request.profile ?? 'dev');
    if (!previous.ownership?.review_scope_digest) fail('OwnershipEditorInvalid');
    const { path } = selected, config = structuredClone(selected.config), document = structuredClone(selected.document);
    if (request.action === 'team') {
      if (!teamPattern.test(request.team_ref ?? '') || !membersValid(request.members)) fail('OwnershipEditorInvalid');
      document.teams[request.team_ref] = { ...document.teams[request.team_ref], members: request.members };
    } else if (request.action === 'assign') {
      if (!previous.ownership.target_refs.includes(request.target_ref) || !Array.isArray(request.teams)
        || request.teams.length > 512 || new Set(request.teams).size !== request.teams.length
        || request.teams.some(ref => !Object.hasOwn(document.teams, ref))) fail('OwnershipEditorInvalid');
      document.owners ??= {};
      if (request.teams.length) document.owners[request.target_ref] = request.teams;
      else delete document.owners[request.target_ref];
    } else if (request.action === 'inherit') document.inherit_owners = request.sources;
    else {
      const team = document.teams[request.reviewer];
      if (!userRef || !membersValid(team?.members) || !team.members.includes(userRef)) fail('OwnershipReviewerUnauthorized');
      if (!previous.ownership.target_refs.includes(request.target_ref) || !['approved', 'rejected'].includes(request.decision)
        || (document.review_gates?.[request.profile ?? 'dev'] && !document.review_gates[request.profile ?? 'dev'].reviewers.includes(request.reviewer))) fail('OwnershipReviewerUnauthorized');
      document.reviews = (document.reviews ?? []).filter(item => !(item.target_ref === request.target_ref && item.profile === (request.profile ?? 'dev') && item.reviewer === request.reviewer));
      document.reviews.push({ review_id: `review:${id}`, target_ref: request.target_ref, profile: request.profile ?? 'dev',
        reviewer: request.reviewer, decision: request.decision, revision: previous.ownership.review_scope_digest,
        actor_ref: userRef, recorded_at: recordedAt, receipt_id: `ownership-${id}` });
    }
    if (Buffer.byteLength(JSON.stringify(document)) > 1048576 || Object.keys(document.teams).length > 512 || (document.reviews ?? []).length > 4096) fail('OwnershipEditorLimit');
    const report = await prepareProject({ root, mode: 'plan', runProfile: request.profile ?? 'dev', ownershipPath: path, ownershipDocument: document });
    const fatal = report.diagnostics.filter(item => item.severity === 'error' && (/^Ownership|^Review/.test(item.code))
      && !['OwnershipMissing', 'OwnershipReviewedArtifactDrift', 'ReviewGateMissing', 'ReviewRejected'].includes(item.code));
    if (fatal.length) fail('OwnershipEditorInvalid');
    config.configuration ??= {}; config.configuration.ownership = path;
    const files = [{ path, content: JSON.stringify(document, null, 2) + '\n' }];
    if (selected.config.configuration?.ownership !== path) {
      files.push({ path: 'touba.project.json', content: JSON.stringify(config, null, 2) + '\n' });
    }
    for (const file of files) {
      try { const info = lstatSync(join(root, file.path)); if (!info.isFile() || info.size > 1048576) fail('OwnershipEditorInvalid');
        file.base_content_exists = true; file.base_content_sha256 = hash(readFileSync(join(root, file.path))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; file.base_content_exists = false; file.base_content_sha256 = null; }
      file.content_sha256 = hash(file.content);
    }
    validateImportFiles(root, files.map(file => ({ path: join(root, file.path) })), { mode: 'plan' });
    return { files, revision: digest({ preparation: report.review_digest, before: previous.ownership.review_scope_digest, files }),
      before: view(root, selected.document, previous, path), after: view(root, document, report, path),
      review: request.action === 'review' ? document.reviews.at(-1) : undefined,
      diagnostics: report.diagnostics.filter(item => /^Ownership|^Review/.test(item.code)).map(({ code, severity, message }) => ({ code, severity, message })) };
  }
  return {
    async read() { claim(); try { const { selected, report } = await inspect();
      return { schema_version: 'touba-ownership-state-v1', ...view(root, selected.document, report, selected.path) }; } finally { busy = false; } },
    async preview(principal, userRef, request) {
      claim(); try {
        for (const [id, item] of pending) if (item.principal === principal || item.expires <= now()) pending.delete(id);
        if (pending.size >= 8) fail('OwnershipEditorLimit');
        const id = randomUUID(), recordedAt = new Date(now()).toISOString();
        const next = await plan(request, userRef, id, recordedAt), expires = now() + 300000;
        pending.set(id, { principal, userRef, request: structuredClone(request), digest: next.revision, expires, recordedAt });
        return { schema_version: 'touba-ownership-preview-v1', id, review_digest: next.revision,
          expires_at: new Date(expires).toISOString(), before: next.before, after: next.after, diagnostics: next.diagnostics };
      } finally { busy = false; }
    },
    async apply(principal, userRef, request, reviewing) {
      claim(); try {
        if (!object(request) || Object.keys(request).some(key => !['id', 'review_digest', 'reason'].includes(key))
          || typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 1000) fail('OwnershipEditorInvalid');
        const item = pending.get(request.id);
        if (!item || item.principal !== principal || item.userRef !== userRef || item.expires <= now()
          || (item.request.action === 'review') !== reviewing) fail('OwnershipReviewMissing');
        pending.delete(request.id);
        const next = await plan(item.request, userRef, request.id, item.recordedAt);
        if (next.revision !== item.digest || request.review_digest !== item.digest) fail('OwnershipReviewStale');
        validateImportFiles(root, [{ path: join(root, '.touba/change-transactions/ownership-preflight/journal.json') }], { mode: 'plan' });
        const evidence = apply({ proposalId: request.id, targets: next.files, decidedAt: new Date(now()).toISOString(),
          review_actor: `sha256:${hash(userRef ?? principal)}`, reason: request.reason,
          transaction_id: `ownership-${request.id}`, review_evidence: next.review });
        return { schema_version: 'touba-ownership-result-v1', status: 'applied', review_digest: next.revision, transaction_id: evidence.transaction_id };
      } finally { busy = false; }
    },
  };
}
