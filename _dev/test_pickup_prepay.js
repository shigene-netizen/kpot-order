/* Test for the pickup prepayment rule — pay BEFORE the kitchen.
 *
 * The owner's rule (2026-10-22): a PICKUP order over a set total must be
 * paid before it is sent to the kitchen. A pickup guest is not in the
 * building, so an unpaid pickup order is food cooked for someone who may
 * never arrive — and the waste scales with the ticket.
 *
 * The rule has TWO arms, deliberately different shapes, and both live in
 * server.js. This test LIFTS THE REAL FUNCTIONS OUT of the source and
 * exercises them directly, rather than re-implementing the rules — a
 * re-implementation would only prove the test agrees with itself.
 *
 *   1. THE PAYMENT ARM (pickupPrepayVerdict). Pay-at-counter is not offered
 *      on a pickup order above the threshold; the guest pays online at
 *      checkout. Like the pay-at-counter ceiling it fails OPEN when no
 *      online method is configured — a shop with no card processing must
 *      still be able to take a large pickup order.
 *
 *   2. THE KITCHEN ARM (pickupKitchenHold). Whatever the pay method, an
 *      unpaid pickup order above the threshold cannot reach 'preparing' —
 *      not by the kitchen automation, not by a staff tap. This arm is
 *      UNCONDITIONAL: it never stops an order from existing, it only holds
 *      the cooking, so there is nothing to fall back to and no outage to
 *      guard against.
 *
 * Getting this wrong is expensive in both directions:
 *   - too permissive → a large unpaid pickup order is cooked and never
 *     collected;
 *   - too strict     → small counter orders (the ones the threshold exists
 *     to protect) stop going straight to the kitchen, and cash customers
 *     are pushed online for a $12 bowl.
 *
 * Run:  node _dev/test_pickup_prepay.js
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
  grab('pickupPrepayOver') + '\n' +
  grab('pickupPrepayVerdict') + '\n' +
  grab('pickupKitchenHold') + '\n' +
  'this.pv = (total, payMethod, orderType, cfg, online) => pickupPrepayVerdict(total, payMethod, orderType, cfg, online);\n' +
  'this.kh = (order, cfg) => pickupKitchenHold(order, cfg);\n' +
  'this.over = (cfg) => pickupPrepayOver(cfg);',
  ctx
);

const pv = (total, payMethod, orderType, cfg, online) => ctx.pv(total, payMethod, orderType, cfg, online);
const kh = (order, cfg) => ctx.kh(order, cfg);
const over = (cfg) => ctx.over(cfg);

/* Config shapes used below. */
const over20 = { pickup: { prepayOver: 20 } };
const noPickup = {};
const ruleOff = { pickup: { prepayOver: 0 } };
const ruleGarbage = { pickup: { prepayOver: 'abc' } };
const ruleNegative = { pickup: { prepayOver: -5 } };
const ruleNull = { pickup: null };

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

/* ========================================================================== */
console.log('--- payment arm: pay-at-counter on a PICKUP order (pickupPrepayVerdict) ---');
/* ========================================================================== */

/* --- under and at the threshold: still allowed ----------------------------- */
check('$16.95 counter pickup, threshold $20 → allowed',
  pv(16.95, 'counter', 'pickup', over20, true), false);
check('$20.00 EXACTLY at the threshold → allowed (the rule is "over", not "at")',
  pv(20, 'counter', 'pickup', over20, true), false);
check('$19.99 just under → allowed',
  pv(19.99, 'counter', 'pickup', over20, true), false);

/* --- over the threshold: refused ------------------------------------------ */
check('$20.01 one cent over → BLOCKED',
  pv(20.01, 'counter', 'pickup', over20, true), true, 'pickup_prepay_required');
check('$20.12 (bowl + fries) → BLOCKED',
  pv(20.12, 'counter', 'pickup', over20, true), true, 'pickup_prepay_required');
check('$50 large pickup order → BLOCKED',
  pv(50, 'counter', 'pickup', over20, true), true, 'pickup_prepay_required');
/* The refusal carries the threshold, so the guest can be told the number. */
{
  const v = pv(50, 'counter', 'pickup', over20, true);
  const ok = v.over === 20;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  the refusal carries the threshold ($20)' +
    (ok ? '' : '\n         got over=' + v.over));
}

/* --- no online alternative: the rule must NOT bite ------------------------ */
/* Otherwise a shop with no card processing would silently stop taking every
   pickup order over the threshold — a self-inflicted outage. The kitchen
   arm below still holds the food, so the no-show risk does not come back. */
check('over the threshold but NO online method → allowed (never lock out large orders)',
  pv(50, 'counter', 'pickup', over20, false), false);

/* --- rule switched off ----------------------------------------------------- */
check('prepayOver 0 → rule off, $50 counter pickup allowed',
  pv(50, 'counter', 'pickup', ruleOff, true), false);
check('prepayOver missing → rule off',
  pv(50, 'counter', 'pickup', noPickup, true), false);
check('prepayOver garbage ("abc") → treated as off',
  pv(50, 'counter', 'pickup', ruleGarbage, true), false);
check('prepayOver negative → treated as off',
  pv(50, 'counter', 'pickup', ruleNegative, true), false);
check('pickup block null → no crash, allowed',
  pv(50, 'counter', 'pickup', ruleNull, true), false);
check('cfg null → no crash, allowed',
  pv(50, 'counter', 'pickup', null, true), false);

/* --- the rule is about the COUNTER on PICKUP only -------------------------- */
/* A prepaid order is paid before the kitchen sees it, so its size is
   irrelevant here — the pay-at-counter ceiling ($30) guards the other
   channels, and it has its own test. */
check('stripe $50 pickup → allowed (already prepaid)',
  pv(50, 'stripe', 'pickup', over20, true), false);
check('venmo $50 pickup → allowed',
  pv(50, 'venmo', 'pickup', over20, true), false);
check('zelle $50 pickup → allowed',
  pv(50, 'zelle', 'pickup', over20, true), false);
check('unknown method $50 pickup → not this rule\'s business (allowed)',
  pv(50, 'teleport', 'pickup', over20, true), false);
check('empty method $50 pickup → allowed by this rule',
  pv(50, '', 'pickup', over20, true), false);
check('dine-in counter $50 → allowed (the guest is in the building)',
  pv(50, 'counter', 'dinein', over20, true), false);
check('delivery counter $50 → allowed by THIS rule (the delivery ban is separate)',
  pv(50, 'counter', 'delivery', over20, true), false);
check('unknown order type counter $50 → allowed by this rule',
  pv(50, 'counter', 'teleport', over20, true), false);

/* --- defensive ------------------------------------------------------------- */
check('NaN total → not blocked (never refuse on a number we cannot read)',
  pv(NaN, 'counter', 'pickup', over20, true), false);

/* ========================================================================== */
console.log('\n--- kitchen arm: an unpaid pickup order held out of the kitchen (pickupKitchenHold) ---');
/* ========================================================================== */

const ord = (total, paymentStatus, orderType) => ({
  orderType: orderType || 'pickup',
  total: total,
  paymentStatus: paymentStatus
});

/* --- over the threshold, money not confirmed: held ------------------------- */
check('$20.12 pickup, paymentStatus pending → BLOCKED',
  kh(ord(20.12, 'pending'), over20), true, 'pickup_awaiting_payment');
check('$20.12 pickup, paymentStatus unverified → BLOCKED (guest left the tab)',
  kh(ord(20.12, 'unverified'), over20), true, 'pickup_awaiting_payment');
check('$20.12 pickup, paymentStatus counter → BLOCKED (legacy counter order)',
  kh(ord(20.12, 'counter'), over20), true, 'pickup_awaiting_payment');
check('$20.12 pickup, paymentStatus unpaid → BLOCKED (Stripe says unpaid)',
  kh(ord(20.12, 'unpaid'), over20), true, 'pickup_awaiting_payment');
check('an unrecognised payment status fails CLOSED → BLOCKED',
  kh(ord(20.12, 'teleport'), over20), true, 'pickup_awaiting_payment');
check('a MISSING payment status fails CLOSED → BLOCKED',
  kh(ord(20.12, undefined), over20), true, 'pickup_awaiting_payment');
/* The hold carries the total and the threshold, so the board can name the
   number it is waiting on. */
{
  const v = kh(ord(20.12, 'pending'), over20);
  const ok = v.total === 20.12 && v.over === 20;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  the hold carries the total ($20.12) and threshold ($20)' +
    (ok ? '' : '\n         got total=' + v.total + ' over=' + v.over));
}

/* --- money confirmed: released -------------------------------------------- */
check('$20.12 pickup, verified → allowed (Stripe confirmed)',
  kh(ord(20.12, 'verified'), over20), false);
check('$20.12 pickup, paid → allowed (staff tapped Collected)',
  kh(ord(20.12, 'paid'), over20), false);

/* --- at and under the threshold: the threshold is doing its job ------------ */
/* A small counter order is exactly the case the owner wants to keep cooking
   on arrival — the rule exists for the big tickets, not for a $12 bowl. */
check('$20.00 EXACTLY at the threshold, unpaid → allowed',
  kh(ord(20, 'pending'), over20), false);
check('$16.95 pickup, unpaid → allowed (small counter orders cook first)',
  kh(ord(16.95, 'counter'), over20), false);
check('$0.00 credit-covered pickup → allowed (nothing is owed)',
  kh(ord(0, 'verified'), over20), false);

/* --- other order types: this rule is pickup-scoped ------------------------- */
check('dine-in $100 unpaid → allowed (the guest is at a table, in the building)',
  kh(ord(100, 'counter', 'dinein'), over20), false);
check('delivery $100 unpaid → allowed by THIS rule (its own doors are elsewhere)',
  kh(ord(100, 'pending', 'delivery'), over20), false);
check('unknown order type $100 unpaid → allowed by this rule',
  kh(ord(100, 'pending', 'teleport'), over20), false);

/* --- rule switched off ----------------------------------------------------- */
check('prepayOver 0 → rule off, unpaid $100 pickup allowed',
  kh(ord(100, 'pending'), ruleOff), false);
check('prepayOver missing → rule off',
  kh(ord(100, 'pending'), noPickup), false);
check('prepayOver garbage → rule off',
  kh(ord(100, 'pending'), ruleGarbage), false);
check('cfg null → rule off',
  kh(ord(100, 'pending'), null), false);

/* --- defensive ------------------------------------------------------------- */
check('order null → no crash, allowed',
  kh(null, over20), false);
check('NaN total → not blocked (never hold on a number we cannot read)',
  kh(ord(NaN, 'pending'), over20), false);

/* ========================================================================== */
console.log('\n--- the shipped config really does set $20 ---');
/* ========================================================================== */
/* Pins the owner's actual decision, so a stray edit to config.js is caught.
   Comments are stripped first: the config's own explanatory comment mentions
   "prepayOver: 0", and a naive regex would read that as the real setting. */
const configSrc = fs.readFileSync(path.join(ROOT, 'assets', 'config.js'), 'utf8');
const configCode = configSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/\/\/[^\n]*/g, '');        // line comments
const m = configCode.match(/pickup:\s*\{[\s\S]*?prepayOver:\s*([0-9.]+)/);
const shipped = m ? Number(m[1]) : null;
const cfgOk = shipped === 20;
if (cfgOk) pass++; else fail++;
console.log((cfgOk ? '  ok  ' : '  FAIL') +
  '  config.js ships pickup.prepayOver = 20 (owner decision)' +
  (cfgOk ? '' : '\n         parsed prepayOver = ' + shipped));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
