import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { indexedStore } from '../../../runtime/touba-runtime/src/sqlite-record-store.mjs';
import { readPreparedProject } from './prepared-project.mjs';
import { inspectHandlerImplementation } from './handler-implementation.mjs';

const fail = (code, field, suiteId) => { throw Object.assign(new Error(field ? `${code}: ${field}${suiteId ? ` (suite ${suiteId})` : ''}` : code),
  { code, ...(field ? { field } : {}), ...(suiteId ? { suite_id: suiteId } : {}) }); };
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const worker = fileURLToPath(new URL('./project-validation-worker.mjs', import.meta.url));
const states = ['running', 'passed', 'failed', 'no_tests', 'interrupted', 'stale'];

function projectFile(root, path) {
  if (typeof path !== 'string' || path.length > 2048 || isAbsolute(path) || path.includes('\\')
    || path.split('/').some(part => !part || ['.', '..'].includes(part))) fail('ToubaValidationPathInvalid');
  const candidate = resolve(root, path), actual = realpathSync(candidate), rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel) || lstatSync(candidate).isSymbolicLink()
    || !statSync(actual).isFile()) fail('ToubaValidationPathInvalid');
  return actual;
}

// Loaded once by the server operator, never from an HTTP request or automatic
// package discovery. This authorizes trusted host tests, not an OS sandbox.
export function readValidationPlan(root, path) {
  if (!path) return [];
  if (statSync(path).size > 512 * 1024) fail('ToubaValidationPlanInvalid');
  let plan;
  try { plan = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('ToubaValidationPlanInvalid', 'document'); }
  return validateValidationPlan(root, plan);
}

export function validateValidationPlan(root, plan) {
  root = realpathSync(root);
  if (!ownObject(plan) || plan.schema_version !== 'touba-validation-plan-v1'
    || Object.keys(plan).some(key => !['schema_version', 'suites'].includes(key))
    || !Array.isArray(plan.suites) || plan.suites.length > 32) fail('ToubaValidationPlanInvalid');
  const seen = new Set();
  return plan.suites.map((suite, index) => {
    const at = `suites[${index}]`;
    if (!ownObject(suite)) fail('ToubaValidationPlanInvalid', at);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(suite.id ?? '') || seen.has(suite.id)) fail('ToubaValidationPlanInvalid', `${at}.id`);
    const requireField = (condition, field, code = 'ToubaValidationPlanInvalid') => {
      if (!condition) fail(code, `${at}.${field}`, suite.id);
    };
    requireField(Object.keys(suite).every(key => ['id','label','kind','engine','tests','inputs','timeout_ms','python','env','tool_refs'].includes(key)), 'fields');
    requireField(typeof suite.label === 'string' && Boolean(suite.label.trim()) && suite.label.length <= 120, 'label');
    requireField(['contract','business','package'].includes(suite.kind), 'kind');
    requireField(['node','python','package'].includes(suite.engine) && (suite.kind === 'package') === (suite.engine === 'package'), 'engine');
    requireField(Array.isArray(suite.tests) && suite.tests.length >= 1 && suite.tests.length <= 32
      && new Set(suite.tests).size === suite.tests.length, 'tests');
    requireField(ownObject(suite.inputs) && Object.keys(suite.inputs).length <= 2048, 'inputs');
    requireField(Number.isSafeInteger(suite.timeout_ms) && suite.timeout_ms >= 1000 && suite.timeout_ms <= 120000, 'timeout_ms');
    requireField(Array.isArray(suite.env ?? []) && (suite.env ?? []).length <= 16, 'env');
    requireField(Array.isArray(suite.tool_refs ?? []) && (suite.tool_refs ?? []).length <= 128
      && (suite.tool_refs ?? []).every(ref => typeof ref === 'string' && ref.length <= 512 && ref.startsWith('tool:'))
      && (!(suite.tool_refs ?? []).length || suite.kind === 'contract'), 'tool_refs');
    seen.add(suite.id);
    let bytes = 0;
    for (const [position, [path, hash]] of Object.entries(suite.inputs).entries()) {
      requireField(/^sha256:[a-f0-9]{64}$/.test(hash), `inputs[${position}].digest`);
      let file;
      try { file = projectFile(root,path); } catch { fail('ToubaValidationPathInvalid', `${at}.inputs[${position}]`, suite.id); }
      bytes += statSync(file).size;
      requireField(bytes <= 64*1024*1024 && digest(readFileSync(file)) === hash, `inputs[${position}]`, 'ToubaValidationInputChanged');
    }
    for (const [position, path] of suite.tests.entries()) {
      const field = `tests[${position}]`;
      requireField(typeof path === 'string' && Object.hasOwn(suite.inputs,path), field);
      requireField(suite.engine !== 'node' || /\.test\.(?:mjs|cjs|js)$/.test(path), field);
      requireField(suite.engine !== 'python' || /\.py$/.test(path), field);
      requireField(suite.engine !== 'package' || (suite.tests.length === 1 && basename(path) === 'touba.package.json'), field);
    }
    if (suite.engine === 'python') {
      let valid = false;
      try {
        valid = ownObject(suite.python) && Object.keys(suite.python).sort().join(',') === 'command,digest'
          && typeof suite.python.command === 'string' && isAbsolute(suite.python.command) && /^sha256:[a-f0-9]{64}$/.test(suite.python.digest ?? '')
          && statSync(suite.python.command).isFile() && statSync(suite.python.command).size <= 128*1024*1024
          && digest(readFileSync(suite.python.command)) === suite.python.digest;
      } catch { /* Report the field, never an interpreter path or host error. */ }
      requireField(valid, 'python', 'ToubaValidationPythonInvalid');
    } else requireField(suite.python === undefined, 'python');
    for (const [position, key] of (suite.env ?? []).entries()) requireField(typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(key)
      && !/^(NODE_|PYTHON|LD_|DYLD_|BASH_ENV$|ENV$|PATH$|SYSTEMROOT$|WINDIR$)/.test(key), `env[${position}]`, 'ToubaValidationEnvironmentInvalid');
    return structuredClone(suite);
  });
}

export function validationStore(path) {
  return indexedStore({path, schemaVersion:'touba-validation-store-v1', maxBytes:32*1024*1024, maxRecordBytes:32768,
    indexes:{status:"json_extract(body, '$.status')",suite_id:"json_extract(body, '$.suite_id')",revision:"json_extract(body, '$.revision')"},
    keyOf: row => row.id, validate(row) {
      if (!ownObject(row) || !uuid(row.id) || !states.includes(row.status) || typeof row.suite_id !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(row.revision ?? '') || typeof row.actor !== 'string'
        || !Number.isFinite(Date.parse(row.started_at)) || typeof row.output !== 'string' || row.output.length > 16384
        || !Number.isSafeInteger(row.tests) || row.tests < 0 || !Number.isSafeInteger(row.passed) || row.passed < 0
        || ![null, 'timeout', 'output_limit', 'cancelled', 'process_failed', 'state_changed', 'server_restarted'].includes(row.reason)) fail('ToubaValidationReceiptInvalid');
    },
    checkTransaction(db) { if (db.prepare('SELECT count(*) AS n FROM records').get().n > 1000) fail('ToubaValidationHistoryFull'); },
  });
}

function readRevision(root, suite) {
  const prepared = readPreparedProject(root);
  if (!prepared) fail('ToubaValidationPreparationRequired');
  let bytes = 0;
  for (const [path, hash] of Object.entries(suite.inputs)) {
    const file = projectFile(root,path); bytes += statSync(file).size;
    if (bytes > 64*1024*1024 || digest(readFileSync(file)) !== hash) fail('ToubaValidationInputChanged');
  }
  if (suite.python && (!statSync(suite.python.command).isFile() || statSync(suite.python.command).size > 128*1024*1024
    || digest(readFileSync(suite.python.command)) !== suite.python.digest)) fail('ToubaValidationPythonInvalid');
  return digest(JSON.stringify([suite,prepared.inputs]));
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe');
      spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {timeout:2000, windowsHide:true, stdio:'ignore', shell:false});
    } else process.kill(-child.pid, 'SIGKILL');
  } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
}

export function validationProcess(root, suite) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','TMPDIR','TMP','TEMP','TOUBA_COMPILE_BIN']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const protectedValues = [];
  for (const key of suite.env ?? []) {
    if (process.env[key] === undefined) fail('ToubaValidationEnvironmentMissing');
    env[key] = process.env[key]; if (env[key]) protectedValues.push(env[key]);
  }
  env.PYTHONDONTWRITEBYTECODE = '1';
  const child = spawn(process.execPath, [worker], { cwd:root, env, detached:process.platform !== 'win32',
    stdio:['pipe','pipe','pipe'], windowsHide:true, shell:false });
  let reason = null, bytes = 0, settled = false;
  const output = [];
  const cancel = why => { reason ??= why; killTree(child); };
  const result = new Promise(resolveResult => {
    const timer = setTimeout(() => cancel('timeout'), suite.timeout_ms);
    const finish = (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer); killTree(child);
      let text = Buffer.concat(output).toString('utf8');
      for (const secret of protectedValues) text = text.replaceAll(secret, '[REDACTED]');
      const summary = [...text.matchAll(/^# TOUBA_VALIDATION tests=(\d+) passed=(\d+)$/gm)].at(-1);
      const total = Number(summary?.[1] ?? 0);
      const passed = Number(summary?.[2] ?? 0);
      resolveResult({ status:reason ? 'interrupted' : code === 0 && total > 0 && passed === total ? 'passed' : total === 0 && code === 0 ? 'no_tests' : 'failed',
        tests:Number.isSafeInteger(total) ? total : 0, passed:Number.isSafeInteger(passed) ? passed : 0,
        reason: reason ?? (code !== 0 || signal ? 'process_failed' : null), output:text.slice(0,4096) });
    };
    for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 65536) output.push(chunk); else cancel('output_limit');
    });
    child.once('error', () => { reason ??= 'process_failed'; finish(1,null); });
    child.once('exit', () => killTree(child));
    child.once('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(suite));
  });
  return {result, cancel:() => cancel('cancelled')};
}

/** Fixed, reviewed suite IDs only. No HTTP-controlled command, argument or environment. */
export function createProjectValidation({root, planPath, emit = () => {}, now = Date.now}) {
  root = realpathSync(root);
  let suites = [], diagnostic = null;
  try { suites = readValidationPlan(root, planPath); }
  catch (error) {
    // A rejected test plan disables host testing, not project inspection.
    // Neither raw filesystem errors nor configuration values leave this boundary.
    diagnostic = { code: ['ToubaValidationPlanInvalid', 'ToubaValidationPathInvalid', 'ToubaValidationInputChanged',
      'ToubaValidationPythonInvalid', 'ToubaValidationEnvironmentInvalid'].includes(error.code)
      ? error.code : 'ToubaValidationPlanInvalid',
      ...(error.field ? { field: error.field } : {}), ...(error.suite_id ? { suite_id: error.suite_id } : {}) };
  }
  const previews = new Map();
  const store = validationStore(join(root,'.touba/project-validation.sqlite'));
  let active = null, task = null, closed = false;
  // Recovery never reruns a test whose host effects are uncertain.
  const recovered = store.read([{status:'running'}]);
  for (const row of recovered) { row.status='interrupted'; row.reason='server_restarted'; row.finished_at=new Date(now()).toISOString(); }
  if (recovered.length) store.write(recovered);
  const scope = actor => typeof actor === 'string' && actor.length > 0 && actor.length <= 256 ? actor : fail('ToubaValidationActorInvalid');
  function find(id) { return suites.find(suite => suite.id === id) ?? fail('ToubaValidationSuiteMissing'); }
  function receipt(id) { return store.read([{id}])[0] ?? fail('ToubaValidationRunMissing'); }
  return {
    handlerEvidence() {
      const coverage=new Map();
      for(const suite of suites.filter(item=>item.tool_refs?.length)) {
        let revision, manifest, manifestPath, latest;
        try {
          revision=readRevision(root,suite);const prepared=readPreparedProject(root);
          const manifestInput=prepared.inputs.find(input=>input.kind==='manifest');
          if(manifestInput) {
            manifestPath=projectFile(root,manifestInput.path);
            manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
          }
          latest=store.read([{suite_id:suite.id,revision}],{order:'rowid',direction:'desc',limit:1})[0];
        }catch{/* No current evidence when preparation, test inputs or interpreter drift. */}
        for(const ref of suite.tool_refs) {
          const handler=inspectHandlerImplementation(root,manifest?.bindings?.[ref]?.handler,{manifestPath});
          const proved=latest&&handler.implementation_status==='present'&&Object.hasOwn(suite.inputs,handler.candidate_path);
          const entries=coverage.get(ref)??[];
          entries.push({status:proved?latest.status:'missing',label:suite.label,id:proved?latest.id:null});coverage.set(ref,entries);
        }
      }
      const evidence=new Map();
      for(const [ref,entries] of coverage) evidence.set(ref,{
        status:entries.find(entry=>entry.status!=='passed')?.status??'passed',
        command:`Host tests: ${entries.map(entry=>entry.label).join(', ')}`,
        evidence_ref:entries.some(entry=>entry.id)?entries.filter(entry=>entry.id).map(entry=>`validation:${entry.id}`).join(', '):null});
      return evidence;
    },
    inspect() {
      return {schema_version:'touba-project-validation-v1', enabled:suites.length > 0, active_id:active?.id ?? null,
        ...(diagnostic ? { diagnostic } : {}),
        suites:suites.map(({id,label,kind,engine,timeout_ms}) => ({id,label,kind,engine,timeout_ms})),
        runs:store.read(undefined,{order:'rowid',direction:'desc',limit:50})};
    },
    preview(actor, id) {
      scope(actor); if (closed || active) fail('ToubaValidationBusy');
      if (diagnostic) fail(diagnostic.code, diagnostic.field, diagnostic.suite_id);
      for (const [key, item] of previews) if (item.expires <= now() || item.actor === actor) previews.delete(key);
      if (previews.size >= 8) fail('ToubaValidationCapacity');
      const suite=find(id), revision=readRevision(root,suite), token=randomUUID(), expires=now()+300000;
      previews.set(token,{actor,suite,revision,expires});
      return {schema_version:'touba-project-validation-preview-v1',id:token,suite_id:id,revision,expires_at:new Date(expires).toISOString(),
        label:suite.label,kind:suite.kind,engine:suite.engine,tests:suite.tests,env:suite.env ?? [],timeout_ms:suite.timeout_ms};
    },
    start(actor, body, authority = async () => true) {
      scope(actor);
      if (!ownObject(body) || Object.keys(body).sort().join(',') !== 'id,revision' || !uuid(body.id)) fail('ToubaValidationRequestInvalid');
      const rows=store.read([{id:body.id}]), previous=rows[0];
      if (previous) {
        if (previous.actor !== actor || previous.revision !== body.revision) fail('ToubaValidationReviewMissing');
        return previous;
      }
      if (closed || active) fail('ToubaValidationBusy');
      const review=previews.get(body.id);
      if (!review || review.actor !== actor || review.expires <= now()) fail('ToubaValidationReviewMissing');
      if (body.revision !== review.revision || readRevision(root,review.suite) !== review.revision) fail('ToubaValidationReviewStale');
      const row={id:body.id,suite_id:review.suite.id,revision:review.revision,actor,status:'running',
        started_at:new Date(now()).toISOString(),finished_at:null,tests:0,passed:0,reason:null,output:''};
      rows.push(row); store.write(rows); previews.delete(body.id); active={id:row.id,cancel:null};
      task=(async () => {
        try {
          if (closed || !await authority()) fail('ToubaValidationAuthorityChanged');
          if (closed) fail('ToubaValidationAuthorityChanged');
          if (readRevision(root,review.suite) !== review.revision) fail('ToubaValidationReviewStale');
          const process = validationProcess(root,review.suite); active.cancel=process.cancel;
          Object.assign(row,await process.result);
          try { if (readRevision(root,review.suite) !== row.revision) { row.status='stale'; row.reason='state_changed'; } }
          catch { row.status='stale'; row.reason='state_changed'; }
        } catch { row.status='interrupted'; row.reason='process_failed'; }
        finally {
          row.finished_at=new Date(now()).toISOString();
          try { store.write(rows); emit('validation.completed',{id:row.id,suite_id:row.suite_id,status:row.status,actor}); }
          finally { active=null; task=null; }
        }
      })();
      // Persistence failure is exposed by the still-running durable receipt and
      // repaired to interrupted at restart. Never emit a fabricated pass.
      task.catch(() => {});
      return row;
    },
    receipt,
    async stop() { closed=true; active?.cancel?.(); await task; },
  };
}
