import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {reviewSdkCleanup,cleanSdkArchives} from '../src/sdk-cleanup.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'touba-sdk-clean-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const add=(name,data)=>{const id=hash(data),dir=join(root,'vendor/touba-sdk',id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),data);return{id,path:`vendor/touba-sdk/${id}/${name}`};};return{root,add};}

test('two SDK upgrades retain referenced revisions and explicit rollback while removing only reviewed orphans',t=>{
 const {root,add}=fixture(t),first=add('touba-sdk-old.tgz','old'),second=add('touba-sdk-rollback.tgz','rollback'),third=add('touba-sdk-current.tgz','current');
 writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{'@touba/sdk':`file:${third.path}`}}));
 const options={root,language:'javascript',keep:[second.id]},plan=reviewSdkCleanup(options);assert.equal(plan.status,'preview');assert.deepEqual(plan.candidates.map(x=>x.path),[first.path]);assert(existsSync(join(root,first.path)));
 const applied=cleanSdkArchives({...options,accept:plan.reviewDigest});assert.deepEqual(applied.removed,[first.path]);assert(!existsSync(join(root,first.path)));assert(existsSync(join(root,second.path)));assert(existsSync(join(root,third.path)));
});

test('a stale preview refuses all deletion and a nested dependency retains its archive',t=>{
 const {root,add}=fixture(t),old=add('touba-sdk-old.tgz','old');const plan=reviewSdkCleanup({root,language:'javascript'});
 mkdirSync(join(root,'packages/app'),{recursive:true});writeFileSync(join(root,'packages/app/package-lock.json'),JSON.stringify({resolved:`file:../../${old.path}`}));
 assert.throws(()=>cleanSdkArchives({root,language:'javascript',accept:plan.reviewDigest}),{code:'SDKCleanupReviewStale'});assert(existsSync(join(root,old.path)));assert.equal(reviewSdkCleanup({root,language:'javascript'}).candidates.length,0);
});

test('unknown files, symlinks, Python environments and execution state are preserved',t=>{
 for(const mode of ['unknown','link','environment','state','private']){
  const f=fixture(t),archive=f.add(mode==='environment'?'touba_sdk-1.0-py3-none-any.whl':'touba-sdk-old.tgz','controlled');
  if(mode==='unknown')writeFileSync(join(f.root,'vendor/touba-sdk/unknown.txt'),'keep');
  if(mode==='link')symlinkSync(join(f.root,archive.path),join(f.root,'vendor/touba-sdk/current'));
  if(mode==='environment'){mkdirSync(join(f.root,'.venv'));writeFileSync(join(f.root,'.venv/pyvenv.cfg'),'synthetic');}
  if(mode==='state'){mkdirSync(join(f.root,'.touba'));writeFileSync(join(f.root,'.touba/approval-checkpoints.sqlite'),'synthetic');}
  if(mode==='private')writeFileSync(join(f.root,'.env'),Buffer.alloc(9*1024*1024,1));
  assert.equal(reviewSdkCleanup({root:f.root,language:mode==='environment'?'python':'javascript'}).candidates.length,0);assert(existsSync(join(f.root,archive.path)));
 }
});

test('symlink vendor cannot escape the project and language selection preserves the other SDK',t=>{
 const {root,add}=fixture(t),js=add('touba-sdk-old.tgz','javascript'),py=add('touba_sdk-1.0-py3-none-any.whl','python');
 const plan=reviewSdkCleanup({root,language:'javascript'});cleanSdkArchives({root,language:'javascript',accept:plan.reviewDigest});assert(!existsSync(join(root,js.path)));assert.equal(readFileSync(join(root,py.path),'utf8'),'python');
 const external=fixture(t);symlinkSync(join(root,'vendor'),join(external.root,'vendor'));assert.throws(()=>reviewSdkCleanup({root:external.root,language:'javascript'}),{code:'SDKCleanupPathInvalid'});
});

test('decoded JSON and URI references protect archives, malformed declarations stay conservative',t=>{
 for(const encoding of ['json','uri','invalid']){
  const {root,add}=fixture(t),archive=add('touba-sdk-old.tgz','controlled');
  let body=JSON.stringify({dependencies:{'@touba/sdk':`file:${archive.path}`}});
  if(encoding==='json')body=body.replaceAll(archive.id,archive.id.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  if(encoding==='uri')body=JSON.stringify({dependencies:{'@touba/sdk':'file:'+archive.path.split('').map(c=>'%'+c.charCodeAt(0).toString(16)).join('')}});
  if(encoding==='invalid')body='{invalid';
  writeFileSync(join(root,'package.json'),body);
  assert.equal(reviewSdkCleanup({root,language:'javascript'}).candidates.length,0);assert(existsSync(join(root,archive.path)));
 }
});

test('nested execution state and unknown checkpoint names protect archives even beside an empty state directory',t=>{
 const {root,add}=fixture(t),archive=add('touba-sdk-old.tgz','controlled');
 const options={root,language:'javascript'},before=reviewSdkCleanup(options);
 assert.equal(before.candidates.length,1);
 mkdirSync(join(root,'packages/active/.touba'),{recursive:true});
 writeFileSync(join(root,'packages/active/.touba/wait.json'),JSON.stringify({status:'human_approval_pending'}));
 mkdirSync(join(root,'packages/empty/.touba'),{recursive:true});
 const preview=reviewSdkCleanup(options);
 assert.equal(preview.candidates.length,0);
 assert.equal(preview.archives[0].protectedBy,'execution_state');
 assert.throws(()=>cleanSdkArchives({...options,accept:before.reviewDigest}),{code:'SDKCleanupReviewStale'});
 const applied=cleanSdkArchives({...options,accept:preview.reviewDigest});
 assert.equal(applied.removed.length,0);assert(existsSync(join(root,archive.path)));
});
