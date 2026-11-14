import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateImportFiles } from './import-files.mjs';
import { applyChangeTargetsTransaction } from './project-transactions.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Object.assign(new Error('Restore the reviewed source inputs first; recovery only restores a known generated projection'), { code: 'BindingFragmentRestoreUnavailable' }); };

// Recovery restores only the generated manifest whose canonical source still
// matches the last preparation. It never rolls back a lock, grant declaration,
// consumer approval policy, source file, operation or executed effect.
export function planPreparedRestoration({ root, manifestPath, manifest, effectivePath, effective, projectConfigWrite }) {
  try {
    if (projectConfigWrite !== undefined || !effective
      || !isDeepStrictEqual(JSON.parse(readFileSync(effectivePath)), effective)) fail();
    validateImportFiles(resolve(root), [{ path: manifestPath }], { mode: 'plan' });
    for (const input of effective.inputs) {
      const path = resolve(root, input.path);
      if (path === resolve(manifestPath) && input.kind === 'manifest') continue;
      validateImportFiles(resolve(root), [{ path }], { mode: 'plan' });
      if (`sha256:${hash(readFileSync(path))}` !== input.digest_sha256) fail();
    }
    const content = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(content) > 4 * 1024 * 1024
      || !effective.inputs.some(input => input.kind === 'manifest' && resolve(root, input.path) === resolve(manifestPath)
        && input.digest_sha256 === `sha256:${hash(content)}`)) fail();
    return { path: relative(root, manifestPath).replaceAll('\\', '/'), content, content_sha256: hash(content),
      base_content_exists: true, base_content_sha256: hash(readFileSync(manifestPath)) };
  } catch { fail(); }
}

export function applyPreparedRestoration({ root, target, restores, actor = 'local_operator' }) {
  return applyChangeTargetsTransaction({ projectRoot: root, proposalId: `restore-${randomUUID()}`,
    targets: [target], decidedAt: new Date().toISOString(), review_actor: actor,
    reason: [...new Set(Object.values(restores).map(entry => entry.reason.trim()))].join('\n') });
}
