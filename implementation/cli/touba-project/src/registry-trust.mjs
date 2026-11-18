import { createHash, createPublicKey, verify } from 'node:crypto';
import { readPackageBytes } from './package-fetch.mjs';
import { packageError } from './package-contract.mjs';
import { registryTrustState, trustedKeys } from './registry-trust-state.mjs';
import { realpathSync } from 'node:fs';
import { registryStatusCache } from './registry-status-cache.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readSignedRegistry(indexRef, trustPath, now, readBytes = readPackageBytes) {
  return readRegistry(indexRef, trustPath, now, readBytes);
}

// Offline status is evidence for a reader only, never accepted for installation.
export async function readSignedRegistryStatus(indexRef, trustPath, readBytes = readPackageBytes, { offline = false } = {}) {
  return readRegistry(indexRef, trustPath, undefined, readBytes, { offline, cache: true });
}

async function readRegistry(indexRef, trustPath, now, readBytes, { offline = false, cache = false } = {}) {
  if (!trustPath || /^https?:\/\//.test(trustPath)) throw packageError('RegistryTrustRequired', 'select a local trusted registry key file with --trust');
  let trust;
  try { trust = JSON.parse(await readPackageBytes(trustPath, 65536)); }
  catch { throw packageError('RegistryTrustInvalid', 'cannot read a valid local registry trust document'); }
  const registry = new URL('./', indexRef).href.replace(/\/$/, '');
  const material = trustedKeys(trust, registry);
  // Keep this file beside the explicitly selected trust document, including in
  // backups. A different trust location is an explicit new trust bootstrap.
  const continuity = registryTrustState(realpathSync(trustPath) + '.sqlite', registry);
  continuity.observe(material);
  const cacheStore = registryStatusCache(trustPath, registry);
  const cached = offline ? cacheStore.read() : null;
  const token = cached?.token ?? (await readBytes(new URL('index.jwt', registry + '/').href, 8 * 1024 * 1024)).toString('utf8');
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
  now ??= Math.floor(Date.now() / 1000);
  if (payload.registry !== registry || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat < 0 || payload.iat > now + 30 || (!offline && payload.exp <= now) || payload.exp <= payload.iat || payload.exp - payload.iat > 3600) {
    throw packageError('RegistrySignatureExpired', 'registry origin or validity interval is invalid');
  }
  if (!object(payload.index)) throw packageError('RegistrySignatureInvalid', 'signed registry index is missing');
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw packageError('RegistryRevisionInvalid', 'signed registry revision must be a positive safe integer');
  const bytes = Buffer.from(JSON.stringify(payload.index));
  if (bytes.length > 4 * 1024 * 1024) throw packageError('PackageTooLarge', 'registry index exceeds limit');
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  try {
    continuity.accept({ revision: payload.revision, digest, signingKey: header.kid,
      keyFingerprint: material.find(key => key.id === header.kid).fingerprint });
  } catch (error) {
    if (offline && error.code === 'RegistryRollbackRefused') {
      throw packageError('RegistryStatusCacheStale', 'the local status cache is older than the accepted registry revision; run touba package audit online with the same trust file');
    }
    throw error;
  }
  // Every accepted network read advances the shared status cache, including
  // installation reads. Continuity stays authoritative if a cache write fails.
  if (!offline) cacheStore.write({ registry, token, revision: payload.revision, issued_at: payload.iat, collected_at: now });
  return { value: payload.index, ref: indexRef, bytes, signingKey: header.kid,
    revision: payload.revision, digest,
    issued_at: payload.iat, expires_at: payload.exp,
    ...(cache ? { source: offline ? 'cache' : 'registry', expired: payload.exp <= now,
      issued_at: payload.iat, expires_at: payload.exp, collected_at: cached?.collected_at ?? now } : {}) };
}
