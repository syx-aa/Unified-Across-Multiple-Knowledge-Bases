"""rerank.py — 用 bge-reranker-base 对候选 (问题, 文档) 对打分

输入：vector/candidates.json（由 tests/eval_v2.js stage1 导出）
输出：vector/rerank_scores.json  {qid: {docIdx: score}}，score = sigmoid(logit) ∈ (0,1)

运行：python build/rerank.py
"""
import json
import math
import os
import sys
import time

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VDIR = os.path.join(ROOT, "vector")
MODEL_DIR = os.path.join(VDIR, "models", "bge-reranker-base")
BATCH = 32


@torch.no_grad()
def main():
    t0 = time.time()
    with open(os.path.join(VDIR, "candidates.json"), "r", encoding="utf-8") as f:
        cand = json.load(f)

    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR)
    model.eval()

    cases = json.load(open(os.path.join(ROOT, "tests", "eval_cases.json"), encoding="utf-8"))["cases"]

    # 展开 (qid, docIdx, text) 对
    pairs, index = [], []
    for c in cases:
        qid = c["id"]
        for di in cand["candidates"].get(qid, []):
            pairs.append((c["q"], cand["docTexts"][str(di)]))
            index.append((qid, di))
    total = len(pairs)
    print(f"待打分对：{total}（{len(cases)} 题）")

    scores = {c["id"]: {} for c in cases}
    for i in range(0, total, BATCH):
        batch = pairs[i:i + BATCH]
        enc = tokenizer([p[0] for p in batch], [p[1] for p in batch],
                        padding=True, truncation=True, max_length=512, return_tensors="pt")
        logits = model(**enc).logits.view(-1).float()
        probs = torch.sigmoid(logits).tolist()
        for (qid, di), s in zip(index[i:i + BATCH], probs):
            scores[qid][str(di)] = round(s, 5)
        if (i // BATCH) % 10 == 0:
            el = time.time() - t0
            eta = el / (i + BATCH) * (total - i - BATCH) if i + BATCH < total else 0
            print(f"  {min(i+BATCH, total)}/{total}  已用 {el:.0f}s  预计还需 {eta:.0f}s")

    out = {"model": "bge-reranker-base", "recall": cand["recall"], "candidates": cand["candidates"], "scores": scores}
    with open(os.path.join(VDIR, "rerank_scores.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"rerank_scores.json 写出完成，总耗时 {time.time()-t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
