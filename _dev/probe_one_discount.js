/* Integration probe: ONE reward per order, exhaustively.
 *
 * The owner's standing rule: 每单只用一种奖励、最多一次、不叠加. The server
 * enforces it in resolveOrderDiscount() with a single line —
 *
 *     const chosen = [coupon.discount, loyalty.discount, credit.discount].filter(Boolean);
 *     if (chosen.length > 1) return { error: 'one_discount_only', ... }
 *
 * — and the existing suites each prove ONE corner of that from their own
 * corner: probe_loyalty proves code×points, probe_credit_http proves
 * code×credit, probe_member proves code×member-perk. Each of those probes has
 * to build the OTHER feature's fixture to do it, so nobody ever built all of
 * them at once, and the cells in the middle of the table were never asked:
 *
 *     credit × points          <- never tested
 *     credit × member perk     <- never tested
 *     coupon × points × credit <- never tested (all three)
 *     welcome × credit         <- never tested (the offer must yield)
 *     welcome × points         <- never tested (defensively)
 *
 * A rule that is only proven at its corners is a rule that can be broken in
 * the middle. This probe builds every fixture once and walks the whole table,
 * at BOTH gates: /api/price (what the guest sees) and POST /api/orders (where
 * the money actually moves).
 *
 * Shape of the proof, in order:
 *   0. each reward ALONE resolves, with the right source and a non-zero
 *      amount. Without this the refusals below prove nothing — a reward that
 *      was never recognised would be "refused in combination" for the wrong
 *      reason, which is exactly the false-green this project keeps hitting.
 *   1. every PAIR of explicit rewards is refused with one_discount_only;
 *   2. all three together are refused;
 *   3. the automatic welcome offer YIELDS to any explicit choice — no error,
 *      the guest simply gets what they asked for;
 *   4. the refusal holds at the money gate, and no order is created.
 *
 * Hermetic: every file the server touches lives in a scratch directory.
 * Run:  node _dev/probe_one_discount.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const CR = require(path.join(ROOT, 'credits.js'));

const PORT = 8953;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-one-admin-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-one-discount-'));

const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');
const CUSTOMERS_FILE = path.join(SCRATCH, 'customers.local.json');
const CREDITS_FILE = path.join(SCRATCH, 'credits.local.json');

/* One 'Hot Pot To Go' bowl: $15.99, 6% tax, $16.95. */
const UNIT = 15.99;
const SUBTOTAL = 15.99;
const TAX = 0.96;
const FULL = 16.95;

/* A returning customer: points on the ledger AND a live membership. Two
   separate rewards on the same number, so both can be asked for at once. */
const P_KNOWN = '7708889999';
/* A first-time guest: no orders at all, so the welcome offer is in play. */
const P_NEW = '7707770000';

/* Points: 100 = $10 off (customers.js REDEEM_STEP / REDEEM_VALUE). A $15.99
   basket affords exactly one block, so the reward is a flat $10. */
const POINTS_BAL = 500;
const POINTS_OFF = 10;

const CREDIT_CODE = 'KPOT-ONLY-MATRIX-1';
const CREDIT_OFF = 5;

const COUPON = 'ONLYPROBE';
const COUPON_OFF = 2;

/* Member perk: 5% of $15.99 = $0.7995 → $0.80 (config.js member.percent). */
const MEMBER_OFF = 0.8;

const ITEM = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' };

function headers(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}
const adminH = () => headers({ 'X-Admin-Key': ADMIN });

function post(route, body, h) {
  return fetch(BASE + route, {
    method: 'POST', headers: h || headers(), body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
}
const put = (route, body) => fetch(BASE + route, {
  method: 'PUT', headers: adminH(), body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
function getOrders() {
  return fetch(BASE + '/api/orders', { method: 'GET', headers: adminH() })
    .then((r) => r.json().catch(() => null))
    .then((j) => (j && j.orders) || []);
}

/* The basket every request below sends, with the reward wishes layered on. */
function priceBody(extra) {
  return Object.assign({
    orderType: 'pickup',
    items: [ITEM],
    tipAmount: 0,
    couponCode: '',
    customer: { phone: P_KNOWN }
  }, extra || {});
}

const loyalty = (req) => Object.assign({ device: 'probe-device-token' }, req || {});

/* The three explicit wishes, alone and in combination. */
const W_COUPON = { couponCode: COUPON };
const W_POINTS = { loyalty: loyalty({ phone: P_KNOWN, redeemPoints: true }) };
const W_CREDIT = { creditCode: CREDIT_CODE };
const W_MEMBER = { loyalty: loyalty({ phone: P_KNOWN, memberChoice: 'member_percent' }) };

/* Wishes are LAYERED, not replaced. Asking for points and the member perk is
   ONE loyalty request carrying two wishes — which is the inner guard's job
   (one_reward_only), not two independent requests. A shallow Object.assign
   here would silently drop whichever came second and the pair would look
   "accepted" when it was never asked. */
function mix(...wishes) {
  const out = {};
  for (const w of wishes) {
    for (const k of Object.keys(w)) {
      if (k === 'loyalty' || k === 'customer') {
        out[k] = Object.assign({}, out[k] || {}, w[k]);
      } else {
        out[k] = w[k];
      }
    }
  }
  return out;
}

function orderFor(n, extra) {
  return Object.assign({
    no: 'KP-ONLY-' + n,
    token: 'only-' + n,
    /* DINE-IN: pay-at-counter is refused on pickup and delivery since
       2026-10-22, and this suite is about rewards, not channels. */
    orderType: 'dinein',
    table: '5',
    customer: { name: 'Matrix One', phone: '(770) 888-9999', when: 'ASAP' },
    items: [ITEM],
    subtotal: SUBTOTAL,
    deliveryFee: 0,
    tax: TAX,
    tip: 0,
    surcharge: 0,
    total: FULL,
    payMethod: 'counter',
    paymentStatus: 'counter',
    paid: false,
    couponCode: '',
    source: 'probe'
  }, extra || {});
}

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n' + t); }

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health')
    .then((r) => r.ok ? r.json() : null)
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => new Promise((res) => setTimeout(res, 250)).then(() => waitForHealth(tries - 1)));
}

/* -------------------------------------------------------------------------- */
/* fixtures, written before the server boots                                    */
/* -------------------------------------------------------------------------- */
const guest = (phone, name, points) => ({
  phone: phone,
  name: name,
  email: '',
  points: points,
  lifetimePoints: points,
  settledOrders: 0,
  stampsIssued: 0,
  coupons: [],
  devices: [],
  settledOrderIds: [],
  log: [],
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  /* Live membership, so member_percent is a real choice and not a refusal. */
  memberUntil: new Date(Date.now() + 365 * 86400000).toISOString(),
  memberCouponIssuedFor: null
});

fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify({
  updatedAt: new Date().toISOString(),
  customers: [guest(P_KNOWN, 'Matrix One', POINTS_BAL), guest(P_NEW, 'Matrix New', POINTS_BAL)]
}, null, 2));

/* A prior order for the returning number ONLY. This is what makes
   isFirstTimeCustomer() say "known" for P_KNOWN while P_NEW stays a
   first-timer — the welcome offer is then genuinely in play for the new
   number and genuinely absent for the other, which is the difference the
   last phase of this probe depends on. */
fs.writeFileSync(ORDERS_FILE, JSON.stringify([{
  id: 'KP-ONLY-WARM',
  at: new Date(Date.now() - 86400000).toISOString(),
  status: 'collected',
  orderType: 'dinein',
  customer: { name: 'Matrix One', phone: '(770) 888-9999' },
  total: FULL,
  paymentStatus: 'paid'
}], null, 2));

/* The store-credit code, seeded through credits.js itself so the file on disk
   is the module's own format and not a hand-written guess. */
const seed = CR.blankStore();
CR.issue(seed, CREDIT_CODE, CREDIT_OFF, { roundId: 'probe-matrix', now: new Date().toISOString() });
CR.saveCredits(CREDITS_FILE, seed);

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    KPOT_ORDERS_FILE: ORDERS_FILE,
    KPOT_CUSTOMERS_FILE: CUSTOMERS_FILE,
    KPOT_CREDITS_FILE: CREDITS_FILE,
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    KPOT_GIVEAWAY_FILE: path.join(SCRATCH, 'giveaway.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:1'
  })
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const finish = (code) => {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
};

/* -------------------------------------------------------------------------- */
/* the table                                                                     */
/* -------------------------------------------------------------------------- */
waitForHealth(60)
  .then(() => put('/api/discounts', { codes: [{ code: COUPON, type: 'amount', value: COUPON_OFF, active: true }] }))
  .then((r) => {
    check('the owner published a real discount code (not a typo — a typo would be refused on its own and prove nothing)',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);

    /* ---- 0. each reward ALONE ----------------------------------------
       The false-green guard. Every refusal below is only meaningful if the
       reward being refused was actually recognised. */
    section('0. each reward alone resolves, with its own source');

    return post('/api/price', priceBody(W_COUPON));
  })
  .then((r) => {
    check('a coupon alone takes $2.00 off and is tagged "code"',
      r.status === 200 && r.j.discount === COUPON_OFF && r.j.discountSource === 'code',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    return post('/api/price', priceBody(W_POINTS));
  })
  .then((r) => {
    check('points alone take $10.00 off and are tagged "loyalty"',
      r.status === 200 && r.j.discount === POINTS_OFF && r.j.discountSource === 'loyalty',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    return post('/api/price', priceBody(W_CREDIT));
  })
  .then((r) => {
    check('store credit alone takes $5.00 off and is tagged "credit"',
      r.status === 200 && r.j.discount === CREDIT_OFF && r.j.discountSource === 'credit',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    return post('/api/price', priceBody(W_MEMBER));
  })
  .then((r) => {
    check('the member perk alone takes $0.80 off and is tagged "member"',
      r.status === 200 && r.j.discount === MEMBER_OFF && r.j.discountSource === 'member',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));

    /* And the automatic offer, on a number with no history at all. */
    return post('/api/price', priceBody({ customer: { phone: P_NEW } }));
  })
  .then((r) => {
    check('the welcome offer alone is 10% and is tagged "welcome"',
      r.status === 200 && r.j.discount === 1.6 && r.j.discountSource === 'welcome',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));

    /* ---- 1. every PAIR of explicit rewards ---------------------------- */
    section('1. every pair of explicit rewards is refused');

    return post('/api/price', priceBody(mix(W_COUPON, W_POINTS)));
  })
  .then((r) => {
    check('coupon + points are refused',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));
    return post('/api/price', priceBody(mix(W_COUPON, W_CREDIT)));
  })
  .then((r) => {
    check('coupon + store credit are refused',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));
    return post('/api/price', priceBody(mix(W_COUPON, W_MEMBER)));
  })
  .then((r) => {
    check('coupon + member perk are refused',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));
    return post('/api/price', priceBody(mix(W_POINTS, W_CREDIT)));
  })
  .then((r) => {
    check('points + store credit are refused  <- was never tested before',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));
    return post('/api/price', priceBody(mix(W_POINTS, W_MEMBER)));
  })
  .then((r) => {
    /* Points and the member perk are TWO WISHES INSIDE ONE loyalty request, so
       they are caught by the inner guard first — one_reward_only, a different
       code from the outer one_discount_only, and the guest-facing sentence is
       different too ("Pick one reward for this order"). Same rule, nearer the
       input, better message. */
    check('points + member perk are refused by the INNER guard (one_reward_only)',
      r.status === 409 && r.j && r.j.error === 'one_reward_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));
    return post('/api/price', priceBody(mix(W_CREDIT, W_MEMBER)));
  })
  .then((r) => {
    check('store credit + member perk are refused  <- was never tested before',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));

    /* ---- 2. all three at once ---------------------------------------- */
    section('2. all three together are refused');

    return post('/api/price', priceBody(mix(W_COUPON, W_POINTS, W_CREDIT)));
  })
  .then((r) => {
    check('coupon + points + store credit are refused  <- was never tested before',
      r.status === 409 && r.j && r.j.error === 'one_discount_only',
      'status=' + r.status + ' error=' + (r.j && r.j.error));

    /* ---- 3. the automatic offer YIELDS -------------------------------
       It is unrequested, so it must never fight the guest for the bill: no
       error, and the reward the guest actually asked for is the one they
       get. (welcome+coupon is already covered by probe_first_visit; the
       other two were not.) */
    section('3. the automatic welcome offer yields to an explicit choice');

    return post('/api/price', priceBody(mix(W_CREDIT, { customer: { phone: P_NEW } })));
  })
  .then((r) => {
    check('a first-timer with a store-credit code gets the CODE, no error  <- was never tested',
      r.status === 200 && r.j.discount === CREDIT_OFF && r.j.discountSource === 'credit' && !(r.j && r.j.error),
      'status=' + r.status + ' discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    return post('/api/price', priceBody(mix(W_POINTS, { customer: { phone: P_NEW } })));
  })
  .then((r) => {
    /* Defensive: in practice a guest holding points has already ordered, so
       welcome×points is unreachable. It is asserted anyway, because the
       server should not DEPEND on that correlation holding. */
    check('a first-timer asking for points gets the POINTS, no error  <- was never tested',
      r.status === 200 && r.j.discount === POINTS_OFF && r.j.discountSource === 'loyalty' && !(r.j && r.j.error),
      'status=' + r.status + ' discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    return post('/api/price', priceBody(mix(W_MEMBER, { customer: { phone: P_NEW } })));
  })
  .then((r) => {
    check('a first-timer asking for the member perk gets the PERK, no error  <- was never tested',
      r.status === 200 && r.j.discount === MEMBER_OFF && r.j.discountSource === 'member' && !(r.j && r.j.error),
      'status=' + r.status + ' discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));

    /* ---- 4. the money gate -------------------------------------------
       Refusing at /api/price is only advice to the browser. The rule has to
       hold where the order is actually accepted — and the refused order must
       not exist afterwards. */
    section('4. the refusal holds at the money gate, and no order is created');

    return getOrders().then((before) => {
      const beforeCount = before.length;
      return post('/api/orders', orderFor('MIX', {
        couponCode: COUPON,
        creditCode: CREDIT_CODE,
        loyalty: loyalty({ phone: P_KNOWN, redeemPoints: true })
      })).then((r) => ({ r: r, beforeCount: beforeCount }));
    });
  })
  .then((out) => {
    check('POST /api/orders refuses points + credit + coupon the same way',
      out.r.status === 409 && out.r.j && out.r.j.error === 'one_discount_only',
      'status=' + out.r.status + ' error=' + (out.r.j && out.r.j.error));
    return getOrders().then((after) => ({ after: after, beforeCount: out.beforeCount }));
  })
  .then((out) => {
    check('and the refused order was NOT created',
      out.after.length === out.beforeCount,
      'before=' + out.beforeCount + ' after=' + out.after.length);

    /* ---- and a single reward still goes through the money gate -------- */
    /* The claimed total must be the DISCOUNTED one, because the server
       re-prices and compares: $15.99 - $5.00 credit = $10.99, +6% = $11.65.
       Sending the full price here would fail total_mismatch and prove nothing
       about the reward rule. */
    return post('/api/orders', orderFor('SOLO', {
      creditCode: CREDIT_CODE, tax: 0.66, total: 11.65
    }));
  })
  .then((r) => {
    check('a single reward still passes the money gate (the rule refuses pairs, not rewards)',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(r.j));
    return getOrders();
  })
  .then((list) => {
    const rec = (list || []).find((o) => o.id === 'KP-ONLY-SOLO');
    check('and the accepted order carries exactly one reward, the credit',
      rec && rec.discount && rec.discount.source === 'credit' && rec.discountAmount === CREDIT_OFF,
      'source=' + (rec && rec.discount && rec.discount.source) + ' off=' + (rec && rec.discountAmount));

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    if (fail) console.log('\n--- server log ---\n' + serverLog);
    finish(fail ? 1 : 0);
  })
  .catch((e) => {
    console.log('  FAIL  could not run probe: ' + e.message);
    console.log(serverLog);
    finish(1);
  });
