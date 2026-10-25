import { createHash, createPublicKey } from 'node:crypto';
import { indexedStore } from '../../../runtime/touba-runtime/src/sqlite-record-store.mjs';
import { packageError } from './package-contract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = /^[a-f0-9]{64}$/;
const keyId = /^[A-Za-z0-9_.-]{1,128}$/;
const fail = (code, message) => { throw packageError(code, message); };

export function trustedKeys(trust, registry) {
  if (!object(trust) || trust.schema_version !== 'touba-registry-trust-v1' || trust.registry !== registry
      || !Array.isArray(trust.keys) || trust.keys.length < 1 || trust.keys.length > 64) {
    fail('RegistryTrustInvalid', 'trust file must identify this registry and between 1 and 64 keys');
  }
  const ids = new Set(), fingerprints = new Set();
  return trust.keys.map(entry => {
    if (!object(entry) || typeof entry.id !== 'string' || !keyId.test(entry.id) || !['active', 'revoked'].includes(entry.status)
        || typeof entry.public_key !== 'string' || ids.has(entry.id)) fail('RegistryTrustInvalid', 'invalid or duplicate registry key');
    let key;
    try { key = createPublicKey(entry.public_key); } catch { fail('RegistryTrustInvalid', 'invalid registry public key'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('RegistryTrustInvalid', 'registry keys must use Ed25519');
    const digest = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    if (fingerprints.has(digest)) fail('RegistryTrustInvalid', 'one public key cannot have several identities');
    ids.add(entry.id); fingerprints.add(digest);
    return { id: entry.id, fingerprint: digest, status: entry.status };
  });
}

function validate(record) {
  if (!object(record) || typeof record.registry !== 'string' || !Number.isSafeInteger(record.revision) || record.revision < 0
      || (record.revision === 0 ? record.digest !== null : !/^sha256:[a-f0-9]{64}$/.test(record.digest))
      || !Array.isArray(record.keys) || record.keys.length > 256
      || record.keys.some(key => !object(key) || typeof key.id !== 'string' || !keyId.test(key.id) || !fingerprint.test(key.fingerprint) || !['active', 'revoked'].includes(key.status))
      || new Set(record.keys.map(key => key.id)).size !== record.keys.length) {
    fail('RegistryTrustStateInvalid', 'invalid registry continuity state; restore its verified backup');
  }
}

export function registryTrustState(path, registry) {
  const store = indexedStore({ path, schemaVersion: 'touba-registry-continuity-v1', keyOf: record => record.registry,
    validate, maxBytes: 8 * 1024 * 1024, maxRecordBytes: 128 * 1024 });

  function update(change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const records = store.read([{ id: registry }]);
      const state = records[0] ?? { registry, revision: 0, digest: null, keys: [] };
      change(state);
      if (!records.length) records.push(state);
      try { store.write(records); return; }
      catch (error) { if (error.code !== 'ToubaStoreWriteConflict') throw error; }
    }
    fail('RegistryTrustBusy', 'registry continuity changed concurrently; retry the command');
  }

  return {
    observe(keys) {
      update(state => {
        for (const previous of state.keys) {
          const current = keys.find(key => key.id === previous.id);
          if (current && current.fingerprint !== previous.fingerprint) fail('RegistryKeyConflict', 'a known key identity changed its public key');
          // Revocation is sticky, even if an older local trust file is restored.
          if (!current || current.status === 'revoked') previous.status = 'revoked';
        }
        for (const key of keys) {
          if (!state.keys.some(previous => previous.id === key.id)) {
            const revoked = state.keys.some(previous => previous.fingerprint === key.fingerprint && previous.status === 'revoked');
            state.keys.push({ ...key, status: revoked ? 'revoked' : key.status });
          }
        }
        if (state.keys.length > 256) fail('RegistryTrustCapacityExceeded', 'registry key history exceeds its limit; contact the registry operator');
      });
    },
    accept({ revision, digest, signingKey, keyFingerprint }) {
      update(state => {
        const key = state.keys.find(entry => entry.id === signingKey);
        if (key?.status !== 'active' || key.fingerprint !== keyFingerprint) fail('RegistryKeyUntrusted', 'the signing key is unknown or revoked');
        if (revision < state.revision) fail('RegistryRollbackRefused', 'signed index predates the last accepted registry revision');
        if (revision === state.revision && digest !== state.digest) fail('RegistryRevisionConflict', 'the same signed revision has different content');
        state.revision = revision; state.digest = digest;
      });
    },
  };
}
