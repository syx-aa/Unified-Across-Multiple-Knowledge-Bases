# -*- coding: utf-8 -*-
"""
_tmp_vectors_onnx.py — 用 ONNX Runtime 重跑 chunk / 问题向量（临时脚本）

背景：本机 Python 3.14 装不上 transformers（依赖需源码编译），
      build_vectors.py 的 torch+transformers 路径跑不了；
      但 vector/models/bge-small-zh-v1.5/model.onnx 存在，故走 ONNX 推理。

算法与 build_vectors.py 完全一致：CLS 池化 + L2 归一化，
输入文本拼法（标题\n正文、clean 规则）、问题指令前缀、输出格式均保持一致。
唯一差异：不写 Chroma（server.py 实际读的是 vectors.json 内存索引）。
"""
import json
import os
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VDIR = os.path.join(ROOT, "vector")
MDIR = os.path.join(VDIR, "models", "bge-small-zh-v1.5")
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："


def clean(text):
    return text.replace("[[", "").replace("]]", "").replace("\n", " ").strip()


def encode(sess, tok, texts, batch_size=64):
    vecs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        encs = tok.encode_batch(batch)
        feed = {
            "input_ids": np.array([e.ids for e in encs], dtype=np.int64),
            "attention_mask": np.array([e.attention_mask for e in encs], dtype=np.int64),
            "token_type_ids": np.array([e.type_ids for e in encs], dtype=np.int64),
        }
        out = sess.run(["last_hidden_state"], feed)[0]
        v = out[:, 0]                                    # CLS
        v = v / np.linalg.norm(v, axis=1, keepdims=True)  # L2 归一化
        vecs.append(v.astype(np.float32))
        if (i // batch_size) % 8 == 0:
            print(f"  已编码 {min(i + batch_size, len(texts))}/{len(texts)}")
    return np.vstack(vecs)


def main():
    t0 = time.time()
    with open(os.path.join(VDIR, "docs.json"), "r", encoding="utf-8") as f:
        docs = json.load(f)["docs"]

    chunk_texts, chunk_meta = [], []
    for d in docs:
        title = clean(d["title"])
        for c in d["chunks"]:
            text = clean(c["r"])
            if not text:
                continue
            chunk_texts.append(f"{title}\n{text}")
            chunk_meta.append({"doc_id": d["id"], "title": d["title"],
                               "kind": d["kind"], "chunk_i": c["i"]})
    print(f"待编码 chunk：{len(chunk_texts)} 个")

    tok = Tokenizer.from_file(os.path.join(MDIR, "tokenizer.json"))
    tok.enable_truncation(max_length=512)
    tok.enable_padding(pad_id=0, pad_token="[PAD]")
    sess = ort.InferenceSession(os.path.join(MDIR, "model.onnx"),
                                providers=["CPUExecutionProvider"])

    chunk_vecs = encode(sess, tok, chunk_texts)
    print(f"chunk 向量完成：{chunk_vecs.shape}，耗时 {time.time() - t0:.1f}s")

    with open(os.path.join(ROOT, "tests", "eval_cases.json"), "r", encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    q_vecs = encode(sess, tok, [QUERY_INSTRUCTION + c["q"] for c in cases], batch_size=32)
    print(f"问题向量完成：{q_vecs.shape}")

    out = {
        "model": "bge-small-zh-v1.5",
        "dim": int(chunk_vecs.shape[1]),
        "queryInstruction": QUERY_INSTRUCTION.strip(),
        "chunks": [
            {"doc": m["doc_id"], "i": m["chunk_i"], "v": [round(float(x), 5) for x in v]}
            for m, v in zip(chunk_meta, chunk_vecs)
        ],
        "queries": {
            c["id"]: [round(float(x), 5) for x in v]
            for c, v in zip(cases, q_vecs)
        },
    }
    out_path = os.path.join(VDIR, "vectors.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"vectors.json 导出完成 → {out_path}")
    print(f"总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
