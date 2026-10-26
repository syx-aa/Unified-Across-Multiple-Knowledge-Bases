/**
 * export_docs.js — 从 data.js 导出文档与评测题为 JSON，供 Python 侧向量化使用
 *
 * 运行：node build/export_docs.js
 * 产出：vector/docs.json
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// SPEC-033：支持按库指定数据源与输出目录
// 用法：node build/export_docs.js --data data-enterprise.js --out vector/enterprise
const _argv = process.argv.slice(2);
function _arg(name, def) {
  const i = _argv.indexOf('--' + name);
  return (i >= 0 && _argv[i + 1] && _argv[i + 1].charAt(0) !== '-') ? _argv[i + 1] : def;
}
const DATA_FILE = path.resolve(ROOT, _arg('data', 'data.js'));
const OUT_DIR = path.resolve(ROOT, _arg('out', 'vector'));

const win = {};
new Function('window', fs.readFileSync(DATA_FILE, 'utf8'))(win);
const D = win.WIKI_DATA;

const docs = D.docs.map(d => ({
  id: d.id,
  title: d.title,
  kind: d.kind,
  chunks: (d.chunks || []).map(c => ({ i: c.i, r: c.r }))
}));

const outDir = OUT_DIR;
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'docs.json'),
  JSON.stringify({ docs, terms: D.terms || {}, aliases: D.aliases || {}, meta: D.meta }, null, 1),
  'utf8'
);

const nChunks = docs.reduce((a, d) => a + d.chunks.length, 0);
console.log('导出完成：' + docs.length + ' 篇文档 / ' + nChunks + ' 个 chunk / ' +
  Object.keys(D.terms || {}).length + ' 词条 / ' + Object.keys(D.aliases || {}).length + ' 别名 → vector/docs.json');
