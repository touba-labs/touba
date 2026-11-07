import { packageError } from './package-contract.mjs';
import { publicationUrl, publicationDocument } from './package-identity.mjs';

// An author project's remote link cannot select where a reusable secret is sent.
export function automationIdentity(registry, options = {}) {
  if (!options.registry) throw packageError('PackageAutomationTargetRequired', '--automation requires an explicit --registry');
  const origin = publicationUrl(process.env.TOUBA_CLOUD_ORIGIN ?? 'https://cloud.touba-labs.com');
  if (new URL(origin).origin !== origin || new URL(registry).origin !== origin || new URL(registry).pathname !== '/registry') {
    throw packageError('PackageAutomationTargetMismatch', 'registry must match the origin configured in TOUBA_CLOUD_ORIGIN');
  }
  const token = process.env.TOUBA_CLOUD_API_KEY;
  if (typeof token !== 'string' || !/^tba_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw packageError('PackageAutomationCredentialRequired', 'provide the scoped key through TOUBA_CLOUD_API_KEY, never a command argument');
  }
  return { token, api: origin + '/api/v1/automation', async revoke() {} };
}

export function automationDescriptor(row) {
  if (!row || typeof row !== 'object' || row.publication_id || row.status === 'published') {
    throw packageError('PackageDraftResponseInvalid', 'select a private draft');
  }
  return { ...row, status: 'draft', archive_digest: row.archive_digest?.startsWith('sha256:') ? row.archive_digest : 'sha256:' + row.archive_digest };
}

export function automationRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) {
    throw packageError('PackageAutomationRequestRequired', 'provide --request-id with 16 to 100 letters, digits, underscores or hyphens; reuse it only for the same request');
  }
  return value;
}

export async function requestPackagePublication(draft, options = {}) {
  if (!options.automation || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(draft ?? '') || !/^[1-9][0-9]{0,8}$/.test(options.revision ?? '')) {
    throw packageError('PackageOptionInvalid', 'request-publication requires a draft ID, --automation and --revision');
  }
  const identity = automationIdentity(publicationUrl(options.registry), options);
  const result = await publicationDocument(identity.api + `/drafts/${draft}/publication-request`, {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${identity.token}`,
      'Content-Type': 'application/json', 'Idempotency-Key': automationRequestId(options['request-id']) },
    body: JSON.stringify({ revision: Number(options.revision) }),
  });
  if (!result.ok || result.data.status !== 'awaiting_human_review') {
    throw packageError('PackagePublicationRequestRefused', /^[a-z_]{1,80}$/.test(result.data.error ?? '') ? result.data.error : 'publication_request_refused');
  }
  return { status: 'success', command: 'package request-publication', draft,
    notes: ['Publication requested. Review and confirm this revision in Cloud.'] };
}
