import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPackage, packPackage } from '../../../touba-project/src/packages.mjs';

export async function signedPackageFixture(root, registry, name = 'fixture.remote') {
  const pkg = newPackage(name, { root, publisher: 'Fixture', description: 'Synthetic signed package', license: 'Apache-2.0', version: '1.0.0' });
  const packed = await packPackage(pkg.path, { output: join(root, name + '.tar.gz') });
  const bytes = readFileSync(packed.output), key = generateKeyPairSync('ed25519');
  const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const trust = { schema_version: 'touba-registry-trust-v1', registry, keys: [{ id: 'qa', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] };
  const trustPath = join(root, name + '-trust.json'); writeFileSync(trustPath, JSON.stringify(trust));
  const [namespace, short] = name.split('.');
  function proof({ status = 'validated', revision = 1, compatibility = '>=1.0.0 <2.0.0', exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
    const metadata = JSON.stringify({ schema_version: 'touba-registry-package-v1', package_ref: `pkg:${name}`, namespace, name: short,
      version: '1.0.0', kind: 'touba_package', status, summary: 'Isolated registry fixture',
      source: { type: 'archive', url: registry + '/archive.tar.gz', path: 'archive.tar.gz', revision: packed.digest },
      compatibility: { touba: compatibility, protocols: ['touba-package-v1'] },
      artifacts: [{ kind: 'package_archive', path: 'archive.tar.gz', digest: digest(bytes) }] });
    const index = { index_schema_version: 'touba-registry-index-v1', packages: [{ package_ref: `pkg:${name}`, version: '1.0.0', kind: 'touba_package', status,
      metadata_path: 'metadata.json', metadata_digest: digest(metadata) }] };
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = encode({ alg: 'EdDSA', kid: 'qa', typ: 'touba-registry+jwt' }) + '.'
      + encode({ registry, iat: Math.floor(Date.now() / 1000), exp, revision, index });
    return { name, version: '1.0.0', metadata, index_jwt: message + '.' + sign(null, Buffer.from(message), key.privateKey).toString('base64url') };
  }
  return { bytes, trust, trustPath, proof };
}
