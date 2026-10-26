"""download_models.py — 从魔搭社区下载 embedding 与 reranker 模型到本地

运行：python build/download_models.py
产物：vector/models/bge-small-zh-v1.5/  vector/models/bge-reranker-base/
"""
import os
import sys
from modelscope import snapshot_download

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(ROOT, "vector", "models")

MODELS = [
    "BAAI/bge-small-zh-v1.5",   # embedding，24M 参数，512 token
    "BAAI/bge-reranker-base",   # cross-encoder 重排，278M 参数
]

for repo in MODELS:
    target = os.path.join(MODELS_DIR, repo.split("/")[-1])
    if os.path.isdir(target) and os.listdir(target):
        print(f"[skip] {repo} 已存在 → {target}")
        continue
    print(f"[download] {repo} ...")
    path = snapshot_download(repo, local_dir=target)
    print(f"[done] {repo} → {path}")

print("全部模型就绪。")
sys.exit(0)
