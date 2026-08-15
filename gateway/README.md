# 海康威视接入网关（MediaMTX）

把海康摄像头的 **RTSP** 流转换成浏览器 / 鸿蒙 ArkWeb 能直接播放的 **WebRTC(WHEP)** 与 **HLS**。
浏览器无法直接播放 RTSP，必须经过本网关。

## 拓扑

```
海康摄像头 (RTSP) ──拉流──> MediaMTX 网关 ──WebRTC/WHEP(8889)──> 鸿蒙App/浏览器 (YOLO+JEPA)
                                        └──HLS(8888)──> 回退
```

## 端口

| 协议 | 端口 | 用途 |
|------|------|------|
| RTSP | 8554 | 对外/拉流端口 |
| RTMP | 1935 | 备用推流 |
| HLS | 8888 | App 端 HLS 回退播放 |
| WebRTC/WHEP | 8889 | App 端低延迟播放（优先） |

## 快速启动

```bash
# 1) 先编辑 mediamtx.yml，把海康相机 IP / 账号 / 密码填进去
# 2) 一键启动（有 Docker 用 Docker，否则用本机 mediamtx 二进制）
./start.sh
```

## 海康 RTSP 地址格式

- 主码流：`rtsp://<用户>:<密码>@<相机IP>:554/Streaming/Channels/101`
- 子码流：`rtsp://<用户>:<密码>@<相机IP>:554/Streaming/Channels/102`
- ISAPI ：`rtsp://<用户>:<密码>@<相机IP>:554/ISAPI/Streaming/channels/101`

建议用 **主码流**（通常 1080p H.264）检测以提高精度。若相机为 **H.265** 且目标浏览器不支持 HEVC，需开启转码（见 `mediamtx.yml` 中的 `runOnDemand` 注释，依赖系统安装 ffmpeg）。

## 在 App 端接入

App 面板中填：

- 网关地址：`http://<网关IP>:8889`
- 流路径：与 `mediamtx.yml` 中 `paths` 下的名称一致（如 `cam1`）

App 默认用 **WebRTC 低延迟**，失败自动回退 **HLS**。

## 无相机时本地验证

```bash
# 用一段 mp4 推一路 RTSP 到网关（模拟海康）
ffmpeg -re -stream_loop -1 -i /path/to/test.mp4 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 30 -an \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/cam1
# 然后 App 里填 网关 http://localhost:8889 , 路径 cam1
```

参见 `web/` 下 `whep-client.js`（WHEP 客户端）与 `hls.min.js`（HLS 回退）。