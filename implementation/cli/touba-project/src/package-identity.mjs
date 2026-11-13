import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { packageError } from './package-contract.mjs';
import { sessionKey, sessionLock, sessionStore } from './registry-session.mjs';
import { registryVault } from './registry-vault.mjs';
import { packageLocale } from './package-diagnostics.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function publicationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw packageError('PackagePublicationTargetInvalid', 'choose a registry HTTPS URL'); }
  if (url.username || url.password || url.search || url.hash || /[\x00-\x20\\]/.test(value)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw packageError('PackagePublicationTargetInvalid', 'use HTTPS, or the exact local origin http://127.0.0.1 or http://[::1]; localhost is not accepted');
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
    return { ok: response.ok, status: response.status, headers: response.headers, data };
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

export async function authorizeRegistry(registry, options = {}) {
  registry = publicationUrl(registry);
  try { return await connectedRegistry(registry, options); }
  catch (error) {
    if (options.logout && ['PackagePublicationUnavailable', 'PackagePublicationConfigurationInvalid'].includes(error.code)) {
      const vault = options.vault ?? registryVault();
      const key = sessionKey(registry, options.access ?? 'publication');
      await sessionLock(key, () => vault.remove(key), { signal: options.signal });
      throw packageError('RegistryLogoutIncomplete', 'local credential removed; remote revocation could not be confirmed, so the remote session may remain valid until its deadline');
    }
    throw error;
  }
}

async function connectedRegistry(registry, { access = 'publication', noBrowser = false, notify = text => process.stderr.write(text + '\n'), signal, sessionOnly = false, forceLogin = false, logout = false, vault } = {}) {
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
  const store = sessionStore(registry, access, { ...authorization, issuer }, { ...(vault ? { vault } : {}) });
  const release = async response => {
    let complete = true;
    for (const [token, token_type_hint] of [[response.refresh_token, 'refresh_token'], [response.access_token, 'access_token']]) {
      if (token) {
        try { const result = await fetch(revoke, { ...form({ client_id, token, token_type_hint }), redirect: 'error', signal: AbortSignal.timeout(5000) }); complete = complete && result.ok; }
        catch { complete = false; }
      }
    }
    return complete;
  };
  const validToken = response => response.ok && typeof response.data.access_token === 'string' && response.data.access_token.length > 0 && response.data.access_token.length <= 32768;
  const finish = async (response, persistent, previous) => {
    let saved = false;
    if (persistent) {
      try { saved = store.write(response, previous); }
      catch (error) { await release(response); throw error; }
      if (!saved) { await release(response); throw packageError('RegistrySessionUnavailable', 'the identity provider did not issue a bounded reusable session; use --session-only'); }
    }
    return { token: response.access_token, persistent: saved, async revoke() { if (!saved) await release(response); } };
  };
  const run = async () => {
    let persistent = !sessionOnly && store.supported, saved;
    if ((!sessionOnly && store.supported) || logout) {
      try { saved = store.read(); }
      catch (error) {
        if (forceLogin || logout) throw error;
        persistent = false; notify(packageLocale() === 'fr'
          ? 'Coffre système indisponible. Cette opération utilisera une session temporaire.'
          : 'System credential vault unavailable. This operation will use a temporary session.');
      }
    }
    if (logout || forceLogin) {
      try {
        if (saved && !await release({ refresh_token: saved.refresh })) throw packageError('RegistryLogoutIncomplete', 'local session cleared; remote revocation could not be confirmed, revoke this session from your account');
      } finally { if (saved || logout) store.remove(); }
      saved = null;
      if (logout) return { status: 'success', command: 'package logout', registry, access, async revoke() {} };
    }
    if (forceLogin && !store.supported && !sessionOnly) throw packageError('RegistrySessionUnavailable', 'this registry does not advertise reusable sessions; use --session-only');
    if (saved) {
      const renewed = await document(endpoint, form({ client_id, grant_type: 'refresh_token', refresh_token: saved.refresh }));
      if (validToken(renewed)) return finish(renewed.data, persistent, saved);
      if (renewed.data.error !== 'invalid_grant') throw packageError('PackagePublicationUnavailable', 'session renewal failed; no new browser grant was started');
      store.remove();
    }
  const locale = packageLocale();
  const requested = await document(device, form({ client_id, scope, acr_values: acr, ui_locales: locale }));
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
  browser.searchParams.set('kc_locale', locale);
  notify(locale === 'fr'
    ? `Ouvrez ${browser.href}\nConfirmez le code ${attempt.user_code} pour autoriser ce terminal.`
    : `Open ${browser.href}\nConfirm code ${attempt.user_code} to authorize this terminal.`);
  if (!noBrowser) openBrowser(browser.href);
  const expires = Date.now() + attempt.expires_in * 1000;
  let interval = Number.isInteger(attempt.interval) ? Math.max(1, Math.min(15, attempt.interval)) : 5;
  while (Date.now() < expires) {
    await sleep(interval * 1000, undefined, { signal });
    const response = await document(endpoint, form({ client_id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: attempt.device_code }));
    if (validToken(response)) return finish(response.data, persistent);
    if (response.data.error === 'authorization_pending') continue;
    if (response.data.error === 'slow_down') { interval = Math.min(30, interval + 5); continue; }
    throw packageError('PackagePublicationAuthenticationFailed', 'browser authorization was refused or expired');
  }
  throw packageError('PackagePublicationAuthenticationExpired', 'browser authorization expired; retry when ready');
  };
  return sessionOnly ? run() : sessionLock(store.key, run, { signal });
}
