/* Boundary test for the "Open now / Closed" badge.
 *
 * The store closes in the EVENING (9:30 PM Sun–Thu, 10:30 PM Fri–Sat), not
 * after midnight. The earlier version of this file pinned an afternoon close;
 * the hours changed, so the boundaries below were re-derived from the confirmed
 * schedule. The point of the test is unchanged: an off-by-one or a wrong
 * day-of-week mapping must not be able to reach production.
 *
 * Run:  node _dev/test_hours.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);

/* Load the real config, then lift storeOpenState() out of app.js by evaluating
   just the two functions it depends on. Re-implementing the logic here would
   test the test, not the app. */
const cfgSrc = fs.readFileSync(path.join(ROOT, 'assets', 'config.js'), 'utf8');
const cfgCtx = { window: {} };
vm.createContext(cfgCtx);
vm.runInContext(cfgSrc + '\n;window.CONFIG = CONFIG;', cfgCtx);
const CONFIG = cfgCtx.window.CONFIG;

const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const start = appSrc.indexOf('function fmtMin(');
const end = appSrc.indexOf('/* ------', start);
if (start < 0 || end < 0) {
  console.error('FAIL — could not locate fmtMin/storeOpenState in app.js');
  process.exit(1);
}
const fnSrc = appSrc.slice(start, end);

function stateAt(dateStr) {
  const ctx = { CONFIG, Date: Date };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\n;this.__s = storeOpenState;', ctx);
  /* Freeze "now" for the duration of the call. */
  const RealDate = Date;
  const fixed = new RealDate(dateStr);
  ctx.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    static now() { return fixed.getTime(); }
  };
  vm.runInContext(fnSrc + '\n;this.__s2 = storeOpenState;', ctx);
  return ctx.__s2();
}

/* 2026-10-04 is a Sunday; 2026-10-09 is a Friday; 2026-10-08 is a Thursday. */
const cases = [
  // --- Sunday (Sun–Thu schedule: 12:00 PM – 9:30 PM) ---
  ['2026-10-04T11:59:00', false, 'Sun 11:59 AM — one minute before opening'],
  ['2026-10-04T12:00:00', true,  'Sun 12:00 PM — opens (inclusive)'],
  ['2026-10-04T15:00:00', true,  'Sun 3:00 PM — mid-afternoon'],
  ['2026-10-04T21:29:00', true,  'Sun 9:29 PM — one minute before close'],
  ['2026-10-04T21:30:00', false, 'Sun 9:30 PM — closes (exclusive)'],
  ['2026-10-04T22:00:00', false, 'Sun 10:00 PM — after close'],
  ['2026-10-04T23:30:00', false, 'Sun 11:30 PM — late night, MUST be closed'],
  ['2026-10-04T02:00:00', false, 'Sun 2:00 AM — small hours, MUST be closed'],

  // --- Monday (Sun–Thu schedule) ---
  ['2026-10-05T21:29:00', true,  'Mon 9:29 PM — still open'],
  ['2026-10-05T21:31:00', false, 'Mon 9:31 PM — closed'],

  // --- Friday (Fri–Sat schedule: 12:00 PM – 10:30 PM) ---
  ['2026-10-09T11:59:00', false, 'Fri 11:59 AM — closed'],
  ['2026-10-09T12:00:00', true,  'Fri 12:00 PM — opens'],
  ['2026-10-09T21:30:00', true,  'Fri 9:30 PM — STILL OPEN (Fri runs later than Sun–Thu)'],
  ['2026-10-09T22:29:00', true,  'Fri 10:29 PM — one minute before close'],
  ['2026-10-09T22:30:00', false, 'Fri 10:30 PM — closes (exclusive)'],

  // --- Saturday (Fri–Sat schedule) ---
  ['2026-10-10T22:29:00', true,  'Sat 10:29 PM — still open'],
  ['2026-10-10T22:30:00', false, 'Sat 10:30 PM — closes'],
  ['2026-10-10T23:00:00', false, 'Sat 11:00 PM — MUST be closed'],

  // --- Thursday (Sun–Thu) ---
  ['2026-10-08T21:00:00', true,  'Thu 9:00 PM — open (Thu is Sun–Thu)'],
  ['2026-10-08T21:45:00', false, 'Thu 9:45 PM — closed']
];

let pass = 0, fail = 0;
for (const [iso, wantOpen, desc] of cases) {
  const got = stateAt(iso);
  const ok = got.open === wantOpen;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + (wantOpen ? 'open ' : 'closed') +
    '  got=' + (got.open ? 'open ' : 'closed') +
    '   "' + got.label + '"'
  );
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — badge logic does not match the confirmed hours');
  process.exit(1);
}
console.log('PASS — every boundary matches Sun–Thu 12:00 PM–9:30 PM / Fri–Sat 12:00 PM–10:30 PM');
