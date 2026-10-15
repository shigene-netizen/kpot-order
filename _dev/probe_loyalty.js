/* Integration probe: does the RUNNING server actually pay out loyalty points?
 *
 * _dev/test_loyalty.js proves the ledger rules are right. This proves the
 * server WIRED THEM IN — that an order really earns on payment, really does not
 * earn twice, really releases on cancel, and that a counter order earns
 * NOTHING until a staff member taps Collected.
 *
 * The rule "店员确认收款后才给分" depends on a button the kitchen board did not
 * used to have: without needsCollect() + the Collected button, a pay-at-counter
 * order sat on the board as UNPAID forever and could never be confirmed. That
 * whole path is exercised here over real HTTP.
 *
 * Everything runs against SCRATCH files, never the shop's own. run_all.sh's
 * fingerprint check now also covers customers.local.json.
 *
 * Run:  node _dev/probe_loyalty.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8944;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-loyalty-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-loyalty-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = '6783355388';
const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };
const RICE = { kind: 'simple', name: 'Side of White Rice', qty: 1, mods: [], addons: [] };

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}

function headers(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}
const adminH = () => headers({ 'X-Admin-Key': ADMIN });

function req(method, route, body, h) {
  return fetch(BASE + route, {
    method, headers: h || headers(), body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.text().then((t) => {
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, j: j };
  }));
}
const post = (route, body, h) => req('POST', route, body, h);
const put = (route, body, h) => req('PUT', route, body, h || adminH());
const get = (route, h) => req('GET', route, null, h);
const patch = (route, body) => req('PATCH', route, body, adminH());

const priceBody = (items, loyalty, couponCode) => {
  const b = { orderType: 'pickup', items: items, tipAmount: 0 };
  if (loyalty) b.loyalty = loyalty;
  if (couponCode) b.couponCode = couponCode;
  return b;
};

const orderFor = (no, total, loyalty, extra) => Object.assign({
  no: no,
  token: 'loy-' + no,
  orderType: 'pickup',
  table: '',
  customer: { name: 'Bob Smith', phone: '(678) 335-5388' },
  items: [HOTPOT],
  subtotal: 15.99,
  deliveryFee: 0,
  tax: 0.96,
  tip: 0,
  surcharge: 0,
  total: total,
  payMethod: 'counter',
  paymentStatus: 'counter',
  paid: false,
  source: 'probe'
}, extra || {}, loyalty ? { loyalty: loyalty } : {});

const member = () => get('/api/customer?phone=' + encodeURIComponent(PHONE));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'probe-print-key',
    KPOT_FLUSH_MS: '1000',
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:9',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
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
  setTimeout(() => process.exit(code), 300);
}

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => r.ok ? r.json() : null)
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}

waitForHealth(80).then(() => {
  console.log('server up on ' + BASE + '\n');

  /* A test must never hold the shop's live key — see test_discount.js. */
  check('the server did NOT start with the shop\'s live key',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* ---- the public lookup ---- */
  return member();
}).then((r) => {
  check('an unknown phone resolves to no member', r.j && r.j.found === false, JSON.stringify(r.j));
  check('with zero points', r.j && r.j.points === 0);
  check('and the published rules ride along',
    r.j && r.j.rules && r.j.rules.redeemStep === 100 && r.j.rules.stampEvery === 10,
    JSON.stringify(r.j && r.j.rules));
  check('and an empty stamp card', r.j && r.j.stamps && r.j.stamps.toNext === 10);

  return get('/api/customer?phone=12345');
}).then((r) => {
  check('an unreadable phone is refused, not guessed at',
    r.status === 400 && r.j && r.j.error === 'bad_phone', 'status=' + r.status + ' ' + JSON.stringify(r.j));

  return get('/api/customer');
}).then((r) => {
  check('a missing phone is refused', r.status === 400 && r.j && r.j.error === 'bad_phone', 'status=' + r.status);

  /* ---- pricing without a member ---- */
  return post('/api/price', priceBody([HOTPOT]));
}).then((r) => {
  check('a plain hot pot prices at $16.95 with $0.96 tax',
    r.j && r.j.total === 16.95 && r.j.tax === 0.96, JSON.stringify(r.j));

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  check('points for an unknown phone are refused, not silently ignored',
    r.status === 409 && r.j && r.j.error === 'unknown_customer',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  return post('/api/price', priceBody([HOTPOT], { phone: '12', redeemPoints: true }));
}).then((r) => {
  /* 409, not 400: every discount-resolution failure on this endpoint — an
     unknown code, a used-up code, a reward that cannot apply — comes back 409
     with a machine-readable `error`, and the guest page switches on that
     field. Making bad_phone the odd one out would give the client a second
     status to test for the same class of problem. */
  check('a garbage phone in the loyalty payload is refused',
    r.status === 409 && r.j && r.j.error === 'bad_phone', 'status=' + r.status + ' ' + JSON.stringify(r.j));
  console.log('');

  /* ======================================================================
     FORGED PAYMENT. The order payload is a public web page's form — it can
     say anything. A guest who POSTs paymentStatus:'verified' must not mint
     points just because a staff member later touches the order for an
     unrelated reason.
     ====================================================================== */
  return post('/api/orders', orderFor('KP-LOY-FORGE', 16.95, null, {
    paymentStatus: 'verified',
    paid: true,
    customer: { name: 'Cheater', phone: '4045550199' }
  }));
}).then((r) => {
  check('an order claiming to be paid is still accepted (the claim is just stored)',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));

  return get('/api/customer?phone=4045550199');
}).then((r) => {
  check('...but the forged claim earns nothing', r.j && r.j.found === false, JSON.stringify(r.j));

  /* A staff member touches it for an unrelated reason — this is the trigger
     that would pay out if the claim had been believed. */
  return patch('/api/orders/' + encodeURIComponent('KP-LOY-FORGE'), { status: 'preparing' });
}).then(() => get('/api/customer?phone=4045550199')).then((r) => {
  check('and a later staff PATCH does not pay out on the forged claim',
    r.j && r.j.found === false, JSON.stringify(r.j));

  /* ======================================================================
     THE EARN PATH. A pay-at-counter order earns NOTHING until a staff
     member taps Collected. That is the whole reason the button exists.
     ====================================================================== */
  return post('/api/price', priceBody([HOTPOT]));
}).then((r) => {
  const total = r.j && r.j.total;
  return post('/api/orders', orderFor('KP-LOY-1', total));
}).then((r) => {
  check('a pay-at-counter order is accepted',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));
  const id = r.j && r.j.id;

  return member().then((m) => {
    check('an unpaid order creates NO member record',
      m.j && m.j.found === false, JSON.stringify(m.j));
    check('and earns no points', m.j && m.j.points === 0);
    return id;
  });
}).then((id) => {
  /* The staff member collects the cash. This PATCH is what the board's
     💵 Collected button sends. */
  return patch('/api/orders/' + encodeURIComponent(id), { paymentStatus: 'paid' }).then((r) => {
    check('staff marking the order collected succeeds',
      r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));
    return member();
  });
}).then((r) => {
  check('points ARE earned once payment is confirmed', r.j && r.j.points === 15,
    'points=' + (r.j && r.j.points));
  check('the name comes back masked', r.j && r.j.name === 'Bob S.', 'name=' + (r.j && r.j.name));
  check('a come-back coupon was issued', r.j && r.j.coupons && r.j.coupons.length === 1,
    JSON.stringify(r.j && r.j.coupons));
  check('...worth $5', r.j && r.j.coupons && r.j.coupons[0].value === 5);
  check('...and it expires', r.j && r.j.coupons && r.j.coupons[0].expiresAt !== null);
  check('the stamp card shows 1 settled order', r.j && r.j.stamps && r.j.stamps.settled === 1);
  check('with 9 to go to the $10 reward', r.j && r.j.stamps && r.j.stamps.toNext === 9);

  /* The server's own log line is the audit trail the owner will read. */
  check('the server logged the payout', /loyalty: .* earned 15 point/.test(serverLog),
    serverLog.split('\n').filter((l) => /loyalty/.test(l)).slice(-3).join(' | '));

  return member();
}).then((r) => {
  const first = r.j;
  /* A second, IDENTICAL PATCH — a staff member tapping twice, or a retry. */
  return patch('/api/orders/' + encodeURIComponent('KP-LOY-1'), { paymentStatus: 'paid' })
    .then(() => member())
    .then((again) => {
      check('a repeated Collected tap does not pay twice',
        again.j && again.j.points === first.points, 'points=' + (again.j && again.j.points));
      check('and issues no second coupon',
        again.j && again.j.coupons && again.j.coupons.length === first.coupons.length);
      check('and the order still counts once',
        again.j && again.j.stamps && again.j.stamps.settled === first.stamps.settled);
      return again;
    });
}).then(() => {
  /* A different format of the SAME number must hit the SAME ledger. */
  return get('/api/customer?phone=' + encodeURIComponent('+1 678-335-5388'));
}).then((r) => {
  check('"+1 678-335-5388" resolves to the same member',
    r.j && r.j.found === true && r.j.points === 15, JSON.stringify(r.j));

  return get('/api/customer?phone=' + encodeURIComponent('1 (678) 335.5388'));
}).then((r) => {
  check('dotted and bracketed forms resolve too', r.j && r.j.points === 15, JSON.stringify(r.j));

  /* /api/orders is admin-gated, so the member ledger that rides along on the
     board payload can never be read by a guest. */
  return get('/api/orders', adminH());
}).then((r) => {
  check('the board payload carries the member ledger',
    r.j && r.j.members && r.j.members[PHONE] && r.j.members[PHONE].points === 15,
    JSON.stringify(r.j && r.j.members));
  check('with the member\'s name for the board',
    r.j && r.j.members[PHONE].name === 'Bob Smith');
  check('and the unused coupons',
    r.j && r.j.members[PHONE].unusedCoupons.length === 1);
  console.log('');

  /* ======================================================================
     THE SPEND PATH. A guest may take ONE thing off a bill.
     ====================================================================== */
  return member();
}).then((r) => {
  const couponId = r.j && r.j.coupons && r.j.coupons[0] && r.j.coupons[0].id;
  check('the member holds a come-back coupon id', !!couponId, JSON.stringify(r.j && r.j.coupons));

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, couponId: couponId }));
}).then((r) => {
  check('the coupon takes $5 off the hot pot',
    r.j && r.j.discount === 5, JSON.stringify(r.j));
  check('and tax is recalculated on the discounted amount ($0.66)',
    r.j && r.j.tax === 0.66, 'tax=' + (r.j && r.j.tax));
  check('so the total is $11.65', r.j && r.j.total === 11.65, 'total=' + (r.j && r.j.total));
  check('the label says "come back", not a code name',
    /come back/i.test(r.j && r.j.discountLabel), 'label=' + (r.j && r.j.discountLabel));
  check('and the source is loyalty', r.j && r.j.discountSource === 'loyalty');

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, couponId: 'cp_bogus' }));
}).then((r) => {
  check('an unknown coupon id is refused',
    r.status === 409 && r.j && r.j.error === 'coupon_unavailable', 'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* 15 points is below the 100-point block, so there is nothing to redeem. */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  check('a balance under 100 points is refused as such',
    r.status === 409 && r.j && r.j.error === 'points_unavailable',
    'status=' + r.status + ' ' + JSON.stringify(r.j));
  check('and the message names the balance they DO have',
    /15/.test(r.j && r.j.message), 'message=' + (r.j && r.j.message));

  /* Give them enough to redeem, then try it on an order under $5. */
  return post('/api/customers/adjust', { phone: PHONE, delta: 135, note: 'probe top-up' }, adminH());
}).then((r) => {
  check('staff can top a balance up', r.status === 200 && r.j && r.j.customer.points === 150,
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  return post('/api/price', priceBody([RICE], { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  check('150 points on a $1.50 order is refused as too small, NOT as "not enough points"',
    r.status === 409 && r.j && r.j.error === 'order_too_small',
    'status=' + r.status + ' ' + JSON.stringify(r.j));
  check('and explains the $5 floor', /\$5/.test(r.j && r.j.message), 'message=' + (r.j && r.j.message));

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  check('the same 150 points on a $15.99 order redeem for $5',
    r.j && r.j.discount === 5, JSON.stringify(r.j));
  check('and are labelled in points', /points/i.test(r.j && r.j.discountLabel),
    'label=' + (r.j && r.j.discountLabel));

  /* One give-away per order. Seed a REAL code first: resolveOrderDiscount
     reports a bad code before a bad reward, so a made-up one would prove
     nothing about the stacking rule. */
  return put('/api/discounts', { codes: [{ code: 'FIVE', type: 'amount', value: 5, active: true }] });
}).then((r) => {
  check('a real discount code is in place', r.status === 200 && r.j && r.j.ok === true,
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true }, 'FIVE'));
}).then((r) => {
  check('a discount code AND a reward together are refused',
    r.status === 409 && r.j && r.j.error === 'one_discount_only',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  return member();
}).then((r) => {
  const couponId = r.j && r.j.coupons && r.j.coupons[0] && r.j.coupons[0].id;
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true, couponId: couponId }));
}).then((r) => {
  check('points AND a coupon on one order are refused',
    r.status === 409 && r.j && r.j.error === 'one_reward_only',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ---- placing an order that costs points ---- */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  const total = r.j && r.j.total;
  check('the points price is $11.65', total === 11.65, 'total=' + total);

  return post('/api/orders', orderFor('KP-LOY-2', total, { phone: PHONE, redeemPoints: true }));
}).then((r) => {
  check('an order priced with points is accepted',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));

  return member();
}).then((r) => {
  check('the points LEFT the balance when the order was placed',
    r.j && r.j.points === 50, 'points=' + (r.j && r.j.points));

  /* An order that never collected its money has to give the reward back. */
  return patch('/api/orders/' + encodeURIComponent('KP-LOY-2'), { status: 'cancelled' });
}).then((r) => {
  check('cancelling the order succeeds',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));

  return member();
}).then((r) => {
  check('cancelling gives the points back', r.j && r.j.points === 150,
    'points=' + (r.j && r.j.points));
  check('the server logged the release', /loyalty: released/.test(serverLog),
    serverLog.split('\n').filter((l) => /loyalty/.test(l)).slice(-2).join(' | '));

  return patch('/api/orders/' + encodeURIComponent('KP-LOY-2'), { status: 'cancelled' });
}).then(() => member()).then((r) => {
  check('a SECOND cancellation does not refund twice', r.j && r.j.points === 150,
    'points=' + (r.j && r.j.points));
  console.log('');

  /* ======================================================================
     THE OWNER'S VIEW. Full phone numbers, so admin-gated.
     ====================================================================== */
  return get('/api/customers');
}).then((r) => {
  check('the member list needs the admin key', r.status === 401, 'status=' + r.status);
  return get('/api/customers', adminH());
}).then((r) => {
  check('the member list works with the key',
    r.status === 200 && r.j && r.j.count === 1, 'status=' + r.status + ' count=' + (r.j && r.j.count));
  check('with the raw phone number for the counter',
    r.j && r.j.customers[0].phone === PHONE, JSON.stringify(r.j && r.j.customers[0]));
  check('and the balance', r.j && r.j.customers[0].points === 150);

  return get('/api/customers?q=678335', adminH());
}).then((r) => {
  check('searching by phone digits finds the member', r.j && r.j.count === 1, 'count=' + (r.j && r.j.count));

  return get('/api/customers?q=Bob', adminH());
}).then((r) => {
  check('searching by name finds the member', r.j && r.j.count === 1, 'count=' + (r.j && r.j.count));

  return get('/api/customers?q=nobody-here', adminH());
}).then((r) => {
  check('searching for nobody returns nobody', r.j && r.j.count === 0, 'count=' + (r.j && r.j.count));

  return req('GET', '/api/customers/export.csv');
}).then((r) => {
  check('the member export needs the admin key', r.status === 401, 'status=' + r.status);

  return req('GET', '/api/customers/export.csv', null, adminH());
}).then((r) => {
  check('the member export works with the key', r.status === 200, 'status=' + r.status);
  check('and is served as CSV', typeof r.j === 'string' && r.j.indexOf('phone,name,points,') !== -1,
    String(r.j).slice(0, 80));
  check('with the member in it', typeof r.j === 'string' && r.j.indexOf(PHONE) !== -1);

  /* The BOM has to be checked in the BYTES: fetch's text() decodes UTF-8 with
     a TextDecoder, which strips a leading U+FEFF by design — so asserting on
     the decoded string would pass even if the BOM were never sent. */
  return fetch(BASE + '/api/customers/export.csv', { headers: adminH() })
    .then((res) => res.arrayBuffer()).then((buf) => {
      const b = new Uint8Array(buf);
      check('the CSV really does start with the UTF-8 BOM (EF BB BF)',
        b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF,
        'first bytes: ' + Array.from(b.slice(0, 4)).map((x) => x.toString(16)).join(' '));
    });
}).then(() => {
  /* ---- and the same for the writer ---- */
  return post('/api/customers/adjust', { phone: PHONE, delta: 5 });
}).then((r) => {
  check('adjusting a balance needs the admin key', r.status === 401, 'status=' + r.status);

  return post('/api/customers/adjust', { phone: '12', delta: 5 }, adminH());
}).then((r) => {
  check('adjusting with a garbage phone is refused',
    r.status === 400 && r.j && r.j.error === 'bad_phone', 'status=' + r.status);

  return post('/api/customers/adjust', { phone: PHONE, delta: -9999 }, adminH());
}).then((r) => {
  check('driving a balance negative is REFUSED, not clamped to zero',
    r.status === 400 && r.j && r.j.error === 'points_negative',
    'status=' + r.status + ' ' + JSON.stringify(r.j));
  check('and says what they actually have',
    /150/.test(r.j && r.j.message), 'message=' + (r.j && r.j.message));

  return post('/api/customers/adjust', { phone: PHONE, delta: 2.5 }, adminH());
}).then((r) => {
  check('a fractional points change is refused',
    r.status === 400 && r.j && r.j.error === 'bad_delta', 'status=' + r.status);

  return post('/api/customers/adjust', { phone: PHONE }, adminH());
}).then((r) => {
  check('an adjust with nothing to do is refused',
    r.status === 400 && r.j && r.j.error === 'nothing_to_do', 'status=' + r.status);

  return post('/api/customers/adjust',
    { phone: PHONE, coupon: { value: 8, label: 'Goodwill', days: 30 }, note: 'probe' }, adminH());
}).then((r) => {
  check('staff can hand a guest a one-off reward',
    r.status === 200 && r.j && r.j.customer.coupons.length === 2,
    'status=' + r.status + ' coupons=' + (r.j && r.j.customer && r.j.customer.coupons.length));

  return member();
}).then((r) => {
  check('the one-off reward shows up for the guest',
    r.j && r.j.coupons.length === 2 && r.j.coupons.some((c) => c.value === 8),
    JSON.stringify(r.j && r.j.coupons));
  console.log('');
  console.log('');

  /* ======================================================================
     BACKUPS. The container is not durable, so the ledger gets the same
     rolling treatment as the orders.
     ====================================================================== */
  return sleep(1300).then(() => {
    const dir = path.join(SCRATCH, 'backups');
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) {}
    check('members are backed up as CSV',
      files.some((f) => /^members-\d{4}-\d{2}-\d{2}\.csv$/.test(f)), files.join(', '));
    check('members are backed up as JSON',
      files.some((f) => /^members-\d{4}-\d{2}-\d{2}\.json$/.test(f)), files.join(', '));
    check('orders are still backed up too',
      files.some((f) => /^orders-\d{4}-\d{2}-\d{2}\.csv$/.test(f)), files.join(', '));

    const jsonName = files.find((f) => /^members-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (jsonName) {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, jsonName), 'utf8'));
      check('and the backup copy holds the member', snap.customers.length === 1,
        'customers=' + (snap.customers && snap.customers.length));
    }
  });
}).then(() => {
  /* Nobody may be able to walk the phone-number space through the public
     lookup. It is throttled, exactly like /api/price. */
  const burst = [];
  for (let i = 0; i < 70; i++) burst.push(get('/api/customer?phone=' + PHONE));
  return Promise.all(burst);
}).then((results) => {
  const limited = results.filter((r) => r.status === 429);
  check('the public lookup is throttled so it cannot enumerate numbers',
    limited.length > 0, '429s=' + limited.length + ' of ' + results.length);
  check('and the throttle says why',
    limited.length > 0 && limited[0].j && limited[0].j.error === 'rate_limited',
    JSON.stringify(limited[0] && limited[0].j));
}).then(() => {
  /* ---- hermeticity ---- */
  check('no real customers file was created in the repo',
    !fs.existsSync(path.join(ROOT, 'customers.local.json')),
    'customers.local.json appeared in the repo!');

  const loyaltyLines = serverLog.split('\n').filter((l) => /\[kpot\] loyalty/.test(l));
  check('the server logged the loyalty activity it performed',
    loyaltyLines.length >= 2, loyaltyLines.slice(0, 4).join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  finish(fail ? 1 : 0);
}).catch((e) => { console.log('  FAIL  harness threw: ' + e.message + '\n' + serverLog); finish(1); });
