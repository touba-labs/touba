import { createHash } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { resolve, relative } from "node:path";
import { requiredResourceReferences } from "./resource-bindings.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function read(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail("ResourceBindingsReadFailed", "resource bindings require a regular file of at most 2 MiB");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size === bytes.length) fail("ResourceBindingsReadFailed", "resource bindings exceed 2 MiB");
    return bytes.subarray(0, size);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Paths and fingerprints only: no backend configuration enters the run plan. */
export function snapshotResourceBindings(paths, baseDir) {
  return paths.map(path => ({ path: relative(baseDir, path).split("\\").join("/"), digest_sha256: digest(read(path)) }));
}

export function loadResourceBindingFiles(entries, baseDir) {
  if (!Array.isArray(entries) || entries.length > 256) fail("ResourceBindingsSchemaMismatch", "resource binding files must be a bounded list");
  if (!entries.length) return undefined;
  const resources = Object.create(null), required = new Set(), paths = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path.trim() || entry.path.includes("\0")
      || entry.digest_sha256 !== undefined && !/^sha256:[a-f0-9]{64}$/.test(entry.digest_sha256)) {
      fail("ResourceBindingsSchemaMismatch", "invalid resource binding file reference");
    }
    const path = resolve(baseDir, entry.path);
    if (paths.has(path)) fail("ResourceBindingDuplicate", "resource binding file is declared twice");
    paths.add(path);
    const bytes = read(path);
    if (entry.digest_sha256 !== undefined && digest(bytes) !== entry.digest_sha256) {
      fail("ResourceBindingsPreparationStale", "resource bindings changed; run touba prepare --mode write");
    }
    let document;
    try { document = JSON.parse(bytes.toString("utf8")); }
    catch { fail("ResourceBindingsReadFailed", "resource bindings must contain valid JSON"); }
    if (document?.resource_bindings_schema_version !== "touba-resource-bindings-v1"
      || !document.resources || typeof document.resources !== "object" || Array.isArray(document.resources)) {
      fail("ResourceBindingsSchemaMismatch", "invalid resource bindings document");
    }
    for (const ref of requiredResourceReferences(document)) required.add(ref);
    for (const [ref, binding] of Object.entries(document.resources)) {
      if (Object.hasOwn(resources, ref)) fail("ResourceBindingDuplicate", "a resource is bound by more than one file");
      resources[ref] = binding;
    }
  }
  return { resource_bindings_schema_version: "touba-resource-bindings-v1", resources,
    required_resources: [...required].sort() };
}

/** Project files are validated together by prepare; an entry sees only its AIR. */
export function selectResourceBindings(document, air) {
  if (!document) return undefined;
  const refs = new Set(["memories", "agents", "triggers"].flatMap(kind => (air.definitions?.[kind] ?? []).map(value => value.id)));
  return { ...document, resources: Object.fromEntries(Object.entries(document.resources).filter(([ref]) => refs.has(ref))),
    required_resources: requiredResourceReferences(document).filter(ref => refs.has(ref)) };
}
