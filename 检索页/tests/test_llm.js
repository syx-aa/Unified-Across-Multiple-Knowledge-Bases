/**
 * test_llm.js — 大模型接入通道自测（Node 环境，模拟 DOM + 模拟云服务 SDK）
 *
 * 做法：先在全局塞一个假的 WorkBuddyCloud（复刻真实 SDK 的形状），
 *      再把 index.html 的内联脚本真跑一遍，验证：
 *        · 初始化用的是 publicConfig（endpoint + publishableKey）
 *        · 模型列表为空 / 请求报错 → 明确降级为本地摘要，不静默失败
 *        · 正常流式返回 → 逐字拼进答案区
 *        · 每次 chat.completions.create() 的 messages[0] 都是 system
 *        · 交给模型的资料里含命中的笔记
 *
 * 运行：node tests/test_llm.js
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
      toggle(c, v) { v ? set.add(c) : set.delete(c); }, contains(c) { return set.has(c); }
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

/* ---------------- 模拟云服务 SDK ---------------- */
function mkStream(parts) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          return Promise.resolve(i < parts.length
            ? { value: parts[i++], done: false }
            : { value: undefined, done: true });
        }
      };
    }
  };
}
const chunk = t => ({ choices: [{ delta: { content: t } }] });

const calls = { init: [], create: [] };
let scenario = 'ok';

const fakeCloud = {
  llm: {
    models: {
      list() {
        if (scenario === 'nomodel') return Promise.resolve([]);
        return Promise.resolve([{ id: 'wb-model-test', name: '测试模型' }]);
      }
    },
    chat: {
      completions: {
        create(req) {
          calls.create.push(req);
          if (scenario === 'sync_error') {
            const e = new Error('origin not allowed');
            e.error = { code: 'auth_origin_mismatch', message: 'origin not allowed' };
            throw e;
          }
          if (scenario === 'mid_error') {
            return {
              [Symbol.asyncIterator]() {
                let i = 0;
                return {
                  next() {
                    if (i++ === 0) return Promise.resolve({ value: chunk('半句'), done: false });
                    return Promise.reject(Object.assign(new Error('boom'), {
                      error: { code: 'gateway_stream_interrupted', message: 'boom' }
                    }));
                  }
                };
              }
            };
          }
          if (scenario === 'empty_text') return mkStream([]);
          return mkStream([chunk('央视'), chunk('以约'), chunk('7.5 亿元'), chunk('拿下转播权。')]);
        }
      }
    }
  }
};

/* ---------------- 加载 ---------------- */
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const win = {};
new Function('window', dataJs)(win);
win.WorkBuddyCloud = {
  createWorkBuddyCloud(cfg) { calls.init.push(cfg); return fakeCloud; }
};
global.window = new Proxy(win, { get(t, k) { return k in t ? t[k] : undefined; } });
global.document = documentMock;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 只取内联脚本：<script> 无属性，CDN / data.js 那两个带 src 不会被匹配 */
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(inline.length === 1, '页面只有一个内联脚本块（外链 script 未被误取）');

function runPage() {
  new Function('window', 'document', 'setTimeout', 'clearTimeout', inline[0])(
    global.window, documentMock, setTimeout, clearTimeout);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async function main() {

  console.log('\n[1] 初始化');
  runPage();
  let KB = global.window.__KB__;
  ok(!!KB, '页面脚本执行成功，调试出口可用');

  const cfg = calls.init[0];
  ok(!!cfg, '已用 publicConfig 初始化云服务客户端');
  ok(cfg.endpoint === KB.config.endpoint && /^https:\/\//.test(cfg.endpoint),
    'endpoint 来自 publicConfig（' + cfg.endpoint + '）');
  ok(!!cfg.publishableKey, 'publishableKey 已传入');
  ok(!!cfg.oauthRelayBaseUrl, 'oauthRelayBaseUrl 已传入（web 端必需）');

  await wait(30);
  ok(KB.cloudState() === 'ready', '模型列表拉取成功，状态 = ready');
  ok(/测试模型/.test(els['ai'].textContent), '页面显示当前模型名（' + els['ai'].textContent + '）');

  console.log('\n[2] 正常流式作答');
  els['q'].value = '央视拿下转播权花了多少钱？';
  KB.ask();
  await wait(30);
  const body = els['ansBody'] ? els['ansBody'].innerHTML : '';
  ok(/7\.5 亿元/.test(body), '流式内容已拼进答案区');
  ok(/央视/.test(body), '答案含首块内容');
  ok(/大模型生成/.test(els['genNote'].textContent), '生成完成后标注「大模型生成」（' + els['genNote'].textContent + '）');
  ok(/class="tag k-/.test(els['out'].innerHTML), '答案卡仍带参考来源');

  const req = calls.create[calls.create.length - 1];
  ok(Array.isArray(req.messages) && req.messages[0].role === 'system',
    'messages[0] 是 system 消息');
  ok(typeof req.messages[0].content === 'string' && req.messages[0].content.length > 20,
    'system 提示词非空');
  ok(req.stream === true, 'stream: true（接口仅支持流式）');
  ok(req.model === 'wb-model-test', '使用 models.list() 返回的模型 id');
  ok(/《.+?》/.test(req.messages[1].content), '交给模型的资料里有笔记标题');
  ok(/【问题】央视拿下转播权/.test(req.messages[1].content), '用户问题已拼进资料末尾');

  console.log('\n[3] 请求报错 → 明确降级，不静默失败');
  scenario = 'sync_error';
  calls.init.length = 0; calls.create.length = 0;
  Object.keys(els).forEach(k => delete els[k]);
  runPage();
  KB = global.window.__KB__;
  await wait(30);
  els['q'].value = '梅西是谁？';
  KB.ask();
  await wait(30);
  const h3 = els['out'].innerHTML;
  ok(/本地知识库摘要/.test(h3), '降级为本地摘要');
  ok(/未被授权/.test(h3), '把 auth_ 错误翻译成人话展示给用户');
  ok(!/正在检索资料并生成/.test(h3), '未停留在「生成中」骨架，已替换为本地摘要');
  ok(/class="card"/.test(h3) && !/undefined/.test(h3), '降级结果正常渲染');

  console.log('\n[4] 模型列表为空');
  scenario = 'nomodel';
  Object.keys(els).forEach(k => delete els[k]);
  runPage();
  KB = global.window.__KB__;
  await wait(30);
  ok(KB.cloudState() === 'empty', '空模型列表被显式处理，状态 = empty');
  els['q'].value = '德国';
  KB.ask();
  await wait(30);
  ok(/本地知识库摘要/.test(els['out'].innerHTML), '无可用模型时回退本地摘要');

  console.log('\n[5] 流中断：保留已生成内容');
  scenario = 'mid_error';
  Object.keys(els).forEach(k => delete els[k]);
  runPage();
  KB = global.window.__KB__;
  await wait(30);
  els['q'].value = '梅西';
  KB.ask();
  await wait(30);
  const body5 = els['ansBody'].innerHTML;
  ok(/半句/.test(body5), '中断前已生成的内容被保留');
  ok(/生成中断/.test(els['genNote'].textContent), '明确标注生成中断');
  ok(!/undefined/.test(els['out'].innerHTML), '输出不含 undefined');

  console.log('\n' + (fail === 0 ? '全部通过 ✅' : (fail + ' 项未通过 ❌')));
  process.exit(fail === 0 ? 0 : 1);
})();
