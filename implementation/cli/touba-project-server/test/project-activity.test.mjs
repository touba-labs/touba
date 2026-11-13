import test from 'node:test';
import assert from 'node:assert/strict';
import { authoringReadiness, createProjectActivityGate, projectActivityKind } from '../src/project-activity.mjs';

test('project mutations exclude executions and reviewed active state', () => {
  let blocked = [];
  const gate = createProjectActivityGate(() => blocked);
  const release = gate.enter('execution');
  assert.throws(() => gate.enter('mutation'), { code: 'ToubaServeProjectOperationsActive' });
  release(); release();
  blocked = ['strategy:qa/Pay'];
  assert.throws(() => gate.assertMutationAllowed(), /strategy:qa\/Pay/);
  assert.equal(gate.mutating,false,'preview check never takes the mutation lock');
  assert.throws(() => gate.enter('mutation'), /strategy:qa\/Pay/);
  blocked = [];
  const finish = gate.enter('mutation');
  assert.equal(gate.mutating, true);
  assert.throws(() => gate.enter('execution'), { code: 'ToubaServeProjectMutationBusy' });
  assert.throws(() => gate.enter('mutation'), { code: 'ToubaServeProjectMutationBusy' });
  finish(); assert.equal(gate.mutating, false);
  gate.enter('execution')();
  assert.equal(projectActivityKind('POST', '/interactions/sessions/abc/messages'), 'execution');
  assert.equal(projectActivityKind('POST', '/project/prepare/apply'), 'mutation');
  assert.equal(projectActivityKind('POST', '/project/prepare/preview'), null);
});

test('source preview identifies pending operations and missing host prerequisites without side effects', () => {
  let invoked = 0;
  const gate = createProjectActivityGate(() => ['pending-approval']);
  const policy = { role: 'controller', distinct_from: 'initiator' };
  assert.deepEqual(authoringReadiness({ gate, policy }).map(item => item.code), [
    'ToubaServeProjectOperationsActive', 'ToubaServeApprovalHostRequired', 'HumanApprovalInitiatorRequired',
  ]);
  const host = { humanApprovalAuthority: () => { invoked++; }, humanApprovalInitiator: () => { invoked++; } };
  assert.deepEqual(authoringReadiness({ gate, policy, host }).map(item => item.code), ['ToubaServeProjectOperationsActive']);
  assert.equal(invoked, 0, 'preview never invokes a host module');
  assert.equal(gate.mutating, false);
  assert.deepEqual(authoringReadiness({ gate: createProjectActivityGate(() => []), policy: null }), []);
});
