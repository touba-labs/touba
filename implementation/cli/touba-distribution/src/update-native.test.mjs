import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { createReadStream, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { packageLocalToolchain } from './package-local-toolchain.mjs';
import { generateUpdateKey, signUpdateCatalogue } from './sign-update-catalogue.mjs';
import { toolchainBuildIdentity } from './build-identity.mjs';
import { installDesktop } from './desktop-install.mjs';
import { ensureSpace } from '../../touba-project/src/update/platform.mjs';

const require = createRequire(new URL('../../touba-project/package.json', import.meta.url));
const { c } = require('tar');

// Opt-in: assembles a real native toolchain and opens only a loopback TLS server.
// Ephemeral signing/CA keys never enter a release or the personal installation.
test('native CLI: TLS check, real update, compiler/doctor and offline rollback', {
  skip: process.env.TOUBA_QUALIFY_UPDATE !== '1', timeout: 600000,
}, async t => {
  ensureSpace(tmpdir(), 1600 * 1024 ** 2);
  const work = mkdtempSync(join(tmpdir(), 'touba-native-update-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const cert = join(work, 'local-ca.pem'), tlsKey = join(work, 'local-key.pem');
  execFileSync(process.env.OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', tlsKey, '-out', cert], { stdio: 'pipe' });
  let catalogue, archive, archiveRequests = 0;
  const server = createServer({ key: readFileSync(tlsKey), cert: readFileSync(cert) }, (request, response) => {
    if (request.url === '/downloads/touba/updates.json') { response.writeHead(200); response.end(catalogue); }
    else if (request.url === '/downloads/touba/build.tar.gz') { archiveRequests++; createReadStream(archive).pipe(response); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const keyPath = join(work, 'signing.pem'), key = generateUpdateKey(keyPath);
  const policy = { schema: 'touba-update-trust-v1', channel: 'validation', build_sequence: 1,
    catalogue_url: `${origin}/downloads/touba/updates.json`, keys: [key] };
  const initial = join(work, 'initial');
  packageLocalToolchain({ toolchainRoot: initial, buildCompiler: false, quiet: true });
  if (process.platform === 'darwin') {
    // This disposable fixture uses an ephemeral catalogue key. Intel Rust
    // binaries have no implicit ad-hoc signature; seal this fixture explicitly.
    // This is not Developer ID signing or notarization of a deliverable.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', join(initial, 'bin/touba-compile')], { stdio: 'pipe' });
  }
  function identify(root, sequence) {
    writeFileSync(join(root, 'lib/cli/touba-project/src/update/trust.json'), JSON.stringify({ ...policy, build_sequence: sequence }));
    const path = join(root, 'TOOLCHAIN.json'), metadata = JSON.parse(readFileSync(path, 'utf8'));
    metadata.build = toolchainBuildIdentity(root);
    writeFileSync(path, JSON.stringify(metadata));
    return metadata;
  }
  const old = identify(initial, 1), prefix = join(work, 'installed');
  const installed = installDesktop({ source: initial, prefix });
  mkdirSync(join(prefix, 'projects'));
  writeFileSync(join(prefix, 'projects/untouched.txt'), 'keep');
  const releaseName = `touba-v${old.touba_version}-${old.platform}`;
  const candidate = join(work, releaseName, 'touba-toolchain');
  mkdirSync(join(work, releaseName));
  // Reuse the assembled source as the candidate; do not retain another full copy.
  cpSync(initial, candidate, { recursive: true });
  rmSync(initial, { recursive: true });
  const next = identify(candidate, 2);
  archive = join(work, 'build.tar.gz');
  c({ file: archive, gzip: true, sync: true, portable: true, cwd: work }, [releaseName]);
  rmSync(join(work, releaseName), { recursive: true });
  const now = Date.now();
  catalogue = await signUpdateCatalogue({ policy, privateKey: readFileSync(keyPath), manifest: { sequence: 2,
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3600000).toISOString(),
    artifacts: [{ archive, url: `${origin}/downloads/touba/build.tar.gz`, notes: 'Isolated native qualification only.' }] } });

  const active = join(prefix, 'touba-toolchain');
  const cli = installed.cli_path;
  const run = args => new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `""${cli}" ${args.join(' ')}"`], { windowsVerbatimArguments: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } })
      : spawn(cli, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 240000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`CLI ${args.join(' ')} failed (${code}): ${stdout}\n${stderr}`)); else resolve(stdout); });
  });
  assert.equal(JSON.parse(await run(['version', '--json'])).build.id, old.build.id);
  const checked = JSON.parse(await run(['update', '--check', '--json']));
  assert.equal(checked.status, 'available'); assert.equal(archiveRequests, 0);
  const updated = JSON.parse(await run(['update', '--yes', '--json']));
  assert.equal(updated.status, 'updated'); assert.equal(updated.build, next.build.id);
  assert.equal(JSON.parse(await run(['doctor', '--json'])).status, 'ok');
  assert.equal(JSON.parse(await run(['version', '--json'])).build.id, next.build.id);
  assert.equal(archiveRequests, 1);
  await new Promise(resolve => server.close(resolve));
  const rollback = JSON.parse(await run(['update', '--rollback', '--yes', '--json']));
  assert.equal(rollback.status, 'restored'); assert.equal(rollback.build, old.build.id);
  assert.equal(JSON.parse(await run(['version', '--json'])).build.id, old.build.id);
  assert.equal(readFileSync(join(prefix, 'projects/untouched.txt'), 'utf8'), 'keep');
  t.diagnostic(`Native verified: ${old.platform}; real CLI/compiler/doctor; HTTPS signature; update and offline rollback; projects preserved.`);
});
