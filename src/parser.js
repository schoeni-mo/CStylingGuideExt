'use strict';
// Lightweight structural parser for C on top of the token stream.

const TYPE_KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'bool',
  '_Complex', '_Imaginary',
]);
const QUALIFIERS = new Set([
  'const', 'volatile', 'restrict', 'static', 'extern', 'inline', 'register', 'auto', '_Atomic',
  '_Thread_local', '_Noreturn', '_Alignas',
]);
const TAG_KEYWORDS = new Set(['struct', 'union', 'enum']);
const STD_TYPEDEFS = new Set([
  'size_t', 'ssize_t', 'ptrdiff_t', 'FILE', 'fpos_t', 'time_t', 'clock_t', 'wchar_t', 'wint_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'intptr_t', 'uintptr_t', 'intmax_t', 'uintmax_t', 'va_list', 'jmp_buf', 'div_t', 'ldiv_t',
  'max_align_t', 'char16_t', 'char32_t', 'mbstate_t', 'sig_atomic_t', 'errno_t', 'bool',
  'int_least8_t', 'int_fast8_t', 'uint_least8_t', 'uint_fast8_t', 'thrd_t', 'mtx_t', 'cnd_t',
]);
const CONTROL_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'switch']);
const STATEMENT_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return', 'break', 'continue',
  'goto', 'sizeof', 'typedef',
]);

function matchBrackets(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const t of tokens) {
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') {
      stack.push(t.index);
    } else if (pairs[t.value]) {
      // pop until we find the matching opener (tolerate broken code)
      for (let s = stack.length - 1; s >= 0; s--) {
        if (tokens[stack[s]].value === pairs[t.value]) {
          match[t.index] = stack[s];
          match[stack[s]] = t.index;
          stack.length = s;
          break;
        }
      }
    }
  }
  return match;
}

class Parser {
  constructor(lexed) {
    this.tokens = lexed.tokens;
    this.comments = lexed.comments;
    this.directives = lexed.directives;
    this.lineStarts = lexed.lineStarts;
    this.match = matchBrackets(this.tokens);
    this.typeNames = new Set(STD_TYPEDEFS);
    this.functions = [];      // definitions + prototypes
    this.globals = [];        // file-scope declarators that are variables/constants
    this.typedefs = [];       // { name, tok, kind }
    this.tags = [];           // { name, tok, kind } struct/enum/union tags at definitions
    this.members = [];        // struct/union member declarators { name, tok }
    this.enumerators = [];    // { name, tok }
    this.defines = [];        // { name, line, col, start, end, value, directive }
    this.includes = [];       // { name, system, directive }
    this.braceKind = new Map(); // index of '{' -> 'function'|'struct'|'enum'|'init'|'block'
  }

  isTypeStart(i) {
    const t = this.tokens[i];
    if (!t || t.type !== 'id') return false;
    return TYPE_KEYWORDS.has(t.value) || QUALIFIERS.has(t.value) || TAG_KEYWORDS.has(t.value) ||
      this.typeNames.has(t.value);
  }

  // Heuristic: identifier that is probably a type (e.g. from a header we cannot see):
  // PascalCase followed by '*' or another identifier.
  looksLikeType(i) {
    const t = this.tokens[i];
    if (!t || t.type !== 'id') return false;
    if (this.isTypeStart(i)) return true;
    const next = this.tokens[i + 1];
    if (!next) return false;
    if (/^[A-Z][a-z0-9]*[A-Z]?[A-Za-z0-9]*$/.test(t.value) && /[a-z]/.test(t.value)) {
      if (next.type === 'id') return true;
      if (next.value === '*' && this.tokens[i + 2] && (this.tokens[i + 2].type === 'id' || this.tokens[i + 2].value === '*' || this.tokens[i + 2].value === ')')) return true;
    }
    return false;
  }

  parse() {
    this.parseDirectives();
    this.collectTypedefNamesFirstPass();
    this.parseTopLevel(0, this.tokens.length, true);
    return this;
  }

  parseDirectives() {
    for (const d of this.directives) {
      let m = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\(?)/.exec(d.text);
      if (m) {
        const nameOffset = d.text.indexOf(m[1], d.text.indexOf('define') + 6);
        this.defines.push({ name: m[1], functionLike: m[2] === '(', start: d.start + nameOffset,
          end: d.start + nameOffset + m[1].length, directive: d });
        continue;
      }
      m = /^#\s*include\s*([<"])([^>"]+)[>"]/.exec(d.text);
      if (m) this.includes.push({ name: m[2].trim(), system: m[1] === '<', directive: d });
    }
  }

  // collect typedef names early so declarations before/after can use them
  collectTypedefNamesFirstPass() {
    const tk = this.tokens;
    for (let i = 0; i < tk.length; i++) {
      if (tk[i].value !== 'typedef') continue;
      // find terminating ';' at same depth
      let j = i + 1;
      let lastId = null;
      let depth = 0;
      for (; j < tk.length; j++) {
        const v = tk[j].value;
        if (v === '{' || v === '(' || v === '[') {
          if (v === '(' && tk[j + 1] && tk[j + 1].value === '*' && tk[j + 2] && tk[j + 2].type === 'id') {
            lastId = tk[j + 2]; // function pointer typedef
          }
          depth++;
          continue;
        }
        if (v === '}' || v === ')' || v === ']') { depth--; continue; }
        if (depth === 0 && v === ';') break;
        if (depth === 0 && tk[j].type === 'id') lastId = tk[j];
      }
      if (lastId) this.typeNames.add(lastId.value);
    }
  }

  // Parse a range of tokens that forms a sequence of top-level declarations.
  parseTopLevel(from, to) {
    const tk = this.tokens;
    let i = from;
    while (i < to) {
      const stmtStart = i;
      let j = i;
      let fnDef = null;
      // advance to the end of this declaration
      while (j < to) {
        const t = tk[j];
        if (t.value === ';') break;
        if (t.value === '(' || t.value === '[') { j = Math.max(j, this.match[j]); j++; continue; }
        if (t.value === '{') {
          const prev = tk[j - 1];
          if (prev && prev.value === ')' && !this.statementHas(stmtStart, j, '=')) {
            fnDef = j;
            break;
          }
          this.classifyBrace(stmtStart, j);
          this.parseAggregate(stmtStart, j);
          j = this.match[j] >= 0 ? this.match[j] + 1 : to;
          continue;
        }
        if (t.value === '}') break; // stray
        j++;
      }
      if (fnDef !== null) {
        const fn = this.parseFunctionSignature(stmtStart, fnDef, true);
        const close = this.match[fnDef] >= 0 ? this.match[fnDef] : to - 1;
        if (fn) {
          fn.openBrace = fnDef;
          fn.closeBrace = close;
          this.functions.push(fn);
        }
        this.braceKind.set(fnDef, 'function');
        this.markInnerBraces(fnDef + 1, close);
        i = close + 1;
        continue;
      }
      // declaration ending in ';' (or EOF)
      this.parseFileScopeDeclaration(stmtStart, j);
      i = j + 1;
    }
  }

  statementHas(from, to, value) {
    for (let k = from; k < to; k++) {
      if (this.tokens[k].value === value) return true;
      if (this.tokens[k].value === '(' || this.tokens[k].value === '[') k = Math.max(k, this.match[k]);
    }
    return false;
  }

  classifyBrace(stmtStart, braceIdx) {
    const tk = this.tokens;
    let kind = 'block';
    for (let k = braceIdx - 1; k >= stmtStart; k--) {
      const v = tk[k].value;
      if (v === '=' || v === ',' || v === '{' || v === '(' || v === 'return') { kind = 'init'; break; }
      if (v === 'struct' || v === 'union') { kind = 'struct'; break; }
      if (v === 'enum') { kind = 'enum'; break; }
      if (v === ';' || v === '}') break;
    }
    if (tk[braceIdx - 1] && tk[braceIdx - 1].value === ')' && kind === 'init') {
      // compound literal (Type){...} or call argument
      kind = 'init';
    }
    this.braceKind.set(braceIdx, kind);
    if (kind === 'init' || kind === 'enum') {
      const close = this.match[braceIdx];
      for (let k = braceIdx + 1; k < close; k++) {
        if (tk[k].value === '{') this.braceKind.set(k, 'init');
      }
    }
    return kind;
  }

  // struct/union/enum definitions: collect tag, members/enumerators
  parseAggregate(stmtStart, braceIdx) {
    const tk = this.tokens;
    const kind = this.braceKind.get(braceIdx);
    if (kind !== 'struct' && kind !== 'enum') return;
    const close = this.match[braceIdx];
    const prev = tk[braceIdx - 1];
    if (prev && prev.type === 'id' && !TAG_KEYWORDS.has(prev.value)) {
      this.tags.push({ name: prev.value, tok: prev, kind: tk[braceIdx - 2] ? tk[braceIdx - 2].value : 'struct' });
    }
    if (close < 0) return;
    if (kind === 'enum') {
      let expectName = true;
      let depth = 0;
      for (let k = braceIdx + 1; k < close; k++) {
        const v = tk[k].value;
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') depth--;
        else if (depth === 0 && v === ',') { expectName = true; continue; }
        if (expectName && tk[k].type === 'id' && depth === 0) {
          this.enumerators.push({ name: tk[k].value, tok: tk[k] });
          expectName = false;
        }
      }
      return;
    }
    // struct/union members
    let k = braceIdx + 1;
    while (k < close) {
      let end = k;
      while (end < close && tk[end].value !== ';') {
        if (tk[end].value === '{') {
          this.classifyBrace(k, end);
          this.parseAggregate(k, end);
          end = this.match[end] >= 0 ? this.match[end] : close;
        } else if (tk[end].value === '(' || tk[end].value === '[') {
          end = Math.max(end, this.match[end]);
        }
        end++;
      }
      const decl = this.parseDeclarators(k, end);
      if (decl) for (const d of decl.declarators) this.members.push(d);
      k = end + 1;
    }
  }

  markInnerBraces(from, to) {
    const tk = this.tokens;
    let stmtStart = from;
    for (let k = from; k < to; k++) {
      const v = tk[k].value;
      if (v === '{' && !this.braceKind.has(k)) {
        // look back to the start of the current statement
        let s = k - 1;
        while (s >= from && tk[s].value !== ';' && tk[s].value !== '{' && tk[s].value !== '}' &&
          !(tk[s].value === ')' && this.isControlParen(s))) s--;
        const kind = this.classifyBrace(s + 1, k);
        if (kind === 'struct' || kind === 'enum') this.parseAggregate(s + 1, k);
      }
      if (v === ';' || v === '}') stmtStart = k + 1;
    }
    return stmtStart;
  }

  isControlParen(closeIdx) {
    const open = this.match[closeIdx];
    if (open < 1) return false;
    const kw = this.tokens[open - 1];
    return kw && (kw.value === 'if' || kw.value === 'for' || kw.value === 'while' || kw.value === 'switch');
  }

  // Returns function object for tokens [from, to) where to is '{' or ';'
  parseFunctionSignature(from, to, isDefinition) {
    const tk = this.tokens;
    // find the first identifier followed by '(' at depth 0
    let nameIdx = -1;
    for (let k = from; k < to; k++) {
      if (tk[k].type === 'id' && tk[k + 1] && tk[k + 1].value === '(') {
        if (TYPE_KEYWORDS.has(tk[k].value) || QUALIFIERS.has(tk[k].value)) continue;
        nameIdx = k;
        break;
      }
      if (tk[k].value === '(') k = Math.max(k, this.match[k]);
    }
    if (nameIdx < 0) return null;
    const open = nameIdx + 1;
    const close = this.match[open];
    if (close < 0 || close >= to + 1) return null;
    const retTokens = tk.slice(from, nameIdx);
    const retClean = retTokens.filter((t) => !QUALIFIERS.has(t.value));
    const isVoid = retClean.length === 1 && retClean[0].value === 'void';
    const params = this.parseParams(open, close);
    return {
      name: tk[nameIdx].value, nameTok: tk[nameIdx], startTok: from, nameIdx, parenOpen: open, parenClose: close,
      returnType: retTokens.map((t) => t.value).join(' '), isVoid, params, isDefinition,
      isStatic: retTokens.some((t) => t.value === 'static'),
    };
  }

  parseParams(open, close) {
    const tk = this.tokens;
    const params = [];
    let segStart = open + 1;
    const segments = [];
    for (let k = open + 1; k <= close; k++) {
      if (k === close || (tk[k].value === ',')) {
        segments.push([segStart, k]);
        segStart = k + 1;
        continue;
      }
      if (tk[k].value === '(' || tk[k].value === '[' || tk[k].value === '{') k = Math.max(k, this.match[k]);
    }
    for (const [a, b] of segments) {
      if (b <= a) continue;
      if (b - a === 1 && tk[a].value === 'void') continue;
      if (tk[a].value === '...') { params.push({ name: '...', tok: tk[a], variadic: true, from: a, to: b }); continue; }
      let nameTok = null;
      // function pointer: ( * name )
      for (let k = a; k < b; k++) {
        if (tk[k].value === '(' && tk[k + 1] && tk[k + 1].value === '*' && tk[k + 2] && tk[k + 2].type === 'id') {
          nameTok = tk[k + 2];
          break;
        }
      }
      if (!nameTok) {
        for (let k = a; k < b; k++) {
          if (tk[k].value === '[') break;
          if (tk[k].type === 'id' && !TYPE_KEYWORDS.has(tk[k].value) && !QUALIFIERS.has(tk[k].value) &&
            !TAG_KEYWORDS.has(tk[k].value)) {
            nameTok = tk[k];
          }
        }
        // a lone type name (e.g. prototype "int f(Human*)") is not a parameter name
        if (nameTok) {
          const before = tk.slice(a, nameTok.index).filter((t) => t.type === 'id' && !QUALIFIERS.has(t.value));
          if (before.length === 0) nameTok = null;
        }
      }
      params.push({ name: nameTok ? nameTok.value : null, tok: nameTok, from: a, to: b });
    }
    return params;
  }

  parseFileScopeDeclaration(from, to) {
    const tk = this.tokens;
    if (from >= to) return;
    if (tk[from].value === 'typedef') {
      this.parseTypedef(from, to);
      return;
    }
    // prototype?
    const fn = this.parseFunctionSignature(from, to, false);
    const decl = this.parseDeclarators(from, to);
    if (fn && decl && decl.declarators.length && decl.declarators[0].isFunction) {
      fn.prototypeEnd = to;
      this.functions.push(fn);
      return;
    }
    if (!decl) return;
    for (const d of decl.declarators) {
      if (d.isFunction) continue;
      d.isConst = decl.isConst || d.constPointer;
      d.isExtern = decl.specifiers.includes('extern');
      d.isStatic = decl.specifiers.includes('static');
      this.globals.push(d);
    }
  }

  parseTypedef(from, to) {
    const tk = this.tokens;
    // typedef name(s): identifiers at depth 0 after the type part
    let depth = 0;
    let lastId = null;
    let kind = 'type';
    for (let k = from + 1; k < to; k++) {
      const v = tk[k].value;
      if (k === from + 1 && TAG_KEYWORDS.has(v)) kind = v;
      if (v === '(' && tk[k + 1] && tk[k + 1].value === '*' && tk[k + 2] && tk[k + 2].type === 'id' && depth === 0) {
        lastId = tk[k + 2];
        kind = 'function pointer';
      }
      if (v === '{' || v === '(' || v === '[') { k = Math.max(k, this.match[k]); continue; }
      if (depth === 0 && v === ',') {
        if (lastId) this.typedefs.push({ name: lastId.value, tok: lastId, kind });
        lastId = null;
        continue;
      }
      if (tk[k].type === 'id' && k > from + 1 && !(TAG_KEYWORDS.has(tk[k - 1].value)) &&
        !TYPE_KEYWORDS.has(v) && !QUALIFIERS.has(v)) {
        lastId = tk[k];
      }
    }
    if (lastId) {
      this.typedefs.push({ name: lastId.value, tok: lastId, kind });
      this.typeNames.add(lastId.value);
    }
  }

  // Parse "specifiers declarator (= init)?, declarator ..." in [from, to).
  // Returns null if it does not look like a declaration.
  parseDeclarators(from, to) {
    const tk = this.tokens;
    let k = from;
    const specifiers = [];
    let sawType = false;
    let isConst = false;
    while (k < to) {
      const t = tk[k];
      if (t.type !== 'id') break;
      if (QUALIFIERS.has(t.value)) { specifiers.push(t.value); if (t.value === 'const') isConst = true; k++; continue; }
      if (TYPE_KEYWORDS.has(t.value)) { sawType = true; specifiers.push(t.value); k++; continue; }
      if (TAG_KEYWORDS.has(t.value)) {
        sawType = true;
        specifiers.push(t.value);
        k++;
        if (tk[k] && tk[k].type === 'id') { specifiers.push(tk[k].value); k++; }
        if (tk[k] && tk[k].value === '{') k = this.match[k] + 1;
        continue;
      }
      if (!sawType && (this.typeNames.has(t.value) || this.looksLikeType(k))) {
        sawType = true; specifiers.push(t.value); k++; continue;
      }
      break;
    }
    if (!sawType || k >= to) return null;
    const declarators = [];
    let segStart = k;
    const segs = [];
    for (let m = k; m <= to; m++) {
      if (m === to || tk[m].value === ',') { segs.push([segStart, m]); segStart = m + 1; continue; }
      if (tk[m].value === '(' || tk[m].value === '[' || tk[m].value === '{') m = Math.max(m, this.match[m]);
    }
    for (const [a, b] of segs) {
      let m = a;
      let pointer = 0;
      let constPointer = false;
      const stars = [];
      while (m < b && (tk[m].value === '*' || tk[m].value === 'const' || tk[m].value === 'restrict' || tk[m].value === 'volatile')) {
        if (tk[m].value === '*') { pointer++; stars.push(tk[m]); constPointer = false; }
        if (tk[m].value === 'const' && pointer) constPointer = true;
        m++;
      }
      let nameTok = null;
      let isFunction = false;
      if (tk[m] && tk[m].value === '(' && tk[m + 1] && tk[m + 1].value === '*') {
        // function pointer variable
        let q = m + 1;
        while (tk[q] && tk[q].value === '*') q++;
        if (tk[q] && tk[q].type === 'id') nameTok = tk[q];
      } else if (tk[m] && tk[m].type === 'id') {
        nameTok = tk[m];
        if (tk[m + 1] && tk[m + 1].value === '(') isFunction = true;
      }
      if (!nameTok) continue;
      let initStart = -1;
      for (let q = m; q < b; q++) if (tk[q].value === '=') { initStart = q; break; }
      declarators.push({ name: nameTok.value, tok: nameTok, pointer, constPointer, isFunction, stars,
        typeEndTok: tk[a - 1], initStart, segEnd: b, isArray: tk[m + 1] && tk[m + 1].value === '[' });
    }
    if (!declarators.length) return null;
    return { specifiers, isConst, declarators, typeEnd: k, segments: segs };
  }
}

function parse(lexed) {
  return new Parser(lexed).parse();
}

module.exports = { parse, Parser, TYPE_KEYWORDS, QUALIFIERS, TAG_KEYWORDS, CONTROL_KEYWORDS, STATEMENT_KEYWORDS };
