/**
 * eval_backend.js — 对本地 FastAPI 服务做 120 题全量回归评测
 *
 * 前置：python server.py 已启动（默认 127.0.0.1:8765）
 * 运行：node tests/eval_backend.js
 * 产出：tests/eval_baseline_backend.json + 控制台对比
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BACKEND_URL || 'http://127.0.0.1:8765';

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_cases.json'), 'utf8')).cases;
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'))(win);
const DOCS = win.WIKI_DATA.docs;

const norm = s => String(s).replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
const titleIndex = new Map();
DOCS.forEach((d, i) => {
  if (!titleIndex.has(norm(d.title))) titleIndex.set(norm(d.title), i);
  if (d.titleRaw && !titleIndex.has(norm(d.titleRaw))) titleIndex.set(norm(d.titleRaw), i);
});
const resolve = t => (titleIndex.has(norm(t)) ? titleIndex.get(norm(t)) : -1);

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json();
  if (!health.ok) throw new Error('服务未就绪');
  console.log('服务就绪：', JSON.stringify(health));

  const per = [];
  for (const c of CASES) {
    const res = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent(c.q))).json();
    const expectIdx = new Set(c.expect.map(resolve).filter(i => i >= 0));
    let rank = 0;
    res.rows.forEach((r, i) => { if (!rank && expectIdx.has(r.di)) rank = i + 1; });
    per.push({ id: c.id, type: c.type, q: c.q, expect: c.expect, rank,
      top: res.rows.slice(0, 5).map(r => DOCS[r.di].title) });
    process.stdout.write(`\r${per.length}/${CASES.length}`);
  }
  console.log('');

  const isHit = (p, k) => p.rank >= 1 && p.rank <= k;
  const metrics = arr => {
    const n = arr.length || 1;
    return { n: arr.length,
      h1: arr.filter(p => isHit(p, 1)).length,
      h3: arr.filter(p => isHit(p, 3)).length,
      h5: arr.filter(p => isHit(p, 5)).length,
      mrr: arr.reduce((a, p) => a + (p.rank ? 1 / p.rank : 0), 0) / n };
  };
  const pct = v => (v * 100).toFixed(1) + '%';
  const TYPES = [['fact', '事实数字型'], ['entity', '专名实体型'], ['concept', '通用概念型'], ['rewrite', '口语化改写型']];
  const m = metrics(per);
  console.log('═══ 后端服务评测（120 题，逐题 HTTP）═══');
  console.log(`总体    Hit@1 ${pct(m.h1 / m.n)}  Hit@3 ${pct(m.h3 / m.n)}  Hit@5 ${pct(m.h5 / m.n)}  MRR ${m.mrr.toFixed(3)}`);
  TYPES.forEach(([t, name]) => { const s = metrics(per.filter(p => p.type === t));
    console.log(`${name.padEnd(8)} Hit@1 ${pct(s.h1 / s.n)}  Hit@5 ${pct(s.h5 / s.n)}  MRR ${s.mrr.toFixed(3)}`); });

  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_baseline_v2.json'), 'utf8'));
  console.log('\n--- 对比离线基线 v2 ---');
  const bm = base.metrics.all;
  console.log(`总体   ${pct(bm.h1 / bm.n)} → ${pct(m.h1 / m.n)}  Hit@5 ${pct(bm.h5 / bm.n)} → ${pct(m.h5 / m.n)}  MRR ${bm.mrr.toFixed(3)} → ${m.mrr.toFixed(3)}`);
  const diffs = [];
  per.forEach((p, i) => { if (p.rank !== base.perCase[i].rank) diffs.push(`${p.id}: ${base.perCase[i].rank || '未中'} → ${p.rank || '未中'}`); });
  console.log(`排名不一致题数：${diffs.length}` + (diffs.length ? '\n  ' + diffs.slice(0, 20).join('\n  ') : ''));

  fs.writeFileSync(path.join(__dirname, 'eval_baseline_backend.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), via: 'http://127.0.0.1:8765',
      metrics: { all: m }, byType: Object.fromEntries(TYPES.map(([t]) => [t, metrics(per.filter(p => p.type === t))])), perCase: per }, null, 2));
  console.log('\n已写出 tests/eval_baseline_backend.json');
}

main().catch(e => { console.error(e); process.exit(1); });
