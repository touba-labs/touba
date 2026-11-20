import { lstatSync, readFileSync } from "node:fs";
import { packageError } from "./package-contract.mjs";
import { authorizeRegistry, publicationUrl } from "./package-identity.mjs";
import { setTimeout as delay } from 'node:timers/promises';

async function remoteBytes(url, maxBytes, authorization, callerSignal) {
  const deadline = Date.now() + 20000;
  const timeout = AbortSignal.timeout(20000);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, { redirect: 'error', signal,
        headers: authorization ? { Authorization: `Bearer ${authorization}` } : {} });
      if (response.status === 401 && /^Bearer(?:\s|$)/i.test(response.headers.get('www-authenticate') ?? '')) {
        await response.body?.cancel();
        throw packageError('RegistryAuthenticationRequired', 'sign in to read this private registry');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        const after = response.headers.get('retry-after');
        const wait = after === null ? 200 * (attempt + 1)
          : /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
        // Retry only transient GET failures, inside one total deadline. Never
        // retry authentication, integrity checks, redirects or write requests.
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2
          && Number.isFinite(wait) && wait >= 0 && wait <= 2000 && Date.now() + wait < deadline) {
          await delay(wait, undefined, { signal });
          continue;
        }
        throw Object.assign(packageError('RegistryFetchFailed', `registry returned HTTP ${response.status}`),
          { httpStatus: response.status });
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) { await response.body.cancel(); throw packageError('PackageTooLarge', 'registry response exceeds limit'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) throw packageError('PackageTooLarge', 'registry response exceeds limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    }
  } catch (error) {
    if (callerSignal?.aborted) throw packageError('RegistryRequestCancelled', 'registry read cancelled');
    if (timeout.aborted || error.name === 'TimeoutError') throw packageError('RegistryTimeout', 'registry did not respond within 20 seconds');
    if (error instanceof TypeError || error.code === 'ECONNRESET') throw packageError('RegistryUnavailable', 'cannot reach the selected registry');
    throw error;
  }
}

// Bounded reads, including slow or chunked responses. No credentials in URLs,
// redirects, fallback registry, or unbounded response.arrayBuffer().
export async function readPackageBytes(location, maxBytes, authorization, signal) {
  if (/^https?:\/\//.test(location)) {
    const url = new URL(location);
    if (url.username || url.password) throw packageError("RegistryUrlInvalid", "registry URLs must not contain credentials");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw packageError("RegistryUrlInvalid", "use HTTPS, except for loopback development");
    return remoteBytes(url, maxBytes, authorization, signal);
  }
  const stat = lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink()) throw packageError("RegistryFileMissing", "registry content must be a regular file");
  if (stat.size > maxBytes) throw packageError("PackageTooLarge", "registry file exceeds limit");
  return readFileSync(location);
}

// One reader per installation, no process-global credentials or token files.
export function createRegistryReader(location, { noBrowser = false, notify, signal, sessionOnly = false } = {}) {
  if (!/^https?:\/\//.test(location)) return { readBytes: readPackageBytes, close: async () => {} };
  const registry = publicationUrl(location.replace(/\/index\.json$/, ''));
  const root = new URL(registry + '/');
  let identity;
  let attempted = false;
  return {
    async readBytes(url, maximum) {
      const target = new URL(url);
      if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)
          || target.username || target.password || target.search || target.hash) {
        throw packageError('RegistryUrlInvalid', 'registry content must remain inside the selected registry');
      }
      try { return await readPackageBytes(target.href, maximum, identity?.token, signal); }
      catch (error) {
        if (error.code !== 'RegistryAuthenticationRequired' || attempted) throw error;
        attempted = true;
        identity = await authorizeRegistry(registry, { access: 'read', noBrowser, notify, signal, sessionOnly });
        return readPackageBytes(target.href, maximum, identity.token, signal);
      }
    },
    async close() { try { await identity?.revoke(); } finally { identity = undefined; } },
  };
}
