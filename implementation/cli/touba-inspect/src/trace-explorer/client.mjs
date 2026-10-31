import { fork } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Read-only scans have their own process: cancellation must not terminate a
 * V8 worker during ESM initialization inside the editor/server process. */
export class TraceClient {
  constructor(options) {
    this.pending = new Map(); this.next = 0; this.closed = false;
    this.temporary = mkdtempSync(join(tmpdir(), 'touba-trace-reader-')); chmodSync(this.temporary, 0o700);
    try {
      // Never pass provider credentials, NODE_OPTIONS or extension preload hooks
      // to the reader. Electron's executable also supports this Node-only mode.
      const env = { ELECTRON_RUN_AS_NODE: '1' };
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      this.worker = fork(new URL('./worker.mjs', import.meta.url), [], {
        env, execArgv: ['--max-old-space-size=192'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      });
    } catch (error) {
      rmSync(this.temporary, { recursive: true, force: true });
      throw error;
    }
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An immediately disposed view need not have awaited ready yet.
    this.ready.catch(() => {});
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.startTimer = setTimeout(() => this.fail(new Error('TraceReaderStartTimeout')), 30000);
    this.worker.on('message', message => {
      if (message.ready) { clearTimeout(this.startTimer); this.resolveReady(); return; }
      if (message.failed) { this.fail(new Error(message.error)); return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('error', error => {
      if (!this.worker.pid) this.resolveExited();
      this.fail(error);
    });
    this.worker.on('exit', (code, signal) => {
      this.resolveExited();
      if (!this.closed) this.fail(new Error(`Trace reader stopped (${signal ?? code})`));
    });
    this.worker.send({ initialize: { ...options, temporaryRoot: this.temporary } }, error => {
      if (error) this.fail(error);
    });
  }
  fail(error) {
    if (this.closed) return;
    clearTimeout(this.startTimer);
    this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.closed = true;
    this.closing = (async () => {
      // Only private disposable indices are written by this process. No project
      // handler runs here. Wait for exit before removing its temporary files.
      this.worker.kill();
      const timer = setTimeout(() => this.worker.kill('SIGKILL'), 1000);
      try { await this.exited; }
      finally { clearTimeout(timer); await rm(this.temporary, { recursive: true, force: true }); }
    })();
    this.closing.catch(() => {});
  }
  async request(method, args = {}) {
    await this.ready;
    if (this.closed) throw new Error('TraceReaderClosed');
    if (this.pending.size >= 8) throw new Error('TraceReaderBusy');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('TraceRequestTimeout')); }, method === 'select' ? 120000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.send({ id, method, args }, error => { if (error) this.fail(error); }); }
      catch (error) { this.fail(error); }
    });
  }
  async close() {
    this.fail(new Error('TraceReaderClosed'));
    await this.closing;
  }
}
