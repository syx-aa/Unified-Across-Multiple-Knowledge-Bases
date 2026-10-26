# SPEC-003 向量语义检索

> 状态：Done ｜ 优先级：P0 ｜ 归属：检索层 ｜ 更新：2026-10-23

## 1. 需求（Spec）

补上关键词路的短板：**换个说法提问也能召回**。
例：「哪支队被叫无冕之王」→ 命中荷兰，「世界杯什么时候开踢」→ 命中赛程笔记。

设计约束：模型推理在 Python 侧完成，**不进浏览器**。

## 2. 验收标准（AC）

- [x] AC1：使用 `bge-small-zh-v1.5`，CLS 池化 + L2 归一化（BGE 官方用法）
- [x] AC2：查询侧加检索指令前缀 `为这个句子生成表示以用于检索相关文章：`
- [x] AC3：chunk 级向量（非整篇），文档分取其 chunk 的最大余弦
- [x] AC4：向量持久化进 Chroma（`vector/chroma_db`，cosine 空间）
- [x] AC5：查询走内存索引（1037×512 点积快于逐次打库）
- [x] AC6：向量数 = chunk 数，语料变更后可重建

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 构建 | `python build/build_vectors.py` | 打印 chunk 向量形状与写入条数 |
| TC2 精度校验 | `python build/export_onnx.py` | ONNX 与 torch 向量平均余弦 > 0.999 |
| TC3 指标 | `node tests/eval_v2.js` → 口语化改写型 36 题 | Hit@5 显著高于纯 BM25 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`build/build_vectors.py`](../../build/build_vectors.py#L38-L52) | `encode()` 38-52 | batch 编码 + CLS + 归一化 |
| [`build/build_vectors.py`](../../build/build_vectors.py#L80-L117) | `main()` 80-117 | 写 Chroma + 导出 `vectors.json` |
| [`server.py`](../../server.py#L228-L239) | `embed_query()` 228-239 | 在线查询编码，torch / ONNX 双后端 |
| [`server.py`](../../server.py#L216-L225) | 内存索引载入 216-225 | 从 `vectors.json` 构建 `CHUNK_VECS` |

## 5. 验证结果

- chunk 数 **1037**，维度 512
- 口语化改写型 Hit@5：**77.8% → 91.7%**（+13.9pt），是全表提升最大的一项

## 6. 部署差异

| | 本地完整版 | 云端轻量版 |
|---|---|---|
| 后端 | torch（fp32） | ONNX Runtime（fp32，96MB） |
| 依赖 | 含 torch | 无 torch/CUDA |
