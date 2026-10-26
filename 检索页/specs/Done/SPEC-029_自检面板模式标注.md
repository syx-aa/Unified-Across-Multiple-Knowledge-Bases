# SPEC-029 自检面板标注真实检索模式

> 状态：Done ｜ 优先级：P2 ｜ 归属：前端

## 1. 需求（Spec）

页面「检索自检」面板永远显示 64.2%，但这是**页面内置两路**（关键词 + 实体）的成绩 ——
即使已连上服务端、实际走三路融合 + 重排，面板数字也不变，且文案仍写「检索模式：智能」。

结果就是误导：用户看面板以为「加了服务端没有提升」，实际面板根本没测到服务端那条链路。

面板 misma 的职责是**校验页面自身逻辑与离线基线一致**（test_selfcheck 依赖它），
跑本地逻辑是正确设计，不能改；要改的是**把这件事说清楚**。

## 2. 验收标准（AC）

- [x] AC1：面板脚注按当前真实状态显示 —— 服务端可用 vs 纯本地，两种文案不同
- [x] AC2：服务端可用时，明确提示「本面板只评测页面内置两路，服务端链路请用 `tests/eval_backend.js` 测」
- [x] AC3：无服务端时保持原有文案风格，不引入噪音
- [x] AC4：**不改动任何检索逻辑与指标数字**（64.2% 仍应是那个值）
- [x] AC5：现有 `test_selfcheck.js` 的 19 项断言全部通过（回归）
- [x] AC6：新增测试覆盖 AC1-AC3

## 3. 测试用例

| 用例 | 命令 | 覆盖 |
|---|---|---|
| TC1 文案随状态变化 | `node tests/test_selfcheck.js` + 新增 `tests/test_selfcheck_mode.js` | AC1-AC3 |
| TC2 指标不变 | `node tests/test_selfcheck.js` | AC4 |
| TC3 回归 | `test_search.js` / `test_llm.js` / `test_stream_render.js` / `test_llm_speed.js` | AC5 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L645) | `SERVER` | 增加 `rerank` 字段，记录服务端是否启用重排 |
| [`index.html`](../../index.html#L658-L659) | `probeServer()` | 探活成功时回填 `SERVER.rerank` |
| [`index.html`](../../index.html#L1246-L1251) | 自检面板脚注 | 按 `SERVER.ready` / `SERVER.rerank` 切换文案 |
| [`tests/test_selfcheck_mode.js`](../../tests/test_selfcheck_mode.js) | 全文 | 新增：4 类场景共 16 项断言 |

## 5. 验证结果（Verify）

实测（2026-10-24）：

| 场景 | 脚注输出 |
|---|---|
| 无服务端 | `当前链路：本地两路（关键词 + 实体）` + 「本面板只评测页面内置的两路检索」 ✅ |
| 服务端含重排 | `当前链路：服务端三路（关键词 + 实体 + 向量 + 重排）` ✅ |
| 服务端轻量版 | `服务端三路（…向量）`，不带 `+ 重排` ✅ |
| 页头 hint | `服务端检索：BM25 + 实体 + 向量 + 重排 · FastAPI` ✅ |

指标未受影响（三种场景完全一致）：`n=120  h1=77  h5=108  MRR=0.753`。

新增 `tests/test_selfcheck_mode.js` 通过 16 项；`test_selfcheck.js` 回归 19 项仍全绿。
