import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath, pathToFileURL} from "node:url";
import {buildHandlerSandboxPlan} from "../runtime/touba-runtime/src/handler-protocol.mjs";

const bounded = value => String(value ?? "").slice(0,8192).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,"");
export function diagnose(binding) {
  assert.equal(process.platform,"linux");
  assert.equal(process.env.GITHUB_ACTIONS,"true");
  assert.match(binding.handler.cwd,/^\/tmp\/touba-python-package-sandbox-[^/]+\/consumer$/);
  assert.equal(binding.sandbox.required,true);
  const probeCode="import json,sys,sysconfig; print(json.dumps({'prefix':sys.prefix,'base_prefix':sys.base_prefix,'executable':sys.executable,'libdir':sysconfig.get_config_var('LIBDIR'),'ldlibrary':sysconfig.get_config_var('LDLIBRARY'),'instsoname':sysconfig.get_config_var('INSTSONAME')}),flush=True); import asyncio,touba_sdk; print('SDK_IMPORT_OK',flush=True)";
  const probeBinding={...binding,handler:{...binding.handler,args:["-I","-B","-c",probeCode]}};
  const plan=buildHandlerSandboxPlan({binding:probeBinding,env:{...process.env,TOUBA_BWRAP_COMMAND:process.env.TOUBA_TEST_BWRAP}});
  assert.equal(plan.mechanism,"bubblewrap-seccomp-landlock");
  const host=spawnSync(binding.handler.command,["-I","-B","-c",probeCode],{encoding:"utf8",timeout:10000,maxBuffer:8192,env:{PATH:process.env.PATH ?? ""}});
  console.log("PYTHON_SANDBOX_HOST_CONTROL",JSON.stringify({status:host.status,stdout:bounded(host.stdout),stderr:bounded(host.stderr)}));
  console.log("PYTHON_SANDBOX_SELECTION",JSON.stringify({command:binding.handler.command,canonical:realpathSync(binding.handler.command),code_files:binding.sandbox.code_paths.length,python_libraries:binding.sandbox.code_paths.filter(p=>/libpython|pyvenv\.cfg|touba_sdk\/__init__\.py$/.test(p)),planned_command:plan.args.at(-5)}));
  const temporary=mkdtempSync(join(tmpdir(),"touba-sandbox-diagnostic-"));
  const fds=[];
  try {
    for(const [name,bytes] of [["filter",plan.seccomp],["policy",plan.policy]]){
      const path=join(temporary,name);writeFileSync(path,bytes,{mode:0o600,flag:"wx"});fds.push(openSync(path,"r"));
    }
    const result=spawnSync(plan.command,plan.args,{cwd:binding.handler.cwd,encoding:"utf8",timeout:10000,maxBuffer:8192,env:{PYTHONDONTWRITEBYTECODE:"1",...plan.environment},stdio:["ignore","pipe","pipe","ignore",...fds]});
    console.log("PYTHON_SANDBOX_STARTUP",JSON.stringify({status:result.status,signal:result.signal,error_code:result.error?.code,stdout:bounded(result.stdout),stderr:bounded(result.stderr)}));
  } finally {fds.forEach(fd=>closeSync(fd));rmSync(temporary,{recursive:true,force:true});}
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  assert.equal(process.argv[2],"--run");assert.equal(process.platform,"linux");assert.equal(process.env.GITHUB_ACTIONS,"true");
  const sourcePath=fileURLToPath(new URL("../cli/touba-project/test/python-package-sandbox.test.mjs",import.meta.url));
  const source=readFileSync(sourcePath,"utf8"),anchor="  const engine = new ToubaEngine({ projectRoot: project, command: process.execPath, commandArgs: [cli] });";
  assert.equal(source.split(anchor).length,2);
  const injection=`  (await import(${JSON.stringify(import.meta.url)})).diagnose({ ...fragment.bindings[ref], limits: { timeout_ms: 10000, max_payload_bytes: 65536 } });\n`;
  const generated=join(dirname(sourcePath),`python-sandbox-diagnostic-${process.pid}.test.mjs`);
  assert.equal(existsSync(generated),false);
  writeFileSync(generated,source.replace(anchor,injection+anchor),{flag:"wx",mode:0o600});
  try {
    const result=spawnSync(process.execPath,["--test","--test-reporter=tap",generated],{stdio:"inherit",timeout:60000,env:{...process.env,TOUBA_BWRAP_COMMAND:process.env.TOUBA_TEST_BWRAP}});
    process.exitCode=result.status ?? 1;
  }finally{rmSync(generated);}
}
