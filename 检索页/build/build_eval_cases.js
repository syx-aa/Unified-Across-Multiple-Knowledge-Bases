/**
 * build_eval_cases.js — 把 tests/eval_cases.json 打包成页面可直接引用的 eval_cases.js
 *
 * 为什么需要这一步：
 *   页面用 file:// 双击打开时，fetch('eval_cases.json') 会被浏览器同源策略拦住（CORS），
 *   改成 <script src> 引入一个挂到 window 上的变量即可绕开，双击就能用。
 *
 * 运行：node build/build_eval_cases.js
 * 输入：tests/eval_cases.json
 * 输出：E:/课件/检索页/eval_cases.js   →   window.EVAL_CASES = {...}
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'tests', 'eval_cases.json');
const OUT = path.join(__dirname, '..', 'eval_cases.js');

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const js = 'window.EVAL_CASES = ' + JSON.stringify(data) + ';\n';
fs.writeFileSync(OUT, js, 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log('生成：' + OUT);
console.log('  ' + data.cases.length + ' 题 · ' + kb + ' KB');
Object.entries(data.meta.counts || {}).forEach(([k, v]) => console.log('    ' + k + ': ' + v));
