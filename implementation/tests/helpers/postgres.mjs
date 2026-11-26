// Real disposable PostgreSQL for integration recipes. Docker remains the
// default; native POSIX qualification requires an explicit private binary dir.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

export async function isolatedPostgres({ user, password, database }) {
  if (![user, database].every(value => /^[a-z][a-z_]{0,40}$/.test(value))
      || typeof password !== 'string' || !/^[a-z-]{1,80}$/.test(password)) {
    throw new TypeError('invalid fixture database credentials');
  }
  const driver = process.env.TOUBA_TEST_POSTGRES_DRIVER ?? 'docker';
  if (!['docker', 'native'].includes(driver)) throw new Error('unknown fixture PostgreSQL driver');
  let port, paused = false, started = false, child, root, stopped = [];
  const container = `touba-postgres-qa-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000 }).trim();
  const signal = value => process.kill(-child.pid, value);
  const resume = () => {
    if (!paused) return;
    if (driver === 'docker') docker(['unpause', container]);
    else {
      for (const pid of [...stopped].reverse()) {
        try { process.kill(pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      signal('SIGCONT');
      stopped = [];
    }
    paused = false;
  };
  const stop = async () => {
    resume();
    if (driver === 'docker') {
      if (started) { docker(['stop', '--time', '2', container]); started = false; }
    } else if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGINT'); // PostgreSQL fast shutdown, not an OS crash.
      const killer = setTimeout(() => signal('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(killer); }
    }
    if (root) { rmSync(root, { recursive: true, force: true }); root = null; }
  };
  try {
    if (driver === 'docker') {
      docker(['run', '--detach', '--rm', '--pull', 'never', '--name', container,
        '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128', '--publish', '127.0.0.1::5432',
        '--env', `POSTGRES_USER=${user}`, '--env', `POSTGRES_PASSWORD=${password}`,
        '--env', `POSTGRES_DB=${database}`, 'postgres:17.10-alpine']);
      started = true;
      port = Number(docker(['port', container, '5432/tcp']).split(':').at(-1));
    } else {
      const bin = process.env.TOUBA_TEST_POSTGRES_BIN;
      if (process.platform === 'win32' || !bin || !isAbsolute(bin)) {
        throw new Error('native fixture requires POSIX and an absolute TOUBA_TEST_POSTGRES_BIN');
      }
      const command = name => join(bin, name);
      const version = execFileSync(command('postgres'), ['--version'], { encoding: 'utf8' }).trim();
      if (version !== 'postgres (PostgreSQL) 17.10') throw new Error('fixture requires PostgreSQL 17.10');
      root = mkdtempSync(join(tmpdir(), 'touba-postgres-native-'));
      const data = join(root, 'data'), pwfile = join(root, 'password');
      writeFileSync(pwfile, password + '\n', { mode: 0o600 });
      try {
        execFileSync(command('initdb'), ['-D', data, '-U', user, '--pwfile', pwfile,
          '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=trust'],
        { stdio: 'pipe', timeout: 30000 });
      } finally { rmSync(pwfile, { force: true }); }
      const reservation = createServer();
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
      port = reservation.address().port;
      await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      const log = openSync(join(root, 'server.log'), 'wx', 0o600);
      try {
        child = spawn(command('postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port), '-k', root,
          '-c', 'max_connections=20', '-c', 'shared_buffers=16MB', '-c', 'max_wal_size=128MB',
          '-c', 'min_wal_size=32MB', '-c', 'fsync=on', '-c', 'synchronous_commit=on'],
        { detached: true, stdio: ['ignore', log, log] });
      } finally { closeSync(log); }
      await once(child, 'spawn');
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated PostgreSQL exited during startup');
        try {
          execFileSync(command('pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-t', '1'], { stdio: 'pipe', timeout: 2000 });
          ready = true; break;
        } catch { await wait(100); }
      }
      if (!ready) throw new Error('isolated PostgreSQL did not become ready');
      execFileSync(command('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', user, database],
        { env: { ...process.env, PGPASSWORD: password }, stdio: 'pipe', timeout: 10000 });
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid fixture PostgreSQL port');
    return { driver, port, stop, resume,
      pause() {
        if (paused) throw new Error('fixture PostgreSQL already paused');
        if (driver === 'docker') { docker(['pause', container]); paused = true; }
        else {
          // PostgreSQL backends create their own process groups. Stop the
          // postmaster first, then its descendants, so existing SQL sessions
          // really become unavailable as they do under docker pause.
          signal('SIGSTOP'); paused = true;
          try {
            const parents = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
              .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
            const queue = [child.pid];
            for (const parent of queue) for (const [pid, ppid] of parents) {
              if (ppid !== parent || !Number.isSafeInteger(pid) || pid < 1) continue;
              try { process.kill(pid, 'SIGSTOP'); stopped.push(pid); queue.push(pid); }
              catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
          } catch (error) { resume(); throw error; }
        }
      },
    };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'PostgreSQL fixture startup and cleanup failed'); }
    throw error;
  }
}
