$ErrorActionPreference = 'Stop'
$taskRuntime = Join-Path $env:LOCALAPPDATA 'Programs\ZCodeNativeWallpaper'
$taskManifest = Join-Path $taskRuntime 'adapter-state.json'
if (-not (Test-Path -LiteralPath $taskManifest)) { throw '没有本版本的安装记录。' }
& node (Join-Path $taskRuntime 'adapter.cjs') restore --manifest $taskManifest
if ($LASTEXITCODE -ne 0) { throw '恢复被版本守卫阻止，请查看以上诊断。' }
Move-Item -LiteralPath $taskManifest -Destination (Join-Path $taskRuntime ('restored-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'))
Write-Output 'ZCode 原包已恢复。壁纸设置和源码保留；无需运行常驻服务。'
