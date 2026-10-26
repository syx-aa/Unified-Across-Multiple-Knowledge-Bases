# SPEC-026 生成耗时优化与诊断

> 状态：Done ｜ 优先级：P0 ｜ 归属：前端 / 大模型通道 ｜ 创建：2026-10-24

## 1. 需求（Spec）

实测一次提问的 trace：

```
4 向量路   查询向量化（bge-small-zh，2ms）→ 内存向量索引聚合
8 取料     取前 6 篇（总长 ≤ 6200 字）拼成上下文
9 生成     大模型流式作答完成 · 依据 3 篇资料 · 用时 94.0 s
```

**检索侧 2ms，生成侧 94s**。重复提问仍是 90s（非偶发），页头显示模型为 **`Auto`**。

三个问题叠加：

1. **模型取值是 `usable[0]`**（列表第一个），`Auto` 是平台自动路由别名，
   可能被路由到推理型模型 —— 内部"思考"耗时极长，而最终输出很短，耗时不可控。
2. **没有 `max_tokens`**，输出长度无上限，模型自由发挥时耗时线性增长。
3. **无诊断数据**：已请求 `stream_options.include_usage` 但代码从未读取 usage，
   也分不清慢在"等首字"还是"吐字慢"，只能靠猜。

## 2. 验收标准（AC）

- [x] AC1：`pickModel()` 按名称优选 —— 排除 `auto` / 推理型（`think|reason|r1|o1|o3|qwq`），
      优先轻量型（`flash|lite|turbo|mini|small|fast`）；无其他候选时仍能回退到 `auto`
- [x] AC2：支持 URL 参数 `?model=<id 或 name>` 强制指定模型，便于人工对比速度
- [x] AC3：请求带 `max_tokens` 上限（`MAX_OUTPUT_TOKENS`），输出长度不再无上限
- [x] AC4：trace 生成步显示 **首字延迟 / 总用时 / 输出字数 / token 数**，可直接定位慢在哪
- [x] AC5：`pickModel()` 为纯函数并暴露给 `__KB__`，可被 Node 测试直接覆盖
- [x] AC6：现有测试全部通过（回归）：`test_search.js` / `test_llm.js` / `test_selfcheck.js` / `test_stream_render.js`
- [x] AC7：新增 `tests/test_llm_speed.js` 覆盖 AC1-AC5

## 3. 测试用例（Test）

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 优选与诊断 | `node tests/test_llm_speed.js` | AC1-AC5 全绿 |
| TC2 回归 | `node tests/test_llm.js` | 通过（降级链不受影响） |
| TC3 页面回归 | `node tests/test_search.js` · `node tests/test_selfcheck.js` | 通过 |
| TC4 真机验证 | 线上提问，看页头模型名与 trace 首字/用时 | 需人工确认耗时下降 |

## 4. 实现（Implementation）

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L913-L918) | `MAX_OUTPUT_TOKENS` / `SLOW_HINT_RE` / `FAST_HINT_RE` | 新增常量与名称启发式规则 |
| [`index.html`](../../index.html#L920-L934) | `pickModel()` 920-934 | 新增：按名称打分优选（纯函数，可测） |
| [`index.html`](../../index.html#L938-L945) | `forcedModelId()` 938-945 | 新增：读 URL `?model=` 参数 |
| [`index.html`](../../index.html#L969-L974) | `loadModel()` 969-974 | 改用 `pickModel()`，URL 指定优先，指定不存在时回退 |
| [`index.html`](../../index.html#L1063) | `create()` 1063 | 增加 `max_tokens` |
| [`index.html`](../../index.html#L1075-L1084) | 流循环与 trace 1075-1084 | 记录首字时间、读取 `usage`、显示字数与 tokens |
| [`tests/test_llm_speed.js`](../../tests/test_llm_speed.js) | 全文 | 新增：AC1-AC5 自动化验证 |

## 5. 验证结果（Verify）

自动化（2026-10-24）：

| 项 | 结果 |
|---|---|
| `[auto, deepseek-r1, qwen-flash]` | 选中 `qwen-flash` ✅ |
| `[o1-mini, glm-4]` | 选中 `glm-4`（推理型被排后）✅ |
| 只有 `auto` | 仍能回退，不返回 null ✅ |
| 空列表 / 全 disabled | 返回 null ✅ |
| `?model=wb-flash` | 强制命中 ✅；指定的不存在时回退优选 ✅ |
| `max_tokens` | 请求带 `1024` ✅ |
| trace 显示 | `首字 / 用时 / 输出字数 / tokens` 四项齐全 ✅ |
| 降级链 | 无模型 → `state=empty`，不静默失败 ✅ |

回归：`test_search.js` / `test_llm.js` / `test_selfcheck.js` / `test_stream_render.js` 全部通过。

**未验证项（需真机）**：耗时是否真的下降。这是本 Spec 的最终目的，
但只能在**线上发布域名**下调用大模型才能测（本地 `file://` / `localhost` 无授权）。
请在线上提问后观察 trace 第 9 步：

- **首字 ≈ 总用时** → 慢在排队 / prefill → 下一步应减少上下文（`buildContext` 6200 字）
- **首字短、耗时长** → 慢在解码 → 已被 `max_tokens` 封顶，若仍慢则换具体模型
- **仍 90s 且首字极长** → 平台侧路由问题，用 `?model=<具体 id>` 逐个对比

## 6. 部署差异

线上（发布域名）才走大模型通道；本地 `file://` / `localhost` 无授权，仍回退本地摘要 —— 本项不影响该降级链。

> 若真机验证后耗时仍未下降，说明瓶颈在平台侧路由/排队而非输出长度，
> 届时应改为"减少上下文"（`buildContext` 的 6200 字预算）或改用指定具体模型。
