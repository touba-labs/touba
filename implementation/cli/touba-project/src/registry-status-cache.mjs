import { existsSync, realpathSync } from 'node:fs';
import { indexedStore } from '../../../runtime/touba-runtime/src/sqlite-record-store.mjs';
import { packageError } from './package-contract.mjs';

// Disposable catalogue evidence. Never share its lifecycle with key continuity.
export function registryStatusCache(trustPath, registry) {
  const path = realpathSync(trustPath) + '.status.sqlite';
  const validate = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'collected_at,issued_at,registry,revision,token'
        || value.registry !== registry || typeof value.token !== 'string'
        || Buffer.byteLength(value.token, 'utf8') > 8 * 1024 * 1024
        || !Number.isSafeInteger(value.revision) || value.revision < 1
        || !Number.isSafeInteger(value.issued_at) || value.issued_at < 0
        || !Number.isSafeInteger(value.collected_at) || value.collected_at < 0 || value.collected_at > 8640000000000) {
      throw packageError('RegistryStatusCacheInvalid', 'invalid cached catalogue; refresh with touba package audit');
    }
  };
  const store = indexedStore({ path, schemaVersion: 'touba-registry-status-cache-v1',
    keyOf: value => value.registry, validate, maxBytes: 32 * 1024 * 1024, maxRecordBytes: 9 * 1024 * 1024 });
  return {
    read() {
      if (!existsSync(path)) throw packageError('RegistryStatusCacheMissing', 'no signed status cached; run touba package audit online first');
      const value = store.read([{ id: registry }])[0];
      if (!value) throw packageError('RegistryStatusCacheMissing', 'no signed status cached; run touba package audit online first');
      return value;
    },
    write(value) {
      validate(value);
      for (let attempt = 0; attempt < 4; attempt++) {
        const rows = store.read([{ id: registry }]);
        const previous = rows[0];
        if (previous && (previous.revision > value.revision
          || previous.revision === value.revision && previous.issued_at > value.issued_at)) return;
        if (previous) Object.assign(previous, value); else rows.push(value);
        try { store.write(rows); return; }
        catch (error) { if (error.code !== 'ToubaStoreWriteConflict') throw error; }
      }
      throw packageError('RegistryStatusCacheBusy', 'status cache changed concurrently; retry the audit');
    },
  };
}
