import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { packageError } from './package-contract.mjs';
import { registryVault } from './registry-vault.mjs';

export const sessionKey = (registry, access) => createHash('sha256').update(JSON.stringify([registry, access])).digest('hex');
export async function sessionLock(key, operation, { signal, wait = 20000 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw packageError('RegistrySessionUnsafe', 'invalid session lock identifier');
  const owner = createHash('sha256').update(homedir()).digest('hex').slice(0, 24);
  const folder = join(tmpdir(), 'touba-registry-locks-' + owner);
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw packageError('RegistrySessionUnsafe', 'unsafe session lock directory');
  const path = join(folder, key + '.lock'); let fd; const deadline = Date.now() + wait;
  for (;;) {
    signal?.throwIfAborted();
    try {
      fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); }
      catch (error) { closeSync(fd); unlinkSync(path); throw error; }
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let info, pid;
      try {
        info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 20) throw packageError('RegistrySessionUnsafe', 'unsafe session lock');
        pid = Number(readFileSync(path, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code === 'ESRCH' && lstatSync(path).ino === info.ino) { unlinkSync(path); continue; }
        if (error.code !== 'EPERM') throw error;
      }
      if (Date.now() >= deadline) throw packageError('RegistrySessionBusy', 'another terminal is using this registry session; retry shortly');
      await sleep(100, undefined, { signal });
    }
  }
  try { return await operation(); }
  finally { closeSync(fd); unlinkSync(path); }
}

export function sessionStore(registry, access, authorization, { vault = registryVault(), now = () => Date.now() } = {}) {
  const key = sessionKey(registry, access);
  const binding = JSON.stringify([registry, authorization.issuer, authorization.client_id, authorization.scope, authorization.acr]);
  const maximum = access === 'read' ? 28800 : 600;
  const supported = authorization.session_max_age_seconds === maximum;
  return {
    key, supported,
    read() {
      const raw = vault.read(key);
      if (!raw) return null;
      let value;
      try { value = JSON.parse(raw); } catch { vault.remove(key); return null; }
      if (!value || value.binding !== binding || typeof value.refresh !== 'string' || !value.refresh.length || value.refresh.length > 32768
        || !Number.isSafeInteger(value.until) || !Number.isSafeInteger(value.started) || value.until <= now() || value.started > now()
        || value.until - value.started > maximum * 1000 || !supported) { vault.remove(key); return null; }
      return value;
    },
    write(response, previous) {
      if (!supported || typeof response.refresh_token !== 'string' || !response.refresh_token.length || response.refresh_token.length > 32768) return false;
      const started = previous?.started ?? now();
      const until = Math.min(previous?.until ?? started + maximum * 1000,
        Number.isSafeInteger(response.refresh_expires_in) && response.refresh_expires_in > 0 ? now() + response.refresh_expires_in * 1000 : started + maximum * 1000);
      if (until <= now()) return false;
      vault.write(key, JSON.stringify({ binding, started, until, refresh: response.refresh_token }));
      return true;
    },
    remove() { vault.remove(key); },
  };
}
