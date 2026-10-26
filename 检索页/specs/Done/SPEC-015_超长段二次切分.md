# SPEC-015 超长段落按句二次切分（带重叠）

> 状态：**Done** ｜ 优先级：P1 ｜ 归属：数据层 ｜ 完成：2026-10-24

## 1. 需求（Spec）

分块按 `## 小节 + 空行段落` 结构切，长短悬殊（实测 3 ~ 1153 字）。
超过 512 token 的段落会在编码时被 `build_vectors.py` 的 `max_len=512`
**静默截断**，尾部信息丢失。需要对超长段落做二次切分，并保证相邻块有上下文重叠。

## 2. 验收标准（AC）

- [x] AC1：段落 ≤ 400 字时不切分（行为向后兼容）
- [x] AC2：>400 字按句末标点 / 换行二次切分，块长 ≤ 400
- [x] AC3：相邻子块带约 60 字尾部重叠，避免切断语义
- [x] AC4：切分后**无内容丢失**（所有句子都能在某个块里找到）
- [x] AC5：保留标点与换行原文，列表项不粘连
- [x] AC6：单句本身超长时有兜底（定长滑窗）
- [x] AC7：**重跑完整管线，`data.js`/`docs.json`/向量全部更新**
- [x] AC8：**重跑 120 题评测，指标不下降**
- [x] AC9：重叠内容**不污染** BM25 索引与喂给大模型的资料（实现中发现的副作用，已修）

## 3. 测试用例

| 用例 | 命令 / 位置 | 结果 |
|---|---|---|
| TC1 切分正确性 | JS 等价复刻 + 构造样例 + 真实最长 chunk | 块长 ≤400、有重叠、无丢句 ✅ |
| TC2 全链路重跑 | `python build/build_data.py` → `export_docs.js` → 向量化 | ✅ 1079 chunk / 1079 向量，对齐 |
| TC3 指标回归 | `node tests/eval_v2.js stage1` + `node tests/test_selfcheck.js` | ✅ 见下表 |
| TC4 前端回归 | 4 个测试脚本 | ✅ 全通过 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`build/build_data.py`](../../build/build_data.py#L32-L34) | 32-34 | 阈值常量 `MAX_CHUNK_CHARS=400`、`OVERLAP_CHARS=60` |
| [`build/build_data.py`](../../build/build_data.py#L126-L135) | `split_sentences()` 126-135 | 按句末标点/换行切句，保留原文 |
| [`build/build_data.py`](../../build/build_data.py#L138-L144) | `hard_wrap()` 138-144 | 单句超长时的滑窗兜底 |
| [`build/build_data.py`](../../build/build_data.py#L147-L180) | `pack_sentences()` 147-180 | 贪心打包 + 尾部重叠；**返回重叠字数** |
| [`build/build_data.py`](../../build/build_data.py#L183-L198) | `to_chunks()` 183-198 | 入口；子块带 `ov` 字段（与上一块重复的字数） |
| [`index.html`](../../index.html#L329-L335) | `chunkText()` 329-335 | 新增：拼接正文时跳过重叠的 `ov` 字 |
| [`index.html`](../../index.html#L386) | BM25 索引构建 | 改用 `chunkText()` |
| [`index.html`](../../index.html#L1029) | 喂给大模型的资料 | 改用 `chunkText()` |
| [`build/build_vectors_onnx.py`](../../build/build_vectors_onnx.py) | 全文 | 新增：ONNX 版向量化（见备注 2） |

## 5. 验证结果（2026-10-24 实测）

**分块分布**（`docs.json` 1079 chunk）：

| | 改动前 | 改动后 |
|---|---|---|
| chunk 总数 | 1037 | 1079（+42） |
| 最长 chunk | 1153 字 | 1153 字（见备注 1） |
| >512 字 | 21 | **9**（-12） |
| >1000 字 | 5 | **1** |

**融合检索 stage1**（同一口径对比，改动前用备份数据复现）：

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| Hit@1 | 67.5% | 67.5% | 持平 |
| Hit@3 | 85.0% | 86.7% | **+1.7** |
| Hit@5 | 88.3% | 89.2% | **+0.9** |
| MRR | 0.763 | 0.765 | **+0.002** |

**纯前端自检**（`test_selfcheck.js`，页面 vs 离线基线）：

| 指标 | 基线 | 修复重叠后 |
|---|---|---|
| Hit@1 | 64.2% | 64.2% |
| Hit@5 | 90.0% | **90.0%** |
| MRR | 0.753 | **0.753** |
| 19 项断言 | — | **全部通过** |

## 6. 过程中发现并修复的问题（AC9）

首轮重跑后 `test_selfcheck.js` 挂了 3 项（Hit@5 108→107、MRR 0.753→0.750、fact 型 h5 38→37）。

根因：BM25 的索引文本是**由 chunks 拼接**的（`index.html` 原 379 行），
重叠的 60 字被拼进去**两次** → 人为抬高词频 → 排序变化。
同一段代码也用于拼接喂给大模型的资料，重复内容白占 6200 字预算。

修复：`pack_sentences()` 返回重叠字数，chunk 增加 `ov` 字段，
前端新增 `chunkText()` 在拼接时跳过重叠部分（向量侧仍用含重叠的完整块）。
修复后指标回到基线，且融合层的提升保留。

## 7. 备注（遗留）

1. **最长 chunk 仍是 1153 字**：剩下 9 个 >512 的 chunk 全部来自 `refs`
   （`parse_node()` 里拼的「关联笔记：[[A]]、[[B]]…」），不走 `to_chunks()`。
   已单列在 Plan 清单，本 Spec 不处理。
2. **向量化走了 ONNX 路径**：本机 Python 3.14 装不上 `transformers`
   （依赖需源码编译），故新增 `build/build_vectors_onnx.py`
   （算法与 `build_vectors.py` 一致：CLS 池化 + L2 归一化）。
   待 transformers 可用后，仍应以 `build_vectors.py` 为准。
3. **Chroma 未同步**：本次只更新了 `vectors.json`（server.py 实际读它做内存索引），
   `vector/chroma_db` 仍是旧的 1037 条，暂未重建。
