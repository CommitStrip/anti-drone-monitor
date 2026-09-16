#!/usr/bin/env python3
"""
quantize_opset_convert.py - 量化攻坚第二路径：opset 转换 → QDQ 重试
====================================================================
背景（2026-09-06 结论）：原 yolov8s-drone.onnx 是 opset 12 自定义导出，
QDQ 量化因 per-channel bias 的 DequantizeLinear(axis)（需 opset≥13）产出
非法图；QOperator 量化产图合法但输出恒为零（检出归零），被任务级闸门拦截。

本脚本试的是当时未走的路：
  onnx.version_converter 12→16（机械化重写，不换权重）→ QDQ 静态量化
  → 与 QOperator 同口径的任务级闸门复核。
converter 失败或 QDQ 仍失效 → 输出失败证据，不盲切。

用法: python scripts/quantize_opset_convert.py
"""

import os
import sys

import onnx
import onnxruntime as ort
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quantize_models import (YOLO32, YOLO8, letterbox640, load_frames,
                             bench, mb, nms_final, N_CALIB)

OUT = YOLO8.replace(".onnx", "-qdq.onnx")  # yolov8s-drone-int8-qdq.onnx
CONV = YOLO32.replace(".onnx", "-opset16.onnx")

# 类头排除集（2026-09-06 诊断）：/model.22/Sigmoid 输入的 9 个 cv3 类分支卷积
# 在 MinMax 校准下被压到恒零（框分支 cv2 正常）——单类头 logits 分布极端，
# 激活尺度计算错误地吞掉了分类通道。头部极小，排除代价可忽略。
CLS_HEAD_NODES = [
    f"/model.22/cv3.{h}/cv3.{h}.{i}/conv/Conv" for h in (0, 1, 2) for i in (0, 1)
] + [
    f"/model.22/cv3.{h}/cv3.{h}.2/Conv" for h in (0, 1, 2)
] + [
    f"/model.22/cv3.{h}/cv3.{h}.{i}/act/Mul" for h in (0, 1, 2) for i in (0, 1)
] + [
    f"/model.22/cv3.{h}/cv3.{h}.{i}/act/Sigmoid" for h in (0, 1, 2) for i in (0, 1)
] + ["/model.22/Sigmoid"] + [
    # 2026-09-06 深挖确诊的真凶：输出解码尾部的 per-tensor Q/DQ 把 0-640 的框坐标
    # 与 0-0.78 的类置信共享同一个 scale（≈2.5），0.73/2.5≈0.29 → 取整为 0——
    # 类通道被框坐标尺度碾压成恒零（框通道数值大所以看似正常）。尾部三节点
    # 保持在 fp32，骨干/颈部照常 int8。
    "/model.22/Concat_2", "/model.22/Mul_2", "/model.22/Concat_3",
]


def main():
    print("=" * 64)
    print("[路径2] opset 12→16 转换 → QDQ 静态量化")
    m = onnx.load(YOLO32)
    from onnx import version_converter
    try:
        m16 = version_converter.convert_version(m, 16)
        onnx.save(m16, CONV)
        print(f"  转换成功: {CONV}（{mb(CONV):.1f}MB）")
    except Exception as e:
        print(f"  ❌ version_converter 失败: {type(e).__name__}: {str(e)[:200]}")
        return 1

    try:
        sess = ort.InferenceSession(CONV, providers=["CPUExecutionProvider"])
        print(f"  转换后模型可加载，IO: {sess.get_inputs()[0].shape} → {sess.get_outputs()[0].shape}")
    except Exception as e:
        print(f"  ❌ 转换后模型不可加载: {str(e)[:200]}")
        return 1

    calib = load_frames(N_CALIB, letterbox640)
    in_name = sess.get_inputs()[0].name

    from onnxruntime.quantization import (CalibrationMethod, QuantFormat,
                                          QuantType, quantize_static)
    from onnxruntime.quantization.shape_inference import quant_pre_process

    pre = CONV + ".pre.onnx"
    quant_pre_process(CONV, pre)

    class Reader:
        def __init__(self, data):
            self.items = list(data.items()); self.i = 0
        def get_next(self):
            if self.i >= len(self.items):
                return None
            _, f = self.items[self.i]; self.i += 1
            return {in_name: f}

    quantize_static(pre, OUT, Reader(calib),
                    quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QInt8,
                    weight_type=QuantType.QInt8,
                    per_channel=True,
                    calibrate_method=CalibrationMethod.MinMax,
                    nodes_to_exclude=CLS_HEAD_NODES)
    print(f"  QDQ 体积: {mb(YOLO32):.1f}MB → {mb(OUT):.1f}MB")

    try:
        s8 = ort.InferenceSession(OUT, providers=["CPUExecutionProvider"])
    except Exception as e:
        print(f"  ❌ QDQ 产物仍不可加载: {str(e)[:200]}")
        return 1

    s32 = ort.InferenceSession(YOLO32, providers=["CPUExecutionProvider"])
    ms32 = bench(s32, next(iter(calib.values())))
    ms8 = bench(s8, next(iter(calib.values())))
    print(f"  推理耗时(ORT-CPU 代理): {ms32:.0f}ms → {ms8:.0f}ms（{ms32 / ms8:.2f}×）")

    # 任务级闸门（与 quantize_models 同口径）
    n32 = n8 = 0
    ious = []
    for f in calib.values():
        d32 = nms_final(s32.run(None, {in_name: f})[0])
        d8 = nms_final(s8.run(None, {in_name: f})[0])
        n32 += len(d32); n8 += len(d8)
        for a in d32:
            best = 0.0
            for b in d8:
                xx1 = max(a[0], b[0]); yy1 = max(a[1], b[1])
                xx2 = min(a[2], b[2]); yy2 = min(a[3], b[3])
                inter = max(0, xx2 - xx1) * max(0, yy2 - yy1)
                ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
                best = max(best, inter/ua if ua > 0 else 0.0)
            ious.append(best)
    print(f"  任务级保真度({len(calib)} 帧): fp32 检出 {n32} → int8-QDQ 检出 {n8}"
          + (f"，IoU 均值 {np.mean(ious):.3f} 最小 {min(ious):.3f}" if ious else ""))
    if n32 == 0:
        print("  ⚠ 校准集无检出，校验不可信"); return 1
    ok = n8 >= n32 * 0.9 and (not ious or np.mean(ious) >= 0.8)
    print(f"  QDQ 判定: {'✅ 路径可用，可切换' if ok else '❌ 仍不可用（禁止切换）'}")

    # 同排除集的 QOperator 路径：QLinearConv 融合核在 CPU 上才是真加速
    # （QDQ 逐算子 Q/DQ 转换开销在 CPU 常为负收益——上轮实测 122ms vs fp32 57ms）。
    # 两种格式此前同样死于输出 per-tensor 尺度塌缩，排除集应同样治愈 QOperator。
    OUT_QOP = OUT.replace("-qdq.onnx", "-qop.onnx")
    quantize_static(pre, OUT_QOP, Reader(calib),
                    quant_format=QuantFormat.QOperator,
                    activation_type=QuantType.QUInt8,
                    weight_type=QuantType.QInt8,
                    per_channel=True,
                    calibrate_method=CalibrationMethod.MinMax,
                    nodes_to_exclude=CLS_HEAD_NODES)
    os.remove(pre)
    try:
        sq = ort.InferenceSession(OUT_QOP, providers=["CPUExecutionProvider"])
    except Exception as e:
        print(f"  QOperator 不可加载: {str(e)[:160]}")
        return 0 if ok else 1
    msq = bench(sq, next(iter(calib.values())))
    print(f"  QOperator 推理耗时: {ms32:.0f}ms → {msq:.0f}ms（{ms32 / msq:.2f}×）  "
          f"体积 QDQ={mb(OUT):.1f}MB QOP={mb(OUT_QOP):.1f}MB")

    nq = 0
    qious = []
    for f in calib.values():
        dq = nms_final(sq.run(None, {in_name: f})[0])
        nq += len(dq)
        for a in nms_final(s32.run(None, {in_name: f})[0]):
            best = 0.0
            for b in dq:
                xx1 = max(a[0], b[0]); yy1 = max(a[1], b[1])
                xx2 = min(a[2], b[2]); yy2 = min(a[3], b[3])
                inter = max(0, xx2 - xx1) * max(0, yy2 - yy1)
                ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
                best = max(best, inter/ua if ua > 0 else 0.0)
            qious.append(best)
    print(f"  [QOP] 任务级保真度: fp32 {n32} → QOP {nq}"
          + (f"，IoU 均值 {np.mean(qious):.3f} 最小 {min(qious):.3f}" if qious else ""))
    ok_qop = nq >= n32 * 0.9 and (not qious or np.mean(qious) >= 0.8)
    print(f"  QOperator 判定: {'✅ 可用' if ok_qop else '❌ 不可用'}")
    if not (ok or ok_qop):
        print("  两格式均不可用")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
