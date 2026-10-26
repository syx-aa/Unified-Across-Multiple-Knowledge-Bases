/**
 * test_concurrent.js — 重复提问 / 快速切换模式的竞态修复自测（SPEC-030）
 *
 * 覆盖：
 *   1. 每次 ask() 有唯一序号，过期请求不写 DOM
 *   2. 连点模式切换 N 次 → 只呈现最后一次结果
 *   3. 旧流继续吐字也不再写入界面
 *   4. 过期被中止的流不触发 renderAnswer 兜底（界面不出现错误文案）
 *   5. 结束后 busy 已释放，后续提问仍正常
 *
 * 运行：node tests/test_concurrent.js
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

/* 每次 create 返回不同的答案，且逐字带延迟 —— 便于观察"上一次还没吐完"时的抢占 */
function makeSeqCloud(texts, delayMs) {
  let n = 0;
  const cloud = {
    llm: {
      models: { list(){ return Promise.resolve([{ id: 'm1', name: 'M1' }]); } },
      chat: {
        completions: {
          create() {
            const idx = n++;
            const text = texts[idx] || '额外答案ZZZ';
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
      }
    },
    _calls: () => n
  };
  return cloud;
}

const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...htmlSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const dataJs = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');

function loadPage(cloud) {
  const win = {};
  new Function('window', dataJs)(win);
  win.WorkBuddyCloud = { createWorkBuddyCloud(){ return cloud; } };
  const els = {};
  const doc = {
    getElementById(id){ return els[id] || (els[id] = mockEl(id)); },
    querySelector(sel){ return els[sel] || (els[sel] = mockEl(sel)); },
    addEventListener(){}, activeElement: null
  };
  delete global.fetch;                       // 不接服务端 → 走本地两路检索（同步，便于测 async 抢占）
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

/* mock DOM 里各元素是独立的：答案落在 ansBody，trace 落在 trGenD，
   都不嵌套在 out 里 —— 必须把这些元素的内容一起取出来才有意义 */
const SNAP_IDS = ['out', 'ansBody', 'trGenD', 'genNote'];
const snap = els => SNAP_IDS.map(id => {
  const e = els[id];
  return e ? String(e.innerHTML || '') + '\n' + String(e.textContent || '') : '';
}).join('\n');

(async () => {
  const Q = '阿根廷队的26人大名单都有谁';

  console.log('\n[1] 连点三次（模拟快速切换 智能/关键词/实体）→ 只保留最后一次');
  {
    const cloud = makeSeqCloud(['第一次答案AAA', '第二次答案BBB', '第三次答案CCC'], 20);
    const { KB, els } = loadPage(cloud);
    await sleep(30);
    els['q'].value = Q;
    KB.ask(); await sleep(45);      // 第 1 次还在吐字
    KB.ask(); await sleep(45);      // 第 2 次
    KB.ask();                       // 第 3 次
    await sleep(1500);              // 等所有流收敛
    const h = snap(els);
    ok('共发起 3 次生成', cloud._calls() === 3, String(cloud._calls()));
    ok('渲染最后一次答案', /第三次答案CCC/.test(h));
    ok('不含第 1 次内容', !/第一次答案AAA/.test(h));
    ok('不含第 2 次内容', !/第二次答案BBB/.test(h));
    ok('未出现错误兜底文案', !/生成中断|没有返回内容/.test(h));
    ok('答案区已完成渲染', /大模型流式作答完成/.test(h));
  }

  console.log('\n[2] 旧流继续吐字时被抢占 → 不再写入界面');
  {
    // 旧流很慢（100ms/字），新请求很快（10ms/字）
    const cloud = makeSeqCloud(['陈旧答案OLDOLD', '最新答案NEW'], 100);
    const { KB, els } = loadPage(cloud);
    await sleep(30);
    els['q'].value = Q;
    KB.ask();                       // 慢请求
    await sleep(120);               // 让它吐 1 个字
    els['q'].value = Q;
    KB.ask();                       // 抢占
    await sleep(900);               // 此时旧流本应继续吐完
    const h = snap(els);
    ok('呈现最新答案', /最新答案NEW/.test(h));
    ok('陈旧内容未写回界面', !/陈旧答案OLDOLD/.test(h));
  }

  console.log('\n[3] busy 已释放 → 后续提问仍正常');
  {
    const cloud = makeSeqCloud(['首轮答案111', '次轮答案222'], 20);
    const { KB, els } = loadPage(cloud);
    await sleep(30);
    els['q'].value = Q;
    KB.ask();
    await sleep(600);
    els['q'].value = Q;
    KB.ask();
    await sleep(800);
    const h = snap(els);
    ok('第二轮答案已渲染', /次轮答案222/.test(h));
    ok('无残留 busy 阻塞', /大模型流式作答完成/.test(h));
  }

  console.log('\n[4] REQ 序号单调递增');
  {
    const cloud = makeSeqCloud(['甲', '乙', '丙'], 10);
    const { KB, els } = loadPage(cloud);
    await sleep(30);
    els['q'].value = Q;
    KB.ask(); await sleep(30);
    KB.ask(); await sleep(30);
    KB.ask();
    await sleep(600);
    const s = snap(els);
    ok('三次提问均被受理', cloud._calls() === 3, String(cloud._calls()));
    ok('最终只剩最后一次答案（丙）', /丙/.test(s) && !/甲/.test(s) && !/乙/.test(s));
  }

  console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
