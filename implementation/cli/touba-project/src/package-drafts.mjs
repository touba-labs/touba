import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizePublication, publicationBytes, publicationDocument, publicationUrl } from './package-publish-remote.mjs';
import { PACKAGE_LIMITS, PACKAGE_NAME, exactPackageVersion, packageDigest, packageError, packagePath, readPackage } from './package-contract.mjs';
import { assertAuthorWritable, assertPlainDirectory, findPackageWorkspace } from './package-store.mjs';
import { checkPackageArchive, packPackage, unpackPackage } from './packages.mjs';
import { automationIdentity, automationDescriptor, automationRequestId } from './package-automation.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LINK = 'package-draft.json';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function draftId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw packageError('PackageDraftInvalid', 'provide the draft ID shown in Cloud');
  return value;
}
function descriptor(value, expected) {
  if (!object(value) || value.status !== 'draft' || !UUID.test(value.id ?? '') || (expected && value.id !== expected)
      || typeof value.name !== 'string' || value.name.length > 180 || !PACKAGE_NAME.test(value.name)
      || !exactPackageVersion(value.version) || !DIGEST.test(value.archive_digest ?? '')
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision >= 2147483647) {
    throw packageError('PackageDraftResponseInvalid', 'the service returned an invalid draft descriptor');
  }
  return value;
}
function accepted(result) {
  if (!result.ok) {
    const code = /^[a-z_]{1,80}$/.test(result.data.error ?? '') ? result.data.error : 'draft_request_refused';
    throw packageError('PackageDraftRefused', code);
  }
  return result.data;
}
function localLink(root) {
  assertPlainDirectory(join(root, '.touba'));
  const path = join(root, '.touba', LINK);
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw packageError('PackageDraftLinkInvalid', 'local draft link must be a small regular file');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(value) || Object.keys(value).sort().join(',') !== 'archive_digest,id,name,registry,revision,status,version') throw new Error('fields');
    descriptor(value);
    if (publicationUrl(value.registry) !== value.registry) throw new Error('registry');
    return value;
  } catch { throw packageError('PackageDraftLinkInvalid', 'local draft link is invalid; inspect .touba/package-draft.json'); }
}
function saveLink(root, registry, row) {
  const folder = join(root, '.touba');
  assertPlainDirectory(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  localLink(root); // Refuse symlink or corrupted targets, including dangling links.
  const temporary = mkdtempSync(join(folder, '.draft-link-'));
  try {
    const value = { registry, status: 'draft', id: row.id, name: row.name, version: row.version, revision: row.revision, archive_digest: row.archive_digest };
    writeFileSync(join(temporary, LINK), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(join(temporary, LINK), join(folder, LINK));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
async function cancellable(options, run) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try { return await run(signal); }
  catch (error) {
    if (signal.aborted) throw packageError('PackageOperationCancelled', 'operation cancelled; inspect the draft in Cloud if submission had started');
    throw error;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
const requestOptions = (token, signal, milliseconds = 15000) => ({
  headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]),
});
const reviewUrl = (registry, row) => new URL(`/cloud/library?draft=${row.id}`, registry).href;

export async function checkoutPackageDraft(id, options = {}) {
  draftId(id);
  const registry = publicationUrl(options.registry);
  // Resolve the selected existing parent; never adopt a link below it.
  const root = realpathSync(options.root ?? process.cwd());
  assertPlainDirectory(root);
  return cancellable(options, async signal => {
    let identity, temporary, destination, owned = false;
    try {
      identity = options.automation ? automationIdentity(registry, options) : await authorizePublication(registry, { noBrowser: options['no-browser'] === true, signal, notify: options.notify });
      const api = identity.api ?? registry;
      const response = accepted(await publicationDocument(`${api}/drafts/${id}`, requestOptions(identity.token, signal)));
      const row = descriptor(options.automation ? automationDescriptor(response) : response, id);
      const name = row.name.split('.').at(-1);
      packagePath(name);
      if (name === 'packages') throw packageError('PackageReservedName', 'packages is reserved for managed dependencies');
      destination = join(root, name);
      assertAuthorWritable(destination);
      if (readdirSync(root).some(entry => entry.toLowerCase() === name.toLowerCase())) throw packageError('PackageAlreadyExists', 'checkout requires a new author folder');
      temporary = mkdtempSync(join(root, '.touba-package-checkout-'));
      const fetched = await publicationBytes(`${api}/drafts/${id}/archive`, requestOptions(identity.token, signal, 60000), PACKAGE_LIMITS.totalBytes);
      if (!fetched.ok) throw packageError('PackageDraftRefused', 'draft archive is unavailable; no project was created');
      if (fetched.headers.get('x-touba-digest') !== row.archive_digest || packageDigest(fetched.bytes) !== row.archive_digest) throw packageError('PackageDraftIntegrityMismatch', 'downloaded archive differs from the selected draft');
      const archive = join(temporary, 'package.tar.gz');
      writeFileSync(archive, fetched.bytes, { flag: 'wx', mode: 0o600 });
      const checked = await checkPackageArchive(archive, { publishing: true });
      if (checked.manifest.name !== row.name || checked.manifest.version !== row.version || checked.archive_digest !== row.archive_digest) throw packageError('PackageDraftIntegrityMismatch', 'archive identity differs from the selected draft');
      signal.throwIfAborted();
      const source = unpackPackage(archive, join(temporary, 'contents'));
      saveLink(source, registry, row);
      assertPlainDirectory(root); assertAuthorWritable(destination);
      // Exclusive reservation: never rename over an existing directory.
      mkdirSync(destination, { mode: 0o700 }); owned = true;
      for (const entry of readdirSync(source)) renameSync(join(source, entry), join(destination, entry));
      owned = false;
      return { status: 'success', command: 'package checkout', path: destination, package: row.name, version: row.version,
        draft: row.id, registry, archive_digest: row.archive_digest, notes: ['Author project created. Review the source and tests, then use touba package submit. No author code was executed.'] };
    } finally {
      await identity?.revoke();
      if (owned) rmSync(destination, { recursive: true, force: true });
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  });
}

export async function submitPackageDraft(path, options = {}) {
  if (options.automation) automationRequestId(options['request-id']);
  path ??= findPackageWorkspace(options.root, { author: true });
  const author = readPackage(path, { publishing: true });
  const root = author.root;
  assertAuthorWritable(root);
  const linked = localLink(root);
  const registry = publicationUrl(options.registry ?? linked?.registry);
  const matching = linked?.name === author.document.name && linked.version === author.document.version;
  if (matching && linked.registry !== registry && !options.draft) throw packageError('PackageDraftTargetMismatch', 'this author project is linked to another registry; choose its draft explicitly');
  const selected = options.draft ? draftId(options.draft) : matching ? linked.id : undefined;
  const folder = join(root, '.touba');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = join(folder, 'package-draft.lock');
  try { writeFileSync(lock, String(process.pid) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw packageError('PackageDraftBusy', 'another draft operation is active; inspect .touba/package-draft.lock before recovery'); throw error; }
  let temporary;
  try {
    temporary = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-submit-')));
    return await cancellable(options, async signal => {
      let identity;
      try {
        const packed = await packPackage(root, { output: join(temporary, 'package.tar.gz') });
        const checked = await checkPackageArchive(packed.output, { publishing: true });
        if (checked.manifest.name !== author.document.name || checked.manifest.version !== author.document.version) throw packageError('PackageProjectChanged', 'package identity changed while preparing the submission');
        identity = options.automation ? automationIdentity(registry, options) : await authorizePublication(registry, { noBrowser: options['no-browser'] === true, signal, notify: options.notify });
        const api = identity.api ?? registry;
        let previous;
        if (selected) {
          const response = accepted(await publicationDocument(`${api}/drafts/${selected}`, requestOptions(identity.token, signal)));
          previous = descriptor(options.automation ? automationDescriptor(response) : response, selected);
          if (previous.name !== checked.manifest.name || previous.version !== checked.manifest.version) throw packageError('PackageDraftTargetMismatch', 'the selected draft has a different package identity or version');
          if (matching && linked.registry === registry && linked.id === selected && previous.archive_digest !== linked.archive_digest) throw packageError('PackageDraftConflict', 'the remote archive changed; review it before submitting your local changes');
        }
        const request = requestOptions(identity.token, signal, 210000);
        const result = await publicationDocument(`${api}/drafts${selected ? `/${selected}${options.automation ? '/archive' : ''}` : ''}`, { ...request, method: selected ? 'PUT' : 'POST',
          headers: { ...request.headers, 'Content-Type': 'application/gzip', 'X-Touba-Namespace': checked.manifest.name.split('.').slice(0, -1).join('.'),
            ...(previous ? { 'X-Touba-Draft-Revision': String(previous.revision) } : {}),
            ...(options.automation ? { 'Idempotency-Key': options['request-id'], 'X-Touba-Package': checked.manifest.name,
              ...(previous ? { 'X-Touba-Revision': String(previous.revision) } : {}) } : {}) }, body: readFileSync(packed.output) });
        const response = accepted(result);
        const row = descriptor(options.automation ? automationDescriptor(response) : response);
        if (row.name !== checked.manifest.name || row.version !== checked.manifest.version || row.archive_digest !== packed.digest) throw packageError('PackageDraftResponseInvalid', 'the service did not confirm the submitted bytes; inspect Cloud before retrying');
        // Preserve a truthful success if the remote commit succeeded but local bookkeeping fails.
        let saved = true;
        try { saveLink(root, registry, row); } catch { saved = false; }
        const preview = reviewUrl(registry, row);
        return { status: 'success', command: 'package submit', package: row.name, version: row.version, draft: row.id,
          registry, archive_digest: row.archive_digest, preview, local_link_saved: saved,
          notes: [`Private draft verified. Preview and publish explicitly: ${preview}`,
            ...(!saved ? [`Local draft link was not saved. Resume with --draft ${row.id} --registry ${registry}.`] : [])] };
      } finally { await identity?.revoke(); }
    });
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); rmSync(lock); }
}
