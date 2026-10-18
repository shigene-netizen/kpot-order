/* Integration probe: does the RUNNING server actually do what the discount
 * rules say?
 *
 * _dev/test_discount.js proves the arithmetic is right. This proves the server
 * WIRED IT IN — that /api/price and /api/orders really resolve a code, really
 * recompute with it, and really spend the code only when an order exists. A
 * correct function nobody calls is the classic silent failure.
 *
 * It also pins down two behaviours that are easy to get wrong and expensive to
 * discover in production:
 *
 *   - the admin key. Discount codes are the owner's pricing; an open GET would
 *     let anyone enumerate them. Checked over real HTTP, because the stub
 *     server used elsewhere has no auth and cannot see this.
 *   - the code is spent on ORDER CREATION, not when a payment page was opened.
 *     A guest who opens Stripe and walks away must not burn one of the owner's
 *     codes.
 *
 * Runs against SCRATCH files, never the shop's own. The fingerprint check in
 * run_all.sh now includes discounts.local.json.
 *
 * Run:  node _dev/probe_discount_http.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8933;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-admin-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-disc-http-'));

/* One 'Hot Pot To Go' bowl: $15.99 base, 6% tax. */
const UNIT = 15.99;
const SUBTOTAL = 15.99;
const TAX = 0.96;
const TOTAL = 16.95;

function headers(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}
const adminH = () => headers({ 'X-Admin-Key': ADMIN });

function post(route, body, h) {
  return fetch(BASE + route, {
    method: 'POST',
    headers: h || headers(),
    body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
}
const put = (route, body) => fetch(BASE + route, {
  method: 'PUT', headers: adminH(), body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
const get = (route, h) => fetch(BASE + route, { headers: h || headers() })
  .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));

function orderFor(n, couponCode, token, total) {
  return {
    no: 'KP-PROBE-DISC-' + n,
    token: 'probe-disc-' + token,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Probe', phone: '', when: 'ASAP' },
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' }],
    subtotal: SUBTOTAL,
    deliveryFee: 0,
    tax: TAX,
    tip: 0,
    surcharge: 0,
    total: total,
    payMethod: 'counter',
    paymentStatus: 'counter',
    paid: false,
    couponCode: couponCode || '',
    source: 'probe'
  };
}

const priceBody = (couponCode) => ({
  orderType: 'pickup',
  items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' }],
  tipAmount: 0,
  couponCode: couponCode || ''
});

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health')
    .then((r) => r.ok ? r.json() : null)
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => new Promise((res) => setTimeout(res, 250)).then(() => waitForHealth(tries - 1)));
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
       refuses those outside opening hours. The clock must not decide these
       cases. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups')
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 250);
}

const CODES = [
  { code: 'TEN', type: 'percent', value: 10, active: true },
  { code: 'FIVE', type: 'amount', value: 5, active: true },
  { code: 'SHIPFREE', type: 'freeship', value: 0, active: true },
  { code: 'BIGSPEND', type: 'amount', value: 5, active: true, minSubtotal: 30 }
];

waitForHealth(60)
  .then(() => {
    console.log('server up on ' + BASE + '\n');

    /* A test must never hold the shop's live Stripe key. KPOT_SECRETS_FILE
       points at a scratch file precisely so this assertion can be made: without
       it the server reads secrets.local.json, the log says "live mode", and the
       first suite that touches Stripe would be spending real money. */
    check('the server did NOT start with the shop\'s live key',
      !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

    /* ---- the codes are the owner's pricing, so they are admin-gated ---- */
    return get('/api/discounts').then((r) => {
      check('GET /api/discounts with no key → 401', r.status === 401, 'status=' + r.status);
      return fetch(BASE + '/api/discounts', { method: 'PUT', headers: headers(), body: '{"codes":[]}' })
        .then((r2) => r2.status).then((s) => {
          check('PUT /api/discounts with no key → 401', s === 401, 'status=' + s);
          return put('/api/discounts', { codes: CODES });
        });
    });
  })
  .then((r) => {
    check('PUT /api/discounts with the key → saved',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);
    return put('/api/discounts', { codes: [{ code: 'TEN', type: 'amount', value: 1 }, { code: 'ten', type: 'percent', value: 5 }] });
  })
  .then((r) => {
    check('a duplicate code is refused, not silently overwritten',
      r.status === 400 && /duplicate/i.test((r.j && r.j.message) || ''), 'status=' + r.status + ' body=' + JSON.stringify(r.j));
    return put('/api/discounts', { codes: [{ code: 'X', type: 'teleport', value: 1 }] });
  })
  .then((r) => {
    check('an unknown discount type is refused',
      r.status === 400 && r.j && r.j.error === 'invalid_discount', 'status=' + r.status);
    return get('/api/discounts', adminH());
  })
  .then((r) => {
    check('the owner reads back exactly the codes that were saved',
      r.status === 200 && r.j.codes.length === CODES.length, 'codes=' + (r.j && r.j.codes.length));

    /* ---- pricing with and without a code ---- */
    return post('/api/price', priceBody(''));
  })
  .then((r) => {
    check('no code → $16.95 and tax $0.96 (nobody can price the browser)',
      r.status === 200 && r.j.total === TOTAL && r.j.tax === TAX,
      'total=' + (r.j && r.j.total) + ' tax=' + (r.j && r.j.tax));
    return post('/api/price', priceBody('TEN'));
  })
  .then((r) => {
    check('TEN (10% off) → $1.60 off', r.status === 200 && r.j.discount === 1.6,
      'discount=' + (r.j && r.j.discount));
    check('TEN → tax recalculated on the discounted amount ($0.86)',
      r.j && r.j.tax === 0.86, 'tax=' + (r.j && r.j.tax));
    check('TEN → new total $15.25', r.j && r.j.total === 15.25, 'total=' + (r.j && r.j.total));
    check('TEN → the code name comes back for display', r.j && r.j.discountCode === 'TEN');
    return post('/api/price', priceBody('FIVE'));
  })
  .then((r) => {
    check('FIVE ($5 off) → $5.00 off, tax $0.66, total $11.65',
      r.j && r.j.discount === 5 && r.j.tax === 0.66 && r.j.total === 11.65,
      JSON.stringify({ d: r.j && r.j.discount, t: r.j && r.j.tax, total: r.j && r.j.total }));
    return post('/api/price', priceBody('shipfree'));
  })
  .then((r) => {
    check('free-delivery code on a pickup order → $0 off, total unchanged',
      r.j && r.j.total === TOTAL, 'total=' + (r.j && r.j.total));
    return post('/api/price', priceBody('NOPE'));
  })
  .then((r) => {
    check('an unknown code is refused at pricing time',
      r.status === 409 && r.j && r.j.error === 'unknown_code', 'status=' + r.status);
    return post('/api/price', priceBody('BIGSPEND'));
  })
  .then((r) => {
    check('a code below its minimum spend is refused',
      r.status === 409 && r.j && r.j.error === 'min_subtotal', 'status=' + r.status);

    /* ---- placing an order ---- */
    return post('/api/orders', orderFor(1, 'TEN', 'a', 15.25));
  })
  .then((r) => {
    check('an order with TEN at the discounted total is accepted',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(r.j));

    /* The guest's idea of the total is not trusted: the same order claiming the
       UNDISCOUNTED total must be refused, or a browser could send the real
       price and still be charged the discounted one (or vice versa). */
    return post('/api/orders', orderFor(2, 'TEN', 'b', 16.95));
  })
  .then((r) => {
    check('an order whose total does not match the discounted price is refused',
      r.status === 400 && r.j && r.j.error === 'total_mismatch', 'status=' + r.status);
    return get('/api/discounts', adminH());
  })
  .then((r) => {
    check('TEN is spent exactly once after one order',
      r.j.codes.find((c) => c.code === 'TEN').used === 1,
      'used=' + r.j.codes.find((c) => c.code === 'TEN').used);
    return post('/api/orders', orderFor(1, 'TEN', 'c', 15.25));
  })
  .then((r) => {
    return get('/api/discounts', adminH()).then((r2) => {
      check('TEN is spent again on a second order',
        r2.j.codes.find((c) => c.code === 'TEN').used === 2,
        'used=' + r2.j.codes.find((c) => c.code === 'TEN').used);
      return r;
    });
  })
  .then(() => post('/api/orders', orderFor(1, 'BIGSPEND', 'd', SUBTOTAL + TAX)))
  .then((r) => {
    check('an order with a min-spend code it does not qualify for is refused',
      r.status === 409 && r.j && r.j.error === 'min_subtotal', 'status=' + r.status);
    return get('/api/discounts', adminH());
  })
  .then((r) => {
    check('a refused order does not spend the code',
      r.j.codes.find((c) => c.code === 'BIGSPEND').used === 0);

    /* ---- staff discount on an existing order ---- */
    return fetch(BASE + '/api/orders/KP-PROBE-DISC-1', {
      method: 'PATCH', headers: adminH(), body: JSON.stringify({ discount: { type: 'amount', value: 3, source: 'staff' } })
    }).then((r2) => r2.json().catch(() => null).then((j) => ({ status: r2.status, j: j })));
  })
  .then((r) => {
    check('staff $3 off a $16.95 order → new total $13.77',
      r.status === 200 && r.j && r.j.total === 13.77 && r.j.discountAmount === 3,
      'total=' + (r.j && r.j.total) + ' off=' + (r.j && r.j.discountAmount));
    check('the staff discount is tagged as staff, not a code',
      r.j && r.j.discount && r.j.discount.source === 'staff');
    return fetch(BASE + '/api/orders/KP-PROBE-DISC-1', {
      method: 'PATCH', headers: adminH(), body: JSON.stringify({ discount: { type: 'teleport', value: 999 } })
    }).then((r2) => r2.json().catch(() => null).then((j) => ({ status: r2.status, j: j })));
  })
  .then((r) => {
    check('an unknown staff discount type is refused (fail closed)',
      r.status === 400 && r.j && r.j.error === 'bad_discount', 'status=' + r.status);
    return fetch(BASE + '/api/orders/KP-PROBE-DISC-1', {
      method: 'PATCH', headers: adminH(), body: JSON.stringify({ discount: { type: 'amount', value: 999, source: 'staff' } })
    }).then((r2) => r2.json().catch(() => null).then((j) => ({ status: r2.status, j: j })));
  })
  .then((r) => {
    check('a staff discount bigger than the order is refused rather than going negative',
      r.status === 400 && r.j && r.j.error === 'bad_discount', 'status=' + r.status);
    return fetch(BASE + '/api/orders/KP-PROBE-DISC-1', {
      method: 'PATCH', headers: adminH(), body: JSON.stringify({ discount: null })
    }).then((r2) => r2.json().catch(() => null).then((j) => ({ status: r2.status, j: j })));
  })
  .then((r) => {
    check('removing the discount restores the original $16.95',
      r.status === 200 && r.j && r.j.total === TOTAL && r.j.discountAmount === 0,
      'total=' + (r.j && r.j.total));
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    if (fail) console.log('\n--- server log ---\n' + serverLog);
    finish(fail ? 1 : 0);
  })
  .catch((e) => {
    console.log('  FAIL  could not run probe: ' + e.message);
    console.log(serverLog);
    finish(1);
  });
