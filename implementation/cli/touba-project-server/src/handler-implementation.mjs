import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isCanonicalHandlerStub } from '../../touba-manifest/src/stub-validation.mjs';

// Source presence and the canonical unimplemented template are separate from
// behavioral tests. Never run/import a handler just to classify it.
export function inspectHandlerImplementation(root, handler) {
  const unknown={implementation_status:'unknown',candidate_path:null};
  if(handler?.kind!=='process')return unknown;
  const candidates=[handler.command,...(Array.isArray(handler.args)?handler.args:[])]
    .filter(value=>typeof value==='string'&&!value.startsWith('-')&&/\.(?:mjs|cjs|js|py)$/.test(value));
  if(candidates.length!==1)return unknown;
  try {
    const base=realpathSync(root), file=realpathSync(resolve(root,candidates[0])), rel=relative(base,file);
    if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!statSync(file).isFile()||statSync(file).size>1024*1024)return unknown;
    const content=readFileSync(file,'utf8');
    return {implementation_status:isCanonicalHandlerStub(content,file.endsWith('.py')?'python':'javascript')?'stub':'present',candidate_path:rel.split(sep).join('/')};
  }catch{return unknown;}
}
