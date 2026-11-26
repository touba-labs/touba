// Source templates for an explicitly configured project server. The application
// reviews the directory; Cloud project roles never become business roles.
const javascript = `import { open } from 'node:fs/promises';
async function attest(request, subject) {
  if (typeof subject !== 'string' || !subject.startsWith('user:')) throw new Error('Authenticated signer required');
  const file = await open(new URL('../config/studio-directory.json', import.meta.url), 'r');
  const buffer = Buffer.alloc(262145);
  let size = 0;
  try {
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } finally { await file.close(); }
  if (size > 262144) throw new Error('Approval directory too large');
  const directory = JSON.parse(buffer.subarray(0, size));
  const person = directory.schema_version === 'touba-approval-directory-v1' && Object.hasOwn(directory.users ?? {}, subject) ? directory.users[subject] : null;
  if (!person || person.enabled !== true || !Array.isArray(person.roles) || person.roles.length > 128
      || !person.roles.every(role => typeof role === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(role))) throw new Error('Signer unavailable');
  if (request.policy?.exclude_signers) throw new Error('Configure the application exclusion resolver before using this policy');
  return { request_id: request.request_id, run_id: request.run_id, subject_ref: subject, roles: [...person.roles] };
}
export async function attestHumanApproval({ request, decision, hostDecision }) {
  const expected = decision === 'approved' ? 'approve' : decision === 'rejected' ? 'reject' : null;
  if (!expected || !hostDecision || hostDecision.request_id !== request.request_id || hostDecision.run_id !== request.run_id
      || hostDecision.decision !== expected || hostDecision.decided_by !== hostDecision.user_ref) throw new Error('Server decision required');
  return { ...await attest(request, hostDecision.user_ref), decision };
}
export async function attestHumanApprovalReview({ purpose, request, viewer }) {
  if (purpose !== 'review' || !viewer?.session_id) throw new Error('Authenticated review required');
  return { ...await attest(request, viewer.subject_ref), purpose };
}
`;
const python = `import json
import re
from pathlib import Path

def _attest(request, subject):
    if not isinstance(subject, str) or not subject.startswith('user:'):
        raise ValueError('Authenticated signer required')
    with (Path(__file__).parent / '../config/studio-directory.json').open('rb') as stream:
        raw = stream.read(262145)
    if len(raw) > 262144:
        raise ValueError('Approval directory too large')
    directory = json.loads(raw)
    person = directory.get('users', {}).get(subject) if directory.get('schema_version') == 'touba-approval-directory-v1' else None
    if not isinstance(person, dict) or person.get('enabled') is not True:
        raise ValueError('Signer unavailable')
    roles = person.get('roles')
    if not isinstance(roles, list) or len(roles) > 128 or not all(isinstance(role, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.:-]{0,127}', role) for role in roles):
        raise ValueError('Invalid business roles')
    if request.get('policy', {}).get('exclude_signers'):
        raise ValueError('Configure the application exclusion resolver before using this policy')
    return dict(request_id=request['request_id'], run_id=request['run_id'], subject_ref=subject, roles=roles)

def attest_human_approval(payload):
    request, decision = payload['request'], payload['decision']
    record = payload.get('hostDecision', {})
    expected = {'approved': 'approve', 'rejected': 'reject'}.get(decision)
    if not expected or record.get('request_id') != request['request_id'] or record.get('run_id') != request['run_id'] or record.get('decision') != expected or record.get('decided_by') != record.get('user_ref'):
        raise ValueError('Server decision required')
    return dict(_attest(request, record.get('user_ref')), decision=decision)

def attest_human_approval_review(payload):
    viewer = payload.get('viewer', {})
    if payload.get('purpose') != 'review' or not viewer.get('session_id'):
        raise ValueError('Authenticated review required')
    return dict(_attest(payload['request'], viewer.get('subject_ref')), purpose='review')
`;

export function approvalHostTemplate(language, identity) {
  if (!['javascript', 'python'].includes(language) || identity?.schema_version !== 'touba-product-identity-v1'
      || !Array.isArray(identity.users) || identity.users.length > 1000) throw new Error('ToubaApprovalTemplateInvalid');
  const users = Object.create(null);
  for (const user of identity.users) {
    if (typeof user.user_ref !== 'string' || !/^user:[A-Za-z0-9_.:-]{1,256}$/.test(user.user_ref)) throw new Error('ToubaApprovalTemplateInvalid');
    users[user.user_ref] = { enabled: false, roles: [] };
  }
  return {
    host: { path: language === 'python' ? 'host/studio-approval.py' : 'host/studio-approval.mjs', content: language === 'python' ? python : javascript },
    directory: { path: 'config/studio-directory.json', content: JSON.stringify({ schema_version: 'touba-approval-directory-v1', users }, null, 2) + '\n' },
  };
}
