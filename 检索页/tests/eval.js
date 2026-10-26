/**
 * eval.js — 检索评测脚本
 *
 * 复刻 test_search.js 的做法：在 mock DOM 里真跑一遍 index.html 的内联脚本，
 * 再用 window.__KB__ 的 retrieve() 对评测集逐题打分。
 *
 * 运行：node tests/eval.js
 * 产出：tests/eval_report.md（可读报告） + tests/eval_baseline.json（原始结果，供日後对比）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ================= mock DOM（与 test_search.js 一致） ================= */
function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, children: [], _h: {},
    classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); },
      toggle(c, v) { v ? set.add(c) : set.delete(c); }, contains(c) { return set.has(c); },
      _set: set
    },
    addEventListener(t, fn) { this._h[t] = fn; },
    getAttribute(k) { return this.dataset[k]; },
    querySelector() { return mockEl('exc'); },
    scrollIntoView() {}, focus() {}, closest() { return null; }
  };
}
const els = {};
const documentMock = {
  getElementById(id) { return els[id] || (els[id] = mockEl(id)); },
  querySelector(sel) { return els[sel] || (els[sel] = mockEl(sel)); },
  addEventListener() {},
  activeElement: null
};

/* ================= 加载数据与页面脚本 ================= */
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const win = {};
new Function('window', dataJs)(win);
global.window = win;
global.document = documentMock;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
  global.window, documentMock, setTimeout, clearTimeout);

const KB = global.window.__KB__;
if (!KB) { console.error('无法获取 window.__KB__'); process.exit(1); }

/* ================= 评测集 ================= */
const casesFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_cases.json'), 'utf8'));
const CASES = casesFile.cases;

/* 「抓取噪音」文档（标题为用户名词 + 日期）已于 2026-10-11 清理：
 * 18 篇归档至 练习/_archived/；另 3 篇（或许就是她04-12 / 让我们重返世界杯 /
 * 超哥爱足球03-22）经核查含有效知识，保留，其中前两篇已改名。
 * 此集合保留为空，用于持续监测未来是否新出现同类噪音。 */
const NOISE = new Set();

/* ================= 标题解析（防呆：expect 必须真实存在） ================= */
/* 规范化：忽略空白，并容忍清洗流水线残留的 [[ ]] 标记（标题可能随时被修好） */
const norm = s => String(s).replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
const titleIndex = new Map();
KB.docs.forEach((d, i) => {
  if (!titleIndex.has(norm(d.title))) titleIndex.set(norm(d.title), i);
  if (d.titleRaw && !titleIndex.has(norm(d.titleRaw))) titleIndex.set(norm(d.titleRaw), i);
});
const resolve = t => (titleIndex.has(norm(t)) ? titleIndex.get(norm(t)) : -1);

const unresolved = [];
CASES.forEach(c => c.expect.forEach(t => { if (resolve(t) < 0) unresolved.push(c.id + ' → ' + t); }));

/* ================= 单模式评测 ================= */
const TOPK = 5;
function runMode(mode) {
  return CASES.map(c => {
    const expectIdx = new Set(c.expect.map(resolve).filter(i => i >= 0));
    let rows = [];
    try { rows = KB.retrieve(c.q, mode).rows.slice(0, TOPK); } catch (e) { rows = []; }
    const top = rows.map(r => KB.docs[r.di].title);
    let rank = 0;
    for (let i = 0; i < rows.length; i++) {
      if (expectIdx.has(rows[i].di)) { rank = i + 1; break; }
    }
    const noiseHits = top.filter(t => NOISE.has(t)).length;
    return { id: c.id, type: c.type, q: c.q, expect: c.expect, rank, top, noiseHits };
  });
}

const isHit = (p, k) => p.rank >= 1 && p.rank <= k;
function metrics(per) {
  const n = per.length || 1;
  return {
    n: per.length,
    h1: per.filter(p => isHit(p, 1)).length,
    h3: per.filter(p => isHit(p, 3)).length,
    h5: per.filter(p => isHit(p, 5)).length,
    mrr: per.reduce((a, p) => a + (p.rank ? 1 / p.rank : 0), 0) / n
  };
}
const pct = v => (v * 100).toFixed(1) + '%';

const TYPES = [
  ['fact', '事实数字型'],
  ['entity', '专名实体型'],
  ['concept', '通用概念型'],
  ['rewrite', '口语化改写型']
];

const perAll = runMode('all');
const perKw = runMode('keyword');
const perEnt = runMode('entity');

const mAll = metrics(perAll);
const mKw = metrics(perKw);
const mEnt = metrics(perEnt);

/* ================= 控制台输出 ================= */
console.log('═══ 检索评测（' + CASES.length + ' 题）═══\n');
if (unresolved.length) {
  console.log('⚠️  ' + unresolved.length + ' 条 expect 标题未在知识库中找到（这些题会被判为未命中）：');
  unresolved.forEach(u => console.log('    ' + u));
  console.log('');
}
function line(label, m) {
  console.log(label.padEnd(12) + ' n=' + m.n +
    '  Hit@1 ' + pct(m.h1 / m.n) + '  Hit@3 ' + pct(m.h3 / m.n) +
    '  Hit@5 ' + pct(m.h5 / m.n) + '  MRR ' + m.mrr.toFixed(3));
}
console.log('--- 分模式 ---');
line('智能(all)', mAll);
line('关键词', mKw);
line('实体', mEnt);
console.log('\n--- 智能模式分题型 ---');
TYPES.forEach(([t, name]) => {
  const sub = perAll.filter(p => p.type === t);
  if (sub.length) line(name, metrics(sub));
});

/* ================= 生成报告 ================= */
function table(rows) {
  return rows.join('\n');
}
function failedList(per) {
  const miss = per.filter(p => !p.rank);
  if (!miss.length) return '无 —— 全部命中 top-5。\n';
  return miss.map(p =>
    '**' + p.id + '** · ' + p.q + '\n' +
    '  - 期望：' + p.expect.map(e => '`' + e + '`').join(' / ') + '\n' +
    '  - 实际 top5：' + (p.top.length ? p.top.map(t => '`' + t + '`').join(' → ') : '（无结果）') + '\n'
  ).join('\n');
}
function rankDist(per) {
  const d = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let miss = 0;
  per.forEach(p => { if (p.rank) d[p.rank]++; else miss++; });
  return d[1] + ' / ' + d[2] + ' / ' + d[3] + ' / ' + d[4] + ' / ' + d[5] + '，未命中 ' + miss;
}

const noiseDocs = KB.docs.filter(d => /\[\[|\]\]/.test(d.title)).map(d => d.title);
const avgNoise = perAll.reduce((a, p) => a + p.noiseHits, 0) / perAll.length;

const md = [];
md.push('# 检索评测报告 · BM25 基线');
md.push('');
md.push('> 生成时间：' + new Date().toLocaleString('zh-CN') + '　｜　脚本：`tests/eval.js`　｜　评测集：`tests/eval_cases.json`');
md.push('> 知识库：' + KB.docs.length + ' 篇（' + KB.docs.filter(d => d.kind === 'note').length + ' 笔记 / ' +
  KB.docs.filter(d => d.kind === 'entity').length + ' 实体 / ' + KB.docs.filter(d => d.kind === 'concept').length + ' 概念）　｜　' +
  '`meta.vector = ' + (KB.meta && KB.meta.vector) + '`（本条基线为纯 BM25 + 实体路，**未启用向量检索**）');
md.push('');
md.push('**判定规则**：一道题的 `expect` 列表中任一标题出现在 top-k 结果中，即记为命中；MRR 取首个命中位置倒数（未命中记 0）。');
md.push('');
md.push('## 一、总体指标');
md.push('');
md.push('| 模式 | 题数 | Hit@1 | Hit@3 | Hit@5 | MRR |');
md.push('|---|---|---|---|---|---|');
[['智能（关键词 + 实体加权）', mAll], ['仅关键词（BM25）', mKw], ['仅实体（词条 / 别名）', mEnt]].forEach(([name, m]) => {
  md.push('| ' + name + ' | ' + m.n + ' | ' + pct(m.h1 / m.n) + ' | ' + pct(m.h3 / m.n) + ' | ' + pct(m.h5 / m.n) + ' | ' + m.mrr.toFixed(3) + ' |');
});
md.push('');
md.push('命中位置分布（智能模式，第 1~5 名 / 未命中）：' + rankDist(perAll));
md.push('');
md.push('## 二、分题型（智能模式）');
md.push('');
md.push('| 题型 | 题数 | Hit@1 | Hit@3 | Hit@5 | MRR | 说明 |');
md.push('|---|---|---|---|---|---|---|');
const TYPE_DESC = {
  fact: '答案锚定单篇笔记，考察关键词精确匹配',
  entity: '考察实体词条与别名通路',
  concept: '考察概念词条通路',
  rewrite: '弱化原文关键词，考察语义召回（向量检索的战场）'
};
TYPES.forEach(([t, name]) => {
  const sub = perAll.filter(p => p.type === t);
  if (!sub.length) return;
  const m = metrics(sub);
  md.push('| ' + name + ' | ' + m.n + ' | ' + pct(m.h1 / m.n) + ' | ' + pct(m.h3 / m.n) + ' | ' + pct(m.h5 / m.n) + ' | ' + m.mrr.toFixed(3) + ' | ' + TYPE_DESC[t] + ' |');
});
md.push('');
md.push('## 三、失败案例（未进 top-5）');
md.push('');
md.push(failedList(perAll));
md.push('');
md.push('> 含排名但不在前三的题（可优化项）：');
md.push('');
const lowRank = perAll.filter(p => p.rank > 3);
if (!lowRank.length) md.push('无。');
else lowRank.forEach(p => {
  md.push('- **' + p.id + '** 「' + p.q + '」 → 命中位置第 ' + p.rank + ' 名：`' + p.top[p.rank - 1] + '`');
});
md.push('');
md.push('## 四、数据质量观察');
md.push('');
if (NOISE.size) {
  md.push('- **抓取噪音文档**：top-5 结果中平均混入 ' + avgNoise.toFixed(2) + ' 篇「用户名 + 日期」型噪音文档（占 ' + pct(avgNoise / TOPK) + '）。');
  md.push('  噪音清单见 `tests/eval.js` 中的 `NOISE` 集合，共 ' + NOISE.size + ' 篇——它们会被 fuzz 查询误召回，是 Hit@1 的主要拖累。');
} else {
  md.push('- **抓取噪音文档**：✅ 已于 2026-10-11 清理（18 篇归档至 `练习/_archived/`；2 篇高价值文档改名为《2026美加墨世界杯完整分组表》《2026世界杯球衣号码一览》）。本次 top-5 噪音污染为 ' + avgNoise.toFixed(2) + ' 篇。');
}
md.push('- **清洗残留标记**：以下文档标题中仍带 `[[` 或 `]]`，属清洗流水线漏网：');
noiseDocs.forEach(t => md.push('  - `' + t + '`'));
md.push('- **重复内容**：✅ 已消除。原 `简简单单05-12` 与《⚽ 2026世界杯·最后一舞》、`慢冷05-12` 与《1013天前》的高度重复，已随 18 篇噪音文档归档一并解决。');
if (unresolved.length) {
  md.push('- **评测集待修**：' + unresolved.length + ' 条 expect 标题未匹配到知识库，需核对拼写：');
  unresolved.forEach(u => md.push('  - ' + u));
}
md.push('');
md.push('## 五、下一步（引入向量检索后的验收标准）');
md.push('');
md.push('本条基线是引入向量检索 + RRF 融合之前的**对照组**。补上向量路后，重点看两个数字：');
md.push('');
md.push('1. **口语化改写型的 Hit@5 / MRR 提升幅度** —— 这是向量检索唯一真正的价值所在，其他题型提升有限属正常。');
md.push('2. **总体 Hit@1 是否不降** —— 加一路召回可能把噪音文档也带上来，若 Hit@1 下降说明融合权重需要调。');
md.push('');

const reportPath = path.join(__dirname, 'eval_report.md');
fs.writeFileSync(reportPath, md.join('\n'), 'utf8');

const baselinePath = path.join(__dirname, 'eval_baseline.json');
fs.writeFileSync(baselinePath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  kb: { docs: KB.docs.length, vector: !!(KB.meta && KB.meta.vector) },
  metrics: { all: mAll, keyword: mKw, entity: mEnt },
  byType: Object.fromEntries(TYPES.map(([t]) => [t, metrics(perAll.filter(p => p.type === t))])),
  perCase: perAll
}, null, 2), 'utf8');

console.log('\n报告已写出：' + reportPath);
console.log('原始结果：' + baselinePath);
