import { spawn, spawnSync } from 'node:child_process';
import { packageError } from './package-contract.mjs';

// Credentials travel on stdin, never in argv, environment variables or diagnostics.
function execute(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 262144, windowsHide: true });
  return { ok: !result.error && result.status === 0, status: result.status, output: result.stdout ?? '' };
}

function executeAsync(command, args, input) {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15000);
    child.stdout.on('data', data => { output += data; if (Buffer.byteLength(output) > 262144) { failed = true; child.kill('SIGKILL'); } });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, status: null, output: '' }); });
    child.on('close', status => { clearTimeout(timer); resolve({ ok: !failed && status === 0, status, output: failed ? '' : output }); });
    child.stdin.on('error', () => { failed = true; });
    child.stdin.end(input);
  });
}

const windows = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ToubaCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
  public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential credential,uint flags);
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr credential);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target,uint type,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$inputData = '__PAYLOAD__' | ConvertFrom-Json
$target = '__SERVICE__/' + $inputData.key
if ($inputData.action -eq 'read') {
 $pointer = [IntPtr]::Zero
 if (![ToubaCredential]::Read($target,1,0,[ref]$pointer)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }; exit 1 }
 try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][ToubaCredential+Credential])
  if ($credential.CredentialBlobSize -gt 2560) { exit 1 }
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob,$bytes,0,$bytes.Length)
  [Console]::Write([Text.Encoding]::UTF8.GetString($bytes))
 } finally { [ToubaCredential]::CredFree($pointer) }
} elseif ($inputData.action -eq 'delete') {
 if (![ToubaCredential]::Delete($target,1,0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { exit 1 }
} else {
 $bytes = [Text.Encoding]::UTF8.GetBytes($inputData.value)
 if ($bytes.Length -gt 2560) { exit 1 }
 $credential = New-Object ToubaCredential+Credential
 $credential.Type=1; $credential.TargetName=$target; $credential.Persist=2; $credential.UserName='Touba'
 $credential.CredentialBlobSize=$bytes.Length; $credential.CredentialBlob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
 try { [Runtime.InteropServices.Marshal]::Copy($bytes,0,$credential.CredentialBlob,$bytes.Length); if (![ToubaCredential]::Write([ref]$credential,0)) { exit 1 } }
 finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($credential.CredentialBlob) }
}
exit 0
`;

export function systemVault({ platform = process.platform, purpose = 'registry', asynchronous = false, run = asynchronous ? executeAsync : execute } = {}) {
  if (!['registry', 'project-service'].includes(purpose)) throw new Error('Unsupported credential purpose');
  const SERVICE = purpose === 'registry' ? 'org.toubalang.registry-session.v1' : 'org.toubalang.project-service.v1';
  const unavailable = () => { throw packageError(purpose === 'registry' ? 'RegistryVaultUnavailable' : 'ToubaServeVaultUnavailable',
    'unlock the system credential vault; no credential was saved in a file'); };
  function* call(action, key, value = '') {
    if (!/^[a-f0-9]{64}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 100000) return unavailable();
    if (platform === 'darwin') {
      if (action === 'write') {
        // security -i parses this command from stdin. Base64 and the fixed hex
        // key exclude quotes, newlines and command injection.
        const encoded = Buffer.from(value).toString('base64');
        yield ['/usr/bin/security', ['-i'], `add-generic-password -U -a ${key} -s ${SERVICE} -w ${encoded}\n`];
        const saved = yield* call('read', key);
        if (saved !== value) return unavailable();
        return;
      }
      const result = yield ['/usr/bin/security', [action === 'read' ? 'find-generic-password' : 'delete-generic-password', '-a', key, '-s', SERVICE, ...(action === 'read' ? ['-w'] : [])]];
      if (result.status === 44) return null;
      if (!result.ok) return unavailable();
      if (action === 'delete') return;
      const encoded = result.output.trim();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return unavailable();
      return Buffer.from(encoded, 'base64').toString('utf8');
    }
    if (platform === 'linux') {
      const result = yield ['secret-tool', action === 'write' ? ['store', `--label=Touba ${purpose}`, 'service', SERVICE, 'account', key]
        : [action === 'read' ? 'lookup' : 'clear', 'service', SERVICE, 'account', key], action === 'write' ? value : undefined];
      if (result.status === 1 && action !== 'write' && !result.output) return null;
      if (!result.ok) return unavailable();
      return action === 'read' ? result.output.trimEnd() : undefined;
    }
    if (platform === 'win32') {
      // Credential Manager bounds a blob to 2560 bytes. Store only the refresh
      // credential (no access/ID token); larger provider grants fail closed.
      const payload = JSON.stringify({ action, key, value }).replaceAll("'", "\\u0027");
      const result = yield ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], windows.replace('__PAYLOAD__', payload).replace('__SERVICE__', SERVICE)];
      if (result.status === 3) return null;
      if (!result.ok) return unavailable();
      return action === 'read' ? result.output.trimEnd() : undefined;
    }
    return unavailable();
  }
  function sync(...args) {
    const iterator = call(...args); let step = iterator.next();
    while (!step.done) step = iterator.next(run(...step.value));
    return step.value;
  }
  async function asyncCall(...args) {
    const iterator = call(...args); let step = iterator.next();
    while (!step.done) step = iterator.next(await run(...step.value));
    return step.value;
  }
  const resolve = asynchronous ? asyncCall : sync;
  return { read: key => resolve('read', key), write: (key, value) => resolve('write', key, value), remove: key => resolve('delete', key) };
}

export const registryVault = options => systemVault({ ...options, purpose: 'registry' });
