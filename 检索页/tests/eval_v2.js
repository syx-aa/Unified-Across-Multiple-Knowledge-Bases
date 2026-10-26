/**
 * eval_v2.js — 混合检索（关键词 + 实体 + 向量）+ 重排 评测
 *
 * 用法：
 *   node tests/eval_v2.js stage1   # 融合检索评测，输出候选集 vector/candidates.json
 *   node tests/eval_v2.js final    # 应用 vector/rerank_scores.json，输出最终报告与对比
 *
 * 数据流：
 *   data.js + index.html(KB) → 关键词/实体分（复用线上同一套逻辑，保证同口径）
 *   vector/vectors.json      → chunk 向量（Python bge-small-zh-v1.5 预计算）
 *   vector/rerank_scores.json→ bge-reranker-base 预打分
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const VDIR = path.join(ROOT, 'vector');
const phase = process.argv[2] || 'stage1';

/* ================= mock DOM（与 eval.js 一致） ================= */
function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, children: [], _h: {},
    classList: { add(c) { set.add(c); }, remove(c) { set.delete(c); },
      toggle(c, v) { v ? set.add(c) : set.delete(c); }, contains(c) { return set.has(c); }, _set: set },
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
  addEventListener() {}, activeElement: null
};

/* ================= 加载页面与数据 ================= */
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'))(win);
global.window = win;
global.document = documentMock;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
  global.window, documentMock, setTimeout, clearTimeout);
const KB = global.window.__KB__;

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_cases.json'), 'utf8')).cases;
const VEC = JSON.parse(fs.readFileSync(path.join(VDIR, 'vectors.json'), 'utf8'));

/* ================= 标题解析（与 eval.js 同规则） ================= */
const norm = s => String(s).replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
const titleIndex = new Map();
KB.docs.forEach((d, i) => {
  if (!titleIndex.has(norm(d.title))) titleIndex.set(norm(d.title), i);
  if (d.titleRaw && !titleIndex.has(norm(d.titleRaw))) titleIndex.set(norm(d.titleRaw), i);
});
const resolve = t => (titleIndex.has(norm(t)) ? titleIndex.get(norm(t)) : -1);
const unresolved = [];
CASES.forEach(c => c.expect.forEach(t => { if (resolve(t) < 0) unresolved.push(c.id + ' → ' + t); }));

/* ================= 向量索引：doc → 其 chunk 向量 ================= */
const docId2Idx = new Map();
KB.docs.forEach((d, i) => docId2Idx.set(d.id, i));
const chunksByDoc = new Map();   // docIdx -> [{i, v}]
VEC.chunks.forEach(c => {
  const di = docId2Idx.get(c.doc);
  if (di == null) return;
  if (!chunksByDoc.has(di)) chunksByDoc.set(di, []);
  chunksByDoc.get(di).push(c.v);
});
const dim = VEC.dim;

function docVecScore(qv, di) {
  const list = chunksByDoc.get(di);
  if (!list) return 0;
  let best = -Infinity;
  for (const v of list) {
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += qv[j] * v[j];
    if (dot > best) best = dot;
  }
  return best;   // 已归一化向量，点积即余弦；取该文档所有 chunk 的最大值
}

/* ================= 融合检索 ================= */
const W = { k: 0.45, e: 0.25, v: 0.30 };   // 关键词 / 实体 / 向量
const VTOP = 40;                            // 向量路兜底召回条数

function fusedRows(q, qid) {
  const qv = VEC.queries[qid];
  const base = KB.retrieve(q, 'all');        // 复用线上关键词+实体融合
  const cand = new Map();                    // di -> {k, e, v}
  base.rows.forEach(r => cand.set(r.di, { k: r.k, e: r.e, v: 0 }));

  // 向量路：全部文档算余弦，取 top-VTOP 兜底
  const vrows = [];
  for (let di = 0; di < KB.docs.length; di++) {
    const s = docVecScore(qv, di);
    if (s > 0) vrows.push([di, s]);
  }
  vrows.sort((a, b) => b[1] - a[1]);
  const vTop = vrows.length ? vrows[0][1] : 1;
  vrows.slice(0, VTOP).forEach(([di, s]) => {
    const c = cand.get(di) || { k: 0, e: 0, v: 0 };
    c.v = s / (vTop || 1);                   // 归一化到与 k/e 同尺度
    cand.set(di, c);
  });

  const rows = [];
  cand.forEach((c, di) => {
    const s = W.k * c.k + W.e * c.e + W.v * c.v;
    if (s <= 0) return;
    rows.push({ di, score: s, k: c.k, e: c.e, v: c.v });
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/* rerank 用的文档文本（标题 + 正文前 450 字） */
function docText(di) {
  const d = KB.docs[di];
  const body = (d.chunks || []).map(c => c.r).join(' ').replace(/\[\[|\]\]/g, '');
  return (d.title.replace(/\[\[|\]\]/g, '') + '\n' + body).slice(0, 500);
}

/* ================= 指标 ================= */
const isHit = (p, k) => p.rank >= 1 && p.rank <= k;
function metrics(per) {
  const n = per.length || 1;
  return { n: per.length,
    h1: per.filter(p => isHit(p, 1)).length,
    h3: per.filter(p => isHit(p, 3)).length,
    h5: per.filter(p => isHit(p, 5)).length,
    mrr: per.reduce((a, p) => a + (p.rank ? 1 / p.rank : 0), 0) / n };
}
const pct = v => (v * 100).toFixed(1) + '%';
function line(label, m) {
  console.log(label.padEnd(14) + ' n=' + m.n +
    '  Hit@1 ' + pct(m.h1 / m.n) + '  Hit@3 ' + pct(m.h3 / m.n) +
    '  Hit@5 ' + pct(m.h5 / m.n) + '  MRR ' + m.mrr.toFixed(3));
}
const TYPES = [['fact', '事实数字型'], ['entity', '专名实体型'], ['concept', '通用概念型'], ['rewrite', '口语化改写型']];

/* ================= stage1：融合评测 + 导出候选 ================= */
if (phase === 'stage1') {
  console.log('═══ 混合检索评测（0.45×关键词 + 0.25×实体 + 0.30×向量）═══\n');
  if (unresolved.length) {
    console.log('⚠️ ' + unresolved.length + ' 条 expect 未匹配：'); unresolved.forEach(u => console.log('  ' + u)); console.log('');
  }
  const per = CASES.map(c => {
    const expectIdx = new Set(c.expect.map(resolve).filter(i => i >= 0));
    const rows = fusedRows(c.q, c.id).slice(0, 5);
    let rank = 0;
    rows.forEach((r, i) => { if (!rank && expectIdx.has(r.di)) rank = i + 1; });
    return { id: c.id, type: c.type, q: c.q, expect: c.expect, rank,
      top: rows.map(r => KB.docs[r.di].title) };
  });

  const m = metrics(per);
  line('总体', m);
  TYPES.forEach(([t, name]) => { const sub = per.filter(p => p.type === t); if (sub.length) line(name, metrics(sub)); });

  // 权重敏感性参考（仅控制台，防过拟合提示）
  console.log('\n--- 权重敏感性（Hit@1 / Hit@5 / MRR）---');
  [[0.6, 0.4, 0], [0.5, 0.2, 0.3], [0.45, 0.25, 0.3], [0.4, 0.2, 0.4], [0.3, 0.15, 0.55]].forEach(([wk, we, wv]) => {
    W.k = wk; W.e = we; W.v = wv;
    const p2 = CASES.map(c => {
      const expectIdx = new Set(c.expect.map(resolve).filter(i => i >= 0));
      const rows = fusedRows(c.q, c.id).slice(0, 5);
      let rank = 0;
      rows.forEach((r, i) => { if (!rank && expectIdx.has(r.di)) rank = i + 1; });
      return { rank };
    });
    const mm = metrics(p2);
    console.log(`k=${wk} e=${we} v=${wv}  →  ${pct(mm.h1 / mm.n)} / ${pct(mm.h5 / mm.n)} / ${mm.mrr.toFixed(3)}`);
  });

  // 导出 rerank 候选：融合 top-30 ∪ 向量 top-30（融合态权重）
  W.k = 0.45; W.e = 0.25; W.v = 0.30;
  const RECALL = 30;
  const candMap = {};    // qid -> [docIdx]
  const docTexts = {};   // docIdx -> text
  CASES.forEach(c => {
    const qv = VEC.queries[c.id];
    const fusedTop = fusedRows(c.q, c.id).slice(0, RECALL).map(r => r.di);
    const vlist = [];
    for (let di = 0; di < KB.docs.length; di++) {
      const s = docVecScore(qv, di);
      if (s > 0) vlist.push([di, s]);
    }
    vlist.sort((a, b) => b[1] - a[1]);
    const vecTop = vlist.slice(0, RECALL).map(r => r[0]);
    const set = [...new Set(fusedTop.concat(vecTop))];
    candMap[c.id] = set;
    set.forEach(di => { if (!docTexts[di]) docTexts[di] = docText(di); });
  });
  fs.writeFileSync(path.join(VDIR, 'candidates.json'), JSON.stringify({
    recall: RECALL, candidates: candMap,
    docTexts: Object.fromEntries(Object.entries(docTexts).map(([k, v]) => [k, v]))
  }), 'utf8');
  console.log('\n候选集已导出 → vector/candidates.json（' +
    CASES.length + ' 题 × ~' + Math.round(Object.values(candMap).reduce((a, b) => a + b.length, 0) / CASES.length) + ' 篇/题）');
  console.log('下一步：python build/rerank.py');
  process.exit(0);
}

/* ================= final：应用 rerank，出报告 ================= */
if (phase === 'final') {
  const RR = JSON.parse(fs.readFileSync(path.join(VDIR, 'rerank_scores.json'), 'utf8'));
  const TOPK = 5;
  const per = CASES.map(c => {
    const expectIdx = new Set(c.expect.map(resolve).filter(i => i >= 0));
    const cands = RR.candidates[c.id] || [];
    const scores = RR.scores[c.id] || {};
    /* 精确实体命中保护：查询词与词条名/别名完全一致时，实体词条是权威答案，
     * cross-encoder 对这种"短查询 vs 丰富笔记"的场景会系统性偏向笔记，需绕过重排 */
    const ent = KB.retrieve(c.q, 'entity');
    const pinned = ent.rows.filter(r => ent.exact.get(r.di)).map(r => r.di);
    const pinnedSet = new Set(pinned);
    // 其余候选按 rerank 分数排序；无分的退回融合序
    const rest = cands.filter(di => !pinnedSet.has(di))
      .sort((a, b) => (scores[b] ?? -9) - (scores[a] ?? -9));
    const order = pinned.concat(rest).slice(0, TOPK);
    let rank = 0;
    order.forEach((di, i) => { if (!rank && expectIdx.has(di)) rank = i + 1; });
    return { id: c.id, type: c.type, q: c.q, expect: c.expect, rank,
      top: order.map(di => KB.docs[di].title) };
  });

  console.log('═══ 混合检索 + bge-reranker 重排（最终）═══\n');
  const m = metrics(per);
  line('总体', m);
  TYPES.forEach(([t, name]) => { const sub = per.filter(p => p.type === t); if (sub.length) line(name, metrics(sub)); });

  // 与清理后 BM25 基线对比
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_baseline_clean.json'), 'utf8'));
  const bm = base.metrics.all;
  console.log('\n--- 对比基线（纯 BM25 + 实体）---');
  console.log('总体   Hit@1 ' + pct(bm.h1 / bm.n) + ' → ' + pct(m.h1 / m.n) +
    '   Hit@5 ' + pct(bm.h5 / bm.n) + ' → ' + pct(m.h5 / m.n) +
    '   MRR ' + bm.mrr.toFixed(3) + ' → ' + m.mrr.toFixed(3));
  TYPES.forEach(([t, name]) => {
    const b = base.byType[t], s = metrics(per.filter(p => p.type === t));
    console.log(name.padEnd(8) + ' Hit@1 ' + pct(b.h1 / b.n) + ' → ' + pct(s.h1 / s.n) +
      '   Hit@5 ' + pct(b.h5 / b.n) + ' → ' + pct(s.h5 / s.n) +
      '   MRR ' + b.mrr.toFixed(3) + ' → ' + s.mrr.toFixed(3));
  });

  // 未命中清单
  const miss = per.filter(p => !p.rank);
  console.log('\n--- 未进 top-5（' + miss.length + ' 题）---');
  miss.forEach(p => console.log(p.id + ' 「' + p.q + '」 期望: ' + p.expect.join('/') + '  实际: ' + (p.top.join(' → ') || '无')));

  // 产出
  fs.writeFileSync(path.join(__dirname, 'eval_baseline_v2.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    kb: { docs: KB.docs.length, vector: true, rerank: 'bge-reranker-base' },
    fusion: W, recall: RR.recall,
    metrics: { all: m }, byType: Object.fromEntries(TYPES.map(([t]) => [t, metrics(per.filter(p => p.type === t))])),
    perCase: per
  }, null, 2), 'utf8');
  console.log('\n新基线已写出 → tests/eval_baseline_v2.json');
  process.exit(0);
}

console.error('未知 phase：' + phase + '（可用：stage1 / final）');
process.exit(1);
