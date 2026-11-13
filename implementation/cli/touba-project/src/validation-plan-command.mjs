import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateValidationPlan } from '../../touba-project-server/src/project-validation.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function localFile(root, relative, { absent = false } = {}) {
  if (typeof relative !== 'string' || relative.length > 2048 || isAbsolute(relative) || relative.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('ToubaValidationPathInvalid');
  let path = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat && absent && index === parts.length - 1) return path;
    if (!stat || stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('ToubaValidationPathInvalid');
  }
  return path;
}
function bytes(path, maximum) {
  if (!lstatSync(path).isFile() || lstatSync(path).size > maximum) fail('ToubaValidationPlanSizeLimit');
  const data = readFileSync(path);
  if (data.length > maximum) fail('ToubaValidationPlanSizeLimit');
  return data;
}
function pin(root, suite) {
  const paths = [...new Set([...(suite.tests ?? []), ...Object.keys(suite.inputs ?? {})])].sort();
  if (paths.length > 2048) fail('ToubaValidationPlanSizeLimit');
  let size = 0;
  const inputs = Object.fromEntries(paths.map(path => {
    const content = bytes(localFile(root, path), 64 * 1024 * 1024 - size);
    size += content.length;
    return [path, hash(content)];
  }));
  const python = suite.engine === 'python' ? (() => {
    if (!isAbsolute(suite.python?.command ?? '')) fail('ToubaValidationPythonInvalid');
    // Venv executables may be symbolic links. Pin the resolved interpreter.
    const command = realpathSync(suite.python.command);
    return { command: suite.python.command, digest: hash(bytes(command, 128 * 1024 * 1024)) };
  })() : undefined;
  return { ...suite, inputs, ...(python ? { python } : {}) };
}

/** Explicit operator review of host code; neither discovery nor execution. */
export function prepareValidationPlan({ root = process.cwd(), output = 'tests/validation.json', suite, refresh = false, apply = false, reviewDigest } = {}) {
  root = realpathSync(root);
  if (!output.endsWith('.json') || Boolean(suite) === Boolean(refresh)) fail('ToubaValidationPlanOptionsInvalid');
  const path = localFile(root, output, { absent: true });
  const previous = existsSync(path) ? bytes(path, 512 * 1024) : null;
  let before = { schema_version: 'touba-validation-plan-v1', suites: [] };
  if (previous) {
    try { before = JSON.parse(previous); } catch { fail('ToubaValidationPlanInvalid'); }
    if (!before || Object.keys(before).sort().join(',') !== 'schema_version,suites'
      || before.schema_version !== 'touba-validation-plan-v1' || !Array.isArray(before.suites)
      || before.suites.length > 32) fail('ToubaValidationPlanInvalid');
  }
  if (refresh && !previous) fail('ToubaValidationPlanMissing');
  const selected = refresh ? before.suites : [...before.suites.filter(item => item?.id !== suite.id), suite];
  const after = { ...before, suites: selected.map(item => refresh || item === suite ? pin(root, item) : item) };
  if (after.suites.some(item => Object.hasOwn(item.inputs ?? {}, output))) fail('ToubaValidationPlanOptionsInvalid');
  validateValidationPlan(root, after);
  const serialized = JSON.stringify(after, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 512 * 1024) fail('ToubaValidationPlanSizeLimit');
  const review = hash(JSON.stringify({ root, output, before: previous ? hash(previous) : null, after }));
  const report = { schema_version: 'touba-validation-plan-review-v1', status: 'preview', path: output,
    review_digest: review, before, after, execution: 'none' };
  if (!apply) return report;
  if (reviewDigest !== review) fail('ToubaValidationPlanReviewStale');
  const lock = path + '.review-lock';
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { fail('ToubaValidationPlanBusy'); }
  const temporary = join(dirname(path), `.touba-validation-${randomUUID()}.json`);
  try {
    // Recheck inputs and the destination after taking our writer lock.
    validateValidationPlan(root, after);
    localFile(root, output, { absent: true });
    const current = existsSync(path) ? bytes(path, 512 * 1024) : null;
    if ((current ? hash(current) : null) !== (previous ? hash(previous) : null)) fail('ToubaValidationPlanReviewStale');
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    const pending = openSync(temporary, 'r');
    try { fsyncSync(pending); } finally { closeSync(pending); }
    renameSync(temporary, path);
    return { ...report, status: 'written' };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(fd); unlinkSync(lock);
  }
}

export function validationPlanCommand(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])
    || args.length === 2 && args[0] === 'plan' && ['--help', '-h'].includes(args[1])) {
    return { exitCode: 0, text: `Usage: touba validation plan [options]

Prepare a reviewed validation plan. Test files are read and fingerprinted.
Preview first, then apply using the returned review_digest.

  --root PATH           Project directory (default: current directory)
  --out PATH            Plan path (default: tests/validation.json)
  --id NAME             Suite identifier
  --label TEXT          Suite label (default: identifier)
  --kind KIND           contract, business or package (default: contract)
  --engine ENGINE       node, python or package (default: node)
  --test PATH           Test file; repeat for multiple files
  --input PATH          Additional file to fingerprint; repeat as needed
  --python PATH         Absolute Python interpreter path, for engine python
  --timeout-ms NUMBER   Suite time limit (default: 30000)
  --env NAME            Allowed environment variable; repeat as needed
  --tool REF            Tool covered by this suite; repeat as needed
  --refresh             Review new fingerprints of an existing plan
  --apply               Write the reviewed plan
  --review-digest HASH  Digest returned by the matching preview
  --help, -h            Show this help

Example: touba validation plan --id contracts --test tests/contracts.test.mjs
` };
  }
  if (args[0] !== 'plan') fail('ToubaValidationPlanOptionsInvalid');
  const list = new Set(['--test', '--input', '--env', '--tool']), flags = new Set(['--apply', '--refresh']);
  const scalar = new Set(['--root', '--out', '--id', '--label', '--kind', '--engine', '--python', '--timeout-ms', '--review-digest']);
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key)) { if (options[key]) fail('ToubaValidationPlanOptionsInvalid'); options[key] = true; continue; }
    if (!list.has(key) && !scalar.has(key)) fail('ToubaValidationPlanOptionsInvalid');
    const value = args[++i];
    if (!value || value.startsWith('--') || scalar.has(key) && Object.hasOwn(options, key)) fail('ToubaValidationPlanOptionsInvalid');
    if (list.has(key)) (options[key] ??= []).push(value); else options[key] = value;
  }
  if (options['--refresh'] && Object.keys(options).some(key => !['--refresh', '--root', '--out', '--apply', '--review-digest'].includes(key))) fail('ToubaValidationPlanOptionsInvalid');
  const report = prepareValidationPlan({ root: options['--root'], output: options['--out'],
    refresh: options['--refresh'] === true, apply: options['--apply'] === true, reviewDigest: options['--review-digest'],
    suite: options['--refresh'] ? undefined : {
      id: options['--id'], label: options['--label'] ?? options['--id'], kind: options['--kind'] ?? 'contract',
      engine: options['--engine'] ?? 'node', tests: options['--test'] ?? [],
      inputs: Object.fromEntries((options['--input'] ?? []).map(path => [path, ''])),
      timeout_ms: options['--timeout-ms'] === undefined ? 30000 : Number(options['--timeout-ms']),
      env: options['--env'] ?? [], tool_refs: options['--tool'] ?? [],
      ...(options['--python'] ? { python: { command: options['--python'] } } : {}),
    } });
  return { text: JSON.stringify(report, null, 2), exitCode: 0 };
}
