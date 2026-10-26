/**
 * test_progress_feedback.js — 检索等待期的进度反馈（SPEC-031）
 *
 * 验证：提问后立刻有反馈（不会干等服务端检索），检索完成后平滑换成完整界面，
 *       流式期间答案逐步出现。
 *
 * 运行：node tests/test_progress_feedback.js
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
            return new Promise(r => setTimeout(() => r({
              value: Buffer.from(v, 'utf-8'), done: false
            }), delay));
          }
        };
      }
    }
  };
}

/* 流：逐字带延迟，便于观察"中途是否已显示部分内容" */
function makeCloud(text, delayMs) {
  const parts = text.split('').map(ch => ({ choices: [{ delta: { content: ch } }] }));
  return {
    llm: {
      models: { list(){ return Promise.resolve([{ id: 'm1', name: 'M1' }]); } },
      chat: {
        completions: {
          create() {
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
      }
    }
  };
}

const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...htmlSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');

/* mode='stream' 时 mock 一个逐步推送的服务端；'broken' 时流接口 404，用于验证降级 */
function loadPage(cloud, mode) {
  if (mode) {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/health') >= 0) {
        return { ok: true, json: async () => ({ ok: true, engine: 'server', docs: 130,
          models: { embedding: 'bge-small-zh-v1.5 (torch)', reranker: 'bge-reranker-base' },
          vectorDb: { type: 'memory', vectors: 1079 } }) };
      }
      if (u.indexOf('/api/search/stream') >= 0) {
        return ndjsonResponse([
          { type: 'step', step: { t: '分词', d: '→ 8 个词元' } },
          { type: 'step', step: { t: '关键词路', d: '命中 12 篇' } },
          { type: 'step', step: { t: '实体路', d: '命中词条「梅西」' } },
          { type: 'step', step: { t: '向量路', d: '覆盖 30 篇' } },
          { type: 'step', step: { t: '重排', d: '对 20 篇打分' } },
          { type: 'done', engine: 'server', q: 'x', ms: 118,
            rows: [{ di: 5, score: 0.92, k: 0.9, e: 0.2, v: 0.8, rr: 0.9, rank: 1 },
                   { di: 8, score: 0.71, k: 0.7, e: 0.1, v: 0.6, rr: 0.7, rank: 2 }],
            terms: ['梅西'], exact: [] }
        ], 150);
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
  } else {
    delete global.fetch;
  }
  const win = {};
  new Function('window', dataJs)(win);
  win.WorkBuddyCloud = { createWorkBuddyCloud(){ return cloud; } };
  const els = {};
  const doc = {
    getElementById(id){ return els[id] || (els[id] = mockEl(id)); },
    querySelector(sel){ return els[sel] || (els[sel] = mockEl(sel)); },
    addEventListener(){}, activeElement: null
  };
  global.window = win;
  global.document = doc;
  global.location = { search: '' };
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'location', inline[inline.length - 1])(
    global.window, doc, setTimeout, clearTimeout, global.location);
  return { KB: global.window.__KB__, els };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  (cond ? pass++ : fail++);
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + '  ' + name + (extra ? '   ' + extra : ''));
};

(async () => {
  const Q = '梅西是谁';
  const FULL = '梅西是阿根廷球员';

  console.log('\n[1] 提问后立即有反馈（不等服务端检索）');
  {
    const cloud = makeCloud(FULL, 40);
    const { KB, els } = loadPage(cloud, 'stream');
    await sleep(80);                       // 等 probeServer 探活完成
    els['q'].value = Q;
    KB.ask();
    await sleep(30);                       // 远早于服务端 300ms 的返回
    const h = els['out'].innerHTML;
    ok('检索等待期已显示检索中', /检索中/.test(h), h.slice(0, 40));
    ok('提示中带当前问题', /梅西是谁/.test(h));
    ok('说明走的是服务端链路', /BM25 \+ 实体 \+ 向量/.test(h));
  }

  console.log('\n[2] 检索完成后换成完整界面');
  {
    const cloud = makeCloud(FULL, 40);
    const { KB, els } = loadPage(cloud, 'stream');
    await sleep(80);
    els['q'].value = Q;
    KB.ask();
    await sleep(1200);                     // 等 5 步推送（150ms×5）+ done
    const h = els['out'].innerHTML;
    ok('出现完整 trace', /检索过程/.test(h));
    ok('检索中提示已消失', !/正在检索「/.test(h));
    ok('答案区已建立', !!els['ansBody']);
  }

  console.log('\n[3] 流式期间逐步显示（中途能读到部分内容）');
  {
    const cloud = makeCloud(FULL, 200);    // 生成 8 字 × 200ms ≈ 1.6s
    const { KB, els } = loadPage(cloud, 'stream');
    await sleep(80);
    els['q'].value = Q;
    KB.ask();
    await sleep(1250);                     // 检索完（~900ms）+ 流已吐 1-2 字
    const mid = els['ansBody'] ? String(els['ansBody'].innerHTML || '') : '';
    ok('流式中途答案区已有内容', mid.length > 0, mid.slice(0, 30));
    ok('中途尚未写完', !/阿根廷球员$/.test(mid.replace(/<[^>]+>/g, '')));
    await sleep(1800);                     // 等流走完
    const fin = els['ansBody'] ? String(els['ansBody'].innerHTML || '') : '';
    ok('最终写出完整答案', /梅西是阿根廷球员/.test(fin.replace(/<[^>]+>/g, '')));
  }

  console.log('\n[4] 本地两路（无服务端）不闪检索中');
  {
    const cloud = makeCloud(FULL, 20);
    const { KB, els } = loadPage(cloud, 'broken');
    await sleep(80);
    els['q'].value = Q;
    KB.ask();
    await sleep(1200);                     // 等降级渲染落地
    const h = els['out'].innerHTML;
    ok('未出现检索中骨架', !/检索中/.test(h));
    ok('直接进入生成态', /检索过程/.test(h) || /回答/.test(h));
  }

  console.log('\n[5] 与 SPEC-030 兼容：过期请求不覆盖新界面');
  {
    const cloud = makeCloud(FULL, 30);
    const { KB, els } = loadPage(cloud, 'stream');
    await sleep(80);
    els['q'].value = Q;
    KB.ask();
    await sleep(80);                       // 第一次仍在检索中
    els['q'].value = '阿根廷队名单';
    KB.ask();                              // 抢占
    await sleep(50);
    const h1 = els['out'].innerHTML;
    ok('第二次提问立刻刷新检索中', /检索中/.test(h1));
    ok('提示换成新问题', /阿根廷队名单/.test(h1));
    await sleep(900);
    const h2 = els['out'].innerHTML;
    ok('最终界面不含旧问题的检索提示', !/正在检索「梅西是谁」/.test(h2));
  }

  console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
