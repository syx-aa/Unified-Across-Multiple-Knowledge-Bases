# SPEC-020 分离产物与文件拆分

> 状态：Abandoned ｜ 原优先级：P2 ｜ 归属：数据层 / 前端 ｜ 归档：2026-10-23

## 1. 原需求

设计方案 v2（第八节）规划的交付结构：

```
data/data.json            {id, 类型, 标题, 分类, 正文, 关键要点, 关联词条}
data/keyword-index.json   中文 bigram + 英文词倒排
data/embeddings.json      每个片段的向量
models/bge-small-zh-v1.5/ ONNX 模型 + 分词器
app.js / style.css        逻辑与样式
```

## 2. 为什么放弃

| 原规划 | 实际 | 原因 |
|---|---|---|
| `data.json` + `keyword-index.json` + `embeddings.json` | 合成 `data.js` 一个文件 | 倒排索引前端启动即时构建（几十毫秒），不必预生成；`file://` 下 `fetch` 会被拦，`<script src>` 不会 |
| `app.js` / `style.css` 分离 | 全部内联进 `index.html` | 无构建步骤、双击即可用 |
| `models/` 随包 | `vector/models/`（仅服务端用） | 浏览器不再推理（SPEC-016），模型只是服务端资源 |

## 3. 替代方案

```
index.html        页面（样式 + 交互 + 内置 BM25 回退）
data.js           数据（构建产物，window.WIKI_DATA）
eval_cases.js     评测集（构建产物）
vector/           向量与模型（仅服务端消费）
server.py         服务端检索
build/            构建脚本
```

## 4. 教训

产物拆分的驱动力应是**加载与缓存策略**，不是「看起来更工程化」。
在 `file://` 可直接打开这个硬约束下，`<script src>` + 单文件是更优解。
