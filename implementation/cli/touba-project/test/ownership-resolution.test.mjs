import assert from 'node:assert/strict';
import test from 'node:test';
import { ownershipMembership, resolveOwnershipInheritance } from '../src/ownership-resolution.mjs';

const docs = [{ module: { id: 'module:app.main' }, definitions: { tools: [{ id: 'tool:app.main/Pay' }, { id: 'tool:app.main/Read' }] } },
  { module: { id: 'module:app.other' }, definitions: { tools: [{ id: 'tool:app.other/Pay' }] } }];
const membership = ownershipMembership(docs, [{ name: 'org.payment', modules: ['app.main'] }]);
const knownTargets = new Set(['package:org.payment', ...docs.flatMap(doc => [doc.module.id, ...doc.definitions.tools.map(tool => tool.id)])]);
const resolve = (document, entries) => resolveOwnershipInheritance({ document, owners: new Map(entries), knownTargets, ...membership });

test('inheritance is explicit, exact, and never propagates a declared review', () => {
  const owners = [['module:app.main', ['team:finance']]];
  assert.equal(resolve({}, owners).length, 1);
  const document = { inherit_owners: ['module:app.main'], reviews: [{ target_ref: 'module:app.main', decision: 'approved' }] };
  const before = structuredClone(document), result = resolve(document, owners);
  assert.equal(result.length, 3); assert.deepEqual(document, before);
  assert.deepEqual(result.find(row => row.target_ref === 'tool:app.main/Pay'), {
    target_ref: 'tool:app.main/Pay', teams: ['team:finance'], origin_refs: ['module:app.main'], inherited: true,
  });
  assert.equal(result.some(row => row.target_ref === 'tool:app.other/Pay'), false);
  assert.equal(JSON.stringify(result).includes('approved'), false);
});

test('package and module conflicts require an explicit target exception', () => {
  const document = { inherit_owners: ['package:org.payment', 'module:app.main'] };
  const owners = [['package:org.payment', ['team:package']], ['module:app.main', ['team:module']]];
  assert.throws(() => resolve(document, owners), { code: 'OwnershipInheritanceConflict' });
  const result = resolve(document, [...owners, ['tool:app.main/Pay', ['team:review']], ['tool:app.main/Read', ['team:review']]]);
  assert.equal(result.find(row => row.target_ref === 'tool:app.main/Pay').inherited, false);
  assert.deepEqual(result.find(row => row.target_ref === 'tool:app.main/Pay').teams, ['team:review']);
});

test('matching inherited owners retain both origins without granting a new right', () => {
  const result = resolve({ inherit_owners: ['package:org.payment', 'module:app.main'] },
    [['package:org.payment', ['team:finance']], ['module:app.main', ['team:finance']]]);
  assert.deepEqual(result.find(row => row.target_ref === 'tool:app.main/Pay').origin_refs, ['module:app.main', 'package:org.payment']);
  assert.equal(Object.keys(result[0]).sort().join(), 'inherited,origin_refs,target_ref,teams');
});

test('unknown, duplicate, wildcard and unowned sources are refused', () => {
  for (const selected of [true, ['module:app.*'], ['module:app.main', 'module:app.main']]) {
    assert.throws(() => resolve({ inherit_owners: selected }, []), { code: 'OwnershipInheritanceInvalid' });
  }
  for (const ref of ['module:unknown', 'module:app.main', 'package:unknown']) {
    assert.throws(() => resolve({ inherit_owners: [ref] }, []), { code: 'OwnershipInheritanceSourceMissing' });
  }
});
