import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageError } from './package-contract.mjs';
import { findPackageWorkspace } from './package-store.mjs';
import { checkPackageArchive, packPackage } from './packages.mjs';
import { publicationDocument, publicationUrl } from './package-publish-remote.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function submitCiPackage(path, options = {}) {
  if (options.draft || options['no-browser'] || !UUID.test(options.ci ?? '') || !options.registry) {
    throw packageError('PackageCiConfigurationInvalid', 'use --ci <authorization-id> and --registry <URL> for a new private draft');
  }
  const registry = publicationUrl(options.registry);
  const endpoint = `${registry}/ci/drafts/${options.ci}`;
  const environment = process.env;
  let issuerRequest;
  try { issuerRequest = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { /* Refused below. */ }
  if (environment.GITHUB_ACTIONS !== 'true' || !issuerRequest || issuerRequest.protocol !== 'https:'
      || !issuerRequest.hostname.endsWith('.actions.githubusercontent.com') || issuerRequest.port
      || issuerRequest.username || issuerRequest.password || issuerRequest.hash
      || typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string'
      || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN || environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 32768) {
    throw packageError('PackageCiIdentityUnavailable', 'GitHub Actions OIDC requires id-token: write in the authorized job');
  }
  path ??= findPackageWorkspace(options.root, { author: true });
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'touba-ci-draft-')));
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    const packed = await packPackage(path, { output: join(temporary, 'package.tar.gz') });
    const checked = await checkPackageArchive(packed.output, { publishing: true });
    issuerRequest.searchParams.set('audience', endpoint);
    const identity = await publicationDocument(issuerRequest.href, { headers: {
      Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!identity.ok || typeof identity.data.value !== 'string' || !identity.data.value || identity.data.value.length > 32768) {
      throw packageError('PackageCiIdentityUnavailable', 'GitHub did not issue an identity for this job');
    }
    const result = await publicationDocument(endpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${identity.data.value}`, 'Content-Type': 'application/gzip' },
      body: readFileSync(packed.output), signal: AbortSignal.any([signal, AbortSignal.timeout(210000)]) });
    if (!result.ok) {
      const code = /^[a-z_]{1,80}$/.test(result.data.error ?? '') ? result.data.error : 'ci_submission_refused';
      throw packageError('PackageCiSubmissionRefused', code);
    }
    const row = result.data;
    if (row.status !== 'draft' || !UUID.test(row.id ?? '') || row.name !== checked.manifest.name
        || row.version !== checked.manifest.version || row.archive_digest !== packed.digest) {
      throw packageError('PackageCiResponseInvalid', 'check Cloud before retrying; the service did not confirm the selected archive');
    }
    const preview = new URL(`/cloud/library?draft=${row.id}`, registry).href;
    return { status: 'success', command: 'package submit', package: row.name, version: row.version,
      draft: row.id, registry, archive_digest: packed.digest, preview,
      notes: [`Private draft verified. Review and publish in Cloud: ${preview}`] };
  } catch (error) {
    if (signal.aborted) throw packageError('PackageOperationCancelled', 'operation cancelled; inspect Cloud if submission had started');
    throw error;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    rmSync(temporary, { recursive: true, force: true });
  }
}
