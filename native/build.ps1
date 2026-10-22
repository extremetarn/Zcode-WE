param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'vbc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x 64-bit VB compiler was not found' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$json = & (Join-Path $PSScriptRoot 'restore-dependencies.ps1')
$response = @('/nologo', '/target:exe', '/platform:x64', '/optioninfer+', '/main:Program', ('/out:"' + (Join-Path $OutputDirectory 'ZCodeWallpaperHost.exe') + '"'), '/imports:System,System.IO,System.Linq,System.Collections.Generic,System.Diagnostics,System.Threading,System.Threading.Tasks,System.Windows', ('"' + (Join-Path $PSScriptRoot 'Program.vb') + '"'), ('"' + (Join-Path $PSScriptRoot 'WallpaperIndependentRuntime.vb') + '"'), ('/reference:"' + $json + '"'))
foreach ($reference in @('WPF/PresentationFramework.dll', 'WPF/PresentationCore.dll', 'WPF/WindowsBase.dll', 'System.Xaml.dll', 'System.Core.dll')) { $response += ('/reference:"' + (Join-Path $framework $reference) + '"') }
$responseFile = Join-Path $OutputDirectory 'compile.rsp'
[IO.File]::WriteAllLines($responseFile, $response, [Text.Encoding]::UTF8)
& $compiler "@$responseFile"
if ($LASTEXITCODE -ne 0) { throw 'Native helper compilation failed' }
Copy-Item -LiteralPath $json -Destination (Join-Path $OutputDirectory 'Newtonsoft.Json.dll') -Force
Write-Output (Join-Path $OutputDirectory 'ZCodeWallpaperHost.exe')
