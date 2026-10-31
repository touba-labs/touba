// Browser origins only. This is not a credential or an execution permission.
export function projectClientOrigins(values = []) {
  if (!Array.isArray(values) || values.length > 16) throw invalid();
  const origins = new Set();
  for (const value of values) {
    let url;
    try { url = new URL(value); } catch { throw invalid(); }
    if (typeof value !== "string" || value.length > 2048 || url.protocol !== "https:"
      || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.hostname.includes("*") || (value !== url.origin && value !== `${url.origin}/`)) throw invalid();
    origins.add(url.origin);
  }
  return origins;
}

export function applyProjectCorsHeaders(request, response, configured) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowed(origin, configured)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id, x-touba-identity-token");
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "Origin");
  // No cookies, wildcard or bypass of browser local-network consent.
  return true;
}

function allowed(origin, configured) {
  try {
    if (origin === "tauri://localhost") return true;
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return false;
    return configured.has(origin) || ["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(url.hostname)
      || url.hostname.endsWith(".localhost");
  } catch { return false; }
}

function invalid() {
  return Object.assign(new Error("client origins must be at most 16 exact HTTPS origins without credentials, paths or wildcards"),
    { code: "ToubaServeClientOriginInvalid" });
}
