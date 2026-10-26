# Specs · SpecDD 规格库（本地项目 `检索页`）

> **开发前必读**：[`../开发约束.md`](../开发约束.md) —— 尤其是 **R-01 降级决策规则**：
> 任何形式的降级（关功能 / 换模型 / 回退路径 / 放宽 AC）都**必须先询问项目负责人**，
> 并提供可选方案与量化影响，得到明确选择后方可实施。

用 SpecDD（Specification Driven Development）的思想把项目重新组织一遍：
**每个功能必须先有规格（Spec）与验收标准（AC），再有实现，最后由测试用例判定是否 Done。**

现在的代码是「先写后记」，这里把它反推成 24 份规格，作为后续演进的基线。

## SpecDD 流程

```
Spec（需求规格）
   ↓
AC（验收标准 · 可量化 · 可判定）
   ↓
Test（测试用例 / 评测命令）
   ↓
Implement（实现）
   ↓
Verify（跑测试 → 判定状态）
```

**状态的判定权在 AC + Test，不在"我觉得写完了"。**
AC 全部通过 → `Done`；AC 有未通过且代码已写 → `Indevelopment`；
规格作废 → `Abandoned`；有 Spec 无实现 → `Plan`。

## 目录约定

```
specs/
├── README.md          本文件（总纲 + 功能总表）
├── _template.md       Spec 模板
├── Done/              已通过全部 AC
├── Indevelopment/     代码已写，AC 尚未全部验证
├── Abandoned/         规格作废（记录放弃原因与替代方案）
└── Plan/              有 Spec，未开工
```

编号规则：`SPEC-NNN` 全局流水，状态由所在目录表达；编号只增不改，
功能在目录间移动时编号不变（便于追溯历史）。

**文件列可点击跳转**：每份 Spec 的「实现」表格里，文件路径写成
`[`文件名`](../../xxx.py#L起-L止)` 形式的相对链接，点一下直接跳到代码那几行。
（本目录在 `specs/` 下，所以路径以 `../../` 开头；新建 Spec 时照
`_template.md` 的格式写即可。）

## 状态流转（新功能开发的完整路径）

```
   ┌──────────── 作废时随时可走这条旁路 ────────────┐
   │                                                ▼
Plan ────▶ Indevelopment ────▶ Done
写 Spec        写代码            AC 全绿
+ AC        逐条验证 AC
```

| 阶段 | 进入条件 | AC 状态 | 手上动作 |
|---|---|---|---|
| **Plan** | Spec + AC 写完，**尚未动代码** | 全空 | 想清楚"什么算做完" |
| **Indevelopment** | **开始写代码那一刻移入** | 部分打勾 | 边做边验证，逐条打勾 |
| **Done** | AC **全部**打勾且测试通过 | 全勾 | 归档，更新总表 |
| **Abandoned** | 判定不该做（不可行 / 被替代 / 性价比低） | 任意 | 记录放弃原因与替代方案 |

两条硬规则：

1. **一动手写代码就挪进 `Indevelopment`** —— 不存在"从 Plan 直接跳 Done"。
2. **有代码不等于 Done** —— 只要还有一条 AC 未验证，就停在 `Indevelopment`。
   典型例子：[SPEC-015](./Indevelopment/SPEC-015_超长段二次切分.md)：代码已写完，
   但 AC7（重跑管线）、AC8（重跑评测）因 Python 环境损坏无法验证，故仍属 Indevelopment。

## 功能总表

| ID | 功能 | 状态 |
|---|---|---|
| [SPEC-001](./Done/SPEC-001_关键词检索.md) | 关键词检索（BM25 + bigram） | Done |
| [SPEC-002](./Done/SPEC-002_实体别名检索.md) | 实体 / 别名检索 | Done |
| [SPEC-003](./Done/SPEC-003_向量语义检索.md) | 向量语义检索 | Done |
| [SPEC-004](./Done/SPEC-004_三路融合检索.md) | 三路融合检索 | Done |
| [SPEC-005](./Done/SPEC-005_CrossEncoder重排.md) | cross-encoder 重排 | Done |
| [SPEC-006](./Done/SPEC-006_精确实体保护.md) | 精确实体命中保护 | Done |
| [SPEC-007](./Done/SPEC-007_流式答案与来源.md) | 大模型流式答案 + 来源标注 | Done |
| [SPEC-008](./Done/SPEC-008_生成降级链.md) | 生成降级链 | Done |
| [SPEC-009](./Done/SPEC-009_检索过程面板.md) | 检索过程 trace 面板 | Done |
| [SPEC-010](./Done/SPEC-010_页面检索自检.md) | 页面内检索自检评测 | Done |
| [SPEC-011](./Done/SPEC-011_数据构建管线.md) | 数据构建管线 | Done |
| [SPEC-012](./Done/SPEC-012_语料清理.md) | 语料清理 | Done |
| [SPEC-013](./Done/SPEC-013_服务端检索.md) | 服务端检索（FastAPI） | Done |
| [SPEC-014](./Done/SPEC-014_前端服务降级.md) | 前端服务探活降级 | Done |
| [SPEC-015](./Done/SPEC-015_超长段二次切分.md) | 超长段落二次切分 | Done |
| [SPEC-025](./Done/SPEC-025_流式渲染节流.md) | 流式渲染按帧节流 | Done |
| [SPEC-026](./Done/SPEC-026_生成耗时优化与诊断.md) | 模型优选 + 输出上限 + 生成耗时诊断 | Done |
| [SPEC-027](./Abandoned/SPEC-027_实际模型名标注.md) | 页头标注实际回答的模型名 | Abandoned（平台不回填 `chunk.model`，代码已删） |
| [SPEC-028](./Done/SPEC-028_模型列表查看开关.md) | `?models=1` 查看模型清单 | Done |
| [SPEC-029](./Done/SPEC-029_自检面板模式标注.md) | 自检面板标注真实检索模式 | Done |
| [SPEC-030](./Done/SPEC-030_提问竞态修复.md) | 重复提问/快速切换竞态修复 | Done |
| [SPEC-031](./Done/SPEC-031_检索等待期进度反馈.md) | 检索等待期的进度反馈 | Done |
| [SPEC-032](./Done/SPEC-032_检索过程逐步实时显示.md) | 检索过程逐步实时显示 | Done |
| [SPEC-016](./Abandoned/SPEC-016_浏览器端向量推理.md) | 浏览器端 transformers.js 推理 | Abandoned |
| [SPEC-017](./Abandoned/SPEC-017_大模型路由层.md) | 大模型路由层（自动模式） | Abandoned |
| [SPEC-018](./Abandoned/SPEC-018_查询改写.md) | 查询改写 | Abandoned |
| [SPEC-019](./Abandoned/SPEC-019_三栏布局.md) | 三栏布局与筛选面板 | Abandoned |
| [SPEC-020](./Abandoned/SPEC-020_分离产物结构.md) | 分离产物与文件拆分 | Abandoned |
| [SPEC-021](./Abandoned/SPEC-021_云端重排.md) | 云端重排 | Abandoned |
| [SPEC-022](./Plan/SPEC-022_refs超长分块.md) | refs 类超长 chunk 切分 | Plan |
| [SPEC-023](./Plan/SPEC-023_重排权衡调优.md) | 重排 trade-off 调优 | Plan |
| [SPEC-024](./Plan/SPEC-024_云端int8量化.md) | 云端 int8 量化 | Plan |
| [SPEC-033](./Done/SPEC-033_多知识库切换.md) | 多知识库切换问答 | Done |
| [SPEC-034](./Done/SPEC-034_示例问题随库切换.md) | 示例问题随知识库切换 | Done |

## 范围说明

- **本规格库只覆盖本地项目 `检索页`**（开发侧：页面 + 构建脚本 + 服务端）。
- `检索页-cloud` 是**线上部署环境**，由本项目的产物裁剪而来
  （ONNX 后端、无重排），它不是独立需求源，故不单独建 Spec，
  凡是涉及云端的差异，写在对应 Spec 的「部署差异」小节里。

## 验收总基线（120 题评测集，`tests/eval_cases.json`）

| 档位 | Hit@1 | Hit@5 | MRR |
|---|---|---|---|
| 纯前端 BM25 + 实体（历史起点） | 64.2% | 90.0% | 0.753 |
| 服务端融合，无重排（云端现版） | 72.5% | 93.3% | 0.816 |
| 服务端融合 + 重排（本地完整版） | 79.2% | 97.5% | 0.854 |

**任何改动合并前须满足**：总体 Hit@1 不降，且无题型 Hit@5 退步。
判定命令：`node tests/eval_backend.js`（需先 `python server.py` 起服务）。
