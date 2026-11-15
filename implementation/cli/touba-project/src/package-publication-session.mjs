import { authorizePublication, publicationUrl } from './package-publish-remote.mjs';
import { packageError } from './package-contract.mjs';

// One scope per command. Credentials never appear in results, files or logs.
export function createPublicationSession() {
  const temporary = new Map();
  let closed = false;
  return {
    async acquire(registry, options) {
      if (closed) throw packageError('RegistrySessionExpired', 'publication session is closed');
      registry = publicationUrl(registry);
      options.signal?.throwIfAborted();
      const existing = temporary.get(registry);
      if (existing) return existing.ensureFresh();
      const identity = await authorizePublication(registry, options);
      // Persistent sessions retain the existing serialized vault refresh path.
      if (!identity.persistent) temporary.set(registry, identity);
      return identity;
    },
    async close() {
      if (closed) return true;
      closed = true;
      try {
        const results = await Promise.all([...temporary.values()].map(async identity => {
          try { return await identity.revoke(); } catch { return false; }
        }));
        return results.every(Boolean);
      } finally { temporary.clear(); }
    },
  };
}
