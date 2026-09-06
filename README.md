# anti-drone-monitor — Realtime Anti-Drone Monitoring (Phone Demo)

[![CI](https://github.com/CommitStrip/anti-drone-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/CommitStrip/anti-drone-monitor/actions/workflows/ci.yml)

**English** | [简体中文](README-CN.md)

Turn a live video stream (Hikvision RTSP / phone camera / local video) into **on-device realtime drone detection and alerting**: frame-difference motion gating → triggered YOLOv8s detection → constant-velocity tracking + multi-frame confirmation → JEPA (DINOv2) bird/drone discrimination → target-following zoom. One HTML5 core runs on onnxruntime-web (pure wasm, no server-side inference), reused by both an Android WebView shell and a HarmonyOS ArkWeb shell.

Current validation status: probe-head offline accuracy **98.15%** (162 authoritative Drone-vs-Bird samples, evidence `web/jepa_probe_init.json`: acc=0.9815, n_train=162, dim=768); WHEP signaling verified end-to-end against a local MediaMTX v1.20.0 + H.264 test stream; **21 unit tests + GitHub Actions CI all green**. On-device end-to-end fps/latency benchmarks are **pending** — per-frame telemetry is already built in (see [Performance & validation status](#performance--validation-status)).

## Key capabilities

| Capability | Description |
|------|------|
| Realtime detection | Frame-difference gate (fast) → triggered detection (slow): motion fires detection within 400 ms, a 5 s patrol covers stillness; motion-area floor 0.003 suppresses sensor noise |
| Target tracking | IoU + center-distance association + constant-velocity prediction (no track loss across long detection gaps), multi-frame confirmation (≥2) cuts false positives; confirmed targets get a 12 s survival window — hovering targets are not lost |
| Smooth zoom | Pinch / slider / buttons + **target-following** auto-centering, smooth interpolation 1×-8× |
| Distance estimation | Pinhole model with per-class size (drone 0.35 m / bird 0.20 m); digital zoom is a center crop and does not affect the reading |
| Performance recording | Per-frame fps / stage latencies / gate motion ratio / detection events / confirmation events / zoom level |
| Effect recording | Detected class / confidence / distance, confirmation-alert timeline |
| Data traceability | IndexedDB persistence + CSV/JSON export + native bridge (Android JSONL / Harmony CSV) |

## System layout

```
drone-monitor-app/
├── web/index.html        # shared HTML5 core (reused by both WebViews)
├── web/core.js           # pure-logic core (config/tracking/gating; node:test-able)
├── gateway/              # MediaMTX gateway: Hikvision RTSP → WebRTC(WHEP)/HLS
├── android/              # Android app (Kotlin WebView shell + telemetry)
└── harmony/              # HarmonyOS(NEXT) app (ArkWeb shell + telemetry)
```

> After editing shared files under `web/`, run `bash scripts/sync-web.sh` to sync the android/harmony packaged copies; CI enforces consistency with `--check`.

## How it works

The fast system runs frame differencing every frame on a 96×54 downscaled grayscale image (threshold 25, area floor 0.003 ≈ 15 px) — **motion fires detection within 400 ms; stillness falls back to a 5 s patrol**. The slow system runs YOLOv8s on triggered frames (640 letterbox → class-wise NMS); detections are matched by IoU + center distance (constant-velocity prediction bridges the 0.4–5 s detection gaps, a 0.35 normalized matching gate prevents distant targets from being swallowed), confirmed after 2 consecutive frames — hovering targets stay alive via the patrol (confirmed tracks survive 12 s) instead of being reset by aging. Detection always runs on the full frame; digital zoom is only a center crop of the overlay and does not affect detection or ranging.

## Real model inference (integrated)

The core ships a real **YOLOv8s drone-detection model** (`web/yolov8s-drone.onnx`, 43 MB, onnxruntime-web + wasm), replacing the earlier synthetic `MotionDetector`. Full chain: letterbox preprocessing → inference → box/class parsing → class-wise NMS → IoU tracking & confirmation → target-following zoom. Inference time and detections stream into telemetry; wasm threads adapt to `SharedArrayBuffer` availability (single-threaded under WebView file://).

## JEPA discrimination + online learning (integrated)

On top of YOLO localization, a **JEPA-style self-supervised discriminator** (`web/dinov2_vits14_feat.onnx`, 85 MB, DINOv2-ViT-S feature extractor + `web/jepa_probe_init.json` linear probe head):

- **Division of labor**: YOLO localizes (candidate boxes), DINOv2 discriminates (768-d features per crop → probe head → bird/drone confidence on the HUD).
- **JEPA post-training**: onnxruntime-web supports inference only and cannot fine-tune the backbone, so "post-training" lands as **online lifelong learning** — on frozen DINOv2 features, user feedback ("🕊 bird / 🛸 drone") incrementally updates the probe head (centroid moving average + one-step SGD on the logreg head), persisted to `localStorage` (survives restarts). Feedback is bound to a target with a 15 s validity window to prevent mislabeling. "Reset learning" restores the initial weights.
- Probe-head offline accuracy **98.15%** (162 authoritative Drone-vs-Bird samples; evidence in-repo at `web/jepa_probe_init.json`: acc=0.9815, n_train=162, dim=768).

> Note: the DINOv2 model is ~85 MB; it is **lazy-loaded** — nothing is loaded at startup, the model is fetched on first confirmed target (HUD shows load…); discrimination runs only on **multi-frame-confirmed targets** (immediately on first confirmation, then refreshed every 30 s — not per frame, not per detection) to bound wasm-side inference cost.

## Hikvision RTSP intake (verified)

Feed a real Hikvision camera's RTSP stream into the app for live detection/discrimination. Browsers cannot play RTSP directly, so a local **MediaMTX gateway** (`gateway/`) converts it into low-latency WebRTC (WHEP) and highly compatible HLS:

- **Division of labor**: MediaMTX pulls the Hikvision RTSP stream (camera IP/credentials in `gateway/mediamtx.yml`) → WebRTC/WHEP (8889) or HLS (8888); the app's `whep-client.js` implements standard WHEP signaling (exponential-backoff reconnect: 2 s start, 30 s cap) and falls back to `hls.min.js` HLS on failure.
- **How to connect**: tap "🔌 海康" in the app, enter the gateway address and stream path (e.g. `http://gatewayIP:8889` + `cam1`), pick WebRTC low-latency or HLS compatible — the same YOLO+JEPA pipeline runs on top.
- **Hikvision RTSP URLs**: main stream `rtsp://user:pass@IP:554/Streaming/Channels/101`, sub-stream `.../102`; the main stream (1080p H.264) is recommended for detection; H.265 cameras need transcoding (see `gateway/README.md`).
- Verified end-to-end with local MediaMTX v1.20.0 + an H.264 test stream (**full WHEP signaling**: OPTIONS→POST→PATCH→DELETE all pass).

Gateway startup and configuration: see `gateway/README.md`.

## Quick start (browser / phone)

```bash
cd web && python3 -m http.server 8899
# on a phone in the same network, open http://<PC-IP>:8899/index.html
# or open web/index.html directly in a browser
```

- Tap **▶ Start** to use the phone camera, or **📁 Video** to load a local video.
- Tap **⏺ Record** to open the telemetry panel; events accumulate live; **export CSV/JSON** to download.
- Zoom via slider / ＋− buttons / two-finger pinch; enable **target-following** to auto-center on confirmed targets.

## Native shells

### Android

See `android/README.md`. The core runs in a WebView loading the shared `index.html`; a `JsBridge` writes telemetry as JSONL into app-private storage; the camera is granted explicitly via `WebChromeClient.onPermissionRequest` (WebView rejects getUserMedia by default).

### HarmonyOS

See `harmony/README.md`. The core runs in an ArkWeb component; `javaScriptProxy` writes telemetry to sandboxed CSV; the camera is granted via `onPermissionRequest` plus a runtime `ohos.permission.CAMERA` request in `EntryAbility`.

> Note: this project is a **runnable real-inference core + two native shells**. The `web/` core runs standalone in any phone browser and exercises every feature; the native shells must be built in Android Studio / DevEco Studio (no build artifacts are shipped in the repo).

## Development: tests, CI and multi-copy sync

```bash
node --test tests/core.test.mjs     # 21 unit tests (node:test, zero deps)
bash scripts/sync-web.sh            # web/ → android assets + harmony rawfile
bash scripts/sync-web.sh --check    # consistency check only (same as CI)
```

CI (node 20/22 matrix): JS syntax checks → unit tests → three-copy consistency. All pure logic (config/IoU/tracker/gate/ranging) lives in `web/core.js` with zero DOM dependencies, directly unit-testable; the `index.html` inline script has a syntax-guard test.

## Performance & validation status

| Item | Status |
|----|------|
| WHEP signaling end-to-end | ✅ verified (MediaMTX v1.20.0 + H.264 test stream, OPTIONS→POST→PATCH→DELETE all pass) |
| Probe-head offline accuracy | ✅ 98.15% (162 samples, `web/jepa_probe_init.json`) |
| Unit tests / CI | ✅ 21 tests green, node 20/22 matrix |
| On-device fps/latency | ⏳ pending — telemetry already records per-frame `detMs/trackMs/motionRatio`; export CSV/JSON for measured data |

Model size & strategy: YOLOv8s fp32 43 MB + DINOv2 85 MB; a single wasm-side inference takes seconds — hence detection is **trigger-based** (gating + cooldown) rather than per-frame, and JEPA runs only on confirmed targets with lazy loading. The next fps lever is swapping in quantized lightweight weights (todo).

## Platforms & hardware

Browsers need WASM and WebRTC (Android 8+ WebView / modern desktop browsers); the HarmonyOS shell needs HarmonyOS NEXT + ArkWeb. No GPU dependency — all inference is wasm CPU.

## Acknowledgments

- [MediaMTX](https://github.com/bluenviron/mediamtx) — RTSP → WebRTC/HLS streaming gateway (MIT). This repo only ships configuration and a launch script under `gateway/`.
- [onnxruntime-web](https://github.com/microsoft/onnxruntime) — wasm inference engine (MIT).
- [hls.js](https://github.com/video-dev/hls.js) — HLS fallback playback (Apache-2.0).
- [DINOv2](https://github.com/facebookresearch/dinov2) ViT-S/14 (Meta AI) — discrimination feature extractor; upstream code is Apache-2.0 while the official weights are CC-BY-NC 4.0 (non-commercial). `dinov2_vits14_feat.onnx` in this repo is an export of its vision tower; verify upstream terms before redistribution or commercial use.
- [YOLOv8 / ultralytics](https://github.com/ultralytics/ultralytics) — detection architecture (AGPL-3.0). `yolov8s-drone.onnx` in this repo is a fine-tuned drone-detection export of that architecture; redistribution and commercial use must comply with AGPL-3.0 and upstream terms.

## License

MIT © 2026 (applies to the repository code; the bundled model weights `*.onnx` follow their upstream licenses — see Acknowledgments)
