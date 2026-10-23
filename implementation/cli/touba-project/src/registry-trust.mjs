import { createHash, createPublicKey, verify } from 'node:crypto';
import { readPackageBytes } from './package-fetch.mjs';
import { packageError } from './package-contract.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readSignedRegistry(indexRef, trustPath, now = Math.floor(Date.now() / 1000)) {
  if (!trustPath || /^https?:\/\//.test(trustPath)) throw packageError('RegistryTrustRequired', 'select a local trusted registry key file with --trust');
  let trust;
  try { trust = JSON.parse(await readPackageBytes(trustPath, 65536)); }
  catch { throw packageError('RegistryTrustInvalid', 'cannot read a valid local registry trust document'); }
  const registry = new URL('./', indexRef).href.replace(/\/$/, '');
  if (!object(trust) || trust.schema_version !== 'touba-registry-trust-v1' || trust.registry !== registry
      || !Array.isArray(trust.keys) || !trust.keys.every(object)) {
    throw packageError('RegistryTrustInvalid', 'trust file does not identify this registry');
  }
  const token = (await readPackageBytes(new URL('index.jwt', registry + '/').href, 8 * 1024 * 1024)).toString('utf8');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw packageError('RegistrySignatureInvalid', 'invalid signed registry index');
  let header, payload;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); payload = JSON.parse(Buffer.from(parts[1], 'base64url')); }
  catch { throw packageError('RegistrySignatureInvalid', 'invalid signed registry document'); }
  if (!object(header) || !object(payload) || header.alg !== 'EdDSA' || header.typ !== 'touba-registry+jwt'
      || typeof header.kid !== 'string' || Object.keys(header).some(key => !['alg','kid','typ'].includes(key))) {
    throw packageError('RegistrySignatureInvalid', 'unsupported registry signature');
  }
  const keys = trust.keys.filter(key => key.id === header.kid && key.status === 'active');
  if (keys.length !== 1) throw packageError('RegistryKeyUntrusted', 'the signing key is unknown or revoked');
  let valid = false;
  try {
    const key = createPublicKey(keys[0].public_key);
    valid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
  } catch { /* Invalid key material is a verification failure, never an unsigned fallback. */ }
  if (!valid) throw packageError('RegistrySignatureInvalid', 'registry signature verification failed');
  if (payload.registry !== registry || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat > now + 30 || payload.exp <= now || payload.exp <= payload.iat || payload.exp - payload.iat > 3600) {
    throw packageError('RegistrySignatureExpired', 'registry origin or validity interval is invalid');
  }
  if (!object(payload.index)) throw packageError('RegistrySignatureInvalid', 'signed registry index is missing');
  const bytes = Buffer.from(JSON.stringify(payload.index));
  if (bytes.length > 4 * 1024 * 1024) throw packageError('PackageTooLarge', 'registry index exceeds limit');
  return { value: payload.index, ref: indexRef, bytes, signingKey: header.kid,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}
