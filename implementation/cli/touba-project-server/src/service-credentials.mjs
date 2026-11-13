import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { systemVault } from '../../touba-project/src/registry-vault.mjs';
import { expandServerConfig } from './server-config.mjs';

const failure = () => Object.assign(new Error('Project service credential unavailable. Store the current key with touba serve login --config touba.server.json --token-stdin.'), { code: 'ToubaServeVaultUnavailable' });
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.~-]{32,256}$/.test(value);

export function serviceCredentialKey(root, controlPlaneUrl) {
  const url = new URL(controlPlaneUrl);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw failure();
  return createHash('sha256').update(JSON.stringify([realpathSync(root), url.href.replace(/\/$/, '')])).digest('hex');
}

export function projectServiceCredentials(root, controlPlaneUrl, vault = systemVault({ purpose: 'project-service', asynchronous: true })) {
  const key = serviceCredentialKey(root, controlPlaneUrl);
  let reading;
  const read = () => reading ??= (async () => {
    const value = await vault.read(key);
    if (!valid(value)) throw failure();
    return value;
  })().finally(() => { reading = undefined; });
  return {
    read,
    async write(value) {
      if (!valid(value)) throw failure();
      await vault.write(key, value);
      if (await vault.read(key) !== value) throw failure();
    },
    async remove() { await vault.remove(key); },
  };
}

export async function serviceCredentialCommand(args, { cwd = process.cwd(), input = process.stdin, vault } = {}) {
  const [action, ...flags] = args;
  if (!['login', 'logout'].includes(action)) throw failure();
  if (flags.length === 1 && ['--help', '-h'].includes(flags[0])) return 'Usage: touba serve login --config touba.server.json --token-stdin\n       touba serve logout --config touba.server.json\nThe key is read from standard input, stored in the system vault and never printed.\n';
  let root = cwd, config, stdin = false;
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw failure(); seen.add(flag);
    if (flag === '--token-stdin') stdin = true;
    else if (['--config', '--project-root'].includes(flag)) {
      const value = flags[++index];
      if (!value || value.startsWith('--')) throw failure();
      if (flag === '--config') config = value; else root = resolve(cwd, value);
    } else throw failure();
  }
  if (!config || (action === 'login') !== stdin || input.isTTY && stdin) throw failure();
  const expanded = expandServerConfig(['--project-root', root, '--config', config], cwd);
  const position = expanded.indexOf('--identity-control-plane-url');
  if (position < 0 || !expanded.includes('--identity-service-token-vault')) throw failure();
  const credentials = projectServiceCredentials(root, expanded[position + 1], vault);
  if (action === 'logout') { await credentials.remove(); return 'Project service key removed from the system vault.\n'; }
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 512) throw failure();
  }
  await credentials.write(value.trim());
  return 'Project service key stored in the system vault. The server reads the current key for each authorization.\n';
}
