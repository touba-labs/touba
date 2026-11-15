// A reusable, in-memory grant owned by one bounded command, never by the OS vault.
import { packageError } from './package-contract.mjs';

export function ephemeralRegistryIdentity(initial, { maximum = 300, refresh, release, now = Date.now, features = {} }) {
  const allowed = Number.isSafeInteger(maximum) && maximum >= 60 && maximum <= 3600;
  const until = now() + (allowed ? maximum : 300) * 1000;
  let response = initial, closed = false, clean = true;
  const expiration = (seconds, fallback) => Number.isSafeInteger(seconds) && seconds > 0
    ? Math.min(until, now() + seconds * 1000) : fallback;
  let accessUntil = expiration(response.expires_in, now());
  let refreshUntil = expiration(response.refresh_expires_in, now());
  const expired = () => packageError('RegistrySessionExpired', 'temporary session expired; confirm your identity in a new command');
  const identity = {
    ...features, persistent: false,
    get token() { if (closed) throw expired(); return response.access_token; },
    async ensureFresh() {
      if (closed || now() >= until) throw expired();
      if (accessUntil > now() + 15000) return identity;
      if (!allowed || typeof response.refresh_token !== 'string' || !response.refresh_token.length
          || response.refresh_token.length > 32768 || now() >= refreshUntil) throw expired();
      const renewed = await refresh(response.refresh_token);
      if (!renewed.ok || typeof renewed.data.access_token !== 'string' || !renewed.data.access_token.length
          || renewed.data.access_token.length > 32768) {
        throw renewed.data?.error === 'invalid_grant' ? expired()
          : packageError('PackagePublicationUnavailable', 'temporary session renewal failed; no upload was retried');
      }
      const previous = response;
      response = { ...renewed.data, refresh_token: renewed.data.refresh_token ?? previous.refresh_token };
      accessUntil = expiration(response.expires_in, now());
      refreshUntil = expiration(response.refresh_expires_in, refreshUntil);
      // The old access token is no longer needed by this sequential command.
      clean = await release({ access_token: previous.access_token }) && clean;
      if (now() >= until || accessUntil <= now()) throw expired();
      return identity;
    },
    async revoke() {
      if (closed) return clean;
      closed = true;
      try { clean = await release(response) && clean; return clean; }
      finally { response = {}; }
    },
  };
  return identity;
}
