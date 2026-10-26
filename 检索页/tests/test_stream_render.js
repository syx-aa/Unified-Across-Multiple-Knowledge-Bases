/**
 * test_stream_render.js — SPEC-025 流式渲染节流自测
 *
 * 校验点：
 *   1. 同一帧内多次 push 只触发一次 DOM 写入（改造前是 N 次）
 *   2. 最终文本与逐字渲染完全一致（不丢字、不重复、不乱序）
 *   3. 流结束时移除光标 caret，中断路径保留已生成内容
 *   4. 无 requestAnimationFrame 时降级为 setTimeout（本测试正是该场景）
 *
 * 运行：node tests/test_stream_render.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
function ok(cond, msg) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg);
  if (!cond) fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- mock DOM（与 test_search.js 同思路） ---------------- */
function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, children: [], _h: {},
    classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); },
      toggle(c, v) { v ? set.add(c) : set.delete(c); }, contains(c) { return set.has(c); }, _set: set
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
  addEventListener() {}, activeElement: null
};

/* 带写入计数的元素：每赋值一次 innerHTML 记一次 */
function countingEl() {
  let v = '', n = 0;
  const o = { id: 'counted' };
  Object.defineProperty(o, 'innerHTML', {
    get() { return v; },
    set(x) { v = x; n++; }
  });
  o.__writes = () => n;
  return o;
}

/* ---------------- 加载页面脚本 ---------------- */
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const win = {};
new Function('window', dataJs)(win);
global.window = new Proxy(win, { get(t, k) { return k in t ? t[k] : undefined; } });
global.document = documentMock;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

(async function main() {
  console.log('[1] 页面脚本加载');
  try {
    new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
      global.window, documentMock, setTimeout, clearTimeout);
    ok(true, '页面脚本在模拟 DOM 中执行无异常');
  } catch (e) {
    ok(false, '页面脚本执行异常：' + e.message);
    process.exit(1);
  }
  const KB = global.window.__KB__;
  ok(!!KB && typeof KB.streamRenderer === 'function', '__KB__.streamRenderer 已暴露');

  console.log('\n[2] AC1 同一帧内多次 push 只写一次 DOM');
  const el = countingEl();
  const rr = KB.streamRenderer(el);
  const tokens = ['阿', '根', '廷', '队', '夺', '冠', '了', '。'];
  for (const t of tokens) rr.push(t);
  ok(el.__writes() === 0, '同步阶段尚未写入 DOM（写入次数=' + el.__writes() + '）');
  await sleep(40);
  ok(el.__writes() === 1, '一帧后只写入 1 次（改造前应为 ' + tokens.length + ' 次，实际=' + el.__writes() + '）');

  console.log('\n[3] AC2 内容完整且与顺序一致');
  const txt = '阿根廷队夺冠了。';
  ok(el.innerHTML.indexOf(txt) >= 0, '渲染内容包含完整拼接结果');
  ok(el.innerHTML.indexOf('廷队') >= 0 && el.innerHTML.indexOf('队夺') >= 0, '拼接顺序正确（无乱序/丢字）');
  ok(rr.raw() === txt, 'raw() 返回完整缓冲：' + rr.raw());

  console.log('\n[4] AC3 流过程中显示光标，结束时移除');
  ok(el.innerHTML.indexOf('caret') >= 0, '流式过程中带光标 <span class="caret">');
  const finished = rr.finish();
  ok(el.innerHTML.indexOf('caret') < 0, 'finish() 后光标已移除');
  ok(finished === txt, 'finish() 返回完整文本');
  ok(el.innerHTML.indexOf(txt) >= 0, 'finish() 后 DOM 内容完整');

  console.log('\n[5] AC4 中断场景：已生成内容保留在 raw() 中');
  const el2 = countingEl();
  const rr2 = KB.streamRenderer(el2);
  rr2.push('已生成');
  rr2.push('的一半');
  ok(rr2.raw() === '已生成的一半', '中断时可从 raw() 取回已生成内容（页面据此渲染中断提示）');
  await sleep(40);
  ok(el2.innerHTML.indexOf('已生成的一半') >= 0, '中断前的 DOM 内容已渲染');

  console.log('\n[6] AC5 无 requestAnimationFrame 时降级为 setTimeout');
  ok(typeof global.window.requestAnimationFrame === 'undefined', '当前 mock 环境确实没有 rAF（走降级分支）');
  ok(el.innerHTML.length > 0, '降级分支仍能正常渲染');

  console.log('\n[7] HTML 转义仍然生效（不引入 XSS）');
  const el3 = countingEl();
  const rr3 = KB.streamRenderer(el3);
  rr3.push('<img src=x onerror=alert(1)>');
  await sleep(40);
  ok(el3.innerHTML.indexOf('<img') < 0, '原始标签被转义，未写入裸 <img>');
  ok(el3.innerHTML.indexOf('&lt;img') >= 0, '转义为 &lt;img');

  console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过'));
  process.exit(fail ? 1 : 0);
})();
