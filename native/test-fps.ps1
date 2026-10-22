param([string]$Executable=(Join-Path $PSScriptRoot 'bin/ZCodeWallpaperHost.exe'))
$ErrorActionPreference='Stop'
$workspace=Join-Path $PSScriptRoot ('.test-fps-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($workspace)
$assembly=[Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$runtime=$assembly.GetType('WallpaperIndependentRuntime',$true)
$prepare=$runtime.GetMethod('Prepare',[Reflection.BindingFlags]'Public,Static')
$dispose=$runtime.GetMethod('Dispose',[Reflection.BindingFlags]'Public,Instance')
$fpsReader=$assembly.GetType('Program',$true).GetMethod('ReadFps',[Reflection.BindingFlags]'NonPublic,Static')
$json=[Reflection.Assembly]::LoadFrom((Join-Path (Split-Path $Executable) 'Newtonsoft.Json.dll'))
$jobject=$json.GetType('Newtonsoft.Json.Linq.JObject')
$parse=$jobject.GetMethod('Parse',[type[]]@([string]))
$checks=0
function Assert-True($value,$message){if(-not $value){throw $message};$script:checks++}
try {
 Assert-True ($prepare.GetParameters().Count -eq 5 -and $prepare.GetParameters()[4].DefaultValue -eq 60) 'Prepare lacks backward-compatible FPS parameter'
 Assert-True ($null -ne $fpsReader) 'Protocol FPS validation missing'
 $engineDir=Join-Path $workspace 'engine';$projectDir=Join-Path $workspace 'project'
 [void][IO.Directory]::CreateDirectory((Join-Path $engineDir 'assets'));[void][IO.Directory]::CreateDirectory((Join-Path $engineDir 'bin'));[void][IO.Directory]::CreateDirectory($projectDir)
 $engine=Join-Path $engineDir 'fixture.exe';[IO.File]::WriteAllText($engine,'Never executed; configuration preparation only')
 $desktop=@{};$desktop[$env:USERNAME]=@{general=@{user=@{fps=15;msaa='none'}}}
 $configPath=Join-Path $engineDir 'config.json';$desktop|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $configPath -Encoding UTF8
 $original=[IO.File]::ReadAllBytes($configPath)
 $project=Join-Path $projectDir 'project.json';[IO.File]::WriteAllText($project,'{"type":"Scene","file":"scene.pkg"}');[IO.File]::WriteAllText((Join-Path $projectDir 'scene.pkg'),'synthetic')
 foreach($fps in @(10,30,60,120)){
  $instance=$prepare.Invoke($null,@([string]$engine,[string]$project,$null,[Threading.CancellationToken]::None,[int]$fps))
  try{
   $owned=$runtime.GetField('Workspace',[Reflection.BindingFlags]'NonPublic,Instance').GetValue($instance)
   $config=Get-Content -LiteralPath (Join-Path $owned 'config.json') -Raw|ConvertFrom-Json
   Assert-True ($config.($env:USERNAME).general.user.fps -eq $fps) "Owned config did not override desktop FPS with $fps"
   Assert-True ($config.($env:USERNAME).general.user.msaa -eq 'none') 'Unrelated rendering preferences were lost'
  }finally{$dispose.Invoke($instance,@())|Out-Null}
 }
 foreach($fps in @(0,9,121,2147483647)){
  $failed=$false;try{$prepare.Invoke($null,@('missing.exe','missing-project.json',$null,[Threading.CancellationToken]::None,[int]$fps))|Out-Null}catch{$failed=$_.Exception.InnerException -is [ArgumentOutOfRangeException]}
  Assert-True $failed "Prepare did not reject invalid FPS $fps before touching files"
 }
 foreach($case in @(@{json='{}';value=60},@{json='{"fps":10}';value=10},@{json='{"fps":120}';value=120})){
  $request=$parse.Invoke($null,@([string]$case.json));Assert-True ($fpsReader.Invoke($null,(,$request)) -eq $case.value) 'Protocol FPS default or integer bounds failed'
 }
 foreach($raw in @('9','121','60.0','"60"','true','null')){
  $request=$parse.Invoke($null,@('{"fps":'+$raw+'}'));$failed=$false
  try{$fpsReader.Invoke($null,(,$request))|Out-Null}catch{$failed=$true}
  Assert-True $failed "Protocol accepted invalid FPS token $raw"
 }
 Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -eq [Convert]::ToBase64String($original)) 'Desktop config bytes were modified'
 Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $engineDir '.zcode-native-wallpaper-runtime') -Directory).Count -eq 0) 'FPS configuration tests leaked owned runtime directories'
 @{passed=$checks;failed=0;realWallpaperEngineStarted=$false;scope='FPS protocol types/default/bounds, Prepare bounds, actual private config override, desktop config byte preservation'}|ConvertTo-Json
}finally{
 $resolved=[IO.Path]::GetFullPath($workspace)
 if([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath($PSScriptRoot) -or [IO.Path]::GetFileName($resolved) -notmatch '^\.test-fps-[a-f0-9]{32}$'){throw 'Unexpected test cleanup path'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
