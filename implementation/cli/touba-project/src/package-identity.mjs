import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { packageError } from './package-contract.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function publicationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw packageError('PackagePublicationTargetInvalid', 'choose a registry HTTPS URL'); }
  if (url.username || url.password || url.search || url.hash || /[\x00-\x20\\]/.test(value)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw packageError('PackagePublicationTargetInvalid', 'HTTPS is required; local development may use a loopback address');
  }
  return url.href.replace(/\/$/, '');
}

export async function publicationBytes(url, options = {}, maximum = 131072) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options, redirect: 'error' });
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error('response_limit');
      chunks.push(chunk);
    }
    return { ok: response.ok, status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
  } catch {
    throw packageError('PackagePublicationUnavailable', 'publication service or identity provider is unavailable');
  }
}

export async function publicationDocument(url, options = {}) {
  const response = await publicationBytes(url, options);
  try {
    const data = JSON.parse(response.bytes);
    if (!object(data)) throw new Error('invalid_document');
    return { ok: response.ok, status: response.status, data };
  } catch { throw packageError('PackagePublicationUnavailable', 'invalid response from the publication service'); }
}

const form = values => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return; // The displayed URL works on every platform.
  const child = spawn(command, [url], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

export async function authorizeRegistry(registry, { access = 'publication', noBrowser = false, notify = text => process.stderr.write(text + '\n'), signal } = {}) {
  const document = (url, options = {}) => publicationDocument(url, { ...options,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const config = await document(registry + '/config.json');
  const authorization = config.data[access === 'read' ? 'read_authorization' : 'authorization'];
  if (!config.ok || config.data.registry !== registry || !object(authorization)) throw packageError('PackagePublicationConfigurationInvalid', 'registry identity configuration is invalid');
  const { issuer: supplied, client_id, scope, acr } = authorization;
  const issuer = publicationUrl(supplied);
  if (typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(client_id)
      || typeof scope !== 'string' || scope.length > 256 || typeof acr !== 'string' || acr.length > 64) throw packageError('PackagePublicationConfigurationInvalid', 'invalid identity client');
  const discovery = await document(issuer + '/.well-known/openid-configuration');
  if (!discovery.ok || discovery.data.issuer !== issuer) throw packageError('PackagePublicationConfigurationInvalid', 'identity discovery differs from the selected issuer');
  const { device_authorization_endpoint: device, token_endpoint: endpoint, revocation_endpoint: revoke } = discovery.data;
  for (const url of [device, endpoint, revoke]) {
    if (typeof url !== 'string' || !publicationUrl(url).startsWith(issuer + '/')) throw packageError('PackagePublicationConfigurationInvalid', 'identity endpoint is outside its issuer');
  }
  const requested = await document(device, form({ client_id, scope, acr_values: acr }));
  const attempt = requested.data;
  if (!requested.ok || typeof attempt.device_code !== 'string' || attempt.device_code.length > 4096
      || typeof attempt.user_code !== 'string' || !/^[A-Z0-9-]{4,20}$/i.test(attempt.user_code)
      || !Number.isInteger(attempt.expires_in) || attempt.expires_in < 1 || attempt.expires_in > 600) {
    throw packageError('PackagePublicationAuthenticationFailed', 'could not start browser authentication');
  }
  let browser;
  try { browser = new URL(attempt.verification_uri_complete ?? attempt.verification_uri); }
  catch { throw packageError('PackagePublicationConfigurationInvalid', 'invalid verification page'); }
  if (browser.username || browser.password || browser.hash || browser.origin !== new URL(issuer).origin || !browser.pathname.startsWith(new URL(issuer).pathname + '/')) throw packageError('PackagePublicationConfigurationInvalid', 'verification page is outside the identity provider');
  notify(`Open ${browser.href}\nConfirm code ${attempt.user_code} to authorize this terminal operation.`);
  if (!noBrowser) openBrowser(browser.href);
  const expires = Date.now() + attempt.expires_in * 1000;
  let interval = Number.isInteger(attempt.interval) ? Math.max(1, Math.min(15, attempt.interval)) : 5;
  while (Date.now() < expires) {
    await sleep(interval * 1000, undefined, { signal });
    const response = await document(endpoint, form({ client_id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: attempt.device_code }));
    if (response.ok && typeof response.data.access_token === 'string' && response.data.access_token.length <= 32768) {
      return { token: response.data.access_token, async revoke() {
        // Neither token is saved locally. Revoke the provider grants when the
        // operation finishes; no automatic refresh or persistent publication key.
        for (const [token, token_type_hint] of [[response.data.refresh_token, 'refresh_token'], [response.data.access_token, 'access_token']]) {
          if (token) await fetch(revoke, { ...form({ client_id, token, token_type_hint }), redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => {});
        }
      } };
    }
    if (response.data.error === 'authorization_pending') continue;
    if (response.data.error === 'slow_down') { interval = Math.min(30, interval + 5); continue; }
    throw packageError('PackagePublicationAuthenticationFailed', 'browser authorization was refused or expired');
  }
  throw packageError('PackagePublicationAuthenticationExpired', 'browser authorization expired; retry when ready');
}
