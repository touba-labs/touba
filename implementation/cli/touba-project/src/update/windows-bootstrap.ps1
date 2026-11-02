param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..'))
$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('touba-update-' + [guid]::NewGuid().ToString('N'))
$ExitCode = 2
try {
    New-Item -ItemType Directory -Path $Temporary | Out-Null
    $Node = Join-Path $Temporary 'node.exe'
    Copy-Item -LiteralPath (Join-Path $Root 'bin\node.exe') -Destination $Node
    & $Node (Join-Path $Root 'lib\cli\touba-project\src\main.mjs') @Arguments
    $ExitCode = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Recurse -Force }
}
exit $ExitCode
