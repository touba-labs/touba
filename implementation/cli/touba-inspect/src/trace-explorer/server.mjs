import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findProject, implementationRoot } from '../explorer/project.mjs';
import { TraceClient } from './client.mjs';

export const webRoot = join(dirname(fileURLToPath(import.meta.url)), 'web');
export const tokensPath = join(implementationRoot, 'contracts/design/touba-design-tokens-v1.css');
const assets = { 'app.mjs': 'text/javascript', 'view.mjs': 'text/javascript', 'style.css': 'text/css', 'tokens.css': 'text/css' };
export async function traceHtml(assetUri = name => name, csp = "'self'") {
  return (await readFile(join(webRoot, 'index.html'), 'utf8')).replaceAll('__CSP_SOURCE__', csp)
    .replace(/__ASSET_([a-z.]+)__/gu, (_, name) => assetUri(name));
}
export async function startTraceExplorer({ root = process.cwd(), filename, air, port = 0, openBrowser = true } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TracePortInvalid');
  root = await findProject(root);
  const readerOptions = { filename: filename ? resolve(filename) : join(root, '.touba/traces.sqlite'), root, air };
  let client = new TraceClient(readerOptions);
  try { await client.ready; } catch (error) { await client.close(); throw error; }
  const token = randomBytes(32).toString('hex'); let origin;
  const server = createServer(async (request, response) => {
    const reply = (status, type, body) => {
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); response.end(body);
    };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return reply(403, 'text/plain', 'Forbidden');
      if (request.method !== 'GET') return reply(405, 'text/plain', 'Read-only');
      if (request.url.length > 16384) return reply(414, 'text/plain', 'Request too long');
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.authorization !== `Bearer ${token}`) return reply(401, 'text/plain', 'Unauthorized');
        const method = url.pathname.slice(5);
        if (!['list', 'select', 'query', 'detail', 'graph', 'export', 'source', 'cancel'].includes(method)) return reply(404, 'text/plain', 'Not found');
        if (method === 'cancel') {
          await client.close(); client = new TraceClient(readerOptions); await client.ready;
          return reply(200, 'application/json', '{}');
        }
        const args = JSON.parse(url.searchParams.get('q') ?? '{}');
        try { return reply(200, 'application/json', JSON.stringify(await client.request(method, args))); }
        catch (error) { return reply(400, 'application/json', JSON.stringify({ error: error.message })); }
      }
      if (url.pathname === '/') return reply(200, 'text/html', await traceHtml());
      if (url.pathname === '/favicon.ico') return reply(204, 'image/x-icon', '');
      const name = url.pathname.slice(1);
      if (Object.hasOwn(assets, name)) return reply(200, assets[name], await readFile(name === 'tokens.css' ? tokensPath : join(webRoot, name)));
      reply(404, 'text/plain', 'Not found');
    } catch { reply(400, 'application/json', JSON.stringify({ error: 'TraceRequestInvalid' })); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  try { await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); }); }
  catch (error) { await client.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  if (openBrowser) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => process.stderr.write('Open the printed Traces URL in your browser.\n')); child.unref();
  }
  return { url, client, async close() { await client.close(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
}
export async function traceExploreCommand(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write('touba trace explore [project|trace.json|journal.sqlite] [--air <file>] [--port <number>] [--no-open]\n'); return; }
    if (arg === '--no-open' && options.openBrowser === undefined) options.openBrowser = false;
    else if (arg === '--port' && options.port === undefined && /^\d+$/u.test(args[i + 1] ?? '')) options.port = Number(args[++i]);
    else if (arg === '--air' && !options.air && args[i + 1] && !args[i + 1].startsWith('-')) options.air = resolve(args[++i]);
    else if (!arg.startsWith('-') && !options.input) options.input = resolve(arg);
    else throw new Error(`Unknown trace explorer argument: ${arg}`);
  }
  if (options.input) {
    if ((await stat(options.input)).isDirectory()) options.root = options.input;
    else { options.filename = options.input; options.root = dirname(options.input); }
  }
  const explorer = await startTraceExplorer(options);
  process.stdout.write(`Touba Explorer · Traces\n${explorer.url}\nPress Ctrl+C to close.\n`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); await explorer.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
