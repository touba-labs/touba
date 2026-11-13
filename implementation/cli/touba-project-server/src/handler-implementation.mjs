import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isCanonicalHandlerStub } from '../../touba-manifest/src/stub-validation.mjs';

// Source presence and the canonical unimplemented template are separate from
// behavioral tests. Never run/import a handler just to classify it.
export function inspectHandlerImplementation(root, handler, { manifestPath = resolve(root, 'touba.manifest.json') } = {}) {
  const unknown={implementation_status:'unknown',candidate_path:null};
  if(handler?.kind!=='process')return unknown;
  // Prepared manifests rebase cwd relative to their own directory, just as
  // runtime loading does. Project containment is checked separately below.
  const cwd = resolve(dirname(manifestPath), handler.cwd ?? '.');
  const candidates=[handler.command,...(Array.isArray(handler.args)?handler.args:[])]
    .filter(value=>typeof value==='string'&&!value.startsWith('-')&&/\.(?:mjs|cjs|js|py)$/.test(value));
  const args = Array.isArray(handler.args) ? handler.args : [];
  const moduleIndex = args.indexOf('-m');
  if (candidates.length === 0 && /^python(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?$/u.test(basename(handler.command ?? ''))
    && moduleIndex >= 0 && args.slice(0, moduleIndex).every(arg => ['-I', '-B', '-E', '-s', '-u'].includes(arg))
    && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(args[moduleIndex + 1] ?? '')) {
    const modulePath = args[moduleIndex + 1].replaceAll('.', '/');
    // Resolve only project-local source. No interpreter, import hook or package
    // code is executed by this read-only classification.
    for (const path of [modulePath + '.py', modulePath + '/__main__.py']) {
      try { if (statSync(resolve(cwd, path)).isFile()) { candidates.push(path); break; } }
      catch { /* An absent module remains unknown. */ }
    }
  }
  if(candidates.length!==1)return unknown;
  try {
    const base=realpathSync(root), file=realpathSync(resolve(cwd,candidates[0])), rel=relative(base,file);
    if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!statSync(file).isFile()||statSync(file).size>1024*1024)return unknown;
    const content=readFileSync(file,'utf8');
    return {implementation_status:isCanonicalHandlerStub(content,file.endsWith('.py')?'python':'javascript')?'stub':'present',candidate_path:rel.split(sep).join('/')};
  }catch{return unknown;}
}
