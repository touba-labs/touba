import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRegistry, publicationUrl, publicationDocument } from './package-identity.mjs';
export { publicationUrl, publicationDocument, publicationBytes } from './package-identity.mjs';
export const authorizePublication = (registry, options) => authorizeRegistry(registry, options);
import { findPackageWorkspace } from './package-store.mjs';
import { packageError, readPackage } from './package-contract.mjs';
import { packPackage } from './packages.mjs';
import { publicationRefusal } from './package-diagnostics.mjs';

export async function publishRemotePackage(path, options = {}) {
  const registry = publicationUrl(options.registry);
  path ??= findPackageWorkspace(options.root, { author: true });
  const author = readPackage(path, { publishing: true });
  if (!author.document.readme || !readFileSync(join(author.root, author.document.readme), 'utf8').trim()) {
    throw packageError('PackagePresentationRequired', 'direct publication requires a README; submit your archive in Cloud to compose its presentation');
  }
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-publication-')));
  let identity;
  try {
    const packed = await packPackage(path, { output: join(temporary, 'package.tar.gz') });
    identity = await authorizePublication(registry, { noBrowser: options['no-browser'] === true, sessionOnly: options['session-only'] === true });
    const result = await publicationDocument(registry + '/publish', { method: 'POST', signal: AbortSignal.timeout(210000),
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/gzip',
        'X-Touba-Namespace': author.document.name.split('.').slice(0, -1).join('.') }, body: readFileSync(packed.output) });
    if (!result.ok) {
      throw publicationRefusal('PackagePublicationRefused', result, 'publication_refused');
    }
    if (result.data.status !== 'published' || result.data.name !== author.document.name || result.data.version !== author.document.version || result.data.archive_digest !== packed.digest) {
      throw packageError('PackagePublicationResponseInvalid', 'the service did not confirm the selected archive; check its catalog before retrying');
    }
    return { status: 'success', command: 'package publish', package: result.data.name, version: result.data.version,
      registry, archive_digest: result.data.archive_digest, notes: ['Published after server-side archive validation and isolated contract tests.'] };
  } finally {
    await identity?.revoke();
    rmSync(temporary, { recursive: true, force: true });
  }
}
