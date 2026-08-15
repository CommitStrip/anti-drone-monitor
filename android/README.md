# 反无人机监控 · Android 演示端

一个极简的 Android 工程骨架：用 `WebView` 加载共享的 HTML5 检测核心（`web/index.html`），
并通过 `nativeBridge` 的 JsBridge 接收检测核心输出的遥测事件，落盘为 CSV 便于追溯与改进。

## 目录结构

```
android/
├── settings.gradle
├── build.gradle
├── README.md
└── app/
    ├── build.gradle
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/example/dronemonitor/MainActivity.kt
        └── res/values/
            ├── themes.xml
            └── strings.xml
```

## 1. 把共享 Web 核心拷贝进 assets

Web 检测核心位于共享目录 `../web/index.html`（相对本工程 `android/` 而言）。

自动拷贝（推荐）：`app/build.gradle` 中已定义 `copyWebApp` 任务，它会在 `preBuild`
阶段把 `web/index.html` 拷贝到 `app/src/main/assets/web/index.html`，并让 `sourceSets`
把 `assets` 直接指向该目录。因此：

- 直接构建即可，无需手工拷贝。
- 也可单独执行手动同步：在 `android/` 目录运行
  `./gradlew :app:copyWebApp`（Windows 用 `gradlew.bat`）。

手工拷贝（可选，不依赖 gradle）：把 `web/index.html` 复制到
`app/src/main/assets/web/index.html`，WebView 通过 `file:///android_asset/web/index.html`
加载。注意：`MainActivity` 加载的路径是 `file:///android_asset/web/index.html`，
所以必须放在 `assets/web/index.html` 这个相对位置。

## 2. 用 Android Studio 构建

1. 用 Android Studio 打开本目录（`android/`，顶层有 `settings.gradle`）。
2. 等待 Gradle 同步完成（首次会下载依赖，需联网）。
3. 机型连接后点击 Run 运行 `app`；或通过菜单 Build → Build APK(s) 生成安装包。
4. 最近一次构建也可用命令行：`./gradlew :app:assembleDebug`。

> 说明：本工程当前在受限沙箱内测试，尚未配置本地 Gradle Wrapper / Android SDK，
> 请使用 Android Studio 自带的 SDK 与 Gradle 完成构建。

## 3. 相机（getUserMedia）支持

Web 核心通过系统 WebView 的 `getUserMedia` 调用相机。Android 系统 WebView 对
`getUserMedia` 有安全约束：

- **必须使用 HTTPS 或受信任的本机 scheme**（如 `file://`、`https://`）。
- `MainActivity` 中已配置 `WebChromeClient` 并默认用 `file:///android_asset/web/index.html`
  加载，因此本机 assets 场景下可直接使用相机。
- 若改为加载远程 `https://` 页面，则无需额外处理；但**不要**使用 `http://` 明文地址
  （Android 9+ 默认禁止明文流量，且 getUserMedia 会被拒绝）。

关于明文（cleartext）与 localhost：当前工程通过 `file://` 加载，不依赖 cleartext 白名单。
若将来需要从 `http://<本机/局域网>` 加载调试，可在 `AndroidManifest.xml` 的 `<application>`
中加 `android:usesCleartextTraffic="true"` 或配置 `networkSecurityConfig`，仅用于调试，
不建议用于生产。

权限说明：`AndroidManifest.xml` 已声明 `CAMERA` 权限与 `INTERNET` 权限，`MainActivity`
在启动时会请求相机权限。

## 4. 遥测落盘位置

检测核心通过 `nativeBridge.pushTelemetry(json)` 上报事件，`MainActivity` 将其逐行写入 CSV。

- 落盘目录：应用私有外部存储
  `Android/data/com.example.dronemonitor/files/Documents/telemetry/`
  即 `getExternalFilesDir(DIRECTORY_DOCUMENTS)/telemetry`。
- 每次启动生成一个文件：`telemetry_yyyyMMdd_HHmmss.csv`，以追加方式写入。
- 该目录属于应用私有目录，卸载应用会被清除；无需额外存储权限即可读写。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `app/src/main/java/com/example/dronemonitor/MainActivity.kt` | WebView 封装 + nativeBridge 遥测桥 |
| `app/build.gradle` | 构建配置 + `copyWebApp` 任务 |
| `app/src/main/AndroidManifest.xml` | 权限、Activity、主题声明 |
| `app/src/main/res/values/themes.xml` | 深色主题 `Theme.Material` |
| `app/src/main/res/values/strings.xml` | 应用名等字符串资源 |