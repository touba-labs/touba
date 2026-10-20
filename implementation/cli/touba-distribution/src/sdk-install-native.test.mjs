import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter, dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {packageSdk} from "./package-sdk.mjs";

test("offline JavaScript SDK installation repeats across projects with the bundled Node first on PATH", {timeout:240000}, t=>{
  const implementation=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
  const root=mkdtempSync(join(tmpdir(),"touba-sdk-native-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const toolchain=join(root,"installation with spaces");mkdirSync(join(toolchain,"bin"),{recursive:true});
  const sdk=packageSdk(implementation,toolchain);
  writeFileSync(join(toolchain,"TOOLCHAIN.json"),JSON.stringify({sdk}));
  const sourceNode=process.platform==='darwin' && process.arch==='arm64'
    ? resolve(implementation,".toolchains/node-v24.15.0-darwin-arm64/bin/node") : process.execPath;
  assert.ok(existsSync(sourceNode),"A portable native Node binary is required");
  const node=join(toolchain,"bin",process.platform==='win32'?'node.exe':'node');copyFileSync(sourceNode,node);
  const module=pathToFileURL(join(implementation,"cli/touba-project/src/sdk-command.mjs")).href;
  const cache=join(root,"npm-cache");
  for(const [index,prepend] of [false,true,true].entries()){
    const project=join(root,"project "+index);mkdirSync(project);
    const env={...process.env,npm_config_cache:cache,npm_config_loglevel:"verbose"};
    if(prepend)env.PATH=join(toolchain,"bin")+delimiter+process.env.PATH;
    console.log(JSON.stringify({stage:"sdk-install",index,prepend}));
    const started=Date.now();
    const code=`import {installSdk} from ${JSON.stringify(module)};installSdk("javascript",{root:${JSON.stringify(project)},distributionRoot:${JSON.stringify(toolchain)}});console.log("installed");`;
    const result=spawnSync(node,["--input-type=module","-e",code],{cwd:project,env,encoding:"utf8",timeout:150000,maxBuffer:2*1024*1024});
    console.log(JSON.stringify({stage:"sdk-result",index,elapsedMs:Date.now()-started,status:result.status,error:result.error?.code}));
    if(result.status!==0){
      const logs=join(cache,"_logs");
      if(existsSync(logs))for(const name of readdirSync(logs).filter(n=>n.endsWith("debug-0.log")).slice(-2)){
        // Only npm phase/timing records; never print configuration or requests.
        const lines=readFileSync(join(logs,name),"utf8").split(/\r?\n/).filter(line=>/^\d+ (timing |verbose (node|npm|exit|cwd)|silly (reify|idealTree))/.test(line));
        console.log(lines.slice(-25).join("\n"));
      }
    }
    assert.equal(result.status,0,result.error?.message??result.stderr);
    assert.match(result.stdout,/installed/);
    const identity=JSON.parse(readFileSync(join(project,"package.json"),"utf8"));
    assert.match(identity.dependencies["@touba/sdk"],/^file:vendor\/touba-sdk\//);
  }
});
