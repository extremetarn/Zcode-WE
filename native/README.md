# Zcode-WE native host

Windows x64 原生辅助程序，为本机 Wallpaper Engine 创建独立的预览进程、配置、缓存及承载窗口。Zcode-WE 通过标准输入／输出 JSON 行协议控制它，并把自有窗口的实时画面接入同一 Chromium 文档中的视频层。

## 构建

从项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\build.ps1
```

需要 Windows PowerShell、.NET Framework 4.x x64 的 VB 编译器和 WPF 程序集。构建自动从官方 NuGet 获取固定版本 **Newtonsoft.Json 13.0.3**，校验下载依赖后使用。首次构建需要网络访问；下载的 DLL、临时文件和构建产物不纳入 Git。

输出为 `native/bin/ZCodeWallpaperHost.exe` 及相邻的 `Newtonsoft.Json.dll`，运行时须保留这两个文件。依赖许可见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

## 测试

从项目根目录运行：

```powershell
npm test
npm run build:native
npm run test:native
```

默认原生检查覆盖协议验证、项目类型和 FPS 配置。需要检查 Scene／Video 窗口识别、首帧握手、屏外位置维护、移动／缩放、取消及退出清理时，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-native.ps1 -IncludeWindowFixtures
```

生命周期测试会编译合成 Win32 预览进程，短暂显示测试窗口，不启动真实 Wallpaper Engine。合成检查不代替实际壁纸、系统合成器或显卡驱动的兼容测试。

## 标准输入／输出协议

启动辅助程序时重定向标准输入与输出，使用 UTF-8，并隐藏控制台窗口。每条请求和响应各占一行；响应回显 `id`，主动事件携带 `event`。首条消息为：

```json
{"event":"hello","protocol":1,"state":"idle"}
```

请求示例中的路径须替换为调用方已经确认的本机绝对路径，句柄须替换为当前真实 HWND：

```json
{"id":1,"command":"start","presentation":"capture","fps":60,"enginePath":"<absolute path to wallpaper64.exe>","projectPath":"<absolute path to project.json>","values":{},"targetHwnd":"123456","rect":{"x":100,"y":80,"width":1200,"height":800}}
{"id":2,"command":"capture-attached","captureHwnd":"789012"}
{"id":3,"command":"layout","rect":{"x":100,"y":80,"width":1200,"height":800},"visible":true}
{"id":4,"command":"status"}
{"id":5,"command":"stop"}
{"id":6,"command":"shutdown"}
```

- `targetHwnd` 和 `captureHwnd` 使用十进制字符串，保留 64 位句柄精度。
- `rect` 使用物理屏幕像素，允许负坐标；可见目标窗口的实际尺寸由原生窗口 API 校验。
- `fps` 为 10–120 的整数，缺省为 60。它只改变独立引擎配置；桥接层同时设置画面流的帧率上限。
- `values` 是可选的壁纸作者参数对象。调整帧率或作者参数以新的 `start` 应用。
- 成功响应携带 `ok:true` 与状态快照；失败响应携带 `ok:false` 和错误信息。

快照包括 `state`、`runtimePid`、`targetHwnd`、`captureHwnd`、`captureParked`、`fps`、`visible`、`rect` 和 `error`。只有采集源就绪时，`captureHwnd` 才是自有承载窗口的句柄；否则为 `"0"`。

状态可为 `idle`、`preparing`、`ready`、`error`、`stopping` 或 `stopped`。`start` 先确认准备阶段，后续状态通过事件通知。事件可能先于请求确认到达，应按 `id` 匹配响应，不依赖行顺序。

## 画面连接与光标隔离

1. `start` 创建透明原生承载窗口和独立 Wallpaper Engine 实例，进入 `ready` 后返回自有 `captureHwnd`。
2. 桥接层只使用该 HWND 建立本地窗口 MediaStream，页面视频暂时保持隐藏。
3. 首帧到达后发送 `capture-attached`，必须包含当前自有 `captureHwnd`；缺失、过期句柄或非就绪状态均拒绝。
4. 辅助程序把源窗口放到虚拟桌面左上边界之外，留出 64 像素余量，并返回 `captureParked:true`。重复确认当前句柄是幂等操作。
5. 页面再等待两帧后显示背景，避免展示连接初期的光标残留。

源窗口带有透明、工具窗口、不激活与点击穿透样式；alpha 0 在显示之前设置。连接后周期检测虚拟桌面边界与位置漂移，必要时修正。源窗口不会跟随主界面移动；主界面的移动、缩放、隐藏与最小化不重建采集源，Chromium 使用 DOM 视频完成展示。

窗口采集 API 接受某个光标约束，并不代表运行环境真的执行了它。本实现通过将源窗口移出真实指针可达区域来隔离系统光标，不改变系统光标本身。

## 生命周期与隔离

独立实例使用 Wallpaper Engine 安装目录中的 `.zcode-native-wallpaper-runtime/<guid>` 作为私有工作区。配置、缓存、标记与租约归该实例所有，渲染资源从本机引擎链接或复制，不写回原桌面配置。因此该安装目录需要写入权限。

引擎以挂起方式创建，加入带有退出清理约束的 Windows Job 后再恢复运行。版本标记与取消机制防止过期的异步启动成为活动实例。目标窗口关闭、句柄被其他进程复用、标准输入结束或辅助程序退出时，释放所属进程树及临时目录。删除操作验证运行目录、标记及归属，不跟随资源目录链接；短暂文件占用会做有限重试，未完成清理的带标记目录可在后续启动回收。

`shutdown` 先确认请求，再执行清理。程序只管理自有实例，不终止无关进程。桥接层还须在替换或关闭画面源时停止 MediaStream tracks，移除视频节点并取消未完成的等待。

## 兼容边界

- `capture` 是 Zcode-WE 使用的展示模式。为兼容协议保留的 `overlay` 模式依赖另一个原生窗口与应用窗口的位置同步，不作为当前产品展示路径。
- Scene、Video、Web 元数据类型会做大小写和空白规范化；Scene 可使用打包的 `scene.pkg`。
- 网页壁纸使用 Wallpaper Engine 全局屏保通道，存在冲突时拒绝启动；Web、音频、交互与跨屏 DPI 兼容性仍需验证。
- 捕获画面是本地 MediaStream，不写录制文件，不进行编码／转码，不提供 HTTP 或 CDP 服务；此画面流不采集音频。
- 固定连接分辨率与 FPS 上限不保证任意硬件上的实际清晰度和帧率。输入视频也不会因提高上限而产生额外源帧。

独立原生运行时及窗口合成方法为自研实现。项目只调用本机软件，不分发 ZCode、Wallpaper Engine 或壁纸资产。
