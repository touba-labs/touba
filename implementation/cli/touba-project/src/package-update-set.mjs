import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGE_LIMITS, PACKAGE_NAME, exactPackageVersion, packageDigest, packageError } from './package-contract.mjs';
import { createRegistryReader, readPackageBytes } from './package-fetch.mjs';
import { resolveRegistryArchive, reviewPackageUpdates } from './packages.mjs';
import schema from '../../../contracts/packages/touba-package-update-set-v1.schema.json' with { type: 'json' };
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';

const invalid = () => { throw packageError('PackageUpdateSetInvalid', 'provide a bounded touba-package-update-set-v1 document with explicit local sources or exact registry versions and trust files'); };
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0-\x1f\x7f]/u.test(value);
export function validatePackageUpdateSet(document) {
  if (validateObject(schema, document).length) invalid();
  for (const item of document.packages) {
    if (Object.hasOwn(item, 'path')) { if (!string(item.path)) invalid(); }
    else if (!string(item.name) || !PACKAGE_NAME.test(item.name) || !exactPackageVersion(item.version)
      || !string(item.registry) || !string(item.trust)) invalid();
  }
  return document;
}
export async function updatePackageSet(file, options = {}) {
  if (!string(file)) invalid();
  file = resolve(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) invalid();
  let document;
  try { document = JSON.parse(readFileSync(file, 'utf8')); } catch { invalid(); }
  validatePackageUpdateSet(document);
  const staging = mkdtempSync(join(tmpdir(), 'touba-update-set-sources-')), readers = new Map(), paths = [], sources = [];
  let bytes = 0;
  try {
    for (const [index, item] of document.packages.entries()) {
      if (item.path) {
        const path = resolve(dirname(file), item.path); paths.push(path); sources.push({ path }); continue;
      }
      const registry = /^https?:\/\//.test(item.registry) ? item.registry : resolve(dirname(file), item.registry);
      let reader = readers.get(registry);
      if (!reader) { reader = createRegistryReader(registry, { noBrowser: options['no-browser'] === true, sessionOnly: options['session-only'] === true }); readers.set(registry, reader); }
      const selected = { registry, trust: resolve(dirname(file), item.trust), version: item.version };
      const trustBytes = await readPackageBytes(selected.trust, 65536);
      const { artifact, location } = await resolveRegistryArchive(item.name, selected, reader.readBytes);
      const content = await reader.readBytes(location, PACKAGE_LIMITS.totalBytes);
      bytes += content.length;
      if (bytes > PACKAGE_LIMITS.totalBytes) throw packageError('PackageTooLarge', 'update set exceeds the archive byte limit');
      if (packageDigest(content) !== artifact.digest) throw packageError('PackageIntegrityMismatch', 'registry archive digest mismatch');
      if (!trustBytes.equals(await readPackageBytes(selected.trust, 65536))) throw packageError('PackageReviewChanged', 'registry trust changed during verification');
      const path = join(staging, `${index}.tar.gz`); writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      paths.push(path); sources.push({ registry, version: item.version, archive_digest: artifact.digest, expected_name: item.name,
        trust_digest: packageDigest(trustBytes) });
    }
    return await reviewPackageUpdates(paths, { ...options, sourceReviews: sources });
  } finally {
    try { await Promise.all([...readers.values()].map(reader => reader.close())); }
    finally { rmSync(staging, { recursive: true, force: true }); }
  }
}
