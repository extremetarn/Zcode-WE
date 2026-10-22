param([string]$Executable=(Join-Path $PSScriptRoot 'bin/ZCodeWallpaperHost.exe'))
$ErrorActionPreference='Stop'
$workspace=Join-Path $PSScriptRoot ('.test-types-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($workspace)
$assembly=[Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$runtimeType=$assembly.GetType('WallpaperIndependentRuntime',$true)
$binding=[Reflection.BindingFlags]'Instance,NonPublic'
$writer=$runtimeType.GetMethod('WriteConfiguration',$binding)
$checks=0
try {
 foreach($kind in @('scene','Scene',' SCENE ','video','Video',' VIDEO ','web','Web',' WEB ','application','', $null)){
  $folder=Join-Path $workspace ([Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($folder)
  $normalized=([string]$kind).Trim().ToLowerInvariant()
  $content=switch($normalized){'video'{'clip.mp4'}'web'{'index.html'}default{'scene.pkg'}}
  [IO.File]::WriteAllText((Join-Path $folder $content),'metadata fixture only')
  # Scene metadata intentionally points at an absent scene.json: packed fallback
  # must work with the same mixed-case project type found in actual Workshop files.
  $declared=if($normalized -eq 'scene'){'scene.json'}else{$content}
  @{type=$kind;file=$declared}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'project.json') -Encoding UTF8
  $instance=[Activator]::CreateInstance($runtimeType,$true)
  foreach($entry in @{Workspace=$folder;SelectedProject=(Join-Path $folder 'project.json');SourceExecutable=(Join-Path $workspace 'fixture.exe')}.GetEnumerator()){$runtimeType.GetField($entry.Key,$binding).SetValue($instance,$entry.Value)}
  $accepted=$normalized -in 'scene','video','web'
  $failure=$null
  try{$writer.Invoke($instance,@($null))|Out-Null}catch{$failure=$_.Exception.InnerException}
  if($accepted){
   if($null -ne $failure){throw "Type '$kind' failed: $($failure.Message)"};$checks++
   $config=Get-Content -LiteralPath (Join-Path $folder 'config.json') -Raw|ConvertFrom-Json
   $selected=$config.($env:USERNAME).general.wallpaperconfigscreensaver.selectedwallpapers.Monitor0.file
   if($selected -ne (Join-Path $folder $content).Replace('\','/')){throw "Type '$kind' selected wrong content: $selected"};$checks++
   if($runtimeType.GetField('IsVideo',$binding).GetValue($instance) -ne ($normalized -eq 'video')){throw "Type '$kind' did not select video-class detection"};$checks++
   if($runtimeType.GetField('IsWeb',$binding).GetValue($instance) -ne ($normalized -eq 'web')){throw "Type '$kind' did not select web isolation guard"};$checks++
  }else{
   if($null -eq $failure){throw "Unsupported type '$kind' was accepted"};$checks++
  }
 }
 @{passed=$checks;failed=0;realWallpaperEngineStarted=$false;scope='Native project metadata: mixed-case and padded Scene/Video/Web, packed-scene fallback, renderer-kind flags, unsupported and empty types'}|ConvertTo-Json
}finally{
 $resolved=[IO.Path]::GetFullPath($workspace)
 if([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath($PSScriptRoot) -or [IO.Path]::GetFileName($resolved) -notmatch '^\.test-types-[a-f0-9]{32}$'){throw 'Unexpected test cleanup path'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
