"""build_vectors.py — 文档 chunk 向量化并写入 Chroma 向量数据库

流程：
  1. 读 vector/docs.json（由 build/export_docs.js 从 data.js 导出）
  2. 用 bge-small-zh-v1.5 对每个 chunk（标题 + 正文）计算 embedding
  3. 全部写入 Chroma 持久化库 vector/chroma_db（collection: worldcup）
  4. 对 120 道评测题计算问题向量（带 BGE 官方检索指令前缀）
  5. 导出 vector/vectors.json 供 Node 评测脚本做融合检索

运行：python build/build_vectors.py
"""
import json
import os
import sys
import time

import numpy as np
import torch
from transformers import AutoTokenizer, AutoModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VDIR = os.path.join(ROOT, "vector")
MODEL_DIR = os.path.join(VDIR, "models", "bge-small-zh-v1.5")
CHROMA_DIR = os.path.join(VDIR, "chroma_db")
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："


def load_docs():
    with open(os.path.join(VDIR, "docs.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def clean(text):
    """去掉清洗残留的 [[ ]] 标记，正文换行合并为空格"""
    return text.replace("[[", "").replace("]]", "").replace("\n", " ").strip()


@torch.no_grad()
def encode(model, tokenizer, texts, batch_size=64, max_len=512):
    """CLS 池化 + L2 归一化（BGE 官方用法）"""
    vecs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        enc = tokenizer(batch, padding=True, truncation=True, max_length=max_len,
                        return_tensors="pt")
        out = model(**enc)
        v = out.last_hidden_state[:, 0]          # CLS
        v = torch.nn.functional.normalize(v, p=2, dim=1)
        vecs.append(v.cpu().numpy().astype(np.float32))
        if (i // batch_size) % 4 == 0:
            print(f"  已编码 {min(i + batch_size, len(texts))}/{len(texts)}")
    return np.vstack(vecs)


def main():
    global VDIR, CHROMA_DIR
    import argparse as _ap
    _p = _ap.ArgumentParser(description="chunk 向量化（可按库输出目录）")
    _p.add_argument("--vd", default=VDIR, help="向量库目录，默认 vector/")
    _p.add_argument("--docs", default=None, help="docs.json 路径，默认 <vd>/docs.json")
    _p.add_argument("--out", default=None, help="输出 vectors.json，默认 <vd>/vectors.json")
    _a = _p.parse_args()
    VDIR = _a.vd
    CHROMA_DIR = os.path.join(VDIR, "chroma_db")
    _docs_path = _a.docs or os.path.join(VDIR, "docs.json")
    _out_path = _a.out or os.path.join(VDIR, "vectors.json")

    t0 = time.time()
    with open(_docs_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    docs = data["docs"]

    # ---------- 组装 chunk 文本：标题 + 正文 ----------
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

    # ---------- 编码 chunk ----------
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModel.from_pretrained(MODEL_DIR)
    model.eval()
    chunk_vecs = encode(model, tokenizer, chunk_texts)
    print(f"chunk 向量完成：{chunk_vecs.shape}，耗时 {time.time()-t0:.1f}s")

    # ---------- 写入 Chroma ----------
    # 与 server.py 口径一致：chromadb 只是可选持久化层。
    # 检索实际走 vectors.json 内存索引，没装 chromadb 也能正常跑。
    try:
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        coll_name = os.path.basename(os.path.normpath(VDIR)) or "kb"
        col = client.get_or_create_collection(
            name=coll_name,
            metadata={"hnsw:space": "cosine", "model": "bge-small-zh-v1.5"})
        ids = [f"doc{m['doc_id']}#c{m['chunk_i']}" for m in chunk_meta]
        got = col.get(ids=ids[:1])
        if got["ids"]:
            col.delete(where={})   # 重建式写入，保证与 docs.json 同步
        col.add(embeddings=chunk_vecs.tolist(), metadatas=chunk_meta, ids=ids)
        print(f"Chroma 写入完成：{col.count()} 条 → {CHROMA_DIR}")
    except Exception as e:
        print(f"Chroma 不可用（跳过持久化，内存索引仍可用）：{type(e).__name__}")

    # ---------- 编码评测题 ----------
    # 新接入的库还没有自己的评测集 —— 缺文件时跳过，不阻塞向量化
    q_vecs = None
    cases = []
    ev_path = os.path.join(ROOT, "tests", "eval_cases.json")
    if os.path.exists(ev_path):
        with open(ev_path, "r", encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        q_texts = [QUERY_INSTRUCTION + c["q"] for c in cases]
        q_vecs = encode(model, tokenizer, q_texts, batch_size=32)
        print(f"问题向量完成：{q_vecs.shape}")
    else:
        print("（无评测集，跳过问题向量）")

    # ---------- 导出 vectors.json ----------
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
    os.makedirs(os.path.dirname(_out_path) or ".", exist_ok=True)
    with open(_out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"vectors.json 导出完成 → {_out_path}")
    print(f"总耗时 {time.time()-t0:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
