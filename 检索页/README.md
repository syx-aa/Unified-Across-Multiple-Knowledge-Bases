# 知识库 · 智能问答页

把清洗后的知识库语料编译成一个**问答页**，支持在**多个知识库之间切换**检索。

当前接入三个库：

| 库 | 笔记 | 实体 | 概念 |
|---|---|---|---|
| 世界杯 | 54 | 62 | 14 |
| 企业内部项目文档 | 104 | 125 | 102 |
| 小红书AI帖子 | 85 | 25 | 25 |

> **开发约束：[开发约束.md](./开发约束.md)**
> 开发前必读 —— 尤其是 **R-01**：降级必须先询问负责人并给出方案与影响。

> **功能规格库：[specs/README.md](./specs/README.md)**
> 按 SpecDD 组织，每项功能都有验收标准（AC）与判定命令，
> 按 `Done / Indevelopment / Abandoned / Plan` 四档归档，共 34 项。

页面有五样东西：**知识库切换器**、**一个提问框**、**一个搜索方式切换**、**检索过程 trace**、**答案区**。

## 快速开始

**方式一：直接双击** `index.html`
数据按当前知识库动态载入（`data.js` / `data-enterprise.js` / `data-xiaohongshu.js`），
`file://` 双击打开也能切换；但**大模型通道会因域名未授权而拒绝**，此时页面自动降级为本地摘要。

**方式二：起本地服务**

```bash
python serve.py          # 默认 8765，自动打开浏览器
python serve.py 8080     # 指定端口
```

**方式三：发布上线（大模型唯一可用的方式）**
云服务强制校验访问域名（Origin），只有发布后的线上地址才被授权。

## 目录结构

```
检索页/
├── index.html          页面（样式与交互全在这一个文件里）
├── data.js             世界杯库数据（构建产物，window.WIKI_DATA = {...}）
├── data-enterprise.js  企业内部项目文档库数据
├── data-xiaohongshu.js 小红书AI帖子库数据
├── data/               各库清洗结果（含各自的 examples.txt 示例问题）
├── eval_cases.js       评测集（构建产物，供页面「检索自检」用）
├── server.py           服务端检索（FastAPI：三路融合 + 重排）
├── serve.py            本地静态服务
├── build/              构建脚本（改语料或重建向量时才跑）
│   ├── clean_wiki.py        Raw 原始文档 → 标准知识库结构（清洗）
│   ├── build_data.py        知识库 md → data-<db>.js（含分块）
│   ├── export_docs.js       data.js → vector/docs.json
│   ├── build_eval_cases.js  tests/eval_cases.json → eval_cases.js
│   ├── download_models.py   从魔搭下载 bge embedding / reranker
│   ├── build_vectors.py     chunk 向量化 → Chroma + vectors.json
│   ├── export_onnx.py       torch → ONNX（云端轻量版用）
│   └── rerank.py            bge-reranker 对候选对打分
├── tests/              测试与评测（每次改动后跑，用来验证质量）
│   ├── test_search.js       自测：检索 / 答案 / 渲染 / 边界
│   ├── test_llm.js          自测：大模型通道（模拟 SDK 流式返回）
│   ├── test_selfcheck.js    自测：页面自检与离线基线数值一致
│   ├── test_selfcheck_mode.js 自测：自检面板标注真实检索模式（SPEC-029）
│   ├── test_concurrent.js   自测：重复提问/快速切换的竞态防护（SPEC-030）
│   ├── test_progress_feedback.js 自测：检索等待期进度反馈 + 逐步实时显示（SPEC-031/032）
│   ├── test_database_switch.js  自测：多知识库切换（SPEC-033）
│   ├── test_stream_render.js 自测：流式渲染按帧节流（SPEC-025）
│   ├── eval.js              检索评测：120 题 × Hit@k / MRR
│   ├── eval_v2.js           混合检索 + 重排评测（stage1 / final）
│   ├── eval_backend.js      服务端检索回归（BACKEND_URL 可指向线上）
│   ├── compare_baselines.js 基线对比：两版 eval_baseline*.json 的涨跌
│   ├── eval_cases.json      评测集（四类题型，人工维护的源头）
│   ├── eval_baseline*.json  历史基线快照
│   └── eval_report.md       评测报告（自动生成）
├── specs/              功能规格库（SpecDD，按完成状态归档）
│   ├── Done/ Indevelopment/ Abandoned/ Plan/
│   └── README.md
└── README.md
```

## 三种搜索方式

| 模式 | 含义 |
|---|---|
| **智能** | 关键词 + 实体 两路合并，`0.6 × 关键词 + 0.4 × 实体`；输入基本就是词条名时该词条保底靠前 |
| **关键词** | 只按字面匹配（BM25），擅长专名、数字 |
| **实体** | 只查词条名与别名，如 `cr7` → C罗、`netherlands` → 荷兰 |

搜索方式决定**取哪些资料**，取到的资料再交给大模型生成答案。

**参考来源**每条都标注**相似度百分比**（1–100%）：
- 取自该条的检索综合得分（关键词路 / 实体路按本次查询归一后的加权分），`四舍五入 × 100`
- 颜色分三档：≥70% 金色、40–69% 蓝色、<40% 灰蓝
- 来源按相似度从高到低排列（同分时笔记优先）

> 注意：该百分比是**相对本次查询**的相关度，不是跨查询可比的绝对指标。

## 页面上的「检索过程」面板

答案卡上方有一个可折叠面板，**把上面这条链路逐步摊开**，让你看到「拿到问题后先干什么、再干什么」：

| # | 步骤 | 展示的内容 |
|---|---|---|
| 1 | 分词 | 问题被切成几个词元（中文相邻二字 + 英文数字词），前 12 个列出来 |
| 2 | 关键词路 | 倒排索引命中多少篇 · BM25 最高原始分 |
| 3 | 实体路 | 命中了哪些词条/别名 · 带出多少篇文档 · 其中几篇是精确命中 |
| 4 | 归一化融合 | 两路归一后按 `0.6×关键词 + 0.4×实体` 加权 → 多少篇候选 |
| 5 | 相关度闸门 | 通过 / 未通过（未通过会标红，并说明原因） |
| 6 | 取料 | 交给大模型几篇、页面标注几条来源 |
| 7 | 生成 | 流式中显示「作答中…」，完成后显示用时；降级则显示「回退本地摘要」 |

- 面板头部显示**总步数与检索耗时**（毫秒），点击可折叠/展开
- 无结果时，第 5 步（闸门）会标红并给出拦截原因，第 7 步显示「未生成」

## 页面上的「检索自检」按钮

页头数据行右侧有一个 **检索自检** 按钮，点一下就用评测集在**浏览器里当场跑一遍检索评测**——
演示或面试时不必开命令行，就能把量化结果摆在对方面前。

面板分三层往下看：

| 层 | 内容 |
|---|---|
| 指标卡 | **Hit@1 / Hit@3 / Hit@5 / MRR** —— 正确原文进前 k 名的比例，以及排序质量 |
| 分题型表 | 事实数字型 / 专名实体型 / 通用概念型 / 口语化改写型，各自命中率 + 总体行 |
| 未命中清单 | 没进前 5 名的题目，逐题列出「应命中的文档」与「实际返回的前 3」，便于定位是检索问题还是标注问题 |

- 120 题**分块执行**并显示进度条，浏览器内 1 秒左右跑完
- **不调用大模型**，纯检索指标 —— 所以离线与线上必然一致
- 判定规则与 `tests/eval.js` 完全一致，结果与离线基线**逐项相同**（`node tests/test_selfcheck.js` 专门校验这一点）

## 答案是怎么来的

```
提问 → 检索取料（BM25 + 实体/别名） → 拼资料（≤6 篇，≤6200 字）
     → 大模型流式作答 → 标注参考来源
```

1. **检索**：中文二元切分（bigram）倒排索引 + BM25 排序（标题权重 ×3），叠加实体/别名通路
2. **取料**：命中的笔记正文（分段）+ 词条简介，限长后拼成给模型的上下文
3. **生成**：`cloud.llm.chat.completions.create({ stream: true })`，逐字流式渲染；
   `messages[0]` 固定为 system 提示词，约束模型**只能依据资料作答、不得编造**
4. **降级**：无模型 / 报错 / 流中断 → 回退本地摘要或保留已生成内容，并**明确标注**，不静默失败

## 大模型接入（已开通）

- 云服务应用：`世界杯问答`（`wbapp_pG8XenfRmDD41KjXaItJFl`）
- 客户端：`@tencent-ai/workbuddy-cloud-sdk@dev`（CDN 全局 `WorkBuddyCloud`）
- 初始化只用公开配置：`endpoint` / `oauthRelayBaseUrl` / `publishableKey`（无权限，可随前端发布）
- 免密钥：**不需要你提供任何 API Key**

## 重新生成数据

```bash
python build/build_data.py        # 重新生成 data.js
node build/build_eval_cases.js    # 重新打包评测集 eval_cases.js（改过评测集后必跑）
node tests/test_search.js         # 自测：检索与渲染
node tests/test_llm.js            # 自测：大模型通道
node tests/test_selfcheck.js      # 自测：页面自检与离线基线一致
```

脚本会自动解析 `index.md` 的分类导航与别名表；词条有增删，页面自动跟着变。

## 检索效果评测

给检索质量建一把**可量化的尺子**。跑一次评测：

```bash
node tests/eval.js
```

- 评测集：`tests/eval_cases.json`，120 题，分四类题型
- 判定规则：`expect` 列表中任一标题进入 top-k 即记为命中；MRR 取首个命中位置的倒数
- 产出：`tests/eval_report.md`（可读报告）+ `tests/eval_baseline.json`（原始结果）
- **线上同款**：页面右上角的「检索自检」按钮，用同一评测集在浏览器内跑同一套指标（见上文），结果与离线基线逐项相同

**当前基线（2026-10-11，纯 BM25 + 实体路，`meta.vector = false`）**

| 题型 | 题数 | 考察什么 | Hit@1 | Hit@5 | MRR |
|---|---|---|---|---|---|
| 事实数字型 | 40 | 答案锚定单篇笔记，关键词精确匹配 | 52.5% | 95.0% | 0.697 |
| 专名实体型 | 30 | 实体词条与别名通路 | 100% | 100% | 1.000 |
| 通用概念型 | 14 | 概念词条通路 | 71.4% | 85.7% | 0.786 |
| 口语化改写型 | 36 | 弱化原文关键词，语义召回 | 44.4% | 77.8% | 0.596 |
| **总体（智能模式）** | **120** | | **64.2%** | **90.0%** | **0.753** |

> **口语化改写型（44.4% / 77.8%）是全表最弱项**，正是向量检索要赢回的战场。
> 补上向量路后重点验收：① 该项 Hit@5 / MRR 是否显著提升；② 总体 Hit@1 是否不降。

### 对比任意两版基线

```bash
node tests/compare_baselines.js eval_baseline_dirty.json eval_baseline.json
```

输出总体 / 分题型的涨跌，以及逐题排名变化（含「未命中 → 命中」的翻盘项）。
历史快照：`eval_baseline_dirty.json`（清理前 72 篇）、`eval_baseline_clean.json`（清理后 54 篇）。

## 语料清理（2026-10-11）

用评测结果反查数据质量，处理了 21 篇「用户名 + 日期」型抓取噪音：

| 处理 | 数量 | 说明 |
|---|---|---|
| 归档到 `练习/_archived/` | 18 篇 | 12 篇纯噪音（彩票票面、求带、视频目录等）+ 6 篇内容重复 |
| 改名保留 | 2 篇 | `或许就是她04-12` → 《2026美加墨世界杯完整分组表》（含完整 A–L 分组表）；`让我们重返世界杯` → 《2026世界杯球衣号码一览》 |
| 原样保留 | 1 篇 | `超哥爱足球03-22`（2022 赛事集锦，真实足球事实） |

- 笔记 **72 → 54 篇**，语料 114,266 字
- 同步剪枝：节点页 **171 处失效引用** + **109 处改名引用**，并重算「关联笔记 N 篇」计数
- 全量备份：`E:\课件\_backup_练习_20261011\`（可完整回滚）

**清理效果**（`compare_baselines.js` 实测）：

| 指标 | 清理前 | 清理后 | 变化 |
|---|---|---|---|
| 总体 Hit@1 | 64.2% | 64.2% | = |
| 总体 Hit@5 | 88.3% | 90.0% | ↑ 1.7pt |
| 总体 MRR | 0.746 | 0.753 | ↑ 0.007 |
| 事实数字型 Hit@1 | 50.0% | 52.5% | ↑ 2.5pt |
| 口语化改写型 Hit@5 | 75.0% | 77.8% | ↑ 2.8pt |

逐题：改善 8 题、退步 4 题。其中 **F13「A组都有哪些球队」由未命中转为命中**——这是改名的直接收益：该文档装着完整分组表，原先因标题是用户名而检索不到。

> 提升幅度有限（噪音只占 17 KB）——**它的主要价值不是涨分，而是让后续优化的对照组变干净**。真正的涨分在向量检索那一步。

## 向量检索 + 重排（2026-10-23 已完成，离线管线）

在原「关键词 + 实体」之外，补齐了**向量语义召回**与**cross-encoder 重排**，构成完整三路混合检索。
模型推理在 Python 侧完成（不进浏览器），向量存入 **Chroma 向量数据库**（本地持久化）。

### 链路

```
离线（Python，vector/ 目录）
  docs.js ──export_docs.js──▶ docs.json
  bge-small-zh-v1.5 ──▶ 1037 个 chunk 向量 ──▶ Chroma 持久化库（vector/chroma_db）
  120 道评测题 ──▶ 问题向量 ──▶ vectors.json
在线评测（Node，复用线上同一套 BM25/实体逻辑）
  融合：0.45×关键词 + 0.25×实体 + 0.30×向量（文档分 = 其 chunk 最大余弦）
  候选：融合 top-30 ∪ 向量 top-30 ──▶ bge-reranker-base 打分（4372 对）
  重排：rerank 分排序；精确实体命中保护（词条是权威答案，绕过重排）
```

### 效果（120 题实测）

| 题型 | BM25 基线 Hit@1 | 混合+重排 Hit@1 | 基线 Hit@5 | 混合+重排 Hit@5 | MRR |
|---|---|---|---|---|---|
| 事实数字型 | 52.5% | **77.5%** | 95.0% | 95.0% | 0.697 → 0.850 |
| 专名实体型 | 100% | 100% | 100% | 100% | 1.000 → 1.000 |
| 通用概念型 | 71.4% | **85.7%** | 85.7% | **100%** | 0.786 → 0.899 |
| 口语化改写型 | 44.4% | **61.1%** | 77.8% | **91.7%** | 0.596 → 0.728 |
| **总体** | **64.2%** | **79.2%** | **90.0%** | **95.8%** | **0.753 → 0.857** |

- 验收标准达成：口语化改写型 Hit@5 **77.8% → 91.7%**（+13.9pt），总体 Hit@1 **不降反升 +15pt**
- 逐题净变化：改善 35 题 · 退步 15 题（`node tests/compare_baselines.js eval_baseline_clean.json eval_baseline_v2.json`）
- **已知代价**：两道「揭幕战」题从第 2 名掉出 top-5——cross-encoder 对内容更丰富的干扰文档打分偏高，
  这是重排的真实 trade-off，也是后续继续调优的方向
- **关键设计：精确实体命中保护**。纯单词查询（如「梅西」）时 cross-encoder 会系统性偏向内容丰富的笔记
  而非实体词条（实测把实体型从 100% 拉低到 40%），因此词条精确命中绕过重排——修复后回到 100%

### 复跑

```bash
python build/download_models.py       # 首次：魔搭下载两个模型（免 VPN）
python build/build_vectors.py         # 语料变更后：重算向量 + 更新 Chroma
node tests/eval_v2.js stage1          # 混合评测 + 导出重排候选
python build/rerank.py                # reranker 打分（CPU 约 20 分钟）
node tests/eval_v2.js final           # 应用重排，出最终指标与对比
```

> **演进说明**：上表的重排完整版最初以离线管线形态存在（`meta.vector = false`，纯前端跑不了模型推理）。
> 随后完成了 **P3 后端化**（见下节）——线上现在跑的就是服务端检索。

## P3 后端化：FastAPI 检索服务（2026-10-23 上线）

检索整体搬进服务端常驻进程（`server.py`，FastAPI + uvicorn），浏览器只负责发问题、展示答案。
**线上**（`worldcup-qa.app.workbuddy.host`）现在是「Python 服务 + 静态页」混合应用：
页面加载时探测同源 `/api/health`，可达 → 检索走服务端；不可达（本地 `file://` 打开、服务未启动）→
自动回退内置 BM25，不报错。

### 双运行时设计（按权重文件是否存在自动选路）

| | 本地（`检索页/`，含 `model.safetensors`） | 轻量部署（只有 `model.onnx`） |
|---|---|---|
| embedding | torch（fp32） | **ONNX Runtime**（fp32，无 torch/CUDA 依赖） |
| 重排 | bge-reranker-base（torch） | 停用，按融合分排序 |
| 单次检索耗时 | ~10s（重排占大头） | **~31ms** |
| 启动依赖 | `requirements.txt`（含 torch / transformers / chromadb） | 精简版：仅 numpy + onnxruntime |

判断规则在 `server.py`：**有无 `model.safetensors` 决定走 torch 还是 ONNX**，
`EMB_BACKEND=onnx` 环境变量可强制走轻量路。

> 2026-10-24：原 `检索页-cloud/` 部署副本已删除（移入回收站）。
> 待本地链路全部验证通过后再重建上线。

#### 本地起服务端

系统自带 Python（`E:\py\python.exe`）已损坏，改用 workbuddy 的 Python 3.14：

```powershell
$py = "C:\Users\24504\.workbuddy\binaries\python\versions\3.14.3\python.exe"
& $py server.py            # 端口 8765，加载 torch 权重 + 重排，约 20s 就绪
```

就绪后打开 http://127.0.0.1:8765/api/health 应返回：

```json
{"ok":true,"engine":"server","docs":130,
 "models":{"embedding":"bge-small-zh-v1.5 (torch)","reranker":"bge-reranker-base"},
 "vectorDb":{"type":"chroma(persisted) + in-memory index","vectors":1079}}
```

看到 `engine=server` 且 `reranker` 非 null 即说明三路融合 + 重排全程生效，
页面会自动从两路降级切到服务端模式。

### 三档实测指标（120 题，同评测集）

| 档位 | 检索方式 | Hit@1 | Hit@5 | MRR |
|---|---|---|---|---|
| 原线上（纯前端 BM25+实体） | `meta.vector=false` | 64.2% | 90.0% | 0.753 |
| **线上现版**（服务端融合，ONNX，无重排） | `BACKEND_URL=线上 node tests/eval_backend.js` | **72.5%** | **93.3%** | **0.816** |
| 完整版（服务端，torch + bge-reranker） | `node tests/eval_backend.js`（本地服务） | **79.2%** | **97.5%** | **0.854** |

- **移植验证**：Python 复刻的 BM25/实体路对 120 题与 JS 版聚合指标一致（16 题排名微差，净效果持平略升）
- 评测快照：`eval_baseline_backend.json`（本地完整版）· `eval_baseline_online.json`（线上轻量版）

### 本地运行

```bash
pip install -r requirements.txt        # 完整版含 torch；云端版不含
python server.py                       # 默认 8765 端口，可用环境变量 PORT 覆盖
# 打开 http://127.0.0.1:8765 → 页头提示"服务端检索"即生效；trace 面板会标注服务端步骤
node tests/eval_backend.js             # 120 题回归（BACKEND_URL 可指向任意环境）
node tests/eval_v2.js final            # 离线对照（Python 预计算分数）
```

### 接口

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 服务状态（embedding 后端 / reranker 是否可用 / 向量数） |
| `GET /api/search?q=...&rerank_top=30` | 融合检索 + 重排，返回 rows/terms/exact/trace |
| `GET /` | 静态托管问答页（index.html / data.js / eval_cases.js） |

### 关键实现决策（面试可讲）

1. **权重文件决定运行时**，而非"有没有 torch"——沙箱预装 torch 也能正确走 ONNX 路径
2. **精确实体保护在服务端复刻**：搜"梅西"时 cross-encoder 会偏向内容丰富的笔记，词条精确命中绕过重排
3. **Chroma 负责持久化，查询走内存索引**：1037×512 的量级，逐查询打向量库反而慢于内存点积
   （chromadb 1.5.9 在 Windows 跨进程读 HNSW 段存在 bug，内存索引同时规避了它）
4. **前端降级链**：服务端探活 2.5s 超时 → 回退内置 BM25 → 页头提示切换，全程无硬错误

## 数据来源

- 语料：`E:\课件\练习\Cleaned\`（小红书笔记清洗后）
- 词条：`E:\课件\练习\entity\`、`E:\课件\练习\concept\`
- 分类与别名：`E:\课件\练习\index.md`、
  `F:\世界杯数据库查询\LLM Wiki\LLM Wiki\3、世界杯\Wiki\index.md`（别名表，2026-10-24 从 E 盘移入本项目）

