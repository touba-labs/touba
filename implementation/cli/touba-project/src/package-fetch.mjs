import { lstatSync, readFileSync } from "node:fs";
import { packageError } from "./package-contract.mjs";

// Bounded reads, including slow or chunked responses. No credentials in URLs,
// redirects, fallback registry, or unbounded response.arrayBuffer().
export async function readPackageBytes(location, maxBytes) {
  if (/^https?:\/\//.test(location)) {
    const url = new URL(location);
    if (url.username || url.password) throw packageError("RegistryUrlInvalid", "registry URLs must not contain credentials");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw packageError("RegistryUrlInvalid", "use HTTPS, except for loopback development");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body) throw packageError("RegistryFetchFailed", `registry returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) { await response.body.cancel(); throw packageError("PackageTooLarge", "registry response exceeds limit"); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw packageError("PackageTooLarge", "registry response exceeds limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  const stat = lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink()) throw packageError("RegistryFileMissing", "registry content must be a regular file");
  if (stat.size > maxBytes) throw packageError("PackageTooLarge", "registry file exceeds limit");
  return readFileSync(location);
}
