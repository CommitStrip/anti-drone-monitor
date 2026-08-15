# 反无人机监控 · 手机端演示程序

基于已完成的**反无人机识别管线**（帧差门控 → 触发式检测 → IoU 目标跟踪 → 多帧确认 → 目标跟随变焦）构建的**跨端手机演示程序**。

## 设计：一套 Web 核心，双端复用

```
drone-monitor-app/
├── web/index.html        # 共享 HTML5 核心（两端 WebView 复用）
├── android/              # Android 工程（Kotlin WebView 封装 + 遥测落盘）
└── harmony/              # HarmonyOS(NEXT) 工程（ArkWeb 封装 + 遥测落盘）
```

手机作为平台的优势：**变焦更丝滑**（支持捏合手势 + 滑块 + 目标跟随数字变焦，平滑插值过渡），同时**运行时全量记录性能与效果**便于追溯与后期改进。

## 核心能力

| 能力 | 说明 |
|------|------|
| 实时检测 | 帧差运动门控(快) → 触发式检测(慢)，冷却/巡检调度 |
| 目标跟踪 | IoU + 中心距离关联，多帧确认(≥2 次)降假阳性 |
| 丝滑变焦 | 捏合/滑块/按钮 + **目标跟随**自动居中，平滑插值 1×-8× |
| 距离估算 | 针孔模型，实时显示目标距离 |
| 性能记录 | 每帧 fps / 各阶段延迟 / 检出事件 / 确认事件 / 变焦档位 |
| 效果记录 | 检出目标类别/置信度/距离，确认告警时间线 |
| 数据可追溯 | IndexedDB 落盘 + CSV/JSON 导出 + 原生桥接落盘 |

## 真实模型推理（已接入）

核心已内置真实 **YOLOv8s 无人机检测模型**（`web/yolov8s-drone.onnx`，onnxruntime-web + wasm 单核），替换掉了先前的合成 `MotionDetector`。完整链路：letterbox 预处理 → 模型推理 → 坐标/类别解析 → 类内 NMS → IoU 跟踪确认 → 目标跟随变焦。模型推理耗时与检出结果实时写入遥测。

## JEPA 判别 + 在线后训练（已接入）

在 YOLO 定位之上叠加 **JEPA 风格自监督判别**（`web/dinov2_vits14_feat.onnx`，DINOv2-ViT-S 特征提取器 + `web/jepa_probe_init.json` 线性探针头）：

- **分工**：YOLO 负责定位（检测候选框），DINOv2 负责判别（对候选框 crop 提 768 维特征，经探针头输出"鸟/无人机"置信度并在 HUD 显示）。
- **JEPA 后训练**：onnxruntime-web 仅支持推理、无法微调 backbone，故"后训练"落地为**在线终身学习**——在冻结的 DINOv2 特征上，用户点"🕊 这是鸟 / 🛸 这是无人机"反馈后，用闭式增量更新（质心 + 岭回归）微调探针头，并持久化到 `localStorage`（重启保留）。"重置学习"可恢复初始化权重。
- 初始化探针头离线精度 **98.15%**（162 张权威 Drone-vs-Bird 样本，见判别基准报告第 08 章）。

> 注意：DINOv2 模型约 89 MB，首次加载较慢；JEPA 判别在检出目标后触发（非每帧），以控制 wasm 端侧推理开销。

## 海康威视监控接入（已接入）

把真实海康摄像头的 RTSP 流接入本 App 做实时检测/判别。浏览器无法直接播放 RTSP，故经由本地 **MediaMTX 网关**（`gateway/`）转成低延迟 WebRTC(WHEP) 与高兼容 HLS 两种协议：

- **分工**：MediaMTX 拉海康 RTSP（`gateway/mediamtx.yml` 配置相机 IP/账号）→ WebRTC/WHEP(8889) 或 HLS(8888)；App 端 `whep-client.js` 实现标准 WHEP 信令拉流，失败自动回退 `hls.min.js` 的 HLS。
- **接入方式**：App 点"🔌 海康"填网关地址与流路径（如 `http://网关IP:8889` + `cam1`），选 WebRTC 低延迟或 HLS 兼容，连接后复用同一套 YOLO+JEPA 检测管线。
- **海康 RTSP 地址**：主码流 `rtsp://用户:密码@IP:554/Streaming/Channels/101`，子码流 `.../102`；建议主码流（1080p H.264）检测，H.265 相机需转码（见 `gateway/README.md`）。
- 已用本地 MediaMTX v1.20.0 + H.264 测试流完成 **WHEP 信令端到端验证**（OPTIONS→POST→PATCH→DELETE 全通过）。

网关启动与配置：见 `gateway/README.md`。

## 快速体验（浏览器/手机）

```bash
cd web && python3 -m http.server 8899
# 手机同网段访问 http://<电脑IP>:8899/index.html
# 或直接浏览器打开 web/index.html
```

- 点击 **开始监控** 调用手机相机；或 **📁 视频** 载入本地视频回放。
- 点击 **记录** 打开遥测面板，运行中实时累积事件；**导出 CSV/JSON** 下载记录。
- 变焦滑杆 / ＋－按钮 / 双指捏合直接操作；开启 **目标跟随** 变焦自动锁住已确认目标。

## Android 端

见 `android/README.md`。核心用 WebView 加载共享 `index.html`，`JsBridge` 把遥测写入应用私有目录便于追溯。

## 鸿蒙端

见 `harmony/README.md`。核心用 ArkWeb 组件加载，`javaScriptProxy` 把遥测写入沙箱文件。

> 说明：本工程为**可运行的真实推理核心 + 双端原生壳**。`web/` 核心可独立运行于任意手机浏览器验证全部功能（真机摄像头输出 H.264 可正常播放）；两端原生壳在此沙箱内未编译（无对应 SDK），需在 Android Studio / DevEco Studio 中构建安装。遥测落盘路径见 `android/README.md` 与 `harmony/README.md`。