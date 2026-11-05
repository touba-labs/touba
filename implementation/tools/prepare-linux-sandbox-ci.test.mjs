import test from "node:test";
import assert from "node:assert/strict";
import {prepareLinuxSandboxCi,ciBwrap,ciProfile,profileText} from "./prepare-linux-sandbox-ci.mjs";
const env={GITHUB_ACTIONS:"true",RUNNER_ENVIRONMENT:"github-hosted",GITHUB_ENV:"/test/env"};
test("CI sandbox preparation refuses personal and self-hosted machines before any command",()=>{
  for(const options of [{platform:"darwin",env},{platform:"linux",env:{}},{platform:"linux",env:{...env,RUNNER_ENVIRONMENT:"self-hosted"}}])
    assert.throws(()=>prepareLinuxSandboxCi({...options,run:()=>assert.fail("no command permitted")}));
});
test("working bubblewrap is preserved without privilege changes",()=>{
  const calls=[];const result=prepareLinuxSandboxCi({platform:"linux",env,
    run:(command,args)=>{calls.push([command,args]);return {status:0};},
    append:(...args)=>calls.push(args),read:()=>assert.fail("no policy change needed")});
  assert.equal(result.profile_added,false);assert.equal(calls.length,2);
  assert.equal(calls[0][0],"/usr/bin/bwrap");assert.equal(calls[1][1],"TOUBA_TEST_BWRAP=/usr/bin/bwrap\n");
});
test("restricted runner uses only a root-owned dedicated executable and profile",()=>{
  const calls=[];
  const result=prepareLinuxSandboxCi({platform:"linux",env,
    run:(command,args)=>{calls.push([command,args]);return command==="/usr/bin/bwrap"?{status:1,stderr:"Creating new namespace failed: Operation not permitted"}:{status:0};},
    read:()=>"1\n",mkdir:()=>"/test/scratch",write:(...args)=>calls.push(["write",args]),
    remove:(...args)=>calls.push(["remove",args]),append:(...args)=>calls.push(["append",args])});
  assert.equal(result.profile_added,true);
  assert.ok(calls.some(([c,a])=>c==="sudo"&&a.join(" ")===`apparmor_parser --replace ${ciProfile}`));
  assert.ok(calls.some(([c,a])=>c==="sudo"&&a.join(" ")===`install -o root -g root -m 0755 /usr/bin/bwrap ${ciBwrap}`));
  assert.ok(calls.some(([c])=>c===ciBwrap));
  assert.doesNotMatch(JSON.stringify(calls),/sysctl|systemctl|setcap|chmod/);
  assert.match(profileText,/userns,/);assert.doesNotMatch(profileText,/\*|\/home\//);
});
test("unexplained probe failure does not change system policy",()=>{
  for(const [stderr,restriction] of [["unknown failure","1"],["Operation not permitted","0"]]){
    assert.throws(()=>prepareLinuxSandboxCi({platform:"linux",env,
      run:()=>({status:1,stderr}),read:()=>restriction,mkdir:()=>assert.fail("no writes permitted")}));
  }
});
