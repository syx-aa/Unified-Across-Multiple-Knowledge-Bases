# SPEC-005 cross-encoder 重排

> 状态：Done ｜ 优先级：P1 ｜ 归属：检索层 ｜ 更新：2026-10-23

## 1. 需求（Spec）

融合排序只看各路分数，缺少「问题与文档放在一起看」的精排。
用 `bge-reranker-base`（cross-encoder）对候选逐对打分，提升 top-1 准确率。

## 2. 验收标准（AC）

- [x] AC1：对 (问题, 文档) 逐对打分，sigmoid 输出
- [x] AC2：候选来自融合 top-30 ∪ 向量 top-30
- [x] AC3：重排不可用时**自动降级**为融合序，不报错
- [x] AC4：总体 Hit@1 高于纯融合
- [x] AC5：离线批处理可复跑（`stage1` → 打分 → `final` 三段）

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 离线评测 | `node tests/eval_v2.js stage1` → `python build/rerank.py` → `node tests/eval_v2.js final` | 出最终指标 |
| TC2 服务端 | `node tests/eval_backend.js`（本地起了服务） | Hit@1 ≈ 79.2% |
| TC3 降级 | 云端环境无 reranker 权重 | 检索正常返回，按融合分排序 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`build/rerank.py`](../../build/rerank.py#L24-L64) | `main()` 24-64 | 离线批量打分（4372 对，CPU 约 20 分钟） |
| [`server.py`](../../server.py#L242-L255) | `rerank_pairs()` 242-255 | 在线打分，模型不可用时返回 None |

## 5. 验证结果

| 档位 | Hit@1 | Hit@5 | MRR |
|---|---|---|---|
| 融合（无重排） | 72.5% | 93.3% | 0.816 |
| **融合 + 重排** | **79.2%** | **97.5%** | **0.854** |

**已知代价**：两道「揭幕战」题从第 2 名掉出 top-5 —— cross-encoder 对内容更丰富的
干扰文档打分偏高。这是重排的真实 trade-off，跟踪见 SPEC-023。

## 6. 部署差异

云端**停用**重排（见 SPEC-021）：单次检索 10s → 31ms。
