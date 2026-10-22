param([string]$ZCodeDirectory = "$env:LOCALAPPDATA\Programs\ZCode")
$ErrorActionPreference = 'Stop'
$taskExe = Join-Path $ZCodeDirectory 'ZCode.exe'
$taskArchive = Join-Path $ZCodeDirectory 'resources\app.asar'
if (-not (Test-Path -LiteralPath $taskExe)) { throw '未找到 ZCode.exe。' }
if (Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $taskExe }) { throw '请先正常退出 ZCode，再安装。' }
$taskRuntime = Join-Path $env:LOCALAPPDATA 'Programs\ZCodeNativeWallpaper'
$taskManifest = Join-Path $taskRuntime 'adapter-state.json'
if (Test-Path -LiteralPath $taskManifest) { throw '已有适配记录，请先运行 uninstall.ps1 恢复再安装。' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'native\bin\ZCodeWallpaperHost.exe'))) { & (Join-Path $PSScriptRoot 'native\build.ps1') }
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
foreach ($taskName in @('bridge.cjs','background.cjs','appearance.cjs','library.cjs','native-client.cjs','settings.html','settings-preload.cjs','adapter.cjs','README.md','THIRD-PARTY-NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $taskName) -Destination (Join-Path $taskRuntime $taskName) -Force
}
New-Item -ItemType Directory -Path (Join-Path $taskRuntime 'native\bin'),(Join-Path $taskRuntime 'test') -Force | Out-Null
foreach ($taskName in @('ZCodeWallpaperHost.exe','Newtonsoft.Json.dll')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "native\bin\$taskName") -Destination (Join-Path $taskRuntime "native\bin\$taskName") -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test\live-probe.cjs') -Destination (Join-Path $taskRuntime 'test\live-probe.cjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test\capture-window.ps1') -Destination (Join-Path $taskRuntime 'test\capture-window.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test\motion-probe.cjs') -Destination (Join-Path $taskRuntime 'test\motion-probe.cjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test\cursor-probe.cjs') -Destination (Join-Path $taskRuntime 'test\cursor-probe.cjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test\fps-probe.cjs') -Destination (Join-Path $taskRuntime 'test\fps-probe.cjs') -Force
$taskStage = Join-Path $taskRuntime ('prepared-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& node (Join-Path $taskRuntime 'adapter.cjs') prepare --source $taskArchive --bridge (Join-Path $taskRuntime 'bridge.cjs') --out $taskStage
if ($LASTEXITCODE -ne 0) { throw '版本检查或适配准备失败，ZCode 文件未替换。' }
& node (Join-Path $taskRuntime 'adapter.cjs') apply --manifest (Join-Path $taskStage 'manifest.json')
if ($LASTEXITCODE -ne 0) { throw '安装失败，请查看以上诊断。' }
Copy-Item -LiteralPath (Join-Path $taskStage 'manifest.json') -Destination $taskManifest
$taskFiles = @('bridge.cjs','background.cjs','appearance.cjs','library.cjs','native-client.cjs','settings.html','settings-preload.cjs','adapter.cjs','README.md','THIRD-PARTY-NOTICES.md','native\bin\ZCodeWallpaperHost.exe','native\bin\Newtonsoft.Json.dll')
$taskRevision = [ordered]@{ updatedAt = [DateTime]::UtcNow.ToString('o'); files = @($taskFiles | ForEach-Object { [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $taskRuntime $_) -Algorithm SHA256).Hash } }) }
$taskRevision | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskRuntime 'runtime-files.json') -Encoding UTF8
Write-Output "已安装。正常启动 ZCode，点击右下角壁纸按钮。恢复记录：$taskManifest"
