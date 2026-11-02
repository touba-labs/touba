import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

// Test-only authority. An explicit config avoids inherited OpenSSL extensions
// conflicting with -addext (notably on the macOS runner's OpenSSL 1.1.1).
export function createUpdateTlsFixture(work) {
  const cert = join(work, 'local-ca.pem'), key = join(work, 'local-key.pem');
  const config = join(work, 'local-tls.cnf');
  writeFileSync(config, `[req]
distinguished_name = identity
x509_extensions = tls
prompt = no
[identity]
CN = 127.0.0.1
[tls]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
`);
  execFileSync(process.env.OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-config', config, '-keyout', key, '-out', cert], { stdio: 'pipe' });
  const certificate = new X509Certificate(readFileSync(cert));
  assert.equal(certificate.ca, true, 'the isolated test certificate must be a CA');
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(certificate.verify(certificate.publicKey), true);
  return { cert, key, certificate };
}
