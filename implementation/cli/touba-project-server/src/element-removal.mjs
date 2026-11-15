import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { compileProposedSources } from './source-validation.mjs';

const fail = message => { throw Object.assign(new Error(message), {code:'ToubaServeElementRemovalInvalid'}); };
const json = value => JSON.stringify(value,null,2)+'\n';
function readLocal(root,path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => !part || ['..','.','.git','.touba','packages','node_modules'].includes(part))) fail('removal only reviews local project configuration');
  let parent=root;
  for (const part of path.split('/')) {
    parent=join(parent,part);
    if (lstatSync(parent).isSymbolicLink()) fail('removal does not follow configuration links');
  }
  const stat=lstatSync(parent);
  if (!stat.isFile() || stat.size>1024*1024) fail('configuration must be a regular file no larger than 1 MiB');
  return JSON.parse(readFileSync(parent,'utf8'));
}

// A removal is a proposed multi-file change, never an immediate deletion.
// Compiler byte spans select the declaration; whole-project compilation then
// rejects remaining callers. Handlers, records and generated state stay intact.
export function elementRemovalChanges({projectRoot,current}) {
  const compiled=compileProposedSources({projectRoot,targets:[{path:current.path,content:current.content}]});
  const definition=compiled.air?.definitions?.[current.kind==='tool'?'tools':'triggers']?.find(item=>item.id===current.element_ref);
  const span=definition?.source_ref, bytes=Buffer.from(current.content);
  if (compiled.diagnostics.some(item=>item.severity==='error') || !span
    || !Number.isSafeInteger(span.start_byte) || !Number.isSafeInteger(span.end_byte)
    || span.start_byte<0 || span.end_byte<=span.start_byte || span.end_byte>bytes.length
    || !bytes.subarray(span.start_byte,span.end_byte).toString('utf8').startsWith(`${current.kind} ${current.name}`))
    fail('compile a valid local declaration before reviewing its removal');
  const content=Buffer.concat([bytes.subarray(0,span.start_byte),bytes.subarray(span.end_byte)]).toString('utf8');
  const changes=[{path:current.path,content,role:'source'}];
  const path='touba.project.json';
  if (!existsSync(join(projectRoot,path))) return changes;
  const config=readLocal(projectRoot,path), before=json(config), ref=current.element_ref;
  if (Array.isArray(config.entrypoints)) config.entrypoints=config.entrypoints.filter(item=>item!==ref);
  if (config.entry===ref) {
    const next=config.entrypoints?.[0];
    if (!next) fail('select another project entrypoint before removing its last entrypoint');
    // Selecting a replacement is itself visible in the reviewed project diff.
    config.entry=next;
  }
  for (const fragmentPath of config.configuration?.binding_fragments ?? []) {
    const fragment=readLocal(projectRoot,fragmentPath);
    if (Object.hasOwn(fragment.bindings ?? {},ref)) {
      delete fragment.bindings[ref];
      changes.push({path:fragmentPath,content:json(fragment),role:'manifest'});
    }
  }
  if (json(config)!==before) changes.push({path,content:json(config),role:'manifest'});
  return changes;
}
