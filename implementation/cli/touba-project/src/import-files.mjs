import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Check the complete plan before creating any file. Imported paths never follow
// project symlinks, including with an explicitly requested overwrite.
export function validateImportFiles(root, files, { mode, force = false } = {}) {
  const seen = new Set();
  for (const file of files) {
    const path = resolve(file.path), rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('generated files must stay inside the project');
    if (seen.has(path)) throw new Error('generated file names collide');
    seen.add(path);
    for (let current = path; current !== root; current = dirname(current)) {
      let stat;
      try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error('generated paths must not follow symbolic links');
      if (current !== path && !stat.isDirectory()) throw new Error('generated path parent is not a directory');
      if (current === path) {
        if (!stat.isFile()) throw new Error('generated destination is not a regular file');
        if (stat.size > 4 * 1024 * 1024) throw new Error('generated destination exceeds the review limit');
        if (mode === 'write' && !force && readFileSync(path, 'utf8') !== file.content) throw new Error(`refusing to overwrite generated file without --force: ${path}`);
      }
    }
  }
}

export function importedObjectSchemaError(schema, label) {
  const permitted = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$comment', 'examples', '$schema']);
  if (Object.keys(schema).some(key => !permitted.has(key))) return `${label} contains an unsupported object constraint or reference`;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return `${label} must declare a closed record, not arbitrary additional properties`;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length
    || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties ?? {}, key)))) return `${label}.required must name distinct declared properties`;
  return null;
}
