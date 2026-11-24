'use strict';
// Pure analysis engine (no vscode dependency) so it can be unit tested with plain node.

const { lex } = require('./lexer');
const { parse, TYPE_KEYWORDS, QUALIFIERS } = require('./parser');
const H = require('./headers');
const { RULES } = require('./rules');

const DEFAULTS = {
  maxLineLength: 120,
  maxFunctionLines: 70,
  maxParams: 6,
  warnNesting: 4,
  maxNesting: 6,
  mainMaxLines: 30,
  allowedNumbers: [0, 1],
  disabledRules: [],
  indentSize: 2,
};

const C17_HEADERS = new Set([
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h', 'inttypes.h', 'iso646.h', 'limits.h',
  'locale.h', 'math.h', 'setjmp.h', 'signal.h', 'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbool.h',
  'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h', 'string.h', 'tgmath.h', 'threads.h',
  'time.h', 'uchar.h', 'wchar.h', 'wctype.h',
]);

const RE = {
  snake: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
  camel: /^[a-z][a-zA-Z0-9]*$/,
  upper: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/,
  member: /^[a-z][a-z0-9]*(_[a-z0-9]+)*_$/,
  pascal: /^[A-Z][a-zA-Z0-9]*$/,
  tag: /^_[A-Z][a-zA-Z0-9]*_$/,
};

const BINARY_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '==', '!=', '<=', '>=', '&&', '||',
  '<', '>', '<<', '>>', '/', '%', '|', '^', '?',
]);
const MAYBE_UNARY = new Set(['+', '-', '*', '&']);
const NON_VALUE_KEYWORDS = new Set([
  'return', 'sizeof', 'case', 'if', 'while', 'for', 'switch', 'else', 'do', 'goto', 'typedef', 'struct',
  'union', 'enum', '_Alignof', 'alignof',
]);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'else', 'do']);
const MEANINGLESS_VARS = new Set(['tmp', 'temp', 'num', 'var', 'foo', 'bar', 'baz', 'val', 'stuff', 'thing', 'data1', 'x1', 'abc', 'asdf']);
const MEANINGLESS_FUNCS = /^(func|function|foo|bar|test|doit|doStuff|doSomething|calculate|compute|helper|process|handle|run|stuff)\d*$/;
const SHORT_COUNTER = /^([a-z]|[a-z]\d|cnt\d*|count\d*|counter\d*|idx\d*|index\d*|ii|jj|kk)$/;

function analyze(text, userOptions) {
  const defined = {};
  for (const [key, value] of Object.entries(userOptions || {})) if (value !== undefined && value !== null) defined[key] = value;
  const opt = Object.assign({}, DEFAULTS, defined);
  const disabled = new Set(opt.disabledRules || []);
  const lexed = lex(text);
  const P = parse(lexed);
  const tk = lexed.tokens;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const lineStarts = lexed.lineStarts;
  const tokensByLine = [];
  for (const t of tk) (tokensByLine[t.line] || (tokensByLine[t.line] = [])).push(t);

  const diagnostics = [];
  const ctx = {
    text, opt, lexed, P, tk, lines, lineStarts, tokensByLine,
    offset: (line, col) => lineStarts[line] + col,
    lead: (line) => /^[ \t]*/.exec(lines[line] || '')[0],
    report(rule, start, end, message, fix, extra) {
      if (disabled.has(rule)) return;
      diagnostics.push(Object.assign({ rule, start, end: Math.max(end, start), message, fix: fix || null,
        severity: RULES[rule] ? RULES[rule].severity : 'warning' }, extra || {}));
    },
    reportTok(rule, tok, message, fix, extra) { this.report(rule, tok.start, tok.end, message, fix, extra); },
  };

  checkRawLines(ctx);
  checkFileHeader(ctx);
  checkFunctionHeaders(ctx);
  checkDirectives(ctx);
  checkNaming(ctx);
  checkGlobals(ctx);
  checkLayout(ctx);
  checkBracesAndStatements(ctx);
  checkSpacing(ctx);
  checkTokens(ctx);
  const fnInfo = [];
  for (const fn of P.functions) {
    if (fn.isDefinition) fnInfo.push(scanFunction(ctx, fn));
  }
  checkDuplicates(ctx, fnInfo);
  checkPointerStyle(ctx);
  checkComments(ctx);

  diagnostics.sort((a, b) => a.start - b.start);
  return { diagnostics, functions: P.functions, parser: P, lexed, lines };
}

// ------------------------------------------------------------------------------------------------ raw lines
function checkRawLines(ctx) {
  const { lines, opt } = ctx;
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const start = ctx.lineStarts[l];
    if (line.includes('\t')) {
      // Fix: expand tabs in leading whitespace to two spaces each, other tabs to one space.
      const lead = /^[ \t]*/.exec(line)[0];
      const newLead = lead.replace(/\t/g, ' '.repeat(opt.indentSize));
      const rest = line.slice(lead.length).replace(/\t/g, ' ');
      ctx.report('no-tabs', start + line.indexOf('\t'), start + line.lastIndexOf('\t') + 1,
        'Tabs are not allowed - indent with exactly two spaces.',
        { title: 'Replace tabs with spaces', edits: [{ start, end: start + line.length, text: newLead + rest }] });
    }
    if (line.length > opt.maxLineLength) {
      ctx.report('line-length', start + opt.maxLineLength, start + line.length,
        `Line is ${line.length} characters long (max. ${opt.maxLineLength}). Break it and indent the continuation by at least 2 spaces.`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ headers
function checkFileHeader(ctx) {
  const res = H.checkFileHeader(ctx.lines);
  if (!res.present) {
    const author = ctx.opt.author || '';
    const headerText = H.fileHeaderLines(author).join('\n') + '\n' + (ctx.lines[0] && ctx.lines[0].trim() ? '\n' : '');
    ctx.report('file-header', 0, Math.min(ctx.text.length, (ctx.lines[0] || '').length),
      res.problems[0], { title: 'Insert file header', edits: [{ start: 0, end: 0, text: headerText }], header: true });
    return;
  }
  const startOff = ctx.lineStarts[res.startLine];
  const endOff = ctx.lineStarts[res.endLine] + ctx.lines[res.endLine].length;
  if (res.problems.length) {
    ctx.report('file-header', startOff, endOff, 'File header: ' + res.problems.join(' '));
  }
  if (res.placeholder) {
    ctx.report('header-placeholder', startOff, endOff, 'File header still contains placeholder text - describe the program and add your matriculation number.');
  }
}

function checkFunctionHeaders(ctx) {
  const { P, lines } = ctx;
  for (const fn of P.functions) {
    if (!fn.isDefinition) continue;
    const startTok = ctx.tk[fn.startTok];
    const fnLine = startTok.line;
    const indent = ctx.lead(fnLine);
    const found = H.findHeaderAbove(lines, fnLine);
    const nameTok = fn.nameTok;
    if (!found) {
      const hdr = H.functionHeaderLines(fn, null).map((l) => indent + l).join('\n') + '\n';
      ctx.report('function-header', nameTok.start, nameTok.end,
        `Function '${fn.name}' has no function header (//---- line, @brief, @param, @return).`,
        { title: `Generate header for '${fn.name}'`, edits: [{ start: ctx.lineStarts[fnLine], end: ctx.lineStarts[fnLine], text: hdr }], header: true });
      continue;
    }
    const parsed = H.parseHeader(found.lines);
    const problems = headerProblems(parsed, fn);
    const hStart = ctx.lineStarts[found.startLine];
    const hEnd = ctx.lineStarts[found.endLine] + lines[found.endLine].length;
    if (problems.length) {
      const newHdr = H.functionHeaderLines(fn, parsed).map((l) => indent + l).join('\n');
      ctx.report('function-header', nameTok.start, nameTok.end,
        `Header of '${fn.name}': ${problems.join('; ')}.`,
        { title: `Update header of '${fn.name}'`, edits: [{ start: hStart, end: hEnd, text: newHdr }], header: true });
    }
    if (H.hasPlaceholder(found.lines)) {
      ctx.report('header-placeholder', hStart, hEnd, `Header of '${fn.name}' still contains TODO placeholders - describe the function.`);
    }
  }
}

function headerProblems(parsed, fn) {
  return H.headerProblems(parsed, fn);
}

// ------------------------------------------------------------------------------------------------ directives
function checkDirectives(ctx) {
  const { P } = ctx;
  for (const inc of P.includes) {
    const d = inc.directive;
    if (inc.name === 'setjmp.h') {
      ctx.report('forbidden-construct', d.start, d.end, 'The <setjmp.h> library is forbidden (-25%).');
    } else if (inc.system && !C17_HEADERS.has(inc.name)) {
      ctx.report('non-standard-header', d.start, d.end, `<${inc.name}> is not part of the C17 standard library (-25%).`);
    }
  }
  for (const def of P.defines) {
    if (!RE.upper.test(def.name) && !/^_*[A-Z0-9_]+_H_*$/.test(def.name)) {
      ctx.report('naming-constant', def.start, def.end, `Constant '${def.name}' should be ALL_UPPERCASE_WITH_UNDERSCORES.`,
        renameFix(ctx, def.name, toUpper(def.name)));
    }
  }
}

// ------------------------------------------------------------------------------------------------ naming
function splitWords(name) {
  return name.replace(/^_+|_+$/g, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/_+/).filter(Boolean).map((w) => w.toLowerCase());
}
function toSnake(name) { return splitWords(name).join('_'); }
function toUpper(name) { return splitWords(name).join('_').toUpperCase(); }
function toCamel(name) { const w = splitWords(name); return w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join(''); }
function toPascal(name) { return splitWords(name).map((x) => x[0].toUpperCase() + x.slice(1)).join(''); }
function toMember(name) { return toSnake(name) + '_'; }
function toTag(name) { return '_' + toPascal(name) + '_'; }

// Rename every identifier token with that name in the file (only offered when the new name is free).
function renameFix(ctx, oldName, newName) {
  if (!newName || newName === oldName) return null;
  if (ctx.tk.some((t) => t.type === 'id' && t.value === newName)) return null;
  const edits = ctx.tk.filter((t) => t.type === 'id' && t.value === oldName).map((t) => ({ start: t.start, end: t.end, text: newName }));
  for (const d of ctx.P.defines) if (d.name === oldName) edits.push({ start: d.start, end: d.end, text: newName });
  for (const dir of ctx.P.directives) {
    // uses inside macros
    const re = new RegExp(`\\b${oldName}\\b`, 'g');
    let m;
    const nameDef = ctx.P.defines.find((d) => d.directive === dir && d.name === oldName);
    while ((m = re.exec(dir.text))) {
      const s = dir.start + m.index;
      if (nameDef && s === nameDef.start) continue;
      edits.push({ start: s, end: s + oldName.length, text: newName });
    }
  }
  return { title: `Rename '${oldName}' to '${newName}'`, edits, rename: true };
}

function checkNaming(ctx) {
  const { P } = ctx;
  const seen = new Set();
  for (const fn of P.functions) {
    if (fn.name !== 'main' && !RE.camel.test(fn.name) && !seen.has(fn.nameTok.start)) {
      seen.add(fn.nameTok.start);
      ctx.reportTok('naming-function', fn.nameTok, `Function '${fn.name}' should be firstWordLowerCaseRestCapitalizedWithoutUnderscores (e.g. ${toCamel(fn.name)}).`,
        renameFix(ctx, fn.name, toCamel(fn.name)));
    }
    if (fn.name !== 'main' && MEANINGLESS_FUNCS.test(fn.name) && fn.isDefinition) {
      ctx.reportTok('meaningful-name', fn.nameTok, `'${fn.name}' does not say what the function does - be precise (e.g. calculateAverageValueOfItems).`);
    }
    if (fn.params.filter((p) => !p.variadic).length > ctx.opt.maxParams && fn.isDefinition) {
      ctx.reportTok('too-many-params', fn.nameTok, `'${fn.name}' has ${fn.params.length} parameters (max. ${ctx.opt.maxParams}). Group related parameters in a struct.`);
    }
    for (const p of fn.params) {
      if (!p.tok || p.variadic) continue;
      if (!RE.snake.test(p.name)) {
        ctx.reportTok('naming-variable', p.tok, `Parameter '${p.name}' should be all_lower_case_with_underscores (e.g. ${toSnake(p.name)}).`,
          fn.isDefinition ? scopedRenameFix(ctx, fn, p.name, toSnake(p.name)) : null);
      } else if (fn.isDefinition) {
        checkMeaningfulVar(ctx, p.tok, p.name);
      }
    }
  }
  for (const m of P.members) {
    if (!RE.member.test(m.name)) {
      ctx.reportTok('naming-member', m.tok, `Struct member '${m.name}' should be all_lower_case_with_underscores_and_trailing_underscore_ (e.g. ${toMember(m.name)}).`,
        memberRenameFix(ctx, m.name, toMember(m.name)));
    }
  }
  for (const e of P.enumerators) {
    if (!RE.upper.test(e.name)) {
      ctx.reportTok('naming-constant', e.tok, `Enum element '${e.name}' should be ALL_UPPERCASE_WITH_UNDERSCORES (e.g. ${toUpper(e.name)}).`,
        renameFix(ctx, e.name, toUpper(e.name)));
    }
  }
  for (const t of P.typedefs) {
    if (!RE.pascal.test(t.name)) {
      ctx.reportTok('naming-type', t.tok, `Typedef'ed type '${t.name}' should be AllWordsCapitalizedWithoutUnderscore (e.g. ${toPascal(t.name)}).`,
        renameFix(ctx, t.name, toPascal(t.name)));
    }
  }
  for (const t of P.tags) {
    if (!RE.tag.test(t.name)) {
      ctx.reportTok('naming-tag', t.tok, `Non-typedef'ed ${t.kind} tag '${t.name}' should be _AllWordsCapitalizedWithUnderscoresOnBothEnds_ (e.g. ${toTag(t.name)}).`,
        renameFix(ctx, t.name, toTag(t.name)));
    }
  }
}

// rename only inside one function (parameters / locals)
function scopedRenameFix(ctx, fn, oldName, newName) {
  if (!newName || newName === oldName) return null;
  const from = fn.startTok;
  const to = fn.closeBrace;
  const toks = ctx.tk.slice(from, to + 1);
  if (toks.some((t) => t.type === 'id' && t.value === newName)) return null;
  const edits = toks.filter((t, i) => t.type === 'id' && t.value === oldName &&
    !(ctx.tk[t.index - 1] && (ctx.tk[t.index - 1].value === '.' || ctx.tk[t.index - 1].value === '->')))
    .map((t) => ({ start: t.start, end: t.end, text: newName }));
  return { title: `Rename '${oldName}' to '${newName}'`, edits, rename: true };
}

// members are accessed via . / -> everywhere
function memberRenameFix(ctx, oldName, newName) {
  if (ctx.tk.some((t) => t.type === 'id' && t.value === newName)) return null;
  const memberToks = new Set(ctx.P.members.filter((m) => m.name === oldName).map((m) => m.tok.index));
  const edits = ctx.tk.filter((t) => t.type === 'id' && t.value === oldName && (memberToks.has(t.index) ||
    (ctx.tk[t.index - 1] && (ctx.tk[t.index - 1].value === '.' || ctx.tk[t.index - 1].value === '->'))))
    .map((t) => ({ start: t.start, end: t.end, text: newName }));
  return { title: `Rename member '${oldName}' to '${newName}'`, edits, rename: true };
}

function checkMeaningfulVar(ctx, tok, name, isLoopCounter) {
  if (isLoopCounter) return;
  if (MEANINGLESS_VARS.has(name.toLowerCase())) {
    ctx.reportTok('meaningful-name', tok, `'${name}' says nothing about its purpose - use a descriptive name (e.g. number_of_items_in_inventory).`);
  } else if (/^[a-z]$/.test(name) && !/^[ijk]$/.test(name)) {
    ctx.reportTok('meaningful-name', tok, `Single-letter name '${name}' - the name should express what the variable is for.`);
  }
}

// ------------------------------------------------------------------------------------------------ globals
function checkGlobals(ctx) {
  for (const g of ctx.P.globals) {
    if (g.isConst) {
      if (!RE.upper.test(g.name)) {
        ctx.reportTok('naming-constant', g.tok, `Constant '${g.name}' should be ALL_UPPERCASE_WITH_UNDERSCORES (e.g. ${toUpper(g.name)}).`,
          renameFix(ctx, g.name, toUpper(g.name)));
      }
      continue;
    }
    ctx.reportTok('global-variable', g.tok, `Global variable '${g.name}' is not allowed (-25%). Pass data via parameters and return values; only global constants are allowed.`);
  }
}

// ------------------------------------------------------------------------------------------------ layout / indentation
function checkLayout(ctx) {
  const { P, tokensByLine, lines, opt } = ctx;
  const IND = opt.indentSize;
  const stack = [{ braceIndent: -IND, kind: 'top', ifIndents: [], isSwitch: false, inCase: false }];
  let pending = 0;
  let inStmt = false;
  let stmtIndent = 0;
  let stmtFirst = null;
  let paren = 0;
  let switchNext = false;

  for (let ln = 0; ln < lines.length; ln++) {
    const toks = tokensByLine[ln];
    if (!toks || !toks.length) continue;
    const lead = ctx.lead(ln);
    const A = lead.length;
    const hasTab = lead.includes('\t');
    const first = toks[0];
    const top = stack[stack.length - 1];
    const base = top.braceIndent + IND;
    const firstIsLineStart = first.col === A;
    const caseExtra = top.isSwitch && top.inCase && first.value !== 'case' && first.value !== 'default' && first.value !== '}' ? IND : 0;
    let expected = null;
    let minIndent = null;
    let elseOk = false;

    if (first.value === '}') {
      expected = top.kind === 'top' ? 0 : top.braceIndent;
    } else if (first.value === '{') {
      expected = inStmt ? stmtIndent : base + caseExtra + IND * Math.max(pending - 1, 0);
    } else if (inStmt) {
      minIndent = first.value === ')' ? stmtIndent : stmtIndent + IND;
    } else if (first.value === 'else') {
      if (top.ifIndents.includes(A)) elseOk = true;
      else expected = top.ifIndents.length ? top.ifIndents[top.ifIndents.length - 1] : base + caseExtra + IND * pending;
    } else {
      expected = base + caseExtra + IND * pending;
    }

    if (!hasTab && firstIsLineStart && !elseOk) {
      const ls = ctx.lineStarts[ln];
      if (expected !== null && A !== expected && expected >= 0) {
        ctx.report('indentation', ls, ls + Math.max(A, 1) + (A ? 0 : first.value.length - 1),
          `Wrong indentation: expected ${expected} spaces, found ${A}. Each block is indented by exactly two spaces.`,
          { title: 'Fix indentation', edits: [{ start: ls, end: ls + A, text: ' '.repeat(expected) }], layout: true });
      } else if (minIndent !== null && A < minIndent) {
        ctx.report('indentation', ls, ls + Math.max(A, 1),
          `Continuation line should be indented at least ${minIndent} spaces (2 more than the start of the statement).`,
          { title: 'Fix continuation indentation', edits: [{ start: ls, end: ls + A, text: ' '.repeat(minIndent) }], layout: true });
      }
    }

    // continue with the indentation the line *should* have, so errors do not cascade
    const eff = expected !== null && expected >= 0 ? expected : A;
    for (const t of toks) {
      const v = t.value;
      const cur = stack[stack.length - 1];
      if (!inStmt && paren === 0 && v !== '{' && v !== '}' && v !== ';') {
        inStmt = true;
        stmtIndent = t === first ? eff : A;
        stmtFirst = v;
        if (v === 'if') cur.ifIndents.push(t === first ? eff : A);
      }
      if (v === '(' || v === '[') paren++;
      else if (v === ')' || v === ']') paren = Math.max(0, paren - 1);
      else if (v === '{') {
        const kind = P.braceKind.get(t.index) || 'block';
        const braceIndent = t === first ? eff : (inStmt ? stmtIndent : eff);
        const entry = { braceIndent, kind, ifIndents: [], isSwitch: false, inCase: false, saved: null };
        if (kind === 'block' && (switchNext || (inStmt && stmtFirst === 'switch'))) entry.isSwitch = true;
        if (kind === 'block') switchNext = false;
        if (kind === 'struct' || kind === 'enum' || kind === 'init') entry.saved = { inStmt, stmtIndent, stmtFirst, pending, paren };
        stack.push(entry);
        inStmt = false; pending = 0; paren = 0;
      } else if (v === '}') {
        if (stack.length > 1) {
          const e = stack.pop();
          if (e.saved) ({ inStmt, stmtIndent, stmtFirst, pending, paren } = e.saved);
          else { inStmt = false; pending = 0; paren = 0; }
        }
      } else if (v === ';' && paren === 0) {
        inStmt = false; pending = 0;
      } else if (v === ':' && paren === 0 && inStmt && (stmtFirst === 'case' || stmtFirst === 'default')) {
        inStmt = false;
        cur.inCase = true;
      } else if (v === ':' && paren === 0 && inStmt && ctx.tk[t.index - 1] && ctx.tk[t.index - 1].value === stmtFirst &&
        ctx.tk[t.index - 1].type === 'id' && cur.kind !== 'struct') {
        inStmt = false; // goto label
      }
    }
    const last = toks[toks.length - 1];
    const cur = stack[stack.length - 1];
    if ((cur.kind === 'init' || cur.kind === 'enum') && last.value === ',') inStmt = false;
    if (inStmt && paren === 0 && CONTROL.has(stmtFirst)) {
      if ((last.value === ')' && P.isControlParen(last.index)) || last.value === 'else' || last.value === 'do') {
        pending++;
        inStmt = false;
        if (stmtFirst === 'switch') switchNext = true;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ braces & statements
function nextOnLine(ctx, t) {
  const n = ctx.tk[t.index + 1];
  return n && n.line === t.line ? n : null;
}
function prevOnLine(ctx, t) {
  const p = ctx.tk[t.index - 1];
  return p && p.line === t.line ? p : null;
}
function breakBefore(ctx, prev, tok, extraIndent) {
  const indent = ' '.repeat(Math.max(0, ctx.lead(tok.line).length + (extraIndent || 0)));
  return { start: prev.end, end: tok.start, text: '\n' + indent };
}

function checkBracesAndStatements(ctx) {
  const { tk, P } = ctx;
  const IND = ctx.opt.indentSize;
  // paren depth for every token
  const depth = new Array(tk.length).fill(0);
  let d = 0;
  for (const t of tk) {
    if (t.value === ')' || t.value === ']') d = Math.max(0, d - 1);
    depth[t.index] = d;
    if (t.value === '(' || t.value === '[') d++;
    if (t.value === '{' || t.value === '}' || t.value === ';') { if (t.value !== ';') d = Math.min(d, d); }
  }

  for (const t of tk) {
    const v = t.value;
    if (v === '{') {
      const kind = P.braceKind.get(t.index) || 'block';
      const prev = prevOnLine(ctx, t);
      const next = nextOnLine(ctx, t);
      if (kind === 'init') {
        if (!prev && tk[t.index - 1] && tk[t.index - 1].value === '=') {
          ctx.reportTok('brace-own-line', t, 'Array/struct initializer braces belong on the same line as the declaration: int array[] = {1, 2, 3, 4};',
            { title: 'Join initializer with declaration', edits: [{ start: tk[t.index - 1].end, end: t.start, text: ' ' }], layout: true });
        }
        continue;
      }
      if (prev) {
        ctx.reportTok('brace-own-line', t, "Opening block bracket '{' must be on its own line.",
          { title: "Move '{' to its own line", edits: [breakBefore(ctx, prev, t, 0)], layout: true });
      }
      if (next) {
        ctx.reportTok('brace-own-line', next, "Code after '{' must start on a new line.",
          { title: 'Insert line break', edits: [breakBefore(ctx, t, next, next.value === '}' ? 0 : IND)], layout: true });
      }
    } else if (v === '}') {
      const open = P.match[t.index];
      const kind = open >= 0 ? (P.braceKind.get(open) || 'block') : 'block';
      const prev = prevOnLine(ctx, t);
      const next = nextOnLine(ctx, t);
      const after = tk[t.index + 1];
      const isDo = open > 0 && tk[open - 1] && tk[open - 1].value === 'do';
      if (kind === 'init') {
        if (after && after.value === ';' && after.line !== t.line) {
          ctx.reportTok('brace-own-line', after, "The ';' belongs directly after '}'.",
            { title: "Move ';' after '}'", edits: [{ start: t.end, end: after.start, text: '' }], layout: true });
        }
        continue;
      }
      if (prev && prev.value !== '{') {
        ctx.reportTok('brace-own-line', t, "Closing block bracket '}' must be on its own line.",
          { title: "Move '}' to its own line", edits: [breakBefore(ctx, prev, t, -IND)], layout: true });
      }
      if (next) {
        const ok = next.value === ';' || next.value === ',' ||
          (next.value === 'while' && isDo) ||
          ((kind === 'struct' || kind === 'enum') && (next.type === 'id' || next.value === '*'));
        if (!ok) {
          ctx.reportTok('brace-own-line', next, next.value === 'else'
            ? "'else' must be on its own line after '}'."
            : "Code after '}' must start on a new line.",
          { title: 'Insert line break', edits: [breakBefore(ctx, t, next, 0)], layout: true });
        }
      } else if (after) {
        // exceptions that must stay on the same line as '}'
        if (after.value === ';' || (after.value === 'while' && isDo) ||
          ((kind === 'struct' || kind === 'enum') && after.type === 'id' && tk[open - 1] && isTypedefBody(ctx, open))) {
          const what = after.value === ';' ? "';'" : after.value === 'while' ? "'while' of a do-while loop" : 'The typedef name';
          ctx.reportTok('brace-own-line', after, `${what} belongs on the same line as '}' (e.g. "} Whatever;", "} while (x);").`,
            { title: "Join with '}'", edits: [{ start: t.end, end: after.start, text: after.value === ';' ? '' : ' ' }], layout: true });
        }
      }
    } else if (v === ';' && depth[t.index] === 0) {
      const next = nextOnLine(ctx, t);
      if (next && next.value !== '}') {
        ctx.reportTok('one-statement-per-line', next, 'Each statement must be on its own line.',
          { title: 'Insert line break', edits: [breakBefore(ctx, t, next, 0)], layout: true });
      }
    } else if (v === ')' && P.isControlParen(t.index)) {
      const kw = tk[P.match[t.index] - 1];
      const next = nextOnLine(ctx, t);
      const isDoWhile = kw.value === 'while' && tk[kw.index - 1] && tk[kw.index - 1].value === '}' &&
        P.match[kw.index - 1] > 0 && tk[P.match[kw.index - 1] - 1] && tk[P.match[kw.index - 1] - 1].value === 'do';
      if (next && next.value !== '{' && next.value !== ';' && !isDoWhile) {
        ctx.reportTok('one-statement-per-line', next, `The body of '${kw.value}' must start on a new line.`,
          { title: 'Insert line break', edits: [breakBefore(ctx, t, next, IND)], layout: true });
      }
    } else if ((v === 'else' || v === 'do') && t.type === 'id') {
      const next = nextOnLine(ctx, t);
      if (next && next.value !== '{' && !(v === 'else' && next.value === 'if')) {
        ctx.reportTok('one-statement-per-line', next, `The body of '${v}' must start on a new line.`,
          { title: 'Insert line break', edits: [breakBefore(ctx, t, next, IND)], layout: true });
      }
    } else if ((v === 'case' || v === 'default') && t.type === 'id') {
      // find the label colon
      let k = t.index + 1;
      let pd = 0;
      let q = 0;
      for (; k < tk.length; k++) {
        const w = tk[k].value;
        if (w === '(') pd++;
        else if (w === ')') pd--;
        else if (w === '?') q++;
        else if (w === ':' && pd === 0) { if (q) { q--; continue; } break; }
        else if (w === ';' || w === '{' || w === '}') { k = -1; break; }
      }
      if (k > 0 && tk[k]) {
        const colon = tk[k];
        const next = nextOnLine(ctx, colon);
        if (next && next.value !== '{') {
          ctx.reportTok('one-statement-per-line', next, `Statements after '${v}:' must start on a new line.`,
            { title: 'Insert line break', edits: [breakBefore(ctx, colon, next, IND)], layout: true });
        }
      }
    }
  }
}

function isTypedefBody(ctx, open) {
  for (let k = open - 1; k >= 0 && k >= open - 4; k--) {
    if (ctx.tk[k].value === 'typedef') return true;
    if (ctx.tk[k].value === ';' || ctx.tk[k].value === '}') return false;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ spacing
function isWs(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isTypeToken(ctx, t) {
  if (!t || t.type !== 'id') return false;
  return TYPE_KEYWORDS.has(t.value) || QUALIFIERS.has(t.value) || ctx.P.typeNames.has(t.value) ||
    (/^[A-Z][a-z]/.test(t.value) && !RE.upper.test(t.value)) ||
    (ctx.tk[t.index - 1] && ['struct', 'union', 'enum'].includes(ctx.tk[t.index - 1].value));
}

function isBinaryContext(ctx, t) {
  const prev = ctx.tk[t.index - 1];
  if (!prev) return false;
  if (prev.type === 'num' || prev.type === 'str' || prev.type === 'char') return true;
  if (prev.value === ')' || prev.value === ']') {
    if (prev.value === ')' && (t.value === '*' || t.value === '&' || t.value === '-' || t.value === '+')) {
      // cast like (int)-x or (char*)&y ? check what is inside the parens
      const open = ctx.P.match[prev.index];
      const inner = ctx.tk[open + 1];
      if (inner && isTypeToken(ctx, inner) && !ctx.P.isControlParen(prev.index)) {
        const fnCall = ctx.tk[open - 1] && ctx.tk[open - 1].type === 'id' && !NON_VALUE_KEYWORDS.has(ctx.tk[open - 1].value);
        if (!fnCall) return false;
      }
    }
    return true;
  }
  if (prev.value === '++' || prev.value === '--') {
    const pp = ctx.tk[t.index - 2];
    return pp && (pp.type === 'id' || pp.value === ')' || pp.value === ']');
  }
  if (prev.type === 'id') {
    if (NON_VALUE_KEYWORDS.has(prev.value)) return false;
    if ((t.value === '*' || t.value === '&') && isTypeToken(ctx, prev)) return false;
    return true;
  }
  return false;
}

function checkSpacing(ctx) {
  const { tk, text } = ctx;
  for (const t of tk) {
    if (t.type !== 'punct') continue;
    const v = t.value;
    if (v === ',') {
      if (!isWs(text[t.end]) && text[t.end] !== undefined) {
        ctx.reportTok('operator-spacing', t, "Missing space after ','.",
          { title: "Insert space after ','", edits: [{ start: t.end, end: t.end, text: ' ' }], layout: true });
      }
      continue;
    }
    let binary = BINARY_OPS.has(v);
    if (!binary && MAYBE_UNARY.has(v)) binary = isBinaryContext(ctx, t);
    if (!binary) continue;
    // '<' '>' could be part of a header name in a macro; tokens never contain directives, fine.
    const before = isWs(text[t.start - 1]);
    const after = isWs(text[t.end]);
    if (before && after) continue;
    const edits = [];
    if (!before) edits.push({ start: t.start, end: t.start, text: ' ' });
    if (!after) edits.push({ start: t.end, end: t.end, text: ' ' });
    ctx.reportTok('operator-spacing', t, `Binary operator '${v}' needs a space on both sides.`,
      { title: `Insert spaces around '${v}'`, edits, layout: true });
  }
}

// ------------------------------------------------------------------------------------------------ token-level rules
function checkTokens(ctx) {
  const { tk } = ctx;
  for (const t of tk) {
    if (t.type !== 'id') continue;
    const next = tk[t.index + 1];
    const prev = tk[t.index - 1];
    const isCall = next && next.value === '(';
    const isMember = prev && (prev.value === '.' || prev.value === '->');
    if (isMember) continue;
    if (t.value === 'goto') {
      ctx.reportTok('forbidden-construct', t, "'goto' is forbidden (-25%).");
    } else if (isCall && ['exit', '_Exit', 'quick_exit', 'abort'].includes(t.value)) {
      ctx.reportTok('forbidden-construct', t, `'${t.value}()' is forbidden (-25%). Return from main instead.`);
    } else if (isCall && ['setjmp', 'longjmp'].includes(t.value)) {
      ctx.reportTok('forbidden-construct', t, `'${t.value}' (setjmp.h) is forbidden (-25%).`);
    } else if (t.value === 'stderr' || (isCall && t.value === 'perror')) {
      ctx.reportTok('stderr-output', t, 'Output must go to stdout, not stderr (-10%). Use printf.');
    }
  }
  // unnecessary negation: !(a < b)
  for (const t of tk) {
    if (t.value !== '!' || !tk[t.index + 1] || tk[t.index + 1].value !== '(') continue;
    const open = t.index + 1;
    const close = ctx.P.match[open];
    if (close < 0) continue;
    // the parens must not be a function call / more complex expression
    let opTok = null;
    let ok = true;
    for (let k = open + 1; k < close; k++) {
      const w = tk[k].value;
      if (w === '(' || w === '[') { k = ctx.P.match[k]; continue; }
      if (w === '&&' || w === '||' || w === '?' || w === '=') { ok = false; break; }
      if (['<', '>', '<=', '>=', '==', '!='].includes(w)) { if (opTok) { ok = false; break; } opTok = tk[k]; }
    }
    if (!ok || !opTok) continue;
    const inv = { '<': '>=', '>': '<=', '<=': '>', '>=': '<', '==': '!=', '!=': '==' }[opTok.value];
    const lhs = ctx.text.slice(tk[open + 1].start, tk[opTok.index - 1].end);
    const rhs = ctx.text.slice(tk[opTok.index + 1].start, tk[close - 1].end);
    ctx.report('unnecessary-negation', t.start, tk[close].end, `Unnecessary negation - write '${lhs} ${inv} ${rhs}' instead.`,
      { title: `Simplify to '${lhs} ${inv} ${rhs}'`, edits: [{ start: t.start, end: tk[close].end, text: `${lhs} ${inv} ${rhs}` }] });
  }
}

// ------------------------------------------------------------------------------------------------ per-function scan
function stmtEnd(ctx, k, limit) {
  const { tk, P } = ctx;
  let j = k;
  while (j < limit) {
    const v = tk[j].value;
    if (v === ';') return j;
    if ((v === '(' || v === '[' || v === '{') && P.match[j] > j) { j = P.match[j] + 1; continue; }
    if (v === '}') return j - 1;
    j++;
  }
  return limit - 1;
}

function numberValue(s) {
  const clean = s.replace(/[uUlLfF]+$/, '');
  if (/^0[xX]/.test(clean)) return parseInt(clean, 16);
  if (/^0[bB]/.test(clean)) return parseInt(clean.slice(2), 2);
  if (/^0[0-7]+$/.test(clean)) return parseInt(clean, 8);
  return parseFloat(clean);
}

function scanFunction(ctx, fn) {
  const { tk, P, opt } = ctx;
  const open = fn.openBrace;
  const close = fn.closeBrace;
  const blocks = [];
  let pending = 0;
  let nestWarned = false;
  let nestErrored = false;
  const loopStack = [];
  const allocs = [];
  const locals = [];
  const codeLines = new Set();
  let controlCount = 0;
  let maxNest = 0;
  let unreachableReported = false;
  const level = () => blocks.reduce((s, b) => s + b.contrib, 0) + pending;

  for (let k = open + 1; k < close; k++) codeLines.add(tk[k].line);
  // remove lines that only contain braces / semicolons
  for (const line of [...codeLines]) {
    const toks = ctx.tokensByLine[line].filter((t) => t.index > open && t.index < close);
    if (toks.every((t) => t.value === '{' || t.value === '}' || t.value === ';')) codeLines.delete(line);
  }

  let k = open + 1;
  while (k < close) {
    const t = tk[k];
    const v = t.value;
    if (v === '{') {
      const kind = P.braceKind.get(k);
      blocks.push({ contrib: pending, close: P.match[k] });
      pending = 0;
      k++;
      continue;
    }
    if (v === '}') {
      blocks.pop();
      pending = 0;
      k++;
      continue;
    }
    if (v === ';') { pending = 0; k++; continue; }
    if (v === 'else') {
      if (tk[k + 1] && tk[k + 1].value === 'if') { k++; continue; }
      pending++;
      k++;
      continue;
    }
    if (v === 'do' || v === 'if' || v === 'for' || v === 'while' || v === 'switch') {
      const L = level();
      const isDoWhileTail = v === 'while' && tk[k - 1] && tk[k - 1].value === '}' && P.match[k - 1] > 0 &&
        tk[P.match[k - 1] - 1] && tk[P.match[k - 1] - 1].value === 'do';
      if (!isDoWhileTail) {
        controlCount++;
        const nest = L + 1;
        maxNest = Math.max(maxNest, nest);
        if (nest > opt.maxNesting && !nestErrored) {
          nestErrored = true;
          ctx.reportTok('max-nesting', t, `Nesting depth ${nest} exceeds the maximum of ${opt.maxNesting} (-10%). Use guard clauses or helper functions.`);
        } else if (nest > opt.warnNesting && nest <= opt.maxNesting && !nestWarned) {
          nestWarned = true;
          ctx.reportTok('nesting-depth', t, `Nesting depth ${nest}: more than ${opt.warnNesting} levels will almost certainly lead to deductions. Consider guard clauses or helper functions.`);
        }
      }
      if ((v === 'for' || v === 'while' || v === 'do') && !isDoWhileTail) {
        while (loopStack.length && loopStack[loopStack.length - 1].level >= L) loopStack.pop();
        let counter = null;
        if (v === 'for' && tk[k + 1] && tk[k + 1].value === '(') {
          const pOpen = k + 1;
          const pClose = P.match[pOpen];
          let semi = pOpen + 1;
          while (semi < pClose && tk[semi].value !== ';') semi++;
          const decl = P.parseDeclarators(pOpen + 1, semi);
          if (decl) {
            for (const dd of decl.declarators) {
              locals.push({ name: dd.name, tok: dd.tok, loopCounter: true });
              checkLocalName(ctx, fn, dd, decl, true);
            }
            counter = decl.declarators[0];
          } else if (tk[pOpen + 1] && tk[pOpen + 1].type === 'id' && tk[pOpen + 2] && tk[pOpen + 2].value === '=') {
            counter = { name: tk[pOpen + 1].value, tok: tk[pOpen + 1] };
          } else if (tk[semi + 1] && tk[semi + 1].type === 'id') {
            counter = { name: tk[semi + 1].value, tok: tk[semi + 1] };
          }
        }
        const entry = { level: L, counter, reported: false };
        if (counter && SHORT_COUNTER.test(counter.name)) {
          const outers = loopStack.filter((l) => l.counter && SHORT_COUNTER.test(l.counter.name));
          if (loopStack.length) {
            entry.reported = true;
            ctx.reportTok('nested-loop-counter', counter.tok, `Counter '${counter.name}' in a nested loop - use a name that says what is counted (e.g. row_index).`);
            for (const o of outers) {
              if (o.reported) continue;
              o.reported = true;
              ctx.reportTok('nested-loop-counter', o.counter.tok, `Counter '${o.counter.name}' of a loop with a nested loop - use a name that says what is counted.`);
            }
          }
        }
        loopStack.push(entry);
      }
      if (v === 'do') { pending++; k++; continue; }
      // condition analysis
      if (tk[k + 1] && tk[k + 1].value === '(') {
        const pOpen = k + 1;
        const pClose = P.match[pOpen];
        if (v !== 'for') checkCondition(ctx, pOpen, pClose);
        if (pClose < 0) break;
        k = pClose + 1;
        if (isDoWhileTail) continue;
        pending++;
        continue;
      }
      k++;
      continue;
    }
    if ((v === 'case' || v === 'default') && t.type === 'id') {
      let j = k + 1;
      while (j < close && tk[j].value !== ':') j++;
      k = j + 1;
      continue;
    }
    if (t.type === 'id' && tk[k + 1] && tk[k + 1].value === ':' && !(tk[k - 1] && tk[k - 1].value === '?')) {
      k += 2; // label
      continue;
    }
    // ordinary statement
    const end = stmtEnd(ctx, k, close);
    const startLevelPending = pending;
    if (P.isTypeStart(k) || P.looksLikeType(k)) {
      const decl = P.parseDeclarators(k, end);
      if (decl && !decl.declarators.some((dd) => dd.isFunction)) {
        if (decl.declarators.length > 1) reportChained(ctx, decl, k);
        for (const dd of decl.declarators) {
          locals.push({ name: dd.name, tok: dd.tok });
          checkLocalName(ctx, fn, dd, decl, false);
          if (decl.specifiers.includes('static')) {
            ctx.reportTok('static-local', dd.tok, `Static local variable '${dd.name}' - abusing static variables to simulate globals is forbidden.`);
          }
          if (dd.initStart >= 0) {
            const a = allocCall(ctx, dd.initStart + 1, dd.segEnd);
            if (a) allocs.push(Object.assign(a, { lhs: dd.name, lhsTok: dd.tok, end }));
          }
        }
      }
    } else {
      // assignment "lhs = malloc(...)"
      let eq = -1;
      for (let j = k; j <= end; j++) {
        const w = tk[j].value;
        if (w === '(' || w === '[') { j = P.match[j]; continue; }
        if (w === '=') { eq = j; break; }
      }
      if (eq > k) {
        const a = allocCall(ctx, eq + 1, end + 1);
        if (a) allocs.push(Object.assign(a, { lhs: tk.slice(k, eq).map((x) => x.value).join(' '), lhsTok: tk[k], end }));
      }
      if ((v === 'return' || v === 'break' || v === 'continue') && startLevelPending === 0 && !unreachableReported) {
        const nx = tk[end + 1];
        if (nx && end + 1 < close && nx.value !== '}' && nx.value !== 'case' && nx.value !== 'default') {
          unreachableReported = true;
          ctx.reportTok('unreachable-code', nx, `Unreachable code: this statement can never be executed (after '${v}').`);
        }
      }
    }
    pending = 0;
    k = end + 1;
  }

  // recursion
  const selfCall = tk.slice(open + 1, close).find((t) => t.type === 'id' && t.value === fn.name && tk[t.index + 1] && tk[t.index + 1].value === '(' &&
    !(tk[t.index - 1] && (tk[t.index - 1].value === '.' || tk[t.index - 1].value === '->')));
  if (selfCall) {
    ctx.reportTok('recursion', selfCall, `'${fn.name}' is recursive. Make sure recursion is appropriate here (never for handling user input) - otherwise -10%.`);
  }

  // allocation checks
  for (const a of allocs) checkAlloc(ctx, a, close);

  // magic numbers
  const allowed = new Set((opt.allowedNumbers || []).map(Number));
  for (let j = open + 1; j < close; j++) {
    const t = tk[j];
    if (t.type !== 'num') continue;
    const val = numberValue(t.value);
    if (allowed.has(val)) continue;
    let shown = t.value;
    if (tk[j - 1] && tk[j - 1].value === '-' && !isBinaryContext(ctx, tk[j - 1])) {
      if (allowed.has(-val)) continue;
      shown = '-' + shown;
    }
    ctx.reportTok('magic-number', t, `Hardcoded value ${shown} - use a constant (#define or const) with a meaningful name.`);
  }

  // length
  const loc = codeLines.size;
  if (loc > opt.maxFunctionLines) {
    ctx.reportTok('function-length', fn.nameTok, `'${fn.name}' has ${loc} lines of code (max. ${opt.maxFunctionLines}). Split it into helper functions with one purpose each.`);
  }
  if (fn.name === 'main' && (loc > opt.mainMaxLines || controlCount > 4 || maxNest > 2)) {
    ctx.reportTok('main-logic', fn.nameTok, `main has ${loc} lines and ${controlCount} control structures - main should only call subfunctions and handle their results.`);
  }
  return { fn, open, close };
}

function checkLocalName(ctx, fn, dd, decl, isLoopCounter) {
  const isConst = decl.isConst && !dd.pointer;
  if (isConst && RE.upper.test(dd.name)) return;
  if (!RE.snake.test(dd.name)) {
    ctx.reportTok('naming-variable', dd.tok, `Local variable '${dd.name}' should be all_lower_case_with_underscores (e.g. ${toSnake(dd.name)}).`,
      scopedRenameFix(ctx, fn, dd.name, toSnake(dd.name)));
    return;
  }
  checkMeaningfulVar(ctx, dd.tok, dd.name, isLoopCounter);
}

function reportChained(ctx, decl, k) {
  const { tk, text } = ctx;
  const specText = text.slice(tk[k].start, tk[decl.typeEnd - 1].end);
  const indent = ctx.lead(tk[k].line);
  const edits = [];
  for (let s = 1; s < decl.segments.length; s++) {
    const comma = tk[decl.segments[s][0] - 1];
    const segFirst = tk[decl.segments[s][0]];
    if (!comma || !segFirst) return;
    edits.push({ start: comma.start, end: segFirst.start, text: `;\n${indent}${specText} ` });
  }
  ctx.reportTok('chained-declaration', decl.declarators[1].tok, 'Declare each variable individually on its own line.',
    { title: 'Split declarations', edits, layout: true });
}

function allocCall(ctx, from, to) {
  const { tk, P } = ctx;
  let j = from;
  // skip casts "(Type*)"
  while (tk[j] && tk[j].value === '(' && P.match[j] > j && P.match[j] < to && tk[j + 1] && P.isTypeStart(j + 1) || (tk[j] && tk[j].value === '(' && tk[j + 1] && P.looksLikeType(j + 1))) {
    j = P.match[j] + 1;
  }
  const t = tk[j];
  if (!t || t.type !== 'id' || !tk[j + 1] || tk[j + 1].value !== '(') return null;
  if (!['malloc', 'calloc', 'realloc', 'fopen'].includes(t.value)) return null;
  const call = { kind: t.value, tok: t };
  if (t.value === 'realloc') {
    const pOpen = j + 1;
    let k = pOpen + 1;
    const arg = [];
    while (k < P.match[pOpen] && tk[k].value !== ',') { arg.push(tk[k].value); k++; }
    call.firstArg = arg.join(' ');
  }
  return call;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function checkAlloc(ctx, a, close) {
  const { tk } = ctx;
  const rest = ' ' + tk.slice(a.end + 1, close).map((t) => t.value).join(' ') + ' ';
  const L = escapeRe(a.lhs);
  const patterns = [
    `${L} == NULL`, `${L} != NULL`, `NULL == ${L}`, `NULL != ${L}`, `! ${L} [)&|]`, `\\( ${L} \\)`,
    `${L} == 0 `, `${L} != 0 `, `\\( ${L} &&`, `\\( ${L} \\|\\|`, `\\|\\| ${L} \\)`, `&& ${L} \\)`,
  ];
  const checked = patterns.some((p) => new RegExp(`(^|[^A-Za-z0-9_])${p}`).test(rest));
  if (a.kind === 'realloc' && a.firstArg === a.lhs) {
    ctx.reportTok('realloc-temp', a.tok, `If realloc fails, '${a.lhs}' is lost (memory leak). Store the result in a temporary pointer first.`);
  }
  if (!checked) {
    const rule = a.kind === 'fopen' ? 'fopen-null-check' : 'alloc-null-check';
    const what = a.kind === 'fopen' ? 'Opened file' : `Result of ${a.kind}`;
    ctx.reportTok(rule, a.tok, `${what} '${a.lhs}' is never checked for NULL. On failure free all allocated resources and end in a controlled way.`);
  }
}

// detect "x > 5 && x < 4" style contradictions and constant conditions
function checkCondition(ctx, pOpen, pClose) {
  const { tk } = ctx;
  if (pClose - pOpen === 2 && tk[pOpen + 1].type === 'num' && numberValue(tk[pOpen + 1].value) === 0) {
    ctx.reportTok('unreachable-code', tk[pOpen + 1], 'Condition is always false - this code can never be executed.');
    return;
  }
  // split on top-level && (only pure && chains)
  const parts = [];
  let cur = [];
  for (let k = pOpen + 1; k < pClose; k++) {
    const w = tk[k].value;
    if (w === '||') return;
    if (w === '(' || w === '[') { const m = ctx.P.match[k]; cur.push(...tk.slice(k, m + 1)); k = m; continue; }
    if (w === '&&') { parts.push(cur); cur = []; continue; }
    cur.push(tk[k]);
  }
  parts.push(cur);
  const ranges = new Map();
  for (const p of parts) {
    if (p.length !== 3) continue;
    let [a, op, b] = p;
    if (a.type === 'num' && b.type === 'id') {
      [a, b] = [b, a];
      op = { value: { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==' }[op.value] || op.value };
    }
    if (a.type !== 'id' || b.type !== 'num') continue;
    const n = numberValue(b.value);
    const r = ranges.get(a.value) || { lo: -Infinity, hi: Infinity, loInc: true, hiInc: true };
    if (op.value === '>') { if (n >= r.lo) { r.lo = n; r.loInc = false; } }
    else if (op.value === '>=') { if (n > r.lo) { r.lo = n; r.loInc = true; } }
    else if (op.value === '<') { if (n <= r.hi) { r.hi = n; r.hiInc = false; } }
    else if (op.value === '<=') { if (n < r.hi) { r.hi = n; r.hiInc = true; } }
    else if (op.value === '==') { r.lo = Math.max(r.lo, n); r.hi = Math.min(r.hi, n); }
    else continue;
    ranges.set(a.value, r);
  }
  for (const [name, r] of ranges) {
    if (r.lo > r.hi || (r.lo === r.hi && !(r.loInc && r.hiInc))) {
      ctx.report('unreachable-code', tk[pOpen].start, tk[pClose].end, `Condition on '${name}' can never be true - the code inside is unreachable.`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ duplicates
function checkDuplicates(ctx, fnInfo) {
  const seqs = [];
  for (const info of fnInfo) {
    const lineNums = [];
    for (let l = ctx.tk[info.open].line + 1; l < ctx.tk[info.close].line; l++) {
      const toks = (ctx.tokensByLine[l] || []).filter((t) => t.index > info.open && t.index < info.close);
      const norm = toks.map((t) => t.value).join(' ');
      if (toks.length <= 2 || /^(break ;|return .{0,3};|else|continue ;|default :)$/.test(norm)) continue;
      lineNums.push({ line: l, norm, count: toks.length, first: toks[0] });
    }
    seqs.push(lineNums);
  }
  const seen = new Map();
  const reportedLines = new Set();
  for (const seq of seqs) {
    for (let i = 0; i + 1 < seq.length; i++) {
      const w3 = i + 2 < seq.length ? [seq[i], seq[i + 1], seq[i + 2]] : null;
      const w2 = [seq[i], seq[i + 1]];
      const candidates = [];
      if (w3) candidates.push(w3);
      if (w2[0].count + w2[1].count >= 10) candidates.push(w2);
      for (const w of candidates) {
        const key = w.map((x) => x.norm).join('\n');
        const prev = seen.get(key);
        if (prev === undefined) { seen.set(key, w[0].line); continue; }
        if (prev + w.length > w[0].line) continue; // overlapping
        if (w.some((x) => reportedLines.has(x.line))) continue;
        w.forEach((x) => reportedLines.add(x.line));
        const first = w[0].first;
        const lastLine = w[w.length - 1].line;
        ctx.report('duplicate-code', first.start, ctx.lineStarts[lastLine] + ctx.lines[lastLine].length,
          `Duplicated code (same as line ${prev + 1}). Move recurring subtasks into a helper function.`);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ pointer style
function checkPointerStyle(ctx) {
  const { tk, text, P } = ctx;
  const samples = [];
  const consider = (star) => {
    const prev = tk[star.index - 1];
    const next = tk[star.index + 1];
    if (!prev || !next || next.type !== 'id' || prev.value === '*') return;
    const spaceBefore = isWs(text[star.start - 1]);
    const spaceAfter = isWs(text[star.end]);
    if (spaceBefore === spaceAfter) return; // "int * x" or "int*x": neither style
    samples.push({ star, style: spaceBefore ? 'name' : 'type' });
  };
  for (const fn of P.functions) {
    for (const p of fn.params) {
      for (let k = p.from; k < p.to; k++) if (tk[k].value === '*' && isTypeToken(ctx, tk[k - 1])) { consider(tk[k]); break; }
    }
  }
  for (const t of tk) {
    if (t.value !== '*') continue;
    const prev = tk[t.index - 1];
    if (!prev || !isTypeToken(ctx, prev)) continue;
    if (samples.some((s) => s.star === t)) continue;
    const next = tk[t.index + 1];
    if (next && next.type === 'id' && tk[t.index + 2] && [';', '=', ',', '[', ')'].includes(tk[t.index + 2].value)) consider(t);
  }
  const typeCount = samples.filter((s) => s.style === 'type').length;
  const nameCount = samples.length - typeCount;
  if (!typeCount || !nameCount) return;
  const majority = typeCount >= nameCount ? 'type' : 'name';
  for (const s of samples) {
    if (s.style === majority) continue;
    const fix = majority === 'type'
      ? { start: s.star.start - 1, end: s.star.end + 0, text: '* ' }
      : { start: s.star.start, end: s.star.end + 1, text: ' *' };
    // keep precise: remove whitespace on one side, add on the other
    const ws = majority === 'type'
      ? { start: wsStart(text, s.star.start), end: s.star.end, text: '* ' }
      : { start: s.star.start, end: wsEnd(text, s.star.end), text: ' *' };
    void fix;
    ctx.reportTok('pointer-style', s.star, `Inconsistent pointer star position - this file mostly uses ${majority === 'type' ? '"int* name"' : '"int *name"'}.`,
      { title: 'Use the same pointer style as the rest of the file', edits: [majority === 'type'
        ? { start: ws.start, end: ws.end, text: '* ' }
        : { start: ws.start, end: ws.end, text: ' *' }], layout: true });
  }
}
function wsStart(text, i) { while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--; return i; }
function wsEnd(text, i) { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; return i; }

// ------------------------------------------------------------------------------------------------ comments
const CODE_COMMENT_RES = [
  /;\s*$/,
  /^\s*[{}]\s*;?\s*$/,
  /^\s*(if|for|while|switch)\s*\(.*\)\s*\{?\s*$/,
  /^\s*(else|do)\s*\{?\s*$/,
  /^\s*(int|char|float|double|long|short|unsigned|void|bool|size_t|FILE|struct\s+\w+)\b[\s*]+\w+\s*(\[.*\])?\s*(=.*)?[;{(]?\s*$/,
  /^\s*(return|printf|scanf|free|malloc|fclose|fopen|strcpy|strcat)\b\s*[(;].*$/,
  /^\s*[A-Za-z_]\w*(\[[^\]]*\]|->\w+|\.\w+)*\s*([+\-*/%]?=|\+\+|--)\s*[^=]*;?\s*$/,
  /^\s*#\s*(include|define)\b/,
];
const GERMAN_RE = /[äöüÄÖÜß]|\b(und|oder|nicht|ist|das|der|die|wenn|dann|mit|für|fuer|eine?|wird|werden|zahl|ausgabe|eingabe|speicher|zeile|benutzer|schleife|prüfen|pruefen)\b/i;

function looksLikeCode(content) {
  const c = content.trim();
  if (!c || c.length < 3) return false;
  if (/^[A-Z][a-z].*[a-z]\.$/.test(c) && !/[;{}=()]/.test(c)) return false; // sentence
  if (/^(TODO|NOTE|FIXME|HACK)\b/i.test(c)) return false;
  return CODE_COMMENT_RES.some((re) => re.test(c));
}

function checkComments(ctx) {
  const { lexed } = ctx;
  let group = null;
  const flush = () => {
    if (group) {
      ctx.report('commented-code', group.start, group.end, 'Commented-out code is not allowed in the final submission - remove it.',
        { title: 'Remove commented-out code', edits: [{ start: group.lineStart, end: group.lineEnd, text: '' }] });
    }
    group = null;
  };
  let lastLine = -2;
  for (const c of lexed.comments) {
    if (GERMAN_RE.test(c.text) && !/^\s*\/\/-+\s*$/.test(c.text)) {
      ctx.report('english-only', c.start, c.end, 'Comments (and the source code) must be written in English.');
    }
    if (c.kind === 'line' && (c.text.startsWith('///') || H.isDashLine(c.text))) { flush(); continue; }
    const contents = c.kind === 'line' ? [c.text.slice(2)] : c.text.replace(/^\/\*+|\*+\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*?/, ''));
    const isCode = contents.some((l) => looksLikeCode(l));
    if (!isCode) { flush(); lastLine = c.endLine; continue; }
    const own = c.ownLine;
    const ls = ctx.lineStarts[c.line];
    const lineStart = own ? ls : c.start;
    const nextLs = ctx.lineStarts[c.endLine + 1];
    const lineEnd = own ? (nextLs !== undefined ? nextLs : ctx.text.length) : c.end;
    const trimStart = own ? lineStart : wsStart(ctx.text, c.start);
    if (group && own && c.line === lastLine + 1 && group.own) {
      group.end = c.end;
      group.lineEnd = lineEnd;
    } else {
      flush();
      group = { start: c.start, end: c.end, lineStart: trimStart, lineEnd, own };
    }
    lastLine = c.endLine;
    if (!own) flush();
  }
  flush();
}

module.exports = { analyze, DEFAULTS, C17_HEADERS, toSnake, toCamel, toUpper, toPascal };
