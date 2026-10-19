# Native qualification only, on a disposable Windows CI runner. No elevation
# in the tested host, no global sandbox/firewall policy changes, no secrets.
$ErrorActionPreference = 'Stop'
$source = Split-Path (Split-Path $PSScriptRoot)
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$account = "ToubaQ$suffix"
$root = "C:\ToubaQualification-$suffix"
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + '!aA9') -AsPlainText -Force
$credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
$created = $false
try {
    $user = New-LocalUser -Name $account -Password $password -Description 'Disposable Touba native qualification'
    $created = $true
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
    New-Item -ItemType Directory -Path "$root\implementation\runtime\touba-runtime", "$root\implementation\contracts", "$root\tools", "$root\temp", "$root\localdata" -Force | Out-Null
    Copy-Item "$source\runtime\touba-runtime\src" "$root\implementation\runtime\touba-runtime\src" -Recurse
    foreach ($sdk in @('touba-handler-sdk', 'touba-python-sdk')) {
        New-Item -ItemType Directory "$root\implementation\runtime\$sdk" | Out-Null
        Copy-Item "$source\runtime\$sdk\src" "$root\implementation\runtime\$sdk\src" -Recurse
    }
    New-Item -ItemType Directory "$root\implementation\runtime\touba-runtime\test" | Out-Null
    Copy-Item "$source\runtime\touba-runtime\test\windows-handler-sandbox-native.test.mjs" "$root\implementation\runtime\touba-runtime\test"
    Copy-Item "$source\contracts\machine" "$root\implementation\contracts\machine" -Recurse
    Copy-Item "$source\target\debug\touba-sandbox.exe" "$root\tools\touba-sandbox.exe"
    Copy-Item (Get-Command node).Source "$root\tools\node.exe"
    $python = (Get-Command python).Source.Replace("'", "''")
    $script = @"
`$ErrorActionPreference = 'Stop'
`$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
`$principal = [Security.Principal.WindowsPrincipal]::new(`$identity)
if (`$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Qualification host must not be administrator' }
Write-Output 'HOST standard-user, administrator=false'
`$env:TEMP = '$root\temp'; `$env:TMP = '$root\temp'; `$env:LOCALAPPDATA = '$root\localdata'
`$env:TOUBA_TEST_SANDBOX_LAUNCHER = '$root\tools\touba-sandbox.exe'
`$env:TOUBA_TEST_PYTHON = '$python'
& '$root\tools\node.exe' --test --test-concurrency=1 '$root\implementation\runtime\touba-runtime\test\windows-handler-sandbox-native.test.mjs'
exit `$LASTEXITCODE
"@
    Set-Content -LiteralPath "$root\run.ps1" -Value $script -Encoding utf8
    # Exclusively new qualification files; never the checkout or system Python.
    $sid = $user.SID.Value
    & icacls.exe $root /grant:r "${account}:(OI)(CI)F" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL setup failed' }
    & icacls.exe $root /setowner "*$sid" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture ownership setup failed' }
    $hostProcess = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"$root\run.ps1") -RedirectStandardOutput "$root\stdout.log" -RedirectStandardError "$root\stderr.log" -PassThru
    if (-not $hostProcess.WaitForExit(120000)) { $hostProcess.Kill(); throw 'Standard-user qualification timeout' }
    Get-Content "$root\stdout.log"
    Get-Content "$root\stderr.log"
    if ($hostProcess.ExitCode -ne 0) { throw "Standard-user qualification failed: $($hostProcess.ExitCode)" }
} finally {
    if ($created) { Remove-LocalUser -Name $account }
    # Disposable runner teardown removes the isolated fixture and user profile.
}
