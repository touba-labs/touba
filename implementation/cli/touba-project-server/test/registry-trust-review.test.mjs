import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRegistryTrustReview } from '../src/registry-trust-review.mjs';
import { createProjectPackageSurface } from '../src/package-surface.mjs';
import { initProject } from '../../touba-project/src/project.mjs';
import { signedPackageFixture } from './fixtures/signed-package.mjs';

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-trust-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = 'https://cloud.example.test/registry';
  const key = id => ({ id, status: 'active', public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) });
  let document = { schema_version: 'touba-registry-trust-v1', registry, keys: [key('first')] };
  let calls = 0, serviceKey = 'service-key'; const activations = [];
  const options = { controlPlaneUrl: 'https://cloud.example.test/api/v1/studio', serviceToken: () => serviceKey,
    onChange: value => activations.push(value), fetchImpl: async (url, request) => {
      calls++; assert.equal(url, registry + '/studio-trust'); assert.equal(request.redirect, 'error');
      assert.equal(request.headers['x-touba-service-token'], serviceKey);
      assert.equal(JSON.parse(request.body).access_token, 'owner-grant');
      return Response.json(document);
    } };
  const review = createRegistryTrustReview(root, options); t.after(() => review.close());
  return { root, registry, key, options, review, activations, calls: () => calls, document,
    setDocument: value => { document = value; }, rotate: () => { serviceKey = 'rotated-key'; } };
}

test('own Cloud keys require an explicit principal-bound review and survive restart without a server flag', async t => {
  const f = setup(t), path = join(f.root, 'touba.registry-trust.json');
  const preview = await f.review.preview('alice:session', 'owner-grant');
  assert.equal(existsSync(path), false); assert.equal(f.activations.length, 0);
  assert.match(preview.keys[0].fingerprint, /^[a-f0-9]{64}$/);
  const request = { id: preview.id, review_digest: preview.review_digest };
  assert.throws(() => f.review.apply('bob:session', request), { code: 'RegistryTrustReviewRequired' });
  assert.throws(() => f.review.apply('alice:session', { ...request, registry: 'https://evil.example' }), { code: 'RegistryTrustReviewRequired' });
  assert.equal(f.review.apply('alice:session', request).status, 'configured');
  assert.deepEqual(JSON.parse(readFileSync(path)), f.document);
  assert.equal(f.activations.length, 1);
  assert.throws(() => f.review.apply('alice:session', request), { code: 'RegistryTrustReviewRequired' });
  const restarted = createRegistryTrustReview(f.root, f.options); t.after(() => restarted.close());
  assert.equal(f.activations.length, 2);
  f.rotate(); await restarted.preview('alice:new-session', 'owner-grant');
  assert.equal(f.calls(), 2);
});

test('expiry, drift, foreign origin, oversize and preconfigured external trust fail closed', async t => {
  const f = setup(t); let now = 0;
  const review = createRegistryTrustReview(f.root, { ...f.options, now: () => now }); t.after(() => review.close());
  let preview = await review.preview('alice', 'owner-grant'); now = 300001;
  assert.throws(() => review.apply('alice', { id: preview.id, review_digest: preview.review_digest }), { code: 'RegistryTrustReviewRequired' });
  preview = await review.preview('alice', 'owner-grant');
  writeFileSync(join(f.root, 'touba.registry-trust.json'), JSON.stringify(f.document));
  assert.throws(() => review.apply('alice', { id: preview.id, review_digest: preview.review_digest }), { code: 'RegistryTrustReviewRequired' });
  f.setDocument({ ...f.document, registry: 'https://foreign.example/registry' });
  await assert.rejects(review.preview('alice', 'owner-grant'), { code: 'RegistryTrustInvalid' });
  const outside = createRegistryTrustReview(f.root, { ...f.options, configuredRegistry: f.registry, configuredTrust: '/operator/trust.json' });
  assert.equal(outside.available, false);
  await assert.rejects(outside.preview('alice', 'owner-grant'), { code: 'RegistryTrustUnavailable' });
  const large = createRegistryTrustReview(f.root, { ...f.options, fetchImpl: async () => new Response('x'.repeat(65537)) });
  await assert.rejects(large.preview('alice', 'owner-grant'), { code: 'RegistryTrustInvalid' });
});

test('approved trust activates signed installation, invalidates pending previews and keeps revocation sticky', async t => {
  const f = setup(t); initProject({ root: f.root });
  const fixture = await signedPackageFixture(f.root, f.registry);
  f.setDocument(fixture.trust);
  const surface = createProjectPackageSurface(f.root); t.after(() => surface.close());
  const review = createRegistryTrustReview(f.root, { ...f.options, onChange: value => surface.configureRegistry(value) });
  t.after(() => review.close());
  async function accept() { const p = await review.preview('alice', 'owner-grant'); return review.apply('alice', { id: p.id, review_digest: p.review_digest }); }
  assert.equal(surface.registry().configured, false); await accept();
  assert.equal(surface.registry().configured, true);
  const resolution = await surface.resolveRegistry('alice', fixture.proof());
  const pending = await surface.previewRegistry('alice', resolution.id, fixture.bytes);
  f.setDocument({ ...fixture.trust, keys: [{ ...fixture.trust.keys[0], status: 'revoked' }, f.key('next')] });
  await accept();
  await assert.rejects(surface.apply('alice', pending), { code: 'ToubaServePackagePreviewMissing' });
  f.setDocument(fixture.trust); await accept();
  await assert.rejects(surface.resolveRegistry('alice', fixture.proof()), { code: 'RegistryKeyUntrusted' });
  assert.equal(surface.inventory().packages.length, 0);
});

test('symlink trust targets are refused without overwriting them', async t => {
  const f = setup(t), elsewhere = join(f.root, 'keep.json');
  writeFileSync(elsewhere, JSON.stringify(f.document));
  symlinkSync(elsewhere, join(f.root, 'touba.registry-trust.json'));
  await assert.rejects(f.review.preview('alice', 'owner-grant'), { code: 'RegistryTrustInvalid' });
  assert.deepEqual(JSON.parse(readFileSync(elsewhere)), f.document);
});
