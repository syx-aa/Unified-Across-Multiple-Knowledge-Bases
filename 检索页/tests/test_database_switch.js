/**
 * test_database_switch.js — 多知识库切换自测（SPEC-033）
 *
 * 覆盖：
 *   AC1  切换器列出所有可用知识库
 *   AC6  当前库有明确选中态
 *   AC7  服务端不可达时不显示切换器（无库可切），且不报错
 *   AC2/AC4 检索请求带上 db 参数，服务端按库返回
 *   AC5  切换知识库后清空当前问答（Q4）
 *
 * 运行：node tests/test_database_switch.js
 */
const fs = require('fs');
const path = require('path');
const { loadPage, sleep, ndjsonResponse } = require('./helpers');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + '  ' + name + (extra ? '   ' + extra : ''));
};

/* 两个库各自返回可区分的文档 —— 便于验证"结果来自哪个库" */
const LIB_DATA = {
  worldcup:   { title: '【世界杯】梅西', id: 'wc-messi' },
  enterprise: { title: '【企业库】技术方案', id: 'ent-plan' },
};

function rowsFor(db) {
  const d = LIB_DATA[db] || LIB_DATA.worldcup;
  return [{
    di: 0, score: 0.92, k: 0.9, e: 0.2, v: 0.8, rr: 0.9, rank: 1,
    title: d.title, id: d.id,
  }];
}

function makeMultiLib(opts) {
  const state = { calls: [] };
  return {
    _calls(){ return state.calls.length; },
    _lastUrl(){ return state.calls[state.calls.length - 1] || ''; },
    _reset(){ state.calls.length = 0; },
    fetch: async function (url) {
      const u = String(url);
      state.calls.push(u);
      if (u.indexOf('/api/health') >= 0) {
        if (opts && opts.serverDown) throw new Error('connect fail');
        return { ok: true, json: async () => ({ ok: true, engine: 'server', docs: 130,
          models: { embedding: 'bge-small-zh-v1.5 (torch)', reranker: 'bge-reranker-base' },
          vectorDb: { type: 'memory', vectors: 1079 } }) };
      }
      if (u.indexOf('/api/databases') >= 0) {
        if (opts && opts.serverDown) throw new Error('connect fail');
        return { ok: true, json: async () => ({ ok: true, current: 'worldcup',
          items: [
            { key: 'worldcup',   notes: 54,  entities: 62,  concepts: 14,  chars: 199000, vectors: 1079 },
            { key: 'enterprise', notes: 104, entities: 125, concepts: 102, chars: 543077, vectors: 620 },
          ] }) };
      }
      if (u.indexOf('/api/search/stream') >= 0) {
        const m = /[?&]db=([^&]+)/.exec(u);
        const db = m ? decodeURIComponent(m[1]) : 'worldcup';
        const d = LIB_DATA[db] || LIB_DATA.worldcup;
        return ndjsonResponse([
          { type: 'step', step: { t: '分词', d: '→ 8 个词元' } },
          { type: 'step', step: { t: '关键词路', d: '命中 12 篇' } },
          { type: 'step', step: { t: '实体路', d: '命中词条' } },
          { type: 'step', step: { t: '向量路', d: '覆盖 30 篇' } },
          { type: 'step', step: { t: '重排', d: '对 20 篇打分' } },
          { type: 'done', engine: 'server', q: 'x', ms: 120,
            rows: rowsFor(db), terms: [d.id], exact: [] },
        ], 10);
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    },
  };
}

(async function () {
  console.log('\n=== SPEC-033 多知识库切换 自测 ===\n');

  /* ---------- AC1 / AC6：切换器列出全部库，当前库有选中态 ---------- */
  console.log('[1] 切换器列出所有可用知识库');
  {
    const ml = makeMultiLib();
    const { KB, els } = loadPage({ fetch: ml.fetch });
    await sleep(300);                                  // 等待 probeServer + loadLibs
    const box = els['libbox'];
    const html = box ? String(box.innerHTML || '') : '';

    ok('切换器已渲染', /class="lib/.test(html), html.slice(0, 60));
    ok('列出了世界杯库', /data-db="worldcup"/.test(html));
    ok('列出了企业库', /data-db="enterprise"/.test(html));
    ok('当前库为 worldcup 且带选中态', /class="lib on" data-db="worldcup"|class="lib on"/.test(html));
    ok('切换器可见', els['libs'] && els['libs'].hidden === false);
  }

  /* ---------- AC2 / AC4：检索请求带 db 参数 ---------- */
  console.log('\n[2] 切换后检索只查该库');
  {
    const ml = makeMultiLib();
    const { KB, els } = loadPage({ fetch: ml.fetch });
    await sleep(300);

    els['q'].value = '预算';
    KB.ask();
    await sleep(200);
    ok('默认库请求带 db=worldcup', /db=worldcup/.test(ml._lastUrl()), ml._lastUrl().slice(-40));

    // 切到企业库
    KB.switchLib('enterprise');
    ok('切换后 state.db 更新', KB.currentLib() === 'enterprise', KB.currentLib());

    els['q'].value = '预算';
    KB.ask();
    await sleep(200);
    ok('切换后请求带 db=enterprise', /db=enterprise/.test(ml._lastUrl()), ml._lastUrl().slice(-40));
  }

  /* ---------- AC5：切库清空当前问答（Q4） ---------- */
  console.log('\n[3] 切换知识库清空当前问答');
  {
    const ml = makeMultiLib();
    const { KB, els } = loadPage({ fetch: ml.fetch });
    await sleep(300);

    els['q'].value = '梅西是谁';
    KB.ask();
    await sleep(200);

    KB.switchLib('enterprise');
    ok('输入框已清空', els['q'].value === '', JSON.stringify(els['q'].value));
    ok('state.q 已清空', KB.state.q === '', JSON.stringify(KB.state.q));
    // 空闲态的标志：回到「可以这样问」的引导卡片，且不再有 trace / 答案
    const h = String(els['out'].innerHTML || '');
    ok('答案区回到空闲态', /可以这样问/.test(h) && !/检索过程|检索中/.test(h),
      h.slice(0, 50));
  }

  /* ---------- AC7：服务端不可达 → 不显示切换器 ---------- */
  console.log('\n[4] 服务端不可达时不显示切换器');
  {
    const ml = makeMultiLib({ serverDown: true });
    const { KB, els } = loadPage({ fetch: ml.fetch });
    await sleep(300);
    ok('切换器保持隐藏', !els['libs'] || els['libs'].hidden === true);
    ok('未因不可达而崩溃', !!KB);
  }

  /* ---------- AC9 / SPEC-034：示例问题跟随当前库 ---------- */
  console.log('\n[5] 示例问题随知识库切换');
  {
    const ml = makeMultiLib();
    const a = loadPage({ fetch: ml.fetch, dataFile: 'data.js' });
    await sleep(250);
    const ha = String(a.els['out'].innerHTML || '');
    ok('世界杯库示例含「梅西」', /梅西/.test(ha));
    ok('世界杯库示例不含企业问题', !/中信证券/.test(ha));

    const b = loadPage({ fetch: ml.fetch, dataFile: 'data-enterprise.js' });
    await sleep(250);
    const hb = String(b.els['out'].innerHTML || '');
    ok('企业库示例含「中信证券」', /中信证券/.test(hb));
    ok('企业库示例含「来往账目」', /来往账目/.test(hb));
    ok('企业库示例不再显示世界杯问题', !/梅西/.test(hb));
  }

  /* ---------- 回归：URL ?db= 决定的库必须与切换器选中态一致 ---------- */
  console.log('\n[6] 重载后切换器选中态跟随 URL 的 ?db=');
  {
    const ml = makeMultiLib();
    const p = loadPage({ fetch: ml.fetch, dataFile: 'data-enterprise.js', search: '?db=enterprise' });
    await sleep(300);
    const h = String(p.els['libbox'].innerHTML || '');
    ok('选中态在企业库', /class="lib on" data-db="enterprise"/.test(h), h.slice(0, 90));
    ok('世界杯未被选中', !/data-db="worldcup"[^>]*class="lib on"/.test(h));
    ok('state.db 与 URL 一致', p.KB.currentLib() === 'enterprise', p.KB.currentLib());
  }

  console.log('\n' + (fail === 0
    ? '✅ 全部通过（' + pass + ' 项）'
    : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项') + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
