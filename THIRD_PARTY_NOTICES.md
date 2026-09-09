# THIRD_PARTY_NOTICES — 第三方组件与模型许可声明

本仓库代码采用 MIT（见 `LICENSE`）。仓库**捆绑的模型权重与运行时资产**来自第三方，许可随上游，不随 MIT——分发/商用前请逐项核对。哈希与大小见 `MODEL_MANIFEST.json`。

## 运行时 / 库

| 组件 | 用途 | 许可 | 来源 |
|---|---|---|---|
| onnxruntime-web | wasm 端推理引擎 | MIT | https://github.com/microsoft/onnxruntime |
| hls.min.js | HLS 回退播放 | Apache-2.0 | https://github.com/video-dev/hls.js |
| MediaMTX（gateway 外部依赖，不入库） | RTSP → WebRTC/HLS 网关 | MIT | https://github.com/bluenviron/mediamtx |
| OpenCV（Android/iOS 系统侧如用到） | 视频处理 | Apache-2.0 | https://opencv.org |

## 捆绑模型权重

| 文件 | 来源与导出 | 许可 | 商用提示 |
|---|---|---|---|
| `web/yolov8s-drone.onnx`（及双端打包副本） | ultralytics YOLOv8s 架构上微调的无人机检测权重，opset 12 自定义导出 | **AGPL-3.0**（ultralytics 声明其训练权重同受 AGPL 约束） | AGPL 具传染性：以本权重构建的服务对外提供时须开放对应源码；闭源商用需向 ultralytics 购买商业授权或自行重训替代 |
| `web/dinov2_vits14_feat.onnx`（及双端打包副本） | facebookresearch/dinov2 ViT-S/14 视觉塔特征导出 | 上游代码 Apache-2.0；**官方权重 CC-BY-NC 4.0（非商业）** | 非 NC 许可下仅限非商业用途；商用需自行获得授权或以替代特征塔重导出 |
| `web/jepa_probe_init.json` | 本项目离线训练的线性探针头（162 样本，acc=0.9815） | MIT（项目数据） | 注意：其效力建立在上述 DINOv2 特征之上，继承上游限制 |

## 其他说明

- 探针的**运行时在线更新**（自训练/回滚）产生的是本仓库自有数据（特征派生），但派生自上述特征塔，商业化时整体按最严格的上游约束评估。
- 打包副本（`android/app/src/main/assets/web/`、`harmony/entry/src/main/resources/rawfile/`）与 `web/` 源逐字节一致（CI 强制校验），许可声明同等适用。
- 许可条目如与上游最新条款冲突，以**上游仓库当前 LICENSE 为准**——本文件是快照式指引，不是法律意见。
