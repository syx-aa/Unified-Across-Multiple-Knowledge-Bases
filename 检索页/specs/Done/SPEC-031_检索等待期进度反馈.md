# SPEC-031 检索等待期的进度反馈

> 状态：Done ｜ 优先级：P1 ｜ 归属：前端 ｜ 类型：缺陷修复

## 1. 需求（Spec）

提问后页面长时间无任何变化，直到答案全部完成才整块出现，用户无从判断进行到哪一步。

根因**不是** SPEC-030 的竞态（那个已修），而是：服务端检索是一次异步 `fetch`
（三路融合 + 重排，本地约 10 秒），而 `ask()` 发起请求之后、`.then` 之前
**没有任何一次 DOM 写入** —— 这段时间页面停留在上一轮的结果上，看起来就是卡死。

```javascript
composeAnswerServer(q).then(function(ans){ ... handleAnswer(q, ans, seq); });
```

首次写 `OUT` 发生在 `streamAnswer()` 内部，即服务端返回之后。

## 2. 验收标准（AC）

- [x] AC1：提问后**同步**渲染"检索中"状态，用户立即看到反馈
- [x] AC2：服务端返回后，该状态被完整 trace + 答案骨架替换，不残留
- [x] AC3：本地两路（同步检索，毫秒级）不受影响，不闪一下检索中
- [x] AC4：与 SPEC-030 的序号机制兼容 —— 过期请求不覆盖新界面
- [x] AC5：流式生成期间答案逐步出现（中途能读到部分内容）
- [x] AC6：新增 `tests/test_progress_feedback.js` 覆盖 AC1-AC5
- [x] AC7：现有测试全部通过（回归）

## 3. 测试用例

| 用例 | 场景 | 期望 |
|---|---|---|
| TC1 | mock 服务端检索延迟 300ms，提问后 20ms 查界面 | 已显示"检索中" |
| TC2 | 等待检索完成 | 界面换成完整 trace，无"检索中"残留 |
| TC3 | 不接服务端（本地两路） | 不出现检索中状态 |
| TC4 | 流式中途查答案区 | 已含部分生成内容 |
| TC5 | 回归 | 全部现有测试通过 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L789-L797) | `renderSearching()` | 新增：检索中的轻量骨架，含当前问题与链路说明 |
| [`index.html`](../../index.html#L895) | `ask()` 服务端分支 | 发起 fetch **之前**先调 `renderSearching(q)` |
| [`tests/test_progress_feedback.js`](../../tests/test_progress_feedback.js) | 全文 | 新增：5 组时序测试共 14 项 |

## 5. 验证结果（Verify）

实测（2026-10-24），mock 服务端检索延迟 300ms：

| 用例 | 结果 |
|---|---|
| 提问后 30ms（远早于服务端返回） | 已显示「检索中 · 正在检索「梅西是谁」的资料」 ✅ |
| 检索完成后 | 换成完整 trace，「正在检索」提示消失 ✅ |
| 流式中途读答案区 | 已含部分内容 `<p class="lead">梅西<span …` ✅ |
| 本地两路（无服务端） | 不出现检索中骨架 ✅ |
| 抢占提问 | 立刻刷新为新问题的检索提示，旧问题不残留 ✅ |

`tests/test_progress_feedback.js` 通过 14 项。

回归全绿：`test_search.js` / `test_llm.js` / `test_selfcheck.js`（19）/
`test_selfcheck_mode.js`（16）/ `test_stream_render.js` / `test_llm_speed.js` /
`test_concurrent.js`（12）。

**重要澄清**：修复前曾误判为竞态（SPEC-030 已修但现象仍在）。实测证明
**流式渲染一直正常**（中途能读到部分内容），真正的空白只发生在服务端检索
那几秒 —— 本 Spec 修的正是这一段。
