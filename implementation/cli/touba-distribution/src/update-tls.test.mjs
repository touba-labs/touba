import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { createUpdateTlsFixture } from './update-tls-fixture.mjs';

// Small native preflight: no toolchain build, network service or persistent CA.
test('update TLS transport trusts only the supplied ephemeral CA', { timeout: 30000 }, async t => {
  const work = mkdtempSync(join(tmpdir(), 'touba-update-tls-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const { cert, key, certificate } = createUpdateTlsFixture(work);
  const openssl = process.env.OPENSSL ?? 'openssl';
  t.diagnostic(JSON.stringify({ node: process.version, tls: process.versions.openssl,
    generator: execFileSync(openssl, ['version'], { encoding: 'utf8' }).trim(),
    ca: certificate.ca, subjectAltName: certificate.subjectAltName,
    validFrom: certificate.validFrom, validTo: certificate.validTo }));
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => response.end('ok'));
  server.on('tlsClientError', error => t.diagnostic(`TLS server: ${error.code}`));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `https://127.0.0.1:${server.address().port}`;
  const probe = async trust => {
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    // A CI environment that disables verification must never produce a pass.
    assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    if (trust) env.NODE_EXTRA_CA_CERTS = cert;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      try { const response = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) });
        console.log(JSON.stringify({ status: response.status, body: await response.text() }));
      } catch (error) { console.log(JSON.stringify({ error: error.name, code: error.cause?.code, reason: error.cause?.message ?? error.message })); process.exitCode = 1; }
    `], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  };
  const refused = await probe(false);
  assert.equal(refused.code, 1, JSON.stringify(refused));
  assert.match(refused.stdout, /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN/);
  const accepted = await probe(true);
  assert.equal(accepted.code, 0, JSON.stringify(accepted));
  assert.deepEqual(JSON.parse(accepted.stdout), { status: 200, body: 'ok' });
});
