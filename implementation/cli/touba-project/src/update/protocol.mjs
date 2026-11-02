import { createHash, createPublicKey, verify } from 'node:crypto';
import { valid, lt } from 'semver';

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
export const MAX_ARCHIVE = 1024 ** 3;
export const MAX_EXPANDED = 2 * 1024 ** 3;
export function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashPattern = /^[a-f0-9]{64}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !(key in value))) fail('UpdateMetadataInvalid');
}
export function trustedUrl(value, policy, archive = false) {
  let url;
  try { url = new URL(value); } catch { fail('UpdateOriginInvalid'); }
  const origin = new URL(policy.catalogue_url);
  if (url.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password || url.hash || url.search
    || (archive && !url.pathname.startsWith('/downloads/touba/'))
    || (!archive && url.href !== origin.href)) fail('UpdateOriginInvalid');
  return url;
}
export function validatePolicy(policy) {
  if (policy?.schema !== 'touba-update-trust-v1' || policy.channel !== 'validation'
    || !positive(policy.build_sequence) || !Array.isArray(policy.keys) || !policy.keys.length) fail('UpdateTrustUnavailable');
  trustedUrl(policy.catalogue_url, policy);
  const ids = new Set();
  for (const key of policy.keys) {
    const publicKey = createPublicKey(key.public_key);
    if (publicKey.asymmetricKeyType !== 'ed25519' || key.id !== digest(publicKey.export({type:'spki',format:'der'})) || ids.has(key.id)) fail('UpdateTrustInvalid');
    ids.add(key.id);
  }
  return policy;
}
export function verifyCatalogue(bytes, policy, { now = Date.now(), previous = null } = {}) {
  validatePolicy(policy);
  if (bytes.length > 65536) fail('UpdateMetadataTooLarge');
  let envelope, catalogue;
  try { envelope = JSON.parse(bytes.toString()); } catch { fail('UpdateMetadataInvalid'); }
  fields(envelope, ['schema','key_id','payload','signature']);
  if (envelope.schema !== 'touba-update-envelope-v1' || typeof envelope.payload !== 'string'
    || typeof envelope.signature !== 'string') fail('UpdateMetadataInvalid');
  const key = policy.keys.find(item => item.id === envelope.key_id);
  if (!key) fail('UpdateSignatureInvalid');
  const payload = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  if (payload.toString('base64') !== envelope.payload || signature.toString('base64') !== envelope.signature
    || signature.length !== 64 || !verify(null, payload, key.public_key, signature)) fail('UpdateSignatureInvalid');
  try { catalogue = JSON.parse(payload); } catch { fail('UpdateMetadataInvalid'); }
  fields(catalogue, ['schema','channel','sequence','issued_at','expires_at','releases']);
  if (catalogue.schema !== 'touba-update-catalogue-v1' || catalogue.channel !== policy.channel || !positive(catalogue.sequence)) fail('UpdateMetadataInvalid');
  const issued = Date.parse(catalogue.issued_at), expires = Date.parse(catalogue.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000
    || expires <= now || expires <= issued || expires - issued > 14 * 86400000) fail('UpdateCatalogueExpired');
  const contentHash = digest(payload);
  if (previous && (catalogue.sequence < previous.sequence || (catalogue.sequence === previous.sequence && contentHash !== previous.digest))) fail('UpdateCatalogueRollback');
  if (!Array.isArray(catalogue.releases) || catalogue.releases.length < 1 || catalogue.releases.length > 4) fail('UpdateMetadataInvalid');
  const seen = new Set();
  for (const release of catalogue.releases) {
    fields(release, ['platform','version','build_id','build_sequence','url','sha256','size','expanded_size','notes']);
    if (!TARGETS.includes(release.platform) || seen.has(release.platform) || !valid(release.version)
      || !hashPattern.test(release.build_id) || !hashPattern.test(release.sha256) || !positive(release.build_sequence)
      || !positive(release.size) || release.size > MAX_ARCHIVE || !positive(release.expanded_size) || release.expanded_size > MAX_EXPANDED
      || typeof release.notes !== 'string' || release.notes.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(release.notes)) fail('UpdateMetadataInvalid');
    trustedUrl(release.url, policy, true); seen.add(release.platform);
  }
  return { catalogue, checkpoint: { sequence: catalogue.sequence, digest: contentHash } };
}
export function chooseRelease(catalogue, installed, policy, highestBuild = 0) {
  const release = catalogue.releases.find(item => item.platform === installed.platform);
  if (!release) fail('UpdatePlatformUnavailable');
  if (!valid(installed.touba_version) || !hashPattern.test(installed.build?.id)) fail('UpdateInstallationInvalid');
  if (release.build_id === installed.build.id) {
    if (release.version !== installed.touba_version || release.build_sequence !== policy.build_sequence) fail('UpdateBuildMetadataMismatch');
    return { release, current: true };
  }
  if (lt(release.version, installed.touba_version) || release.build_sequence <= policy.build_sequence
    || release.build_sequence < highestBuild) fail('UpdateDowngradeRefused');
  return { release, current: false };
}
