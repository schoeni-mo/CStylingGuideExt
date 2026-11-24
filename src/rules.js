'use strict';
// Catalog of all checks. Every rule maps to a section of the course style guide.
//
// severity: 'error' | 'warning' | 'information' | 'hint'
// Deductions (points are subtracted directly) default to 'error'.

const RULES = {
  // ---------------------------------------------------------------- Documentation
  'file-header': { severity: 'warning', category: 'Documentation', title: 'The source file contains a comment header' },
  'function-header': { severity: 'warning', category: 'Documentation', title: 'Each function has a function header' },
  'header-placeholder': { severity: 'warning', category: 'Documentation', title: 'Header comment still contains placeholder text' },
  'naming-variable': { severity: 'warning', category: 'Documentation', title: 'Naming: local variables / parameters are all_lower_case_with_underscores' },
  'naming-function': { severity: 'warning', category: 'Documentation', title: 'Naming: functions are firstWordLowerCaseRestCapitalized' },
  'naming-constant': { severity: 'warning', category: 'Documentation', title: 'Naming: constants and enum elements are ALL_UPPERCASE_WITH_UNDERSCORES' },
  'naming-member': { severity: 'warning', category: 'Documentation', title: 'Naming: struct members are lower_case_with_trailing_underscore_' },
  'naming-type': { severity: 'warning', category: 'Documentation', title: "Naming: typedef'ed types are AllWordsCapitalized" },
  'naming-tag': { severity: 'warning', category: 'Documentation', title: "Naming: non-typedef'ed struct/enum/union tags are _AllWordsCapitalized_" },
  'meaningful-name': { severity: 'information', category: 'Documentation', title: 'Appropriate variable and function names (the name indicates the purpose)' },
  'nested-loop-counter': { severity: 'warning', category: 'Documentation', title: 'No i, j, k / count1, count2 counters in nested loops' },
  'commented-code': { severity: 'warning', category: 'Documentation', title: 'Commented-out code is not allowed' },
  'magic-number': { severity: 'information', category: 'Documentation', title: 'No hardcoded values - use appropriate constants' },
  'pointer-style': { severity: 'information', category: 'Documentation', title: 'The code should be consistent (pointer star position)' },
  'english-only': { severity: 'information', category: 'Documentation', title: 'The language of source code and comments is English' },

  // ---------------------------------------------------------------- Presentation
  'operator-spacing': { severity: 'warning', category: 'Presentation', title: 'Space between operands and parameters' },
  'one-statement-per-line': { severity: 'warning', category: 'Presentation', title: 'Each command is on a separate line' },
  'chained-declaration': { severity: 'warning', category: 'Presentation', title: 'Variable declarations are made individually' },
  'brace-own-line': { severity: 'warning', category: 'Presentation', title: 'Block brackets are on their own lines' },
  'indentation': { severity: 'warning', category: 'Presentation', title: 'Each block must be indented with two spaces' },
  'no-tabs': { severity: 'warning', category: 'Presentation', title: 'Indentation uses spaces, never tabs' },
  'line-length': { severity: 'warning', category: 'Presentation', title: 'The length of a code line must not exceed 120 characters' },

  // ---------------------------------------------------------------- Algorithms
  'duplicate-code': { severity: 'information', category: 'Algorithms', title: 'Avoid duplicated code segments' },
  'nesting-depth': { severity: 'warning', category: 'Algorithms', title: 'Keep nesting to a minimum (more than 4 levels)' },
  'unreachable-code': { severity: 'warning', category: 'Algorithms', title: 'Avoid unnecessary calculations/variables and unreachable code' },
  'unnecessary-negation': { severity: 'hint', category: 'Algorithms', title: 'Keep logic expressions simple (avoid unnecessary negation)' },

  // ---------------------------------------------------------------- Structure
  'main-logic': { severity: 'information', category: 'Structure', title: 'Store program logic in subfunctions (main should not include the logic)' },
  'too-many-params': { severity: 'warning', category: 'Structure', title: 'Not more than 6 parameters per function' },
  'function-length': { severity: 'warning', category: 'Structure', title: 'Functions are no longer than 70 lines of code' },

  // ---------------------------------------------------------------- Deductions
  'recursion': { severity: 'information', category: 'Deduction -10%', title: 'Inappropriate use of recursion' },
  'max-nesting': { severity: 'error', category: 'Deduction -10%', title: 'Unnecessarily complex nesting (statement nesting more than 6)' },
  'stderr-output': { severity: 'error', category: 'Deduction -10%', title: 'Print your output on stdout, no output on stderr' },
  'compiler-warning': { severity: 'error', category: 'Deduction -10%', title: 'Compiler warnings (-Wall -Wextra -pedantic -std=c17)' },
  'forbidden-construct': { severity: 'error', category: 'Deduction -25%', title: 'goto, exit and <setjmp.h> are forbidden' },
  'global-variable': { severity: 'error', category: 'Deduction -25%', title: 'The use of global variables' },
  'static-local': { severity: 'warning', category: 'Deduction -25%', title: 'Abusing static variables to simulate global variables is forbidden' },
  'non-standard-header': { severity: 'error', category: 'Deduction -25%', title: 'The use of non-standard libraries' },

  // ---------------------------------------------------------------- Memory management
  'alloc-null-check': { severity: 'error', category: 'Memory -10%', title: 'Each malloc/calloc/realloc call is checked for NULL' },
  'realloc-temp': { severity: 'error', category: 'Memory -10%', title: 'Use a temporary variable for the result of realloc' },
  'fopen-null-check': { severity: 'error', category: 'Memory -10%', title: 'Opened files are checked for NULL' },
};

// Link shown on every diagnostic; configurable with cStyle.guideUrl (empty = no link).
const GUIDE_URL = '';

module.exports = { RULES, GUIDE_URL };
