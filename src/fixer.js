'use strict';
// Applies auto-fixes repeatedly until the text is stable (pure, used by "Fix all" and tests).
const { analyze } = require('./analyzer');

const NOT_IN_FIX_ALL = new Set(['commented-code']);

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// pick a non-overlapping subset of fixes
function selectFixes(diagnostics, filter) {
  const chosen = [];
  const taken = [];
  const overlaps = (e) => taken.some((t) => e.start < t.end && t.start < e.end || (e.start === e.end && e.start === t.start) ||
    (t.start === t.end && t.start === e.start));
  for (const d of diagnostics) {
    if (!d.fix || !filter(d)) continue;
    const edits = d.fix.edits;
    if (edits.some(overlaps)) continue;
    edits.forEach((e) => taken.push(e));
    chosen.push(...edits);
    if (d.fix.rename) break; // renames touch many places: one per round
  }
  return chosen;
}

function fixAll(text, options, opts) {
  const includeRenames = !!(opts && opts.includeRenames);
  const filter = (d) => !NOT_IN_FIX_ALL.has(d.rule) && (includeRenames || !d.fix.rename) &&
    !(opts && opts.only && !opts.only(d));
  let current = text;
  for (let round = 0; round < 40; round++) {
    const { diagnostics } = analyze(current, options);
    const edits = selectFixes(diagnostics, filter);
    if (!edits.length) break;
    const next = applyEdits(current, edits);
    if (next === current) break;
    current = next;
  }
  return current;
}

module.exports = { fixAll, applyEdits, selectFixes };
