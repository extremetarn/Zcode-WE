param([switch]$IncludeWindowFixtures)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
foreach ($taskTest in @('test-protocol.ps1', 'test-project-types.ps1', 'test-fps.ps1')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskRoot "native\$taskTest")
    if ($LASTEXITCODE -ne 0) { throw "Failed: $taskTest" }
}
if ($IncludeWindowFixtures) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskRoot 'native\test-runtime.ps1') -CaptureFixture
    if ($LASTEXITCODE -ne 0) { throw 'Scene capture fixture failed' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskRoot 'native\test-runtime.ps1') -CaptureFixture -VideoFixture
    if ($LASTEXITCODE -ne 0) { throw 'Video capture fixture failed' }
}
