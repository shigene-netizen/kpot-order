/* Test for the delivery minimum — the smallest order that earns a driver's trip.
 *
 * The 2-mile rule (geo.js) decides WHERE the shop delivers. This decides HOW
 * BIG an order has to be to be delivered at all: a run across town for a $6
 * bowl loses the shop money, so the owner set a floor (2026-10-19, $10) and
 * the landing page's old "NO MINIMUM" promise was retired with it.
 *
 * Two things make this rule different from its neighbour, the counter
 * ceiling (test_counter_cap.js):
 *
 *  1. It applies to EVERY delivery order, not just pay-at-counter ones — a
 *     delivery is prepaid anyway, so the ceiling's "only unpaid orders" logic
 *     does not apply; the floor is about the RUN, not the risk.
 *
 *  2. It has no "no online fallback" carve-out. The ceiling must relax when
 *     the shop has no card processing, or large orders would be locked out
 *     entirely; the floor is legitimate with or without card payments, so it
 *     simply holds.
 *
 * The rule lives in server.js. This test LIFTS the real function out of the
 * source and exercises it directly — a re-implementation would only prove the
 * test agrees with itself.
 *
 * Run:  node _dev/test_delivery_min.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name + '() in server.js');
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
  grab('deliveryMinVerdict') + '\n' +
  'this.verdict = (subtotal, orderType, cfg) => deliveryMinVerdict(subtotal, orderType, cfg);',
  ctx
);

const verdict = (subtotal, orderType, cfg) => ctx.verdict(subtotal, orderType, cfg);

/* Config shapes used below. min10 is the shipped shape. */
const min10 = { delivery: { minSubtotal: 10 } };
const noMin = { delivery: {} };
const minOff = { delivery: { minSubtotal: 0 } };
const minGarbage = { delivery: { minSubtotal: 'ten dollars' } };
const minNegative = { delivery: { minSubtotal: -10 } };
const minFifteen = { delivery: { minSubtotal: 15 } };

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
/* Field-level check for a refusal: the `short` figure is what the guest is
   told to add, so a rounding slip here is a wrong promise on the screen. */
function checkShort(desc, got, wantShort) {
  const ok = got.blocked && Math.abs(got.short - wantShort) < 1e-9;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want short=' + wantShort + '  got=' + (got.blocked ? got.short : '(not blocked)')
  );
}

/* --- under the floor: refused -------------------------------------------- */
check('delivery $6.00, floor $10 → BLOCKED',
  verdict(6, 'delivery', min10), true, 'delivery_below_minimum');
check('delivery $2.00 → BLOCKED',
  verdict(2, 'delivery', min10), true, 'delivery_below_minimum');
checkShort('delivery $6.00 → short is $4.00',
  verdict(6, 'delivery', min10), 4);
checkShort('delivery $2.50 → short is $7.50',
  verdict(2.5, 'delivery', min10), 7.5);
/* Float money: 10 - 9.99 is 0.010000000000000675 in IEEE754, and a guest
   told to "add $0.010000000000000675" reads as a broken till. */
checkShort('delivery $9.99 → short is exactly $0.01',
  verdict(9.99, 'delivery', min10), 0.01);

/* --- at and above the floor: allowed -------------------------------------- */
/* The floor is a floor, not a wall — exactly at $10 clears it, the same way
   exactly at $30 clears the counter ceiling. */
check('delivery $10.00 EXACTLY at the floor → allowed',
  verdict(10, 'delivery', min10), false);
check('delivery $10.01 one cent over → allowed',
  verdict(10.01, 'delivery', min10), false);
check('delivery $150 large party order → allowed',
  verdict(150, 'delivery', min10), false);

/* --- the floor is about DELIVERY only -------------------------------------- */
check('pickup $2.00 → allowed (this rule is about delivery only)',
  verdict(2, 'pickup', min10), false);
check('dine-in $2.00 → allowed',
  verdict(2, 'dinein', min10), false);
check('unknown type $2.00 → allowed (not delivery, not this rule)',
  verdict(2, 'teleport', min10), false);

/* --- the floor applies to EVERY payment method ----------------------------- */
/* Unlike the counter ceiling there is no payMethod parameter at all: a
   delivery is prepaid (counterDeliveryVerdict bans the other case), so the
   rule cannot depend on how the guest pays. These exist to say so in the
   record — the shape of the signature is the test. */
check('delivery $6.00 with floor $15 → BLOCKED (floor is configurable)',
  verdict(6, 'delivery', minFifteen), true, 'delivery_below_minimum');
check('delivery $12.00 with floor $15 → BLOCKED, short $3.00',
  verdict(12, 'delivery', minFifteen), true, 'delivery_below_minimum');
checkShort('delivery $12.00 with floor $15 → short is $3.00',
  verdict(12, 'delivery', minFifteen), 3);

/* --- floor switched off ---------------------------------------------------- */
check('minSubtotal 0 → no floor, $6 delivery allowed',
  verdict(6, 'delivery', minOff), false);
check('minSubtotal missing → no floor, $6 delivery allowed',
  verdict(6, 'delivery', noMin), false);
check('minSubtotal garbage ("ten dollars") → treated as no floor',
  verdict(6, 'delivery', minGarbage), false);
check('minSubtotal negative → treated as no floor',
  verdict(6, 'delivery', minNegative), false);
check('delivery block missing entirely → no crash, allowed',
  verdict(6, 'delivery', { payment: {} }), false);
check('cfg null → no crash, allowed',
  verdict(6, 'delivery', null), false);

/* --- defensive ------------------------------------------------------------- */
check('NaN subtotal → not blocked (never refuse on a number we cannot read)',
  verdict(NaN, 'delivery', min10), false);

/* --- the shipped config really does set $10 -------------------------------- */
/* Pins the owner's actual decision so a stray edit to config.js is caught.
   Comments are stripped first: the config's own explanatory comment mentions
   "minSubtotal: 10", and a naive regex would read the comment as the value. */
const configSrc = fs.readFileSync(path.join(ROOT, 'assets', 'config.js'), 'utf8');
const configCode = configSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/\/\/[^\n]*/g, '');        // line comments
const m = configCode.match(/minSubtotal:\s*([0-9.]+)/);
const shipped = m ? Number(m[1]) : null;
const cfgOk = shipped === 10;
if (cfgOk) pass++; else fail++;
console.log((cfgOk ? '  ok  ' : '  FAIL') +
  '  config.js ships delivery.minSubtotal = 10 (owner decision 2026-10-19)' +
  (cfgOk ? '' : '\n         parsed minSubtotal = ' + shipped));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
