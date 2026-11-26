import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeThirdPartyNotices} from './third-party-notices.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'touba-notices-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const node=join(root,'node'),crate=join(root,'crate'),out=join(root,'output');
  mkdirSync(join(node,'bin'),{recursive:true});mkdirSync(crate);mkdirSync(out);
  writeFileSync(join(node,'bin/node'),'fixture executable');
  writeFileSync(join(node,'LICENSE'),'Node.js original fixture license\n');
  writeFileSync(join(crate,'Cargo.toml'),'[package]\nname="example-lib"\n');
  const noticePath=join(root,'COPYRIGHT-library.html');writeFileSync(noticePath,'Rust Standard Library original fixture notice\n');
  const metadata={packages:[{name:'example-lib',version:'1.0.0',source:'registry+https://example.invalid',manifest_path:join(crate,'Cargo.toml'),license:'MIT'}]};
  return {root,crate,out,options:{implementationRoot:root,toolchainRoot:out,nodeSource:join(node,'bin/node'),metadata,rustLibrary:{version:'1.95.0',noticePath}}};
}
test('notices preserve original license bytes and exclude source-machine paths',t=>{
  const f=fixture(t);writeFileSync(join(f.crate,'LICENSE-MIT'),'Copyright Fixture Author\nPermission notice\n');
  const proof=writeThirdPartyNotices(f.options);assert.equal(proof.components,3);
  assert.equal(readFileSync(join(f.out,'licenses/rust-standard-library/COPYRIGHT-library.html'),'utf8'),'Rust Standard Library original fixture notice\n');
  assert.equal(readFileSync(join(f.out,'licenses/rust/example-lib-1.0.0/LICENSE-MIT'),'utf8'),'Copyright Fixture Author\nPermission notice\n');
  const index=readFileSync(join(f.out,'licenses/manifest.json'),'utf8');assert.equal(index.includes(f.root),false);
  assert.equal(readFileSync(join(f.out,'THIRD_PARTY_NOTICES.md'),'utf8').includes(f.root),false);
});
test('missing redistribution text refuses packaging',t=>{
  const f=fixture(t);assert.throws(()=>writeThirdPartyNotices(f.options),/Missing redistribution notice/);
});
test('official Windows layout keeps the Node notice beside node.exe',t=>{
  const f=fixture(t);writeFileSync(join(f.crate,'LICENSE-MIT'),'Original fixture notice\n');
  const executable=join(f.root,'node/node.exe');renameSync(f.options.nodeSource,executable);
  f.options.nodeSource=executable;
  assert.equal(writeThirdPartyNotices(f.options).components,3);
  assert.equal(readFileSync(join(f.out,'licenses/node/LICENSE'),'utf8'),'Node.js original fixture license\n');
});
test('a source package cannot copy a notice from outside its directory',t=>{
  const f=fixture(t);writeFileSync(join(f.root,'outside-license'),'not a package notice');
  f.options.metadata.packages[0].license_file='../outside-license';
  assert.throws(()=>writeThirdPartyNotices(f.options),/inside its source package/);
});
