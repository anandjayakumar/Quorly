#!/usr/bin/env node
// Regression fixtures for the vendored Markdown parser (L-6).
//
//   node tools/test-marked.mjs
//
// marked is not the security boundary (DOMPurify is), but its output shape is what the editor
// post-processes (tables, images, task lists, code fences, links), so an upgrade must not change
// it silently. These assertions are structural on purpose: they survive cosmetic whitespace
// changes and still catch a broken or swapped parser.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vendorFile = path.join(here, '..', 'vendor', 'marked.min.js');

// The vendored file is a UMD build, so Node can require it as CommonJS.
const marked = require(vendorFile);
const parse = (marked.marked || marked).parse;

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '  ' + detail));
}

check('parser reports v18.1.1', fs.readFileSync(vendorFile, 'utf8').includes('marked v18.1.1'));

const sync = parse('# Title');
check('parse is synchronous and returns a string', typeof sync === 'string' && sync.includes('<h1>Title</h1>'));

const table = parse('| A | B |\n| --- | --- |\n| 1 | 2 |');
check('renders a GFM table', table.includes('<table>') && table.includes('<th>A</th>') && table.includes('<td>1</td>'));

const image = parse('![alt](https://example.com/i.png)');
check('keeps the image source', image.includes('<img src="https://example.com/i.png"') && image.includes('alt="alt"'));

const code = parse('```js\nconst a = 1 < 2;\n```');
check('renders a fenced code block with its language',
  code.includes('<pre><code class="language-js">') && code.includes('1 &lt; 2'));

const task = parse('- [x] done\n- [ ] todo');
check('renders task-list checkboxes', (task.match(/type="checkbox"/g) || []).length === 2);

const link = parse('[link](https://example.com)');
check('renders a link', link.includes('<a href="https://example.com"') && link.includes('>link</a>'));

const list = parse('- one\n  - two\n- three');
check('renders nested lists', list.includes('<ul>') && list.includes('<li>one') && list.includes('<li>two'));

const quote = parse('> quoted');
check('renders a blockquote', quote.includes('<blockquote>'));

const heading = parse('Setext\n======');
check('renders a setext heading', heading.includes('<h1>Setext</h1>'));

const raw = parse('<div class="x"><b>bold</b></div>');
check('passes raw block HTML through for the sanitizer', raw.includes('<div class="x">') && raw.includes('<b>bold</b>'));

const escape = parse('a & b < c');
check('escapes text entities', escape.includes('a &amp; b &lt; c'));

const hardBreak = parse('one  \ntwo');
check('keeps a hard line break', hardBreak.includes('<br>'));

const empty = parse('');
check('handles an empty document', typeof empty === 'string');

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
