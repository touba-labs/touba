import { fileURLToPath } from 'node:url';
import { readProjectFleet } from './project-fleet.mjs';
import { createFleetSupervisor } from './fleet-supervisor.mjs';
import { fleetUpgrade } from './fleet-upgrade.mjs';

const help = `Usage:
  touba fleet plan --config fleet.json
  touba fleet start --config fleet.json --review-digest <digest>
  touba fleet upgrade --config fleet.json [--apply --review-digest <digest>]

The fleet lists approved local roots and server profiles. Review includes ports
and scheduled execution. Start runs in the foreground; Ctrl+C stops its children.
Upgrade requires stopped servers. Pending or uncertain operations block their
own project. No operation is abandoned or replayed by this command.
SDK archives come from the current verified distribution. Preparation retains
existing grants; changes requiring a governance review remain blocked.
`;

export async function fleetCommand(args) {
  if (!args.length || args.length === 1 && ['--help', '-h'].includes(args[0]) || args.length === 2 && ['--help', '-h'].includes(args[1])) return { text: help, exitCode: 0 };
  const [action, ...flags] = args;
  let file, digest, apply = false, json = false; const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]; if (seen.has(flag)) throw new Error('ToubaFleetOptionsInvalid'); seen.add(flag);
    if (flag === '--apply') apply = true;
    else if (flag === '--control-stdin' && action === 'start') { /* The owning desktop closes this pipe to stop its fleet. */ }
    else if (flag === '--json') json = true;
    else if (['--config', '--review-digest'].includes(flag)) {
      const value = flags[++i]; if (!value || value.startsWith('--')) throw new Error('ToubaFleetOptionsInvalid');
      if (flag === '--config') file = value; else digest = value;
    } else throw new Error('ToubaFleetOptionsInvalid');
  }
  if (!file || !['plan', 'start', 'upgrade'].includes(action) || action !== 'upgrade' && apply
    || action === 'plan' && digest || action === 'start' && !digest || action === 'upgrade' && apply !== Boolean(digest)) throw new Error('ToubaFleetOptionsInvalid');
  if (action === 'start') {
    const supervisor = createFleetSupervisor({ cli: { command: process.execPath, args: [fileURLToPath(new URL('../../touba-project/src/main.mjs', import.meta.url))] },
      notify: event => process.stdout.write(JSON.stringify(event) + '\n') });
    let signal, requestedStop = false;
    const stop = () => { requestedStop = true; signal?.(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (seen.has('--control-stdin')) { process.stdin.once('end', stop); process.stdin.once('error', stop); process.stdin.resume(); }
    try {
      await supervisor.start(file, digest);
      await new Promise(resolve => {
        if (requestedStop) { resolve(); return; }
        signal = resolve;
        const timer = setInterval(() => {
          if (supervisor.status().every(item => ['exited', 'failed', 'stopped'].includes(item.status))) { clearInterval(timer); resolve(); }
        }, 250);
        const done = signal;
        signal = () => { clearInterval(timer); done(); };
      });
    } finally {
      await supervisor.stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      if (seen.has('--control-stdin')) { process.stdin.removeListener('end', stop); process.stdin.removeListener('error', stop); process.stdin.pause(); }
    }
    return { report: { projects: supervisor.status() }, json: true,
      exitCode: supervisor.status().some(item => ['failed', 'stop_failed'].includes(item.status) || item.status === 'exited' && item.code !== 0) ? 1 : 0 };
  }
  const upgrade = action === 'upgrade' ? fleetUpgrade() : null;
  const report = upgrade ? (apply ? await upgrade.apply(file, digest) : upgrade.plan(file)) : readProjectFleet(file);
  return { report, json, exitCode: apply && report.projects.some(item => item.status !== 'complete') ? 1 : 0,
    ...(!json ? { text: report.projects.map(item => `${item.id}: ${item.status ?? 'review'}${item.code ? ` (${item.code})` : ''}${item.port ? ` · ${item.host}:${item.port}` : ''}${item.schedule_triggers ? ' · scheduled execution enabled' : ''}`)
      .join('\n') + (report.review_digest ? `\nReview digest: ${report.review_digest}\n` : '\n') } : {}) };
}
