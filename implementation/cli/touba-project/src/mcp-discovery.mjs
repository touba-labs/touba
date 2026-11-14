import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { discoverMcpTools } from '../../../runtime/touba-handler-sdk/src/index.mjs';

const fail = (code,message) => {throw Object.assign(new Error(message),{code});};
const hash = text => 'sha256:'+createHash('sha256').update(text).digest('hex');

// Loaded only through an explicit host option. No discovery at startup and no
// browser-supplied executable, URL, environment value or path is accepted.
export function createMcpDiscovery(configPath) {
  let targets = [];
  if (configPath) {
    const path = resolve(configPath);
    for(let current=path;current!==dirname(current);current=dirname(current)) {
      if(lstatSync(current).isSymbolicLink()) fail('McpDiscoveryConfigInvalid','Discovery configuration must not follow symbolic links');
    }
    const stat=lstatSync(path);
    if(!stat.isFile() || stat.nlink!==1 || stat.size>262144) fail('McpDiscoveryConfigInvalid','Discovery configuration must be a bounded regular file');
    const document=JSON.parse(readFileSync(path,'utf8'));
    if(document.schema_version!=='touba-mcp-discovery-v1' || !Array.isArray(document.targets) || document.targets.length>16
      || Object.keys(document).some(key=>!['schema_version','targets'].includes(key))) fail('McpDiscoveryConfigInvalid','Invalid discovery configuration');
    const ids=new Set();
    targets=document.targets.map(item=>{
      if(!item || Object.keys(item).some(key=>!['id','label','config','secret_handles','max_pages','max_tools'].includes(key))
        || !/^[a-z][a-z0-9_-]{0,47}$/.test(item.id??'') || ids.has(item.id)
        || typeof item.label!=='string' || !item.label.trim() || item.label.length>120
        || item.config?.server?.transport!=='stdio' || !isAbsolute(item.config.server.command??'')
        || item.config.server.cwd!==undefined && !isAbsolute(item.config.server.cwd)
        || !Array.isArray(item.secret_handles) || item.secret_handles.length>16
        || item.secret_handles.some(h=>!/^[A-Z][A-Z0-9_]{0,63}$/.test(h))) fail('McpDiscoveryConfigInvalid','Invalid approved discovery target');
      ids.add(item.id);
      for(const entry of Object.values(item.config.server.env??{})) if(entry.value!==undefined) fail('McpDiscoveryConfigInvalid','Discovery environment values must use explicitly granted secret handles');
      return structuredClone(item);
    });
  }
  let busy=false;
  return {
    targets:()=>({schema_version:'touba-mcp-discovery-targets-v1',items:targets.map(t=>({id:t.id,label:t.label,transport:'stdio',starts_process:true}))}),
    async discover(request) {
      if(!request || Object.keys(request).some(key=>!['target','confirm_process'].includes(key)) || request.confirm_process!==true) fail('McpDiscoveryConsentRequired','Confirm execution of the approved local MCP server');
      const target=targets.find(t=>t.id===request.target);
      if(!target) fail('McpDiscoveryTargetUnavailable','Select an approved discovery target');
      if(busy) fail('McpDiscoveryBusy','Another discovery is running');
      busy=true;
      try {
        const document=await discoverMcpTools({config:target.config,context:{secretHandles:target.secret_handles},maxPages:target.max_pages??8,maxTools:target.max_tools??256});
        return {schema_version:'touba-mcp-discovery-result-v1',target:target.id,discovered_at:new Date().toISOString(),digest:hash(JSON.stringify(document)),document};
      } finally {busy=false;}
    },
  };
}
