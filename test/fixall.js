'use strict';
const fs = require('fs');
const { fixAll } = require('../src/fixer');
const text = fs.readFileSync(process.argv[2], 'utf8');
const out = fixAll(text, { author: '12345678' }, { includeRenames: process.argv[3] === 'renames' });
process.stdout.write(out);
