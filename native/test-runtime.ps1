param([string]$Executable = (Join-Path $PSScriptRoot 'bin/ZCodeWallpaperHost.exe'), [switch]$VideoFixture, [switch]$CaptureFixture)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$work = Join-Path $PSScriptRoot ('.test-runtime-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$engineDir = Join-Path $work 'engine'
$projectDir = Join-Path $work 'project'
[void][IO.Directory]::CreateDirectory((Join-Path $engineDir 'bin'))
[void][IO.Directory]::CreateDirectory((Join-Path $engineDir 'assets'))
[void][IO.Directory]::CreateDirectory($projectDir)
[IO.File]::WriteAllText((Join-Path $engineDir 'assets/sentinel.txt'), 'original asset must survive')
[IO.File]::WriteAllText((Join-Path $projectDir 'project.json'), '{"type":"scene","file":"scene.pkg"}')
[IO.File]::WriteAllText((Join-Path $projectDir 'scene.pkg'), 'synthetic fixture, never a real wallpaper')
if($VideoFixture){
    [IO.File]::WriteAllText((Join-Path $projectDir 'project.json'), '{"type":"video","file":"synthetic.mp4"}')
    [IO.File]::WriteAllText((Join-Path $projectDir 'synthetic.mp4'), 'synthetic video fixture, not playable media')
}
$engine = Join-Path $engineDir 'fixture.exe'
$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class ZwnFixture {
  public delegate IntPtr WindowProc(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct WindowClass {
    public uint style; public WindowProc proc; public int cbCls,cbWnd; public IntPtr instance,icon,cursor,brush;
    public string menu,name;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int left,top,right,bottom;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern ushort RegisterClass(ref WindowClass wc);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr CreateWindowEx(uint ex,string cls,string name,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h,out uint color,out byte alpha,out uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  private static WindowProc procedure = DefWindowProc;
  [STAThread] public static void Main(string[] args) {
    if(args.Length==1 && args[0]=="--child") { Thread.Sleep(120000);return; }
    int index=Array.IndexOf(args,"-host");
    if(index<0)throw new ArgumentException("fixture requires host");
    IntPtr parent=new IntPtr(long.Parse(args[index+1]));
    var wc=new WindowClass {proc=procedure,name="WPEDesktopFixture"};RegisterClass(ref wc);
    IntPtr window=CreateWindowEx(0,wc.name,"synthetic preview",0x50000000,0,0,640,480,parent,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(window==IntPtr.Zero)throw new InvalidOperationException("fixture window failed");
    var child=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--child") {UseShellExecute=false,CreateNoWindow=true});
    File.WriteAllText("fixture-child.pid",child.Id.ToString());
    File.WriteAllText("fixture-host.txt",parent.ToInt64().ToString());
    Application.Run();
  }
}
'@
$sourceFile = Join-Path $work 'fixture.cs'
if($VideoFixture){$source=$source.Replace('WPEDesktopFixture','WPEVideoWallpaper')}
[IO.File]::WriteAllText($sourceFile, $source)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll "/out:$engine" $sourceFile
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms
$previousDpi = [ZwnFixture]::SetThreadDpiAwarenessContext([IntPtr](-4))
$script:checks = 0
$script:completed = $false
$script:sequence = 0
$script:helpers = @()
function Assert-True($Value, [string]$Message) { if(-not $Value){throw $Message};$script:checks++ }
function Start-Helper {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($info)
    $script:helpers += $p
    [void](Read-Message $p)
    return $p
}
function Read-Message($Process) {
    $read=$Process.StandardOutput.ReadLineAsync()
    if(-not $read.Wait(5000)){throw 'Fixture helper response timed out'}
    if($null -eq $read.Result){throw ('Helper closed stdout: '+$Process.StandardError.ReadToEnd())}
    return ($read.Result | ConvertFrom-Json)
}
function Request($Process,[string]$Command,$Fields=@{},[bool]$AllowFailure=$false) {
    $script:sequence++
    $Fields.id=$script:sequence;$Fields.command=$Command
    $Process.StandardInput.WriteLine(($Fields | ConvertTo-Json -Depth 8 -Compress))
    $Process.StandardInput.Flush()
    do {$reply=Read-Message $Process} while($reply.id -ne $script:sequence)
    if(-not $reply.ok -and -not $AllowFailure){throw $reply.error}
    return $reply
}
function Pause([int]$Milliseconds) {
    $until=[DateTime]::UtcNow.AddMilliseconds($Milliseconds)
    do {[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 10} while([DateTime]::UtcNow -lt $until)
}
function Wait-Ready($Process,$PreviousPid=0) {
    for($n=0;$n -lt 100;$n++) {
        $s=Request $Process 'status'
        if($s.state -eq 'error'){throw $s.error}
        if($s.state -eq 'ready' -and $s.runtimePid -ne $PreviousPid){return $s}
        Pause 50
    }
    throw 'Synthetic preview did not become ready'
}
function Start-Preview($Process,$Target) {
    return Request $Process 'start' @{presentation=$(if($CaptureFixture){'capture'}else{'overlay'});targetHwnd=$Target.Handle.ToInt64().ToString();enginePath=$engine;projectPath=(Join-Path $projectDir 'project.json');rect=@{x=80;y=90;width=640;height=480};values=@{}}
}
function Runtime-Info($Status) {
    $folder=[IO.Path]::GetDirectoryName((Get-Process -Id $Status.runtimePid).MainModule.FileName)
    for($n=0;$n -lt 50 -and -not (Test-Path -LiteralPath (Join-Path $folder 'fixture-child.pid'));$n++){Pause 20}
    return @{folder=$folder;pid=$Status.runtimePid;child=[int][IO.File]::ReadAllText((Join-Path $folder 'fixture-child.pid'));hwnd=[IntPtr][long][IO.File]::ReadAllText((Join-Path $folder 'fixture-host.txt'))}
}
function Is-Running([int]$ProcessId){return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)}
function Assert-Stopped($Info) {
    for($n=0;$n -lt 100 -and ((Is-Running $Info.pid) -or (Is-Running $Info.child));$n++){Pause 30}
    Assert-True (-not (Is-Running $Info.pid) -and -not (Is-Running $Info.child)) 'Owned process tree survived cleanup'
}
function Runtime-Directories {
    $root=Join-Path $engineDir '.zcode-native-wallpaper-runtime'
    if(Test-Path -LiteralPath $root){return @(Get-ChildItem -LiteralPath $root -Directory)}
    return @()
}
$target=New-Object Windows.Forms.Form
$target.Text='ZCode wallpaper synthetic lifecycle test'
$target.SetBounds(80,90,640,480)
$target.ShowInTaskbar=$false
$target.Show()
try {
    $proc=Start-Helper
    [void](Start-Preview $proc $target)
    $ready=Wait-Ready $proc
    $first=Runtime-Info $ready
    Pause 150
    Assert-True ([ZwnFixture]::IsWindowVisible($first.hwnd)) 'Preview holder was not shown'
    if($CaptureFixture){
        Assert-True ($ready.captureHwnd -eq $first.hwnd.ToInt64().ToString()) 'Capture HWND did not identify the owned holder'
        $color=[uint32]0;$alpha=[byte]255;$flags=[uint32]0
        Assert-True ([ZwnFixture]::GetLayeredWindowAttributes($first.hwnd,[ref]$color,[ref]$alpha,[ref]$flags) -and $alpha -eq 0 -and ($flags -band 2) -ne 0) 'Capture source was not alpha zero'
        $bounds=New-Object ZwnFixture+Rect
        [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$bounds)
        Assert-True ($bounds.left -eq 0 -and $bounds.top -eq 0 -and $bounds.right -eq 640 -and $bounds.bottom -eq 480) 'Capture source did not start at fixed on-screen bounds'
        Assert-True (-not $ready.captureParked) 'Capture source parked before its first-frame handshake'
        $missing=Request $proc 'capture-attached' @{} $true
        Assert-True (-not $missing.ok) 'Capture handshake accepted a missing HWND'
        $stale=Request $proc 'capture-attached' @{captureHwnd=($first.hwnd.ToInt64()+1).ToString()} $true
        Assert-True (-not $stale.ok) 'Capture handshake accepted a stale HWND'
        $attached=Request $proc 'capture-attached' @{captureHwnd=$ready.captureHwnd}
        Assert-True ($attached.captureParked -and $attached.runtimePid -eq $first.pid) 'First-frame handshake did not park current source without restarting'
        $again=Request $proc 'capture-attached' @{captureHwnd=$ready.captureHwnd}
        Assert-True ($again.captureParked -and $again.runtimePid -eq $first.pid) 'Capture handshake was not idempotent'
        [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$bounds)
        $parkX=$bounds.left;$parkY=$bounds.top
        Assert-True ($bounds.right -lt [ZwnFixture]::GetSystemMetrics(76) -and $bounds.bottom -lt [ZwnFixture]::GetSystemMetrics(77)) 'Capture source overlaps the virtual desktop after first frame'
        [void][ZwnFixture]::SetWindowPos($first.hwnd,[IntPtr]::Zero,20,20,0,0,0x15);Pause 250
        [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$bounds)
        Assert-True ($bounds.left -eq $parkX -and $bounds.top -eq $parkY) 'Capture source drift was not restored outside the desktop'
        $target.SetBounds(300,250,900,650)
        [void](Request $proc 'layout' @{rect=@{x=301;y=251;width=901;height=649};visible=$true});Pause 450
        Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Capture source restarted after client move or resize'
        [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$bounds)
        Assert-True ($bounds.left -eq $parkX -and $bounds.top -eq $parkY -and ($bounds.right-$bounds.left) -eq 640 -and ($bounds.bottom-$bounds.top) -eq 480) 'Capture source followed client movement or resize'
        $target.WindowState=[Windows.Forms.FormWindowState]::Minimized;Pause 250
        Assert-True ([ZwnFixture]::IsWindowVisible($first.hwnd)) 'Minimize interrupted capture source'
        $target.WindowState=[Windows.Forms.FormWindowState]::Normal;$target.Hide();Pause 250
        Assert-True ([ZwnFixture]::IsWindowVisible($first.hwnd)) 'Hidden target interrupted capture source'
        [void](Request $proc 'layout' @{rect=@{x=-32000;y=-32000;width=1;height=1};visible=$false});Pause 150
        Assert-True ([ZwnFixture]::IsWindowVisible($first.hwnd)) 'Explicit presentation hide interrupted capture source'
        Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Visibility changed capture process'
        Assert-True ([ZwnFixture]::GetLayeredWindowAttributes($first.hwnd,[ref]$color,[ref]$alpha,[ref]$flags) -and $alpha -eq 0) 'Capture source lost alpha zero during lifecycle changes'
        $target.Show();[void](Request $proc 'layout' @{rect=@{x=300;y=250;width=900;height=650};visible=$true})
        $second=$first
    } else {
    # DPI conversions can fluctuate by one pixel even though the real HWND size
    # is unchanged. Such IPC hints must never reset the renderer playback.
    foreach($delta in @(1,-1,0)) {
        [void](Request $proc 'layout' @{rect=@{x=80;y=90;width=(640+$delta);height=(480-$delta)};visible=$true})
        Pause 450
        Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Rounded IPC bounds restarted a constant-size native window'
    }
    # No layout messages: the helper must follow native movement independently
    # while Electron's main thread is in Windows' modal window-move loop.
    $target.SetBounds(135,145,640,480)
    Pause 90
    $follow=New-Object ZwnFixture+Rect
    [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$follow)
    Assert-True ($follow.left -eq 135 -and $follow.top -eq 145) 'Native movement without IPC did not reach holder'
    Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Native movement without IPC restarted renderer'
    $target.Hide();Pause 250
    Assert-True (-not [ZwnFixture]::IsWindowVisible($first.hwnd)) 'Hidden target left preview visible'
    $target.Show();Pause 250
    Assert-True ([ZwnFixture]::IsWindowVisible($first.hwnd)) 'Show failed to restore holder'
    $target.WindowState=[Windows.Forms.FormWindowState]::Minimized;Pause 250
    Assert-True (-not [ZwnFixture]::IsWindowVisible($first.hwnd)) 'Minimized target left preview visible'
    $target.WindowState=[Windows.Forms.FormWindowState]::Normal;Pause 250
    [void](Request $proc 'layout' @{rect=@{x=-25;y=70;width=640;height=480};visible=$false});Pause 150
    Assert-True (-not [ZwnFixture]::IsWindowVisible($first.hwnd)) 'Explicit hide left preview visible'
    $target.SetBounds(100,110,640,480)
    [void](Request $proc 'layout' @{rect=@{x=100;y=110;width=640;height=480};visible=$true});Pause 150
    $actual=New-Object ZwnFixture+Rect
    [void][ZwnFixture]::GetWindowRect($first.hwnd,[ref]$actual)
    Assert-True ($actual.left -eq 100 -and $actual.top -eq 110) ('Move coordinates did not reach holder: ' + $actual.left + ',' + $actual.top)
    Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Position-only layout restarted renderer'
    $target.SetBounds(100,110,700,500)
    [void](Request $proc 'layout' @{rect=@{x=100;y=110;width=700;height=500};visible=$true});Pause 100
    $target.SetBounds(100,110,720,520)
    [void](Request $proc 'layout' @{rect=@{x=100;y=110;width=720;height=520};visible=$true});Pause 100
    Assert-True ((Request $proc 'status').runtimePid -eq $first.pid) 'Resize debounce restarted renderer too soon'
    $ready=Wait-Ready $proc $first.pid
    $second=Runtime-Info $ready
    Assert-True ($ready.rect.width -eq 720 -and $ready.rect.height -eq 520) 'Resize lost latest dimensions'
    Assert-Stopped $first
    Assert-True (-not (Test-Path -LiteralPath $first.folder)) 'Replaced workspace was not removed'
    # Real one-pixel resizes must still be honored. Ignore inaccurate IPC, not
    # small native changes; no layout command is needed to detect this resize.
    $target.SetBounds(100,110,721,520)
    $ready=Wait-Ready $proc $second.pid
    $onePixel=Runtime-Info $ready
    Assert-True ($ready.rect.width -eq 721 -and $ready.rect.height -eq 520) 'Real one-pixel native resize was ignored'
    Assert-Stopped $second
    Assert-True (-not (Test-Path -LiteralPath $second.folder)) 'One-pixel resize left old workspace behind'
    $second=$onePixel
    }
    [void](Request $proc 'stop')
    Assert-Stopped $second
    Assert-True (@(Runtime-Directories).Count -eq 0) 'Stop left workspace behind'
    if($CaptureFixture){
        $stopped=Request $proc 'capture-attached' @{captureHwnd=$first.hwnd.ToInt64().ToString()} $true
        Assert-True (-not $stopped.ok) 'Stopped capture source accepted its old handshake'
    }
    # Back-to-back start/stop supersedes asynchronous preparation.
    [void](Start-Preview $proc $target)
    [void](Request $proc 'stop')
    Pause 350
    Assert-True ((Request $proc 'status').state -eq 'idle') 'Cancelled preparation became active later'
    Assert-True (@(Runtime-Directories).Count -eq 0) 'Cancelled preparation leaked workspace'
    [void](Start-Preview $proc $target)
    $target.SetBounds(80,90,730,530)
    [void](Request $proc 'start' @{presentation=$(if($CaptureFixture){'capture'}else{'overlay'});targetHwnd=$target.Handle.ToInt64().ToString();enginePath=$engine;projectPath=(Join-Path $projectDir 'project.json');rect=@{x=80;y=90;width=730;height=530};values=@{}})
    $ready=Wait-Ready $proc;$replacement=Runtime-Info $ready
    if($CaptureFixture){Assert-True (-not $ready.captureParked) 'New capture source reused the previous handshake state'}
    Assert-True ($ready.rect.width -eq 730 -and $ready.rect.height -eq 530) 'Superseded start replaced the newest request'
    Pause 350
    Assert-True (@(Runtime-Directories).Count -eq 1) 'Superseded start left an extra workspace'
    [void](Request $proc 'stop')
    Assert-Stopped $replacement
    Assert-True (@(Runtime-Directories).Count -eq 0) 'Replacement stop left workspace behind'
    [void](Start-Preview $proc $target)
    $ready=Wait-Ready $proc;$third=Runtime-Info $ready
    $proc.StandardInput.Close()
    Assert-True ($proc.WaitForExit(5000)) 'EOF did not stop active helper'
    Assert-Stopped $third
    Assert-True (-not (Test-Path -LiteralPath $third.folder)) 'EOF left workspace behind'
    $proc=Start-Helper
    [void](Start-Preview $proc $target)
    $ready=Wait-Ready $proc;$fourth=Runtime-Info $ready
    $proc.Kill();[void]$proc.WaitForExit(5000)
    Assert-Stopped $fourth
    $proc=Start-Helper
    [void](Start-Preview $proc $target)
    $ready=Wait-Ready $proc;$fifth=Runtime-Info $ready
    Assert-True (-not (Test-Path -LiteralPath $fourth.folder)) 'Next preparation did not reclaim abandoned workspace'
    $target.Close()
    Assert-True ($proc.WaitForExit(5000)) 'Target close did not stop helper'
    Assert-Stopped $fifth
    Assert-True (@(Runtime-Directories).Count -eq 0) 'Target close left workspace behind'
    Assert-True ([IO.File]::ReadAllText((Join-Path $engineDir 'assets/sentinel.txt')) -eq 'original asset must survive') 'Cleanup followed resource junction'
    $script:completed=$true
    [ordered]@{passed=$script:checks;failed=0;realWallpaperEngineStarted=$false;fixtureType=$(if($VideoFixture){'video'}else{'scene'});presentation=$(if($CaptureFixture){'capture'}else{'overlay'});scope='Synthetic Win32 preview: presentation geometry and visibility, lifecycle, cancellation, EOF, target closure, kill-on-close job and junction-safe cleanup'} | ConvertTo-Json
} finally {
    foreach($p in $script:helpers){if(-not $p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)};$p.Dispose()}
    if(-not $target.IsDisposed){$target.Close()};$target.Dispose()
    [void][ZwnFixture]::SetThreadDpiAwarenessContext($previousDpi)
    # Leave failed fixtures for inspection; remove only successful, fully drained test trees.
    if($script:completed -and @(Runtime-Directories).Count -eq 0) {Remove-Item -LiteralPath $work -Recurse -Force}
}
