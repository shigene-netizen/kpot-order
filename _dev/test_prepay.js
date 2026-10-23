/* Test for the prepayment rule — pay BEFORE the kitchen, on pickup AND
 * delivery.
 *
 * The owner's rule (2026-10-22, final): every PICKUP and every DELIVERY order
 * must be paid before it is sent to the kitchen, and pay-at-counter is not
 * accepted on either. Only a guest sitting at a table may run a tab. The rule
 * started the same day as "$20 and over"; the threshold is gone.
 *
 * The rule has TWO arms, both in server.js, and this test LIFTS THE REAL
 * FUNCTIONS OUT of the source rather than re-implementing them — a
 * re-implementation would only prove the test agrees with itself.
 *
 *   1. THE PAYMENT ARM (counterChannelVerdict). Pay-at-counter is refused on
 *      pickup and delivery at order creation, at ANY total, with or without
 *      an online method, and with no config switch to turn it off.
 *
 *   2. THE KITCHEN ARM (kitchenHold). Whatever the pay method, an order whose
 *      payment is not confirmed cannot reach 'preparing' — not by the kitchen
 *      automation, not by a staff tap. Dine-in is exempt.
 *
 * Getting this wrong is expensive in both directions:
 *   - too permissive → unpaid pickup/delivery food is cooked and never
 *     collected, and the loss is the whole ticket;
 *   - too strict     → dine-in tabs stop working, and a $12 bowl at a table
 *     gets pushed online.
 *
 * Run:  node _dev/test_prepay.js
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

/* kitchenHold() asks the loyalty module what "money is confirmed" means, and
   that definition is deliberately kept in ONE place (customers.js). Lifting
   the real module — not a stub — is what makes this test worth running: if
   isPaidStatus ever stops counting 'paid', this suite goes red. */
const L = require(path.join(ROOT, 'customers.js'));

const ctx = { console, L };
vm.createContext(ctx);
vm.runInContext(
  grab('counterChannelVerdict') + '\n' +
  grab('kitchenHold') + '\n' +
  'this.cv = (payMethod, orderType, extra) => counterChannelVerdict(payMethod, orderType, extra);\n' +
  'this.kh = (order) => kitchenHold(order);',
  ctx
);

const cv = (payMethod, orderType, extra) => ctx.cv(payMethod, orderType, extra);
const kh = (order) => ctx.kh(order);

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
console.log('--- payment arm: pay-at-counter on pickup / delivery (counterChannelVerdict) ---');
/* ========================================================================== */

/* --- the two channels that must prepay, at any total ---------------------- */
check('counter pickup $16.95 → BLOCKED (no threshold any more)',
  cv('counter', 'pickup'), true, 'counter_not_allowed');
check('counter pickup $3.50 → BLOCKED (a small unpaid pickup is still a no-show)',
  cv('counter', 'pickup'), true, 'counter_not_allowed');
check('counter delivery → BLOCKED (it leaves the building)',
  cv('counter', 'delivery'), true, 'counter_not_allowed');
{
  const v = cv('counter', 'pickup');
  const ok = v.channel === 'pickup';
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  the refusal names the channel (pickup)' +
    (ok ? '' : '\n         got channel=' + v.channel));
}
{
  const v = cv('counter', 'delivery');
  const ok = v.channel === 'delivery';
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  the refusal names the channel (delivery)' +
    (ok ? '' : '\n         got channel=' + v.channel));
}

/* --- dine-in is the one channel that may run a tab ------------------------ */
check('counter dine-in → allowed (the guest is in the building)',
  cv('counter', 'dinein'), false);

/* --- there is NO switch --------------------------------------------------- */
/* The old shape had `pickup.prepayOver` (a threshold) and
   `delivery.allowCounter` (a hatch). Both are gone on purpose: a rule that
   only bites above a number lets the expensive order through, and a hatch is
   what somebody flips at 9pm when the card terminal is down — the exact
   moment the rule exists for. Extra arguments are ignored, which is the
   point: no config object can unblock this. */
check('a cfg saying prepayOver: 0 + allowCounter: true cannot unblock it (no switch exists)',
  cv('counter', 'pickup', { pickup: { prepayOver: 0 }, delivery: { allowCounter: true } }),
  true, 'counter_not_allowed');
check('…and the same cfg cannot unblock a delivery either',
  cv('counter', 'delivery', { pickup: { prepayOver: 0 }, delivery: { allowCounter: true } }),
  true, 'counter_not_allowed');

/* --- an unknown order type fails CLOSED ----------------------------------- */
/* A typo in the payload must not become a way to pay cash for a delivery. */
check('counter + unrecognised order type → BLOCKED (fail closed)',
  cv('counter', 'teleport'), true, 'counter_not_allowed');
check('counter + missing order type → BLOCKED (fail closed)',
  cv('counter', undefined), true, 'counter_not_allowed');

/* --- every other pay method is not this rule's business ------------------- */
/* Those orders are held by the kitchen arm instead, if the money is not in. */
check('stripe pickup → allowed by this rule (prepaid by definition)',
  cv('stripe', 'pickup'), false);
check('venmo pickup → allowed by this rule',
  cv('venmo', 'pickup'), false);
check('zelle pickup → allowed by this rule',
  cv('zelle', 'pickup'), false);
check('credit pickup → allowed by this rule (the balance already covered it)',
  cv('credit', 'pickup'), false);
check('unknown method pickup → allowed by this rule',
  cv('teleport', 'pickup'), false);
check('empty method → allowed by this rule',
  cv('', 'pickup'), false);
check('no method at all → allowed by this rule',
  cv(undefined, 'pickup'), false);

/* ========================================================================== */
console.log('\n--- kitchen arm: an unpaid pickup/delivery order held out of the kitchen (kitchenHold) ---');
/* ========================================================================== */

const ord = (total, paymentStatus, orderType) => ({
  orderType: orderType === undefined ? 'pickup' : orderType,
  total: total,
  paymentStatus: paymentStatus
});

/* --- money NOT confirmed: held, whatever the status ----------------------- */
check('pickup $20.12 pending → BLOCKED',
  kh(ord(20.12, 'pending')), true, 'unpaid_before_kitchen');
check('pickup $20.12 unverified → BLOCKED (guest left the tab)',
  kh(ord(20.12, 'unverified')), true, 'unpaid_before_kitchen');
check('pickup $20.12 counter → BLOCKED (a legacy counter order)',
  kh(ord(20.12, 'counter')), true, 'unpaid_before_kitchen');
check('pickup $20.12 unpaid → BLOCKED (Stripe says unpaid)',
  kh(ord(20.12, 'unpaid')), true, 'unpaid_before_kitchen');
check('pickup, unrecognised payment status → BLOCKED (fail closed)',
  kh(ord(20.12, 'teleport')), true, 'unpaid_before_kitchen');
check('pickup, MISSING payment status → BLOCKED (fail closed)',
  kh(ord(20.12, undefined)), true, 'unpaid_before_kitchen');
check('pickup, empty-string payment status → BLOCKED (fail closed)',
  kh(ord(20.12, '')), true, 'unpaid_before_kitchen');

/* --- delivery: the same rule, and it has no dine-in escape hatch ---------- */
check('delivery $30 pending → BLOCKED',
  kh(ord(30, 'pending', 'delivery')), true, 'unpaid_before_kitchen');
check('delivery $8 counter → BLOCKED (below the $10 minimum, still not cookable)',
  kh(ord(8, 'counter', 'delivery')), true, 'unpaid_before_kitchen');
{
  const v = kh(ord(30, 'pending', 'delivery'));
  const ok = v.channel === 'delivery' && v.total === 30;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  the hold names the channel and the total' +
    (ok ? '' : '\n         got channel=' + v.channel + ' total=' + v.total));
}

/* --- the threshold is GONE: a small unpaid order is held too -------------- */
/* This is the check that would have passed under the $20 rule and must fail
   now: $16.95 is under every threshold the shop ever had, and it is still
   food cooked for money that has not arrived. */
check('pickup $16.95 counter → BLOCKED (no threshold to slip under)',
  kh(ord(16.95, 'counter')), true, 'unpaid_before_kitchen');
check('pickup $0.01 pending → BLOCKED (size is irrelevant)',
  kh(ord(0.01, 'pending')), true, 'unpaid_before_kitchen');

/* --- money confirmed: released -------------------------------------------- */
check('pickup verified → allowed (Stripe confirmed)',
  kh(ord(20.12, 'verified')), false);
check('pickup paid → allowed (staff tapped Collected)',
  kh(ord(20.12, 'paid')), false);
check('delivery verified → allowed',
  kh(ord(30, 'verified', 'delivery')), false);
check('delivery paid → allowed',
  kh(ord(30, 'paid', 'delivery')), false);
check('$0.00 credit-covered pickup, verified → allowed (nothing is owed)',
  kh(ord(0, 'verified')), false);

/* --- dine-in is exempt ---------------------------------------------------- */
/* Not a loophole: the guest is at a table, in the building, with staff
   walking past, and the tab is settled at the end by design. */
check('dine-in $100 counter → allowed',
  kh(ord(100, 'counter', 'dinein')), false);
check('dine-in $100 pending → allowed',
  kh(ord(100, 'pending', 'dinein')), false);

/* --- an unknown order type fails CLOSED ----------------------------------- */
check('unrecognised order type, unpaid → BLOCKED (fail closed)',
  kh(ord(100, 'pending', 'teleport')), true, 'unpaid_before_kitchen');
check('missing order type, unpaid → BLOCKED (fail closed)',
  kh(ord(100, 'pending', undefined)), true, 'unpaid_before_kitchen');

/* --- defensive ------------------------------------------------------------ */
check('order null → no crash, allowed',
  kh(null), false);
check('NaN total, unpaid → still BLOCKED (the decision is about the money, not the number)',
  kh(ord(NaN, 'pending')), true, 'unpaid_before_kitchen');

/* ========================================================================== */
console.log('\n--- the shipped config has no switches, and the old ones are really gone ---');
/* ========================================================================== */
/* Comments are stripped first: config.js explains in prose that `prepayOver`
   and `allowCounter` no longer exist, and a naive regex would read that as
   the real settings. */
const configSrc = fs.readFileSync(path.join(ROOT, 'assets', 'config.js'), 'utf8');
const configCode = configSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/\/\/[^\n]*/g, '');        // line comments

function absent(desc, re, code) {
  const found = code.match(re);
  const ok = !found;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    (ok ? '' : '\n         found: ' + found[0]));
}
function present(desc, re, code) {
  const found = code.match(re);
  const ok = !!found;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc);
}

absent('config.js has NO pickup.prepayOver (the threshold is retired)', /prepayOver\s*:/, configCode);
absent('config.js has NO delivery.allowCounter (the hatch is retired)', /allowCounter\s*:/, configCode);
present('config.js still ships the dine-in table-tab ceiling (maxTotal)', /maxTotal\s*:\s*[1-9]/, configCode);

/* The two codes are the contract between the server and the two pages that
   react to a refusal. Pinned here because a rename would otherwise show up
   only as a guest seeing a generic "could not place that order". */
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const boardSrc = fs.readFileSync(path.join(ROOT, 'admin-orders.html'), 'utf8');
present('app.js recovers from counter_not_allowed', /counter_not_allowed/, appSrc);
absent('app.js no longer knows the retired pickup_prepay_required',
  /pickup_prepay_required/, appSrc);
present('the board greys out PREPARING on a held order (kitchenHeld)', /function kitchenHeld\(/, boardSrc);
present('server.js answers the hold with unpaid_before_kitchen', /unpaid_before_kitchen/, src);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
