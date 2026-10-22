# Zcode-WE

为 ZCode 带来独立的 Wallpaper Engine 动态背景，以及随手可调的半透明界面。

**基于 [sorrowKnight123/zcode-beautify-for-wallpaper-engine](https://github.com/sorrowKnight123/zcode-beautify-for-wallpaper-engine) 项目，并采用自研窗口合成方法。** 保留右下角独立菜单和分层透明的使用体验，将本地实时壁纸与 ZCode 界面放在同一文档中合成。

## 功能

- **独立菜单**：点击右下角「壁纸与外观」，集中选择壁纸、调整参数与外观。
- **本地壁纸库**：扫描 Wallpaper Engine 内置项目和 Steam 创意工坊内容，支持搜索、类型筛选与作者参数。
- **分层半透明**：通透／均衡／专注三种预设，另可调整内容底色不透明度、背景压暗；深浅主题跟随 ZCode。
- **10–120 FPS 帧率上限**：默认 60 FPS，可在菜单中调整。实际帧率取决于壁纸、视频源和硬件。
- **同文档合成**：实时画面作为本地 MediaStream 接入背景视频层；移动、缩放窗口时保持同一渲染实例。
- **光标隔离**：建立采集后将自有渲染窗口移出虚拟桌面，等待新帧后展示背景，避免出现第二个系统光标。
- **独立运行与退出清理**：使用私有 Wallpaper Engine 配置和 Windows Job 管理进程树，不修改桌面壁纸配置。

## 支持范围

目前仅适配 **Windows x64 上 ZCode 3.16.2 的指定原始构建**，`resources/app.asar` 的 SHA-256 必须为：

```text
1f960ba24a4a6687bb29090a9ac3273c06e9fc18b14882525f591132650a99a8
```

安装同时检查版本、文件哈希和 Electron 状态。版本相同但文件不同，也会拒绝修改。本项目使用可恢复的应用包适配，不是 ZCode 官方插件接口；ZCode 更新后需要重新核验兼容性。

## 安装

准备以下环境：

- Node.js **22 或更新版本**，可在终端执行 `node` 和 `npm`。
- Windows PowerShell 与 .NET Framework 4.x x64（含 VB 编译器和 WPF 组件）。
- 本机已安装 Wallpaper Engine，并有其安装目录的写入权限。
- 首次构建可访问官方 NuGet，用于下载固定版本依赖。

下载或克隆源码后，在项目目录打开 PowerShell，先正常退出 ZCode，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

默认使用 `%LOCALAPPDATA%\Programs\ZCode`。其他位置可传入 `-ZCodeDirectory`，其值为包含 `ZCode.exe` 的目录。

安装脚本会构建所需的原生辅助程序，将运行文件复制到稳定目录，备份原始应用包，然后应用经过版本与哈希校验的适配。构建会从官方 NuGet 获取 **Newtonsoft.Json 13.0.3** 并校验依赖；DLL 与构建产物不纳入源码版本控制。

启动 ZCode，点击右下角按钮：

1. 扫描壁纸，必要时选择本机 `wallpaper64.exe`。
2. 选择项目并开启「启用独立壁纸」。
3. 调整作者参数、帧率上限与外观。
4. 点击「应用设置」。修改先保存为草稿，应用后生效。

只修改不透明度、压暗或预设时更新界面样式；切换壁纸、作者参数或帧率上限时重新连接渲染实例。

## 卸载与更新

正常退出 ZCode，在项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

脚本校验当前包与备份后恢复原始 `app.asar`，保留设置、源码和备份。已有安装记录时，先卸载再重新安装。若应用已经更新，恢复守卫会拒绝用旧包覆盖新版本；不要通过删除记录绕过检查。

为兼容既有安装，运行与设置目录继续使用 `ZCodeNativeWallpaper`：

- 运行文件：`%LOCALAPPDATA%\Programs\ZCodeNativeWallpaper`
- 设置和日志：`%APPDATA%\ZCodeNativeWallpaper`
- 恢复记录：运行目录中的 `adapter-state.json`
- 文件校验清单：运行目录中的 `runtime-files.json`
- 原包备份：ZCode 的 `resources` 目录中的 `app.asar.zwn-original-*`

## 工作原理

```text
本机 Wallpaper Engine
       ↓ 独立进程、私有配置、Windows Job
自有原生渲染窗口
       ↓ 本地窗口 MediaStream
ZCode 文档中的背景 video + 半透明界面
```

原生窗口先以 alpha 0 建立画面连接。首帧到达后，桥接层通过标准输入／输出协议发送匹配 HWND 的确认请求；辅助程序将窗口移到整个虚拟桌面之外，页面再等两帧后显示视频。源窗口的位置不会跟随 ZCode 移动，页面用 `object-fit: cover` 统一处理背景缩放。

此路径不录制视频文件、不编码或转码，不启动 HTTP 服务或 CDP／远程调试端口；画面流不采集音频。引擎与 ZCode 自身的联网行为不受这些描述限制。窗口采集只使用辅助程序拥有的 HWND，不向页面开放任意桌面或窗口选择器。

## 开发与测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\build.ps1
npm test
npm run test:native
```

JavaScript 测试覆盖适配守卫、壁纸库、配置、外观、画面生命周期和桥接层。原生测试使用合成窗口与进程检查协议、项目类型、帧率、取消、退出和清理，不启动真实 Wallpaper Engine。真实壁纸的画面效果与硬件兼容性仍需在目标机器验证。

原生协议与构建细节见 [native/README.md](native/README.md)。开发验收探针及其可选依赖不是正常运行所必需的内容。

## 已知边界

- 原生渲染分辨率保持连接时的尺寸，窗口缩放不会重启引擎；放大时清晰度可能降低，比例变化时 `cover` 会裁切画面。
- 同时保持一个独立壁纸实例。网页项目受 Wallpaper Engine 全局屏保通道限制，存在冲突时会拒绝连接。
- Scene／Video 的画面通道已验证；不同项目、视频框架、Web 壁纸、音频、鼠标互动与跨屏 DPI 仍有兼容边界。背景层不接收鼠标操作。
- 透明与压暗作用于文档内背景，当前不提供真实毛玻璃模糊。
- 帧率设置是上限，不是吞吐保证；固定帧率视频不会因此生成额外画面。

## 许可与致谢

源码采用 [MIT License](LICENSE)。分层表面颜色映射参考并改编自 `zcode-beautify-for-wallpaper-engine`；独立渲染与窗口合成采用自研实现。参考项目与 Newtonsoft.Json 的版权及完整许可保留在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

项目调用本机安装的 ZCode、Wallpaper Engine 和本地壁纸，不分发这些产品的程序或壁纸资产，也不代表其官方授权或背书。
