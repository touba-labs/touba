import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { newPackage, addPackage, updatePackage, checkPackage, reviewPackageUpdate } from '../src/packages.mjs';
import { readPackage, packageHandlerConfiguration } from '../src/package-contract.mjs';
import { initProject, prepareProject } from '../src/project.mjs';
import { applyHostDecisions } from '../src/host-decisions.mjs';

const ref = 'tool:example.config/Read';
const schema = { schema_version: 'touba-handler-configuration-v1', fields: { endpoint: { type: 'string', required: true } } };
const values = { endpoint: 'https://example.invalid/private-marker' };
const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const read = path => JSON.parse(readFileSync(path));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));

test('package configuration is explicit, reviewed, repeatable and never an environment grant', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-configuration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = newPackage('example.config', { root, version: '1.0.0' }).path;
  const app = join(root, 'consumer'); initProject({ root: app });
  const documentPath = join(source, 'touba.package.json');
  const document = read(documentPath);
  document.exports = { tools: [ref] };
  document.handlers = [{ tool: ref, path: 'handlers/read.mjs', configuration: 'handlers/configuration.json', protocol: 'touba-tool-handler-v1' }];
  write(documentPath, document);
  mkdirSync(join(source, 'handlers'));
  write(join(source, 'handlers/configuration.json'), schema);
  writeFileSync(join(source, 'src/example/config.tb'), 'module example.config\ntool Read\n    gives Text\n');
  writeFileSync(join(source, 'handlers/read.mjs'), `let raw='';for await(const chunk of process.stdin)raw+=chunk;
const r=JSON.parse(raw);if(r.configuration?.endpoint!=='https://example.invalid/private-marker'||process.env.endpoint)throw new Error('invalid configuration');
process.stdout.write(JSON.stringify({ok:true,value:'configured'}));`);
  await checkPackage(source);
  await addPackage(source, { root: app });
  const options = { root: app, entryRef: ref };
  const selected = { package_handler: 'example.config', effect_contract: { kind: 'none' } };
  const missing = await prepareProject({ ...options, mode: 'write', hostDecisions: { bindings: { [ref]: selected } } });
  assert.equal(missing.status, 'error');
  assert.ok(missing.diagnostics.some(d => d.code === 'HandlerConfigurationInvalid'));
  const decisions = { bindings: { [ref]: { configuration: values, ...selected } } }; // Order must not matter.
  const plan = await prepareProject({ ...options, mode: 'plan', hostDecisions: decisions });
  assert.notEqual(plan.status, 'error', JSON.stringify(plan.diagnostics));
  const different = structuredClone(decisions); different.bindings[ref].configuration.endpoint += '/changed';
  await assert.rejects(prepareProject({ ...options, mode: 'write', hostDecisions: different, expectedReviewDigest: plan.review_digest }), { code: 'ProjectPreparationReviewStale' });
  const prepared = await prepareProject({ ...options, mode: 'write', hostDecisions: decisions, expectedReviewDigest: plan.review_digest });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared.diagnostics));
  const manifestPath = join(app, '.touba/build/dev/touba.manifest.json');
  const binding = read(manifestPath).bindings[ref];
  assert.deepEqual(binding.configuration, { schema, values });
  assert.equal(binding.handler.configuration_schema, undefined);
  assert.deepEqual(binding.grants, []);
  for (const mode of ['plan', 'write', 'check']) {
    const result = await prepareProject({ ...options, mode });
    assert.equal(result.status, 'success', JSON.stringify(result.diagnostics));
  }
  const run = spawnSync(process.execPath, [cli, 'run', '--project', app, '--entry', ref, '--output', 'json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).result, 'configured');
  assert.ok(!run.stdout.includes('private-marker'));

  document.version = '1.0.1'; write(documentPath, document);
  write(join(source, 'handlers/configuration.json'), { ...schema, fields: { ...schema.fields, region: { type: 'string', required: true } } });
  const update = await reviewPackageUpdate(source, { root: app });
  assert.ok(update.contracts.some(item => item.tools?.[ref]?.configuration_schema?.fields.region));
  await updatePackage(source, { root: app, name: document.name, reviewDigest: update.review_digest });
  const refused = await prepareProject({ ...options, mode: 'write' });
  assert.equal(refused.status, 'error');
  assert.ok(refused.diagnostics.some(d => d.code === 'PackageGovernanceReviewRequired'));
  const digest = readPackage(source).digest;
  const reviewed = { review_packages: { [document.name]: digest } };
  const noValues = await prepareProject({ ...options, mode: 'write', hostDecisions: reviewed });
  assert.equal(noValues.status, 'error');
  assert.ok(noValues.diagnostics.some(d => d.code === 'PackageHandlerConfigurationReviewRequired'));
  const completed = await prepareProject({ ...options, mode: 'write', hostDecisions: { ...reviewed,
    bindings: { [ref]: { ...selected, configuration: { ...values, region: 'ca' } } } } });
  assert.equal(completed.status, 'success', JSON.stringify(completed.diagnostics));
  assert.equal((await prepareProject({ ...options, mode: 'check' })).status, 'success');
});

test('legacy descriptive configuration cannot become runtime values, nor can configuration cross handler targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-legacy-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'configuration.md'), 'Configure the application explicitly.');
  assert.equal(packageHandlerConfiguration(root, { configuration: 'configuration.md' }), undefined);
  const handler = { kind: 'process', command: process.execPath, args: ['handler.mjs'] };
  const manifest = { bindings: { [ref]: { handler, grants: [] }, 'tool:example.config/Other': { handler, grants: [] } } };
  const requirements = { bindings: { [ref]: {}, 'tool:example.config/Other': {} } };
  const proposals = new Map([[ref, new Map([['example.config', { ...handler, configuration_schema: schema }]])]]);
  const result = applyHostDecisions(manifest, { bindings: { [ref]: { configuration: values, package_handler: 'example.config' } } }, requirements, new Set(), proposals);
  assert.deepEqual(result.manifest.bindings[ref].configuration.values, values);
  assert.equal(result.manifest.bindings['tool:example.config/Other'].configuration, undefined);
  assert.equal(manifest.bindings[ref].configuration, undefined);
  assert.throws(() => applyHostDecisions(result.manifest, { bindings: { [ref]: {
    handler: { ...handler, args: ['another-handler.mjs'] },
  } } }, requirements), { code: 'HandlerConfigurationReviewRequired' });
  assert.throws(() => applyHostDecisions(manifest, { bindings: { [ref]: { configuration: values } } }, requirements), { code: 'HandlerConfigurationSchemaRequired' });
  assert.throws(() => applyHostDecisions(manifest, { bindings: { [ref]: { configuration: values } } }, requirements, new Set([ref]), proposals), { code: 'HostDecisionFragmentConflict' });
  writeFileSync(join(root, 'configuration.json'), JSON.stringify({ schema_version: 'touba-handler-configuration-v2', fields: {} }));
  assert.throws(() => packageHandlerConfiguration(root, { configuration: 'configuration.json' }), { code: 'HandlerConfigurationInvalid' });
});
