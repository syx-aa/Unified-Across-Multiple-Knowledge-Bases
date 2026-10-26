/**
 * test_search.js — 问答页自测（Node 环境，模拟 DOM）
 *
 * 做法：把 index.html 的内联脚本在 mock 的 DOM 里真跑一遍，
 *      再通过页面暴露的 window.__KB__ 调用真实函数，检查检索与答案生成。
 *
 * 运行：node tests/test_search.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
function ok(cond, msg) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg);
  if (!cond) fail++;
}

/* ---------------- mock DOM ---------------- */
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

/* ---------------- 加载数据 ---------------- */
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const win = {};
new Function('window', dataJs)(win);
global.window = new Proxy(win, { get(t, k) { return k in t ? t[k] : undefined; } });
global.document = documentMock;

/* ---------------- 执行页面脚本 ---------------- */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('页面内联脚本块：', inline.length);

console.log('\n[1] 脚本执行');
try {
  new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
    global.window, documentMock, setTimeout, clearTimeout);
  ok(true, '页面脚本在模拟 DOM 中执行无异常');
} catch (e) {
  ok(false, '脚本执行抛错: ' + e.message);
  process.exit(1);
}

const KB = global.window.__KB__;
ok(!!KB, '调试出口 window.__KB__ 可用');
ok(/trybtn/.test(els['out'].innerHTML), '首屏渲染了示例问题');
ok(/篇笔记/.test(els['stat'].textContent), '顶栏统计已填充（' + els['stat'].textContent + '）');

/* ---------------- 辅助 ---------------- */
function answer(q, mode) {
  KB.state.mode = mode || 'all';
  KB.state.q = q;
  const a = KB.answer(q, KB.state.mode);
  KB.state.lastTerms = a.terms || [];
  return a;
}
function ask(q, mode) {
  if (mode) KB.state.mode = mode;
  els['q'].value = q;
  KB.ask();
  return els['out'].innerHTML;
}
function topTitles(q, mode, n) {
  const r = KB.retrieve(q, mode || 'all').rows;
  return r.slice(0, n || 5).map(x => KB.docs[x.di].title + '(' + KB.docs[x.di].kind + ')');
}

console.log('\n[2] 检索通路');
let r = topTitles('梅西');
console.log('   查「梅西」→', r.join(' | '));
ok(r[0] === '梅西(entity)', 'Top1 为实体「梅西」');

r = topTitles('cr7');
console.log('   查别名「cr7」→', r.join(' | '));
ok(r[0] === 'C罗(entity)', '英文别名 cr7 → C罗');

r = topTitles('netherlands');
console.log('   查别名「netherlands」→', r.join(' | '));
ok(r[0] === '荷兰(entity)', '英文别名 netherlands → 荷兰');

r = topTitles('7.5亿');
console.log('   查「7.5亿」→', r.join(' | '));
ok(/转播权/.test(r[0] || ''), '数字专名命中「央视转播权」笔记');

r = topTitles('德国');
ok(r[0] === '德国(entity)' && r.some(x => x.indexOf('(note)') > 0), '词条「德国」排第一，且带出关联笔记');

console.log('\n[3] 答案生成');
let a = answer('梅西');
console.log('   问「梅西」→', a.lead.slice(0, 60));
ok(!a.empty && a.lead.indexOf('梅西') >= 0, '答出「梅西」词条简介');
ok(a.sources.length > 0, '给出了参考来源（' + a.sources.length + ' 条）');

a = answer('阿根廷 26人大名单都有谁？');
console.log('   问名单 →', a.lead.slice(0, 60));
ok(!a.empty, '返回了答案');
ok(a.points.length > 0, '抽出了要点（' + a.points.length + ' 条）');
ok(a.sources.some(s => s.title.indexOf('阿根廷') >= 0), '来源包含阿根廷相关笔记');
console.log('   要点示例:', a.points.slice(0, 2).map(p => p.t.slice(0, 42)).join(' / '));

a = answer('央视拿下转播权花了多少钱？');
console.log('   问转播权 →', a.lead.slice(0, 60));
ok(!a.empty && a.sources.some(s => /转播权/.test(s.title)), '命中「央视转播权」笔记');
ok(a.points.length > 0, '要点非空');

a = answer('2026 世界杯夺冠热门有哪些？');
ok(!a.empty && a.points.length > 0, '「夺冠热门」能答出要点');

console.log('\n[4] 三种模式');
let hk = ask('球衣号码', 'keyword');
let he = ask('球衣号码', 'entity');
let ha = ask('球衣号码', 'all');
ok(hk.length > 0 && he.length > 0 && ha.length > 0, '关键词 / 实体 / 智能 三种模式均可产出答案');
ok(/球衣|号码/.test(ha), '智能模式下答案里出现「球衣/号码」');

console.log('\n[5] 渲染与安全');
const h = ask('阿根廷');
ok(/<mark>/.test(h), '答案里生成高亮 <mark>');
ok(/class="tag k-/.test(h), '来源带类型标签');
ok(/class="src"/.test(h), '参考来源可点击展开');
ok(/class="sim s-(hi|mid|lo)"/.test(h), '来源带相似度条');
ok(/class="sim-n">\d+%</.test(h), '来源显示相似度百分比');
const pcts = (h.match(/class="sim-n">(\d+)%/g) || []).map(s => +s.match(/(\d+)%/)[1]);
ok(pcts.length > 0 && pcts.every(p => p >= 1 && p <= 100), '相似度均在 1~100% 之间');
ok(pcts.every((p, i) => i === 0 || pcts[i-1] >= p), '来源按相似度从高到低排列');

/* --- 检索过程面板 --- */
ok(/id="traceBox"/.test(h) && /检索过程/.test(h), '渲染了「检索过程」面板');
const tsteps = (h.match(/class="tstep[^"]*"/g) || []).length;
ok(tsteps >= 6, '检索过程含 ≥6 步（实际 ' + tsteps + '）');
ok(/分词/.test(h) && /关键词路/.test(h) && /实体路/.test(h) && /归一化融合/.test(h) && /相关度闸门/.test(h) && /取料/.test(h),
   '六个检索步骤齐全（分词/关键词路/实体路/归一化融合/闸门/取料）');
ok(/id="trGen"/.test(h) && /本地摘要/.test(h), '生成步骤渲染（本地摘要路径）');
const nums = (h.match(/class="no">(\d+)</g) || []).map(s => +s.match(/>(\d+)</)[1]);
ok(nums.join(',') === '1,2,3,4,5,6,7', '步骤编号连续递增：' + nums.join(','));

ok(!/<script/i.test(h), '渲染输出未注入脚本');
ok(!/undefined/.test(h), '渲染输出不含 undefined');
console.log('   高亮示例:', (h.match(/<mark>[^<]*<\/mark>/g) || []).slice(0, 4).join(' '));

const hq = ask('"><img src=x onerror=alert(1)>');
ok(!/<img/i.test(hq) && !/<[a-z]+[^>]*onerror/i.test(hq), 'query 中的 HTML 标签被转义（无 XSS）');

console.log('\n[6] 边界情况');
ask('   ');
ok(/trybtn/.test(els['out'].innerHTML), '空查询回到首屏引导');
ask('qqqqzzzz');
ok(/没有找到/.test(els['out'].innerHTML), '不存在的英文串 → 空状态提示');
ok(/class="tstep bad"/.test(els['out'].innerHTML), '无结果时闸门步骤标为失败');
a = answer('qqqqzzzz');
ok(a.empty, '纯乱码英文串判为无内容');
a = answer('zzzzzz不存在的词');
ok(a.empty || a.sources.every(s => s.title.indexOf('zzzzzz') < 0), '中英混合乱码：不会误命中标题');
a = answer('🇦🇷🎉');
ok(a.empty || a.points.length >= 0, '纯符号查询不崩溃');

console.log('\n' + (fail === 0 ? '全部通过 ✅' : (fail + ' 项未通过 ❌')));
process.exit(fail === 0 ? 0 : 1);
