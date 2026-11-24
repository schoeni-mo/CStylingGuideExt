'use strict';
const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { analyze } = require('./src/analyzer');
const { fixAll, selectFixes, applyEdits } = require('./src/fixer');
const H = require('./src/headers');
const { RULES, GUIDE_URL } = require('./src/rules');

const SOURCE = 'C Style';
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

let styleDiagnostics;
let compilerDiagnostics;
let statusBar;
const fixesByDiagnostic = new WeakMap();
const timers = new Map();

// ------------------------------------------------------------------------------------------------ configuration
function cfg() {
  return vscode.workspace.getConfiguration('cStyle');
}

function guideUrl() {
  return (cfg().get('guideUrl') || GUIDE_URL || '').trim();
}

function analyzerOptions(document) {
  const c = cfg();
  const overrides = c.get('rules') || {};
  const disabled = Object.keys(overrides).filter((r) => overrides[r] === 'off');
  if (document && /\.h$/i.test(document.fileName)) disabled.push('file-header', 'function-header', 'main-logic');
  return {
    author: c.get('matriculationNumber') || '',
    maxLineLength: c.get('maxLineLength'),
    maxFunctionLines: c.get('maxFunctionLines'),
    maxParams: c.get('maxParameters'),
    warnNesting: c.get('warnNestingDepth'),
    maxNesting: c.get('maxNestingDepth'),
    mainMaxLines: c.get('mainMaxLines'),
    allowedNumbers: c.get('allowedNumbers'),
    disabledRules: disabled,
    severityOverrides: overrides,
  };
}

function isC(document) {
  return document && document.languageId === 'c' && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

// ------------------------------------------------------------------------------------------------ linting
function lint(document) {
  if (!isC(document) || !cfg().get('enable')) {
    styleDiagnostics.delete(document.uri);
    updateStatus();
    return;
  }
  const opts = analyzerOptions(document);
  let result;
  try {
    result = analyze(document.getText(), opts);
  } catch (err) {
    console.error('[c-style] analysis failed', err);
    return;
  }
  const diags = [];
  for (const d of result.diagnostics) {
    const sev = opts.severityOverrides[d.rule] || d.severity;
    if (sev === 'off') continue;
    const range = new vscode.Range(document.positionAt(d.start), document.positionAt(d.end));
    const rule = RULES[d.rule];
    const diag = new vscode.Diagnostic(range, d.message, SEVERITY[sev] !== undefined ? SEVERITY[sev] : SEVERITY.warning);
    diag.source = SOURCE + (rule ? ` · ${rule.category}` : '');
    diag.code = guideUrl() ? { value: d.rule, target: vscode.Uri.parse(guideUrl()) } : d.rule;
    if (d.rule === 'unreachable-code' || d.rule === 'commented-code') diag.tags = [vscode.DiagnosticTag.Unnecessary];
    if (d.fix) fixesByDiagnostic.set(diag, d.fix);
    diags.push(diag);
  }
  styleDiagnostics.set(document.uri, diags);
  updateStatus();
}

function scheduleLint(document) {
  if (!isC(document)) return;
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); lint(document); }, 250));
}

function updateStatus() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isC(editor.document) || !cfg().get('enable')) { statusBar.hide(); return; }
  const all = [...(styleDiagnostics.get(editor.document.uri) || []), ...(compilerDiagnostics.get(editor.document.uri) || [])];
  const errors = all.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
  const warnings = all.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
  const infos = all.length - errors - warnings;
  if (!all.length) {
    statusBar.text = '$(pass-filled) TU Style';
    statusBar.tooltip = 'No style guide violations found';
  } else {
    statusBar.text = `$(checklist) TU Style  $(error) ${errors}  $(warning) ${warnings}  $(info) ${infos}`;
    statusBar.tooltip = 'Errors are point deductions (-10% / -25%), warnings cost code quality points. Click to open the Problems view.';
  }
  statusBar.show();
}

// ------------------------------------------------------------------------------------------------ edits helpers
function toWorkspaceEdit(document, edits) {
  const we = new vscode.WorkspaceEdit();
  for (const e of edits) {
    we.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
  }
  return we;
}

function toTextEdits(document, edits) {
  return edits.map((e) => vscode.TextEdit.replace(new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text));
}

async function replaceWholeDocument(document, newText) {
  if (newText === document.getText()) return false;
  const we = new vscode.WorkspaceEdit();
  const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  we.replace(document.uri, full, newText);
  return vscode.workspace.applyEdit(we);
}

// ------------------------------------------------------------------------------------------------ code actions
class StyleCodeActions {
  provideCodeActions(document, range, context) {
    const actions = [];
    const ours = context.diagnostics.filter((d) => d.source && d.source.startsWith(SOURCE));
    for (const diag of ours) {
      const fix = fixesByDiagnostic.get(diag);
      if (fix) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.edit = toWorkspaceEdit(document, fix.edits);
        action.diagnostics = [diag];
        action.isPreferred = !fix.rename;
        actions.push(action);
      }
      const rule = diag.code && typeof diag.code === 'object' ? diag.code.value : diag.code;
      if (rule) {
        const disable = new vscode.CodeAction(`Disable C Style rule '${rule}'`, vscode.CodeActionKind.QuickFix);
        disable.command = { command: 'cStyle.disableRule', title: 'Disable rule', arguments: [rule] };
        disable.diagnostics = [diag];
        actions.push(disable);
      }
    }
    if (ours.some((d) => fixesByDiagnostic.get(d))) {
      const all = new vscode.CodeAction('Fix all auto-fixable C Style problems', vscode.CodeActionKind.QuickFix);
      all.command = { command: 'cStyle.fixAll', title: 'Fix all' };
      actions.push(all);
    }
    if (context.only && context.only.contains(vscode.CodeActionKind.SourceFixAll)) {
      const src = new vscode.CodeAction('Fix all C Style problems', vscode.CodeActionKind.SourceFixAll.append('cstyle'));
      const newText = fixAll(document.getText(), analyzerOptions(document), {});
      if (newText !== document.getText()) {
        src.edit = new vscode.WorkspaceEdit();
        src.edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), newText);
        actions.push(src);
      }
    }
    return actions;
  }
}

// ------------------------------------------------------------------------------------------------ headers
async function ensureMatriculationNumber() {
  let number = cfg().get('matriculationNumber');
  if (number) return number;
  number = await vscode.window.showInputBox({
    title: 'C Style Guide',
    prompt: 'Your matriculation number (used for "/// Author:" in file headers)',
    placeHolder: '12345678',
    ignoreFocusOut: true,
  });
  if (number) await cfg().update('matriculationNumber', number.trim(), vscode.ConfigurationTarget.Global);
  return number || '';
}

async function insertFileHeader(editor, interactive) {
  const document = editor.document;
  const check = H.checkFileHeader(document.getText().split('\n').map((l) => l.replace(/\r$/, '')));
  if (check.present) {
    if (interactive) vscode.window.showInformationMessage('This file already has a file header.');
    return;
  }
  const author = await ensureMatriculationNumber();
  const snippet = new vscode.SnippetString(H.fileHeaderSnippet(author));
  const needsBlank = document.lineCount > 0 && document.lineAt(0).text.trim() !== '';
  if (needsBlank) snippet.appendText('\n');
  await editor.insertSnippet(snippet, new vscode.Position(0, 0));
}

function functionAtLine(result, line) {
  const defs = result.functions.filter((f) => f.isDefinition);
  const tk = result.lexed.tokens;
  // the function containing the line, or the next one below it
  let best = defs.find((f) => tk[f.startTok].line <= line && tk[f.closeBrace] && tk[f.closeBrace].line >= line);
  if (!best) best = defs.filter((f) => tk[f.startTok].line >= line).sort((a, b) => tk[a.startTok].line - tk[b.startTok].line)[0];
  return best || null;
}

async function insertFunctionHeaderAtCursor(editor) {
  const document = editor.document;
  const result = analyze(document.getText(), analyzerOptions(document));
  const fn = functionAtLine(result, editor.selection.active.line);
  if (!fn) {
    vscode.window.showInformationMessage('No function definition found at or below the cursor.');
    return;
  }
  const fnLine = result.lexed.tokens[fn.startTok].line;
  const indent = /^\s*/.exec(result.lines[fnLine])[0];
  const existing = H.findHeaderAbove(result.lines, fnLine);
  if (existing) {
    const parsed = H.parseHeader(existing.lines);
    const newLines = H.functionHeaderLines(fn, parsed).map((l) => indent + l);
    const range = new vscode.Range(existing.startLine, 0, existing.endLine, result.lines[existing.endLine].length);
    await editor.edit((b) => b.replace(range, newLines.join('\n')));
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(H.functionHeaderSnippet(fn, indent) + '\n'), new vscode.Position(fnLine, 0));
}

function headerEdits(document) {
  const opts = analyzerOptions(document);
  const { diagnostics } = analyze(document.getText(), opts);
  return selectFixes(diagnostics, (d) => d.fix.header && (d.rule !== 'file-header' || cfg().get('autoFileHeader')));
}

async function generateAllHeaders(editor) {
  await ensureMatriculationNumber();
  const document = editor.document;
  const edits = headerEdits(document);
  if (!edits.length) {
    vscode.window.showInformationMessage('All headers are complete.');
    return;
  }
  await vscode.workspace.applyEdit(toWorkspaceEdit(document, edits));
}

// "///" completion directly above a function -> full header
class HeaderCompletionProvider {
  provideCompletionItems(document, position) {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    const m = /^(\s*)(\/\/\/?|\/\/-*)$/.exec(before);
    if (!m) return undefined;
    const items = [];
    const result = analyze(document.getText(), analyzerOptions(document));
    const tk = result.lexed.tokens;
    const fn = result.functions.find((f) => f.isDefinition && tk[f.startTok].line > position.line &&
      result.lines.slice(position.line + 1, tk[f.startTok].line).every((l) => /^\s*(\/\/.*)?$/.test(l)));
    const replaceRange = new vscode.Range(position.line, 0, position.line, lineText.length);
    if (fn) {
      const item = new vscode.CompletionItem('Function header', vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(H.functionHeaderSnippet(fn, m[1]));
      item.range = replaceRange;
      item.filterText = before.trim();
      item.detail = `@brief / @param / @return for ${fn.name}()`;
      item.documentation = new vscode.MarkdownString('Inserts the function header required by the style guide.');
      item.sortText = '0';
      item.preselect = true;
      items.push(item);
    }
    if (position.line === 0 || !H.checkFileHeader(result.lines).present) {
      const author = cfg().get('matriculationNumber');
      const item = new vscode.CompletionItem('File header', vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(H.fileHeaderSnippet(author));
      item.range = replaceRange;
      item.filterText = before.trim();
      item.detail = 'Explanation + Author: <matriculation number>';
      item.sortText = '1';
      if (position.line === 0) items.push(item);
    }
    return items;
  }
}

// ------------------------------------------------------------------------------------------------ compiler
function compile(document, showOutput) {
  if (!isC(document) || document.uri.scheme !== 'file' || !/\.c$/i.test(document.fileName)) return Promise.resolve();
  const c = cfg();
  const compiler = c.get('compiler.path') || 'clang';
  const args = [...(c.get('compiler.args') || []), '-fsyntax-only', document.fileName];
  return new Promise((resolve) => {
    execFile(compiler, args, { cwd: path.dirname(document.fileName), timeout: 20000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        if (showOutput) vscode.window.showErrorMessage(`Compiler '${compiler}' not found. Set cStyle.compiler.path.`);
        resolve();
        return;
      }
      const diags = [];
      const re = /^(.*?):(\d+):(\d+):\s+(warning|error|fatal error):\s+(.*)$/;
      let warnings = 0;
      let errors = 0;
      for (const line of (stderr || '').split('\n')) {
        const m = re.exec(line);
        if (!m) continue;
        if (path.resolve(path.dirname(document.fileName), m[1]) !== path.resolve(document.fileName)) continue;
        const ln = Math.max(0, Number(m[2]) - 1);
        const col = Math.max(0, Number(m[3]) - 1);
        const pos = new vscode.Position(Math.min(ln, document.lineCount - 1), col);
        const range = document.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos.translate(0, 1));
        const isWarning = m[4] === 'warning';
        const override = (c.get('rules') || {})['compiler-warning'];
        if (isWarning && override === 'off') continue;
        if (isWarning) warnings++; else errors++;
        const d = new vscode.Diagnostic(range, isWarning ? `${m[5]} (compiler warnings cost -10%)` : m[5],
          isWarning ? SEVERITY[override || 'error'] : vscode.DiagnosticSeverity.Error);
        d.source = `${SOURCE} · ${path.basename(compiler)} -Wall`;
        d.code = guideUrl() ? { value: 'compiler-warning', target: vscode.Uri.parse(guideUrl()) } : 'compiler-warning';
        diags.push(d);
      }
      compilerDiagnostics.set(document.uri, diags);
      updateStatus();
      if (showOutput) {
        const cmd = [compiler, ...(c.get('compiler.args') || []), '-o', path.basename(document.fileName, '.c'), path.basename(document.fileName)].join(' ');
        if (!warnings && !errors) vscode.window.showInformationMessage(`No compiler warnings with: ${cmd}`);
        else vscode.window.showWarningMessage(`${warnings} warning(s), ${errors} error(s) with: ${cmd}`);
      }
      resolve();
    });
  });
}

// ------------------------------------------------------------------------------------------------ git identity
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function checkGitIdentity(interactive) {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const cwd = folder.uri.fsPath;
    const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside !== 'true') continue;
    const name = await git(['config', 'user.name'], cwd);
    const email = await git(['config', 'user.email'], cwd);
    const domain = (cfg().get('git.requiredEmailDomain') || '').trim().replace(/^@/, '').toLowerCase();
    const emailOk = (value) => !!value && /^[^@\s]+@[^@\s]+$/.test(value.trim()) &&
      (!domain || value.trim().toLowerCase().endsWith('@' + domain));
    const okEmail = emailOk(email);
    const okName = name && /\S+\s+\S+/.test(name);
    if (okEmail && okName) {
      if (interactive) vscode.window.showInformationMessage(`Git identity OK: ${name} <${email}>`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Git identity is "${name || '(no name)'} <${email || 'no email'}>". Commits must use your full name${domain ? ` and your @${domain} email` : ' and a valid email'}, otherwise they may not count.`,
      'Set now', 'Ignore');
    if (choice !== 'Set now') return;
    const newName = await vscode.window.showInputBox({ prompt: 'Full name (FIRST_NAME LAST_NAME)', value: name || '', ignoreFocusOut: true });
    if (!newName) return;
    const newEmail = await vscode.window.showInputBox({ prompt: domain ? `Email (@${domain})` : 'Email', value: okEmail ? email : '',
      placeHolder: domain ? `MY_NAME@${domain}` : 'name@example.com', ignoreFocusOut: true,
      validateInput: (v) => (emailOk(v) ? null : domain ? `Must end with @${domain}` : 'Enter a valid email address') });
    if (!newEmail) return;
    const scope = await vscode.window.showQuickPick(['--global', '--local (only this repository)'], { placeHolder: 'Where should the identity be stored?' });
    if (!scope) return;
    const flag = scope.startsWith('--global') ? '--global' : '--local';
    await git(['config', flag, 'user.name', newName.trim()], cwd);
    await git(['config', flag, 'user.email', newEmail.trim()], cwd);
    vscode.window.showInformationMessage(`Git identity set to ${newName.trim()} <${newEmail.trim()}>.`);
    return;
  }
  if (interactive) vscode.window.showInformationMessage('No Git repository found in the workspace.');
}

// ------------------------------------------------------------------------------------------------ activation
function activate(context) {
  styleDiagnostics = vscode.languages.createDiagnosticCollection('c-style');
  compilerDiagnostics = vscode.languages.createDiagnosticCollection('c-style-compiler');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'workbench.actions.view.problems';
  context.subscriptions.push(styleDiagnostics, compilerDiagnostics, statusBar);

  const sel = [{ language: 'c', scheme: 'file' }, { language: 'c', scheme: 'untitled' }];
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(sel, new StyleCodeActions(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.SourceFixAll.append('cstyle')],
    }),
    vscode.languages.registerCompletionItemProvider(sel, new HeaderCompletionProvider(), '/', '-'),

    vscode.workspace.onDidOpenTextDocument((doc) => { lint(doc); maybeAutoFileHeader(doc); }),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleLint(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => { styleDiagnostics.delete(doc.uri); compilerDiagnostics.delete(doc.uri); }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) { lint(ed.document); maybeAutoFileHeader(ed.document); } updateStatus(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cStyle')) vscode.workspace.textDocuments.forEach(lint);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!isC(e.document) || !cfg().get('enable') || !cfg().get('headersOnSave')) return;
      if (e.reason !== vscode.TextDocumentSaveReason.Manual) return;
      const edits = headerEdits(e.document);
      if (edits.length) e.waitUntil(Promise.resolve(toTextEdits(e.document, edits)));
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      lint(doc);
      if (cfg().get('enable') && cfg().get('compileOnSave')) compile(doc, false);
    }),

    vscode.commands.registerTextEditorCommand('cStyle.insertFileHeader', (ed) => insertFileHeader(ed, true)),
    vscode.commands.registerTextEditorCommand('cStyle.insertFunctionHeader', (ed) => insertFunctionHeaderAtCursor(ed)),
    vscode.commands.registerTextEditorCommand('cStyle.generateAllHeaders', (ed) => generateAllHeaders(ed)),
    vscode.commands.registerCommand('cStyle.fixAll', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !isC(ed.document)) return;
      const changed = await replaceWholeDocument(ed.document, fixAll(ed.document.getText(), analyzerOptions(ed.document), {}));
      if (!changed) vscode.window.showInformationMessage('Nothing left to fix automatically - the remaining problems need your judgement.');
    }),
    vscode.commands.registerCommand('cStyle.fixAllIncludingRenames', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !isC(ed.document)) return;
      await replaceWholeDocument(ed.document, fixAll(ed.document.getText(), analyzerOptions(ed.document), { includeRenames: true }));
    }),
    vscode.commands.registerCommand('cStyle.compile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !isC(ed.document)) return;
      if (ed.document.isDirty) await ed.document.save();
      await compile(ed.document, true);
    }),
    vscode.commands.registerCommand('cStyle.checkGitIdentity', () => checkGitIdentity(true)),
    vscode.commands.registerCommand('cStyle.openGuide', () => {
      if (guideUrl()) vscode.env.openExternal(vscode.Uri.parse(guideUrl()));
      else vscode.window.showInformationMessage('Set cStyle.guideUrl to the link of your style guide first.');
    }),
    vscode.commands.registerCommand('cStyle.setMatriculationNumber', async () => {
      const value = await vscode.window.showInputBox({ prompt: 'Matriculation number', value: cfg().get('matriculationNumber') || '' });
      if (value !== undefined) await cfg().update('matriculationNumber', value.trim(), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('cStyle.disableRule', async (rule) => {
      const rules = Object.assign({}, cfg().get('rules') || {});
      rules[rule] = 'off';
      await cfg().update('rules', rules, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }),
  );

  vscode.workspace.textDocuments.forEach(lint);
  if (vscode.window.activeTextEditor) maybeAutoFileHeader(vscode.window.activeTextEditor.document);
  updateStatus();
  if (cfg().get('checkGitIdentity')) checkGitIdentity(false);
}

const autoHeaderDone = new Set();
function maybeAutoFileHeader(document) {
  if (!isC(document) || !cfg().get('enable') || !cfg().get('autoFileHeader')) return;
  if (!/\.c$/i.test(document.fileName) && document.uri.scheme === 'file') return;
  if (document.getText().trim() !== '') return;
  const key = document.uri.toString();
  if (autoHeaderDone.has(key)) return;
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  if (!editor) return;
  autoHeaderDone.add(key);
  insertFileHeader(editor, false);
}

function deactivate() {}

module.exports = { activate, deactivate };
// for tests
module.exports._internal = { applyEdits };
