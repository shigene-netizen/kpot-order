/* Syntax-check every inline <script> in the admin pages.
   node --check cannot read HTML, and a single typo in admin.html would break
   the whole owner console with nothing in the server log to explain it. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const files = process.argv.slice(2);
let bad = 0;

for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    const code = m[1];
    try {
      new vm.Script(code, { filename: path.basename(f) + '#' + i });
      console.log('OK   ' + path.basename(f) + ' script#' + i + ' (' + code.length + ' chars)');
    } catch (e) {
      bad++;
      console.log('FAIL ' + path.basename(f) + ' script#' + i + ': ' + e.message);
    }
  }
  if (i === 0) console.log('??   ' + path.basename(f) + ' — no inline script found');
}

process.exit(bad ? 1 : 0);
