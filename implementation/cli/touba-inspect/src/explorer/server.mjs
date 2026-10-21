import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ExplorerSession, findProject, implementationRoot } from './project.mjs';

export const webRoot = join(dirname(fileURLToPath(import.meta.url)), 'web');
export const tokenCss = join(implementationRoot, 'contracts/design/touba-design-tokens-v1.css');
const assets = { 'app.mjs': ['text/javascript', 'app.mjs'], 'view.mjs': ['text/javascript', 'view.mjs'], 'style.css': ['text/css', 'style.css'], 'tokens.css': ['text/css', tokenCss] };
export async function explorerHtml(assetUri = name => name, cspSource = "'self'") {
  const html = await readFile(join(webRoot, 'index.html'), 'utf8');
  return html.replaceAll('__CSP_SOURCE__', cspSource).replace(/__ASSET_([a-z.]+)__/gu, (_, name) => assetUri(name));
}
export async function startExplorer({ root = process.cwd(), port = 0, openBrowser = true, interval = 1500 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Explorer port must be an integer from 0 to 65535');
  root = await findProject(root);
  const session = new ExplorerSession(root, { interval });
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = createServer(async (request, response) => {
    const reply = (code, type, body) => { response.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); response.end(body); };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return reply(403, 'text/plain', 'Forbidden');
      if (request.method !== 'GET') return reply(405, 'text/plain', 'Read-only');
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.authorization !== `Bearer ${token}`) return reply(401, 'text/plain', 'Unauthorized');
        if (url.pathname === '/api/state') return reply(200, 'application/json', JSON.stringify(session.state));
        if (url.pathname === '/api/source') {
          const source = session.source(url.searchParams.get('id'));
          return reply(source ? 200 : 404, 'application/json', JSON.stringify(source));
        }
        return reply(404, 'text/plain', 'Not found');
      }
      if (url.pathname === '/') return reply(200, 'text/html', await explorerHtml());
      if (url.pathname === '/favicon.ico') return reply(204, 'image/x-icon', '');
      const asset = assets[url.pathname.slice(1)];
      if (asset) return reply(200, asset[0], await readFile(asset[1] === tokenCss ? tokenCss : join(webRoot, asset[1])));
      reply(404, 'text/plain', 'Not found');
    } catch { reply(500, 'text/plain', 'Explorer request failed'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  const ready = session.start();
  if (openBrowser) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => process.stderr.write('Open the printed Explorer URL in your browser.\n')); child.unref();
  }
  return { url, session, ready, close: async () => { session.close(); await new Promise(resolve => server.close(resolve)); } };
}

export async function exploreCommand(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') options.openBrowser = false;
    else if (args[i] === '--port') { if (!/^\d+$/u.test(args[i + 1] ?? '')) throw new Error('--port requires a number'); options.port = Number(args[++i]); }
    else if (args[i] === '--help' || args[i] === '-h') { process.stdout.write('touba explore [project] [--port <number>] [--no-open]\n'); return; }
    else if (!args[i].startsWith('-') && !options.root) options.root = args[i];
    else throw new Error(`Unknown explorer argument: ${args[i]}`);
  }
  const explorer = await startExplorer(options);
  process.stdout.write(`Touba Explorer · read-only\n${explorer.url}\nPress Ctrl+C to close.\n`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); await explorer.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
