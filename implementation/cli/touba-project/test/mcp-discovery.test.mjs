import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createMcpDiscovery} from '../src/mcp-discovery.mjs';
import {discoverMcpTools} from '../../../runtime/touba-handler-sdk/src/index.mjs';

function fixture(mode='normal') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'touba-mcp-discovery-')));
  const server=join(root,'server.mjs'), log=join(root,'methods.jsonl'), configPath=join(root,'discovery.json');
  writeFileSync(server,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify({method:m.method,params:m.params})+'\\n');
 if(!m.id)return;if(mode==='hang'&&m.method==='tools/list')return;
 let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}}}:{tools:[{
 name:m.params.cursor?'second':'first',inputSchema:{type:'object',properties:{text:{type:'string'}},required:[],additionalProperties:false},
 outputSchema:{type:'object',properties:{text:{type:'string'}},required:[],additionalProperties:false},description:mode==='secret'?process.env.API_KEY:'Safe metadata'
 }],...(!m.params.cursor||mode==='loop'?{nextCursor:'next'}:{})};
 if(mode==='large'&&m.method==='tools/list')result={tools:[],padding:'x'.repeat(5000)};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  const config={mcp_bridge_config_version:'touba-mcp-bridge-config-v1',server:{transport:'stdio',command:process.execPath,args:[server],cwd:root,timeout_ms:1000,max_payload_bytes:4096,env:{}}};
  writeFileSync(configPath,JSON.stringify({schema_version:'touba-mcp-discovery-v1',targets:[{id:'fixture',label:'Synthetic server',config,secret_handles:[]}]}));
  return {root,server,log,configPath,config,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('explicit discovery is paged, bounded and never calls a business tool',async()=>{
  const f=fixture();try{
    const discovery=createMcpDiscovery(f.configPath);
    assert.equal(discovery.targets().items[0].starts_process,true);
    assert.equal(existsSync(f.log),false,'opening target inventory never starts code');
    await assert.rejects(discovery.discover({target:'fixture'}),{code:'McpDiscoveryConsentRequired'});
    await assert.rejects(discovery.discover({target:'foreign',confirm_process:true}),{code:'McpDiscoveryTargetUnavailable'});
    await assert.rejects(discovery.discover({target:'fixture',confirm_process:true,command:'ignored'}),{code:'McpDiscoveryConsentRequired'});
    const result=await discovery.discover({target:'fixture',confirm_process:true});
    assert.deepEqual(result.document.tools.map(t=>t.name),['first','second']);
    const messages=readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(messages.map(m=>m.method),['initialize','notifications/initialized','tools/list','tools/list']);
    const cli=spawnSync(process.execPath,[new URL('../src/main.mjs',import.meta.url).pathname,'mcp','discover',f.configPath,'fixture','--confirm-process'],{encoding:'utf8',timeout:5000});
    assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).document.tools.length,2);
  }finally{f.cleanup();}
});

test('discovery refuses cursor loops, output floods and a stalled child',async()=>{
  for(const [mode,code] of [['loop','McpDiscoveryInvalid'],['large','McpPayloadTooLarge'],['hang',null]]){
    const f=fixture(mode);try{
      const start=Date.now();
      await assert.rejects(discoverMcpTools({config:f.config}),error=>code?error.code===code:['McpRequestTimeout','McpServerClosed'].includes(error.code));
      assert.ok(Date.now()-start<3000);
    }finally{f.cleanup();}
  }
});

test('no inherited environment and an echoed granted credential is refused',async()=>{
  const f=fixture('secret');try{
    f.config.server.env={API_KEY:{from_secret_handle:'DISCOVERY_TEST_KEY'}};
    await assert.rejects(discoverMcpTools({config:f.config}),{code:'McpSecretNotGranted'});
    await assert.rejects(discoverMcpTools({config:f.config,context:{secretHandles:['DISCOVERY_TEST_KEY'],env:{DISCOVERY_TEST_KEY:'synthetic-secret-never-rendered'}}}),{code:'McpDiscoverySecretEcho'});
    for(const value of ['xy','escaped"credential\\test']) await assert.rejects(discoverMcpTools({config:f.config,context:{secretHandles:['DISCOVERY_TEST_KEY'],env:{DISCOVERY_TEST_KEY:value}}}),{code:'McpDiscoverySecretEcho'});
  }finally{f.cleanup();}
});
