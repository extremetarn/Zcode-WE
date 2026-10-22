param([Parameter(Mandatory=$true)][long]$WindowHandle,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ZwnScreenCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
}
'@
[ZwnScreenCapture]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$taskRectangle=[ZwnScreenCapture+RECT]::new()
if (-not [ZwnScreenCapture]::GetWindowRect([IntPtr]$WindowHandle,[ref]$taskRectangle)) { throw 'Window is unavailable' }
Add-Type -AssemblyName System.Drawing
$taskImage=[System.Drawing.Bitmap]::new(($taskRectangle.Right-$taskRectangle.Left),($taskRectangle.Bottom-$taskRectangle.Top))
$taskGraphics=[System.Drawing.Graphics]::FromImage($taskImage)
try { $taskGraphics.CopyFromScreen($taskRectangle.Left,$taskRectangle.Top,0,0,$taskImage.Size); $taskImage.Save($OutputFile) }
finally { $taskGraphics.Dispose(); $taskImage.Dispose() }
