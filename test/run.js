'use strict';
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/analyzer');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const res = analyze(text, {});
const starts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
const pos = (o) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return `${l + 1}:${o - starts[l] + 1}`; };
for (const d of res.diagnostics) {
  console.log(`${path.basename(file)}:${pos(d.start)} [${d.severity}] ${d.rule}: ${d.message}${d.fix ? '  (fix: ' + d.fix.title + ')' : ''}`);
}
console.log(`${res.diagnostics.length} diagnostics`);
