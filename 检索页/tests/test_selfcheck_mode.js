/**
 * test_selfcheck_mode.js — 自检面板脚注标注真实检索模式（SPEC-029）
 *
 * 验证：
 *   1. 面板脚注随 SERVER.ready 切换文案（服务端三路 / 本地两路），并带重排标记
 *   2. 两种情况下都明确提示「本面板只评测页面内置两路」
 *   3. 文案变化不影响任何检索指标
 *
 * 运行：node tests/test_selfcheck_mode.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, children: [], _h: {},
    hidden: false,
    classList: {
      add(c){ set.add(c); }, remove(c){ set.delete(c); },
      toggle(c, v){ v ? set.add(c) : set.delete(c); }, contains(c){ return set.has(c); }
    },
    addEventListener(t, fn){ this._h[t] = fn; },
    getAttribute(k){ return this.dataset[k]; },
    querySelector(){ return mockEl('exc'); },
    scrollIntoView(){}, focus(){}, closest(){ return null; }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* health 为 null 表示无服务端（模拟 file:// 打开 / 服务未启动） */
async function scenario(health) {
  if (health) {
    global.fetch = async () => ({ json: async () => health });
  } else {
    delete global.fetch;
  }
  const els = {};
  const documentMock = {
    getElementById(id){ return els[id] || (els[id] = mockEl(id)); },
    querySelector(sel){ return els[sel] || (els[sel] = mockEl(sel)); },
    addEventListener(){}, activeElement: null
  };
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'))(win);
  new Function('window', fs.readFileSync(path.join(ROOT, 'eval_cases.js'), 'utf8'))(win);
  global.window = win;
  global.document = documentMock;

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[inline.length - 1])(
    global.window, documentMock, setTimeout, clearTimeout);

  await sleep(60);                     // 等 probeServer 的 promise 落定
  const KB = global.window.__KB__;
  const metrics = KB.selfcheck('all').metrics;

  els['chk'].hidden = true;
  els['chkBtn']._h.click();            // 触发面板渲染
  await sleep(500);                    // 等分块渲染跑完
  return { foot: els['chk'].innerHTML, metrics, hint: els['hint'] ? els['hint'].textContent : '' };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => {
    (cond ? pass++ : fail++);
    console.log('  ' + (cond ? 'OK  ' : 'FAIL') + '  ' + name + (extra ? '   ' + extra : ''));
  };

  console.log('\n=== 1. 无服务端（本地两路）===');
  const a = await scenario(null);
  ok('标注本地两路', /本地两路/.test(a.foot));
  ok('不提服务端三路', !/服务端三路/.test(a.foot));
  ok('保留语料说明', /语料/.test(a.foot));
  ok('提示面板只评测两路', /只评测页面内置的两路检索/.test(a.foot));
  ok('给出服务端评测入口', /eval_backend\.js/.test(a.foot));

  console.log('\n=== 2. 服务端可用（含重排）===');
  const b = await scenario({
    ok: true, engine: 'server', docs: 130,
    models: { embedding: 'bge-small-zh-v1.5 (torch)', reranker: 'bge-reranker-base' },
    vectorDb: { type: 'chroma(persisted) + in-memory index', vectors: 1079 }
  });
  ok('标注服务端三路', /服务端三路/.test(b.foot));
  ok('带重排标记', /\+ 重排/.test(b.foot));
  ok('提示面板只评测两路', /只评测页面内置的两路检索/.test(b.foot));
  ok('提示用 eval_backend 测真实水平', /eval_backend\.js/.test(b.foot));
  ok('页头显示服务端链路', /服务端检索/.test(b.hint), b.hint);

  console.log('\n=== 3. 服务端可用（轻量，无重排）===');
  const c = await scenario({
    ok: true, engine: 'server', docs: 130,
    models: { embedding: 'bge-small-zh-v1.5 (onnx)', reranker: null }
  });
  ok('标注服务端三路', /服务端三路/.test(c.foot));
  ok('不加重排标记', !/\+ 重排/.test(c.foot));

  console.log('\n=== 4. 指标不受文案改动影响（回归）===');
  const same = k => a.metrics[k] === b.metrics[k] && b.metrics[k] === c.metrics[k];
  ok('n 一致', same('n'), String(a.metrics.n));
  ok('h1 一致', same('h1'), String(a.metrics.h1));
  ok('h5 一致', same('h5'), String(a.metrics.h5));
  ok('MRR 一致', Math.abs(a.metrics.mrr - c.metrics.mrr) < 1e-9, a.metrics.mrr.toFixed(3));

  console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
