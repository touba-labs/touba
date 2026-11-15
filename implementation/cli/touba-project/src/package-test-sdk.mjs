import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_RUNTIME_VERSION, packageError } from './package-contract.mjs';

/** Resolve public SDK imports to this toolchain, never an author's installation.
 * Small forwarding modules live above the extracted package, outside its
 * inventory. They execute the real SDK and leave its files and dependencies
 * in their original layout. No package manager or contributor hook is run.
 */
export function stagePackageTestSdk(staging) {
  const root = new URL('../../../runtime/touba-handler-sdk/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (manifest.name !== '@touba/sdk' || manifest.version !== PACKAGE_RUNTIME_VERSION
      || !manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) {
    throw packageError('PackageTestSdkInvalid', 'the toolchain SDK metadata is inconsistent; use a complete matching distribution');
  }
  const entries = Object.entries(manifest.exports);
  if (!entries.length || entries.length > 32 || !Object.hasOwn(manifest.exports, '.')
      || !Object.hasOwn(manifest.exports, './testing')) {
    throw packageError('PackageTestSdkInvalid', 'the toolchain SDK public entries are incomplete');
  }
  const destination = join(staging, 'node_modules/@touba/sdk');
  mkdirSync(destination, { recursive: true });
  const exports = {};
  for (const [index, [name, target]] of entries.entries()) {
    if (!(name === '.' || /^\.\/[a-z]+(?:\/[a-z]+)*$/.test(name))
        || typeof target !== 'string' || !/^\.\/src\/[a-z-]+\.mjs$/.test(target)
        || !lstatSync(fileURLToPath(new URL(target, root))).isFile()) {
      throw packageError('PackageTestSdkInvalid', 'the toolchain SDK has an unsupported public entry');
    }
    const filename = `entry-${index}.mjs`;
    writeFileSync(join(destination, filename), `export * from ${JSON.stringify(new URL(target, root).href)};\n`, { flag: 'wx', mode: 0o600 });
    exports[name] = './' + filename;
  }
  writeFileSync(join(destination, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, private: true, type: 'module', exports,
  }) + '\n', { flag: 'wx', mode: 0o600 });
}
