param([string]$Executable = (Join-Path $PSScriptRoot 'bin/ZCodeWallpaperHost.exe'))
$ErrorActionPreference = 'Stop'
$script:checks = 0
function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:checks++
}
function Start-Helper {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    # .NET Framework inherits this encoding for the redirected stdin writer.
    # Match the production Node bridge: UTF-8 JSON lines without a BOM.
    $originalEncoding = [Console]::InputEncoding
    try {
        [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
        return [Diagnostics.Process]::Start($info)
    } finally {
        [Console]::InputEncoding = $originalEncoding
    }
}
function Read-Message($Process, [string]$Context = 'protocol response', [int]$TimeoutMs = 5000) {
    $read = $Process.StandardOutput.ReadLineAsync()
    if (-not $read.Wait($TimeoutMs)) { throw "Helper timed out waiting for $Context after $TimeoutMs ms (exited: $($Process.HasExited))" }
    if ($null -eq $read.Result) { throw ('Helper closed stdout: ' + $Process.StandardError.ReadToEnd()) }
    return ($read.Result | ConvertFrom-Json)
}
function Request($Process, [string]$Line, $Id) {
    $Process.StandardInput.WriteLine($Line)
    $Process.StandardInput.Flush()
    for ($n = 0; $n -lt 20; $n++) {
        $reply = Read-Message $Process "request id $Id"
        if ($null -ne $reply.PSObject.Properties['id'] -and $reply.id -eq $Id) { return $reply }
    }
    throw 'Missing matching response id'
}
$proc = Start-Helper
try {
    # A fresh Windows runner may need extra time to initialize .NET and WPF.
    # Keep request deadlines short once the startup greeting has arrived.
    $hello = Read-Message $proc 'startup greeting' 30000
    Assert-True ($hello.event -eq 'hello' -and $hello.protocol -eq 1) 'Missing protocol greeting'
    $reply = Request $proc '{"id":1,"command":"status"}' 1
    Assert-True ($reply.ok -and $reply.state -eq 'idle' -and $reply.runtimePid -eq 0) 'Unexpected initial state'
    $reply = Request $proc '{"id":9,"command":"capture-attached","captureHwnd":"12345"}' 9
    Assert-True (-not $reply.ok -and $reply.error -match 'No ready capture source') 'Idle helper accepted a capture handshake'
    foreach($fps in @('9','121','60.0','"60"','true','null')){
        $reply=Request $proc ('{"id":10,"command":"start","fps":'+$fps+'}') 10
        Assert-True (-not $reply.ok -and $reply.error -eq 'fps must be an integer from 10 to 120') ('Invalid FPS token reached runtime preparation: '+$fps)
    }
    Assert-True ((Request $proc '{"id":11,"command":"status"}' 11).fps -eq 60) 'Missing FPS did not keep backward-compatible 60 default'
    $reply = Request $proc '{"id":2,"command":"unknown"}' 2
    Assert-True (-not $reply.ok -and $reply.error -eq 'unknown command') 'Unknown command not rejected'
    $reply = Request $proc 'this is not json' $null
    Assert-True (-not $reply.ok) 'Invalid JSON not rejected'
    $reply = Request $proc '{"id":3,"command":"start","targetHwnd":"0","enginePath":"unused","projectPath":"unused","rect":{"x":0,"y":0,"width":640,"height":480}}' 3
    Assert-True (-not $reply.ok -and $reply.error -match 'targetHwnd') 'Invalid target not rejected before runtime preparation'
    $reply = Request $proc '{"id":4,"command":"layout","rect":{"x":-30,"y":-50,"width":640,"height":480},"visible":false}' 4
    Assert-True ($reply.ok -and -not $reply.visible -and $reply.rect.x -eq -30) 'Valid physical rectangle not accepted'
    $reply = Request $proc '{"id":5,"command":"layout","rect":{"x":0,"y":0,"width":0,"height":480}}' 5
    Assert-True (-not $reply.ok) 'Invalid dimensions not rejected'
    $reply = Request $proc '{"id":6,"command":"layout","rect":{"x":0,"y":0,"width":640,"height":480},"visible":"false"}' 6
    Assert-True (-not $reply.ok) 'Nonboolean visibility not rejected'
    $reply = Request $proc '{"id":7,"command":"stop"}' 7
    Assert-True ($reply.ok -and $reply.state -eq 'idle') 'Idle stop was not idempotent'
    $reply = Request $proc '{"id":8,"command":"shutdown"}' 8
    Assert-True $reply.ok 'Shutdown not acknowledged'
    Assert-True ($proc.WaitForExit(5000) -and $proc.ExitCode -eq 0) 'Shutdown failed to exit cleanly'
} finally {
    if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit() }
    $proc.Dispose()
}
$proc = Start-Helper
try {
    [void](Read-Message $proc 'EOF-test startup greeting' 30000)
    $proc.StandardInput.Close()
    Assert-True ($proc.WaitForExit(5000) -and $proc.ExitCode -eq 0) 'Stdin EOF failed to exit cleanly'
} finally {
    if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit() }
    $proc.Dispose()
}
[ordered]@{ passed = $script:checks; failed = 0; realWallpaperEngineStarted = $false; scope = 'Protocol validation, idle lifecycle, EOF; excludes live rendering' } | ConvertTo-Json
