import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

// This is a project archive inventory, never a global package-manager cache purge.
export function reviewSdkCleanup({root=process.cwd(),language,keep=[]}={}){
  if(!['javascript','python'].includes(language))fail('SDKCleanupLanguageInvalid','Choose javascript or python.');
  if(!Array.isArray(keep)||keep.some(id=>! /^[a-f0-9]{64}$/.test(id)))fail('SDKCleanupKeepInvalid','Keep entries must be full archive SHA-256 values.');
  root=realpathSync(root);const vendor=join(root,'vendor'),directory=join(vendor,'touba-sdk');
  for(const path of [vendor,directory])if(existsSync(path)){const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())fail('SDKCleanupPathInvalid','SDK archive directories must be real project directories.');}
  const archives=[],inventory=[];let text='',total=0,external=false,environment=false,executionState=false;
  function scan(path,depth=0){
    if(depth>20||inventory.length>=10000)fail('SDKCleanupInventoryLimit','Project reference inventory exceeds its bound.');
    const stat=lstatSync(path),name=relative(root,path).replaceAll('\\','/');
    if(stat.isSymbolicLink()){external=true;inventory.push({path:name,kind:'symlink'});return;}
    if(stat.isDirectory()){
      if(path===directory)return;
      if(['.git','node_modules','__pycache__'].includes(path.split(/[\\/]/).at(-1)))return;
      if(existsSync(join(path,'pyvenv.cfg'))){environment=true;inventory.push({path:name,kind:'python-environment'});return;}
      if(path.split(/[\\/]/).at(-1)==='.touba'){
        // A nested project or an unfamiliar checkpoint name can retain this SDK.
        // Treat nonempty state as protected instead of interpreting private stores.
        executionState ||= readdirSync(path).length>0;
        inventory.push({path:name,kind:'execution-state',protected:executionState});return;
      }
      for(const child of readdirSync(path).sort())scan(join(path,child),depth+1);
    }else if(stat.isFile()){
      if(/(?:^|[\/])(?:[.]env(?:[.]|$)|[^\/]*secrets[^\/]*)/i.test(name)){external=true;inventory.push({path:name,kind:'private-unread'});return;}
      if(stat.size>8*1024*1024||total+stat.size>32*1024*1024)fail('SDKCleanupInventoryLimit','A project reference file exceeds the bounded review; no archive was removed.');
      const data=readFileSync(path);total+=data.length;inventory.push({path:name,sha256:hash(data),bytes:data.length});
      const raw=data.toString('utf8');text+='\n'+raw;
      if(name.endsWith('.json')){
        try{text+='\n'+JSON.stringify(JSON.parse(raw));}catch{external=true;}
      }else if(/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2})/.test(raw))external=true;
      text+='\n'+raw.replace(/(?:%[0-9a-fA-F]{2})+/g,encoded=>{try{return decodeURIComponent(encoded);}catch{external=true;return encoded;}});
    }else {external=true;inventory.push({path:name,kind:'unsupported'});}
  }
  scan(root);
  const managed=[];
  if(existsSync(directory))for(const revision of readdirSync(directory).sort()){
    const path=join(directory,revision),stat=lstatSync(path);
    if(!/^[a-f0-9]{64}$/.test(revision)||!stat.isDirectory()||stat.isSymbolicLink()){external=true;continue;}
    const names=readdirSync(path);if(names.length!==1){external=true;continue;}
    const file=names[0],archive=join(path,file),info=lstatSync(archive);
    const kind=file.endsWith('.whl')?'python':file.endsWith('.tgz')?'javascript':null;
    if(!kind||!/^touba[-_]sdk(?:[-.]|$)/.test(file)||!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>64*1024*1024){external=true;continue;}
    const digest=hash(readFileSync(archive));if(digest!==revision){external=true;continue;}
    managed.push({path:relative(root,archive).replaceAll('\\','/'),sha256:digest,bytes:info.size,language:kind,file});
  }
  for(const {file,...item} of managed){
    const protectedBy=keep.includes(item.sha256)?'explicit_keep':external?'unreviewable_reference':executionState?'execution_state':item.language==='python'&&environment?'python_environment':text.includes(item.sha256)||text.includes(file)||text.includes(encodeURIComponent(file))?'project_reference':null;
    archives.push({...item,protectedBy});
  }
  const candidates=archives.filter(x=>x.language===language&&!x.protectedBy);
  const review={root,language,keep:[...keep].sort(),archives,inventory};
  return {status:'preview',language,archives,candidates,bytes:candidates.reduce((sum,x)=>sum+x.bytes,0),reviewDigest:hash(JSON.stringify(review)),root};
}

export function cleanSdkArchives(options={}){
  const plan=reviewSdkCleanup(options);if(options.accept===undefined)return plan;
  if(options.accept!==plan.reviewDigest)fail('SDKCleanupReviewStale','Project references or archives changed; request a new preview.');
  const removed=[];
  for(const item of plan.candidates){
    // Recheck every reference before each deletion. External package managers
    // must be stopped; this command cannot lock another tool's writers.
    const current=reviewSdkCleanup(options);
    if(!current.candidates.some(x=>x.path===item.path&&x.sha256===item.sha256))fail('SDKCleanupReviewStale','An archive gained a reference; request a new preview.');
    const path=join(plan.root,item.path);unlinkSync(path);rmdirSync(dirname(path));removed.push(item.path);
  }
  return {...plan,status:'applied',removed};
}
