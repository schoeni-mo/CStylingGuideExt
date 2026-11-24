# C Style Guide for VSCodium / VS Code

Checks your C code against the course coding style guide as you type, generates the required headers, and fixes layout problems automatically.

## Installation

### From the `.vsix` file (recommended)

1. Download `c-style-guide-1.0.0.vsix` from this repository, or clone it:
   ```
   git clone https://github.com/schoeni-mo/CStylingGuideExt.git
   cd CStylingGuideExt
   ```
2. Install it:
   ```
   codium --install-extension c-style-guide-1.0.0.vsix   # VSCodium
   code --install-extension c-style-guide-1.0.0.vsix     # VS Code
   ```
   Or use the editor's UI: open the Extensions view (`Ctrl+Shift+X`), click the `...` menu, choose **Install from VSIX...** and select the file.
3. Reload the window (`Ctrl+Shift+P` → **Developer: Reload Window**) and open any `.c` file.
4. Set your matriculation number when you're asked for it, or run **C Style: Set Matriculation Number**.

### Requirements

- VSCodium or VS Code 1.75 or newer. There are no other dependencies.
- `clang` (or `gcc`) on your `PATH` for the compiler-warning check. Install it on Debian/Ubuntu with `sudo apt install clang`, or set `cStyle.compiler.path` to another compiler. If no compiler is installed, the other checks still work.
- `git` for the Git name and email check (optional).

### Updating or removing

- **Update:** build or download a newer `.vsix`, then run the install command again with `--force`.
- **Remove:** `codium --uninstall-extension local.c-style-guide`, or uninstall it from the Extensions view.

## Headers

| What | How |
|---|---|
| File header | Inserted automatically into new empty `.c` files. Also available with **C Style: Insert File Header** or by typing `///` on line 1. Uses your matriculation number (asked once, stored in `cStyle.matriculationNumber`). |
| Function header | Type `///` directly above a function and pick **Function header**. You can also use `Ctrl+Alt+H` or the right-click menu. |
| On save | Missing function headers are added. Existing ones are kept in sync: `@param` lines are added, removed or reordered to match the signature, and `@return` is added or removed. Your existing descriptions are kept. Missing file headers are added too. |

Generated text is marked `TODO`, and a warning stays until you replace it with a real description.

## Severity of the highlights

- **Error (red):** a direct point deduction (−10 % / −25 %), e.g. global variables, `goto`/`exit`, `<setjmp.h>`, non-standard headers, `stderr`, nesting deeper than 6, unchecked `malloc`/`fopen`, `p = realloc(p, …)`, compiler warnings.
- **Warning (yellow):** costs code-quality points, e.g. naming conventions, headers, indentation, braces, spacing, one statement per line, tabs, more than 120 characters per line, more than 70 LOC per function, more than 6 parameters, nested-loop counters `i`/`j`, commented-out code, unreachable code.
- **Info / hint:** checks that need your judgement, e.g. hardcoded values, meaningless names, duplicated code, recursion, too much logic in `main`, pointer-star consistency, non-English comments, unnecessary negation.

Set `cStyle.guideUrl` to your style guide and every problem links to it. The status bar shows the totals.

## Fixing

- **Quick fixes (`Ctrl+.`):** indentation, tabs, braces on their own line, operator/comma spacing, line breaks between statements, splitting chained declarations, simplifying `!(a < b)`, headers, and renaming to the correct naming convention.
- **Fix All (`Ctrl+Alt+F`):** applies every safe fix repeatedly until the file is stable. Renames and removing commented-out code are left out. Use **Fix All Problems Including Naming** to apply the renames as well.
- You can also turn on `"editor.codeActionsOnSave": { "source.fixAll.cstyle": "explicit" }` to fix on save.

## Other checks

- **Compiler:** on save it runs `clang -Wall -Wextra -pedantic -std=c17 -fsyntax-only` (configurable) and shows the warnings in the file.
- **Git identity:** on startup it checks that `user.name` is your full name and `user.email` is set (and ends in `@<domain>` if you configure `cStyle.git.requiredEmailDomain`), and offers to set them if not.
- **Editor defaults for C:** 2 spaces, no tabs, a ruler at 120 characters.

## Settings

All settings are under `cStyle.*`. Use `cStyle.rules` to change the severity of any rule or turn it off, e.g.
`"cStyle.rules": { "magic-number": "off", "pointer-style": "hint" }`.
A quick fix also offers to disable the rule of the current problem.

## Limitations

This is a heuristic analyzer, not a compiler. Some guide rules can't be fully checked automatically: *one purpose per function*, *reasonable casts*, *appropriate recursion*, *assignment-specific specifications*, and *the file name required by the assignment*. Those are either shown as hints or not checked at all. Your tutor's judgement always wins.

## Development

```
node test/test.js     # analyzer tests
node test/smoke.js    # loads the extension against a mocked vscode API
node test/run.js file.c   # print diagnostics for any file
```

Rebuild the package after changes with `python3 scripts/build-vsix.py .` and install it with `codium --install-extension c-style-guide-1.0.0.vsix --force`.
