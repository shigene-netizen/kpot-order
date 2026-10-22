/* Integration probe: does the RUNNING server spend store credit the way the
 * rules say?
 *
 * _dev/test_credit.js proves the ledger arithmetic. This proves the server
 * WIRED IT IN — at both money gates, once per order, and only for real:
 *
 *   - /api/price resolves a code and adopts its worth without spending it;
 *   - /api/checkout prices the deduction, and for a FULLY covered order sends
 *     the guest nowhere near Stripe (no session, no line items, no charge);
 *   - POST /api/orders is the ONLY place the balance moves, and it moves by
 *     exactly what the server priced;
 *   - a cancelled order puts the money back, exactly once;
 *   - a browser cannot claim its way to a free order: payMethod 'credit' on an
 *     order that still owes money is refused, and a forged 'verified' status
 *     is still ignored.
 *
 * The ledger is seeded through credits.js itself (issue + saveCredits), so the
 * file format on disk is the module's own, not a hand-written guess.
 *
 * Hermetic: every file the server touches lives in a scratch directory,
 * including the credit ledger. Run:  node _dev/probe_credit_http.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.dirname(__dirname);
const CR = require(path.join(ROOT, 'credits.js'));

const PORT = 8941;
const STRIPE_PORT = 8942;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-credit-admin-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-credit-http-'));

/* The winner's code and a nearly-empty one, so partial coverage is exercised
   too. Seeded through the module itself. */
const CODE_FULL = 'KPOT-PROBE-AAAA-BBBB';
const CODE_SMALL = 'KPOT-PROBE-SMALL-1';
const CREDITS_FILE = path.join(SCRATCH, 'credits.local.json');

/* One 'Hot Pot To Go' bowl: $15.99 base, 6% tax, $16.95 total. */
const UNIT = 15.99;
const SUBTOTAL = 15.99;
const TAX = 0.96;
const TOTAL = 16.95;

/* ---- the Stripe stub: counts calls so "no session was created" is provable */
let stripeCalls = 0;
let stripeBodies = [];
const stripeStub = http.createServer((req, res) => {
  stripeCalls++;
  let body = '';
  req.on('data', (c) => { body += c.toString(); });
  req.on('end', () => {
    stripeBodies.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'cs_test_stub_' + stripeCalls, url: 'https://stub.invalid/pay/' + stripeCalls }));
  });
});

const headers = (extra) => Object.assign({ 'Content-Type': 'application/json' }, extra || {});
const adminH = () => headers({ 'X-Admin-Key': ADMIN });
const post = (route, body, h) => fetch(BASE + route, {
  method: 'POST', headers: h || headers(), body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
const get = (route, h) => fetch(BASE + route, { headers: h || headers() })
  .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
const patch = (route, body, h) => fetch(BASE + route, {
  method: 'PATCH', headers: h || adminH(), body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
const put = (route, body) => fetch(BASE + route, {
  method: 'PUT', headers: adminH(), body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));

const priceBody = (extra) => Object.assign({
  orderType: 'pickup',
  items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' }],
  tipAmount: 0,
  couponCode: ''
}, extra || {});

function orderFor(n, extra) {
  return Object.assign({
    no: 'KP-PROBE-CREDIT-' + n,
    token: 'probe-credit-' + n,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Probe', phone: '', when: 'ASAP' },
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' }],
    subtotal: SUBTOTAL,
    deliveryFee: 0,
    tax: TAX,
    tip: 0,
    surcharge: 0,
    total: TOTAL,
    payMethod: 'counter',
    paymentStatus: 'counter',
    paid: false,
    creditCode: '',
    source: 'probe'
  }, extra || {});
}

let pass = 0, fail = 0;
function check(desc, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + desc + (cond ? '' : '\n         ' + (detail || '')));
}

function ledgerBalance(code) {
  const store = CR.loadCredits(CREDITS_FILE);
  const r = CR.balanceOf(store, code);
  return r.ok ? r.balance : null;
}

/* POST /api/orders answers {ok,id,status}, and GET /api/orders/:id is the
   guest's limited view (status only). The board's list is the full record —
   that is what this reads, the same way a staff member would. */
const getOrder = (id) => get('/api/orders', adminH()).then((r) => ({
  j: (r.j && r.j.orders || []).find((o) => o.id === id) || null
}));

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => new Promise((res) => setTimeout(res, 250)).then(() => waitForHealth(tries - 1)));
}

/* ---- seed the ledger BEFORE the server boots, through the module itself -- */
const seed = CR.blankStore();
CR.issue(seed, CODE_FULL, 66, { roundId: 'probe-round', now: new Date().toISOString() });
CR.issue(seed, CODE_SMALL, 1.5, { roundId: 'probe-round', now: new Date().toISOString() });
CR.saveCredits(CREDITS_FILE, seed);

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_CREDITS_FILE: CREDITS_FILE,
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    /* The one that got away: this suite PUTs /api/discounts to seed the coupon
       it needs for the one-discount-per-order check, and without this the
       server wrote that list over the shop's REAL coupons — run_all.sh caught
       it as "shop data: CHANGED", which is exactly what the fingerprint is
       for. Hermeticity is per-file, not per-suite. */
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:' + STRIPE_PORT + '/v1/checkout/sessions',
    STRIPE_SECRET_KEY: 'sk_test_probe_credit_not_real'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { stripeStub.close(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 250);
}

stripeStub.listen(STRIPE_PORT, '127.0.0.1', () => {
  waitForHealth(80).then(() => {
    console.log('server up on ' + BASE + '\n');

    check('the server did NOT start with the shop\'s live key',
      !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');
    check('the ledger booted with the two seeded codes',
      ledgerBalance(CODE_FULL) === 66 && ledgerBalance(CODE_SMALL) === 1.5,
      'full=' + ledgerBalance(CODE_FULL) + ' small=' + ledgerBalance(CODE_SMALL));

    /* A real coupon, so "a credit and a coupon together" exercises the
       three-way XOR rather than tripping over an unknown code first. */
    return put('/api/discounts', { codes: [{ code: 'TEN', type: 'percent', value: 10, active: true }] });
  }).then((r) => {
    check('the coupon TEN is seeded for the conflict test',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);

    /* ---- A. pricing: the code is worth what the ledger says ---- */
    return post('/api/price', priceBody()).then((r) => {
      check('no code → the untouched $16.95', r.status === 200 && r.j.total === TOTAL,
        'total=' + (r.j && r.j.total));
      return post('/api/price', priceBody({ creditCode: CODE_FULL }));
    });
  }).then((r) => {
    check('a $66 code on a $15.99 order takes $15.99, not $66',
      r.status === 200 && r.j.discount === SUBTOTAL, 'discount=' + (r.j && r.j.discount));
    check('tax is recomputed on the discounted amount ($0)',
      r.j && r.j.tax === 0, 'tax=' + (r.j && r.j.tax));
    check('the order totals $0.00', r.j && r.j.total === 0, 'total=' + (r.j && r.j.total));
    check('the response says how much will be LEFT on the code',
      r.j && r.j.credit && r.j.credit.balanceAfter === 50.01,
      JSON.stringify(r.j && r.j.credit));
    check('the credit line carries only a mask, never the code',
      r.j && r.j.credit && r.j.credit.codeRef === 'KPOT…BB' && !JSON.stringify(r.j).includes(CODE_FULL),
      JSON.stringify(r.j && r.j.credit));
    check('pricing did NOT spend anything',
      ledgerBalance(CODE_FULL) === 66, 'balance=' + ledgerBalance(CODE_FULL));

    return post('/api/price', priceBody({ creditCode: 'kpot-probe-aaaa-bbbb' }));
  }).then((r) => {
    check('a code typed in lower case still resolves',
      r.status === 200 && r.j.discount === SUBTOTAL, 'discount=' + (r.j && r.j.discount));
    return post('/api/price', priceBody({ creditCode: CODE_SMALL }));
  }).then((r) => {
    check('a $1.50 code takes $1.50 and leaves the rest to pay',
      r.j && r.j.discount === 1.5 && r.j.tax === 0.87 && r.j.total === 15.36,
      JSON.stringify({ d: r.j && r.j.discount, t: r.j && r.j.tax, total: r.j && r.j.total }));
    return post('/api/price', priceBody({ creditCode: 'KPOT-NOPE-NOPE-NOPE' }));
  }).then((r) => {
    check('an unknown code is refused at pricing time',
      r.status === 409 && r.j && r.j.error === 'credit_not_found', 'status=' + r.status);
    return post('/api/price', priceBody({ creditCode: CODE_FULL, couponCode: 'TEN' }));
  }).then((r) => {
    check('a credit and a coupon together are refused — one discount per order',
      r.status === 409 && r.j && r.j.error === 'one_discount_only', 'status=' + r.status);

    /* ---- B. the balance endpoint ---- */
    return get('/api/credit/balance?code=' + encodeURIComponent(CODE_FULL));
  }).then((r) => {
    check('the balance endpoint reads the ledger',
      r.status === 200 && r.j.ok === true && r.j.balance === 66, JSON.stringify(r.j));
    return get('/api/credit/balance?code=' + encodeURIComponent('KPOT-NOPE-NOPE-NOPE'));
  }).then((r) => {
    check('an unknown code on the balance endpoint is 404, not a guess',
      r.status === 404 && r.j && r.j.ok === false, 'status=' + r.status);
    return get('/api/credit/balance');
  }).then((r) => {
    check('no code on the balance endpoint is 400', r.status === 400, 'status=' + r.status);

    /* ---- C. checkout: covered orders never reach Stripe ---- */
    return post('/api/checkout', orderFor(90, {
      creditCode: CODE_FULL, total: 0, tax: 0, payMethod: 'stripe', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a fully covered checkout returns no session and no URL',
      r.status === 200 && r.j.covered === true && r.j.url === null && r.j.total === 0,
      JSON.stringify(r.j).slice(0, 160));
    check('the covered checkout still reports the credit split',
      r.j && r.j.breakdown && r.j.breakdown.credit && r.j.breakdown.credit.applied === 15.99 &&
      r.j.breakdown.credit.balanceAfter === 50.01,
      JSON.stringify(r.j && r.j.breakdown && r.j.breakdown.credit));
    check('Stripe was NOT called for the covered order',
      stripeCalls === 0, 'calls=' + stripeCalls);
    check('checkout did not spend anything either',
      ledgerBalance(CODE_FULL) === 66, 'balance=' + ledgerBalance(CODE_FULL));

    return post('/api/checkout', orderFor(91, {
      creditCode: CODE_SMALL, total: 15.36, tax: 0.87, payMethod: 'stripe', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a partially covered checkout DOES start a session for the remainder',
      r.status === 200 && !!r.j.url && r.j.total === 15.36, 'status=' + r.status + ' total=' + (r.j && r.j.total));
    /* Two Stripe calls for one discounted session: the one-shot coupon that
       carries the credit's share, then the session itself. A covered order
       makes neither — that is the assertion two steps up. The form is
       URL-encoded, so the amounts appear as "=1599" / "=87". */
    check('Stripe was called twice: the discount coupon, then the session',
      stripeCalls === 2 && /=1599/.test(stripeBodies[1] || '') && /=87/.test(stripeBodies[1] || ''),
      'calls=' + stripeCalls + ' body=' + (stripeBodies[1] || '').slice(0, 200));
    check('the small code is still untouched after checkout',
      ledgerBalance(CODE_SMALL) === 1.5, 'balance=' + ledgerBalance(CODE_SMALL));

    /* ---- D. the order: the balance moves HERE, and only here ---- */
    return post('/api/orders', orderFor(1, {
      creditCode: CODE_FULL, total: 0, tax: 0, payMethod: 'credit', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a fully covered order is accepted',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(r.j).slice(0, 160));
    check('the ledger moved by exactly the priced amount: $66 → $50.01',
      ledgerBalance(CODE_FULL) === 50.01, 'balance=' + ledgerBalance(CODE_FULL));
    return getOrder('KP-PROBE-CREDIT-1');
  }).then((r) => {
    check('it lands PAID without anyone asking Stripe',
      r.j && r.j.paymentStatus === 'verified',
      'paymentStatus=' + (r.j && r.j.paymentStatus));
    check('the order records the credit split',
      r.j && r.j.credit && r.j.credit.applied === 15.99 &&
      r.j.credit.balanceAfter === 50.01 && r.j.credit.released === false,
      JSON.stringify(r.j && r.j.credit));

    return post('/api/orders', orderFor(2, {
      creditCode: CODE_FULL, total: 0, tax: 0, payMethod: 'credit', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a second covered order is accepted',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);
    check('it spends the REMAINING balance correctly: $50.01 → $34.02',
      ledgerBalance(CODE_FULL) === 34.02, 'balance=' + ledgerBalance(CODE_FULL));
    return getOrder('KP-PROBE-CREDIT-2');
  }).then((r) => {
    check('the second order records its own split ($15.99 off, $34.02 left)',
      r.j && r.j.credit && r.j.credit.applied === 15.99 &&
      r.j.credit.balanceAfter === 34.02,
      JSON.stringify(r.j && r.j.credit));

    /* ---- E. a browser cannot claim its way to a free order ---- */
    return post('/api/orders', orderFor(3, {
      total: TOTAL, payMethod: 'credit', paymentStatus: 'verified'
    }));
  }).then((r) => {
    check('payMethod "credit" on an order that still owes $16.95 is refused',
      r.status === 409 && r.j && r.j.error === 'order_owes_money', 'status=' + r.status + ' ' + JSON.stringify(r.j));
    return post('/api/orders', orderFor(4, {
      creditCode: CODE_SMALL, total: 15.36, tax: 0.87, payMethod: 'credit', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a partially covered order may not claim "credit" either — money is still owed',
      r.status === 409 && r.j && r.j.error === 'order_owes_money', 'status=' + r.status);
    check('and the refused order spent nothing',
      ledgerBalance(CODE_SMALL) === 1.5, 'balance=' + ledgerBalance(CODE_SMALL));
    return post('/api/orders', orderFor(5, {
      total: TOTAL, payMethod: 'counter', paymentStatus: 'verified'
    }));
  }).then((r) => {
    check('a forged "verified" on a counter order is still ignored',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);
    return getOrder('KP-PROBE-CREDIT-5');
  }).then((r) => {
    check('…it was recorded as a plain pay-at-counter order',
      r.j && r.j.paymentStatus === 'counter',
      'paymentStatus=' + (r.j && r.j.paymentStatus));
    return post('/api/orders', orderFor(6, {
      creditCode: CODE_FULL, total: 5, tax: 0, payMethod: 'credit', paymentStatus: 'unverified'
    }));
  }).then((r) => {
    check('a covered order claiming a made-up total is refused by the total gate',
      r.status === 400 && r.j && r.j.error === 'total_mismatch', 'status=' + r.status + ' ' + JSON.stringify(r.j));
    check('the refused order spent nothing',
      ledgerBalance(CODE_FULL) === 34.02, 'balance=' + ledgerBalance(CODE_FULL));

    /* ---- F. cancellation puts the money back, exactly once ---- */
    return patch('/api/orders/KP-PROBE-CREDIT-1', { status: 'cancelled' });
  }).then((r) => {
    check('an admin can cancel the order', r.status === 200 && r.j && r.j.ok === true,
      'status=' + r.status + ' ' + JSON.stringify(r.j).slice(0, 120));
    check('the credit came back: $34.02 → $50.01',
      ledgerBalance(CODE_FULL) === 50.01, 'balance=' + ledgerBalance(CODE_FULL));
    return patch('/api/orders/KP-PROBE-CREDIT-1', { status: 'received' });
  }).then(() => patch('/api/orders/KP-PROBE-CREDIT-1', { status: 'cancelled' }))
    .then(() => {
      check('cancelling again (via a status round-trip) does not restore twice',
        ledgerBalance(CODE_FULL) === 50.01, 'balance=' + ledgerBalance(CODE_FULL));
      return getOrder('KP-PROBE-CREDIT-1');
    })
    .then((r) => {
    check('the order is on the board as cancelled and paid',
      r.j && r.j.status === 'cancelled' && r.j.paymentStatus === 'verified',
      JSON.stringify({ s: r.j && r.j.status, p: r.j && r.j.paymentStatus }));
    check('the order still remembers what it spent, marked released',
      r.j && r.j.credit && r.j.credit.applied === 15.99 && r.j.credit.released === true,
      JSON.stringify(r.j && r.j.credit));

    /* ---- G. a counter order the credit only partly covers ---- */
    return post('/api/orders', orderFor(7, {
      creditCode: CODE_SMALL, total: 15.36, tax: 0.87, payMethod: 'counter', paymentStatus: 'counter'
    }));
  }).then((r) => {
    check('a counter order the credit only partly covers is accepted and stays unpaid',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);
    check('and it spent the $1.50',
      ledgerBalance(CODE_SMALL) === 0, 'balance=' + ledgerBalance(CODE_SMALL));
    return getOrder('KP-PROBE-CREDIT-7');
  }).then((r) => {
    check('the board sees $15.36 still to collect, not "paid"',
      r.j && r.j.paymentStatus === 'counter' && r.j.total === 15.36,
      'ps=' + (r.j && r.j.paymentStatus) + ' total=' + (r.j && r.j.total));
    return post('/api/orders', orderFor(8, {
      creditCode: CODE_SMALL, total: TOTAL, tax: TAX, payMethod: 'counter', paymentStatus: 'counter'
    }));
  }).then((r) => {
    check('an empty code takes nothing off and changes nothing',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);
    return getOrder('KP-PROBE-CREDIT-8');
  }).then((r) => {
    check('the order totals the untouched $16.95 with no discount',
      r.j && r.j.total === TOTAL && r.j.discountAmount === 0,
      'total=' + (r.j && r.j.total) + ' discount=' + (r.j && r.j.discountAmount));

    console.log('\n--- ledger at the end ---');
    console.log('  ' + CODE_FULL + ' → $' + ledgerBalance(CODE_FULL) + ' (started $66, one order cancelled)');
    console.log('  ' + CODE_SMALL + ' → $' + ledgerBalance(CODE_SMALL) + ' (started $1.50, one order placed)');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    finish(fail === 0 ? 0 : 1);
  }).catch((e) => {
    console.error('probe crashed:', e && e.stack || e);
    console.log('\n--- server log (tail) ---\n' + serverLog.slice(-2000));
    finish(1);
  });
});
