import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

export const ciBwrap = "/usr/local/libexec/touba-ci/bwrap";
export const ciProfile = "/etc/apparmor.d/touba-ci-bwrap";
// Ubuntu's documented per-executable userns grant. No global sysctl change.
// https://documentation.ubuntu.com/release-notes/24.04/
export const profileText = `abi <abi/4.0>,
include <tunables/global>
profile touba-ci-bwrap ${ciBwrap} flags=(unconfined) {
  userns,
}
`;
const probeArgs = ["--unshare-user", "--unshare-pid", "--unshare-net",
  "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib",
  "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"];

export function prepareLinuxSandboxCi({platform=process.platform,env=process.env,
  run=(command,args)=>spawnSync(command,args,{encoding:"utf8",timeout:15000,env:{PATH:"/usr/sbin:/usr/bin:/sbin:/bin"}}),
  read=readFileSync,write=writeFileSync,mkdir=mkdtempSync,remove=rmSync,
  append=appendFileSync}={}) {
  assert.equal(platform,"linux");
  assert.equal(env.GITHUB_ACTIONS,"true");
  assert.equal(env.RUNNER_ENVIRONMENT,"github-hosted");
  assert.ok(env.GITHUB_ENV,"GitHub environment file required");
  const checked=(command,args)=>{
    const result=run(command,args);
    assert.equal(result.status,0,`${command}: ${result.error?.message??result.stderr??"failed"}`);
    return result;
  };
  const initial=run("/usr/bin/bwrap",probeArgs);
  if(initial.status===0){append(env.GITHUB_ENV,"TOUBA_TEST_BWRAP=/usr/bin/bwrap\n");return {profile_added:false};}
  assert.match(initial.stderr??"",/Operation not permitted|Permission denied/i,"Unexpected bubblewrap startup failure");
  assert.equal(read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns","utf8").trim(),"1",
    "User namespace restriction not established; do not alter AppArmor");
  const scratch=mkdir(join(tmpdir(),"touba-ci-apparmor-"));
  try {
    const source=join(scratch,"touba-ci-bwrap");write(source,profileText,{mode:0o600,flag:"wx"});
    checked("sudo",["install","-d","-o","root","-g","root","-m","0755","/usr/local/libexec/touba-ci"]);
    checked("sudo",["install","-o","root","-g","root","-m","0755","/usr/bin/bwrap",ciBwrap]);
    checked("sudo",["install","-o","root","-g","root","-m","0644",source,ciProfile]);
    checked("sudo",["apparmor_parser","--replace",ciProfile]);
    checked(ciBwrap,probeArgs);
    assert.equal(read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns","utf8").trim(),"1");
    append(env.GITHUB_ENV,`TOUBA_TEST_BWRAP=${ciBwrap}\n`);
    return {profile_added:true,path:ciBwrap,global_userns_restriction:1};
  } finally {remove(scratch,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(prepareLinuxSandboxCi()));
