import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { packageError } from './package-contract.mjs';

const sameFile = (path, info) => {
  try { const current = lstatSync(path); return current.isFile() && !current.isSymbolicLink() && current.ino === info.ino && current.dev === info.dev; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

// Local host only. Serialize acquisition/recovery so two terminals cannot
// reclaim the same abandoned lock and remove each other's replacement.
export function acquireDraftLock(path) {
  const guard = path + '.recovery';
  let gate;
  try { gate = openSync(guard, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw packageError('PackageDraftLockUnsafe', 'draft lock recovery is active or was interrupted; inspect the recovery guard');
    throw error;
  }
  const gateInfo = fstatSync(gate);
  try {
    writeFileSync(gate, JSON.stringify({ pid: process.pid, host: hostname() }));
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let reader, info, owner;
      try {
        if (!lstatSync(path).isFile()) throw Error('not a file');
        reader = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        info = fstatSync(reader);
        if (!info.isFile() || info.size > 1024 || (process.platform !== 'win32' && info.uid !== process.getuid())) throw Error('unsafe owner');
        owner = JSON.parse(readFileSync(reader, 'utf8'));
        if (owner?.version !== 1 || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.id !== 'string') throw Error('unverifiable owner');
      } catch { throw packageError('PackageDraftLockUnsafe', 'draft lock ownership cannot be verified'); }
      finally { if (reader !== undefined) closeSync(reader); }
      try { process.kill(owner.pid, 0); throw packageError('PackageDraftBusy', 'another draft operation is active'); }
      catch (probe) {
        if (probe.code === 'EPERM') throw packageError('PackageDraftBusy', 'another draft operation is active');
        if (probe.code !== 'ESRCH') throw probe;
      }
      if (!sameFile(path, info)) throw packageError('PackageDraftLockUnsafe', 'draft lock changed during recovery');
      unlinkSync(path);
      fd = openSync(path, 'wx', 0o600);
    }
    const info = fstatSync(fd);
    try { writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, host: hostname(), id: randomUUID() }) + '\n'); }
    catch (error) { if (sameFile(path, info)) unlinkSync(path); throw error; }
    finally { closeSync(fd); }
    return () => { if (sameFile(path, info)) unlinkSync(path); };
  } finally { closeSync(gate); if (sameFile(guard, gateInfo)) unlinkSync(guard); }
}
