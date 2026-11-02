import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statfsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, hashPattern } from './protocol.mjs';

export function regular(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('UpdatePathUnsafe');
  return stat;
}
export function readJson(path, optional = false) {
  try {
    if (regular(path).size > 65536) fail('UpdateLocalMetadataInvalid');
    return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
export function atomicJson(path, value) {
  try { regular(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(path), `.update-write-${randomUUID()}`);
  let fd;
  try {
    fd=openSync(temporary,'wx',0o600); writeFileSync(fd,JSON.stringify(value,null,2)+'\n'); fsyncSync(fd); closeSync(fd); fd=undefined;
    renameSync(temporary,path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary,{force:true}); }
}
export function installation(root) {
  regular(root,true); root=realpathSync(root);
  const prefix=dirname(root);
  if (relative(prefix,root) !== 'touba-toolchain') fail('UpdateUnmanagedInstallation','Use the latest Touba installer once to enable updates for this installation.');
  const receipt=readJson(join(prefix,'INSTALLATION.json'));
  if (realpathSync(receipt.prefix) !== prefix || receipt.platform !== `${process.platform}-${process.arch}`) fail('UpdateInstallationInvalid');
  if (!['touba-desktop-install-v1','touba-local-install-v1','touba-local-release-install-v1','touba-local-release-install-experimental-v1','touba-github-release-install-v1'].includes(receipt.installation_profile)) fail('UpdatePackageManagerRequired','Update this system installation through its package manager.');
  // System/package-manager installations remain under their owner's control.
  if (prefix === '/usr' || prefix.startsWith('/usr/') || prefix === '/opt' || prefix.startsWith('/opt/')) fail('UpdatePackageManagerRequired');
  const metadata=readJson(join(root,'TOOLCHAIN.json'));
  if (metadata.platform !== receipt.platform || !hashPattern.test(metadata.build?.id)) fail('UpdateInstallationInvalid');
  return { root,prefix,receipt,metadata };
}
export function ensureSpace(prefix, bytes, stat = statfsSync) {
  const disk=stat(prefix,{bigint:true});
  if (disk.bavail * disk.bsize < BigInt(bytes) + 128n*1024n*1024n) fail('UpdateDiskSpaceInsufficient','Not enough free disk space for a verified update. The current build is unchanged.');
}
export function payloadSize(root) {
  let bytes = 0, count = 0;
  const visit = directory => {
    regular(directory, true);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (++count > 100000 || stat.isSymbolicLink()) fail('UpdateArchivePathUnsafe');
      if (stat.isDirectory()) visit(path);
      else { regular(path); bytes += stat.size; }
      if (bytes > 2 * 1024 ** 3) fail('UpdateArchiveLimit');
    }
  };
  visit(root);
  return bytes;
}
export function activeProcesses(root, execute = spawnSync) {
  let result, rows;
  if (process.platform === 'win32') {
    result=execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress'],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024,windowsHide:true});
    if (!result.error && result.status === 0) {
      const values=JSON.parse(result.stdout); rows=(Array.isArray(values)?values:[values]).map(row=>({pid:row.ProcessId,parent:row.ParentProcessId,executable:row.ExecutablePath ?? '',command:`${row.ExecutablePath ?? ''} ${row.CommandLine ?? ''}`}));
    }
  } else {
    result=execute('/bin/ps',['-axo','pid=,command='],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
    rows=result.stdout?.split('\n').map(line=>line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean).map(match=>({pid:+match[1],command:match[2]}));
  }
  if (result.error || result.status !== 0 || !rows) fail('UpdateProcessCheckFailed');
  const normalized=realpathSync(root).replaceAll('\\','/').toLowerCase();
  const spellings = new Set([root.replaceAll('\\','/').toLowerCase(), normalized]);
  // macOS exposes /private/var and /var as the same filesystem tree.
  if (process.platform === 'darwin' && normalized.startsWith('/private/')) spellings.add(normalized.slice('/private'.length));
  const bootstrapParents = new Set();
  if (process.platform === 'win32') {
    let pid = process.ppid;
    while (pid && !bootstrapParents.has(pid)) {
      const parent = rows.find(row => row.pid === pid);
      if (!parent || !/(?:^|[\\/])(?:cmd|powershell)\.exe$/i.test(parent.executable)
          || !/(?:windows-bootstrap\.ps1|touba\.cmd)[\s"].*\bupdate\b/i.test(parent.command)) break;
      bootstrapParents.add(pid); pid = parent.parent;
    }
  }
  return rows.filter(row=>row.pid !== process.pid && !bootstrapParents.has(row.pid)
    && [...spellings].some(path => row.command.replaceAll('\\','/').toLowerCase().includes(path))).map(row=>row.pid);
}
export function ensureIdle(root) {
  if (activeProcesses(root).length) fail('UpdateProcessesActive','Stop the Touba services using this installation, then run touba update again.');
}
export function verifyRuntime(root, expected) {
  if (process.platform === 'darwin') for (const name of ['node','touba-compile']) {
    const check=spawnSync('/usr/bin/codesign',['--verify','--strict',join(root,'bin',name)],{encoding:'utf8',timeout:15000});
    if (check.error || check.status !== 0) fail('UpdatePlatformSignatureInvalid');
  }
  const env={...process.env,TOUBA_COMPILE_BIN:join(root,'bin',process.platform==='win32'?'touba-compile.exe':'touba-compile')};
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  for (const name of Object.keys(env)) if (name.startsWith('DYLD_') || name.startsWith('LD_')) delete env[name];
  for (const command of ['version','doctor']) {
    const result=spawnSync(join(root,'bin',process.platform==='win32'?'node.exe':'node'),[join(root,'lib/cli/touba-project/src/main.mjs'),command,'--json'],{cwd:root,env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024,windowsHide:true});
    if (result.error || result.status !== 0) fail('UpdateRuntimeCheckFailed');
    const value=JSON.parse(result.stdout);
    if (command === 'version' && (value.build?.id !== expected.build_id || value.cli !== expected.version)) fail('UpdateRuntimeIdentityMismatch');
    if (command === 'doctor' && value.status === 'error') fail('UpdateRuntimeCheckFailed');
  }
}
