/* Test for the order-channel gate (pickup / dine-in / delivery).
 *
 * The rule lives in server.js as storeGate(), and the guest page keeps its own
 * copy of the availability check. This test lifts storeGate() out of server.js
 * and pins the combinations down, because getting it wrong has a real cost:
 *   - too permissive → the owner switches Delivery off and the kitchen still
 *     gets delivery tickets;
 *   - too strict → the shop is closed for business while the owner thinks it
 *     is open.
 *
 * Run:  node _dev/test_store_gate.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* Pull the three pure helpers out of server.js. We deliberately do NOT
   re-implement the rule here — a re-implementation would only prove the test
   agrees with itself. */
function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name + '() in server.js');
  /* Walk braces to find the end of the function. */
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unterminated ' + name + '()');
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  'const ORDER_TYPES = ["pickup","dinein","delivery"];\n' +
  'const ORDER_TYPE_LABELS = { pickup:"pickup", dinein:"dine-in", delivery:"delivery" };\n' +
  'let storeStatus = null;\n' +
  grab('orderTypeEnabled') + '\n' +
  grab('hoursClosedNow') + '\n' +
  grab('storeGate') + '\n' +
  'this.setStatus = (s) => { storeStatus = s; };\n' +
  'this.gate = (t, opts) => storeGate(t, opts);\n' +
  'this.enabled = (t) => orderTypeEnabled(t);',
  ctx
);

function status({ open = true, accepting = true, pickup = true, dinein = true, delivery = true }) {
  ctx.setStatus({ open, acceptingOrders: accepting, orderTypes: { pickup, dinein, delivery } });
}
function gate(t, opts) { return ctx.gate(t, opts); }

const ALL_ON = {};
const SPEC = { openMinute: 720, closeSunThu: 1290, closeFriSat: 1350 };

let pass = 0, fail = 0;
function check(desc, got, wantBlocked, wantCode) {
  const ok = got.blocked === wantBlocked && (!wantBlocked || got.code === wantCode);
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + (wantBlocked ? 'BLOCKED(' + wantCode + ')' : 'allowed') +
    '  got=' + (got.blocked ? 'BLOCKED(' + got.code + ')' : 'allowed')
  );
}

/* --- everything on ------------------------------------------------------- */
status(ALL_ON);
check('all channels on · pickup allowed', gate('pickup'), false);
check('all channels on · delivery allowed', gate('delivery'), false);

/* --- one channel off ----------------------------------------------------- */
status({ delivery: false });
check('delivery off · delivery typed at checkout is refused', gate('delivery'), true, 'type_off');
check('delivery off · pickup still fine', gate('pickup'), false);
check('delivery off · dine-in still fine', gate('dinein'), false);
check('delivery off · orderTypeEnabled(delivery) is false', { blocked: !ctx.enabled('delivery') }, true, undefined);

/* --- every channel off --------------------------------------------------- */
status({ pickup: false, dinein: false, delivery: false });
check('all channels off · pickup refused', gate('pickup'), true, 'type_off');
check('all channels off · delivery refused', gate('delivery'), true, 'type_off');

/* --- whole-store switches win the message -------------------------------- */
status({ open: false });
check('store closed · reports "closed", not the channel', gate('pickup'), true, 'closed');
status({ accepting: false });
check('not accepting · reports "not_accepting"', gate('pickup'), true, 'not_accepting');

/* --- unknown / missing type fails CLOSED --------------------------------- */
status(ALL_ON);
check('unknown channel is refused, not allowed', gate('teleport'), true, 'unknown_type');
/* A real browser always sends one of the three. An empty or missing type means
   a malformed request, so it is refused rather than guessed at — "fail closed"
   is the only safe direction for a rule that gates money. */
check('empty type is refused (not silently treated as pickup)', gate(''), true, 'unknown_type');
check('undefined type is refused', gate(undefined), true, 'unknown_type');
check('unknown type via orderTypeEnabled is false', { blocked: !ctx.enabled('teleport') }, true, undefined);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — the order-channel gate does not match the intended rules');
  process.exit(1);
}
console.log('PASS — per-channel switches are enforced, and unknown types fail closed');
