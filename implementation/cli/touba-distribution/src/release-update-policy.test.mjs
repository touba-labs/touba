import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {assertReleaseUpdateSequence,checkReleaseUpdateSequence} from './release-update-policy.mjs';
import {chooseRelease} from '../../touba-project/src/update/protocol.mjs';
import {fileURLToPath} from 'node:url';
const index=()=>({current_version:'1.3.1',versions:[{version:'1.3.1',update_build_sequence:2},{version:'1.1.0',status:'published',update_build_sequence:1}]});
test('public release sequence must advance even when the semantic version advances',()=>{
 assert.equal(assertReleaseUpdateSequence(index(),{build_sequence:2}),2);
 for(const sequence of [0,1,-1,1.5,undefined]){
  const value=index();value.versions[0].update_build_sequence=sequence;
  assert.throws(()=>assertReleaseUpdateSequence(value,{build_sequence:sequence}),/ReleaseUpdateSequence/);
 }
});
test('missing or mismatched current release metadata is rejected before packaging',()=>{
 for(const value of [undefined,1,3]){const source=index();source.versions[0].update_build_sequence=value;assert.throws(()=>assertReleaseUpdateSequence(source,{build_sequence:2}),/Mismatch/);}
});
test('retained sequences, including retired builds, cannot be reused',()=>{
 const source=index();source.versions.push({version:'1.2.0',status:'retired',update_build_sequence:2});
 assert.throws(()=>assertReleaseUpdateSequence(source,{build_sequence:2}),/NotIncreasing/);
});
test('actual release policy permits the transition from the latest published version',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));checkReleaseUpdateSequence(root);
 const source=JSON.parse(readFileSync(new URL('../../../release/releases.json',import.meta.url)));
 const policy=JSON.parse(readFileSync(new URL('../../touba-project/src/update/trust.json',import.meta.url)));
 for(const previous of source.versions.filter(r=>r.status==='published'&&r.version!==source.current_version&&r.update_build_sequence)){
  const old={platform:'linux-x64',touba_version:previous.version,build:{id:'a'.repeat(64)}};
  const release={platform:'linux-x64',version:source.current_version,build_id:'b'.repeat(64),build_sequence:policy.build_sequence};
  assert.equal(chooseRelease({releases:[release]},old,{...policy,build_sequence:previous.update_build_sequence}).current,false);
  assert.throws(()=>chooseRelease({releases:[{...release,build_sequence:previous.update_build_sequence}]},old,{...policy,build_sequence:previous.update_build_sequence}),{code:'UpdateDowngradeRefused'});
 }
});
