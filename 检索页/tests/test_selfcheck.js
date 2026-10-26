/**
 * test_selfcheck.js — 页面「检索自检」功能自测
 *
 * 两件事：
 *   1. 一致性：页面内自检结果必须与离线基线 tests/eval_baseline.json 完全一致
 *      （同数据、同规则，只跑检索不调大模型 —— 数字对得上才说明两条链路没跑偏）
 *   2. 渲染：模拟点击「检索自检」，确认面板能渲染出指标卡、分题型表、未命中清单
 *
 * 运行：node tests/test_selfcheck.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- mock DOM（与 test_search.js / eval.js 一致） ---------- */
function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, children: [], _h: {},
    hidden: false,
    classList: {
      add(c){ set.add(c); }, remove(c){ set.delete(c); },
      toggle(c, v){ v ? set.add(c) : set.delete(c); }, contains(c){ return set.has(c); }, _set: set
    },
    addEventListener(t, fn){ this._h[t] = fn; },
    getAttribute(k){ return this.dataset[k]; },
    querySelector(){ return mockEl('exc'); },
    scrollIntoView(){}, focus(){}, closest(){ return null; }
  };
}
const els = {};
const documentMock = {
  getElementById(id){ return els[id] || (els[id] = mockEl(id)); },
  querySelector(sel){ return els[sel] || (els[sel] = mockEl(sel)); },
  addEventListener(){}, activeElement: null
};

/* ---------- 载入数据、评测集与页面脚本 ---------- */
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'))(win);
new Function('window', fs.readFileSync(path.join(ROOT, 'eval_cases.js'), 'utf8'))(win);
global.window = win;
global.document = documentMock;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
  global.window, documentMock, setTimeout, clearTimeout);

const KB = global.window.__KB__;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  (cond ? pass++ : fail++);
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + '  ' + name + (extra ? '   ' + extra : ''));
};

/* ================= 1. 与离线基线一致性 ================= */
console.log('\n=== 1. 页面自检 vs 离线基线（智能模式）===');
const got = KB.selfcheck('all');
const basePath = path.join(__dirname, 'eval_baseline.json');
if (!fs.existsSync(basePath)) {
  console.log('  跳过：未找到 eval_baseline.json');
} else {
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  ok('题数一致', got.metrics.n === base.metrics.all.n, got.metrics.n + ' 题');
  ['h1', 'h3', 'h5'].forEach(k =>
    ok('命中数 ' + k + ' 一致', got.metrics[k] === base.metrics.all[k],
      '页面 ' + got.metrics[k] + ' / 基线 ' + base.metrics.all[k]));
  ok('MRR 一致', Math.abs(got.metrics.mrr - base.metrics.all.mrr) < 1e-9,
    '页面 ' + got.metrics.mrr.toFixed(3) + ' / 基线 ' + base.metrics.all.mrr.toFixed(3));
  Object.keys(got.byType).forEach(t => {
    const a = got.byType[t], b = base.byType[t];
    if (!b) return;
    ok('分题型 ' + t + ' 一致',
      a.n === b.n && a.h1 === b.h1 && a.h3 === b.h3 && a.h5 === b.h5 && Math.abs(a.mrr - b.mrr) < 1e-9,
      'n=' + a.n + ' h1=' + a.h1 + ' h5=' + a.h5);
  });
}
console.log('\n  总体：Hit@1 ' + (got.metrics.h1 / got.metrics.n * 100).toFixed(1) +
  '%  Hit@3 ' + (got.metrics.h3 / got.metrics.n * 100).toFixed(1) +
  '%  Hit@5 ' + (got.metrics.h5 / got.metrics.n * 100).toFixed(1) +
  '%  MRR ' + got.metrics.mrr.toFixed(3));

/* ================= 2. 面板渲染 ================= */
console.log('\n=== 2. 面板渲染（模拟点击）===');
const chk = els['chk'], btn = els['chkBtn'];
chk.hidden = true;                 // 模拟 <section hidden>
btn._h.click();
ok('点击后面板展开', chk.hidden === false);
ok('按钮进入选中态', btn.classList.contains('on'));

setTimeout(() => {
  const h = chk.innerHTML;
  ok('指标卡 HIT@1', h.includes('HIT@1'));
  ok('指标卡 MRR', h.includes('MRR'));
  ok('分题型表头', h.includes('题型'));
  ok('总体行', h.includes('总体（智能）'));
  ok('未命中清单小节', h.includes('未命中前 5 名'));
  ok('数据脚注', h.includes('语料'));
  ok('收起按钮', h.includes('chkX'));
  ok('进度条已被结果替换', !h.includes('chkBar'));

  const m = h.match(/HIT@1[\s\S]{0,120}/);
  console.log('\n  渲染片段：' + (m ? m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '(未找到)'));

  console.log('\n' + (fail === 0 ? '✅ 全部通过（' + pass + ' 项）' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项'));
  process.exit(fail === 0 ? 0 : 1);
}, 800);
