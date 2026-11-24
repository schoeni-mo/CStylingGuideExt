'use strict';
// Plain node tests: node test/test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { analyze } = require('../src/analyzer');
const { fixAll } = require('../src/fixer');
const H = require('../src/headers');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const rules = (text, opts) => analyze(text, opts || {}).diagnostics.map((d) => d.rule);
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

test('good.c has no violations except info-level duplicates', () => {
  const r = analyze(fx('good.c')).diagnostics.filter((d) => d.severity !== 'information');
  assert.deepStrictEqual(r.map((d) => d.rule), []);
});
test('tricky.c: no false positives besides hardcoded values', () => {
  assert.deepStrictEqual(rules(fx('tricky.c')).filter((r) => r !== 'magic-number'), []);
});
test('bad.c reports every expected rule', () => {
  const found = new Set(rules(fx('bad.c')));
  for (const r of ['file-header', 'non-standard-header', 'forbidden-construct', 'naming-constant', 'global-variable',
    'naming-tag', 'naming-member', 'naming-type', 'brace-own-line', 'function-header', 'naming-function', 'naming-variable',
    'pointer-style', 'no-tabs', 'operator-spacing', 'magic-number', 'chained-declaration', 'unreachable-code',
    'commented-code', 'unnecessary-negation', 'one-statement-per-line', 'nested-loop-counter', 'alloc-null-check',
    'realloc-temp', 'fopen-null-check', 'stderr-output', 'nesting-depth', 'max-nesting', 'indentation', 'too-many-params',
    'static-local', 'meaningful-name']) {
    assert.ok(found.has(r), 'missing ' + r);
  }
});
test('fix-all is idempotent on clean files', () => {
  for (const f of ['good.c', 'tricky.c']) assert.strictEqual(fixAll(fx(f), {}), fx(f), f);
});
test('fix-all removes all layout problems in bad.c', () => {
  const fixed = fixAll(fx('bad.c'), { author: '12345678' }, { includeRenames: true });
  const left = new Set(rules(fixed));
  for (const r of ['no-tabs', 'indentation', 'brace-own-line', 'operator-spacing', 'one-statement-per-line', 'file-header',
    'function-header', 'chained-declaration', 'naming-function', 'naming-member', 'pointer-style']) {
    assert.ok(!left.has(r), r + ' still present');
  }
});
test('function header is generated with params and return', () => {
  const out = fixAll('int addNumbers(int first_number, int second_number)\n{\n  return first_number + second_number;\n}\n', { author: '1' });
  assert.match(out, /\/\/-{118}\n\/\/\/ @brief .*\n\/\/\/ @param first_number .*\n\/\/\/ @param second_number .*\n\/\/\/ @return .*\nint addNumbers/);
});
test('existing header descriptions are kept when params change', () => {
  const src = '//' + '-'.repeat(118) + '\n/// @brief Adds things.\n/// @param old_name gone\n/// @param kept the kept one\n///        second line\nvoid addThings(int kept, int added)\n{\n}\n';
  const out = fixAll(src, { disabledRules: ['file-header'] });
  assert.ok(out.includes('/// @brief Adds things.'));
  assert.ok(out.includes('/// @param kept the kept one\n///        second line'));
  assert.ok(out.includes('/// @param added TODO'));
  assert.ok(!out.includes('old_name'));
  assert.ok(!out.includes('@return'));
});
test('void function with @return is reported', () => {
  const src = H.fileHeaderLines('1', 'x').join('\n') + '\n' + H.DASH_LINE + '\n/// @brief Does.\n/// @return nothing\nvoid doesNothing(void)\n{\n}\n';
  assert.ok(analyze(src).diagnostics.some((d) => d.rule === 'function-header' && /returns void/.test(d.message)));
});
test('do-while, typedef and array exceptions for braces', () => {
  const src = 'void f(void)\n{\n  int array[] = {1, 1};\n  do\n  {\n    array[0]--;\n  } while (array[0]);\n}\n';
  assert.deepStrictEqual(rules(src, { disabledRules: ['file-header', 'function-header', 'meaningful-name'] }), []);
  const bad = 'void f(void)\n{\n  do\n  {\n  }\n  while (0);\n}\n';
  assert.ok(rules(bad).includes('brace-own-line'));
});
test('naming conversions', () => {
  const { toSnake, toCamel, toUpper, toPascal } = require('../src/analyzer');
  assert.strictEqual(toSnake('numItemsInv'), 'num_items_inv');
  assert.strictEqual(toCamel('get_highest_number'), 'getHighestNumber');
  assert.strictEqual(toUpper('maxSize'), 'MAX_SIZE');
  assert.strictEqual(toPascal('my_bool'), 'MyBool');
});
test('functions longer than 70 LOC', () => {
  const body = Array.from({ length: 71 }, (_, i) => `  printf("${i}");`).join('\n');
  assert.ok(rules(`void longFunction(void)\n{\n${body}\n}\n`).includes('function-length'));
});
test('global const is allowed, global variable is not', () => {
  const r = rules('const int MAX_VALUE = 5;\nint global_counter;\nstatic int hidden = 0;\n');
  assert.strictEqual(r.filter((x) => x === 'global-variable').length, 2);
});
test('main with lots of logic', () => {
  const body = Array.from({ length: 6 }, () => '  if (argc)\n    argc--;').join('\n');
  assert.ok(rules(`int main(int argc, char* argv[])\n{\n${body}\n  return argc;\n}\n`).includes('main-logic'));
});
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
