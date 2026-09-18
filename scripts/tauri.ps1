param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TauriArgs)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$localCargo = Join-Path $project 'work\toolchain\cargo'
if (Test-Path (Join-Path $localCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $project 'work\toolchain\rustup'
    $env:PATH = "$localCargo\bin;$env:PATH"
}
Push-Location $project
try {
    & npm.cmd run tauri -- @TauriArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
