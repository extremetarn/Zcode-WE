' Independently developed Wallpaper Engine preview runtime for Zcode-WE.
' Owns isolated configuration, capture windows and child-process lifetime.
Imports System.ComponentModel
Imports System.Runtime.InteropServices
Imports System.Text
Imports System.Windows.Interop
Imports Microsoft.Win32.SafeHandles
Imports Newtonsoft.Json.Linq

'Uses the locally installed, unmodified engine. Never ships or edits its runtime/assets.
'Screensaver preview has its own event window, configuration and process lifetime.
Friend NotInheritable Class WallpaperIndependentRuntime
    Implements IDisposable

    Private Workspace As String
    Private WorkspaceParent As String
    Private StagedExecutable As String
    Private Holder As HwndSource
    Private CaptureHolder As IntPtr
    Private CaptureMode As Boolean
    Private CaptureParked As Boolean
    Private RenderFps As Integer = 60
    Private Shared ReadOnly CaptureProcedure As WindowProcedure = AddressOf DefWindowProc
    Private Shared CaptureClass As UShort
    Private Job As SafeFileHandle
    Private EngineProcess As Process
    Private Disposed As Boolean
    Private SuppressShow As Boolean
    Private WorkspaceLease As FileStream
    Private IsWeb As Boolean
    Private IsVideo As Boolean
    Public ReadOnly Property Width As Integer
        Get
            Return RenderWidth
        End Get
    End Property
    Public ReadOnly Property Height As Integer
        Get
            Return RenderHeight
        End Get
    End Property
    Private RenderWidth As Integer
    Private RenderHeight As Integer
    Private SourceExecutable As String
    Private SelectedProject As String
    Private InstanceName As String
    Public ReadOnly Property ExecutablePath As String
        Get
            Return SourceExecutable
        End Get
    End Property
    Public ReadOnly Property ProjectPath As String
        Get
            Return SelectedProject
        End Get
    End Property
    Public ReadOnly Property Location As String
        Get
            Return InstanceName
        End Get
    End Property
    Public ReadOnly Property ProcessId As Integer
        Get
            Return If(EngineProcess Is Nothing, 0, EngineProcess.Id)
        End Get
    End Property
    Public ReadOnly Property IsAlive As Boolean
        Get
            Try
                Return Not Disposed AndAlso EngineProcess IsNot Nothing AndAlso Not EngineProcess.HasExited
            Catch
                Return False
            End Try
        End Get
    End Property
    Public ReadOnly Property HostHandle As IntPtr
        Get
            Return If(CaptureHolder <> IntPtr.Zero, CaptureHolder, If(Holder Is Nothing, IntPtr.Zero, Holder.Handle))
        End Get
    End Property
    Public ReadOnly Property IsCaptureSource As Boolean
        Get
            Return CaptureMode
        End Get
    End Property
    Public ReadOnly Property IsCaptureParked As Boolean
        Get
            Return CaptureParked
        End Get
    End Property

    Public Sub CaptureAttached()
        If Not CaptureMode OrElse Disposed OrElse CaptureHolder = IntPtr.Zero Then Throw New InvalidOperationException("No active capture source")
        PositionCaptureOutsideDesktop()
        CaptureParked = True
    End Sub

    Public Sub MaintainCaptureParking()
        If CaptureParked Then PositionCaptureOutsideDesktop()
    End Sub

    Private Sub PositionCaptureOutsideDesktop()
        'Initialize capture on screen, then move the still-rendering source beyond
        'every monitor. Cursor capture cannot overlap this surface afterwards.
        Dim left = CLng(GetSystemMetrics(76))
        Dim top = CLng(GetSystemMetrics(77))
        If GetSystemMetrics(78) <= 0 OrElse GetSystemMetrics(79) <= 0 Then Throw New InvalidOperationException("Cannot determine virtual desktop bounds")
        Dim x = left - RenderWidth - 64L
        Dim y = top - RenderHeight - 64L
        If x < Integer.MinValue OrElse y < Integer.MinValue Then Throw New InvalidOperationException("Virtual desktop exceeds supported capture coordinates")
        Dim current As CaptureRect
        If Not GetWindowRect(CaptureHolder, current) Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot read capture source bounds")
        If current.Left = x AndAlso current.Top = y AndAlso current.Right - current.Left = RenderWidth AndAlso current.Bottom - current.Top = RenderHeight Then Return
        If Not SetWindowPos(CaptureHolder, IntPtr.Zero, CInt(x), CInt(y), RenderWidth, RenderHeight, &H14UI) Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot park capture source outside desktop")
    End Sub
    Public ReadOnly Property RenderHandle As IntPtr
        Get
            If Not IsAlive OrElse HostHandle = IntPtr.Zero Then Return IntPtr.Zero
            Dim found As IntPtr
            EnumChildWindows(HostHandle, Function(handle, unused)
                                            Dim pid As UInteger
                                            GetWindowThreadProcessId(handle, pid)
                                            Dim name As New StringBuilder(128)
                                            GetClassName(handle, name, name.Capacity)
                                            'Video previews use their own native class. Require both our
                                            'owned host ancestry and engine PID; never accept desktop windows.
                                            Dim expected = If(IsVideo,
                                                String.Equals(name.ToString(), "WPEVideoWallpaper", StringComparison.Ordinal),
                                                name.ToString().StartsWith("WPEDesktop", StringComparison.Ordinal))
                                            If pid = ProcessId AndAlso expected Then
                                                found = handle
                                                Return False
                                            End If
                                            Return True
                                        End Function, IntPtr.Zero)
            Return found
        End Get
    End Property

    Public Shared Function Prepare(executable As String, project As String, values As JObject, token As CancellationToken, Optional fps As Integer = 60) As WallpaperIndependentRuntime
        If fps < 10 OrElse fps > 120 Then Throw New ArgumentOutOfRangeException("fps", "fps must be an integer from 10 to 120")
        Dim result As New WallpaperIndependentRuntime With {.SourceExecutable = IO.Path.GetFullPath(executable), .SelectedProject = IO.Path.GetFullPath(project), .RenderFps = fps}
        Try
            token.ThrowIfCancellationRequested()
            Dim source = IO.Path.GetDirectoryName(result.ExecutablePath)
            If File.Exists(IO.Path.Combine(source, "zcode-native-wallpaper.marker")) Then Throw New InvalidOperationException("请使用 Steam 安装的 Wallpaper Engine。")
            'Keep immutable runtime links on the installation volume. A bin junction resolves back
            'to WE's original Chromium profile and can merge otherwise independent web instances.
            result.WorkspaceParent = IO.Path.Combine(source, ".zcode-native-wallpaper-runtime")
            CleanupAbandoned(result.WorkspaceParent, result.ExecutablePath)
            result.Workspace = IO.Path.Combine(result.WorkspaceParent, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(result.Workspace)
            result.WorkspaceLease = New FileStream(IO.Path.Combine(result.Workspace, "zcode-native-wallpaper.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read)
            Directory.CreateDirectory(IO.Path.Combine(result.Workspace, "ui", "wpcache"))
            File.WriteAllText(IO.Path.Combine(result.Workspace, "zcode-native-wallpaper.marker"), result.ExecutablePath)
            result.StagedExecutable = IO.Path.Combine(result.Workspace, IO.Path.GetFileName(executable))
            File.Copy(executable, result.StagedExecutable)
            For Each folder In {"assets", "locale", "plugins", "distribution"}
                token.ThrowIfCancellationRequested()
                Dim target = IO.Path.Combine(source, folder)
                If Directory.Exists(target) Then CreateJunction(IO.Path.Combine(result.Workspace, folder), target)
            Next
            Dim binSource = IO.Path.Combine(source, "bin")
            Dim binTarget = IO.Path.Combine(result.Workspace, "bin")
            Directory.CreateDirectory(binTarget)
            For Each binary In Directory.GetFiles(binSource)
                token.ThrowIfCancellationRequested()
                Dim extension = IO.Path.GetExtension(binary).ToLowerInvariant()
                If Not {".exe", ".dll", ".pak", ".dat", ".bin", ".json", ".scr"}.Contains(extension) AndAlso IO.Path.GetFileName(binary) <> "steam_appid.txt" Then Continue For
                If IO.Path.GetFileName(binary) = "playliststatetime.bin" OrElse IO.Path.GetFileName(binary) = "workshopcache.json" Then Continue For
                Dim destination = IO.Path.Combine(binTarget, IO.Path.GetFileName(binary))
                If Not CreateHardLink(destination, binary, IntPtr.Zero) Then File.Copy(binary, destination)
            Next
            For Each folder In Directory.GetDirectories(binSource)
                CreateJunction(IO.Path.Combine(binTarget, IO.Path.GetFileName(folder)), folder)
            Next
            If Not Directory.Exists(IO.Path.Combine(result.Workspace, "assets")) OrElse Not Directory.Exists(IO.Path.Combine(result.Workspace, "bin")) Then Throw New DirectoryNotFoundException("Wallpaper Engine 安装不完整，请在 Steam 中验证文件。")
            result.WriteConfiguration(values)
            token.ThrowIfCancellationRequested()
            Return result
        Catch
            result.Dispose()
            Throw
        End Try
    End Function

    Private Sub WriteConfiguration(values As JObject)
        Dim project = JObject.Parse(File.ReadAllText(ProjectPath))
        'Workshop projects use both "Scene" and "scene" (likewise Video/Web).
        'Normalize once so validation, packed-file fallback and renderer flags agree.
        Dim kind = If(CStr(project("type")), String.Empty).Trim().ToLowerInvariant()
        IsWeb = kind = "web"
        IsVideo = kind = "video"
        If Not {"scene", "web", "video"}.Contains(kind) Then Throw New InvalidOperationException("独立背景支持 Scene、网页和视频壁纸。")
        Dim content = IO.Path.Combine(IO.Path.GetDirectoryName(ProjectPath), CStr(project("file")))
        If kind = "scene" AndAlso Not File.Exists(content) Then content = IO.Path.Combine(IO.Path.GetDirectoryName(ProjectPath), "scene.pkg")
        If Not File.Exists(content) Then Throw New FileNotFoundException("找不到壁纸内容文件。", content)
        content = IO.Path.GetFullPath(content).Replace("\", "/")
        Dim options As New JObject
        Try
            Dim config = JObject.Parse(File.ReadAllText(IO.Path.Combine(IO.Path.GetDirectoryName(ExecutablePath), "config.json")))
            Dim user = TryCast(config(Environment.UserName), JObject)
            Dim original = If(user Is Nothing, Nothing, TryCast(user.SelectToken("general.user"), JObject))
            If original IsNot Nothing Then
                'Copy rendering preferences only. Never copy desktop selections, app rules or integrations.
                For Each key In {"fps", "msaa", "shadows", "volumetrics", "reflection", "resolution", "postprocessing", "preset", "videoframework", "videohardwareacceleration", "videoloopmode", "videoreadmode", "audioinputdevice", "audioinputvolume", "audioinputthreshold", "language", "steamlanguage"}
                    If original(key) IsNot Nothing Then options(key) = original(key).DeepClone()
                Next
            End If
        Catch
            'WE defaults remain available when its preferences are absent or currently being saved.
        End Try
        'Override only this isolated runtime's limit; never inherit the desktop's
        'possibly lower FPS or rewrite the user's desktop configuration.
        options("fps") = RenderFps
        options("autostart") = False
        options("hasshownwelcomedialog") = True
        options("overridewallpaper") = False
        options("overridelockscreen") = False
        options("adjustdwmcolormode") = "disabled"
        options("plugins") = New JObject
        options("apprules") = New JArray
        options("videoaudiooutput") = True
        For Each key In {"playbackfocus", "playbackfullscreen", "playbackmaximized", "playbackaudio"}
            options(key) = "run"
        Next
        Dim selection As New JObject
        Dim properties As New JObject
        For i = 0 To 15
            selection("Monitor" & i) = New JObject From {{"file", content}}
            properties("Monitor" & i) = If(values Is Nothing, New JObject, values.DeepClone())
        Next
        Dim general As New JObject From {
            {"user", options},
            {"wallpaperconfig", New JObject From {{"layout", 0}, {"selectedwallpapers", New JObject}}},
            {"wallpaperconfigscreensaver", New JObject From {{"layout", 0}, {"sameaswallpaper", False}, {"selectedwallpapers", selection}}}}
        Dim root As New JObject From {
            {"installdirectory", Workspace.Replace("\", "/")},
            {Environment.UserName, New JObject From {{"general", general}, {"wproperties", New JObject From {{content, properties}}}}}}
        File.WriteAllText(IO.Path.Combine(Workspace, "config.json"), root.ToString(), New UTF8Encoding(False))
    End Sub

    Public Sub Start(name As String, width As Integer, height As Integer, Optional capture As Boolean = False)
        If Disposed OrElse Holder IsNot Nothing OrElse CaptureHolder <> IntPtr.Zero Then Throw New InvalidOperationException("独立渲染实例状态无效。")
        If IsWeb AndAlso FindWindow("WPEEventWindowSC", Nothing) <> IntPtr.Zero Then Throw New InvalidOperationException("已有 Wallpaper Engine 屏保或其他独立背景实例在运行。请关闭它后再连接网页壁纸。")
        InstanceName = name
        RenderWidth = width
        RenderHeight = height
        CaptureMode = capture
        'The external child belongs only to this disposable holder, never to the launcher window.
        If CaptureMode Then
            If CaptureClass = 0 Then
                Dim definition As New NativeWindowClass With {.Procedure = CaptureProcedure, .Instance = GetModuleHandle(Nothing), .ClassName = "ZCodeWallpaperCaptureHost"}
                CaptureClass = RegisterClass(definition)
                If CaptureClass = 0 Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot register capture host")
            End If
            'A visible but alpha-zero surface remains capturable. WPF HwndSource
            'rewrites WS_EX_LAYERED, so use an owned plain Win32 window here.
            CaptureHolder = CreateWindowEx(&H80800A0UI, "ZCodeWallpaperCaptureHost", name, &H80000000UI, 0, 0, width, height, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(Nothing), IntPtr.Zero)
            If CaptureHolder = IntPtr.Zero Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot create capture host")
            If Not SetLayeredWindowAttributes(CaptureHolder, 0UI, 0, 2UI) Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot make capture host invisible")
            If Not SetWindowPos(CaptureHolder, New IntPtr(1), 0, 0, width, height, &H10UI Or &H40UI) Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "Cannot position capture host")
        Else
            Dim parameters As New HwndSourceParameters(name) With {
                .PositionX = -30000, .PositionY = -30000, .Width = width, .Height = height,
                .WindowStyle = &H90000000, .ExtendedWindowStyle = &H80000A0}
            Holder = New HwndSource(parameters)
            Holder.AddHook(AddressOf HolderMessage)
        End If
        Job = New SafeFileHandle(CreateJobObject(IntPtr.Zero, Nothing), True)
        If Job.IsInvalid Then Throw New Win32Exception(Marshal.GetLastWin32Error())
        Dim limits As New JobLimits
        limits.BasicLimitInformation.LimitFlags = &H2000UI 'KILL_ON_JOB_CLOSE
        Dim buffer = Marshal.AllocHGlobal(Marshal.SizeOf(limits))
        Try
            Marshal.StructureToPtr(limits, buffer, False)
            If Not SetInformationJobObject(Job, 9, buffer, CUInt(Marshal.SizeOf(limits))) Then Throw New Win32Exception(Marshal.GetLastWin32Error())
        Finally
            Marshal.FreeHGlobal(buffer)
        End Try
        Dim startup As New StartupInfo With {.cb = Marshal.SizeOf(GetType(StartupInfo)), .dwFlags = 1, .wShowWindow = 0}
        Dim processInfo As New NativeProcessInfo
        Dim command As New StringBuilder("""" & StagedExecutable & """ -screensaver -preview -host " & HostHandle.ToInt64().ToString(Globalization.CultureInfo.InvariantCulture))
        If Not CreateProcess(StagedExecutable, command, IntPtr.Zero, IntPtr.Zero, False, &H8000004UI, IntPtr.Zero, Workspace, startup, processInfo) Then Throw New Win32Exception(Marshal.GetLastWin32Error())
        Try
            'Assign before resuming so Chromium/render children inherit the job as well.
            If Not AssignProcessToJobObject(Job, processInfo.hProcess) Then Throw New Win32Exception(Marshal.GetLastWin32Error())
            EngineProcess = Process.GetProcessById(CInt(processInfo.dwProcessId))
            If ResumeThread(processInfo.hThread) = UInteger.MaxValue Then Throw New Win32Exception(Marshal.GetLastWin32Error())
        Catch
            TerminateProcess(processInfo.hProcess, 1UI)
            Throw
        Finally
            CloseHandle(processInfo.hThread)
            CloseHandle(processInfo.hProcess)
        End Try
    End Sub

    Public Sub SetVisible(value As Boolean)
        SuppressShow = Not value
        If Not value AndAlso HostHandle <> IntPtr.Zero Then
            SetWindowPos(HostHandle, IntPtr.Zero, -30000, -30000, 0, 0, &H95UI)
            ShowWindow(HostHandle, 0)
        End If
    End Sub

    Private Function HolderMessage(handle As IntPtr, message As Integer, wParam As IntPtr, lParam As IntPtr, ByRef handled As Boolean) As IntPtr
        'The preview engine can ask to show its parent. Keep the launcher's minimize policy authoritative.
        If SuppressShow AndAlso message = &H46 AndAlso lParam <> IntPtr.Zero Then
            Dim offset = IntPtr.Size * 2 + 16
            Dim flags = Marshal.ReadInt32(lParam, offset)
            Marshal.WriteInt32(lParam, offset, (flags And Not &H40) Or &H80)
        End If
        Return IntPtr.Zero
    End Function

    Public Sub Dispose() Implements IDisposable.Dispose
        If Disposed Then Return
        Disposed = True
        'Closing the only non-inheritable job handle also covers abrupt launcher termination.
        If Job IsNot Nothing Then Job.Dispose()
        If EngineProcess IsNot Nothing Then
            Try
                EngineProcess.WaitForExit(1500)
            Catch
            End Try
            EngineProcess.Dispose()
        End If
        If Holder IsNot Nothing Then Holder.Dispose()
        If CaptureHolder <> IntPtr.Zero Then DestroyWindow(CaptureHolder)
        If WorkspaceLease IsNot Nothing Then WorkspaceLease.Dispose()
        If Workspace IsNot Nothing Then
            Try
                DeleteWorkspaceAfterProcessExit(Workspace, WorkspaceParent)
            Catch
                'The next preparation reclaims marked, unlocked workspaces once drivers release them.
            End Try
        End If
    End Sub

    Private Shared Sub DeleteWorkspaceAfterProcessExit(path As String, expectedParent As String)
        'The root process can exit before its job children release the staged executable.
        'Retry only transient file-access failures, with a bounded 750 ms total delay.
        For attempt = 0 To 5
            Try
                SafeDeleteWorkspace(path, expectedParent)
                Return
            Catch ex As IOException
                If attempt = 5 Then Throw
            Catch ex As UnauthorizedAccessException
                If attempt = 5 Then Throw
            End Try
            Thread.Sleep(50 * (attempt + 1))
        Next
    End Sub

    Private Shared Sub CleanupAbandoned(parent As String, executable As String)
        If Not Directory.Exists(parent) Then Return
        For Each candidate In Directory.GetDirectories(parent)
            Try
                Dim marker = IO.Path.Combine(candidate, "zcode-native-wallpaper.marker")
                If (File.GetAttributes(candidate) And FileAttributes.ReparsePoint) <> 0 OrElse Not File.Exists(marker) OrElse Not String.Equals(File.ReadAllText(marker), executable, StringComparison.OrdinalIgnoreCase) Then Continue For
                Using lease As New FileStream(IO.Path.Combine(candidate, "zcode-native-wallpaper.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)
                    'An active owner holds this lock. A crashed owner also loses its kill-on-close job.
                End Using
                SafeDeleteWorkspace(candidate, parent)
            Catch
                'Active, unrelated, unreadable and still-draining workspaces are left intact.
            End Try
        Next
    End Sub

    Private Shared Sub SafeDeleteWorkspace(path As String, expectedParent As String)
        Dim full = IO.Path.GetFullPath(path)
        Dim parent = IO.Path.GetFullPath(expectedParent).TrimEnd(IO.Path.DirectorySeparatorChar)
        Dim id As Guid
        If IO.Path.GetFileName(parent) <> ".zcode-native-wallpaper-runtime" OrElse Not String.Equals(IO.Path.GetDirectoryName(full), parent, StringComparison.OrdinalIgnoreCase) OrElse Not Guid.TryParseExact(IO.Path.GetFileName(full), "N", id) Then Throw New InvalidOperationException("Invalid runtime cleanup path")
        If Not Directory.Exists(full) OrElse Not File.Exists(IO.Path.Combine(full, "zcode-native-wallpaper.marker")) Then Return
        DeleteOwnedTree(full, True)
    End Sub

    Private Shared Sub DeleteOwnedTree(path As String, Optional root As Boolean = False)
        'Do not recurse into junctions, even during cleanup after a partial preparation.
        If (File.GetAttributes(path) And FileAttributes.ReparsePoint) <> 0 Then
            Directory.Delete(path, False)
            Return
        End If
        For Each file In Directory.GetFiles(path)
            If root AndAlso {"zcode-native-wallpaper.marker", "zcode-native-wallpaper.lock"}.Contains(IO.Path.GetFileName(file)) Then Continue For
            IO.File.Delete(file)
        Next
        For Each child In Directory.GetDirectories(path)
            DeleteOwnedTree(child)
        Next
        If root Then
            File.Delete(IO.Path.Combine(path, "zcode-native-wallpaper.lock"))
            File.Delete(IO.Path.Combine(path, "zcode-native-wallpaper.marker"))
        End If
        Directory.Delete(path, False)
    End Sub

    Private Shared Sub CreateJunction(path As String, target As String)
        Directory.CreateDirectory(path)
        Dim substitute = Encoding.Unicode.GetBytes("\??\" & IO.Path.GetFullPath(target))
        Dim printName = Encoding.Unicode.GetBytes(IO.Path.GetFullPath(target))
        Using data As New MemoryStream(), writer As New BinaryWriter(data)
            writer.Write(&HA0000003UI)
            writer.Write(CUShort(8 + substitute.Length + printName.Length + 4))
            writer.Write(CUShort(0))
            writer.Write(CUShort(0))
            writer.Write(CUShort(substitute.Length))
            writer.Write(CUShort(substitute.Length + 2))
            writer.Write(CUShort(printName.Length))
            writer.Write(substitute)
            writer.Write(CUShort(0))
            writer.Write(printName)
            writer.Write(CUShort(0))
            Using handle = CreateFile(path, &H40000000UI, 7UI, IntPtr.Zero, 3UI, &H2200000UI, IntPtr.Zero)
                If handle.IsInvalid Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "无法创建独立壁纸运行目录。")
                Dim bytes = data.ToArray()
                Dim returned As Integer
                If Not DeviceIoControl(handle, &H900A4UI, bytes, bytes.Length, IntPtr.Zero, 0, returned, IntPtr.Zero) Then Throw New Win32Exception(Marshal.GetLastWin32Error(), "无法关联本机 Wallpaper Engine 资源。")
            End Using
        End Using
    End Sub

    <StructLayout(LayoutKind.Sequential)> Private Structure BasicLimits
        Public PerProcessUserTimeLimit, PerJobUserTimeLimit As Long
        Public LimitFlags As UInteger
        Public MinimumWorkingSetSize, MaximumWorkingSetSize As UIntPtr
        Public ActiveProcessLimit As UInteger
        Public Affinity As UIntPtr
        Public PriorityClass, SchedulingClass As UInteger
    End Structure
    <StructLayout(LayoutKind.Sequential)> Private Structure IoCounters
        Public ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount As ULong
    End Structure
    <StructLayout(LayoutKind.Sequential)> Private Structure JobLimits
        Public BasicLimitInformation As BasicLimits
        Public IoInfo As IoCounters
        Public ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed As UIntPtr
    End Structure
    <StructLayout(LayoutKind.Sequential, CharSet:=CharSet.Unicode)> Private Structure StartupInfo
        Public cb As Integer
        Public lpReserved, lpDesktop, lpTitle As String
        Public dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags As Integer
        Public wShowWindow, cbReserved2 As Short
        Public lpReserved2, hStdInput, hStdOutput, hStdError As IntPtr
    End Structure
    <StructLayout(LayoutKind.Sequential)> Private Structure NativeProcessInfo
        Public hProcess, hThread As IntPtr
        Public dwProcessId, dwThreadId As UInteger
    End Structure
    Private Delegate Function EnumCallback(handle As IntPtr, parameter As IntPtr) As Boolean
    Private Delegate Function WindowProcedure(handle As IntPtr, message As UInteger, wParam As IntPtr, lParam As IntPtr) As IntPtr
    <StructLayout(LayoutKind.Sequential)> Private Structure CaptureRect
        Public Left, Top, Right, Bottom As Integer
    End Structure
    <DllImport("user32.dll")> Private Shared Function GetSystemMetrics(index As Integer) As Integer
    End Function
    <DllImport("user32.dll", SetLastError:=True)> Private Shared Function GetWindowRect(handle As IntPtr, ByRef bounds As CaptureRect) As Boolean
    End Function
    <StructLayout(LayoutKind.Sequential, CharSet:=CharSet.Unicode)> Private Structure NativeWindowClass
        Public Style As UInteger
        Public Procedure As WindowProcedure
        Public ClassBytes, WindowBytes As Integer
        Public Instance, Icon, Cursor, Background As IntPtr
        Public MenuName, ClassName As String
    End Structure
    <DllImport("user32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function RegisterClass(ByRef definition As NativeWindowClass) As UShort
    End Function
    <DllImport("user32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function CreateWindowEx(exStyle As UInteger, className As String, title As String, style As UInteger, x As Integer, y As Integer, width As Integer, height As Integer, parent As IntPtr, menu As IntPtr, instance As IntPtr, parameter As IntPtr) As IntPtr
    End Function
    <DllImport("user32.dll", CharSet:=CharSet.Unicode)> Private Shared Function DefWindowProc(handle As IntPtr, message As UInteger, wParam As IntPtr, lParam As IntPtr) As IntPtr
    End Function
    <DllImport("user32.dll")> Private Shared Function DestroyWindow(handle As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll", SetLastError:=True)> Private Shared Function SetLayeredWindowAttributes(handle As IntPtr, color As UInteger, alpha As Byte, flags As UInteger) As Boolean
    End Function
    <DllImport("kernel32.dll", CharSet:=CharSet.Unicode)> Private Shared Function GetModuleHandle(name As String) As IntPtr
    End Function
    <DllImport("user32.dll", CharSet:=CharSet.Unicode)> Private Shared Function FindWindow(className As String, title As String) As IntPtr
    End Function
    <DllImport("user32.dll")> Private Shared Function EnumChildWindows(parent As IntPtr, callback As EnumCallback, parameter As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll")> Private Shared Function GetWindowThreadProcessId(handle As IntPtr, ByRef pid As UInteger) As UInteger
    End Function
    <DllImport("user32.dll", CharSet:=CharSet.Unicode)> Private Shared Function GetClassName(handle As IntPtr, name As StringBuilder, length As Integer) As Integer
    End Function
    <DllImport("user32.dll", SetLastError:=True)> Private Shared Function SetWindowPos(handle As IntPtr, after As IntPtr, x As Integer, y As Integer, width As Integer, height As Integer, flags As UInteger) As Boolean
    End Function
    <DllImport("user32.dll")> Private Shared Function ShowWindow(handle As IntPtr, command As Integer) As Boolean
    End Function
    <DllImport("kernel32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function CreateJobObject(attributes As IntPtr, name As String) As IntPtr
    End Function
    <DllImport("kernel32.dll", SetLastError:=True)> Private Shared Function SetInformationJobObject(job As SafeFileHandle, infoClass As Integer, info As IntPtr, length As UInteger) As Boolean
    End Function
    <DllImport("kernel32.dll", SetLastError:=True)> Private Shared Function AssignProcessToJobObject(job As SafeFileHandle, process As IntPtr) As Boolean
    End Function
    <DllImport("kernel32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function CreateProcess(application As String, command As StringBuilder, processAttributes As IntPtr, threadAttributes As IntPtr, inherit As Boolean, flags As UInteger, environment As IntPtr, directory As String, ByRef startup As StartupInfo, ByRef info As NativeProcessInfo) As Boolean
    End Function
    <DllImport("kernel32.dll", SetLastError:=True)> Private Shared Function ResumeThread(thread As IntPtr) As UInteger
    End Function
    <DllImport("kernel32.dll")> Private Shared Function TerminateProcess(process As IntPtr, exitCode As UInteger) As Boolean
    End Function
    <DllImport("kernel32.dll")> Private Shared Function CloseHandle(handle As IntPtr) As Boolean
    End Function
    <DllImport("kernel32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function CreateFile(path As String, access As UInteger, share As UInteger, security As IntPtr, disposition As UInteger, flags As UInteger, template As IntPtr) As SafeFileHandle
    End Function
    <DllImport("kernel32.dll", SetLastError:=True)> Private Shared Function DeviceIoControl(handle As SafeFileHandle, code As UInteger, input As Byte(), inputLength As Integer, output As IntPtr, outputLength As Integer, ByRef returned As Integer, overlapped As IntPtr) As Boolean
    End Function
    <DllImport("kernel32.dll", CharSet:=CharSet.Unicode, SetLastError:=True)> Private Shared Function CreateHardLink(path As String, existing As String, security As IntPtr) As Boolean
    End Function
End Class
