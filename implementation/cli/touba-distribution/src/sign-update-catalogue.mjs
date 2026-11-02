import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { toolchainBuildIdentity } from './build-identity.mjs';
import { digest, fail, MAX_ARCHIVE, validatePolicy, verifyCatalogue } from '../../touba-project/src/update/protocol.mjs';
import { extractPayload } from '../../touba-project/src/update/transfer.mjs';

export function generateUpdateKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  return { id: digest(publicKey.export({ type: 'spki', format: 'der' })), public_key: publicKey.export({ type: 'spki', format: 'pem' }) };
}

/** Signing verifies bytes and metadata. Native qualification and release approval remain separate gates. */
export async function signUpdateCatalogue({ manifest, privateKey, policy, now = Date.now() }) {
  validatePolicy(policy);
  const key = createPrivateKey(privateKey), publicKey = createPublicKey(key);
  const id = digest(publicKey.export({ type: 'spki', format: 'der' }));
  if (key.asymmetricKeyType !== 'ed25519' || !policy.keys.some(item => item.id === id)) fail('UpdateSigningKeyUntrusted');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 4) fail('UpdateMetadataInvalid');
  const releases = [];
  for (const artifact of manifest.artifacts) {
    const stat = lstatSync(artifact.archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE) fail('UpdateArchiveLimit');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(artifact.archive)) hash.update(chunk);
    const work = mkdtempSync(join(tmpdir(), 'touba-catalogue-'));
    try {
      const { root, expanded } = await extractPayload(artifact.archive, join(work, 'extracted'));
      const metadata = JSON.parse(readFileSync(join(root, 'TOOLCHAIN.json'), 'utf8'));
      const identity = toolchainBuildIdentity(root);
      if (Object.entries(identity).some(([field, value]) => metadata.build?.[field] !== value)) fail('UpdateBuildIdentityMismatch');
      const embedded = validatePolicy(JSON.parse(readFileSync(join(root, 'lib/cli/touba-project/src/update/trust.json'), 'utf8')));
      if (embedded.catalogue_url !== policy.catalogue_url || embedded.channel !== policy.channel) fail('UpdateBuildMetadataMismatch');
      releases.push({ platform: metadata.platform, version: metadata.touba_version, build_id: metadata.build.id,
        build_sequence: embedded.build_sequence, url: artifact.url, sha256: hash.digest('hex'), size: stat.size,
        expanded_size: expanded, notes: artifact.notes ?? '' });
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  const catalogue = { schema: 'touba-update-catalogue-v1', channel: policy.channel, sequence: manifest.sequence,
    issued_at: manifest.issued_at, expires_at: manifest.expires_at, releases };
  const payload = Buffer.from(JSON.stringify(catalogue));
  const envelope = Buffer.from(JSON.stringify({ schema: 'touba-update-envelope-v1', key_id: id,
    payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n');
  verifyCatalogue(envelope, policy, { now });
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'keygen' && args.length === 1) {
      // Only the public key is printed. The private key is created once, mode 0600.
      process.stdout.write(JSON.stringify(generateUpdateKey(resolve(args[0])), null, 2) + '\n');
    } else if (command === 'sign' && args.length === 3) {
      const [input, keyPath, output] = args.map(path => resolve(path));
      const stat = lstatSync(keyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('UpdateSigningKeyPermissions');
      const manifest = JSON.parse(readFileSync(input, 'utf8'));
      for (const artifact of manifest.artifacts ?? []) artifact.archive = resolve(dirname(input), artifact.archive);
      const policy = JSON.parse(readFileSync(new URL('../../touba-project/src/update/trust.json', import.meta.url), 'utf8'));
      const bytes = await signUpdateCatalogue({ manifest, privateKey: readFileSync(keyPath), policy });
      writeFileSync(output, bytes, { flag: 'wx', mode: 0o644 });
      process.stdout.write('Signed catalogue created. No upload performed.\n');
    } else throw new Error('Usage: node sign-update-catalogue.mjs keygen PRIVATE_KEY_PATH | sign MANIFEST PRIVATE_KEY_PATH OUTPUT');
  } catch (error) {
    process.stderr.write(`Catalogue not created: ${error.code ?? error.message}\n`);
    process.exitCode = 2;
  }
}
