/* ==========================================================================
   KPOT To Go — Loyalty: points, stamps and come-back coupons
   --------------------------------------------------------------------------
   The member's ACCOUNT is their MOBILE NUMBER. There is no account, no
   password and no sign-up: the checkout already demands a name and a mobile
   for order updates, so the phone number is the one identifier we already
   hold. normalizePhone() is therefore the foundation of this whole file —
   get it wrong and one guest silently becomes three accounts with their
   points scattered across all of them.

   ⚠️ A phone number IDENTIFIES an account. It does not AUTHORISE anything.
   Anybody can type anybody's number into a public web form, so a bare number
   must never be enough to read a guest's balance or to spend it — otherwise
   whoever knows a phone number can walk off with the $5 waiting on it. The
   two things that do authorise are in this file and both are secrets:

     * a DEVICE CREDENTIAL — a random token minted for one browser after that
       browser's first successful payment, handed to the browser once and kept
       as a sha256 hash here. Possession is the proof.
     * a RECOVERY CODE — six digits mailed to the address on the account,
       short-lived and single-use, for a guest who is on a new phone.

   Everything here is a pure-ish ledger operation on a plain object, plus
   file I/O with every path passed IN (never a constant) so a test run can
   never touch the shop's real customers. Same rule as discounts.js.

   Nothing in here decides money. It answers "how many points does this order
   earn?" and "what may this guest take off?", and hands the answer to
   pricing.js as an ordinary discount.
   ========================================================================== */

'use strict';

const fs = require('fs');
/* Hashing and randomness for the two authorising secrets. Node built-in —
   this project has no dependencies on purpose (see package.json). */
const crypto = require('crypto');
/* Only for the membership date normaliser above — member.js has no
   dependencies of its own, so this cannot become a cycle. */
const MB = require('./member.js');

/* ---- The rules, in one place -------------------------------------------- */

const POINTS_PER_DOLLAR = 1;   // $1 of FOOD = 1 point (tax and tip excluded)
const REDEEM_STEP = 100;       // …spent in whole blocks of 100 points…
const REDEEM_VALUE = 10;       // …each worth $10 off
/* ONE block per order. A guest holding 900 points has nine redemptions in
   them, but they are spent one order at a time — the owner's rule, and the
   reason `steps` is capped here instead of being left to the subtotal. */
const POINT_BLOCKS_PER_ORDER = 1;
const STAMP_EVERY = 10;        // every 10 settled orders earns…
const STAMP_VALUE = 7;         // …a $7 reward
/* The come-back coupon. ON, on the owner's instruction.

   It was switched off for a day because a dated reward sitting next to a
   points balance reads to a guest as "my points expire", and the owner's
   promise is that they do not. The fix for that was the wording (every points
   row now says "never expire"), not the mechanism — the owner has since said
   plainly not to turn it off, so it is back on.

   Keep the two things visually distinct on the panel: POINTS and STAMP
   REWARDS never carry a countdown, a COME-BACK COUPON always does. That
   distinction is the whole reason this was confusing. */
const RETURN_VALUE = 3;
const RETURN_DAYS = 7;
/* A single order must be at least this big to earn one. Measured on the
   order's own subtotal BEFORE any reward was applied — the owner's choice —
   so spending points or a code on the same order cannot cost the guest their
   coupon. Tax and tip are not part of it: they are not what the kitchen
   cooks. */
const RETURN_MIN_SUBTOTAL = 10;

/* Sanity ceilings. A ledger that grows without bound is a ledger that
   eventually fails to load. */
const MAX_CUSTOMERS = 20000;
const MAX_COUPONS = 20;        // per guest; stamp rewards accumulate, returns do not
const KEEP_ORDER_IDS = 200;    // recent settled order ids, for the audit trail
const KEEP_LOG = 40;

/* ---- Browser recognition ---------------------------------------------------
   How many browsers may hold a credential for one account. A credential is
   minted on every successful payment, so a guest who orders weekly for a year
   would otherwise pile up fifty of them.

   ⚠️ WHAT THIS IS AND IS NOT. Since 2026-10-16 the phone number is the
   credential, by the owner's explicit choice: typing the number is enough to
   see and spend that account's rewards. So what is left here is CONVENIENCE,
   not security — a credential lets a phone that has already paid be recognised
   silently, so the guest does not retype their number on every order. It is
   NOT a gate and MUST NOT be treated as one: see resolveLoyalty() in server.js.
   If you are ever tempted to re-add a gate here, re-read the decision record:
   the owner was shown that the number is printed on every order ticket
   (printer.js:153) and chose convenience over the lock anyway. */
const MAX_DEVICES = 8;

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

/* -------------------------------------------------------------------------- */
/* Browser credentials — a convenience, NOT a gate                              */
/* -------------------------------------------------------------------------- */
/* Read the header first: since 2026-10-16 a phone number IS the credential.
   What follows only remembers a browser so a returning guest skips the typing.

   A device credential is a 256-bit random token. The browser gets the token
   exactly once — in the reply to the request that minted it — and we keep
   only its sha256, so a copy of customers.local.json is not a set of keys.

   The hash is unsalted and compared by plain equality, and that is fine here
   in a way it would not be for a password: the input is 32 random bytes, so
   there is no dictionary to run and no guess to make. Salting would buy
   nothing (each token is already unique) and a constant-time compare would
   protect a value an attacker cannot approach one byte at a time. */

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret == null ? '' : secret), 'utf8').digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function deviceId() {
  return 'dv_' + crypto.randomBytes(6).toString('hex');
}

/* Deliberately narrow, like normalizePhone(). The address is optional contact
   data the owner can attach to an account — it authorises nothing, so a typo
   that passes is a typo in a phone book, not a way into an account. */
function normalizeEmail(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s.length < 6 || s.length > 120) return null;
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(s)) return null;
  return s;
}

function findByEmail(list, rawEmail) {
  const e = normalizeEmail(rawEmail);
  if (!e) return null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (normalizeEmail(c && c.email) === e) return c;
  }
  return null;
}

/* Mint a credential for one browser. Returns the PLAINTEXT token — the only
   time it exists outside the browser — or null. */
function issueDevice(cust, label, now) {
  if (!cust) return null;
  const at = now || new Date().toISOString();
  const token = randomToken();
  if (!Array.isArray(cust.devices)) cust.devices = [];
  cust.devices.push({
    id: deviceId(),
    hash: hashSecret(token),
    label: String(label || '').slice(0, 40),
    createdAt: at,
    lastSeenAt: at
  });
  /* Oldest-by-use goes first. A guest who pays every week for a year would
     otherwise accumulate fifty entries and eventually lock themselves out of
     the ledger by filling it. */
  if (cust.devices.length > MAX_DEVICES) {
    cust.devices.sort((a, b) =>
      String((a && a.lastSeenAt) || '').localeCompare(String((b && b.lastSeenAt) || '')));
    cust.devices = cust.devices.slice(-MAX_DEVICES);
  }
  return token;
}

/* Does this browser hold a credential for this account? A yes also refreshes
   lastSeenAt, so the trim above drops the devices nobody uses any more. */
function verifyDevice(cust, token, now) {
  if (!cust || !token) return false;
  const h = hashSecret(token);
  const d = (cust.devices || []).find((x) => x && x.hash === h);
  if (!d) return false;
  d.lastSeenAt = now || new Date().toISOString();
  return true;
}

/* The owner's panic button: "my guest is standing here and their phone says
   somebody else has it". Every credential dies, the guest recovers by e-mail
   and gets a fresh one. */
function revokeDevices(cust) {
  if (!cust) return 0;
  const n = (cust.devices || []).length;
  cust.devices = [];
  return n;
}

function deviceCount(cust) {
  return (cust.devices || []).length;
}

/* ---- Recovery codes ------------------------------------------------------ */
/* GONE on 2026-10-16, by the owner's decision. There is nothing left to
   recover: a phone number is the credential, so "prove you own this number"
   no longer has a rung above it. The mailer went with it. If this feature is
   ever wanted again, the design record is in the 2026-10-16 daily log — but
   note it was switched off precisely because the owner did not want the
   e-mail dependency, so do not silently reintroduce it. */

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
    /* Optional contact data. It authorises nothing — the phone number is the
       credential — so it is a phone-book field, not a key. */
    email: '',
    emailVerified: false,
    points: 0,
    lifetimePoints: 0,
    settledOrders: 0,
    stampsIssued: 0,
    coupons: [],
    /* Browsers this account is signed in on. Hashes only — see issueDevice().
       Convenience for silent recognition, NOT a gate (see the header). */
    devices: [],
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

  /* The authorising secrets. ⚠️ Same whitelist trap as membership below: a
     field not named here is dropped on the next flush, and a dropped device
     credential means every guest on the site is signed out at the next save
     with no error anywhere. */
  c.email = normalizeEmail(raw.email) || '';
  c.emailVerified = !!raw.emailVerified;
  c.devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .map((d) => (d && typeof d === 'object' && /^[0-9a-f]{64}$/.test(String(d.hash || '')))
      ? {
        id: d.id ? String(d.id).slice(0, 40) : deviceId(),
        hash: String(d.hash),
        label: String(d.label || '').slice(0, 40),
        createdAt: d.createdAt ? String(d.createdAt) : null,
        lastSeenAt: d.lastSeenAt ? String(d.lastSeenAt) : null
      }
      : null)
    .filter(Boolean).slice(-MAX_DEVICES);

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

/* Does this order earn a come-back coupon?

   The threshold is a plain subtotal test, on the order's own food total before
   any reward was applied. Deliberately NOT the amount the guest handed over:
   a $14 basket discounted to $6 by points would then fail a $10 test, which
   would punish exactly the guest the coupon is meant to bring back. Tax and
   tip are excluded — they are not what earns points either. */
function comebackEarns(order) {
  return Math.max(0, Number(order && order.subtotal) || 0) >= RETURN_MIN_SUBTOTAL;
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
  if (RETURN_VALUE > 0 && comebackEarns(order)) {
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
   Capped by the subtotal so a $10 reward can never exceed what there is to
   discount — the same clamp pricing.js applies to a dollar code — and by
   POINT_BLOCKS_PER_ORDER, which is the owner's "one redemption per order".
   A guest with 900 points spends them across nine visits, not nine at once. */
function pointsRedemption(cust, subtotal, now) {
  if (!cust) return null;
  const balance = Math.max(0, Math.floor(Number(cust.points) || 0));
  const affordable = Math.floor(balance / REDEEM_STEP);
  const allowed = Math.floor(round2(Math.max(0, Number(subtotal) || 0)) / REDEEM_VALUE);
  const steps = Math.min(affordable, allowed, POINT_BLOCKS_PER_ORDER);
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

/* Why the points row is offering nothing, in the guest's terms.

   The panel needs this because the obvious note — "N more points for $10 off"
   — is a LIE the moment the reward is a $10 block and the basket is a $7 side:
   the guest already has the points, and what is missing is an order big enough
   to absorb the discount. Telling them to earn more points would send them off
   to fix the wrong thing. resolveRedemption() already draws exactly this
   distinction when it refuses a spend; this is the same logic, phrased for the
   panel. */
function pointsHoldReason(cust, subtotal) {
  const balance = Math.max(0, Math.floor(Number(cust && cust.points) || 0));
  if (balance < REDEEM_STEP) return 'low_balance';
  if (subtotal == null) return 'no_basket';
  if (round2(Math.max(0, Number(subtotal) || 0)) < REDEEM_VALUE) return 'order_too_small';
  return 'none';
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

   `rules` rides along so the storefront can phrase "100 points = $10" and
   "every 10 orders" without hard-coding a second copy of the numbers — one
   place to change them, one place they can disagree. */
function rules() {
  return {
    pointsPerDollar: POINTS_PER_DOLLAR,
    redeemStep: REDEEM_STEP,
    redeemValue: REDEEM_VALUE,
    pointBlocksPerOrder: POINT_BLOCKS_PER_ORDER,
    stampEvery: STAMP_EVERY,
    stampValue: STAMP_VALUE,
    returnValue: RETURN_VALUE,
    returnDays: RETURN_DAYS,
    returnMinSubtotal: RETURN_MIN_SUBTOTAL
  };
}

function publicView(cust, subtotal, now) {
  if (!cust) {
    return {
      found: false, identified: false, points: 0, coupons: [], rules: rules(),
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
    /* The phone number is the credential, so every caller who gets this far
       has proved everything the shop asks for. `identified` stays in the
       payload because the guest page reads it, and `found` is what tells the
       panel "nobody has earned on this number yet". */
    identified: true,
    name: maskName(cust.name),
    rules: rules(),
    points: Math.max(0, Math.floor(Number(cust.points) || 0)),
    pointsRedemption: subtotal == null ? null : pointsRedemption(cust, subtotal, now),
    pointsHold: pointsHoldReason(cust, subtotal),
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

/* -------------------------------------------------------------------------- */
/* What a bare phone number gets                                              */
/* -------------------------------------------------------------------------- */
/* THE WHOLE POINT of the 2026-10-16 decision: there is no second answer.

   For six weeks there were two views — this one, and a locked one that told a
   caller with no credential nothing but "an account exists and has rewards on
   it". The owner asked for that, then reversed it: "不需要EMAIL验证了，凭手机号
   码就可以领奖励了". They were shown, in the question that settled it, that the
   number is printed on every order ticket (printer.js:153) and so is not a
   secret — and chose convenience anyway. `resolveLoyalty()` is the other half
   of the same decision and points here.

   If you are about to re-add a lock on this view: that is a product decision
   the owner has already made once, in the other direction. Ask them; do not
   quietly reintroduce it. */

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
    coupons: (cust.coupons || []).slice(-MAX_COUPONS),
    /* The hashes are useless to the console and a liability in a payload it
       writes to a CSV or a screen recording. The COUNT is what the owner
       actually needs: "this guest is signed in on 2 phones", "nobody is". */
    devices: deviceCount(cust)
  });
}

const CSV_COLUMNS = [
  'phone', 'name', 'email', 'points', 'lifetimePoints', 'settledOrders',
  'stampsIssued', 'unusedCoupons', 'devices', 'memberUntil', 'member', 'lastSeenAt'
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
      c.phone, c.name, c.email || '', c.points, c.lifetimePoints, c.settledOrders, c.stampsIssued,
      (c.coupons || []).filter((x) => isUsable(x, now)).length,
      deviceCount(c),
      isMem ? String(c.memberUntil).slice(0, 10) : '',
      isMem ? 'yes' : '',
      c.lastSeenAt || ''
    ].map(csvCell).join(','));
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

module.exports = {
  POINTS_PER_DOLLAR, REDEEM_STEP, REDEEM_VALUE, POINT_BLOCKS_PER_ORDER,
  STAMP_EVERY, STAMP_VALUE, RETURN_VALUE, RETURN_DAYS, RETURN_MIN_SUBTOTAL,
  MAX_CUSTOMERS, MAX_COUPONS, COUPON_KINDS, CSV_COLUMNS,
  MAX_DEVICES,
  round2, normalizePhone, maskName, rules,
  couponId, makeCoupon, isExpired, isUsable,
  blankCustomer, normalizeCoupon, normalizeCustomer,
  loadCustomers, saveCustomers, ensure, find, findByEmail, touch, pushLog,
  pointsBaseFor, pointsFor, isPaidStatus, comebackEarns,
  awardForOrder, pointsRedemption, pointsHoldReason, couponRedemption, resolveRedemption,
  toDescriptor, commitRedemption, releaseRedemption,
  publicView, adminView, toCsv,
  hashSecret, randomToken, normalizeEmail, issueDevice, verifyDevice,
  revokeDevices, deviceCount
};
