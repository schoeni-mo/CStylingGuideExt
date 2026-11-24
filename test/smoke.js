'use strict';
// Loads extension.js against a minimal mocked vscode API and exercises the main code paths.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const registered = {};
const collections = {};
const settings = { enable: true, matriculationNumber: '12345678', autoFileHeader: true, headersOnSave: true, compileOnSave: false,
  checkGitIdentity: false, rules: {}, maxLineLength: 120, maxFunctionLines: 70, maxParameters: 6, warnNestingDepth: 4,
  maxNestingDepth: 6, mainMaxLines: 30, allowedNumbers: [0, 1], 'compiler.path': 'clang', 'compiler.args': ['-Wall'] };
class Position { constructor(l, c) { this.line = l; this.character = c; } translate(a, b) { return new Position(this.line + a, this.character + b); } }
class Range { constructor(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } }
class Kind { constructor(v) { this.value = v; } append(x) { return new Kind(this.value + '.' + x); } contains(o) { return o.value.startsWith(this.value); } }
const vscode = {
  Position, Range,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DiagnosticTag: { Unnecessary: 1 },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
  CodeActionKind: { QuickFix: new Kind('quickfix'), SourceFixAll: new Kind('source.fixAll') },
  CompletionItem: class { constructor(label) { this.label = label; } },
  CompletionItemKind: { Snippet: 1 },
  SnippetString: class { constructor(v) { this.value = v; } appendText(t) { this.value += t; } },
  MarkdownString: class { constructor(v) { this.value = v; } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ range, text }); } },
  TextEdit: { replace: (range, text) => ({ range, text }) },
  TextDocumentSaveReason: { Manual: 1 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: { openExternal() {} },
  languages: {
    createDiagnosticCollection(name) {
      const map = new Map();
      const c = { name, set: (u, d) => map.set(u.toString(), d), get: (u) => map.get(u.toString()), delete: (u) => map.delete(u.toString()), dispose() {} };
      collections[name] = c; return c;
    },
    registerCodeActionsProvider(sel, p) { registered.codeActions = p; return { dispose() {} }; },
    registerCompletionItemProvider(sel, p) { registered.completion = p; return { dispose() {} }; },
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [],
    createStatusBarItem: () => ({ show() { this.shown = true; }, hide() {}, dispose() {} }),
    showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  workspace: {
    textDocuments: [], workspaceFolders: undefined,
    getConfiguration: () => ({ get: (k) => settings[k], update: async (k, v) => { settings[k] = v; } }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onWillSaveTextDocument: (fn) => { registered.willSave = fn; return { dispose() {} }; },
    onDidSaveTextDocument: () => ({ dispose() {} }),
    applyEdit: async () => true,
  },
  commands: {
    registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; },
    registerTextEditorCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : origLoad.call(this, request, ...rest); };

function makeDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return {
    uri: { scheme: 'file', toString: () => 'file://' + file }, fileName: file, languageId: 'c', isDirty: false,
    getText: () => text, lineCount: starts.length,
    lineAt: (l) => ({ text: text.slice(starts[l], (starts[l + 1] || text.length + 1) - 1) }),
    positionAt: (o) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return new Position(l, o - starts[l]); },
    getWordRangeAtPosition: () => undefined,
  };
}

const ext = require('../extension');
const doc = makeDoc(path.join(__dirname, 'fixtures', 'bad.c'));
vscode.workspace.textDocuments.push(doc);
const context = { subscriptions: [] };
ext.activate(context);

const diags = collections['c-style'].get(doc.uri);
assert.ok(diags && diags.length > 50, 'diagnostics published');
assert.ok(diags.every((d) => d.source.startsWith('C Style') && d.code), 'source/code set');
const ruleOf = (d) => (typeof d.code === 'object' ? d.code.value : d.code);
const withFix = diags.find((d) => ruleOf(d) === 'operator-spacing');
const actions = registered.codeActions.provideCodeActions(doc, withFix.range, { diagnostics: [withFix] });
assert.ok(actions.some((a) => a.title.startsWith('Insert spaces') && a.edit.edits.length), 'quick fix offered');
assert.ok(actions.some((a) => a.title.startsWith('Disable C Style rule')), 'disable action offered');
const fixAllAction = registered.codeActions.provideCodeActions(doc, withFix.range, { diagnostics: [], only: vscode.CodeActionKind.SourceFixAll });
assert.ok(fixAllAction.some((a) => a.kind.value === 'source.fixAll.cstyle'), 'source.fixAll offered');

// completion on "///" above a function
const src = 'int main(void)\n{\n  return 0;\n}\n';
const tmp = path.join(__dirname, 'fixtures', '_tmp_completion.c');
fs.writeFileSync(tmp, '///\n' + src);
const cdoc = makeDoc(tmp);
const items = registered.completion.provideCompletionItems(cdoc, new Position(0, 3));
fs.unlinkSync(tmp);
assert.ok(items.some((i) => i.label === 'Function header' && /@return/.test(i.insertText.value)), 'header completion');

// will-save adds headers
let waited = null;
registered.willSave({ document: doc, reason: 1, waitUntil: (p) => { waited = p; } });
assert.ok(waited, 'headers added on save');
waited.then((edits) => {
  assert.ok(edits.length >= 3, 'file header + function headers');
  assert.ok(edits.some((e) => e.text.includes('/// Author: 12345678')), 'author from settings');
  console.log(`smoke test ok: ${diags.length} diagnostics, ${edits.length} header edits on save, ${Object.keys(registered).length} registrations`);
});
