// Reproducible, offline decomposition. No timing threshold belongs in CI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { executeAirDocument } from '../runtime/touba-runtime/src/index.mjs';
import { createSqliteTraceStore } from '../runtime/touba-runtime/src/sqlite-trace-store.mjs';
import { baseAir } from '../contracts/conformance/corpus.mjs';

const python = process.env.TOUBA_PYTHON_BUILD_BIN ?? 'python3';
const root = fileURLToPath(new URL('../', import.meta.url));
const samples = 9;
const results = {};
const baseline = process.env.TOUBA_STARTUP_BASELINE;
if (baseline && !/^[a-f0-9]{40}$/u.test(baseline)) throw new Error('TOUBA_STARTUP_BASELINE must be a full commit hash');
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples_ms: values, median_ms: sorted[4], p90_ms: sorted[8], min_ms: sorted[0] };
}
const handler = `import asyncio,json
from touba_sdk import create_tool_handler,handle_tool_request
h=create_tool_handler(tool_ref='tool:probe/Echo',run=lambda request,context:request,
    input_signature=[{'name':'value','type_ref':'builtin:Text'}])
r=asyncio.run(handle_tool_request(json.dumps({'protocol':'touba-tool-handler-v1','operation':'invoke',
    'tool_ref':'tool:probe/Echo','arguments':{'value':'ok'}}),'tool:probe/Echo',h))
assert r == {'ok':True,'value':'ok'}
`;
for (const [name, code] of Object.entries({ python_empty:'pass', python_import:'import touba_sdk',
  python_handler:handler, python_engine_import:'from touba_sdk import ToubaEngine' })) {
  const values = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    execFileSync(python, ['-c', code], { env: { ...process.env, PYTHONPATH: join(root, 'runtime/touba-python-sdk/src') }, stdio: 'pipe' });
    values.push(performance.now() - start);
  }
  results[name] = summarize(values);
}
const cli = join(root, 'cli/touba-project/src/main.mjs');
const cliTimes = [];
for (let i = 0; i < samples; i++) {
  const start = performance.now();
  execFileSync(process.execPath, [cli, '--help'], { stdio:'pipe' });
  cliTimes.push(performance.now() - start);
}
results.cli_help_cold = summarize(cliTimes);
const temporary = mkdtempSync(join(tmpdir(), 'touba-startup-measure-'));
try {
  const airFile = join(temporary, 'program.air.json');
  writeFileSync(airFile, JSON.stringify(baseAir()));
  const coldRuns = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const output = execFileSync(process.execPath, [join(root, 'cli/touba-run/src/run.mjs'), airFile,
      '--entry', 'skill:conformance/Run', '--output', 'json', '--trace-store', join(temporary, 'cli-traces.sqlite')],
    { cwd: temporary, encoding: 'utf8', stdio: 'pipe' });
    assert.equal(JSON.parse(output).status, 'success');
    coldRuns.push(performance.now() - start);
  }
  results.cli_run_cold_sqlite = summarize(coldRuns);
  if (baseline) {
    const currentSource = join(root, 'runtime/touba-python-sdk/src');
    cpSync(join(currentSource, 'touba_sdk'), join(temporary, 'touba_sdk'), {
      recursive: true, filter: filename => !filename.includes('__pycache__'),
    });
    writeFileSync(join(temporary, 'touba_sdk/__init__.py'), execFileSync('git', [
      'show', `${baseline}:implementation/runtime/touba-python-sdk/src/touba_sdk/__init__.py`,
    ], { cwd: root }));
    // Alternate the two initializers on identical current submodules/interpreter.
    // This isolates eager vs lazy imports, not all changes since the baseline.
    for (const [name, code] of Object.entries({ import: 'import touba_sdk', handler })) {
      const pairs = { eager: [], lazy: [] };
      for (let i = 0; i < samples; i++) {
        for (const mode of i % 2 ? ['lazy', 'eager'] : ['eager', 'lazy']) {
          const start = performance.now();
          execFileSync(python, ['-c', code], { env: { ...process.env,
            PYTHONPATH: mode === 'eager' ? temporary : currentSource }, stdio: 'pipe' });
          pairs[mode].push(performance.now() - start);
        }
      }
      results[`paired_python_${name}`] = Object.fromEntries(Object.entries(pairs).map(([mode, values]) => [mode, summarize(values)]));
    }
  }
  for (const mode of ['memory', 'sqlite']) {
    const values = [], store = mode === 'sqlite' ? createSqliteTraceStore({ filename:join(temporary, 'trace.sqlite') }) : undefined;
    try {
      for (let i = -1; i < samples; i++) {
        const start = performance.now();
        const result = await executeAirDocument(baseAir(), { entryRef:'skill:conformance/Run', traceStorage:store });
        assert.equal(result.status, 'success'); assert.equal(result.result, 'conformant');
        if (i >= 0) values.push(performance.now() - start);
      }
      results[`pure_run_warm_${mode}`] = summarize(values);
    } finally { store?.close(); }
  }
} finally { rmSync(temporary, { recursive:true, force:true }); }
console.log(JSON.stringify({ platform:process.platform, arch:process.arch, node:process.version,
  python:execFileSync(python, ['--version'], {encoding:'utf8'}).trim(), samples, baseline_initializer:baseline ?? null,
  note:'Cold cases include process startup. Warm runs share the Node process; first run excluded. SQLite durability is unchanged. p90 is the maximum of nine observations. Not a native multi-platform qualification.',
  rss_bytes:process.memoryUsage().rss, results }, null, 2));
