import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPackage, packPackage } from '../../../touba-project/src/packages.mjs';

export async function signedPackageFixture(root, registry, name = 'fixture.remote', configure = () => {}) {
  const pkg = newPackage(name, { root, publisher: 'Fixture', description: 'Synthetic signed package', license: 'Apache-2.0', version: '1.0.0' });
  await configure(pkg.path);
  const manifest = JSON.parse(readFileSync(join(pkg.path, 'touba.package.json')));
  const runtimeCompatibility = manifest.touba.runtime_compatibility;
  const packed = await packPackage(pkg.path, { output: join(root, name + '.tar.gz') });
  const bytes = readFileSync(packed.output), key = generateKeyPairSync('ed25519');
  const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const trust = { schema_version: 'touba-registry-trust-v1', registry, keys: [{ id: 'qa', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] };
  const trustPath = join(root, name + '-trust.json'); writeFileSync(trustPath, JSON.stringify(trust));
  const [namespace, short] = name.split('.');
  function proof({ status = 'validated', revision = 1, compatibility = runtimeCompatibility, withdrawal, releases = [{version: '1.0.0', bytes}], exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
    const metadataByPath = {}, entries = releases.map((release, index) => {
      const metadataPath = releases.length === 1 ? 'metadata.json' : `metadata-${index}.json`;
      const archivePath = releases.length === 1 ? 'archive.tar.gz' : `archive-${index}.tar.gz`;
      const metadata = JSON.stringify({ schema_version: 'touba-registry-package-v1', package_ref: `pkg:${name}`, namespace, name: short,
        version: release.version, kind: 'touba_package', status, ...(withdrawal ? { withdrawal } : {}), summary: 'Isolated registry fixture',
        source: { type: 'archive', url: registry + '/' + archivePath, path: archivePath, revision: digest(release.bytes) },
        compatibility: { touba: compatibility, protocols: [manifest.package_schema_version] },
        artifacts: [{ kind: 'package_archive', path: archivePath, digest: digest(release.bytes) }] });
      metadataByPath[metadataPath] = metadata;
      return { package_ref: `pkg:${name}`, version: release.version, kind: 'touba_package', status,
        metadata_path: metadataPath, metadata_digest: digest(metadata), ...(withdrawal ? { withdrawal } : {}) };
    });
    const metadata = Object.values(metadataByPath)[0];
    const index = { index_schema_version: 'touba-registry-index-v1', packages: entries };
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = encode({ alg: 'EdDSA', kid: 'qa', typ: 'touba-registry+jwt' }) + '.'
      + encode({ registry, iat: Math.floor(Date.now() / 1000), exp, revision, index });
    const result = { name, version: releases[0].version, metadata, index_jwt: message + '.' + sign(null, Buffer.from(message), key.privateKey).toString('base64url') };
    // Fixture transport only; keep the signed-evidence request's closed shape.
    return Object.defineProperty(result, 'metadataByPath', { value: metadataByPath });
  }
  return { bytes, trust, trustPath, proof };
}
