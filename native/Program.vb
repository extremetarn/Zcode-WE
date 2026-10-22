Imports System
Imports System.IO
Imports System.Diagnostics
Imports System.Threading
Imports System.Threading.Tasks
Imports System.Collections.Generic
Imports System.Runtime.InteropServices
Imports System.Windows
Imports System.Windows.Threading
Imports Newtonsoft.Json.Linq

' JSON-lines bridge. No sockets, desktop commands, or dependency on ZCode internals.
Public Module Program
    Private App As Application
    Private Owned As WallpaperIndependentRuntime
    Private Pending As CancellationTokenSource
    Private ReadOnly Operations As New List(Of Task)
    Private ReadOnly OutputLock As New Object
    Private Version As Integer
    Private Ending As Boolean
    Private State As String = "idle"
    Private LastError As String
    Private Target As IntPtr
    Private TargetPid As UInteger
    Private Configuration As JObject
    Private Rect As New NativeRect
    Private Visible As Boolean = True
    Private CapturePresentation As Boolean
    Private RequestedFps As Integer = 60
    Private ResizeAt As DateTime
    Private ResizePending As Boolean
    Private Timer As DispatcherTimer

    Private Structure NativeRect
        Public X, Y, Width, Height As Integer
    End Structure

    <StructLayout(LayoutKind.Sequential)> Private Structure WindowRect
        Public Left, Top, Right, Bottom As Integer
    End Structure

    <STAThread> Public Sub Main()
        Try
            If Not SetProcessDpiAwarenessContext(New IntPtr(-4)) Then SetProcessDPIAware()
        Catch ex As EntryPointNotFoundException
            SetProcessDPIAware()
        End Try
        Console.InputEncoding = New System.Text.UTF8Encoding(False)
        Console.OutputEncoding = New System.Text.UTF8Encoding(False)
        App = New Application With {.ShutdownMode = ShutdownMode.OnExplicitShutdown}
        'This dispatcher is independent of Electron's modal native move loop.
        Timer = New DispatcherTimer With {.Interval = TimeSpan.FromMilliseconds(16)}
        AddHandler Timer.Tick, AddressOf Tick
        Timer.Start()
        Dim reader As New Thread(AddressOf ReadInput) With {.IsBackground = True, .Name = "json-input"}
        reader.Start()
        Emit(New JObject From {{"event", "hello"}, {"protocol", 1}, {"state", State}})
        App.Run()
    End Sub

    Private Sub ReadInput()
        Try
            Do
                Dim line = Console.ReadLine()
                If line Is Nothing Then Exit Do
                Dim captured = line
                App.Dispatcher.BeginInvoke(New Action(Sub() HandleLine(captured)))
            Loop
        Catch ex As Exception
            Console.Error.WriteLine(ex.Message)
        Finally
            App.Dispatcher.BeginInvoke(New Action(Sub() BeginShutdown()))
        End Try
    End Sub

    Private Sub Emit(value As JObject)
        SyncLock OutputLock
            Try
                Console.WriteLine(value.ToString(Newtonsoft.Json.Formatting.None))
                Console.Out.Flush()
            Catch
                ' Closed stdout is handled by stdin EOF / target lifecycle.
            End Try
        End SyncLock
    End Sub

    Private Function Snapshot() As JObject
        Return New JObject From {
            {"state", State}, {"runtimePid", If(Owned Is Nothing, 0, Owned.ProcessId)},
            {"captureHwnd", If(Owned IsNot Nothing AndAlso Owned.IsCaptureSource, Owned.HostHandle.ToInt64().ToString(Globalization.CultureInfo.InvariantCulture), "0")},
            {"captureParked", Owned IsNot Nothing AndAlso Owned.IsCaptureParked},
            {"fps", RequestedFps},
            {"targetHwnd", Target.ToInt64().ToString(Globalization.CultureInfo.InvariantCulture)},
            {"visible", Visible}, {"error", If(LastError, "")},
            {"rect", New JObject From {{"x", Rect.X}, {"y", Rect.Y}, {"width", Rect.Width}, {"height", Rect.Height}}}}
    End Function

    Private Sub ChangeState(value As String, Optional message As String = Nothing)
        State = value
        LastError = message
        Dim evt = Snapshot()
        evt("event") = "state"
        Emit(evt)
    End Sub

    Private Function ReadRect(value As JToken) As NativeRect
        If value Is Nothing OrElse value.Type <> JTokenType.Object Then Throw New ArgumentException("rect is required")
        For Each key In {"x", "y", "width", "height"}
            If value(key) Is Nothing OrElse value(key).Type <> JTokenType.Integer Then Throw New ArgumentException("rect." & key & " must be an integer")
        Next
        Dim result As New NativeRect With {.X = CInt(value("x")), .Y = CInt(value("y")), .Width = CInt(value("width")), .Height = CInt(value("height"))}
        If result.Width < 1 OrElse result.Height < 1 OrElse result.Width > 32768 OrElse result.Height > 32768 Then Throw New ArgumentException("rect dimensions must be 1..32768 physical pixels")
        Return result
    End Function

    Private Function ReadFps(request As JObject) As Integer
        Dim value = request("fps")
        If value Is Nothing Then Return 60
        If value.Type <> JTokenType.Integer OrElse CLng(value) < 10 OrElse CLng(value) > 120 Then Throw New ArgumentException("fps must be an integer from 10 to 120")
        Return CInt(value)
    End Function

    Private Sub HandleLine(line As String)
        Dim id As JToken = JValue.CreateNull()
        Try
            Dim request = JObject.Parse(line)
            If request("id") IsNot Nothing Then id = request("id").DeepClone()
            If Ending Then Throw New InvalidOperationException("helper is shutting down")
            Select Case CStr(request("command"))
                Case "start"
                    Dim fps = ReadFps(request)
                    Dim hwnd As Long
                    If Not Long.TryParse(CStr(request("targetHwnd")), hwnd) OrElse hwnd = 0 OrElse Not IsWindow(New IntPtr(hwnd)) Then Throw New ArgumentException("targetHwnd is not a live window")
                    Dim nextRect = ReadRect(request("rect"))
                    Dim engine = CStr(request("enginePath"))
                    Dim project = CStr(request("projectPath"))
                    If String.IsNullOrWhiteSpace(engine) OrElse Not File.Exists(engine) Then Throw New ArgumentException("enginePath must name an existing executable")
                    If String.IsNullOrWhiteSpace(project) OrElse Not File.Exists(project) Then Throw New ArgumentException("projectPath must name an existing project.json")
                    If Not String.Equals(Path.GetFileName(project), "project.json", StringComparison.OrdinalIgnoreCase) Then Throw New ArgumentException("projectPath must name project.json")
                    Dim values = request("values")
                    If values IsNot Nothing AndAlso values.Type <> JTokenType.Object AndAlso values.Type <> JTokenType.Null Then Throw New ArgumentException("values must be an object")
                    Dim presentation = If(CStr(request("presentation")), "overlay")
                    If presentation <> "overlay" AndAlso presentation <> "capture" Then Throw New ArgumentException("presentation must be overlay or capture")
                    Configuration = CType(request.DeepClone(), JObject)
                    Configuration("fps") = fps
                    RequestedFps = fps
                    Target = New IntPtr(hwnd)
                    GetWindowThreadProcessId(Target, TargetPid)
                    Rect = nextRect
                    RefreshTargetRect(False)
                    CapturePresentation = presentation = "capture"
                    Timer.Interval = TimeSpan.FromMilliseconds(If(CapturePresentation, 100, 16))
                    Visible = True
                    BeginStart()
                Case "layout"
                    'Keep validating the original wire contract, but native HWND bounds
                    'are authoritative. DIP rounding can change an IPC dimension by 1 px.
                    Dim hint = ReadRect(request("rect"))
                    If request("visible") IsNot Nothing AndAlso request("visible").Type <> JTokenType.Boolean Then Throw New ArgumentException("visible must be boolean")
                    If Target = IntPtr.Zero Then Rect = hint
                    If Not CapturePresentation Then RefreshTargetRect()
                    If request("visible") IsNot Nothing Then Visible = CBool(request("visible"))
                    ApplyLayout()
                Case "capture-attached"
                    If Owned Is Nothing OrElse Not Owned.IsCaptureSource OrElse State <> "ready" Then Throw New InvalidOperationException("No ready capture source")
                    Dim captureHandle As Long
                    If Not Long.TryParse(CStr(request("captureHwnd")), captureHandle) OrElse captureHandle <> Owned.HostHandle.ToInt64() Then Throw New ArgumentException("captureHwnd does not match the current source")
                    Owned.CaptureAttached()
                Case "stop"
                    CancelAndDetach()
                    Configuration = Nothing
                    ChangeState("idle")
                Case "status"
                    ' Snapshot below is the reply.
                Case "shutdown"
                    Dim reply = Snapshot()
                    reply("id") = id
                    reply("ok") = True
                    Emit(reply)
                    BeginShutdown()
                    Return
                Case Else
                    Throw New ArgumentException("unknown command")
            End Select
            Dim result = Snapshot()
            result("id") = id
            result("ok") = True
            Emit(result)
        Catch ex As Exception
            Emit(New JObject From {{"id", id}, {"ok", False}, {"state", State}, {"error", ex.Message}})
        End Try
    End Sub

    Private Sub CancelAndDetach()
        Version += 1
        If Pending IsNot Nothing Then Pending.Cancel()
        Pending = Nothing
        ResizePending = False
        If Owned IsNot Nothing Then
            Owned.SetVisible(False)
            Owned.Dispose()
            Owned = Nothing
        End If
    End Sub

    Private Sub BeginStart()
        CancelAndDetach()
        If Ending OrElse Configuration Is Nothing Then Return
        Dim cancellation As New CancellationTokenSource()
        Pending = cancellation
        Dim currentVersion = Version
        Dim config = CType(Configuration.DeepClone(), JObject)
        Dim initialRect = Rect
        ChangeState("preparing")
        Operations.RemoveAll(Function(t) t.IsCompleted)
        Operations.Add(StartAsync(config, initialRect, currentVersion, cancellation))
    End Sub

    Private Async Function StartAsync(config As JObject, initialRect As NativeRect, currentVersion As Integer, cancellation As CancellationTokenSource) As Task
        Dim prepared As WallpaperIndependentRuntime = Nothing
        Try
            Dim values = TryCast(config("values"), JObject)
            prepared = Await Task.Run(Function() WallpaperIndependentRuntime.Prepare(CStr(config("enginePath")), CStr(config("projectPath")), values, cancellation.Token, CInt(config("fps"))))
            cancellation.Token.ThrowIfCancellationRequested()
            If Ending OrElse Version <> currentVersion OrElse Not IsWindow(Target) Then Return
            prepared.Start("ZCode-Native-Wallpaper-" & Process.GetCurrentProcess().Id & "-" & currentVersion, initialRect.Width, initialRect.Height, CStr(config("presentation")) = "capture")
            Dim elapsed = Stopwatch.StartNew()
            While prepared.RenderHandle = IntPtr.Zero
                cancellation.Token.ThrowIfCancellationRequested()
                If Not prepared.IsAlive Then Throw New InvalidOperationException("Wallpaper Engine exited before creating its preview window")
                If elapsed.Elapsed.TotalSeconds > 25 Then Throw New TimeoutException("Wallpaper Engine preview did not become ready within 25 seconds")
                Await Task.Delay(100, cancellation.Token)
            End While
            cancellation.Token.ThrowIfCancellationRequested()
            If Ending OrElse Version <> currentVersion OrElse Not IsWindow(Target) Then Return
            Owned = prepared
            prepared = Nothing
            If Not CapturePresentation AndAlso (Rect.Width <> Owned.Width OrElse Rect.Height <> Owned.Height) Then
                ResizePending = True
                ResizeAt = DateTime.UtcNow
            End If
            ApplyLayout()
            ChangeState("ready")
        Catch ex As OperationCanceledException
            ' A newer command owns state. The old prepared instance is disposed below.
        Catch ex As Exception
            If Not Ending AndAlso currentVersion = Version Then
                If Owned IsNot Nothing Then Owned.Dispose()
                Owned = Nothing
                ChangeState("error", ex.Message)
            End If
        Finally
            If prepared IsNot Nothing Then prepared.Dispose()
            If ReferenceEquals(Pending, cancellation) Then Pending = Nothing
            cancellation.Dispose()
        End Try
    End Function

    Private Sub RefreshTargetRect(Optional scheduleResize As Boolean = True)
        If Target = IntPtr.Zero OrElse Not IsWindowVisible(Target) OrElse IsIconic(Target) Then Return
        Dim bounds As WindowRect
        If Not GetWindowRect(Target, bounds) Then Throw New ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot read target window bounds")
        Dim width As Long = CLng(bounds.Right) - bounds.Left
        Dim height As Long = CLng(bounds.Bottom) - bounds.Top
        If width < 1 OrElse height < 1 OrElse width > 32768 OrElse height > 32768 Then Throw New InvalidOperationException("Target window has invalid physical dimensions")
        If scheduleResize AndAlso (Rect.Width <> width OrElse Rect.Height <> height) Then
            ResizeAt = DateTime.UtcNow
            ResizePending = True
        End If
        Rect = New NativeRect With {.X = bounds.Left, .Y = bounds.Top, .Width = CInt(width), .Height = CInt(height)}
    End Sub

    Private Sub ApplyLayout()
        If Owned Is Nothing Then Return
        If Owned.IsCaptureSource Then
            'The capture source is positioned once at creation. DOM composition
            'owns all client movement, resizing and presentation visibility.
            Return
        End If
        Dim show = Visible AndAlso IsWindow(Target) AndAlso IsWindowVisible(Target) AndAlso Not IsIconic(Target)
        Owned.SetVisible(show)
        If Not show Then Return
        ' Owned holder is immediately behind the target, never its parent or owner.
        If Not SetWindowPos(Owned.HostHandle, Target, Rect.X, Rect.Y, Rect.Width, Rect.Height, &H10UI Or &H40UI Or &H200UI Or &H4000UI) Then
            Throw New ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot position wallpaper holder")
        End If
    End Sub

    Private Sub Tick(sender As Object, e As EventArgs)
        If Ending Then Return
        Try
            Dim currentPid As UInteger
            If Target <> IntPtr.Zero Then GetWindowThreadProcessId(Target, currentPid)
            If Target <> IntPtr.Zero AndAlso (Not IsWindow(Target) OrElse currentPid <> TargetPid) Then
                BeginShutdown()
                Return
            End If
            If Not CapturePresentation Then RefreshTargetRect()
            If Owned Is Nothing Then Return
            If Not Owned.IsAlive OrElse Owned.RenderHandle = IntPtr.Zero Then
                CancelAndDetach()
                ChangeState("error", "Wallpaper Engine preview exited")
                Return
            End If
            Owned.MaintainCaptureParking()
            If ResizePending AndAlso Pending Is Nothing AndAlso DateTime.UtcNow.Subtract(ResizeAt).TotalMilliseconds >= 300 Then
                If Rect.Width <> Owned.Width OrElse Rect.Height <> Owned.Height Then
                    BeginStart()
                    Return
                End If
                ResizePending = False
            End If
            ApplyLayout()
        Catch ex As Exception
            CancelAndDetach()
            ChangeState("error", ex.Message)
        End Try
    End Sub

    Private Async Sub BeginShutdown()
        If Ending Then Return
        Ending = True
        Timer.Stop()
        CancelAndDetach()
        ChangeState("stopping")
        Try
            Await Task.WhenAll(Operations.ToArray())
        Catch ex As Exception
            Console.Error.WriteLine(ex.Message)
        End Try
        ChangeState("stopped")
        App.Shutdown()
    End Sub

    <DllImport("user32.dll")> Private Function IsWindow(handle As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll", SetLastError:=True)> Private Function GetWindowRect(handle As IntPtr, ByRef rect As WindowRect) As Boolean
    End Function
    <DllImport("user32.dll")> Private Function GetWindowThreadProcessId(handle As IntPtr, ByRef processId As UInteger) As UInteger
    End Function
    <DllImport("user32.dll")> Private Function SetProcessDpiAwarenessContext(context As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll")> Private Function SetProcessDPIAware() As Boolean
    End Function
    <DllImport("user32.dll")> Private Function IsWindowVisible(handle As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll")> Private Function IsIconic(handle As IntPtr) As Boolean
    End Function
    <DllImport("user32.dll", SetLastError:=True)> Private Function SetWindowPos(handle As IntPtr, after As IntPtr, x As Integer, y As Integer, width As Integer, height As Integer, flags As UInteger) As Boolean
    End Function
End Module
