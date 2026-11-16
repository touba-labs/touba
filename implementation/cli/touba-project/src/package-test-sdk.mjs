import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_RUNTIME_VERSION, packageError } from './package-contract.mjs';

/** Resolve public SDK imports to this toolchain, never an author's installation.
 * Small forwarding modules live above the extracted package, outside its
 * inventory. They execute the real SDK and leave its files and dependencies
 * in their original layout. No package manager or contributor hook is run.
 */
export function stagePackageTestSdk(staging) {
  stageModule(staging, 'touba-handler-sdk', '@touba/sdk', ['./testing']);
  stageModule(staging, 'touba-runtime', '@touba/runtime', ['./sqlite-effect-journal']);
}

function stageModule(staging, directory, name, required) {
  const root = new URL(`../../../runtime/${directory}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (manifest.name !== name || manifest.version !== PACKAGE_RUNTIME_VERSION
      || !manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) {
    throw packageError('PackageTestSdkInvalid', 'the toolchain SDK metadata is inconsistent; use a complete matching distribution');
  }
  const entries = Object.entries(manifest.exports);
  if (!entries.length || entries.length > 32 || !Object.hasOwn(manifest.exports, '.')
      || required.some(key => !Object.hasOwn(manifest.exports, key))) {
    throw packageError('PackageTestSdkInvalid', 'the toolchain SDK public entries are incomplete');
  }
  const destination = join(staging, 'node_modules', name);
  mkdirSync(destination, { recursive: true });
  if (name === '@touba/sdk') {
    // Source identity is needed when an author test prepares a nested consumer.
    // Execution still forwards to this exact SDK and its locked dependencies.
    // Do not relax normal installed-SDK inspection for test-only metadata.
    cpSync(new URL('src/', root), join(destination, 'src'), { recursive: true });
    const contract = readFileSync(new URL('src/value-contracts.mjs', root), 'utf8');
    if (contract.trim() === 'export * from "../../../contracts/machine/value-contracts.mjs";') {
      cpSync(new URL('../../contracts/machine/value-contracts.mjs', root), join(destination, 'src/value-contracts.mjs'));
    }
  }
  const exports = {};
  for (const [index, [name, target]] of entries.entries()) {
    if (!(name === '.' || /^\.\/[a-z-]+(?:\/[a-z-]+)*$/.test(name))
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
