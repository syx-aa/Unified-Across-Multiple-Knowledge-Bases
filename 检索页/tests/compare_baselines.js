/**
 * compare_baselines.js — 通用基线对比工具
 *
 * 用法：
 *   node tests/compare_baselines.js <before.json> <after.json>
 *   例：node tests/compare_baselines.js eval_baseline_dirty.json eval_baseline.json
 *
 * 注意：baseline JSON 中 metrics.h1/h3/h5 存的是【命中计数】，mrr 是比率。
 * 每次优化检索逻辑后，用本工具对比前后两版 eval_baseline*.json，
 * 就能得到「改了哪里、涨了多少」的量化结论。
 */
const fs = require('fs');
const path = require('path');
const D = __dirname;

const beforeName = process.argv[2] || 'eval_baseline_dirty.json';
const afterName = process.argv[3] || 'eval_baseline.json';
const before = JSON.parse(fs.readFileSync(path.join(D, beforeName), 'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(D, afterName), 'utf8'));

const pct = v => (v * 100).toFixed(1) + '%';
const fmt = (k, v, N) => (k === 'mrr' ? v.toFixed(3) : pct(v / N));
const delta = (k, a, b, N) => {
  const x = k === 'mrr' ? (b - a) : (b - a) / N;
  const s = k === 'mrr' ? x.toFixed(3) : (x * 100).toFixed(1) + 'pt';
  return (x > 0 ? '+' : '') + s;
};
const arrow = (a, b) => (b > a ? '↑' : (b < a ? '↓' : '='));

const tag = f => f.replace(/^eval_baseline_?/, '').replace(/\.json$/, '') || 'base';

console.log('# 基线对比：' + tag(beforeName) + '  →  ' + tag(afterName) + '\n');
console.log('> 生成时间：' + new Date().toLocaleString('zh-CN') + '\n');

console.log('## 一、总体指标\n');
console.log('| 指标 | ' + tag(beforeName) + ' | ' + tag(afterName) + ' | 变化 |');
console.log('|---|---|---|---|');
const ALLN = after.metrics.all.n;
[['h1', 'Hit@1'], ['h3', 'Hit@3'], ['h5', 'Hit@5'], ['mrr', 'MRR']].forEach(([k, name]) => {
  const a = before.metrics.all[k], b = after.metrics.all[k];
  console.log('| ' + name + ' | ' + fmt(k, a, ALLN) + ' | ' + fmt(k, b, ALLN) + ' | ' + arrow(a, b) + ' ' + delta(k, a, b, ALLN) + ' |');
});

if (before.byType && after.byType) {
  console.log('\n## 二、分题型\n');
  console.log('| 题型 | 题数 | 指标 | ' + tag(beforeName) + ' | ' + tag(afterName) + ' | 变化 |');
  console.log('|---|---|---|---|---|---|');
  const TYPES = [['fact', '事实数字型'], ['entity', '专名实体型'], ['concept', '通用概念型'], ['rewrite', '口语化改写型']];
  TYPES.forEach(([t, name]) => {
    if (!before.byType[t] || !after.byType[t]) return;
    const N = before.byType[t].n;
    [['h1', 'Hit@1'], ['h5', 'Hit@5'], ['mrr', 'MRR']].forEach(([k, kn], i) => {
      const a = before.byType[t][k], b = after.byType[t][k];
      console.log('| ' + (i === 0 ? name : '') + ' | ' + (i === 0 ? N : '') + ' | ' + kn +
        ' | ' + fmt(k, a, N) + ' | ' + fmt(k, b, N) + ' | ' + arrow(a, b) + ' ' + delta(k, a, b, N) + ' |');
    });
  });
}

console.log('\n## 三、逐题排名变化（仅列有变化者）\n');
const bmap = Object.fromEntries(before.perCase.map(p => [p.id, p]));
const changed = [];
after.perCase.forEach(c => {
  const d = bmap[c.id];
  if (d && d.rank !== c.rank) changed.push({ id: c.id, type: c.type, q: c.q, before: d.rank, after: c.rank });
});
if (!changed.length) console.log('无变化。');
else {
  console.log('| 题号 | 题型 | 问题 | 前 | 后 | 判定 |');
  console.log('|---|---|---|---|---|---|');
  changed.forEach(c => {
    const verdict = (c.before === 0 && c.after > 0) ? '✅ 未命中 → 命中'
      : (c.before > 0 && c.after === 0) ? '❌ 命中 → 未命中'
        : (c.after < c.before) ? '↑ 排名提前' : '↓ 排名后移';
    console.log('| ' + c.id + ' | ' + c.type + ' | ' + c.q + ' | ' +
      (c.before || '未命中') + ' | ' + (c.after || '未命中') + ' | ' + verdict + ' |');
  });
}
const gain = changed.filter(c => (c.before === 0 && c.after > 0) || (c.before > 0 && c.after > 0 && c.after < c.before)).length;
const loss = changed.filter(c => (c.before > 0 && c.after === 0) || (c.before > 0 && c.after > c.before)).length;
console.log('\n**净变化**：改善 ' + gain + ' 题 · 退步 ' + loss + ' 题 · 共 ' + changed.length + ' 题排名变动');
