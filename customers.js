/* ==========================================================================
   KPOT To Go — Loyalty: points, stamps and come-back coupons
   --------------------------------------------------------------------------
   The member's identity is their MOBILE NUMBER. There is no account, no
   password and no sign-up: the checkout already demands a name and a mobile
   for order updates, so the phone number is the one identifier we already
   hold. normalizePhone() is therefore the foundation of this whole file —
   get it wrong and one guest silently becomes three accounts with their
   points scattered across all of them.

   Everything here is a pure-ish ledger operation on a plain object, plus
   file I/O with every path passed IN (never a constant) so a test run can
   never touch the shop's real customers. Same rule as discounts.js.

   Nothing in here decides money. It answers "how many points does this order
   earn?" and "what may this guest take off?", and hands the answer to
   pricing.js as an ordinary discount.
   ========================================================================== */

'use strict';

const fs = require('fs');
/* Only for the membership date normaliser above — member.js has no
   dependencies of its own, so this cannot become a cycle. */
const MB = require('./member.js');

/* ---- The rules, in one place -------------------------------------------- */

const POINTS_PER_DOLLAR = 1;   // $1 of FOOD = 1 point (tax and tip excluded)
const REDEEM_STEP = 100;       // …spent in whole blocks of 100 points…
const REDEEM_VALUE = 5;        // …each worth $5 off
const STAMP_EVERY = 10;        // every 10 settled orders earns…
const STAMP_VALUE = 10;        // …a $10 reward
const RETURN_VALUE = 5;        // and every settled order drops a $5 coupon…
const RETURN_DAYS = 14;        // …that expires in a fortnight

/* Sanity ceilings. A ledger that grows without bound is a ledger that
   eventually fails to load. */
const MAX_CUSTOMERS = 20000;
const MAX_COUPONS = 20;        // per guest; stamp rewards accumulate, returns do not
const KEEP_ORDER_IDS = 200;    // recent settled order ids, for the audit trail
const KEEP_LOG = 40;

const COUPON_KINDS = ['stamp', 'return'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* -------------------------------------------------------------------------- */
/* Phone normalisation — the whole feature stands on this                      */
/* -------------------------------------------------------------------------- */
/* "  +1 (678) 335-5388 " and "678-335-5388" and "6783355388" are ONE guest.

   The rule is deliberately narrow: strip everything that is not a digit, drop
   a single leading US country code, then require exactly ten digits. Being
   loose here (say, "keep the last ten digits of whatever arrives") would map a
   mistyped eleven-digit number onto some other guest's account, and points
   would land in a stranger's balance. A number we cannot read confidently is
   rejected outright — an unrecognised guest gets no points, which is
   recoverable; a WRONG guest's balance is not. */
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  const local = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (local.length !== 10) return null;
  return local;
}

/* Enough for a guest to recognise themselves without turning the lookup into
   a way to harvest full names by guessing numbers. */
function maskName(name) {
  const s = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const parts = s.split(' ');
  if (parts.length === 1) return parts[0].slice(0, 24);
  return parts[0].slice(0, 24) + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

/* -------------------------------------------------------------------------- */
/* Coupons                                                                     */
/* -------------------------------------------------------------------------- */

function couponId() {
  return 'cp_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function isExpired(c, now) {
  if (!c || !c.expiresAt) return false;
  const t = Date.parse(c.expiresAt);
  return isFinite(t) && (now || Date.now()) > t;
}

function isUsable(c, now) {
  return !!c && !c.usedAt && !isExpired(c, now);
}

function makeCoupon(kind, value, label, orderId, now) {
  const at = now || new Date().toISOString();
  return {
    id: couponId(),
    kind,
    value: round2(value),
    label: String(label || ''),
    issuedAt: at,
    /* A stamp reward is earned, so it does not rot. A come-back coupon exists
       to pull the guest in SOON, so it does. */
    expiresAt: kind === 'return'
      ? new Date(Date.parse(at) + RETURN_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null,
    usedAt: null,
    usedOn: '',
    orderId: String(orderId || '')
  };
}

/* -------------------------------------------------------------------------- */
/* Customer records                                                            */
/* -------------------------------------------------------------------------- */

function blankCustomer(phone) {
  return {
    phone,
    name: '',
    points: 0,
    lifetimePoints: 0,
    settledOrders: 0,
    stampsIssued: 0,
    coupons: [],
    settledOrderIds: [],
    log: [],
    firstSeenAt: null,
    lastSeenAt: null
  };
}

const int = (x) => {
  const n = Number(x);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

function normalizeCoupon(c) {
  if (!c || typeof c !== 'object') return null;
  const kind = COUPON_KINDS.includes(c.kind) ? c.kind : null;
  if (!kind) return null;
  const value = Number(c.value);
  if (!isFinite(value) || value <= 0) return null;
  return {
    id: c.id ? String(c.id).slice(0, 40) : couponId(),
    kind,
    value: round2(value),
    label: String(c.label || '').slice(0, 60),
    issuedAt: c.issuedAt ? String(c.issuedAt) : new Date().toISOString(),
    expiresAt: c.expiresAt == null ? null : String(c.expiresAt),
    usedAt: c.usedAt == null ? null : String(c.usedAt),
    usedOn: c.usedOn ? String(c.usedOn).slice(0, 60) : '',
    orderId: c.orderId ? String(c.orderId).slice(0, 60) : ''
  };
}

function normalizeCustomer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const phone = normalizePhone(raw.phone);
  if (!phone) return null;
  const c = blankCustomer(phone);
  c.name = String(raw.name || '').slice(0, 80);
  c.points = int(raw.points);
  c.lifetimePoints = int(raw.lifetimePoints);
  c.settledOrders = int(raw.settledOrders);
  c.stampsIssued = int(raw.stampsIssued);
  c.coupons = (Array.isArray(raw.coupons) ? raw.coupons : [])
    .map(normalizeCoupon).filter(Boolean).slice(-MAX_COUPONS);
  c.settledOrderIds = (Array.isArray(raw.settledOrderIds) ? raw.settledOrderIds : [])
    .map((x) => String(x).slice(0, 60)).slice(-KEEP_ORDER_IDS);
  c.log = (Array.isArray(raw.log) ? raw.log : []).slice(-KEEP_LOG).map((e) => ({
    at: String((e && e.at) || ''),
    kind: String((e && e.kind) || '').slice(0, 24),
    delta: Number((e && e.delta)) || 0,
    note: String((e && e.note) || '').slice(0, 120)
  }));
  c.firstSeenAt = raw.firstSeenAt ? String(raw.firstSeenAt) : null;
  c.lastSeenAt = raw.lastSeenAt ? String(raw.lastSeenAt) : null;

  /* Membership. ⚠️ This function is a WHITELIST: it builds a fresh record and
     copies field by field, so anything not named here is silently dropped the
     first time the ledger is saved. A member's expiry vanishing on the next
     flush looks exactly like "the renewal never happened". */
  c.memberUntil = MB.normalizeMemberUntil(raw.memberUntil);
  c.memberCouponIssuedFor = MB.normalizeMemberUntil(raw.memberCouponIssuedFor);
  return c;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

function loadCustomers(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.customers)) {
      const customers = j.customers.map(normalizeCustomer).filter(Boolean).slice(0, MAX_CUSTOMERS);
      return { customers, loaded: true };
    }
  } catch (e) { /* no file yet, or unreadable — start empty */ }
  return { customers: [], loaded: false };
}

function saveCustomers(file, customers) {
  const updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ updatedAt, customers }, null, 2));
  return updatedAt;
}

/* Find a guest, or create them. `list` is the live array (mutated in place so
   the caller's reference stays correct). */
function ensure(list, rawPhone, now) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  let c = list.find((x) => x.phone === phone);
  if (!c) {
    if (list.length >= MAX_CUSTOMERS) return null;
    c = blankCustomer(phone);
    c.firstSeenAt = now || new Date().toISOString();
    list.push(c);
  }
  return c;
}

function find(list, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  return list.find((x) => x.phone === phone) || null;
}

function touch(c, name, now) {
  const at = now || new Date().toISOString();
  if (!c.firstSeenAt) c.firstSeenAt = at;
  c.lastSeenAt = at;
  const n = String(name || '').trim();
  if (n) c.name = n.slice(0, 80);
}

function pushLog(c, kind, delta, note, now) {
  c.log.push({
    at: now || new Date().toISOString(),
    kind: String(kind || '').slice(0, 24),
    delta: Number(delta) || 0,
    note: String(note || '').slice(0, 120)
  });
  if (c.log.length > KEEP_LOG) c.log = c.log.slice(-KEEP_LOG);
}

/* -------------------------------------------------------------------------- */
/* Earning                                                                     */
/* -------------------------------------------------------------------------- */
/* Points are earned on the FOOD, not on the bill.

   Base = subtotal + delivery − discount. Tax is somebody else's money and a
   tip is the guest's gift to the staff; paying points on either would be the
   house rewarding itself for collecting the government's share. Using the
   DISCOUNTED subtotal also closes the obvious loop: redeeming points would
   otherwise earn points back on the money those points had just saved. */
function pointsBaseFor(order) {
  if (!order) return 0;
  return round2(
    (Number(order.subtotal) || 0) +
    (Number(order.delivery) || 0) -
    (Number(order.discountAmount) || 0)
  );
}

function pointsFor(order) {
  const base = Math.max(0, pointsBaseFor(order));
  return Math.floor(base * POINTS_PER_DOLLAR);
}

/* The two moments money is genuinely confirmed. Kept here (not in server.js)
   so the rule has exactly one definition and can be unit-tested. */
function isPaidStatus(ps) {
  return ps === 'verified' || ps === 'paid';
}

/* Credit a settled order. Idempotent by the ORDER, not by the guest: the
   caller marks `order.loyalty.awarded` so a Re-check, a second Stripe
   callback or a staff PATCH can never pay the same order's points twice.
   Returns { changed, points, coupons } — coupons is the NEW ones only. */
/* Award a settled order. Idempotent by ORDER, not by guest.

   `opts.pointsMultiplier` scales what the order EARNS — a member earns double.
   It is passed in by the server from the customer's own membership record,
   never taken from the order payload: the multiplier decides how fast a
   balance grows, so it is exactly the kind of number a guest would edit.

   The integer points are multiplied, then floored: $15.99 earns 15 points like
   everyone else, and a 2x member earns 30. Doubling the DOLLARS first and
   flooring after would give 31 and quietly hand every member a bonus in
   fractions of a cent — test_member.js pins the number down. */
function awardForOrder(cust, order, now, opts) {
  if (!cust || !order) return { changed: false, reason: 'no_customer' };
  if (order.loyalty && order.loyalty.awarded) return { changed: false, reason: 'already_awarded' };
  const at = now || new Date().toISOString();
  const mult = (opts && opts.pointsMultiplier) || 1;
  const points = Math.floor(Math.max(0, pointsFor(order)) * (mult > 0 ? mult : 1));

  cust.points += points;
  cust.lifetimePoints += points;
  cust.settledOrders += 1;

  const id = String(order.id || '');
  if (id) {
    cust.settledOrderIds.push(id);
    if (cust.settledOrderIds.length > KEEP_ORDER_IDS) {
      cust.settledOrderIds = cust.settledOrderIds.slice(-KEEP_ORDER_IDS);
    }
  }
  if (points > 0) pushLog(cust, 'earn', points, 'order ' + id, at);

  const issued = [];

  /* Stamps. Compared against a COUNTER of how many have already been handed
     out rather than "is settledOrders a multiple of 10", so a guest whose 10th
     order is awarded twice (or whose counter is edited by staff) can never
     silently earn a second reward for the same milestone. */
  const due = Math.floor(cust.settledOrders / STAMP_EVERY);
  while (cust.stampsIssued < due && cust.coupons.length < MAX_COUPONS) {
    cust.stampsIssued += 1;
    const c = makeCoupon('stamp', STAMP_VALUE,
      '$' + STAMP_VALUE + ' reward — ' + (cust.stampsIssued * STAMP_EVERY) + ' orders',
      id, at);
    cust.coupons.push(c);
    issued.push(c);
    pushLog(cust, 'stamp', 0, 'reward #' + cust.stampsIssued, at);
  }

  /* The come-back coupon. One at a time on purpose: a guest who orders five
     times in a fortnight should not end up holding five of them, which would
     turn a nudge into a standing discount. The newest replaces the oldest
     UNUSED one — a coupon already spent is left alone, so the audit trail
     still shows what was given and taken. */
  if (RETURN_VALUE > 0) {
    const stale = cust.coupons.filter((c) => c.kind === 'return' && !c.usedAt);
    if (stale.length) {
      cust.coupons = cust.coupons.filter((c) => !(c.kind === 'return' && !c.usedAt));
      pushLog(cust, 'return_replaced', 0, stale.length + ' unused coupon(s) replaced', at);
    }
    if (cust.coupons.length < MAX_COUPONS) {
      const c = makeCoupon('return', RETURN_VALUE,
        '$' + RETURN_VALUE + ' off — come back within ' + RETURN_DAYS + ' days', id, at);
      cust.coupons.push(c);
      issued.push(c);
      pushLog(cust, 'return', 0, 'issued', at);
    }
  }

  /* The flag is set HERE, not left to the caller. It is the same invariant as
     releaseRedemption(): "this order has been paid out" belongs to the
     function that pays it, so a Re-check, a second Stripe callback or a
     repeated staff PATCH cannot pay twice even if the caller forgets. The
     server's own `awarded: true` write still happens and is harmless. */
  order.loyalty = order.loyalty || {};
  order.loyalty.awarded = true;

  return { changed: true, points, coupons: issued };
}

/* -------------------------------------------------------------------------- */
/* Spending                                                                    */
/* -------------------------------------------------------------------------- */

/* How many whole blocks of 100 points may come off a bill of this size?
   Capped by the subtotal so a $5 reward can never exceed what there is to
   discount — the same clamp pricing.js applies to a dollar code. */
function pointsRedemption(cust, subtotal, now) {
  if (!cust) return null;
  const balance = Math.max(0, Math.floor(Number(cust.points) || 0));
  const affordable = Math.floor(balance / REDEEM_STEP);
  const allowed = Math.floor(round2(Math.max(0, Number(subtotal) || 0)) / REDEEM_VALUE);
  const steps = Math.min(affordable, allowed);
  if (steps <= 0) return null;
  return {
    kind: 'points',
    steps,
    points: steps * REDEEM_STEP,
    value: round2(steps * REDEEM_VALUE),
    label: (steps * REDEEM_STEP) + ' points'
  };
}

function couponRedemption(cust, id, subtotal, now) {
  if (!cust || !id) return null;
  const c = (cust.coupons || []).find((x) => x.id === String(id) && isUsable(x, now));
  if (!c) return null;
  const value = Math.min(Number(c.value) || 0, round2(Math.max(0, Number(subtotal) || 0)));
  if (value <= 0) return null;
  return { kind: 'coupon', coupon: c, couponId: c.id, value: round2(value), label: c.label || 'Reward' };
}

/* A guest may take ONE thing off a bill. Resolving two would silently pick a
   winner, and "my $10 reward vanished" is a support call. */
function resolveRedemption(cust, req, subtotal, now) {
  const wantsPoints = !!(req && req.redeemPoints);
  const couponId = req && req.couponId ? String(req.couponId) : '';
  if (wantsPoints && couponId) {
    return { error: 'one_reward_only', message: 'Use either your points or a coupon on this order, not both.' };
  }
  if (wantsPoints) {
    const r = pointsRedemption(cust, subtotal, now);
    if (!r) {
      /* Two different reasons wear the same "no". Telling a guest with 300
         points that they "do not have enough" when the real problem is a $3
         order would send them to the counter to argue about it. */
      const balance = Math.max(0, Math.floor(Number(cust.points) || 0));
      if (balance < REDEEM_STEP) {
        return {
          error: 'points_unavailable',
          message: 'You have ' + balance + ' point' + (balance === 1 ? '' : 's') +
            ' — ' + REDEEM_STEP + ' are needed for $' + REDEEM_VALUE + ' off.'
        };
      }
      return {
        error: 'order_too_small',
        message: 'Points can only come off an order of at least $' + REDEEM_VALUE + '.'
      };
    }
    return { redemption: r };
  }
  if (couponId) {
    const r = couponRedemption(cust, couponId, subtotal, now);
    if (!r) return { error: 'coupon_unavailable', message: 'That reward is no longer available.' };
    return { redemption: r };
  }
  return { none: true };
}

/* Turn a redemption into the shape pricing.js already understands. Keeping
   this in one function is what makes "points are just another discount" true
   rather than aspirational. */
function toDescriptor(redemption) {
  if (!redemption) return null;
  return {
    type: 'amount',
    value: redemption.value,
    code: '',
    label: redemption.kind === 'points'
      ? 'Points redeemed (' + redemption.points + ')'
      : (redemption.label || 'Reward'),
    source: 'loyalty'
  };
}

/* Take the reward OUT of the ledger. Called only once the order really
   exists, exactly like a discount code — handing a guest to Stripe is not a
   purchase. Refunded by releaseRedemption() if that order is then cancelled. */
function commitRedemption(cust, redemption, orderId, now) {
  if (!cust || !redemption) return false;
  const at = now || new Date().toISOString();
  if (redemption.kind === 'points') {
    cust.points = Math.max(0, Math.floor(Number(cust.points) || 0) - redemption.points);
    pushLog(cust, 'redeem', -redemption.points, 'order ' + orderId, at);
    return true;
  }
  const c = (cust.coupons || []).find((x) => x.id === redemption.couponId);
  if (!c || c.usedAt) return false;
  c.usedAt = at;
  c.usedOn = String(orderId || '').slice(0, 60);
  pushLog(cust, 'coupon_used', 0, c.label + ' on ' + orderId, at);
  return true;
}

/* An order that is cancelled never collected the money, so the reward it was
   priced with has to go back. Coupons are un-marked (the same coupon, still
   within its expiry) rather than replaced with a fresh one — otherwise a
   guest could reset a 14-day coupon indefinitely by starting and abandoning
   orders. */
function releaseRedemption(cust, order, now) {
  if (!cust || !order || !order.loyalty) return false;
  /* Guarded by the ORDER, so a cancelled order that gets re-settled and
     cancelled again cannot refund the same points twice. The flag is set HERE,
     not left to the caller: it is this function's own invariant, and a second
     caller — a re-run, a future code path, a test — must not be able to refund
     twice just because nothing flipped a flag on the way in. The caller's own
     `released: true` write is now belt-and-braces and harmless. */
  if (order.loyalty.released) return false;
  const at = now || new Date().toISOString();
  const red = order.loyalty.redeemed;
  if (!red) return false;
  if (red.kind === 'points') {
    cust.points += Math.floor(Number(red.points) || 0);
    pushLog(cust, 'refund', Math.floor(Number(red.points) || 0), 'cancelled ' + order.id, at);
    order.loyalty.released = true;
    order.loyalty.releasedAt = at;
    return true;
  }
  const c = (cust.coupons || []).find((x) => x.id === red.couponId);
  if (!c || c.usedOn !== String(order.id || '')) return false;
  c.usedAt = null;
  c.usedOn = '';
  pushLog(cust, 'coupon_returned', 0, c.label + ' from cancelled ' + order.id, at);
  order.loyalty.released = true;
  order.loyalty.releasedAt = at;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

/* What a guest may see about themselves. Never the full name, never the
   ledger, never other people's anything.

   `rules` rides along so the storefront can phrase "100 points = $5" and
   "every 10 orders" without hard-coding a second copy of the numbers — one
   place to change them, one place they can disagree. */
function rules() {
  return {
    pointsPerDollar: POINTS_PER_DOLLAR,
    redeemStep: REDEEM_STEP,
    redeemValue: REDEEM_VALUE,
    stampEvery: STAMP_EVERY,
    stampValue: STAMP_VALUE,
    returnValue: RETURN_VALUE,
    returnDays: RETURN_DAYS
  };
}

function publicView(cust, subtotal, now) {
  if (!cust) {
    return {
      found: false, points: 0, coupons: [], rules: rules(),
      member: { is: false, daysLeft: 0, until: null },
      pointsRedemption: null, stamps: { settled: 0, into: 0, every: STAMP_EVERY, toNext: STAMP_EVERY }
    };
  }
  const usable = (cust.coupons || []).filter((c) => isUsable(c, now));
  const settled = Math.floor(Number(cust.settledOrders) || 0);
  const into = settled % STAMP_EVERY;
  const memberUntil = cust.memberUntil ? Date.parse(cust.memberUntil) : NaN;
  const isMem = isFinite(memberUntil) && memberUntil > now;
  return {
    found: true,
    name: maskName(cust.name),
    rules: rules(),
    points: Math.max(0, Math.floor(Number(cust.points) || 0)),
    pointsRedemption: subtotal == null ? null : pointsRedemption(cust, subtotal, now),
    coupons: usable.map((c) => ({
      id: c.id, value: c.value, label: c.label,
      kind: c.kind, expiresAt: c.expiresAt
    })),
    /* Membership state, and only that. Which perks it BUYS is the server's
       business (they come from config), so the guest page asks the price
       endpoint rather than trusting a number in here. */
    member: {
      is: isMem,
      daysLeft: isMem ? Math.max(0, Math.ceil((memberUntil - now) / 86400000)) : 0,
      until: isMem ? cust.memberUntil : null
    },
    stamps: {
      settled,
      every: STAMP_EVERY,
      into,
      /* 0 means the next order IS the reward — say so rather than "10 to go". */
      toNext: STAMP_EVERY - into
    }
  };
}

/* Is this expiry still in force? Kept here, next to the field it reads, so
   there is exactly one answer to "is this guest a member" — the board, the
   console and the price endpoint must not each derive their own. */
function isMemberDate(until, now) {
  const t = until ? Date.parse(until) : NaN;
  return isFinite(t) && t > now;
}

/* The owner's view: everything, because they own it. `member` is spelled out
   rather than left to whoever is reading to derive: the console shows a badge
   from it, and a page that has to work out whether a date has passed is a page
   that will get it wrong at midnight. */
function adminView(cust) {
  const now = Date.now();
  return Object.assign({}, cust, {
    member: isMemberDate(cust.memberUntil, now),
    coupons: (cust.coupons || []).slice(-MAX_COUPONS)
  });
}

const CSV_COLUMNS = [
  'phone', 'name', 'points', 'lifetimePoints', 'settledOrders',
  'stampsIssued', 'unusedCoupons', 'memberUntil', 'member', 'lastSeenAt'
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  /* Same hardening as the order export: neutralise a leading =/+/-/@ so a
     spreadsheet cannot be talked into treating a guest's name as a formula. */
  return /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"'
    : /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(customers, now) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const c of customers) {
    const until = c.memberUntil ? Date.parse(c.memberUntil) : NaN;
    const isMem = isFinite(until) && until > now;
    rows.push([
      c.phone, c.name, c.points, c.lifetimePoints, c.settledOrders, c.stampsIssued,
      (c.coupons || []).filter((x) => isUsable(x, now)).length,
      isMem ? String(c.memberUntil).slice(0, 10) : '',
      isMem ? 'yes' : '',
      c.lastSeenAt || ''
    ].map(csvCell).join(','));
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

module.exports = {
  POINTS_PER_DOLLAR, REDEEM_STEP, REDEEM_VALUE,
  STAMP_EVERY, STAMP_VALUE, RETURN_VALUE, RETURN_DAYS,
  MAX_CUSTOMERS, MAX_COUPONS, COUPON_KINDS, CSV_COLUMNS,
  round2, normalizePhone, maskName, rules,
  couponId, makeCoupon, isExpired, isUsable,
  blankCustomer, normalizeCoupon, normalizeCustomer,
  loadCustomers, saveCustomers, ensure, find, touch, pushLog,
  pointsBaseFor, pointsFor, isPaidStatus,
  awardForOrder, pointsRedemption, couponRedemption, resolveRedemption,
  toDescriptor, commitRedemption, releaseRedemption,
  publicView, adminView, toCsv
};
