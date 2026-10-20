$ErrorActionPreference = 'Stop'
$Version = '7.1.0'
$Sha256 = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
$Root = Join-Path $env:RUNNER_TEMP 'touba-inno-7.1.0'
$Download = Join-Path $env:RUNNER_TEMP 'innosetup-7.1.0-x64.exe'
if (Test-Path -LiteralPath $Root) { throw 'Inno builder directory already exists' }
Invoke-WebRequest -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' -OutFile $Download
if ((Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Inno Setup checksum mismatch' }
$Signature = Get-AuthenticodeSignature -LiteralPath $Download
if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch 'CN=Pyrsys B\.V\.') { throw 'Unexpected Inno Setup signature' }
$Process = Start-Process -FilePath $Download -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/PORTABLE=1', '/NOICONS', '/TASKS=""', "/DIR=`"$Root`"") -Wait -PassThru
if ($Process.ExitCode -ne 0) { throw "Inno Setup preparation failed: $($Process.ExitCode)" }
$Compiler = Join-Path $Root 'ISCC.exe'
if (!(Test-Path -LiteralPath $Compiler)) { throw 'Inno Setup compiler missing' }
$Reported = & $Compiler --version
if ($LASTEXITCODE -ne 0 -or $Reported -notmatch '7\.1\.0') { throw 'Unexpected Inno Setup compiler version' }
$env:TOUBA_ISCC = $Compiler
"TOUBA_ISCC=$Compiler" >> $env:GITHUB_ENV
Write-Output "Verified Inno Setup $Version, SHA-256 and publisher signature"
