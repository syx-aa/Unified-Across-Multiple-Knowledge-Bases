/**
 * test_llm_speed.js — SPEC-026 生成耗时优化与诊断自测
 *
 * 校验点：
 *   1. pickModel() 排除 auto / 推理型，优先轻量型；无其他候选时回退 auto（AC1）
 *   2. URL 参数 ?model=xxx 强制指定模型（AC2）
 *   3. 请求带 max_tokens 上限（AC3）
 *   4. trace 生成步显示首字延迟 / 总用时 / 输出字数 / token 数（AC4）
 *   5. 降级链不受影响：无模型 / 请求报错仍回退本地摘要
 *
 * 运行：node tests/test_llm_speed.js
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
      toggle(c, v) { v ? set.add(c) : set.delete(c); }, contains(c) { return set.has(c); }, _set: set
    },
    addEventListener(t, fn) { this._h[t] = fn; },
    getAttribute(k) { return this.dataset[k]; },
    querySelector() { return mockEl('exc'); },
    scrollIntoView() {}, focus() {}, closest() { return null; }
  };
}

/* ---------------- 模拟云服务 SDK ---------------- */
const chunk = (t, usage, model) => ({
  choices: [{ delta: { content: t } }],
  usage: usage || undefined,
  model: model || undefined
});
function mkStream(parts) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          return Promise.resolve(i < parts.length ? { value: parts[i++], done: false } : { value: undefined, done: true });
        }
      };
    }
  };
}

function makeCloud(opts) {
  opts = opts || {};
  const calls = { create: [] };
  const cloud = {
    llm: {
      models: { list() { return Promise.resolve(opts.models || []); } },
      chat: {
        completions: {
          create(req) {
            calls.create.push(req);
            if (opts.throwError) {
              const e = new Error('boom');
              e.error = { code: 'auth_origin_mismatch', message: 'boom' };
              throw e;
            }
            return mkStream(opts.parts || [chunk('央视'), chunk('拿下'), chunk('转播权。')]);
          }
        }
      }
    },
    _calls: calls
  };
  return cloud;
}

/* ---------------- 加载页面脚本（每个场景独立 world） ---------------- */
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const pageScript = inline[inline.length - 1];

function loadPage(cloud, search) {
  const win = {};
  new Function('window', dataJs)(win);
  win.WorkBuddyCloud = { createWorkBuddyCloud() { return cloud; } };
  const els = {};
  const appended = [];   // 记录 appendChild 进来的元素（用于验证 ?models=1 的清单渲染）
  const aiEl = mockEl('ai');
  aiEl.parentNode = { appendChild(el) { appended.push(el); } };
  els['ai'] = aiEl;
  const doc = {
    getElementById(id) { return els[id] || (els[id] = mockEl(id)); },
    querySelector(sel) { return els[sel] || (els[sel] = mockEl(sel)); },
    createElement(tag) { const e = mockEl(tag); e.parentNode = { appendChild(el) { appended.push(el); } }; return e; },
    addEventListener() {}, activeElement: null
  };
  global.window = new Proxy(win, { get(t, k) { return k in t ? t[k] : undefined; } });
  global.document = doc;
  global.location = { search: search || '' };
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'location', pageScript)(
    global.window, doc, setTimeout, clearTimeout, global.location);
  return { KB: global.window.__KB__, els, appended };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  console.log('[1] AC1 pickModel：排除 auto / 推理型，优先轻量型');
  {
    const cloud = makeCloud({ models: [] });
    const { KB } = loadPage(cloud, '');
    const pick = KB.pickModel;
    ok(typeof pick === 'function', '__KB__.pickModel 已暴露');

    const list = [
      { id: 'auto', name: 'Auto' },
      { id: 'deepseek-r1', name: 'DeepSeek-R1' },
      { id: 'qwen-flash', name: 'Qwen Flash' }
    ];
    ok(pick(list).id === 'qwen-flash', '从 [auto, r1, flash] 中选中 flash（实际=' + pick(list).id + '）');

    const onlyAuto = [{ id: 'auto', name: 'Auto' }];
    ok(pick(onlyAuto) !== null && pick(onlyAuto).id === 'auto', '只有 auto 时仍能回退，不会返回 null');

    ok(pick([]) === null, '空列表返回 null');
    ok(pick([{ id: 'x', disabled: true }]) === null, '全部 disabled 时返回 null');

    const thinkVsNormal = [{ id: 'o1-mini', name: 'O1 Mini' }, { id: 'glm-4', name: 'GLM-4' }];
    ok(pick(thinkVsNormal).id === 'glm-4', '推理型 o1-mini 被排到后面（实际=' + pick(thinkVsNormal).id + '）');
  }

  console.log('\n[2] AC2 URL 参数 ?model= 强制指定');
  {
    const models = [
      { id: 'auto', name: 'Auto' },
      { id: 'wb-flash', name: 'Flash 快模型' }
    ];
    const cloud = makeCloud({ models });
    const { KB } = loadPage(cloud, '?model=wb-flash');
    await sleep(30);
    const info = KB.modelInfo();
    ok(!!info && info.id === 'wb-flash', '按 URL 指定选中 wb-flash（实际=' + (info && info.id) + '）');
    ok(KB.cloudState() === 'ready', '模型状态为 ready');
  }
  {
    const cloud = makeCloud({ models: [{ id: 'auto', name: 'Auto' }, { id: 'wb-flash', name: 'Flash' }] });
    const { KB } = loadPage(cloud, '');
    await sleep(30);
    const info = KB.modelInfo();
    ok(!!info && info.id === 'wb-flash', '无 URL 参数时按优选规则自动选 flash（实际=' + (info && info.id) + '）');
  }
  {
    const cloud = makeCloud({ models: [{ id: 'auto', name: 'Auto' }, { id: 'wb-flash', name: 'Flash' }] });
    const { KB } = loadPage(cloud, '?model=not-exist');
    await sleep(30);
    ok(!!KB.modelInfo(), '指定了不存在的模型时回退优选逻辑，不会崩溃');
  }

  console.log('\n[3] AC3 请求带 max_tokens 上限');
  {
    const cloud = makeCloud({
      models: [{ id: 'wb-flash', name: 'Flash' }],
      parts: [chunk('阿根廷'), chunk('夺冠。'), chunk('', { completion_tokens: 42, total_tokens: 900 })]
    });
    const { KB, els } = loadPage(cloud, '');
    await sleep(30);
    els['q'].value = '阿根廷队夺冠了吗';   // ask() 读的是输入框的值
    KB.ask();                              // 触发一次真实生成流程
    await sleep(150);
    const req = cloud._calls.create[0];
    ok(!!req, '已发起 chat.completions.create');
    ok(typeof req.max_tokens === 'number' && req.max_tokens > 0,
      '请求带 max_tokens（=' + (req && req.max_tokens) + '）');
    ok(req.stream === true && req.temperature === 0.3, 'stream 与 temperature 保持不变');
  }

  console.log('\n[4] AC4 trace 显示首字 / 用时 / 字数 / tokens');
  {
    const cloud = makeCloud({
      models: [{ id: 'wb-flash', name: 'Flash' }],
      parts: [chunk('阿根廷'), chunk('队夺'), chunk('冠了。', { completion_tokens: 42, total_tokens: 900 })]
    });
    const { KB, els } = loadPage(cloud, '');
    await sleep(30);
    // 直接驱动一次真实的生成流程
    els['q'].value = '阿根廷队夺冠了吗';
    KB.ask();
    await sleep(150);
    const gd = els['trGenD'];
    const txt = gd ? String(gd.innerHTML || '') : '';
    ok(/首字/.test(txt), '显示首字延迟：' + txt.slice(0, 60) + '…');
    ok(/用时/.test(txt), '显示总用时');
    ok(/输出/.test(txt), '显示输出字数');
    ok(/tokens/.test(txt), '显示 token 用量（usage 已读取）');
  }

  console.log('\n[5] 降级链不受影响');
  {
    const cloud = makeCloud({ models: [] });
    const { KB } = loadPage(cloud, '');
    await sleep(30);
    ok(KB.cloudState() === 'empty', '无可用模型 → 明确降级（state=empty），不静默失败');
    ok(KB.modelInfo() === null, 'modelInfo 为 null');
  }

  console.log('\n[6] 模型列表查看开关 ?models=1（SPEC-028）');
  {
    const logs = [];
    const orig = console.log;
    console.log = function () { logs.push([].slice.call(arguments).join(' ')); };
    const cloud = makeCloud({
      models: [
        { id: 'auto', name: 'Auto' },
        { id: 'wb-flash', name: 'Flash 快模型' },
        { id: 'old-slow', name: 'Old', disabled: true }
      ]
    });
    const { KB, appended } = loadPage(cloud, '?models=1');
    await sleep(30);
    console.log = orig;
    ok(logs.some(l => /wb-flash/.test(l)), 'console.log 输出了模型清单');
    ok(appended.length === 1, '页面插入了 1 个清单块（实际=' + appended.length + '）');
    const txt = appended[0] ? String(appended[0].textContent || '') : '';
    ok(/auto/.test(txt) && /wb-flash/.test(txt), '清单含各模型 id');
    ok(/\[禁用\]/.test(txt), '标注了 disabled 的模型');
    ok(/可用模型 3 个/.test(txt), '列出总数（含禁用项）');
    ok(KB.modelList().length === 3, '__KB__.modelList 返回完整列表（含 disabled）');
  }
  {
    const orig = console.log; console.log = function () {};
    const cloud = makeCloud({ models: [{ id: 'auto', name: 'Auto' }] });
    const { appended } = loadPage(cloud, '');
    await sleep(30);
    console.log = orig;
    ok(appended.length === 0, '不带 ?models=1 时页面无额外显示（实际=' + appended.length + '）');
  }
  {
    const orig = console.log; console.log = function () {};
    const cloud = makeCloud({ models: [] });
    const { KB, appended } = loadPage(cloud, '?models=1');
    await sleep(30);
    console.log = orig;
    ok(KB.modelList().length === 0 && appended.length === 0, '空列表不报错、不渲染');
  }

  console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过'));
  process.exit(fail ? 1 : 0);
})();
