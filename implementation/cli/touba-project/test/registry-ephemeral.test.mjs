import test from 'node:test';
import assert from 'node:assert/strict';
import { ephemeralRegistryIdentity } from '../src/registry-ephemeral.mjs';

test('temporary refresh rotates tokens without extending the original one-hour boundary', async () => {
  let time = 1000000, refreshes = 0;
  const revoked = [];
  const identity = ephemeralRegistryIdentity({ access_token: 'access-0', refresh_token: 'refresh-0', expires_in: 300, refresh_expires_in: 3600 }, {
    maximum: 3600, now: () => time,
    refresh: async token => {
      assert.equal(token, `refresh-${refreshes}`); refreshes++;
      return { ok: true, data: { access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 300, refresh_expires_in: 3600 } };
    },
    release: async response => { revoked.push(response); return true; },
  });
  assert.equal(identity.persistent, false);
  await identity.ensureFresh(); assert.equal(refreshes, 0);
  for (let minute = 4; minute < 60; minute += 4) { time = 1000000 + minute * 60000; await identity.ensureFresh(); }
  assert.ok(refreshes > 0);
  time = 1000000 + 3600000;
  await assert.rejects(identity.ensureFresh(), { code: 'RegistrySessionExpired' });
  assert.equal(await identity.revoke(), true);
  const count = revoked.length;
  assert.equal(revoked.at(-1).refresh_token, `refresh-${refreshes}`);
  await identity.revoke(); assert.equal(revoked.length, count);
  assert.throws(() => identity.token, { code: 'RegistrySessionExpired' });
});

test('expired idle grant, refused refresh and late response never authorize another upload', async () => {
  for (const mode of ['idle', 'refused', 'unavailable', 'late']) {
    let time = 0, refreshes = 0;
    const revoked = [];
    const identity = ephemeralRegistryIdentity({ access_token: 'first', refresh_token: 'refresh', expires_in: 20, refresh_expires_in: mode === 'idle' ? 1 : 60 }, {
      maximum: 60, now: () => time,
      refresh: async () => {
        refreshes++;
        if (mode === 'late') { time = 60000; return { ok: true, data: { access_token: 'late', refresh_token: 'late-refresh', expires_in: 300 } }; }
        return { ok: false, data: { error: mode === 'refused' ? 'invalid_grant' : 'temporarily_unavailable' } };
      },
      release: async response => { revoked.push(response); return true; },
    });
    time = 10000;
    await assert.rejects(identity.ensureFresh(), { code: mode === 'unavailable' ? 'PackagePublicationUnavailable' : 'RegistrySessionExpired' });
    assert.equal(refreshes, mode === 'idle' ? 0 : 1);
    await identity.revoke();
    assert.equal(revoked.at(-1).refresh_token, mode === 'late' ? 'late-refresh' : 'refresh');
  }
});

test('cleanup failure remains explicit and never revokes twice', async () => {
  let calls = 0;
  const identity = ephemeralRegistryIdentity({ access_token: 'fixture' }, {
    refresh: async () => { throw Error('unused'); }, release: async () => { calls++; return false; },
  });
  assert.equal(await identity.revoke(), false);
  assert.equal(await identity.revoke(), false);
  assert.equal(calls, 1);
});
