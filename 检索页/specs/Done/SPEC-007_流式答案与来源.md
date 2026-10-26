# SPEC-007 大模型流式答案 + 来源标注

> 状态：Done ｜ 优先级：P0 ｜ 归属：生成层 ｜ 更新：2026-10-23

## 1. 需求（Spec）

检索只是取料，最终要给出**一句人话答案**，并标明依据来自哪些笔记。
答案必须**只能依据检索到的资料**，不得编造。

## 2. 验收标准（AC）

- [x] AC1：`chat.completions.create({ stream: true })`，逐字流式渲染
- [x] AC2：`messages[0]` 固定 system 提示词，约束「只依据资料、不得编造」
- [x] AC3：取料上限 **≤6 篇、≤6200 字**
- [x] AC4：每条来源标注相似度百分比（1–100%）
- [x] AC5：颜色三档：≥70% 金色 / 40–69% 蓝色 / <40% 灰蓝
- [x] AC6：来源按相似度从高到低，同分时笔记优先
- [x] AC7：免密钥接入（只用公开配置，不需要 API Key）

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 大模型通道 | `node tests/test_llm.js` | 模拟 SDK 流式返回，通过 |
| TC2 渲染与边界 | `node tests/test_search.js` | 通过 |

## 4. 实现

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L973-L1046) | `streamAnswer()` 973 | 流式拼接与渲染 |
| [`index.html`](../../index.html#L956-L971) | `buildContext()` 956 | system 提示词、取料长度截断 |
| [`index.html`](../../index.html#L793-L819) | `simPct()` 793 · `sourcesHtml()` 798 | 相似度百分比与颜色分档 |
| [`index.html`](../../index.html#L598-L618) | `pickSources()` 598 | 来源选取与排序 |

## 5. 验证结果

线上可用（`worldcup-qa.app.workbuddy.host`）。
本地 `file://` 打开时因域名未授权被拒 → 走 SPEC-008 降级。

> 相似度百分比是**相对本次查询**的相关度，不是跨查询可比的绝对指标（页面已注明）。
