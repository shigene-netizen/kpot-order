/* Loyalty rules: phone identity, points, stamps, come-back coupons, redemption.
 *
 * Three things are worth pinning down here, because each one is a way to hand
 * out money that was not meant to be handed out:
 *
 *   - IDENTITY. The phone number is the whole account. normalizePhone() being
 *     loose ("keep the last ten digits") would map a mistyped 11-digit number
 *     onto a stranger's balance, and points would land in the wrong ledger.
 *     It must REJECT, not guess.
 *   - THE BASE. Points are earned on food, not on the bill: no tax, no tip, and
 *     the DISCOUNTED subtotal — otherwise redeeming points would earn points
 *     back on the money those points just saved.
 *   - IDEMPOTENCY. Awarding is guarded by the ORDER, and the stamp milestone by
 *     a COUNTER, not by "is settledOrders a multiple of 10". Either way a
 *     Re-check, a second Stripe callback or a repeated staff PATCH pays twice.
 *
 * These are the RULES. That the server actually calls them, that a counter
 * order earns nothing until staff tap Collected, and that a cancelled order
 * gets its reward back, is _dev/probe_loyalty.js's job — a correct function
 * nobody calls is the classic silent failure.
 *
 * Run:  node _dev/test_loyalty.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const L = require(path.join(ROOT, 'customers.js'));

/* Two clocks on purpose. awardForOrder()/makeCoupon() PARSE their `now` argument
   and hand it to Date.parse(), so they need an ISO string; isExpired()/isUsable()
   compare it against Date.parse(expiresAt), so they need a number. Passing the
   wrong one is how a come-back coupon ends up with expiresAt "Invalid Date"
   and quietly never expires. */
const NOW = '2026-10-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + JSON.stringify(want) + '  got=' + JSON.stringify(got));
}
function ok(desc, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + desc +
    (cond ? '' : '\n         ' + (detail || '')));
}

/* ========================================================================== */
/* 1. Phone normalisation — the whole feature stands on this                   */
/* ========================================================================== */

console.log('\n--- 1. phone identity ---');
check('"+1 (678) 335-5388" -> 6783355388', L.normalizePhone('+1 (678) 335-5388'), '6783355388');
check('"  678-335-5388  " -> same guest', L.normalizePhone('  678-335-5388  '), '6783355388');
check('"16783355388" -> the single leading 1 is dropped',
  L.normalizePhone('16783355388'), '6783355388');
check('a bare 10-digit number is kept verbatim', L.normalizePhone('6783355388'), '6783355388');
check('an 11-digit number NOT starting with 1 is refused',
  L.normalizePhone('26783355388'), null);
check('9 digits is refused, not padded', L.normalizePhone('678335538'), null);
check('7 digits is refused', L.normalizePhone('335-5388'), null);
check('nothing is refused', L.normalizePhone(''), null);
check('null is refused', L.normalizePhone(null), null);
check('letters only are refused', L.normalizePhone('call me'), null);
check('an 11-digit number starting with 1 carries a country code',
  L.normalizePhone('11678335538'), '1678335538');
check('a genuine 12-digit number is refused', L.normalizePhone('111678335538'), null);

/* The centre of the design: a number we cannot read confidently is dropped
   rather than trimmed into shape, because a WRONG guest's balance is not
   recoverable while an unrecognised guest simply earns nothing. */
ok('every refused number returns null, never a guess',
  [L.normalizePhone('111'), L.normalizePhone('0000000000000000'),
    L.normalizePhone('+44 20 7946 0958'), L.normalizePhone('12345')]
    .every((x) => x === null));

/* ========================================================================== */
/* 2. Name masking — a guest must recognise themselves without the endpoint    */
/*    doubling as a name-harvester                                            */
/* ========================================================================== */

console.log('\n--- 2. name masking ---');
check('"Bob Smith" -> "Bob S."', L.maskName('Bob Smith'), 'Bob S.');
check('a single name is kept whole', L.maskName('Bob'), 'Bob');
check('three names -> first + last initial', L.maskName('Mary Jane Watson'), 'Mary W.');
check('surrounding whitespace is collapsed', L.maskName('  Bob   Smith '), 'Bob S.');
check('empty -> empty', L.maskName(''), '');
check('null -> empty', L.maskName(null), '');

/* ========================================================================== */
/* 3. The points base                                                        */
/* ========================================================================== */

console.log('\n--- 3. what a point is earned on ---');
check('subtotal alone', L.pointsBaseFor({ subtotal: 15.99 }), 15.99);
check('subtotal + delivery', L.pointsBaseFor({ subtotal: 15.99, delivery: 4.99 }), 20.98);
check('subtotal - discount', L.pointsBaseFor({ subtotal: 15.99, discountAmount: 5 }), 10.99);
check('subtotal + delivery - discount',
  L.pointsBaseFor({ subtotal: 15.99, delivery: 4.99, discountAmount: 5 }), 15.98);
/* Tax is the government's money and a tip is the guest's gift to the staff. */
check('tax is NOT earned on',
  L.pointsBaseFor({ subtotal: 15.99, tax: 0.96, tip: 3 }), 15.99);
check('a missing order is worth nothing', L.pointsBaseFor(null), 0);
check('an empty object is worth nothing', L.pointsBaseFor({}), 0);

check('$15.99 of food -> 15 points', L.pointsFor({ subtotal: 15.99 }), 15);
check('$100 with $5 redeemed -> 95 points (no points on redeemed money)',
  L.pointsFor({ subtotal: 100, discountAmount: 5 }), 95);
check('a $0 order earns 0', L.pointsFor({ subtotal: 0 }), 0);
check('a negative order earns 0, never negative points', L.pointsFor({ subtotal: -50 }), 0);

console.log('\n--- 4. when is money confirmed ---');
ok('stripe verified counts', L.isPaidStatus('verified'));
ok('staff-marked paid counts', L.isPaidStatus('paid'));
ok('a counter order awaiting collection does not', !L.isPaidStatus('counter'));
ok('a pending online order does not', !L.isPaidStatus('pending'));
ok('nothing does not', !L.isPaidStatus(undefined));
ok('an empty string does not', !L.isPaidStatus(''));

/* ========================================================================== */
/* 5. Earning                                                                 */
/* ========================================================================== */

console.log('\n--- 5. earning ---');

/* A plain order: $15.99 of food, nothing off. */
const order = (id, subtotal, extra) => Object.assign({
  id, subtotal, delivery: 0, discountAmount: 0, loyalty: {}
}, extra || {});

const c1 = L.blankCustomer('6783355388');
const o1 = order('KP-1', 15.99);
const first = L.awardForOrder(c1, o1, NOW);
ok('the first order reports a change', first.changed === true);
check('the first order earns 15 points', first.points, 15);
/* The come-back coupon is ON (see the header note in customers.js). It is the
   ONE reward that carries a date — that is its whole job: pull the guest back
   within a fortnight. The promise the owner actually cares about is that
   POINTS and STAMP rewards never expire, so that difference is pinned down
   here rather than blurred. */
check('and a come-back coupon rides along with the first order', first.coupons.length, 1);
check('of the kind that is meant to expire', first.coupons[0].kind, 'return');
ok('and it does carry an end date', !!Date.parse(first.coupons[0].expiresAt));
check('the balance is 15', c1.points, 15);
check('the lifetime total is 15', c1.lifetimePoints, 15);
check('settled orders is 1', c1.settledOrders, 1);
check('no stamp yet (10 orders is the milestone)', c1.stampsIssued, 0);
ok('and the POINTS BALANCE carries no expiry of its own to be forgotten',
  c1.expiresAt === undefined && c1.pointsExpireAt === undefined);
ok('the earn is logged', c1.log.some((e) => e.kind === 'earn' && e.delta === 15));

/* ---- Idempotency is per-ORDER, not per-guest ----
   The SAME order object is awarded twice — exactly what a Re-check, a second
   Stripe callback or a repeated staff PATCH does. No flag is set by hand here:
   awardForOrder() has to refuse on its own. */
const again = L.awardForOrder(c1, o1, NOW + 'x'.length && NOW); /* the same order, seconds later */
ok('a re-award of the SAME order is refused', again.changed === false);
check('and says why', again.reason, 'already_awarded');
check('the balance did not move', c1.points, 15);
check('and no SECOND coupon appeared on the re-award', c1.coupons.length, 1);
check('settled orders still 1', c1.settledOrders, 1);

/* A SECOND, DIFFERENT order still pays — the guard is the order, not a
   one-per-guest latch. */
const second = L.awardForOrder(c1, order('KP-2', 20), NOW);
check('a different order still earns', second.points, 20);
check('balance is now 35', c1.points, 35);
check('settled orders is 2', c1.settledOrders, 2);

/* ---- The stamp milestone pays against a COUNTER ---- */
const c10 = L.blankCustomer('6783355388');
for (let i = 1; i <= 10; i++) L.awardForOrder(c10, order('KP-' + i, 10), NOW);
check('after 10 orders the milestone is due once', c10.stampsIssued, 1);
check('and one $10 stamp reward exists',
  c10.coupons.filter((c) => c.kind === 'stamp').length, 1);
check('the stamp reward is worth $7',
  c10.coupons.find((c) => c.kind === 'stamp').value, 7);
ok('a stamp reward does not rot',
  c10.coupons.find((c) => c.kind === 'stamp').expiresAt === null);
check('and exactly one come-back coupon on the wallet',
  c10.coupons.filter((c) => c.kind === 'return').length, 1);
ok('and ONLY the come-back coupon expires — every stamp reward keeps',
  c10.coupons.filter((c) => c.kind === 'stamp').every((c) => !c.expiresAt) &&
  c10.coupons.filter((c) => c.kind === 'return').every((c) => !!c.expiresAt));

/* 20 orders -> exactly 2 rewards, never a third. */
const c20 = L.blankCustomer('6783355388');
for (let i = 1; i <= 20; i++) L.awardForOrder(c20, order('KP-' + i, 10), NOW);
check('after 20 orders exactly two stamp rewards', c20.stampsIssued, 2);
check('and two stamp coupons on the ledger',
  c20.coupons.filter((c) => c.kind === 'stamp').length, 2);

/* The trap this avoids: "is settledOrders a multiple of 10" would mint a
   second reward for the same milestone once the counter is touched. */
const cDup = L.blankCustomer('6783355388');
for (let i = 1; i <= 10; i++) L.awardForOrder(cDup, order('KP-' + i, 10), NOW);
cDup.settledOrders = 10;                       /* staff re-enters the same count */
L.awardForOrder(cDup, order('KP-99', 10), NOW); /* an 11th order */
check('a re-entered milestone counter mints nothing extra', cDup.stampsIssued, 1);

/* ---- Points never expire -------------------------------------------------
   The owner's rule, stated once and pinned here: a balance sits on the ledger
   until the guest spends it, however long they are away. There is no expiry
   field on a points balance to be forgotten, and redemption is driven by the
   BALANCE, not by when any of it was earned. */
const cDormant = L.blankCustomer('6783355388');
L.awardForOrder(cDormant, order('KP-old', 120), NOW);
check('the balance is banked', cDormant.points, 120);
const THREE_YEARS = NOW_MS + 3 * 365 * DAY;
check('a balance untouched for three years is still there',
  L.publicView(cDormant, 20, THREE_YEARS).points, 120);
ok('and it still buys the reward it always did',
  !!L.pointsRedemption(cDormant, 20, THREE_YEARS));
check('the shipped come-back rule is ON', L.RETURN_VALUE, 3);
check('and the storefront is told so', L.rules().returnValue, 3);
check('the come-back coupon lives 7 days', L.RETURN_DAYS, 7);
check('and only spawns from an order of $10 or more', L.RETURN_MIN_SUBTOTAL, 10);

/* The threshold, proved rather than assumed. $9.99 of food is a drink and a
   side, not a meal; $10.00 exactly is the deal. And the measurement is the
   order's OWN subtotal before rewards — see the discount case below. */
const cThresh = L.blankCustomer('6783355388');
L.awardForOrder(cThresh, order('KP-9-99', 9.99), NOW);
check('a $9.99 order earns no come-back coupon',
  cThresh.coupons.filter((c) => c.kind === 'return').length, 0);
L.awardForOrder(cThresh, order('KP-10-00', 10), NOW);
check('a $10 order earns exactly one',
  cThresh.coupons.filter((c) => c.kind === 'return').length, 1);
check('and it is worth $3',
  cThresh.coupons.find((c) => c.kind === 'return').value, 3);
L.awardForOrder(cThresh, order('KP-25', 25), NOW);
check('a bigger order still earns only one — the newest replaces the unused one',
  cThresh.coupons.filter((c) => c.kind === 'return').length, 1);

/* A guest who spends POINTS on the same order must not lose their coupon for
   it: the order's subtotal is stored gross, so a $14 basket discounted down
   to $4 still clears the threshold and still earns one. */
const cDisc = L.blankCustomer('6783355388');
const discounted = order('KP-D1', 14);
discounted.discountAmount = 10;            /* points or a code took $10 off */
L.awardForOrder(cDisc, discounted, NOW);
check('an order discounted down to $4 still earns the coupon',
  cDisc.coupons.filter((c) => c.kind === 'return').length, 1);

/* An order under the line is not rescued by a big tip or a big tax bill: the
   threshold is about the food, which is what the kitchen actually cooks. */
const cSmall = L.blankCustomer('6783355388');
const tiny = order('KP-T1', 4);
tiny.tip = 20;
tiny.tax = 3;
L.awardForOrder(cSmall, tiny, NOW);
check('a $4 order with a $20 tip earns no coupon',
  cSmall.coupons.filter((c) => c.kind === 'return').length, 0);

/* Whatever the rule is set to, a coupon a guest was ALREADY given keeps
   working inside its own window and still expires when its own date passes —
   changing a rule must never confiscate or resurrect a coupon in someone's
   wallet. 'return' therefore stays a legal kind no matter what the rule says. */
const cLegacy = L.blankCustomer('6783355388');
const legacy = L.makeCoupon('return', 5, '$5 off — come back within 14 days', 'KP-L', NOW);
cLegacy.coupons.push(legacy);
ok('a legacy come-back coupon still redeems inside its window',
  !!L.couponRedemption(cLegacy, legacy.id, 20, NOW_MS));
ok('and still refuses once its own date has passed',
  L.couponRedemption(cLegacy, legacy.id, 20, NOW_MS + 15 * DAY) === null);
check('and it survives a round-trip through the ledger normaliser',
  L.normalizeCustomer(cLegacy).coupons.length, 1);

/* ---- Ceilings ---- */
const cMax = L.blankCustomer('6783355388');
for (let i = 0; i < L.MAX_COUPONS; i++) {
  cMax.coupons.push(L.makeCoupon('stamp', 10, 'stamp ' + i, 'KP-seed', NOW));
}
/* Drive the counter to the milestone so a reward really IS due — with a full
   wallet it must be DEFERRED (the counter does not advance past it), not
   silently lost and not allowed to blow past the ceiling. */
for (let i = 0; i < 9; i++) L.awardForOrder(cMax, order('KP-f' + i, 1), NOW);
L.awardForOrder(cMax, order('KP-X', 12), NOW);
check('a full coupon wallet takes no new reward',
  cMax.coupons.length, L.MAX_COUPONS);
check('and the milestone is deferred, not marked as issued', cMax.stampsIssued, 0);
check('but points are still earned', cMax.points, 21);
check('and the orders still count', cMax.settledOrders, 10);

/* ---- No customer, no award ---- */
check('awarding to nobody changes nothing',
  L.awardForOrder(null, order('KP-1', 10), NOW).changed, false);
check('awarding a nothing order changes nothing',
  L.awardForOrder(c1, null, NOW).changed, false);

/* ========================================================================== */
/* 6. Spending — what may come off a bill                                     */
/* ========================================================================== */

console.log('\n--- 6. redemption ---');

const wallet = (points, coupons) => {
  const c = L.blankCustomer('6783355388');
  c.points = points;
  c.lifetimePoints = points;
  if (coupons) c.coupons = coupons;
  return c;
};

/* 250 points, $15.99 order: affordable = 2 blocks, allowed = 1 — and ONE block
   per order is the owner's rule, so the smaller of the three wins. */
const pr = L.pointsRedemption(wallet(250), 15.99, NOW_MS);
check('250 points on a $15.99 order -> 1 block only', pr.steps, 1);
check('costs 100 points', pr.points, 100);
check('worth $10', pr.value, 10);
check('and says so', pr.label, '100 points');

/* The cap is not about the balance or the bill: 900 points on a $500 order is
   still ONE redemption, because "one reward per order" is a rule, not a
   consequence of either number. */
const big = L.pointsRedemption(wallet(900), 500, NOW_MS);
check('900 points on a $500 order is still one block', big.steps, 1);
check('and the other 800 points are still the guest\'s', big.points, 100);

/* A guest with too FEW points cannot redeem at any order size. */
check('99 points on a big order -> nothing', L.pointsRedemption(wallet(99), 500, NOW_MS), null);
check('150 points on a $3 order -> nothing (too small)', L.pointsRedemption(wallet(150), 3, NOW_MS), null);
check('250 points on a $4.99 order -> nothing (too small)', L.pointsRedemption(wallet(250), 4.99, NOW_MS), null);
check('a $0 order redeems nothing', L.pointsRedemption(wallet(5000), 0, NOW_MS), null);

/* Exactly one block is allowed — but a $10 reward can only come off a bill of
   $10 or more, so a $5 order redeems nothing at all rather than clamping. */
const one = L.pointsRedemption(wallet(150), 5, NOW_MS);
check('150 points on a $5 order -> nothing (a $10 reward will not fit)', one, null);
const exact = L.pointsRedemption(wallet(150), 10, NOW_MS);
check('but on exactly $10 it fits, one block', exact.steps, 1);
check('worth $10', exact.value, 10);
check('a big balance cannot overshoot a small bill',
  L.pointsRedemption(wallet(5000), 12.99, NOW_MS).value, 10);
check('no customer -> nothing', L.pointsRedemption(null, 100, NOW_MS), null);

/* ---- Coupons ---- */
const strike = L.makeCoupon('stamp', 7, '$7 reward — 10 orders', 'KP-1', NOW);
const cb = L.makeCoupon('return', 3, '$3 off — come back within 7 days', 'KP-1', NOW);
const cw = wallet(0, [strike, cb]);

const useStrike = L.couponRedemption(cw, strike.id, 15.99, NOW_MS);
check('a $7 reward on a $15.99 order is worth $7', useStrike.value, 7);
check('and carries its label', useStrike.label, '$7 reward — 10 orders');
/* Clamped to the bill: a $10 reward on a $3 order takes off $3, not $10. */
check('a $7 reward on a $3 order is clamped to $3',
  L.couponRedemption(cw, strike.id, 3, NOW_MS).value, 3);
check('a $7 reward on a $10 order is worth exactly $7',
  L.couponRedemption(cw, strike.id, 10, NOW_MS).value, 7);
check('an unknown id redeems nothing', L.couponRedemption(cw, 'cp_nope', 20, NOW_MS), null);

const spent = L.makeCoupon('return', 5, 'spent', 'KP-0', NOW);
spent.usedAt = NOW;
check('a used coupon redeems nothing',
  L.couponRedemption(wallet(0, [spent]), spent.id, 20, NOW_MS), null);
const rotten = L.makeCoupon('return', 5, 'old', 'KP-0', NOW);
check('an expired coupon redeems nothing',
  L.couponRedemption(wallet(0, [rotten]), rotten.id, 20, NOW_MS + 15 * DAY), null);
check('no coupon id -> nothing', L.couponRedemption(cw, '', 20, NOW_MS), null);
check('no customer -> nothing', L.couponRedemption(null, strike.id, 20, NOW_MS), null);

/* ---- ONE reward per order ---- */
console.log('\n--- 7. one reward per order ---');
const both = L.resolveRedemption(wallet(250), { redeemPoints: true, couponId: strike.id }, 15.99, NOW_MS);
check('points AND a coupon together -> refused', both.error, 'one_reward_only');
ok('and the message says so', /either/i.test(both.message), both.message);

/* Two different reasons used to wear the same "no". A guest with 300 points
   told "you do not have enough" over a $3 order would go to the counter and
   argue about it. */
const lowBal = L.resolveRedemption(wallet(50), { redeemPoints: true }, 100, NOW_MS);
check('a low balance is its own error', lowBal.error, 'points_unavailable');
ok('and names the balance they DO have', /50/.test(lowBal.message), lowBal.message);
const small = L.resolveRedemption(wallet(150), { redeemPoints: true }, 3, NOW_MS);
check('a too-small order is its own error', small.error, 'order_too_small');
ok('and explains the $10 floor', /\$10/.test(small.message), small.message);

const goodP = L.resolveRedemption(wallet(250), { redeemPoints: true }, 15.99, NOW_MS);
check('a good points request resolves', goodP.redemption.kind, 'points');
const goodC = L.resolveRedemption(cw, { couponId: cb.id }, 15.99, NOW_MS);
check('a good coupon request resolves', goodC.redemption.kind, 'coupon');
const noCoupon = L.resolveRedemption(cw, { couponId: 'cp_gone' }, 15.99, NOW_MS);
check('an unavailable coupon is its own error', noCoupon.error, 'coupon_unavailable');
check('asking for nothing resolves to none', L.resolveRedemption(cw, {}, 15.99, NOW_MS).none, true);
check('a null request resolves to none', L.resolveRedemption(cw, null, 15.99, NOW_MS).none, true);

console.log('\n--- 8. a reward is just a discount ---');
const d1 = L.toDescriptor(goodP.redemption);
check('a points redemption becomes an amount discount', d1.type, 'amount');
check('worth the computed value', d1.value, 10);
check('marked as loyalty, not a code', d1.source, 'loyalty');
check('and labelled in points', d1.label, 'Points redeemed (100)');
const d2 = L.toDescriptor(goodC.redemption);
check('a coupon redemption keeps its own label', d2.label, '$3 off — come back within 7 days');
check('no descriptor for no redemption', L.toDescriptor(null), null);

/* ========================================================================== */
/* 9. Taking it out, and putting it back                                      */
/* ========================================================================== */

console.log('\n--- 9. commit and release ---');

const cc = wallet(250);
check('committing 200 points succeeds',
  L.commitRedemption(cc, { kind: 'points', points: 200 }, 'KP-9', NOW), true);
check('the balance is now 50', cc.points, 50);
check('the redemption is logged', cc.log.some((e) => e.kind === 'redeem' && e.delta === -200), true);
check('committing nothing fails', L.commitRedemption(cc, null, 'KP-9', NOW), false);

const ck = wallet(0, [L.makeCoupon('return', 5, 'cb', 'KP-0', NOW)]);
const ckId = ck.coupons[0].id;
check('committing a coupon succeeds',
  L.commitRedemption(ck, { kind: 'coupon', couponId: ckId }, 'KP-9', NOW), true);
ok('the coupon is marked used', ck.coupons[0].usedAt === NOW);
check('on this order', ck.coupons[0].usedOn, 'KP-9');
check('the same coupon cannot be committed twice',
  L.commitRedemption(ck, { kind: 'coupon', couponId: ckId }, 'KP-10', NOW), false);

/* ---- Release: a cancelled order never collected the money ---- */
const rc = wallet(50);
const rcOrder = { id: 'KP-C', loyalty: { redeemed: { kind: 'points', points: 200 } } };
check('cancelling returns the points',
  L.releaseRedemption(rc, rcOrder, NOW), true);
check('balance is back to 250', rc.points, 250);
check('and the refund is logged', rc.log.some((e) => e.kind === 'refund' && e.delta === 200), true);
check('a second cancellation returns nothing',
  L.releaseRedemption(rc, rcOrder, NOW + 1000), false);
check('the balance was not touched again', rc.points, 250);

const rk = wallet(0, [L.makeCoupon('return', 5, 'cb', 'KP-0', NOW)]);
rk.coupons[0].usedAt = NOW;
rk.coupons[0].usedOn = 'KP-C';
const rkOrder = { id: 'KP-C', loyalty: { redeemed: { kind: 'coupon', couponId: rk.coupons[0].id } } };
check('cancelling un-marks the coupon', L.releaseRedemption(rk, rkOrder, NOW), true);
ok('the coupon is usable again', rk.coupons[0].usedAt === null && rk.coupons[0].usedOn === '');
ok('and it keeps its original expiry (the guest cannot refresh a 14-day coupon)',
  rk.coupons[0].expiresAt !== null);

/* A coupon used on a DIFFERENT order is not this one's to return. */
const wrong = wallet(0, [L.makeCoupon('return', 5, 'cb', 'KP-0', NOW)]);
wrong.coupons[0].usedAt = NOW;
wrong.coupons[0].usedOn = 'KP-OTHER';
check('a coupon spent elsewhere is not returned',
  L.releaseRedemption(wrong, { id: 'KP-C', loyalty: { redeemed: { kind: 'coupon', couponId: wrong.coupons[0].id } } }, NOW), false);
check('nothing to release on a plain order', L.releaseRedemption(wallet(0), { id: 'KP-C' }, NOW), false);
check('a released flag alone releases nothing',
  L.releaseRedemption(wallet(0), { id: 'KP-C', loyalty: { released: true } }, NOW), false);

/* ========================================================================== */
/* 10. Normalisation — the file is attacker-adjacent, not trusted              */
/* ========================================================================== */

console.log('\n--- 10. reading the file back ---');

check('a phone in the file is normalised too',
  L.normalizeCustomer({ phone: '+1 678 335 5388', points: 7 }).phone, '6783355388');
check('points are read as a positive integer',
  L.normalizeCustomer({ phone: '6783355388', points: '25' }).points, 25);
check('a negative balance is clamped to 0, never kept',
  L.normalizeCustomer({ phone: '6783355388', points: -40 }).points, 0);
check('a nonsense balance is 0', L.normalizeCustomer({ phone: '6783355388', points: 'lots' }).points, 0);
check('a fractional balance is floored', L.normalizeCustomer({ phone: '6783355388', points: 12.9 }).points, 12);
check('a record with no phone is dropped', L.normalizeCustomer({ points: 5 }), null);
check('a record with a bad phone is dropped', L.normalizeCustomer({ phone: '123', points: 5 }), null);
check('a non-record is dropped', L.normalizeCustomer('nope'), null);
check('nothing is dropped', L.normalizeCustomer(null), null);

const messy = L.normalizeCustomer({
  phone: '6783355388',
  name: 'x'.repeat(200),
  coupons: [
    { kind: 'return', value: 5 },
    { kind: 'teleport', value: 9 },
    { kind: 'return', value: 0 },
    { kind: 'return', value: -3 },
    null,
    'garbage'
  ],
  log: [{ at: '2026-10-01', kind: 'earn', delta: 5, note: 'ok' }]
});
check('a long name is truncated', messy.name.length, 80);
check('only well-formed coupons survive', messy.coupons.length, 1);
check('the surviving coupon is the $5 one', messy.coupons[0].value, 5);
check('log entries are normalised', messy.log.length, 1);

const seeded = [];
for (let i = 0; i < L.MAX_COUPONS + 6; i++) seeded.push({ kind: 'stamp', value: 5 });
check('an oversized coupon wallet is trimmed to the ceiling',
  L.normalizeCustomer({ phone: '6783355388', coupons: seeded }).coupons.length, L.MAX_COUPONS);

/* ---- Persistence round-trip ---- */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-loyalty-logic-'));
const file = path.join(SCRATCH, 'customers.local.json');
try {
  const list = [];
  const a = L.ensure(list, '(678) 335-5388', NOW);
  ok('ensure creates a member for a readable phone', !!a);
  check('under the normalised phone', a.phone, '6783355388');
  ok('ensure is idempotent', L.ensure(list, '678-335-5388', NOW) === a);
  check('a bad phone creates nothing', L.ensure(list, '555', NOW), null);
  check('the list still has one member', list.length, 1);
  check('find locates a member', L.find(list, '16783355388').phone, '6783355388');
  check('find misses an unknown number', L.find(list, '4045551234'), null);

  L.touch(a, 'Bob Smith', NOW);
  check('touch records the name', a.name, 'Bob Smith');
  ok('touch records lastSeenAt', typeof a.lastSeenAt === 'string');
  L.touch(a, '', NOW + DAY);
  check('an empty name does not erase the stored one', a.name, 'Bob Smith');
  a.points = 42;
  L.saveCustomers(file, list);
  const back = L.loadCustomers(file);
  ok('a saved ledger loads back', back.loaded === true);
  check('with the same member count', back.customers.length, 1);
  check('and the same balance', back.customers[0].points, 42);
  check('and the same phone', back.customers[0].phone, '6783355388');

  fs.writeFileSync(file, 'not json at all');
  const broken = L.loadCustomers(file);
  check('a corrupt file starts empty rather than crashing', broken.customers.length, 0);
  check('and says it loaded nothing', broken.loaded, false);
  const missing = L.loadCustomers(path.join(SCRATCH, 'absent.json'));
  check('a missing file starts empty', missing.customers.length, 0);
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
}

/* ========================================================================== */
/* 11. Views                                                                  */
/* ========================================================================== */

console.log('\n--- 11. views ---');

const empty = L.publicView(null, null, NOW_MS);
check('a stranger sees found:false', empty.found, false);
check('with zero points', empty.points, 0);
check('and no coupons', empty.coupons.length, 0);
check('and the rules', empty.rules.stampEvery, 10);
check('and an empty stamp card', empty.stamps.toNext, 10);

const member = wallet(250, [strike, cb, spent]);
member.name = 'Bob Smith';
member.settledOrders = 1;              /* one order into a 10-order cycle */
const pv = L.publicView(member, 15.99, NOW_MS);
check('a member sees found:true', pv.found, true);
check('their real balance', pv.points, 250);
check('only their USABLE coupons', pv.coupons.length, 2);
ok('a used coupon is hidden', pv.coupons.every((c) => c.id !== spent.id));
check('the name is masked to the first name and last initial', pv.name, 'Bob S.');
ok('the redemption offer rides along', pv.pointsRedemption && pv.pointsRedemption.value === 10);
check('the stamp card shows progress into the cycle', pv.stamps.into, 1);
check('with 9 to go', pv.stamps.toNext, 9);

member.settledOrders = 20;
check('a completed cycle says 10 to go, not 0',
  L.publicView(member, null, NOW_MS).stamps.toNext, 10);
check('no subtotal -> no redemption offer', L.publicView(member, null, NOW_MS).pointsRedemption, null);

/* The public view must never leak the ledger. */
const leak = JSON.stringify(L.publicView(member, 15.99, NOW_MS));
ok('the public view carries no raw log', leak.indexOf('"log"') === -1);
ok('and no settled order ids', leak.indexOf('settledOrderIds') === -1);
ok('and no lifetime total', leak.indexOf('lifetimePoints') === -1);

const av = L.adminView(member);
ok('the owner view carries the same coupons', av.coupons.length === member.coupons.length);
ok('and the full name', typeof av.name === 'string');

console.log('\n--- 12. the export ---');
const csv = L.toCsv([member], NOW_MS);
ok('the CSV starts with a BOM so Excel reads it as UTF-8', csv.charCodeAt(0) === 0xFEFF);
ok('uses CRLF line endings', csv.indexOf('\r\n') !== -1);
check('and has one row per member plus a header', csv.split('\r\n').filter((x) => x).length, 2);
ok('the header names the columns', csv.indexOf('phone,name,email,points,') !== -1);
ok('the phone is in the row', csv.indexOf('6783355388') !== -1);
/* Column order is CSV_COLUMNS. It gained `email` and `devices` when the
   rewards scheme grew a credential, so this index moved — a bare number here
   is exactly the kind of thing that silently starts reading the wrong column. */
const csvCols = csv.split('\r\n')[0].split(',');
check('the unused-coupon column counts only usable ones',
  csv.split('\r\n')[1].split(',')[csvCols.indexOf('unusedCoupons')], '2');
check('and the address and device count are exported too',
  csvCols.indexOf('email') + '|' + csvCols.indexOf('devices'), '2|8');

/* A spreadsheet must not be talked into treating a name as a formula. */
const evil = L.toCsv([Object.assign(L.blankCustomer('6783355388'), { name: '=SUM(1+1)' })], NOW_MS);
ok('a name starting with = is quoted', evil.indexOf('"=SUM(1+1)"') !== -1, evil);
const comma = L.toCsv([Object.assign(L.blankCustomer('6783355388'), { name: 'Smith, Bob' })], NOW_MS);
ok('a name containing a comma is quoted', comma.indexOf('"Smith, Bob"') !== -1, comma);
check('an empty ledger still exports a header', L.toCsv([], NOW_MS).split('\r\n').filter((x) => x).length, 1);

/* ========================================================================== */
/* 13. The rules are published, not buried                                    */
/* ========================================================================== */

console.log('\n--- 13. rules ---');
const R = L.rules();
check('$1 of food = 1 point', R.pointsPerDollar, 1);
check('100 points = $10 off', R.redeemStep + ' -> $' + R.redeemValue, '100 -> $10');
check('every 10 orders = $7', R.stampEvery + ' -> $' + R.stampValue, '10 -> $7');
check('the come-back coupon is ON', R.returnValue, 3);
check('valid 7 days', R.returnDays, 7);
check('and needs a $10 order to spawn', R.returnMinSubtotal, 10);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — loyalty rules do not match what the shop intends');
  process.exit(1);
}
console.log('PASS — points are earned on food, guarded by the order, and one reward per bill');
