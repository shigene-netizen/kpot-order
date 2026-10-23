/* Integration probe: does the RUNNING server actually give a first-time
 * guest 10% off, automatically, with no code?
 *
 * The rule (owner's words, 2026-10-23): "系统自动检测如果是第一次客人就给
 * 10% 折扣" — a brand-new mobile number gets 10% off, and the guest types
 * nothing. This proves the server WIRED IT IN over real HTTP:
 *
 *   - a never-seen number on /api/price comes back with a 10% welcome discount
 *     (source 'welcome'), so the guest sees it before they pay;
 *   - the same number on a second order gets NOTHING — the offer is spent once;
 *   - a different new number gets it again;
 *   - no number at all → no discount (we cannot identify a first-timer);
 *   - an explicit code the guest typed WINS over the welcome offer, with no
 *     "pick one" error — a first-timer who has a better code keeps it.
 *
 * Runs against SCRATCH files, never the shop's own.
 *
 * Run:  node _dev/probe_first_visit.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8934;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-admin-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-first-visit-'));

/* One 'Hot Pot To Go' bowl: $15.99 base, 6% tax. */
const UNIT = 15.99;
const SUBTOTAL = 15.99;
const TAX = 0.96;
const FULL = 16.95;
const WELCOME_OFF = 1.60;     // 10% of 15.99
const WELCOME_TOTAL = 15.25;  // 15.99 - 1.60 = 14.39; tax 0.86; total 15.25

const PA = '7701112222'; // first-timer #1
const PB = '7703334444'; // first-timer #2
const PC = '7705556666'; // first-timer #3 (uses a code instead)

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
function getOrders() {
  return fetch(BASE + '/api/orders', { method: 'GET', headers: adminH() })
    .then((r) => r.json().catch(() => null))
    .then((j) => (j && j.orders) || []);
}

function priceFor(phone, couponCode) {
  return {
    orderType: 'pickup',
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: UNIT, mods: [], addons: [], note: '' }],
    tipAmount: 0,
    couponCode: couponCode || '',
    customer: { phone: phone || '' }
  };
}

function orderFor(n, phone, total) {
  return {
    no: 'KP-PROBE-FV-' + n,
    token: 'probe-fv-' + n,
    orderType: 'dinein',
    table: '5',
    customer: { name: 'Probe', phone: phone || '', when: 'ASAP' },
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
    couponCode: '',
    source: 'probe'
  };
}

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

waitForHealth(60)
  .then(() => {
    console.log('server up on ' + BASE + '\n');

    check('the server did NOT start with the shop\'s live key',
      !/live mode/i.test(serverLog), 'log had "live mode"');

    /* One code, so we can prove an explicit choice beats the welcome offer. */
    return put('/api/discounts', { codes: [{ code: 'TEN', type: 'percent', value: 10, active: true }] });
  })
  .then((r) => {
    check('a code was saved for the precedence test', r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status);

    /* ---- the heart of it: a brand-new number gets 10% off, automatically ---- */
    return post('/api/price', priceFor(PA));
  })
  .then((r) => {
    check('a never-seen number → 10% welcome discount ($1.60)',
      r.status === 200 && r.j.discount === WELCOME_OFF, 'discount=' + (r.j && r.j.discount));
    check('the welcome discount is tagged source "welcome", not "code"',
      r.j && r.j.discountSource === 'welcome', 'source=' + (r.j && r.j.discountSource));
    check('the welcome label is the one from config',
      r.j && r.j.discountLabel === 'First-time guest — 10% off', 'label=' + (r.j && r.j.discountLabel));
    check('tax is recomputed on the discounted base ($0.86)',
      r.j && r.j.tax === 0.86, 'tax=' + (r.j && r.j.tax));
    check('the welcome total is $15.25', r.j && r.j.total === WELCOME_TOTAL, 'total=' + (r.j && r.j.total));

    /* ---- and it really lands on the order (read back, not just echoed) ---- */
    return post('/api/orders', orderFor(1, PA, WELCOME_TOTAL));
  })
  .then((r) => {
    check('an order placed by that number at the discounted total is accepted',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(r.j));
    const createdId = (r.j && r.j.id) || 'KP-PROBE-FV-1';
    return getOrders().then((list) => {
      const rec = (list || []).find((o) => o.id === createdId);
      check('the recorded order carries the welcome discount',
        rec && rec.discount && rec.discount.source === 'welcome' && rec.discountAmount === WELCOME_OFF,
        'source=' + (rec && rec.discount && rec.discount.source) + ' off=' + (rec && rec.discountAmount));

      /* ---- the return leg: the SAME order, posted again by token --------
         What the guest page actually does when Stripe sends them back
         (app.js, the return leg): it re-posts the very same order, same
         token, to re-resolve the order number before verifying the session.
         By then the order is on the board — so a naive "has this number
         ordered before?" answers YES, prices the SAME order at full price,
         fails its own total check, and never reaches the idempotent-retry
         branch that exists precisely to answer this request. The discount
         has to be a property of the ORDER, not of when the server was asked. */
      return post('/api/orders', orderFor(1, PA, WELCOME_TOTAL)).then((again) => {
        check('the return-leg re-post of the SAME order is accepted, not refused',
          again.status === 200 && again.j && again.j.ok === true,
          'status=' + again.status + ' body=' + JSON.stringify(again.j));
        check('and it resolves to the order that was already recorded',
          again.j && again.j.id === createdId, 'id=' + (again.j && again.j.id));
        check('and it reports itself as the existing order (idempotent)',
          again.j && again.j.existing === true, 'existing=' + (again.j && again.j.existing));

        /* ---- the exclusion must not become a loophole ---------------------
           Skipping the order being priced is only safe if a genuinely SECOND
           order — different token, same number — still sees the first one and
           still pays full price. Without this the "re-post" allowance would
           hand out 10% forever, one token at a time. */
        return post('/api/orders', orderFor(2, PA, FULL)).then((second) => {
          check('a genuinely SECOND order from the same number is accepted at FULL price',
            second.status === 200 && second.j && second.j.ok === true,
            'status=' + second.status + ' body=' + JSON.stringify(second.j));
          return getOrders().then((list2) => {
            const rec2 = (list2 || []).find((o) => o.id === (second.j && second.j.id));
            check('and it carries NO welcome discount (the offer is spent once)',
              rec2 && !(rec2.discount && rec2.discount.source === 'welcome') && !(rec2.discountAmount > 0),
              'source=' + (rec2 && rec2.discount && rec2.discount.source) + ' off=' + (rec2 && rec2.discountAmount));

            /* ---- the same number, second time: no welcome ---- */
            return post('/api/price', priceFor(PA));
          });
        });
      });
    });
  })
  .then((r) => {
    check('the SAME number on a second order gets NO welcome discount',
      r.status === 200 && r.j.discount === 0 && r.j.discountSource !== 'welcome',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    check('a returning customer pays the full $16.95',
      r.j && r.j.total === FULL, 'total=' + (r.j && r.j.total));

    /* ---- a different new number gets it again ---- */
    return post('/api/price', priceFor(PB));
  })
  .then((r) => {
    check('a DIFFERENT new number gets the welcome 10% again',
      r.status === 200 && r.j.discount === WELCOME_OFF && r.j.discountSource === 'welcome',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));

    /* ---- no number at all → no discount (we cannot identify a first-timer) ---- */
    return post('/api/price', priceFor(''));
  })
  .then((r) => {
    check('an order with NO mobile number gets no welcome discount',
      r.status === 200 && r.j.discount === 0, 'discount=' + (r.j && r.j.discount));

    /* ---- an explicit code the guest typed WINS, no "pick one" error ---- */
    return post('/api/price', priceFor(PC, 'TEN'));
  })
  .then((r) => {
    check('a first-timer who typed a code gets THAT code, not the welcome offer',
      r.status === 200 && r.j.discount === WELCOME_OFF && r.j.discountSource === 'code',
      'discount=' + (r.j && r.j.discount) + ' source=' + (r.j && r.j.discountSource));
    check('the code path returns no error (welcome yields, it does not fight)',
      r.status === 200 && !(r.j && r.j.error), 'error=' + (r.j && r.j.error));

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    if (fail) console.log('\n--- server log ---\n' + serverLog);
    finish(fail ? 1 : 0);
  })
  .catch((e) => {
    console.log('  FAIL  could not run probe: ' + e.message);
    console.log(serverLog);
    finish(1);
  });
