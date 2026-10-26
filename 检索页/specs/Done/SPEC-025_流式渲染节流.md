# SPEC-025 流式渲染节流

> 状态：Done ｜ 优先级：P1 ｜ 归属：前端 ｜ 创建：2026-10-24

## 1. 需求（Spec）

大模型流式返回时，页面**每收到一个 token 就把整个回答重新拼接、转义、重写 `innerHTML`**。
回答越长，每个字要做的工作越多（O(n²)），长回答会明显掉帧、输入滞后。

改成**按帧合并渲染**：同一帧内到达的多个 token 只触发一次 DOM 写入。
这是纯性能修复 —— 不改变任何展示内容与检索逻辑。

## 2. 验收标准（AC）

- [x] AC1：同一帧内多次 `push` 只触发 **1 次** DOM 写入（改造前是 N 次）
- [x] AC2：最终渲染的文本与逐字渲染**完全一致**（不丢字、不重复、不乱序）
- [x] AC3：流正常结束时**移除光标** `<span class="caret">`，无残留
- [x] AC4：生成中断时**保留已生成内容**并标注中断（行为与改造前一致）
- [x] AC5：无 `requestAnimationFrame` 的环境（如测试用的 mock DOM）自动降级为 `setTimeout`
- [x] AC6：现有测试全部通过（回归）：`test_search.js` / `test_llm.js` / `test_selfcheck.js`
- [x] AC7：新增 `tests/test_stream_render.js` 覆盖 AC1-AC5

## 3. 测试用例（Test）

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 节流与完整性 | `node tests/test_stream_render.js` | AC1-AC5 全绿 |
| TC2 页面回归 | `node tests/test_search.js` | 通过（页面脚本仍能加载执行） |
| TC3 自测回归 | `node tests/test_llm.js` · `node tests/test_selfcheck.js` | 通过 |

## 4. 实现（Implementation）

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L976-L994) | `streamRenderer()` 976-994 | 新增：按帧合并的渲染器（`push` / `finish` / `raw`） |
| [`index.html`](../../index.html#L996-L1058) | `streamAnswer()` 996-1058 | 改造点：`buf` 逐字重写换成 `rr.push()` + `rr.finish()` |
| [`index.html`](../../index.html#L1262) | `__KB__.streamRenderer` 1262 | 暴露给测试脚本调用 |
| [`tests/test_stream_render.js`](../../tests/test_stream_render.js) | 全文 | 新增：AC1-AC5 的自动化验证 |

## 5. 验证结果（Verify）

实测（2026-10-24）：

| 项 | 结果 |
|---|---|
| 8 个 token 连续到达 | DOM 写入 **1 次**（改造前 8 次） |
| 内容完整性 | 与逐字渲染一致，顺序正确、无丢字 |
| 光标 | 流中显示、`finish()` 后移除 |
| 中断路径 | `raw()` 可取回已生成内容，页面照常渲染中断提示 |
| 无 rAF 环境 | 自动降级 `setTimeout`，渲染正常 |
| HTML 转义 | `<img>` 被转义为 `&lt;img`，未引入 XSS |

回归：`test_search.js` / `test_llm.js` / `test_selfcheck.js` 全部通过，退出码 0。

**收益**：渲染开销从 O(token 数 × 已生成长度) 降到 O(帧数)，
长回答不再随长度增长而掉帧。不改变任何展示内容与检索逻辑，
故 **120 题指标不受影响**（无需重跑评测）。

**未验证项**：真机浏览器的实际帧率改善 —— 需要人工在页面提问观察，
mock DOM 只能验证写入次数与内容正确性。

## 6. 部署差异

无 —— 纯前端渲染，本地与云端同一份 `index.html`。

> 云端检索约 31ms、本地完整版约 10s（重排），本项**不影响检索耗时**，
> 只影响回答生成过程中的渲染流畅度。
