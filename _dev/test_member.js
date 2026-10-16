/* Membership rules: what a monthly fee buys, and what it must NOT buy.
 *
 * Three things here are ways to give away money that was not meant to be
 * given away:
 *
 *   - A CONFIG that cannot be read. `percent: "abc"` must mean NO discount,
 *     not 100% off, and it must not crash the server either. A deleted config
 *     block is a different failure and means "use the defaults".
 *   - A MEMBERSHIP that cannot be read. `memberUntil` is a string in a JSON
 *     file, so it can be garbage. Garbage must mean "not a member", and a
 *     NaN comparison already gives us that for free.
 *   - A RENEWAL TAPPED TWICE. It must roll the date forward once and mint ONE
 *     coupon, not one per tap.
 *
 * That the server actually applies these — that a member really gets 5% off,
 * that a cancelled member stops getting it, that the multiplier comes from the
 * ledger and not the order payload — is probe_member.js's job.
 *
 * Run:  node _dev/test_member.js
 */

'use strict';

const MB = require('../member.js');
const L = require('../customers.js');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const NOW_ISO = '2026-10-14T12:00:00.000Z';

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
console.log('\n--- 1. reading the config ---');
/* ========================================================================== */

const D = MB.DEFAULTS;
check('the default discount is 5%', D.percent, 5);
check('the default fee is $9.99', D.fee, 9.99);
check('the default period is 30 days', D.periodDays, 30);
check('the default multiplier is 2x', D.pointsMultiplier, 2);
check('the default coupon is $5', D.couponValue, 5);
check('free delivery is on by default', D.freeDelivery, true);

/* Absent block vs garbage value — two different failures, two answers. */
const blank = MB.memberConfig();
check('a missing block falls back to the defaults', blank.percent, 5);
check('including the coupon', blank.couponValue, 5);
check('a null config also uses the defaults', MB.memberConfig(null).percent, 5);
check('an empty object uses the defaults', MB.memberConfig({}).percent, 5);
check('an empty STRING is treated as absent', MB.memberConfig({ percent: '' }).percent, 5);

/* THE MONEY ONE: a typo must not become a giveaway. */
check('percent:"abc" means NO discount, not 100%', MB.memberConfig({ percent: 'abc' }).percent, 0);
check('percent:[] means NO discount', MB.memberConfig({ percent: [] }).percent, 0);
check('percent:{} means NO discount', MB.memberConfig({ percent: {} }).percent, 0);
check('couponValue:"five" means NO coupon', MB.memberConfig({ couponValue: 'five' }).couponValue, 0);
check('percent:0 is the owner switching it off', MB.memberConfig({ percent: 0 }).percent, 0);
check('percent:-50 is refused, not treated as 0 discount on purpose',
  MB.memberConfig({ percent: -50 }).percent, 0);
check('percent:1000 is capped at 100', MB.memberConfig({ percent: 1000 }).percent, 100);

/* A multiplier that cannot be read must be 1x, not 20x and not 0x. */
check('multiplier:"two" is 1x, not 2x-by-luck', MB.memberConfig({ pointsMultiplier: 'two' }).pointsMultiplier, 2);
check('multiplier:0 is 2x by default (never zero)', MB.memberConfig({ pointsMultiplier: 0 }).pointsMultiplier, 2);
check('multiplier:-5 is 2x by default', MB.memberConfig({ pointsMultiplier: -5 }).pointsMultiplier, 2);
check('multiplier:99 is capped at 10', MB.memberConfig({ pointsMultiplier: 99 }).pointsMultiplier, 10);
check('multiplier:1.5 is kept (a half-multiplier is meaningful)',
  MB.memberConfig({ pointsMultiplier: 1.5 }).pointsMultiplier, 1.5);

check('freeDelivery:false is honoured', MB.memberConfig({ freeDelivery: false }).freeDelivery, false);
check('freeDelivery:"no" is treated as ON (only literal false turns it off)',
  MB.memberConfig({ freeDelivery: 'no' }).freeDelivery, true);
check('enabled:false turns the whole thing off',
  MB.benefitsFor({ memberUntil: new Date(NOW + DAY).toISOString() }, { enabled: false }, NOW).member, false);
check('periodDays:0 falls back to 30', MB.memberConfig({ periodDays: 0 }).periodDays, 30);
check('periodDays:7 is kept', MB.memberConfig({ periodDays: 7 }).periodDays, 7);
check('a fee that cannot be read falls back, because it is only a label',
  MB.memberConfig({ fee: 'free' }).fee, 9.99);
check('a negative fee is clamped to 0', MB.memberConfig({ fee: -20 }).fee, 0);

/* ========================================================================== */
console.log('\n--- 2. who is a member ---');
/* ========================================================================== */

const memberAt = (days) => ({ memberUntil: new Date(NOW + days * DAY).toISOString() });

check('an expiry 5 days out is a member', MB.isMember(memberAt(5), NOW), true);
check('an expiry 1 second out is a member', MB.isMember({ memberUntil: new Date(NOW + 1000).toISOString() }, NOW), true);
check('an expiry now is NOT a member (the second it lapses)', MB.isMember({ memberUntil: NOW_ISO }, NOW), false);
check('an expiry yesterday is NOT a member', MB.isMember(memberAt(-1), NOW), false);
check('no expiry at all is NOT a member', MB.isMember({}, NOW), false);
check('an empty expiry is NOT a member', MB.isMember({ memberUntil: '' }, NOW), false);
check('a NULL expiry is NOT a member', MB.isMember({ memberUntil: null }, NOW), false);
/* The file is JSON on disk. Every one of these is reachable by hand-editing. */
check('a garbage expiry is NOT a member', MB.isMember({ memberUntil: 'next tuesday' }, NOW), false);
check('a numeric expiry is NOT a member', MB.isMember({ memberUntil: 1760000000000 }, NOW), false);
check('an object expiry is NOT a member', MB.isMember({ memberUntil: { y: 2026 } }, NOW), false);
check('an array expiry is NOT a member', MB.isMember({ memberUntil: [] }, NOW), false);
check('no customer is NOT a member', MB.isMember(null, NOW), false);

check('5 days left reads 5', MB.daysLeft(memberAt(5), NOW), 5);
check('half a day left reads 1, not 0', MB.daysLeft({ memberUntil: new Date(NOW + 12 * 3600000).toISOString() }, NOW), 1);
check('expired reads 0', MB.daysLeft(memberAt(-5), NOW), 0);
check('no expiry reads 0', MB.daysLeft({}, NOW), 0);
check('a garbage expiry reads 0', MB.daysLeft({ memberUntil: 'soon' }, NOW), 0);

check('30-day period gives an expiry 30 days out',
  MB.memberUntilFrom(NOW, MB.memberConfig()).slice(0, 10),
  new Date(NOW + 30 * DAY).toISOString().slice(0, 10));
check('a 7-day config gives 7 days',
  MB.memberUntilFrom(NOW, MB.memberConfig({ periodDays: 7 })).slice(0, 10),
  new Date(NOW + 7 * DAY).toISOString().slice(0, 10));

/* ========================================================================== */
console.log('\n--- 3. what the membership buys ---');
/* ========================================================================== */

const live = { memberUntil: new Date(NOW + 10 * DAY).toISOString() };
const dead = { memberUntil: new Date(NOW - 10 * DAY).toISOString() };
const stranger = {};

const bl = MB.benefitsFor(live, {}, NOW);
check('a live member gets 5% off', bl.percent, 5);
check('and free delivery', bl.freeDelivery, true);
check('and 2x points', bl.pointsMultiplier, 2);
check('and the $5 coupon', bl.couponValue, 5);
check('and knows how many days are left', bl.daysLeft, 10);

const bd = MB.benefitsFor(dead, {}, NOW);
check('an expired member gets NO discount', bd.percent, 0);
check('no free delivery', bd.freeDelivery, false);
check('a 1x multiplier (never 0x)', bd.pointsMultiplier, 1);
check('and no coupon value', bd.couponValue, 0);

const bs = MB.benefitsFor(stranger, {}, NOW);
check('a non-member gets NO discount', bs.percent, 0);
check('no free delivery', bs.freeDelivery, false);
check('a 1x multiplier', bs.pointsMultiplier, 1);

const bnl = MB.benefitsFor(null, {}, NOW);
check('nobody gets nothing', bnl.member, false);
check('and a 1x multiplier', bnl.pointsMultiplier, 1);

/* The perks offered for a PARTICULAR order. */
const ch = MB.memberDiscountChoices(bl, 'pickup', 0);
check('a pickup order gets exactly one member option', ch.length, 1);
check('and it is the percentage', ch[0].id, 'member_percent');
check('labelled for the guest', ch[0].label, 'Member 5% off');
check('as a percent discount', ch[0].discount.type, 'percent');
check('worth 5', ch[0].discount.value, 5);
check('and marked as a member discount, not a code', ch[0].discount.source, 'member');

const chd = MB.memberDiscountChoices(bl, 'delivery', 4.99);
check('a delivery order gets TWO member options', chd.length, 2);
check('the percentage', chd[0].id, 'member_percent');
check('and free delivery', chd[1].id, 'member_freeship');
check('as a freeship discount', chd[1].discount.type, 'freeship');
check('labelled for the guest', chd[1].discount.label, 'Member free delivery');

check('a non-member is offered nothing', MB.memberDiscountChoices(bs, 'delivery', 4.99).length, 0);
check('an expired member is offered nothing', MB.memberDiscountChoices(bd, 'delivery', 4.99).length, 0);
check('nobody is offered nothing', MB.memberDiscountChoices(null, 'delivery', 4.99).length, 0);
check('free delivery on a PICKUP order is not offered (there is no fee to waive)',
  MB.memberDiscountChoices(bl, 'pickup', 0).length, 1);
check('nor when the fee is already 0',
  MB.memberDiscountChoices(bl, 'delivery', 0).length, 1);
check('with freeDelivery off, only the percentage remains',
  MB.memberDiscountChoices(MB.benefitsFor(live, { freeDelivery: false }, NOW), 'delivery', 4.99).length, 1);
check('with the percentage off, only free delivery remains',
  MB.memberDiscountChoices(MB.benefitsFor(live, { percent: 0 }, NOW), 'delivery', 4.99).length, 1);
check('with both off, nothing is offered',
  MB.memberDiscountChoices(MB.benefitsFor(live, { percent: 0, freeDelivery: false }, NOW), 'delivery', 4.99).length, 0);

/* ========================================================================== */
console.log('\n--- 4. renewing, and the owner tapping twice ---');
/* ========================================================================== */

const fresh = L.blankCustomer('6783355388');
const r1 = MB.confirmMember(fresh, NOW, {});
check('the first renewal changes something', r1.changed, true);
check('and rolls the expiry 30 days out',
  r1.memberUntil, new Date(NOW + 30 * DAY).toISOString());
check('and mints exactly one coupon', !!r1.coupon, true);
check('worth $5', r1.coupon && r1.coupon.value, 5);
check('of member kind', r1.coupon && r1.coupon.kind, 'member');
check('running 30 days', r1.coupon && r1.coupon.days, 30);
check('labelled for the guest', r1.coupon && r1.coupon.label, 'Member reward · 5 off');
check('and writes it onto the customer', fresh.memberUntil, r1.memberUntil);
/* The issued-for stamp is the renewal DAY, not the exact millisecond: an owner
   double-tapping lands two requests milliseconds apart, and comparing full
   timestamps minted a second coupon (this was a real bug, caught by the
   probe). "One coupon per renewal day" catches it and still allows a genuine
   re-enrolment the next day. */
check('the issued-for stamp is the renewal DAY', fresh.memberCouponIssuedFor, '2026-10-14');

/* THE ONE: an owner tapping twice inside the same period. */
const r2 = MB.confirmMember(fresh, NOW, {});
check('a second tap in the same period changes nothing', r2.changed, false);
check('and says so', r2.reason, 'already_current');
check('and mints NO second coupon', r2.coupon, null);
check('the expiry did not move', fresh.memberUntil, r1.memberUntil);

/* A LATER tap is a real renewal — a new period, a new coupon. */
const later = NOW + 40 * DAY;
const r3 = MB.confirmMember(fresh, later, {});
check('renewing after the first period lapsed is a change', r3.changed, true);
check('and rolls 30 days from TODAY, not from the old expiry',
  r3.memberUntil, new Date(later + 30 * DAY).toISOString());
check('and mints a fresh coupon', r3.coupon && r3.coupon.value, 5);
check('a renewal while still active also renews from today',
  (() => { const c = L.blankCustomer('6783355388'); MB.confirmMember(c, NOW, {}); const r = MB.confirmMember(c, NOW + 5 * DAY, {}); return r.memberUntil === new Date(NOW + 35 * DAY).toISOString(); })(), true);

check('renewing a coupon-less config mints nothing',
  MB.confirmMember(L.blankCustomer('6783355388'), NOW, { couponValue: 0 }).coupon, null);
check('renewing with no customer changes nothing', MB.confirmMember(null, NOW, {}).changed, false);
check('renewing with no customer says why', MB.confirmMember(null, NOW, {}).reason, 'no_customer');

/* Renewing twice must not double up on the coupon either. */
const twice = L.blankCustomer('6783355388');
MB.confirmMember(twice, NOW, {});
MB.confirmMember(twice, NOW, {});
check('two taps produced at most one coupon spec (the second returned none)',
  r2.coupon === null, true);

console.log('\n--- 5. cancelling ---');
const canc = L.blankCustomer('6783355388');
MB.confirmMember(canc, NOW, {});
check('cancelling a live member changes something', MB.cancelMember(canc).changed, true);
check('and clears the expiry outright', canc.memberUntil, null);
check('so they are immediately not a member', MB.isMember(canc, NOW), false);
check('and get no perks', MB.benefitsFor(canc, {}, NOW).percent, 0);
check('cancelling again changes nothing', MB.cancelMember(canc).changed, false);
check('and says why', MB.cancelMember(canc).reason, 'not_a_member');
check('cancelling a stranger changes nothing', MB.cancelMember(L.blankCustomer('6783355388')).changed, false);
check('cancelling nobody changes nothing', MB.cancelMember(null).changed, false);

/* A cancelled member keeps their points and their coupons. The fee is gone,
   not the balance. */
const kept = L.blankCustomer('6783355388');
MB.confirmMember(kept, NOW, {});
kept.points = 250;
MB.cancelMember(kept);
check('cancelling keeps the points they earned', kept.points, 250);
check('cancelling keeps the coupons they hold', kept.coupons.length, 0);

/* ========================================================================== */
console.log('\n--- 6. the points multiplier ---');
/* ========================================================================== */

/* $15.99 earns 15 points for everyone; a 2x member earns 30, not 31. */
check('15 points doubled is 30', MB.pointsWithMultiplier(15, 2), 30);
check('1x is a no-op', MB.pointsWithMultiplier(15, 1), 15);
check('0 points doubled is 0', MB.pointsWithMultiplier(0, 2), 0);
check('a negative base is clamped to 0', MB.pointsWithMultiplier(-40, 2), 0);
check('a 1.5x multiplier is honoured', MB.pointsWithMultiplier(15, 1.5), 22);
check('a garbage multiplier means 1x', MB.pointsWithMultiplier(15, 'double'), 15);
check('a zero multiplier means 1x, never 0x', MB.pointsWithMultiplier(15, 0), 15);
check('no base points means 0', MB.pointsWithMultiplier(null, 2), 0);

/* The multiplier must survive a save/load cycle — this is the one that bit us
   while building it, because normalizeCustomer() is a WHITELIST. */
/* A FACTORY, not a shared object: awardForOrder() writes order.loyalty.awarded,
   so handing it the same order twice returns already_awarded and the second
   call has no .points to read. */
const order = () => ({ id: 'KP-M-1', subtotal: 15.99, delivery: 0, discountAmount: 0, loyalty: {} });
const c15 = L.blankCustomer('6783355388');
MB.confirmMember(c15, NOW, {});
const c15b = L.blankCustomer('6783355388');
Object.assign(c15b, JSON.parse(JSON.stringify(c15)));
check('a membership survives a JSON round-trip (normalizeCustomer keeps memberUntil)',
  c15b.memberUntil, c15.memberUntil);
const roundAward = L.awardForOrder(c15b, order(), NOW_ISO, {
  pointsMultiplier: MB.benefitsFor(c15b, {}, NOW).pointsMultiplier
});
check('and still earns double after it', roundAward.points, 30);
const plainAward = L.awardForOrder(L.blankCustomer('4045551234'), order(), NOW_ISO, {});
check('while a non-member earns single', plainAward.points, 15);
check('the multiplier defaults to 1x when not passed',
  L.awardForOrder(L.blankCustomer('4045551234'), order(), NOW_ISO).points, 15);
check('a multiplier in the ORDER payload is ignored (only opts counts)',
  L.awardForOrder(L.blankCustomer('4045551234'), Object.assign(order(), { pointsMultiplier: 50 }), NOW_ISO, {}).points, 15);

/* ========================================================================== */
console.log('\n--- 7. what the guest and the owner are shown ---');
/* ========================================================================== */

const mem = L.blankCustomer('6783355388');
MB.confirmMember(mem, NOW, {});
mem.points = 250;

const pv = L.publicView(mem, null, NOW);
check('the guest is told they are a member', pv.member.is, true);
check('and how many days are left', pv.member.daysLeft, 30);
check('and the expiry itself', pv.member.until, mem.memberUntil);
/* The VIEW must not tell the guest which perks exist — that is config, and
   config belongs to the price endpoint, which re-checks it server-side. */
ok('the public view does not publish the member discount',
  JSON.stringify(pv).indexOf('percent') === -1, JSON.stringify(pv.member));
ok('nor the multiplier', JSON.stringify(pv).indexOf('multiplier') === -1);

const pvD = L.publicView(L.blankCustomer('6783355388'), null, NOW);
check('a non-member is told they are not', pvD.member.is, false);
check('with 0 days left', pvD.member.daysLeft, 0);
check('and no expiry', pvD.member.until, null);

const pvE = L.publicView({ memberUntil: new Date(NOW - DAY).toISOString() }, null, NOW);
check('an expired member is told they are not', pvE.member.is, false);

const csv = L.toCsv([mem], NOW);
const head = csv.split('\r\n')[0];
ok('the CSV header carries memberUntil', head.indexOf('memberUntil') !== -1, head);
ok('and a member flag column', head.indexOf(',member,') !== -1, head);
/* Looked up by NAME, not by position. CSV_COLUMNS grows — it gained `email`
   and `devices` when the rewards scheme grew a credential — and a bare index
   here silently starts asserting on the wrong column the moment it does. */
const csvIdx = (col) => head.split(',').indexOf(col);
check('the member flag column is where the header says it is', csvIdx('member') > 0, true);
check('the member flag is yes', csv.split('\r\n')[1].split(',')[csvIdx('member')], 'yes');
ok('the expiry date is in the row',
  csv.indexOf(String(mem.memberUntil).slice(0, 10)) !== -1, csv);
const csv2 = L.toCsv([L.blankCustomer('4045551234')], NOW);
check('a non-member has an empty flag', csv2.split('\r\n')[1].split(',')[csvIdx('member')], '');

const av = L.adminView(mem);
check('the owner view keeps the expiry', av.memberUntil, mem.memberUntil);
check('and the issued-for stamp', av.memberCouponIssuedFor, mem.memberCouponIssuedFor);

/* The ledger itself must keep a discarded membership honest. */
const gone = L.blankCustomer('6783355388');
MB.confirmMember(gone, NOW, {});
MB.cancelMember(gone);
gone.points = 42;
check('a cancelled membership saves as no membership',
  L.normalizeCustomer(Object.assign({}, gone, { phone: '6783355388' })).memberUntil, null);
check('while the balance they earned survives',
  L.normalizeCustomer(Object.assign({}, gone, { phone: '6783355388' })).points, 42);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — the membership rules do not match what the shop intends');
  process.exit(1);
}
console.log('PASS — a monthly fee buys exactly what it says, and a typo buys nothing');
