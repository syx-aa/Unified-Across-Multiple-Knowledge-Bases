"""export_onnx.py — 把 bge-small-zh-v1.5 导出为 ONNX 并做 int8 动态量化

torch 路径（本地完整版）与 onnx 路径（轻量部署）共用同一模型，
量化后 ~24MB，推理用 onnxruntime（纯 CPU，免 torch/CUDA 依赖）。

运行：python build/export_onnx.py
产物：vector/models/bge-small-zh-v1.5/model.onnx + model_int8.onnx
"""
import os
import sys

import numpy as np
import torch
from transformers import AutoTokenizer, AutoModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT, "vector", "models", "bge-small-zh-v1.5")
FP32 = os.path.join(MODEL_DIR, "model.onnx")
INT8 = os.path.join(MODEL_DIR, "model_int8.onnx")

tok = AutoTokenizer.from_pretrained(MODEL_DIR)
model = AutoModel.from_pretrained(MODEL_DIR)
model.eval()

if not os.path.exists(FP32):
    dummy = tok(["为这个句子生成表示以用于检索相关文章：世界杯"], return_tensors="pt")
    torch.onnx.export(
        model,
        (dummy["input_ids"], dummy["attention_mask"], dummy["token_type_ids"]),
        FP32,
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "token_type_ids": {0: "batch", 1: "seq"},
            "last_hidden_state": {0: "batch", 1: "seq"},
        },
        opset_version=17,
    )
    print("fp32 ONNX 导出完成")

if not os.path.exists(INT8):
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        quantize_dynamic(FP32, INT8, weight_type=QuantType.QInt8)
        print("int8 量化完成")
    except Exception as e:
        print(f"int8 量化跳过（{type(e).__name__}: {e}）—— 云端改用 fp32 ONNX")

# 精度校验：与 torch CLS 向量的平均余弦应 > 0.999
import onnxruntime as ort
enc = tok(["为这个句子生成表示以用于检索相关文章：阿根廷26人大名单都有谁", "普通短句"],
          padding=True, truncation=True, max_length=512, return_tensors="np")
feed = {k: enc[k].astype(np.int64) for k in ("input_ids", "attention_mask", "token_type_ids")}
with torch.no_grad():
    ref = model(**{k: torch.from_numpy(v) for k, v in feed.items()}).last_hidden_state[:, 0].numpy()
ref = ref / np.linalg.norm(ref, axis=1, keepdims=True)
for name, path in [("fp32", FP32), ("int8", INT8)]:
    if not os.path.exists(path):
        continue
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out = sess.run(["last_hidden_state"], feed)[0][:, 0]
    out = out / np.linalg.norm(out, axis=1, keepdims=True)
    cos = float((ref * out).sum(axis=1).mean())
    print(f"{name}: 与 torch CLS 向量平均余弦 = {cos:.6f} · 文件 {os.path.getsize(path)/1e6:.1f}MB")
    assert cos > 0.999, f"{name} 精度不足"
print("ONNX 校验全部通过")
