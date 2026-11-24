'use strict';
// File / function header handling following the course (Doxygen based) scheme:
//
// //----------------------------------------------------------------------------------------------------------------------
// /// @brief This is an example header comment. Here, you explain, what the function does.
// /// @param numbers an array to check
// /// @return the highest number

const DASH_LINE = '//' + '-'.repeat(118); // 120 characters, exactly like the template
const DASH_RE = /^\s*\/\/-{3,}\s*$/;
const PLACEHOLDER_RE = /\bTODO\b|<Explanation of the program|<\.\.\. May have multiple lines\.>|<matriculation number>/i;

function isDashLine(line) {
  return DASH_RE.test(line);
}

function fileHeaderLines(author, explanation) {
  return [
    DASH_LINE,
    `/// ${explanation || 'TODO: Explain what this program does.'}`,
    '///',
    `/// Author: ${author || '<matriculation number>'}`,
    DASH_LINE,
  ];
}

// Check the header at the very top of the file.
// returns { ok, problems: [string], range: {startLine, endLine} | null }
function checkFileHeader(lines) {
  let first = 0;
  const problems = [];
  if (!lines.length || !isDashLine(lines[first] || '')) {
    return { present: false, problems: ['The file must start with the file header comment (dash line, explanation, Author).'] };
  }
  let end = -1;
  for (let l = first + 1; l < Math.min(lines.length, first + 60); l++) {
    if (isDashLine(lines[l])) { end = l; break; }
    if (!/^\s*\/\//.test(lines[l])) break;
  }
  if (end < 0) {
    return { present: true, startLine: first, endLine: first, problems: ['The file header must be closed with a //---- dash line.'] };
  }
  const body = lines.slice(first + 1, end);
  let hasAuthor = false;
  let hasExplanation = false;
  let placeholder = false;
  let badPrefix = false;
  for (const l of body) {
    if (!/^\s*\/\/\//.test(l)) badPrefix = true;
    const content = l.replace(/^\s*\/\/\/?\s?/, '');
    if (/^\s*Author:\s*\S+/.test(content)) hasAuthor = true;
    else if (content.trim()) hasExplanation = true;
    if (PLACEHOLDER_RE.test(content)) placeholder = true;
  }
  if (!hasExplanation) problems.push('The file header needs an explanation of the program.');
  if (!hasAuthor) problems.push('The file header needs an "/// Author: <matriculation number>" line.');
  if (badPrefix) problems.push('Lines inside the file header must start with "///".');
  return { present: true, startLine: first, endLine: end, problems, placeholder };
}

// Find the comment block directly above a function definition.
// Returns { startLine, endLine, lines } or null.
function findHeaderAbove(lines, fnLine) {
  let l = fnLine - 1;
  const collected = [];
  while (l >= 0) {
    const text = lines[l];
    if (!/^\s*\/\//.test(text)) break;
    collected.unshift(text);
    if (isDashLine(text)) break; // the dash line starts the header
    l--;
  }
  if (!collected.length) return null;
  const startLine = fnLine - collected.length;
  // A dash line that closes the *file* header is not a function header.
  if (collected.length === 1 && isDashLine(collected[0]) && startLine > 0 && /^\s*\/\/\//.test(lines[startLine - 1] || '')) {
    return null;
  }
  return { startLine, endLine: fnLine - 1, lines: collected };
}

function parseHeader(headerLines) {
  const result = { hasDash: false, brief: null, params: new Map(), paramOrder: [], ret: null, other: [], hasDocLines: false };
  let current = null;
  for (const raw of headerLines) {
    if (isDashLine(raw)) { result.hasDash = true; continue; }
    const m = /^\s*\/\/\/(.*)$/.exec(raw);
    if (!m) { result.other.push(raw.trim()); continue; }
    result.hasDocLines = true;
    const content = m[1].replace(/^ /, '');
    let t;
    if ((t = /^\s*[@\\]brief\b\s?(.*)$/.exec(content))) {
      result.brief = [t[1]];
      current = result.brief;
    } else if ((t = /^\s*[@\\]param(?:\[[a-z,]+\])?\s+([A-Za-z_][A-Za-z0-9_]*|\.\.\.)\s?(.*)$/.exec(content))) {
      const arr = [t[2]];
      result.params.set(t[1], arr);
      result.paramOrder.push(t[1]);
      current = arr;
    } else if ((t = /^\s*[@\\]returns?\b\s?(.*)$/.exec(content))) {
      result.ret = [t[1]];
      current = result.ret;
    } else if (current) {
      current.push(content); // continuation line
    } else if (content.trim()) {
      // text without @brief: treat as brief
      result.brief = [content];
      current = result.brief;
    }
  }
  return result;
}

function headerProblems(parsed, fn) {
  const problems = [];
  if (!parsed.hasDash) problems.push('missing the //---- separator line at the top');
  if (!parsed.brief || !parsed.brief.join(' ').trim()) problems.push('missing @brief description');
  const actual = fn.params.filter((p) => p.name).map((p) => p.name);
  const missing = actual.filter((n) => !parsed.params.has(n));
  const extra = parsed.paramOrder.filter((n) => !actual.includes(n));
  if (missing.length) problems.push(`missing @param ${missing.join(', ')}`);
  if (extra.length) problems.push(`@param ${extra.join(', ')} does not exist`);
  if (!missing.length && !extra.length && actual.join(',') !== parsed.paramOrder.join(',')) {
    problems.push('@param order does not match the parameter list');
  }
  for (const n of actual) {
    const d = parsed.params.get(n);
    if (d && !d.join(' ').trim()) problems.push(`@param ${n} has no description`);
  }
  if (!fn.isVoid && !parsed.ret) problems.push('missing @return (function does not return void)');
  if (fn.isVoid && parsed.ret) problems.push('@return documented although the function returns void');
  if (parsed.ret && !fn.isVoid && !parsed.ret.join(' ').trim()) problems.push('@return has no description');
  return problems;
}

function hasPlaceholder(headerLines) {
  return headerLines.some((l) => PLACEHOLDER_RE.test(l));
}

// Build header lines for a function, keeping existing descriptions where possible.
function functionHeaderLines(fn, parsed) {
  const out = [DASH_LINE];
  const brief = parsed && parsed.brief && parsed.brief.join('').trim() ? parsed.brief : [`TODO: Explain what ${fn.name} does.`];
  out.push(`/// @brief ${brief[0]}`.trimEnd());
  for (const extra of brief.slice(1)) out.push(`/// ${extra}`.trimEnd());
  for (const p of fn.params) {
    if (!p.name) continue;
    const desc = parsed && parsed.params.get(p.name) ? parsed.params.get(p.name) : ['TODO'];
    out.push(`/// @param ${p.name} ${desc[0]}`.trimEnd());
    for (const extra of desc.slice(1)) out.push(`/// ${extra}`.trimEnd());
  }
  if (!fn.isVoid) {
    const desc = parsed && parsed.ret && parsed.ret.join('').trim() ? parsed.ret : ['TODO'];
    out.push(`/// @return ${desc[0]}`.trimEnd());
    for (const extra of desc.slice(1)) out.push(`/// ${extra}`.trimEnd());
  }
  return out;
}

// VS Code snippet version (tab stops) for interactive insertion.
function functionHeaderSnippet(fn, indent) {
  const esc = (s) => s.replace(/[$}\\]/g, '\\$&');
  let n = 1;
  const lines = [DASH_LINE, `/// @brief \${${n++}:${esc(`Explain what ${fn.name} does.`)}}`];
  for (const p of fn.params) {
    if (!p.name) continue;
    lines.push(`/// @param ${esc(p.name)} \${${n++}:${esc(`description of ${p.name}`)}}`);
  }
  if (!fn.isVoid) lines.push(`/// @return \${${n++}:description of the return value}`);
  return lines.map((l) => indent + l).join('\n');
}

function fileHeaderSnippet(author) {
  const esc = (s) => s.replace(/[$}\\]/g, '\\$&');
  return [
    DASH_LINE,
    '/// ${1:Explanation of the program ...}',
    '///',
    `/// Author: \${2:${esc(author || 'matriculation number')}}`,
    DASH_LINE,
    '',
    '$0',
  ].join('\n');
}

module.exports = {
  DASH_LINE, isDashLine, fileHeaderLines, checkFileHeader, findHeaderAbove, parseHeader, headerProblems,
  functionHeaderLines, functionHeaderSnippet, fileHeaderSnippet, hasPlaceholder, PLACEHOLDER_RE,
};
