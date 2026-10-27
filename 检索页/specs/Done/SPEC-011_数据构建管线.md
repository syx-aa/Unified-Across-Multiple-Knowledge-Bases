# SPEC-011 数据构建管线

> 状态：Done ｜ 优先级：P0 ｜ 归属：数据层 ｜ 更新：2026-10-23

## 1. 需求（Spec）

把 `data/worldcup/` 的 md 语料（笔记 + 实体 + 概念）编译成页面与检索可用的产物，
形成一条**可重复执行、顺序明确**的管线。

## 2. 验收标准（AC）

- [x] AC1：一条命令链可从原始 md 重建全部产物，无需手工干预
- [x] AC2：产物包含 `data.js`（页面数据）与 `vector/vectors.json`（向量）
- [x] AC3：分块按 `## 小节 + 空行段落` 结构切分（非固定长度）
- [x] AC4：chunk 只存原文（含 `[[双链]]`），纯文本由前端即时转换
- [x] AC5：向量数量与 chunk 数量一致，可整库重建
- [x] AC6：词条增删后页面自动跟着变（分类导航与别名表自动解析）
- [x] AC7：模型可从魔搭下载，不依赖 HF

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 全链路 | `python build/build_data.py` → `node build/export_docs.js` → `python build/build_vectors.py` | 无报错，打印统计 |
| TC2 一致性 | `export_docs.js` 输出的 chunk 数 = `vectors.json` 的 chunk 数 | 1037 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`build/build_data.py`](../../build/build_data.py#L137-L187) | `parse_note()` 137 · `to_chunks()` 172 | md → 解析 → `data.js`（含分块） |
| [`build/export_docs.js`](../../build/export_docs.js#L15-L20) | 15-20 | `data.js` → `vector/docs.json` |
| [`build/download_models.py`](../../build/download_models.py) | | 魔搭下载 bge embedding / reranker |
| [`build/build_vectors.py`](../../build/build_vectors.py#L55-L118) | `main()` 55 | chunk 编码 → Chroma + `vectors.json` |
| [`build/build_eval_cases.js`](../../build/build_eval_cases.js) | | 评测集打包成 `eval_cases.js` |

## 5. 验证结果

当前产物：130 篇文档 / **1037 个 chunk** / 120 道评测题。

> 当前阻塞：本机 Python 解释器损坏（`E:\py\python.exe` 无法启动），
> 管线第一步暂时跑不了（见 SPEC-015）。
