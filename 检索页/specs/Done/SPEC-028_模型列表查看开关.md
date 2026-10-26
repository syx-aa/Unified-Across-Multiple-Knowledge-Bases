# SPEC-028 模型列表查看开关

> 状态：Done ｜ 优先级：P0 ｜ 归属：前端 / 大模型通道 ｜ 创建：2026-10-24
> 前置：SPEC-026（模型优选）、SPEC-027（实际模型名标注）

## 1. 需求（Spec）

真机验证结果：**页头仍是 `大模型：Auto`，没有出现 SPEC-027 的括号标注** ——
说明平台**没有在流式 chunk 里回填 `model` 字段**，无从得知 Auto 实际路由到了谁。

只剩一条路：**把 `models.list()` 返回的完整候选列出来**，人工挑一个具体的、快的模型，
再用 SPEC-026 已支持的 `?model=<id>` 固定下来。

需要一个开关：`?models=1` → 页面直接列出所有可用模型（id / name / 是否禁用），
同时打到控制台一份。

## 2. 验收标准（AC）

- [x] AC1：带 `?models=1` 时，页面列出全部候选的 `id` 与 `name`，并标注 `disabled`
- [x] AC2：同时 `console.log` 输出一份，便于复制
- [x] AC3：**不带参数时页面无任何额外显示**，普通用户无感
- [x] AC4：完整列表保存到 `__KB__.modelList`，可被 Node 测试直接读取
- [x] AC5：列表为空时不报错、也不渲染空块（降级链不受影响）
- [x] AC6：新增测试覆盖 AC1-AC5
- [x] AC7：现有测试全部通过（回归）

## 3. 测试用例（Test）

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 列表开关 | `node tests/test_llm_speed.js` 第 7 节 | AC1-AC5 全绿 |
| TC2 回归 | 4 个现有测试脚本 | 通过 |
| TC3 真机 | 线上打开 `?models=1` | 看到模型清单，挑出 id |

## 4. 实现（Implementation）

| 文件 | 位置 | 说明 |
|---|---|---|
| [`index.html`](../../index.html#L948) | `MODEL_LIST` | 保存 `models.list()` 原始返回（含 disabled） |
| [`index.html`](../../index.html#L950-L955) | `wantModelDump()` | 读 URL 的 `?models=1` |
| [`index.html`](../../index.html#L957-L974) | `dumpModels()` 957-974 | 渲染清单块 + `console.log`；空清单不渲染 |
| [`index.html`](../../index.html#L981) | `loadModel()` | 保存列表并调用 `dumpModels()` |
| [`tests/test_llm_speed.js`](../../tests/test_llm_speed.js) | 第 7 节 | 新增：三种场景（有清单 / 无参数 / 空列表） |

## 5. 验证结果（Verify）

| 场景 | 结果 |
|---|---|
| `?models=1` + 3 个候选 | 页面插入清单块，含 id、name、`[禁用]` 标记，显示"可用模型 3 个" ✅ |
| `console.log` | 同步输出清单，便于复制 ✅ |
| 不带参数 | 页面无任何额外显示 ✅ |
| 空列表 | 不报错、不渲染空块 ✅ |
| `__KB__.modelList` | 返回含 disabled 的完整列表 ✅ |

回归：`test_search.js` / `test_llm.js` / `test_selfcheck.js` / `test_stream_render.js` 全部通过。

调试过程中修正一处：空清单时不渲染（原本会插入"可用模型 0 个"的空块）。

## 6. 后续

拿到清单后：
- 若有多个模型 → 用 `?model=<id>` 对比速度，把最快的写进 `pickModel()` 规则
- 若**只有 Auto 一个** → 路由不可控，只能从其他方向降耗时（减少上下文 `buildContext` 6200 字）
