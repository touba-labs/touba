import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { packPackage } from './packages.mjs';
import { readPackage, packageError } from './package-contract.mjs';
import { submitPackageDraft } from './package-drafts.mjs';
import { packageLocale } from './package-diagnostics.mjs';

const integer = (value, fallback, maximum) => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw packageError('PackageSuiteLimitInvalid', 'choose a positive bounded suite limit');
  return number;
};

/** A suite is an explicit local list, never a directory scan or a publication. */
export async function submitPackageSuite(file, options = {}) {
  if (!file) throw packageError('PackageTargetRequired', 'provide a JSON array of author directories');
  const maxPackages = integer(options['max-packages'], 16, 32);
  const maxBytes = integer(options['max-bytes'], 256 * 1024 ** 2, 512 * 1024 ** 2);
  const timeout = integer(options['timeout-seconds'], 900, 1800) * 1000;
  const started = Date.now(), controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeout);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let temporary;
  try {
    const path = resolve(options.root ?? process.cwd(), file), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw packageError('PackageSuiteInvalid', 'suite must be a regular JSON file of at most 16 KiB');
    let paths;
    try { paths = JSON.parse(readFileSync(path, 'utf8')); } catch { throw packageError('PackageSuiteInvalid', 'suite must contain a JSON array of relative author directories'); }
    if (!Array.isArray(paths) || !paths.length || paths.length > maxPackages) throw packageError('PackageSuiteLimitExceeded', 'suite package count exceeds its limit');
    const base = realpathSync(dirname(path)), packages = new Map();
    temporary = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-suite-')));
    let bytes = 0;
    for (const item of paths) {
      signal.throwIfAborted();
      if (typeof item !== 'string' || !item || item.length > 1024 || isAbsolute(item) || item.split(/[\\/]/).includes('..')) throw packageError('PackageSuiteInvalid', 'author paths must stay below the suite directory');
      const root = realpathSync(resolve(base, item)), subpath = relative(base, root);
      if (subpath === '..' || subpath.startsWith('..' + '/') || isAbsolute(subpath) || subpath.startsWith('..\\')) throw packageError('PackageSuiteInvalid', 'author paths must stay below the suite directory');
      const pkg = readPackage(root, { publishing: true });
      if (packages.has(pkg.document.name)) throw packageError('PackageSuiteConflict', 'each package must occur only once in a suite');
      const packed = await packPackage(root, { output: join(temporary, `${packages.size}.tar.gz`) });
      bytes += lstatSync(packed.output).size;
      if (bytes > maxBytes) throw packageError('PackageSuiteLimitExceeded', 'suite archives exceed the byte limit');
      packages.set(pkg.document.name, { root, document: pkg.document, digest: packed.digest });
    }
    const ordered = [], visiting = new Set(), visited = new Set();
    function visit(pkg) {
      const name = pkg.document.name;
      if (visiting.has(name)) throw packageError('PackageSuiteCycle', 'suite dependencies form a cycle');
      if (visited.has(name)) return;
      visiting.add(name);
      for (const [dependency, version] of Object.entries(pkg.document.dependencies ?? {})) {
        const selected = packages.get(dependency);
        if (!selected) continue; // The archive already includes its verified closure.
        if (selected.document.version !== version) throw packageError('PackageSuiteConflict', 'suite dependency versions disagree');
        // Equal versions with different bytes must not be submitted as a coherent suite.
        const installed = readPackage(join(pkg.root, 'packages', dependency));
        const source = readPackage(selected.root);
        if (installed.digest !== source.digest) throw packageError('PackageSuiteConflict', 'a suite dependency differs from its installed locked copy');
        visit(selected);
      }
      visiting.delete(name); visited.add(name); ordered.push(pkg);
    }
    for (const pkg of packages.values()) visit(pkg);
    const results = [];
    for (const pkg of ordered) {
      try {
        signal.throwIfAborted();
        const result = await submitPackageDraft(pkg.root, { ...options, signal, expectedArchiveDigest: pkg.digest, skipUnchanged: true });
        results.push(result);
        if (result.local_link_saved === false) throw packageError('PackageDraftLinkUnavailable', 'save the returned draft ID before resuming the suite');
      } catch (error) {
        const failure = { package: pkg.document.name, version: pkg.document.version,
          status: 'error', code: signal.aborted ? 'PackageOperationCancelled' : error.code ?? 'PackageSuiteFailed' };
        if (Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0) failure.retry_after = error.retryAfter;
        if (typeof error.reason === 'string' && /^[a-z_]{1,80}$/.test(error.reason)) failure.reason = error.reason;
        results.push(failure);
        return { status: 'error', command: 'package submit-suite', results, bytes, elapsed_ms: Date.now() - started,
          notes: [packageLocale(options.lang) === 'fr'
            ? 'Lot arrêté. Les brouillons précédents restent disponibles. Vérifiez une soumission interrompue avant de réessayer ; les brouillons qualifiés inchangés ne sont pas renvoyés.'
            : 'Suite stopped. Earlier private drafts remain available. Inspect an interrupted submission before retrying; unchanged qualified drafts are not uploaded again.', JSON.stringify(failure)], exitCode: 1 };
      }
    }
    return { status: 'success', command: 'package submit-suite', results, bytes, elapsed_ms: Date.now() - started,
      notes: results.map(row => `${row.package}@${row.version}: ${packageLocale(options.lang) === 'fr'
        ? row.unchanged ? 'inchangé' : 'vérifié' : row.unchanged ? 'unchanged' : 'verified'} ${row.preview}`) };
  } finally {
    clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
