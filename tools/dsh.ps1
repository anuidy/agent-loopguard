# Invoke the installed desktop CLI with a project-local profile directory.
$loopguardRoot = Split-Path -Parent $PSScriptRoot
$loopguardCli = $env:DSH_LOOPGUARD_CLI
if (-not $loopguardCli) {
    $loopguardCli = Join-Path $env:USERPROFILE 'AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
}
if (-not (Test-Path -LiteralPath $loopguardCli -PathType Leaf)) {
    throw 'DSH CLI not found. Set DSH_LOOPGUARD_CLI to the installed dsh.cmd path.'
}
$loopguardHome = Join-Path $loopguardRoot '.runtime\dsh-home'
New-Item -ItemType Directory -Path $loopguardHome -Force | Out-Null
$loopguardPreviousHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
$loopguardExit = 0
try {
    $env:DSH_HOME = $loopguardHome
    & $loopguardCli @args
    $loopguardExit = $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable('DSH_HOME', $loopguardPreviousHome, 'Process')
}
exit $loopguardExit
