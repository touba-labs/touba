import { spawn } from 'node:child_process';
import { assertFleetReview, readProjectFleet } from './project-fleet.mjs';

/** Foreground ownership: each child is this supervisor's process, never an adopted PID. */
export function createFleetSupervisor({ cli, spawnImpl = spawn, notify = () => {}, stopTimeout = 10000 } = {}) {
  if (!cli?.command || !Array.isArray(cli.args)) throw new Error('ToubaFleetCliInvalid');
  const children = new Map(), state = new Map();
  let starting = false, stopping = false;
  const report = (id, status, code = null) => { state.set(id, { id, status, code }); notify({ id, status, code }); };
  return {
    status: () => [...state.values()],
    async start(file, digest) {
      if (starting || children.size || stopping) throw new Error('ToubaFleetBusy');
      starting = true;
      try {
        const plan = assertFleetReview(file, digest);
        for (const project of [...plan.deployment_targets, ...plan.projects]) {
          // Re-read before each launch. An external edit cancels the remainder.
          if (readProjectFleet(file).review_digest !== digest) throw new Error('ToubaFleetReviewRequired');
          try {
            const arguments_ = project.storage
              ? ['deploy', 'target', 'serve', '--storage', project.storage, '--host', project.host, '--port', String(project.port), '--auth-token-env', project.auth_token_env]
              : ['serve', '--project-root', project.root, '--config', project.config];
            const child = spawnImpl(cli.command, [...cli.args, ...arguments_], {
              cwd: project.root ?? project.storage, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
            children.set(project.id, child); report(project.id, 'starting');
            child.once('spawn', () => { if (children.get(project.id) === child) report(project.id, 'running'); });
            child.once('error', () => { children.delete(project.id); report(project.id, 'failed', 'ToubaFleetChildStartFailed'); });
            child.once('exit', code => { children.delete(project.id); report(project.id, stopping ? 'stopped' : 'exited', code); });
          } catch { report(project.id, 'failed', 'ToubaFleetChildStartFailed'); }
        }
        return plan;
      } finally { starting = false; }
    },
    async stop() {
      if (starting) throw new Error('ToubaFleetBusy');
      if (stopping) throw new Error('ToubaFleetBusy');
      stopping = true;
      try {
        await Promise.all([...children].map(([id, child]) => new Promise(resolve => {
          let finished = false, timer;
          const done = (confirmed = true) => {
            if (finished) return;
            finished = true; clearTimeout(timer); child.removeListener('exit', exited);
            if (confirmed) children.delete(id);
            else report(id, 'stop_failed', 'ToubaFleetChildStopUnconfirmed');
            resolve();
          };
          const exited = () => done();
          child.once('exit', exited);
          const kill = signal => { try { child.kill(signal); } catch { /* Keep ownership until exit is observed. */ } };
          timer = setTimeout(() => {
            kill('SIGKILL');
            if (!finished) timer = setTimeout(() => done(false), stopTimeout);
          }, stopTimeout);
          if (child.exitCode != null || child.signalCode != null) done(); else kill('SIGTERM');
        })));
      } finally { stopping = false; }
    },
  };
}
