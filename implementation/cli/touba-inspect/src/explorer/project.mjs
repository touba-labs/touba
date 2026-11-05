import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import path, { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compilerInputsForFile } from '../../../touba-project/src/project.mjs';
import { projectEntrypoints } from '../../../touba-project/src/project-entrypoints.mjs';
import { projectExplorer } from './model.mjs';
import { normalizeConsumerPolicies } from '../../../touba-project/src/package-governance.mjs';

export const implementationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ignored = new Set(['node_modules', '.git', '.touba', 'artifacts', 'dist', 'build', 'target', 'packages']);
const MAX_FILES = 512, MAX_BYTES = 8 * 1024 * 1024, MAX_FILE = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.split(sep).join('/');
const inside = (root, file) => { const rel = relative(root, file); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };

export function snapshotSourceId(sourceId, sourceRoot, snapshotRoot, paths = path) {
  // Rust canonicalization uses the extended Windows namespace; Node realpath may not.
  const root = paths.toNamespacedPath(paths.resolve(snapshotRoot));
  const file = paths.toNamespacedPath(paths.resolve(sourceRoot ?? snapshotRoot, sourceId));
  const rel = paths.relative(root, file);
  if (!rel || paths.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${paths.sep}`)) {
    throw new Error('ExplorerSourceOutsideSnapshot');
  }
  return rel.split(paths.sep).join('/');
}

export async function findProject(input = process.cwd()) {
  const path = await realpath(resolve(input));
  let root = (await stat(path)).isFile() ? dirname(path) : path;
  const fallback = root;
  while (true) {
    for (const name of ['touba.project.json', 'touba.package.json']) {
      try { if ((await lstat(join(root, name))).isFile()) return root; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (dirname(root) === root) return fallback;
    root = dirname(root);
  }
}

async function safeRead(root, path) {
  if (!inside(root, await realpath(path))) throw new Error('ExplorerSourceOutsideProject');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('ExplorerSourceLimit: maximum 1 MiB per source or manifest');
    const buffer=Buffer.alloc(MAX_FILE+1);
    let length=0;
    while (length < buffer.length) {
      const {bytesRead}=await fd.read(buffer,length,buffer.length-length,length);
      if (!bytesRead) break;
      length+=bytesRead;
    }
    if (length>MAX_FILE) throw new Error('ExplorerSourceLimit: source grew beyond 1 MiB');
    return buffer.subarray(0,length);
  } finally { await fd.close(); }
}
export { safeRead as readProjectSource };

export async function captureProject(root) {
  const files = [], metadata = [], roots = [], diagnostics = [], packages = [];
  let entrypoints = [];
  let toolPolicies = {};
  const packageSummary = document => {
    if (packages.some(p => p.name === document.name)) return;
    packages.push({ ...Object.fromEntries(['name', 'version', 'description', 'publisher', 'license', 'touba', 'exports', 'dependencies', 'engines', 'hosts'].filter(key => document[key] !== undefined).map(key => [key, document[key]])), contexts:(document.contexts ?? []).map(c => ({ id:c.id, description:c.description, activation:c.activation, execution_links:c.execution_links })) });
  };
  let total = 0, entries = 0;
  async function walk(directory, pkg = null, depth = 0) {
    if (depth > 32) throw new Error('ExplorerDirectoryLimit: maximum source directory depth is 32');
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (++entries > 10000) throw new Error('ExplorerDirectoryLimit: maximum 10000 directory entries');
      if (item.name.startsWith('.') || ignored.has(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`ExplorerSymlinkRefused: ${portable(relative(root, path))}`);
      if (item.isDirectory()) await walk(path, pkg, depth + 1);
      else if (item.isFile() && item.name.endsWith('.tb')) {
        const bytes = await safeRead(root, path);
        total += bytes.length;
        if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error('ExplorerSourceLimit: maximum 512 files / 8 MiB per project');
        files.push({ path: portable(relative(root, path)), text: bytes.toString('utf8'), digest: digest(bytes), package: pkg });
      }
    }
  }
  let sourceRoot = join(root, 'src');
  try { if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('ExplorerSourceRootInvalid'); }
  catch (error) { if (error.code === 'ENOENT') sourceRoot = root; else throw error; }
  roots.push(portable(relative(root, sourceRoot)) || '.');
  await walk(sourceRoot);
  for (const name of ['touba.project.json', 'touba.package.json', 'touba.packages.lock.json']) {
    try {
      const bytes = await safeRead(root, join(root, name)); metadata.push([name, digest(bytes)]);
      if (name === 'touba.package.json') {
        const document=JSON.parse(bytes); packageSummary(document);
        for (const file of files) file.package=document.name;
      }
      if (name === 'touba.project.json') {
        entrypoints = projectEntrypoints(JSON.parse(bytes));
        toolPolicies = normalizeConsumerPolicies(JSON.parse(bytes).configuration?.tool_policies);
        for (const record of JSON.parse(bytes).packages ?? []) {
          if (typeof record.manifest !== 'string' || !inside(root, await realpath(resolve(root, record.manifest)))) throw new Error('ExplorerPackageOutsideProject');
        }
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (metadata.length) {
    // Uses the same package registration/lock validation as the editor and prepare.
    const inputs = compilerInputsForFile(join(root, files[0]?.path ?? 'src/__explorer__.tb'));
    diagnostics.push(...inputs.diagnostics);
    for (const path of inputs.sourceRoots) {
      if (resolve(path) === resolve(sourceRoot)) continue;
      const packageRoot = dirname(path);
      if (!inside(root, await realpath(packageRoot))) throw new Error('ExplorerPackageOutsideProject');
      const manifest = await safeRead(root, join(packageRoot, 'touba.package.json'));
      const document = JSON.parse(manifest), name = document.name;
      packageSummary(document);
      metadata.push([portable(relative(root, packageRoot)), digest(manifest)]);
      try { if (!(await lstat(path)).isDirectory()) throw new Error('ExplorerSourceRootInvalid'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      roots.push(portable(relative(root, path)));
      await walk(path, name);
    }
  }
  const revision = digest(JSON.stringify([metadata, files.map(f => [f.path, f.digest]), diagnostics]));
  return { root, name: basename(root), files, roots, revision, diagnostics, packages, entrypoints, toolPolicies };
}

async function compilerBinary() {
  if (process.env.TOUBA_COMPILE_BIN) return resolve(process.env.TOUBA_COMPILE_BIN);
  const candidates = [join(implementationRoot, 'bin'), resolve(implementationRoot, '../bin'), join(implementationRoot, 'target/release'), join(implementationRoot, 'target/debug')];
  const available = [];
  for (const dir of candidates) {
    const path = join(dir, process.platform === 'win32' ? 'touba-compile.exe' : 'touba-compile');
    try { available.push({ path, time: (await stat(path)).mtimeMs }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const binary = available.sort((a, b) => b.time - a.time)[0]?.path;
  if (!binary) throw new Error('ExplorerCompilerMissing: install Touba or build touba-compile');
  return binary;
}

export async function compileCapture(capture, { signal } = {}) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
  if (capture.diagnostics.some(d => d.severity === 'error')) return { diagnostics: capture.diagnostics };
  if (!capture.files.length) return capture.packages.length ? { graph:projectExplorer([],capture), diagnostics:[] } : { diagnostics: [{ code: 'ExplorerNoSources', message: 'No .tb source in this project.', severity: 'error' }] };
  const binary = await compilerBinary();
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'touba-explore-')));
  try {
    for (const file of capture.files) {
      const target = join(temporary, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.text, { mode: 0o600 });
    }
    const dependencies = capture.files.flatMap(f => ['--module-source', f.path]);
    const rootArgs = capture.roots.flatMap(p => ['--source-root', p]);
    if (process.platform === 'win32' && [...dependencies, ...rootArgs].join(' ').length > 24000) throw new Error('ExplorerCompilerArgumentLimit: project source paths exceed the Windows process argument limit');
    const airs = [], diagnostics = [];
    for (const file of capture.files) {
      if (signal?.aborted) throw signal.reason;
      const args = ['--json', ...dependencies, ...rootArgs, file.path];
      const result = await new Promise((accept, reject) => execFile(binary, args, { cwd: temporary, signal, timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error && (error.killed || error.code === 'ABORT_ERR' || !stdout)) return reject(error);
        try { accept(JSON.parse(stdout)); } catch { reject(new Error('ExplorerCompilerProtocol: expected compiler JSON')); }
      }));
      const remap = value => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.source_ref?.source_id === 'string') {
          value.source_ref.source_id = snapshotSourceId(value.source_ref.source_id, result.source_root, temporary);
        }
        for (const child of Object.values(value)) remap(child);
      };
      remap(result.air); remap(result.diagnostics);
      diagnostics.push(...(result.diagnostics ?? []));
      if (!result.ok) return { diagnostics };
      airs.push(result.air);
    }
    return { graph: projectExplorer(airs, capture), diagnostics };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export class ExplorerSession {
  constructor(root, { interval = 1500 } = {}) {
    this.root = root; this.interval = interval; this.listeners = new Set();
    this.state = { status: 'loading', graph: null, diagnostics: [] };
    this.controller = new AbortController(); this.closed = false;
  }
  subscribe(listener) { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  publish(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(this.state); }
  async start() { await this.refresh(); return this; }
  async refresh() {
    if (this.closed || this.busy) return;
    clearTimeout(this.timer); this.busy = true;
    try {
      const capture = await captureProject(this.root);
      if (capture.revision === this.observed) return;
      this.observed = capture.revision;
      this.publish({ status: 'loading', diagnostics: [] });
      const result = await compileCapture(capture, { signal: this.controller.signal });
      if (this.closed) return;
      const latest = await captureProject(this.root);
      if (latest.revision !== capture.revision) { this.observed = undefined; return; }
      if (result.graph) { this.capture = capture; this.publish({ status: 'ready', ...result }); }
      else this.publish({ status: this.state.graph ? 'stale' : 'error', diagnostics: result.diagnostics });
    } catch (error) {
      if (!this.closed) { this.observed = undefined; this.publish({ status: this.state.graph ? 'stale' : 'error', diagnostics: [{ severity: 'error', code: 'ExplorerAnalysisFailed', message: String(error.message).replaceAll(this.root, '[project]') }] }); }
    } finally {
      this.busy = false;
      if (!this.closed) this.timer = setTimeout(() => this.refresh(), this.interval);
    }
  }
  source(id) {
    const node = this.state.graph?.nodes.find(n => n.id === id);
    const file = this.capture?.files.find(f => f.path === node?.source_ref?.source_id);
    return file ? { path: file.path, text: file.text, digest: file.digest, source_ref: node.source_ref } : null;
  }
  close() { this.closed = true; clearTimeout(this.timer); this.controller.abort(); this.listeners.clear(); }
}
