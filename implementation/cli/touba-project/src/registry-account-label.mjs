import { createHash } from 'node:crypto';

// Display only, never an authorization decision. The issuer supplied this token;
// the registry still validates the token and live memberships on every request.
export function registryAccountLabel(token) {
  try {
    if (typeof token !== 'string' || token.length > 32768) return 'account';
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.preferred_username === 'string' && /^[\p{L}\p{N}._@+-]{1,100}$/u.test(claims.preferred_username)) return claims.preferred_username;
    if (typeof claims.sub === 'string' && claims.sub.length <= 256) return 'account-' + createHash('sha256').update(claims.sub).digest('hex').slice(0, 12);
  } catch { /* Opaque tokens need no parsing for authentication. */ }
  return 'account';
}
