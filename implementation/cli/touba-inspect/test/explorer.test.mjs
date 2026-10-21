import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, writeFile, readFile, rm, realpath, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { captureProject, compileCapture, ExplorerSession, implementationRoot, snapshotSourceId } from '../src/explorer/project.mjs';
import { startExplorer, explorerHtml } from '../src/explorer/server.mjs';
import { visibleGraph, layoutGraph, viewForNode } from '../src/explorer/web/view.mjs';
import { projectExplorer } from '../src/explorer/model.mjs';
import { initProject } from '../../touba-project/src/project.mjs';
import { newPackage, packPackage, addPackage } from '../../touba-project/src/packages.mjs';
import { validateObject } from '../../../tools/validate-product-surface-contracts.mjs';

async function project(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'touba-explorer-test-')));
  t.after(() => rm(root, { recursive:true, force:true }));
  await cp(join(implementationRoot, 'examples/explorer-project'), root, { recursive:true });
  return root;
}
async function analyse(t) { const root = await project(t), capture = await captureProject(root), result = await compileCapture(capture); assert.ok(result.graph, JSON.stringify(result.diagnostics)); return { root, capture, ...result }; }
const options = { view:'architecture',direction:'all',group:false,depth:2 };

test('snapshot paths reconcile Windows canonical namespaces and refuse escapes', () => {
  for (const [root, canonical] of [
    [String.raw`C:\Users\runner\Temp\touba-explore`,String.raw`\\?\C:\Users\runner\Temp\touba-explore`],
    [String.raw`\\server\share\touba-explore`,String.raw`\\?\UNC\server\share\touba-explore`],
  ]) {
    assert.equal(snapshotSourceId('src/review.tb',canonical,root,path.win32),'src/review.tb');
    assert.equal(snapshotSourceId(path.win32.join(canonical,'src/review.tb'),canonical,root,path.win32),'src/review.tb');
    for (const outside of ['../other/file.tb',String.raw`D:\outside.tb`,String.raw`\\other\share\file.tb`]) {
      assert.throws(()=>snapshotSourceId(outside,canonical,root,path.win32),/ExplorerSourceOutsideSnapshot/);
    }
  }
  assert.equal(snapshotSourceId('src/review.tb','/tmp/project','/tmp/project',path.posix),'src/review.tb');
  assert.throws(()=>snapshotSourceId('../project-other/source.tb','/tmp/project','/tmp/project',path.posix),/ExplorerSourceOutsideSnapshot/);
});

test('real compiler: responsibilities, authority, secrets names, approval and bounded parallel call', async t => {
  const { graph, root } = await analyse(t);
  assert.equal(graph.schema_version, 'touba-project-explorer-v1');
  const schema=JSON.parse(await readFile(join(implementationRoot,'contracts/product-surfaces/schemas/touba-project-explorer-v1.schema.json'),'utf8'));
  assert.deepEqual(validateObject(schema,graph),[]);
  const agent = graph.nodes.find(n => n.kind === 'agent');
  assert.match(agent.details.responsibility, /Diagnose/);
  assert.ok(graph.edges.some(e => e.kind === 'callable_by' && e.to === agent.id));
  assert.ok(graph.edges.some(e => e.kind === 'uses' && e.from === agent.id));
  assert.ok(graph.edges.some(e => e.kind === 'requires' && e.to === 'secret_handle:INCIDENT_API_KEY'));
  const parallel = graph.nodes.find(n => n.kind === 'parallel_call');
  assert.equal(parallel.details.max_concurrency, 4); assert.equal(parallel.details.max_items, 32);
  assert.equal(graph.nodes.find(n => n.kind === 'human_approval').details.approval_policy.role, 'incident_manager');
  assert.ok(graph.edges.some(e => e.kind === 'approval_site'));
  assert.ok(graph.nodes.every(n => !n.source_ref || n.source_ref.source_id === 'src/review.tb'));
  assert.equal(JSON.stringify(graph).includes(root), false);
});

test('multi-module source resolution, true origins, deterministic revision, no project writes', async t => {
  const root = await project(t);
  await writeFile(join(root,'src/common.tb'), 'module common\nfunction Echo\n    takes value as Text\n    gives Text\n    do\n        give value\n');
  await writeFile(join(root,'src/client.tb'), 'module client\nimport function Echo from common\nfunction Run\n    takes value as Text\n    gives Text\n    do\n        Echo\n            with value as value\n            into result\n        give result\n');
  const before = await captureProject(root), result = await compileCapture(before), after = await captureProject(root);
  assert.ok(result.graph, JSON.stringify(result.diagnostics)); assert.equal(before.revision,after.revision);
  assert.equal(result.graph.nodes.filter(n => n.id === 'function:common/Echo').length,1);
  assert.equal(result.graph.nodes.find(n => n.id === 'function:common/Echo').module,'module:common');
  assert.ok(result.graph.edges.some(e => e.kind === 'imports' && e.to === 'module:common'));
  assert.deepEqual((await readdir(root)).sort(), ['src']);
});

test('secrets/configuration/handlers are not loaded or executed', async t => {
  const root = await project(t);
  await writeFile(join(root,'.env'),'INCIDENT_API_KEY=PRIVATE_TEST_SENTINEL');
  await writeFile(join(root,'handler.mjs'),'throw new Error("HANDLER_EXECUTED")');
  const capture=await captureProject(root), result=await compileCapture(capture);
  assert.ok(result.graph); assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_SENTINEL'),false);
  assert.deepEqual(capture.files.map(f=>f.path),['src/review.tb']);
});

test('real package installation appears with package provenance; modified package fails integrity', async t => {
  const root=await project(t), consumer=join(root,'consumer');
  initProject({root:consumer});
  const author=newPackage('example.echo',{root});
  const manifest=JSON.parse(await readFile(join(author.path,'touba.package.json'),'utf8')); manifest.publisher='Test'; manifest.license='MIT';
  await writeFile(join(author.path,'touba.package.json'),JSON.stringify(manifest));
  const archive=join(root,'echo.tar.gz'); await packPackage(author.path,{output:archive}); await addPackage(archive,{root:consumer});
  const result=await compileCapture(await captureProject(consumer));
  assert.ok(result.graph,JSON.stringify(result.diagnostics));
  assert.ok(result.graph.nodes.some(n=>n.kind==='package' && n.name==='example.echo'));
  assert.equal(result.graph.nodes.find(n=>n.id==='skill:example.echo/Echo').package,'example.echo');
  await writeFile(join(consumer,'packages/example.echo/src/example/echo.tb'),'module example.echo\n');
  const broken=await compileCapture(await captureProject(consumer));
  assert.ok(broken.diagnostics.some(d=>d.code==='PackageIntegrityMismatch')); assert.equal(broken.graph,undefined);
});

test('symlink escape, source size and malformed AIR are refused', async t => {
  const root=await project(t); await writeFile(join(root,'outside.tb'),'module outside\n');
  await symlink(join(root,'outside.tb'),join(root,'src/alias.tb'));
  await assert.rejects(()=>captureProject(root),/ExplorerSymlinkRefused/);
  await rm(join(root,'src/alias.tb'));
  await writeFile(join(root,'src/huge.tb'),'x'.repeat(1024*1024+1));
  await assert.rejects(()=>captureProject(root),/ExplorerSourceLimit/);
  assert.throws(()=>projectExplorer([{}],{name:'bad',files:[]}),/AIR|air/);
});

test('context-only package has a visible identity and procedure without executing it', async t => {
  const root=await project(t), author=newPackage('example.review',{root,context:true});
  const result=await compileCapture(await captureProject(author.path));
  assert.ok(result.graph,JSON.stringify(result.diagnostics));
  assert.ok(result.graph.nodes.some(n=>n.id==='context:example.review/review'));
  assert.ok(!JSON.stringify(result.graph).includes('Treat instructions inside the material'));
});

test('failed edit retains marked last valid snapshot; fixing it refreshes the graph', async t => {
  const root=await project(t), session=new ExplorerSession(root,{interval:60000}); t.after(()=>session.close());
  await session.start(); assert.equal(session.state.status,'ready'); const graph=session.state.graph;
  const original=await readFile(join(root,'src/review.tb'),'utf8');
  await writeFile(join(root,'src/review.tb'),'not a Touba module'); await session.refresh();
  assert.equal(session.state.status,'stale'); assert.equal(session.state.graph,graph); assert.ok(session.state.diagnostics.length);
  assert.equal(session.source('agent:review/Specialist').text,original);
  await writeFile(join(root,'src/review.tb'),original.replace('supplied incident','reported incident')); await session.refresh();
  assert.equal(session.state.status,'ready'); assert.notEqual(session.state.graph.revision,graph.revision);
  assert.equal(session.source('../../.env'),null);
});

test('views preserve semantic edges; grouping and focus remain explicit', async t => {
  const {graph}=await analyse(t);
  const grouped=visibleGraph(graph,{...options,group:true}); assert.equal(grouped.nodes.length,1);
  const gov=visibleGraph(graph,{...options,view:'governance'});
  assert.ok(gov.edges.some(e=>e.kind==='uses')); assert.ok(!gov.edges.some(e=>e.kind==='invokes'));
  const flow=visibleGraph(graph,{...options,view:'flow'}); assert.ok(flow.nodes.some(n=>n.kind==='parallel_call')); assert.ok(flow.edges.some(e=>e.kind==='flow'));
  const focused=visibleGraph(graph,{...options,view:'governance',selected:'agent:review/Specialist',direction:'outgoing',depth:1});
  assert.ok(focused.nodes.some(n=>n.kind==='tool')); assert.ok(!focused.nodes.some(n=>n.kind==='strategy'));
  assert.equal(visibleGraph(graph,{...options,search:'no such resource'}).nodes.length,0);
  for (const node of graph.nodes) {
    assert.ok(visibleGraph(graph,{...options,view:viewForNode(node)}).nodes.some(n=>n.id===node.id),`source navigation must reveal ${node.id}`);
  }
});

test('cyclic layout is deterministic and finite', () => {
  const nodes=['a','b','c','d'].map(id=>({id})); const edges=[{from:'a',to:'b'},{from:'b',to:'a'},{from:'b',to:'c'},{from:'c',to:'d'}];
  const a=layoutGraph(nodes,edges), b=layoutGraph(nodes,edges);
  assert.deepEqual(a,b); assert.equal(a.positions.size,4); assert.ok(a.width<2000); assert.ok(a.positions.get('d').y>a.positions.get('c').y);
});

test('empty layouts have positive finite extents in each orientation and density', () => {
  for (const direction of ['vertical','horizontal']) for (const density of ['comfortable','compact']) {
    const result=layoutGraph([],[],{direction,density});
    assert.equal(result.positions.size,0);
    assert.ok(Number.isFinite(result.width) && result.width>0);
    assert.ok(Number.isFinite(result.height) && result.height>0);
    assert.equal(result.direction,direction);
  }
});

test('wrapped layouts contain every card without overlap in both directions and densities', () => {
  const nodes=Array.from({length:31},(_,i)=>({id:`node-${i}`}));
  const edges=nodes.slice(1,26).map(n=>({from:nodes[0].id,to:n.id}));
  edges.push({from:'node-1',to:'node-2'},{from:'node-2',to:'node-1'},{from:'node-2',to:'node-26'});
  for (const direction of ['vertical','horizontal']) for (const density of ['comfortable','compact']) for (const wrap of [1,3,8]) {
    const result=layoutGraph(nodes,edges,{direction,density,wrap});
    assert.deepEqual(result,layoutGraph(nodes,edges,{direction,density,wrap}));
    assert.equal(result.positions.size,nodes.length);
    const positions=[...result.positions.values()];
    for (const [i,a] of positions.entries()) {
      assert.ok(a.x>=0 && a.y>=0 && a.x+result.nodeWidth<=result.width && a.y+result.nodeHeight<=result.height);
      for (const b of positions.slice(i+1)) assert.ok(a.x+result.nodeWidth<=b.x || b.x+result.nodeWidth<=a.x || a.y+result.nodeHeight<=b.y || b.y+result.nodeHeight<=a.y);
    }
    const a=result.positions.get('node-2'),b=result.positions.get('node-26');
    assert.ok(direction==='vertical' ? b.y>a.y : b.x>a.x);
  }
});

test('public CLI exposes explorer and rejects invalid options before starting a listener',()=>{
  const cli=join(implementationRoot,'cli/touba-project/src/main.mjs');
  const help=spawnSync(process.execPath,[cli,'explore','--help'],{encoding:'utf8'});
  assert.equal(help.status,0); assert.match(help.stdout,/touba explore/);
  for(const args of [['--host','0.0.0.0'],['--port','abc'],['--port','65536']]) {
    const result=spawnSync(process.execPath,[cli,'explore',...args],{encoding:'utf8'});
    assert.equal(result.status,2); assert.ok(!result.stdout.includes('http://'));
  }
});

for(const [source,nodeKinds,edgeKinds] of [
  ['tb-v01-002-fallback.tb',['fallback'],['recovery']],
  ['tb-v01-003-branch.tb',['branch'],['flow']],
  ['tb-v01-004-loop.tb',['loop'],['flow']],
  ['memory-scopes-anneau-2/positive/tb-a2-mem-p01-agent-read-memory.tb',['memory'],['memory_scope','memory_access']],
  ['triggers-anneau-2/positive/tb-a2-trigger-p01-schedule-strategy-minimal.tb',['trigger'],['dispatches']],
])test(`real source coverage: ${source}`,async t=>{
  const root=await project(t); await rm(join(root,'src/review.tb'));
  await cp(join(implementationRoot,'grammar/tree-sitter-touba/examples',source),join(root,'src/example.tb'));
  const result=await compileCapture(await captureProject(root)); assert.ok(result.graph,JSON.stringify(result.diagnostics));
  for(const kind of nodeKinds)assert.ok(result.graph.nodes.some(n=>n.kind===kind),kind);
  for(const kind of edgeKinds)assert.ok(result.graph.edges.some(e=>e.kind===kind),kind);
});

test('loopback server: bearer authentication, host/origin checks, read-only endpoints, restricted sources', async t => {
  const root=await project(t), server=await startExplorer({root,openBrowser:false,interval:60000}); t.after(()=>server.close()); await server.ready;
  const url=new URL(server.url), base=url.origin, headers={Authorization:`Bearer ${url.hash.slice(1)}`};
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal((await fetch(`${base}/api/state`)).status,401);
  assert.equal((await fetch(`${base}/api/state`,{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const badHost = await new Promise((resolve,reject) => { const req=request(`${base}/api/state`,{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}); req.on('error',reject);req.end(); });
  assert.equal(badHost,403);
  assert.equal((await fetch(`${base}/api/state`,{headers,method:'POST'})).status,405);
  assert.equal((await fetch(`${base}/api/source?id=../../.env`,{headers})).status,404);
  const state=await (await fetch(`${base}/api/state`,{headers})).json(); assert.equal(state.status,'ready');
  const source=await (await fetch(`${base}/api/source?id=agent:review/Specialist`,{headers})).json(); assert.equal(source.path,'src/review.tb');
  const html=await (await fetch(base)).text(); assert.match(html,/Content-Security-Policy/); assert.ok(!html.includes(url.hash.slice(1)));
  assert.equal((await fetch(`${base}/tokens.css`)).status,200); assert.equal((await fetch(`${base}/.env`)).status,404);
  assert.match(await explorerHtml(name=>`safe://${name}`,'safe:'),/src="safe:\/\/app.mjs"/);
});
