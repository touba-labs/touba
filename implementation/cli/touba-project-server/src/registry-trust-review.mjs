import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync, constants, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { trustedKeys, registryTrustState } from '../../touba-project/src/registry-trust-state.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const filename = 'touba.registry-trust.json';

/** Trust is fetched only from the configured identity origin, and activated by a reviewed owner action. */
export function createRegistryTrustReview(root, { controlPlaneUrl, serviceToken, fetchImpl = fetch, now = Date.now, onChange = () => {}, configuredRegistry, configuredTrust } = {}) {
  root = realpathSync(root);
  let registry = null;
  if (controlPlaneUrl) {
    const url = new URL(controlPlaneUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('RegistryTrustInvalid');
    registry = new URL('/registry', url).href;
  }
  const path = join(root, filename), pending = new Map();
  let busy = false;
  function current() {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail('RegistryTrustInvalid');
      const bytes = readFileSync(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      trustedKeys(JSON.parse(bytes), registry);
      return bytes;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function enabled() { return Boolean(registry) && (!configuredRegistry || (configuredRegistry.replace(/\/$/, '') === registry && configuredTrust === path)); }
  function activate(bytes) { if (bytes) onChange({ registry, trust: path }); }
  if (enabled() && !configuredRegistry) activate(current());
  return {
    available: enabled(),
    async preview(principal, accessToken) {
      if (!enabled()) fail('RegistryTrustUnavailable');
      if (busy) fail('RegistryTrustBusy');
      busy = true;
      try {
        const before = current();
        let response;
        try {
          response = await fetchImpl(registry + '/studio-trust', { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json', 'x-touba-service-token': typeof serviceToken === 'function' ? await serviceToken() : serviceToken },
            body: JSON.stringify({ access_token: accessToken }), signal: AbortSignal.timeout(5000) });
        } catch { fail('RegistryTrustUnavailable'); }
        if (!response.ok || !response.body) { await response.body?.cancel(); fail('RegistryTrustUnavailable'); }
        const chunks = []; let length = 0;
        try { for await (const part of response.body) { length += part.length; if (length > 65536) fail('RegistryTrustInvalid'); chunks.push(part); } }
        catch { fail('RegistryTrustInvalid'); }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks)); } catch { fail('RegistryTrustInvalid'); }
        const keys = trustedKeys(value, registry);
        if (!keys.some(key => key.status === 'active')) fail('RegistryTrustInvalid');
        const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        const id = randomUUID(), expires = now() + 300000;
        pending.clear();
        const review = { schema_version: 'touba-registry-trust-review-v1', id, registry, keys,
          previous_digest: before ? hash(before) : null, review_digest: hash(bytes), expires_at: new Date(expires).toISOString() };
        pending.set(id, { principal, bytes, review, expires });
        return review;
      } finally { busy = false; }
    },
    apply(principal, request) {
      if (busy) fail('RegistryTrustBusy');
      const item = pending.get(request?.id);
      if (!item || item.principal !== principal || item.expires <= now() || request.review_digest !== item.review.review_digest
        || Object.keys(request).some(key => !['id', 'review_digest'].includes(key))) fail('RegistryTrustReviewRequired');
      const before = current();
      if ((before ? hash(before) : null) !== item.review.previous_digest) fail('RegistryTrustReviewRequired');
      pending.delete(request.id);
      // Persist key continuity before replacement. A revoked key never becomes active again.
      registryTrustState(path + '.sqlite', registry).observe(trustedKeys(JSON.parse(item.bytes), registry));
      if (before) {
        const backup = `${path}.${hash(before).slice(7)}.previous`;
        try { writeFileSync(backup, before, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST' || !lstatSync(backup).isFile() || !readFileSync(backup, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }).equals(before)) throw error; }
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, item.bytes, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
      } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      activate(item.bytes);
      return { status: 'configured', registry, review_digest: item.review.review_digest };
    },
    close() { pending.clear(); },
  };
}
