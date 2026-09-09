# anti-drone-monitor — 语义摄像头 · 实时场所语义监控（手机端演示）

[![CI](https://github.com/CommitStrip/anti-drone-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/CommitStrip/anti-drone-monitor/actions/workflows/ci.yml)

[English](README.md) | **简体中文**

> **演进说明**：本项目已升级为库系主线 **[semantic-camera](https://github.com/CommitStrip/semantic-camera)**——场所模式语义摄像头平台（模式包化 / 全自动判别 / 时空规则与多相机调度路线）。本仓保留为反无人机单场景演示，冻结维护，Issue 与开发请移步主仓。

把一路实时视频流（海康 RTSP / 手机相机 / 本地视频）变成**端侧实时视频监控 + 触发式非实时重模型判别**的语义摄像头：帧差运动门控 → 触发式 YOLOv8s 检测 → 恒速跟踪 + 多帧确认 → JEPA（DINOv2）全自动语义判别 → 目标跟随变焦。视频显示与帧差门控逐帧实时；重模型按事件触发运行，语义裁决具有秒级有界延迟——这是端侧算力的诚实预算策略，而非逐帧全模型实时。判别按**场所模式包**组织——首包"净空防黑飞"（鸟/机判别与告警），扩展新场所只需新增模式包数据与判别头，不改流水线代码（体系设计见 `docs/semantic-camera-design.md`）。一套 HTML5 核心跑在 onnxruntime-web（纯 wasm，无服务端推理），Android WebView 与 HarmonyOS ArkWeb 双端复用。

当前验证状态：初始化探针头离线精度 **98.15%**（162 张权威 Drone-vs-Bird 样本的**样本集内精度**，证据 `web/jepa_probe_init.json`：acc=0.9815, n_train=162, dim=768；训练/测试划分协议与跨场景泛化评测待入档，不外推为系统能力）；WHEP 信令已用本地 MediaMTX v1.20.0 + H.264 测试流完成端到端验证（信令与传输路径，非真实场景检出评测）；**36 例单元测试 + GitHub Actions CI 全绿**。真机端到端帧率/延迟实测**待回填**——遥测已内置逐帧采集（见[性能与验证状态](#性能与验证状态)）。

## 核心能力

| 能力 | 说明 |
|------|------|
| 实时检测 | 帧差运动门控(快) → 触发式检测(慢)：有运动 400ms 即检、无运动 5s 巡检兜底，运动面积门槛 0.003 抗传感器噪声 |
| 目标跟踪 | IoU + 中心距离关联 + 恒速预测（大检测间隔不丢轨迹），多帧确认(≥2 次)降假阳性；已确认目标 12s 存活窗，悬停不丢 |
| 全自动语义判别 | JEPA 四态裁决：告警 / 待仲裁 / 判明非目标 / 静默——**流水线无人工判定环节**；灰区入仲裁队列（预算硬上限），高置信双信号一致自动自训练探针 |
| 丝滑变焦 | 捏合/滑块/按钮 + **目标跟随**自动居中，平滑插值 1×-8× |
| 距离估算 | 针孔模型按类别尺寸粗估（无人机 0.35m / 鸟 0.20m）；数字变焦是中心裁剪，不影响读数 |
| 性能记录 | 每帧 fps / 各阶段延迟 / 门控运动占比 / 检出事件 / 确认事件 / 变焦档位 |
| 效果记录 | 检出目标类别/置信度/距离，确认告警时间线 |
| 数据可追溯 | IndexedDB 落盘 + CSV/JSON 导出 + 原生桥接落盘（Android JSONL / 鸿蒙 CSV） |

## 系统组成

```
drone-monitor-app/
├── web/index.html        # 共享 HTML5 核心（两端 WebView 复用）
├── web/core.js           # 纯逻辑核心（配置/跟踪/门控，node:test 可单测）
├── gateway/              # MediaMTX 网关：海康 RTSP → WebRTC(WHEP)/HLS
├── android/              # Android 工程（Kotlin WebView 封装 + 遥测落盘）
└── harmony/              # HarmonyOS(NEXT) 工程（ArkWeb 封装 + 遥测落盘）
```

> 修改 `web/` 下共享文件后，运行 `bash scripts/sync-web.sh` 同步 android/harmony 打包副本；CI 用 `--check` 强制校验三副本一致性。

## 工作原理

快系统在 96×54 降采样灰度图上逐帧帧差（阈值 25、面积门槛 0.003 ≈ 15px），**有运动 400ms 即检、无运动 5s 巡检兜底**；慢系统对触发帧跑 YOLOv8s（640 letterbox → 类内 NMS），检出经 IoU + 中心距匹配（恒速预测跨越 0.4~5s 检测间隔、0.35 归一化匹配闸门防远目标吞并），连续 2 帧确认——悬停目标靠巡检续命（已确认轨迹 12s 存活窗），不会因老化反复清零。检测始终在全帧进行，数字变焦只是 overlay 中心裁剪，不影响检测与测距。

## 真实模型推理（已接入）

核心内置真实 **YOLOv8s 无人机检测模型**（`web/yolov8s-drone.onnx`，43MB，onnxruntime-web + wasm），替换掉先前的合成 `MotionDetector`。完整链路：letterbox 预处理 → 模型推理 → 坐标/类别解析 → 类内 NMS → IoU 跟踪确认 → 目标跟随变焦。推理耗时与检出结果实时写入遥测；wasm 线程按 `SharedArrayBuffer` 可用性自适应（WebView file:// 下自动单线程）。

## JEPA 全自动判别 + 自动进化（已接入）

在 YOLO 定位之上叠加 **JEPA 风格自监督判别**（`web/dinov2_vits14_feat.onnx`，85MB，DINOv2-ViT-S 特征提取器 + `web/jepa_probe_init.json` 线性探针头）：

- **分工**：YOLO 负责定位（检测候选框），DINOv2 负责判别（对候选框 crop 提 768 维特征，经探针头输出置信度并参与四态裁决）。
- **四态全自动裁决**（设计红线：判别流水线任何环节不得依赖人工判定）：探针输出 P(正类)，裁决器给出 `alert`（目标侧高置信 → 告警）/ `escalate`（目标侧置信不足 → **弃权待仲裁**，宁可不报不可虚报）/ `clear`（判明非目标 → 抑制告警）/ `suppress`（静默）四种语义态；判别结果未出前检测器权威（防漏报）。
- **自动进化（无人工回路）**：在冻结的 DINOv2 特征上，当 logreg 头与原型距离**双信号一致且置信 ≥0.90** 时自动更新探针头（质心滑动平均 + logreg 单步 SGD，梯度下降），持久化到 `localStorage`（重启保留）；"重置学习"恢复初始化权重（运维操作）。人工判定按钮已废除。
- **灰区仲裁队列**：`escalate` 案件按预算硬上限（20 件/小时）+ 按轨迹去重（15s TTL）排队，事件落遥测（CSV/JSON 可导出）；M2 接入 vus 慢脑 VLM 仲裁后，结论将作为伪标签回灌探针（见 `docs/semantic-camera-design.md` 里程碑）。
- 初始化探针头离线精度 **98.15%**（162 张权威 Drone-vs-Bird 样本；证据见仓库内 `web/jepa_probe_init.json`：acc=0.9815, n_train=162, dim=768）。

> 注意：DINOv2 模型约 85 MB；**懒加载**——开场不加载，首次确认目标时才拉起（HUD 显示 load…）；判别只对**多帧确认后的目标**触发（首次确认立即判别，此后每 30s 刷新一次，非每帧/非每次检出），以控制 wasm 端侧推理开销。

## 海康威视监控接入（已验证）

把真实海康摄像头的 RTSP 流接入本 App 做实时检测/判别。浏览器无法直接播放 RTSP，故经由本地 **MediaMTX 网关**（`gateway/`）转成低延迟 WebRTC(WHEP) 与高兼容 HLS 两种协议：

- **分工**：MediaMTX 拉海康 RTSP（`gateway/mediamtx.yml` 配置相机 IP/账号）→ WebRTC/WHEP(8889) 或 HLS(8888)；App 端 `whep-client.js` 实现标准 WHEP 信令拉流（指数退避重连：2s 起步、封顶 30s），失败自动回退 `hls.min.js` 的 HLS。
- **接入方式**：App 点"🔌 海康"填网关地址与流路径（如 `http://网关IP:8889` + `cam1`），选 WebRTC 低延迟或 HLS 兼容，连接后复用同一套 YOLO+JEPA 检测管线。
- **海康 RTSP 地址**：主码流 `rtsp://用户:密码@IP:554/Streaming/Channels/101`，子码流 `.../102`；建议主码流（1080p H.264）检测，H.265 相机需转码（见 `gateway/README.md`）。
- 已用本地 MediaMTX v1.20.0 + H.264 测试流完成 **WHEP 信令端到端验证**（OPTIONS→POST→PATCH→DELETE 全通过）。

网关启动与配置：见 `gateway/README.md`。

## 快速体验（浏览器 / 手机）

```bash
cd web && python3 -m http.server 8899
# 手机同网段访问 http://<电脑IP>:8899/index.html
# 或直接浏览器打开 web/index.html
```

- 点击 **开始监控** 调用手机相机；或 **📁 视频** 载入本地视频回放。
- 点击 **记录** 打开遥测面板，运行中实时累积事件；**导出 CSV/JSON** 下载记录。
- 变焦滑杆 / ＋－按钮 / 双指捏合直接操作；开启 **目标跟随** 变焦自动锁住已确认目标。

## 双端原生壳

### Android 端

见 `android/README.md`。核心用 WebView 加载共享 `index.html`，`JsBridge` 把遥测以 JSONL 写入应用私有目录便于追溯；相机经 `WebChromeClient.onPermissionRequest` 显式授予（WebView 默认拒绝 getUserMedia）。

### 鸿蒙端

见 `harmony/README.md`。核心用 ArkWeb 组件加载，`javaScriptProxy` 把遥测写入沙箱 CSV；相机经 `onPermissionRequest` 授权 + `EntryAbility` 运行时请求 `ohos.permission.CAMERA`。

> 说明：本工程为**可运行的真实推理核心 + 双端原生壳**。`web/` 核心可独立运行于任意手机浏览器验证全部功能；两端原生壳需在 Android Studio / DevEco Studio 中构建安装（仓库不附带构建产物）。

## 开发：测试、CI 与多端副本同步

```bash
node --test tests/core.test.mjs     # 36 例单测（node:test，零依赖）
bash scripts/sync-web.sh            # web/ → android assets + harmony rawfile
bash scripts/sync-web.sh --check    # 只校验一致性（CI 同款）
```

CI（node 20/22 矩阵）：JS 语法检查 → 单元测试 → 三副本一致性校验。纯逻辑（配置/IoU/跟踪器/门控/估距/四态裁决/仲裁队列/探针学习数学）全部抽在 `web/core.js`，零 DOM 依赖可直接单测；`index.html` 内联脚本有语法守护测试。

运维与安全治理（冻结维护版）：

- **探针更新带证据链**——每次自动更新先快照上一版（`jepa_probe_prev`）、写审计日志（`jepa_probe_log`：时间/来源/前后置信/类间距比，上限 20 条），UI 提供"撤销学习"单步回滚；生产化受控学习（候选池/灰度发布）归主线。
- **凭据不落明文**——海康网关密码只进 `sessionStorage`（关闭页面即清），地址/路径/用户名才持久化，历史版本明文密码在连接时自动清除。
- **模型资产许可**——捆绑权重随上游（AGPL-3.0 / CC-BY-NC 4.0），清单与哈希见 `MODEL_MANIFEST.json`，条款详情见 `THIRD_PARTY_NOTICES.md`。

## 性能与验证状态

| 项 | 状态 |
|----|------|
| WHEP 信令端到端 | ✅ 已验证（MediaMTX v1.20.0 + H.264 测试流，OPTIONS→POST→PATCH→DELETE 全通过） |
| 探针头离线精度 | ✅ 98.15%（162 样本，`web/jepa_probe_init.json`） |
| 单元测试 / CI | ✅ 36 例全绿，node 20/22 矩阵 |
| 真机帧率/延迟 | ⏳ 待回填——遥测已逐帧采集 `detMs/trackMs/motionRatio`，导出 CSV/JSON 即为实测数据 |

模型体积与策略：YOLOv8s fp32 43MB + DINOv2 85MB，wasm 端单次推理为秒级——因此检测是**触发式**（门控+冷却）而非逐帧，JEPA 只对确认目标判别且懒加载。

**int8 量化实测结论（2026-09-06，`scripts/quantize_models.py`）**：现模型为 opset 12 的自定义导出，**量化后不可用**——QOperator 路径体积 42.7→10.9MB、推理 62→34ms（1.8×），但 NMS 后检出数 41→0（输出恒为零）。校验工具已内置任务级闸门（检出数不降 10% 且 IoU≥0.8 才允许切换）防止此类静默失效混入。帧率提升需要用 ultralytics 在训练环境以现代 opset 重导出 yolov8n（预期体积/耗时再降一个量级），DINOv2 int8 同样受量化器算子兼容性限制保持 fp32（它只对确认目标运行，开销已可控）。

## 平台与硬件

浏览器需支持 WASM 与 WebRTC（Android 8+ WebView / 现代桌面浏览器均可）；鸿蒙端需 HarmonyOS NEXT + ArkWeb。无 GPU 依赖，推理全部 wasm CPU。

## 致谢与版权

- [MediaMTX](https://github.com/bluenviron/mediamtx)——RTSP → WebRTC/HLS 流媒体网关（MIT）。本仓库仅在 `gateway/` 提供配置与启动脚本。
- [onnxruntime-web](https://github.com/microsoft/onnxruntime)——wasm 端推理引擎（MIT）。
- [hls.js](https://github.com/video-dev/hls.js)——HLS 回退播放（Apache-2.0）。
- [DINOv2](https://github.com/facebookresearch/dinov2) ViT-S/14（Meta AI）——判别特征提取器；上游代码 Apache-2.0，官方权重为 CC-BY-NC 4.0（非商业）。本仓库的 `dinov2_vits14_feat.onnx` 为其特征塔导出，再分发与商用请自行核实上游条款。
- [YOLOv8 / ultralytics](https://github.com/ultralytics/ultralytics)——检测模型架构（AGPL-3.0）。本仓库的 `yolov8s-drone.onnx` 为在其架构上微调导出的无人机检测权重，再分发与商用须遵守 AGPL-3.0 及上游条款。

## License

MIT © 2026（适用于仓库代码；仓库内捆绑的模型权重 `*.onnx` 许可随上游，见上节）
