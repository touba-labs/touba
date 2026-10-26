import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {packageTutorial} from './package-tutorial.mjs';
import {runDocumentRecipe} from './tutorial-recipe.mjs';

test('archive preserves literal Python and JavaScript steps and executes in an isolated folder', t => {
  const root=mkdtempSync(join(tmpdir(),'touba-archive-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source='```sh title="Terminal"\nmkdir demo\ncd demo\n```\n'
    +'```python title="value.py"\nvalue = 42\n```\n'
    +'```js title="exercise.mjs"\nimport {readFileSync} from "node:fs";\nimport assert from "node:assert/strict";\nassert.equal(readFileSync("value.py","utf8"),"value = 42\\n");\n```\n'
    +'```sh title="Terminal"\nnode exercise.mjs\n```\n';
  const doc=join(root,'tutorial.md'), archive=join(root,'recipe.tar.gz');
  writeFileSync(doc,source);
  assert.equal(packageTutorial({document:doc,output:archive,locale:'fr',slug:'test',version:'1.0.0'}).files,2);
  execFileSync('tar',['-xzf',archive,'-C',root]);
  const extracted=join(root,'touba-tutorial-test');
  assert.equal(readFileSync(join(extracted,'tutorial.md'),'utf8'),source);
  const metadata=JSON.parse(readFileSync(join(extracted,'provenance.json')));
  assert.equal(metadata.files.length,2);
  // Reject modified executable sources before attempting any Touba command.
  for (const file of ['tutorial.md', 'recipe.mjs', metadata.files[0].path]) {
    const target = join(extracted, file);
    const original = readFileSync(target);
    writeFileSync(target, 'modified');
    assert.throws(() => execFileSync(process.execPath, [join(extracted, 'validate.mjs')],
      {encoding: 'utf8', stdio: 'pipe'}), /AssertionError/);
    writeFileSync(target, original);
  }
  const workspace=join(root,'workspace'); mkdirSync(workspace);
  assert.deepEqual({...runDocumentRecipe(join(extracted,'tutorial.md'),workspace,process.env),outputs:[]},
    {cwd:join(workspace,'demo'),files:2,commands:2,outputs:[]});
  writeFileSync(doc,source.replace('value.py','../../value.py'));
  assert.throws(()=>packageTutorial({document:doc,output:archive,locale:'fr',slug:'test',version:'1.0.0'}),/Unsafe/);
});
