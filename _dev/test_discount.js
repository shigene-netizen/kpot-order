/* Discount math and discount-code rules.
 *
 * Two things are worth pinning down here, because getting either wrong costs
 * real money in opposite directions:
 *
 *   - TAX. A merchant-funded discount is taxed on what the guest actually
 *     pays, not on the crossed-out price. Charging tax on the gross amount
 *     means the shop remits tax it never collected.
 *   - CAPS. A $50-off code on a $20 order must take off $20, not $50, and a
 *     "free delivery" code on a pickup order must take off nothing. A discount
 *     that overshoots turns the total negative, which is worse than no
 *     discount at all.
 *
 * These are the RULES. That the server actually calls them is
 * _dev/probe_discount_http.js's job — a correct function nobody calls is the
 * classic silent failure.
 *
 * Run:  node _dev/test_discount.js
 */

'use strict';

const path = require('path');
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, 'pricing.js'));
const D = require(path.join(ROOT, 'discounts.js'));

const CFG = { taxRate: 0.06 };

/* A priced order as priceOrder() would return it: gross subtotal, gross
   delivery, tax on the gross, and a total. */
const priced = (subtotal, delivery, tip) => {
  const tax = P.round2((subtotal + delivery) * CFG.taxRate);
  return {
    lines: [], subtotal, delivery, tax, tip,
    tipRate: 0, tipAmount: tip,
    total: P.round2(subtotal + delivery + tax + tip)
  };
};

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + want + '  got=' + got);
}

/* ------------------------------------------------------------------ */
/* 1. Three shapes                                                     */
/* ------------------------------------------------------------------ */

const pct = P.applyDiscount(priced(100, 0, 0), { type: 'percent', value: 10, code: 'TEN' }, CFG);
check('10% off $100 → $10 off', pct.discountAmount, 10);
check('10% off $100 → tax charged on $90', pct.tax, 5.4);
check('10% off $100 → total $95.40', pct.total, 95.4);

const amt = P.applyDiscount(priced(100, 0, 0), { type: 'amount', value: 5, code: 'FIVE' }, CFG);
check('$5 off $100 → $5 off', amt.discountAmount, 5);
check('$5 off $100 → tax charged on $95', amt.tax, 5.7);
check('$5 off $100 → total $100.70', amt.total, 100.7);

const ship = P.applyDiscount(priced(100, 4.99, 0), { type: 'freeship', value: 0, code: 'SHIPFREE' }, CFG);
check('free delivery on $4.99 → $4.99 off', ship.discountAmount, 4.99);
check('free delivery → subtotal untouched', ship.subtotal, 100);
check('free delivery → delivery still shown as $4.99 (gross)', ship.delivery, 4.99);
check('free delivery → tax charged on $100', ship.tax, 6);
check('free delivery → total $106.00', ship.total, 106);

/* ------------------------------------------------------------------ */
/* 2. Subtotal stays GROSS so the ticket can show the menu price       */
/* ------------------------------------------------------------------ */
check('percent discount leaves subtotal gross', pct.subtotal, 100);
check('amount discount leaves subtotal gross', amt.subtotal, 100);

/* ------------------------------------------------------------------ */
/* 3. Caps — a discount must never overshoot                           */
/* ------------------------------------------------------------------ */
const over = P.applyDiscount(priced(20, 0, 0), { type: 'amount', value: 50, code: 'BIG' }, CFG);
check('$50 off a $20 order → takes off $20, not $50', over.discountAmount, 20);
check('$50 off a $20 order → total is the tax only, not negative', over.total, 0);

const overPct = P.applyDiscount(priced(20, 0, 0), { type: 'percent', value: 150, code: 'ALL' }, CFG);
check('150% off is capped at 100%', overPct.discountAmount, 20);

const noShip = P.applyDiscount(priced(100, 0, 0), { type: 'freeship', value: 0, code: 'SHIPFREE' }, CFG);
check('free-delivery code on a pickup order → $0 off',
  P.discountAmountFor(priced(100, 0, 0), { type: 'freeship', value: 0 }), 0);
check('a code that applies to nothing leaves the total alone', noShip.total, 106);
check('a code that applies to nothing leaves tax alone', noShip.tax, 6);

/* ------------------------------------------------------------------ */
/* 4. Unknown shapes fail CLOSED                                       */
/* ------------------------------------------------------------------ */
check('unknown discount type → $0 off', P.discountAmountFor(priced(100, 0, 0), { type: 'teleport', value: 10 }), 0);
check('missing discount → $0 off', P.discountAmountFor(priced(100, 0, 0), null), 0);
check('negative amount → $0 off', P.discountAmountFor(priced(100, 0, 0), { type: 'amount', value: -5 }), 0);
check('zero percent → $0 off', P.discountAmountFor(priced(100, 0, 0), { type: 'percent', value: 0 }), 0);

const none = priced(100, 0, 0);
check('applyDiscount with no discount returns the same figures', P.applyDiscount(none, null, CFG).total, none.total);

/* ------------------------------------------------------------------ */
/* 5. The tip is the guest's to give, not ours to shrink               */
/* ------------------------------------------------------------------ */
const tipped = P.applyDiscount(priced(100, 0, 10), { type: 'percent', value: 10, code: 'TEN' }, CFG);
check('a discount does not reduce the tip', tipped.tip, 10);
check('total with tip = 90 + 5.40 + 10', tipped.total, 105.4);

/* ------------------------------------------------------------------ */
/* 6. Code normalisation                                               */
/* ------------------------------------------------------------------ */
check('"  welcome 10 " → WELCOME10', D.normalizeCode('  welcome 10 '), 'WELCOME10');
check('"welcome-10!" → WELCOME10 (the dash must not have to be typed)',
  D.normalizeCode('welcome-10!'), 'WELCOME10');
check('"summer_25" → SUMMER25', D.normalizeCode('summer_25'), 'SUMMER25');
check('a code of only symbols → empty', D.normalizeCode('!!'), '');

/* ------------------------------------------------------------------ */
/* 7. Owner input validation                                           */
/* ------------------------------------------------------------------ */
check('valid percent code accepted', D.validateDiscount({ code: 'A', type: 'percent', value: 10 }), null);
check('valid freeship code accepted', D.validateDiscount({ code: 'A', type: 'freeship', value: 0 }), null);
check('unknown type rejected', typeof D.validateDiscount({ code: 'A', type: 'teleport', value: 1 }), 'string');
check('percent 0 rejected', typeof D.validateDiscount({ code: 'A', type: 'percent', value: 0 }), 'string');
check('percent 101 rejected', typeof D.validateDiscount({ code: 'A', type: 'percent', value: 101 }), 'string');
check('negative amount rejected', typeof D.validateDiscount({ code: 'A', type: 'amount', value: -1 }), 'string');
check('no code rejected', typeof D.validateDiscount({ code: '!!', type: 'amount', value: 1 }), 'string');
check('duplicate codes rejected', typeof D.validateList([
  { code: 'A', type: 'amount', value: 1 }, { code: 'a', type: 'amount', value: 2 }
]), 'string');
check('a good list is accepted', D.validateList([{ code: 'A', type: 'amount', value: 1 }]), null);

/* ------------------------------------------------------------------ */
/* 8. "Is this code allowed right now?"                                */
/* ------------------------------------------------------------------ */
const NOW = Date.parse('2026-10-11T12:00:00Z');

const codes = [
  { code: 'TEN', type: 'percent', value: 10, active: true, used: 0 },
  { code: 'OFF', type: 'amount', value: 5, active: false, used: 0 },
  { code: 'GONE', type: 'amount', value: 5, active: true, expiresAt: '2026-01-01', used: 0 },
  { code: 'BIGSPEND', type: 'amount', value: 5, active: true, minSubtotal: 30, used: 0 },
  { code: 'ONETIME', type: 'amount', value: 5, active: true, maxUses: 1, used: 0 },
  { code: 'SPENT', type: 'amount', value: 5, active: true, maxUses: 1, used: 1 }
].map(D.normalizeOne);

const res = (code, subtotal) => D.resolveCode(codes, code, subtotal, NOW);

check('an unknown code is refused', res('NOPE', 100).error, 'unknown_code');
check('a switched-off code is refused', res('OFF', 100).error, 'inactive');
check('an expired code is refused', res('GONE', 100).error, 'expired');
check('below the minimum spend is refused', res('BIGSPEND', 20).error, 'min_subtotal');
check('at the minimum spend is allowed', res('BIGSPEND', 30).ok, true);
check('a used-up code is refused', res('SPENT', 100).error, 'used_up');
check('a code with uses left is allowed', res('ONETIME', 100).ok, true);
check('an empty code is not "unknown", it is "empty"', res('', 100).error, 'empty_code');
check('a good code resolves to a descriptor', res('TEN', 100).discount.type, 'percent');
check('the descriptor carries the normalised code', res('TEN', 100).discount.code, 'TEN');
check('a good code is worth the right amount',
  P.discountAmountFor(priced(100, 0, 0), res('TEN', 100).discount), 10);

/* ------------------------------------------------------------------ */
/* 9. Spending a code                                                  */
/* ------------------------------------------------------------------ */
const entry = res('ONETIME', 100).code;
const after = D.spendCode(codes, entry);
check('spending increments that code', after.find((c) => c.code === 'ONETIME').used, 1);
check('spending leaves the other codes alone', after.find((c) => c.code === 'TEN').used, 0);
check('spending nothing changes nothing', D.spendCode(codes, null).length, codes.length);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — discount rules do not match what the shop intends');
  process.exit(1);
}
console.log('PASS — discounts are taxed on the net amount, capped, and fail closed');
