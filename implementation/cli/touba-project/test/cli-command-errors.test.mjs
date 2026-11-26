import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const command=fileURLToPath(new URL('../src/main.mjs',import.meta.url));
test('version aliases preserve the documented version result',()=>{
  const expected=spawnSync(process.execPath,[command,'version'],{encoding:'utf8'});
  assert.equal(expected.status,0,expected.stderr);
  for(const alias of ['--version','-v']){
    const actual=spawnSync(process.execPath,[command,alias],{encoding:'utf8'});
    assert.equal(actual.status,0,actual.stderr);
    assert.equal(actual.stdout,expected.stdout);
  }
});
test('an unknown command reports a usage failure on stderr without echoing its argument',()=>{
  const actual=spawnSync(process.execPath,[command,'unknown-command-marker'],{encoding:'utf8'});
  assert.equal(actual.status,2);
  assert.equal(actual.stdout,'');
  assert.match(actual.stderr,/Unknown command/);
  assert.doesNotMatch(actual.stderr,/unknown-command-marker/);
});
