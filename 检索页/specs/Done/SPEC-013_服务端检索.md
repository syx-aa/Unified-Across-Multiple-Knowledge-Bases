# SPEC-013 服务端检索（FastAPI，P3）

> 状态：Done ｜ 优先级：P0 ｜ 归属：检索层 ｜ 更新：2026-10-23

## 1. 需求（Spec）

浏览器跑不了模型推理，重排与向量编码必须落在服务端。
把检索整体搬进常驻进程（FastAPI + uvicorn），浏览器只负责发问题、展示答案。

## 2. 验收标准（AC）

- [x] AC1：`GET /api/health` 返回服务状态（embedding 后端 / reranker 是否可用 / 向量数）
- [x] AC2：`GET /api/search?q=&rerank_top=` 返回 `rows/terms/exact/trace`
- [x] AC3：`GET /` 静态托管问答页
- [x] AC4：Python 侧复刻的 BM25/实体路与 JS 版聚合指标一致
- [x] AC5：**权重文件决定运行时**（有 safetensors → torch；只有 onnx → ONNX Runtime），
  而不是靠"有没有 torch"
- [x] AC6：Chroma 负责持久化，查询走内存索引

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 启动 | `python server.py` → 打开 8765 | 页头提示「服务端检索」 |
| TC2 回归 | `node tests/eval_backend.js` | 完整版 ≈ 79.2/97.5/0.854 |
| TC3 接口 | `curl /api/health` | 返回后端与向量数 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`server.py`](../../server.py#L165-L192) | 165-192 | 双后端选路（按权重文件决定 torch / ONNX） |
| [`server.py`](../../server.py#L279-L355) | `search()` 279-355 | 融合与重排主链路 |
| [`server.py`](../../server.py#L358-L386) | 358-386 | FastAPI 应用与路由 |
| [`requirements.txt`](../../requirements.txt) | | 完整版含 torch；云端版不含 |

## 5. 验证结果

| 档位 | Hit@1 | Hit@5 | MRR |
|---|---|---|---|
| 线上（融合，ONNX，无重排） | 72.5% | 93.3% | 0.816 |
| 本地（融合 + 重排） | 79.2% | 97.5% | 0.854 |

## 6. 部署差异

云端轻量版单次检索 **~31ms**，本地完整版 **~10s**（重排占大头）。
