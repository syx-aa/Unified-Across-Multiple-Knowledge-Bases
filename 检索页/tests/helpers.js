/**
 * helpers.js — 测试公共脚手架
 *
 * 页面本体是一个自执行的大 IIFE（index.html 内联 <script>），
 * 这里用最小 mock DOM + 可控 fetch 把它跑起来，供各测试脚本复用。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* 极简 DOM 元素：只实现页面用到的方法 */
function mockEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    children: [], _h: {}, hidden: false, selectionStart: 0, selectionEnd: 0,
    classList: {
      add(c){ set.add(c); }, remove(c){ set.delete(c); },
      toggle(c, v){ v ? set.add(c) : set.delete(c); }, contains(c){ return set.has(c); }
    },
    addEventListener(t, fn){ this._h[t] = fn; },
    getAttribute(k){ return this.dataset[k] !== undefined ? this.dataset[k] : null; },
    setAttribute(k, v){ this.dataset[k] = v; },
    querySelector(){ return mockEl('sub'); },
    closest(){ return null; },
    scrollIntoView(){}, focus(){}, blur(){}, click(){},
    remove(){}, appendChild(){}, insertBefore(){},
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* mock 一个 NDJSON 流式响应：events 逐条推送，每条间隔 delay 毫秒 */
function ndjsonResponse(events, delay) {
  const chunks = events.map(e => JSON.stringify(e) + '\n');
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ value: undefined, done: true });
            const v = chunks[i++];
            return new Promise(r => setTimeout(
              () => r({ value: Buffer.from(v, 'utf-8'), done: false }), delay));
          }
        };
      }
    }
  };
}

/* 构造一个可控的云服务 mock：每次 create 返回下一段文本，逐字带延迟 */
function makeCloud(texts, delayMs) {
  let n = 0;
  return {
    llm: { models: { list(){ return Promise.resolve([{ id: 'm1', name: 'M1' }]); } } },
    chat: {
      completions: {
        create() {
          const text = texts[n++] || '额外答案ZZZ';
          const parts = text.split('').map(ch => ({ choices: [{ delta: { content: ch } }] }));
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                next() {
                  if (i >= parts.length) return Promise.resolve({ value: undefined, done: true });
                  const v = parts[i++];
                  return new Promise(r => setTimeout(() => r({ value: v, done: false }), delayMs));
                }
              };
            }
          };
        }
      }
    },
    _calls: () => n
  };
}

/**
 * 加载页面。
 * @param {object} [opts]
 * @param {Function} [opts.fetch]    自定义 fetch（mock 服务端时用）
 * @param {object}   [opts.cloud]    云服务 mock；不传则用默认
 * @param {string}   [opts.dataFile] 数据文件（相对项目根），默认 data.js
 * @param {string}   [opts.search]   URL 查询串，如 '?db=enterprise'
 */
function loadPage(opts) {
  opts = opts || {};
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, opts.dataFile || 'data.js'), 'utf8'))(win);

  const cloud = opts.cloud || makeCloud(['默认答案AAA'], 0);
  win.WorkBuddyCloud = { createWorkBuddyCloud(){ return cloud; } };

  const els = {};
  const doc = {
    getElementById(id){ return els[id] || (els[id] = mockEl(id)); },
    querySelector(sel){ return els[sel] || (els[sel] = mockEl(sel)); },
    createElement(t){ return mockEl(t); },
    addEventListener(){},
    activeElement: null,
    head: { appendChild(){} },
    body: { appendChild(){} },
  };

  global.fetch = opts.fetch || (async () => {
    throw new Error('no network');
  });

  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inline = [...htmlSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  global.window = win;
  global.document = doc;
  global.location = { search: opts.search || '', href: '', origin: '', protocol: 'http:', host: '' };
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'location',
    inline[inline.length - 1])(
    global.window, doc, setTimeout, clearTimeout, global.location);

  return { KB: global.window.__KB__, els, win };
}

module.exports = { ROOT, mockEl, sleep, ndjsonResponse, makeCloud, loadPage };
