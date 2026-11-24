'use strict';
// Small C lexer: produces code tokens, comments and preprocessor directives with
// line/column/offset information. Good enough for style analysis (not a compiler).

const PUNCTUATORS = [
  '<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '##',
  '[', ']', '(', ')', '{', '}', '.', '&', '*', '+', '-', '~', '!', '/', '%', '<', '>',
  '^', '|', '?', ':', ';', '=', ',', '#',
];

function lex(text) {
  const tokens = [];      // code tokens
  const comments = [];    // { kind: 'line'|'block', text, start, end, line, endLine, col }
  const directives = [];  // { text, start, end, line, endLine }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  let line = 0;
  let lineStart = 0;
  let i = 0;
  const n = text.length;
  let atLineStart = true; // only whitespace seen so far on this line

  function newline(pos) {
    line++;
    lineStart = pos + 1;
    atLineStart = true;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\n') { newline(i); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }

    // Comments
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      comments.push({ kind: 'line', text: text.slice(start, i), start, end: i, line, endLine: line,
        col: start - lineStart, ownLine: atLineStart });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      const startLine = line;
      const col = start - lineStart;
      const own = atLineStart;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      i = Math.min(n, i + 2);
      comments.push({ kind: 'block', text: text.slice(start, i), start, end: i, line: startLine,
        endLine: line, col, ownLine: own });
      continue;
    }

    // Preprocessor directive (only at start of line)
    if (c === '#' && atLineStart) {
      const start = i;
      const startLine = line;
      while (i < n) {
        if (text[i] === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
          i += text[i + 1] === '\r' ? 3 : 2;
          line++; lineStart = i;
          continue;
        }
        if (text[i] === '\n') break;
        // a comment inside a directive ends the directive text for our purposes
        if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break;
        i++;
      }
      directives.push({ text: text.slice(start, i).trimEnd(), start, end: i, line: startLine, endLine: line,
        col: start - lineStart });
      atLineStart = false;
      continue;
    }

    atLineStart = false;
    const start = i;
    const col = i - lineStart;

    // Identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      tokens.push({ type: 'id', value: text.slice(start, i), start, end: i, line, col });
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      while (i < n) {
        const ch = text[i];
        if (/[0-9A-Za-z_.]/.test(ch)) { i++; continue; }
        if ((ch === '+' || ch === '-') && /[eEpP]/.test(text[i - 1]) && !/^0[xX][0-9a-fA-F]*$/.test(text.slice(start, i - 1))) { i++; continue; }
        if ((ch === '+' || ch === '-') && /[pP]/.test(text[i - 1])) { i++; continue; }
        break;
      }
      tokens.push({ type: 'num', value: text.slice(start, i), start, end: i, line, col });
      continue;
    }
    // String / char literals (with optional prefix handled by id path above, fine)
    if (c === '"' || c === '\'') {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      i = Math.min(n, i + 1);
      tokens.push({ type: quote === '"' ? 'str' : 'char', value: text.slice(start, i), start, end: i, line, col });
      continue;
    }
    // Punctuators
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (text.startsWith(p, i)) { matched = p; break; }
    }
    if (!matched) matched = c;
    i += matched.length;
    tokens.push({ type: 'punct', value: matched, start, end: i, line, col });
  }

  for (let k = 0; k < tokens.length; k++) tokens[k].index = k;
  return { tokens, comments, directives, lineStarts };
}

module.exports = { lex };
