# 反无人机监控 · HarmonyOS(NEXT) 演示工程骨架

本目录是 HarmonyOS NEXT 应用骨架，用 **ArkWeb(Web 组件)** 加载共享的 HTML5 检测核心
(`../web/index.html` 即 `drone-monitor-app/web/index.html`)，并通过 **javaScriptProxy 遥测桥**
把 Web 端 JS 产生的"运行时性能 / 效果记录"遥测数据落盘到应用沙箱，便于追溯。

> 说明：本骨架按 **API 12 / SDK 12 (HarmonyOS NEXT)** 标准编写。若你的 DevEco Studio
> 使用更高 SDK，个别 API 写法可能需微调，详见文末"按实际 SDK 调整"。

## 目录结构

```
harmony/
├── AppScope/
│   ├── app.json5                          # 应用级配置(bundleName、图标、标签)
│   └── resources/base/
│       ├── element/string.json            # 应用名
│       └── media/app_icon.png            # 应用图标(占位)
├── build-profile.json5                    # 顶层构建配置(编译 SDK 等)
├── hvigorfile.ts                          # 顶层 hvigor 入口
├── oh-package.json5                       # 顶层包描述
├── entry/
│   ├── build-profile.json5                # 模块构建配置(含混淆规则)
│   ├── hvigorfile.ts                      # 模块 hvigor 入口(hapTasks)
│   ├── oh-package.json5                   # 模块包描述
│   └── src/main/
│       ├── module.json5                   # 模块配置(CAMERA 权限、EntryAbility)
│       ├── resources/                     # 资源
│       │   └── base/
│       │       ├── profile/main_pages.json
│       │       ├── element/string.json
│       │       ├── element/color.json
│       │       └── media/{app_icon,startIcon}.png
│       └── ets/
│           ├── entryability/EntryAbility.ets
│           └── pages/Index.ets           # Web 组件 + 遥测桥 + 深色主题
```

## 1. 如何把共享 web 核心接入

`Index.ets` 中 Web 组件默认加载：

```
Web({ src: 'resource://rawfile/index.html', controller: this.controller })
```

因此需要把共享核心拷贝到 rawfile 目录(二选一)：

- **方式 A(推荐，随应用打包)：**
  将 `drone-monitor-app/web/index.html` 拷贝为
  `entry/src/main/resources/rawfile/index.html`。
  ```bash
  mkdir -p entry/src/main/resources/rawfile
  cp ../web/index.html entry/src/main/resources/rawfile/index.html
  ```
- **方式 B(本地文件路径，调试时用)：**
  把 `index.html` 放到设备某路径，并把 `src` 改为本地绝对路径，例如
  `File(沙箱路径)` 或 `file:///...`，同时确保 Web 组件开启对应文件访问。

## 2. ArkWeb javaScriptProxy 桥接遥测

Web 端(共享核心)通过 `window.nativeBridge.pushTelemetry(json)` 把遥测 JSON 推给 ArkTS。

**ArkTS 侧(Index.ets)** 用 `javaScriptProxy` 注册同名对象：

```ts
Web({ src: 'resource://rawfile/index.html', controller: this.controller })
  .javaScriptProxy({
    object: this.bridge as NativeBridge,   // 桥接对象
    name: 'nativeBridge',                  // 暴露到 window 的名称
    methodList: ['pushTelemetry'],         // 可注入的方法列表
    controller: this.controller
  })
```

`NativeBridge` 是注册在 `window.nativeBridge` 上的对象，ArkTS 定义：

```ts
class NativeBridge {
  pushTelemetry(json: string): void { /* 解析并落盘 */ }
}
```

**Web 端(共享核心)调用示例**——在 `web/index.html` 的遥测记录器中加入一行即可桥接
(例如在 `Telemetry._log` 或 `perf()` 中)：

```js
// window.nativeBridge 由 ArkWeb 注入；不存在时(如纯浏览器)静默跳过
if (window.nativeBridge && window.nativeBridge.pushTelemetry) {
  window.nativeBridge.pushTelemetry(JSON.stringify(ev));
}
```

这样 Web 端每一次"性能采样 / 检出 / 确认 / 错误"记录都会实时转发到 ArkTS 落盘。

## 3. 遥测落盘位置

落盘在**应用沙箱文件目录**(无需额外存储权限)：

```
{context.filesDir}/telemetry/telemetry_YYYYMMDD_HHMMSS.csv
```

- `context.filesDir` 来自 EntryAbility 的 context，Index.ets 内通过
  `getContext(this) as common.UIAbilityContext` 获取后传给 `NativeBridge`。
- CSV 格式：`seq,unix_ms,type,telemetry_json`
  - `seq`：序号
  - `unix_ms`：落盘时间戳(毫秒)
  - `type`：遥测类型(从 JSON 的 `ty` 字段解析，如 `perf`/`det`/`conf`/`err`/`sys`)
  - `telemetry_json`：原始遥测 JSON 字符串
- 文件在应用首次启动时按时间戳创建并写入表头，之后每次 `pushTelemetry` 追加一行。

> 真机调试取文件：`hdc file recv /data/app/el2/100/base/com.example.dronemonitor/haps/entry/files/telemetry/ ...`
> (具体沙箱路径以实际设备为准，DevEco 的 Device File Browser 也可直接查看。)

## 4. 权限与配置

- `module.json5` 已声明相机权限 `ohos.permission.CAMERA`(含申请理由与使用场景)，
  供共享核心调用 `getUserMedia` 做实时检测。
- `requestPermissions` 中写明 `reason` 与 `usedScene`，符合 API 12 要求。
- 读写遥测文件在应用沙箱内，无需额外权限声明。

## 5. 用 DevEco Studio 构建

1. 安装 **DevEco Studio(5.0+ / NEXT)**，并配置好 HarmonyOS SDK(API 12)。
2. 打开工程：File -> Open，选择 `harmony` 目录。
3. 首次打开按提示 Sync(同步)工程，等待 Gradle/Hvigor 拉取依赖完成。
4. 连接真机或模拟器，点击 **Run(▶)** 编译运行。
5. 若报签名错误：Project Structure -> Signing Configs 勾选 **Automatically generate signature**。
6. 运行后点击"开始监控"，Web 端检测流水线产生的遥测即写入沙箱 CSV。

## 6. 按实际 SDK 调整

- 本骨架使用 `@kit.ArkWeb`(提供 `webview` 与 `Web` 组件)、`@kit.AbilityKit`、
  `@kit.CoreFileKit`(文件读写)、`@kit.PerformanceAnalysisKit`(hilog)，均为 API 12 推荐写法。
- 若你的 SDK 更高：
  - `compileSdkVersion` / `compatibleSdkVersion` 可改为对应版本(如 `13`/`14`)。
  - `javaScriptProxy` 的 `object`/`methodList` 字段在较新 API 中保持一致，可直接沿用。
- 若遇到 `getContext` 或 `fs` 相关类型告警，确认已正确 `import { common }` 与 `import { fs }`。