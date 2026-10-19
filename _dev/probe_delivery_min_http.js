/* Integration probe: does the RUNNING server actually enforce the delivery
 * minimum — at BOTH money gates?
 *
 * The unit test (_dev/test_delivery_min.js) proves the RULE is right. This
 * proves the rule is WIRED IN, twice:
 *
 *   1. POST /api/orders    (handleCreateOrder) — the order never reaches the
 *                           kitchen board.
 *   2. POST /api/checkout  (handleCheckout)    — the guest is never handed to
 *                           Stripe for an order the kitchen would refuse.
 *
 * The second one matters more than usual. /api/checkout is the endpoint the
 * full suite only reaches when STRIPE_TEST_KEY is set, so a rule wired into
 * it alone would be checked by nothing in a normal run — the same shape as
 * the bug that took online payments down for two days (`schedule is not
 * defined`, 2026-10-18). This probe stubs Stripe locally (KPOT_STRIPE_API_BASE)
 * and asserts the stub was NOT called, so the "money never moved" path is
 * covered offline, on every run, with no real key.
 *
 * Runs against SCRATCH files (KPOT_ORDERS_FILE / KPOT_STORE_FILE / …), never
 * the shop's own data, and pins KPOT_HOURS_SPEC to 24h so the hours tick
 * cannot decide these cases.
 *
 * Run:  node _dev/probe_delivery_min_http.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8934;
const BASE = 'http://127.0.0.1:' + PORT;
const GEO_PORT = 8935;
const STRIPE_PORT = 8936;
const ADMIN = 'probe-min-admin';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-min-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Simple a-la-carte sides, priced by name (pricing.js's unitPrice). */
const DONUTS = { kind: 'sides', name: 'Chinese Donuts (4)', qty: 1, mods: [], addons: [] };
const SOUP = { kind: 'sides', name: '4 oz Soup (Broth Only)', qty: 1, mods: [], addons: [] };
const RICE = { kind: 'sides', name: 'Side of White Rice', qty: 1, mods: [], addons: [] };
const BALLS = { kind: 'sides', name: 'Sesame Balls with Red Bean Paste (6)', qty: 1, mods: [], addons: [] };

/* --- stub geocoder: Census-shaped, addressed by keyword ------------------- */
const GEO_RESPONSES = [
  { key: 'NEAR', coords: { x: -84.461181, y: 33.880479 + 1.0 / 69.0 } }  /* ~1 mi */
  /* anything else -> no matches (unknown street) */
];
const geoStub = http.createServer((req, res) => {
  const addr = decodeURIComponent((req.url.split('?address=')[1] || '')).toUpperCase();
  const hit = GEO_RESPONSES.find((r) => addr.indexOf(r.key) !== -1);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    result: { addressMatches: hit ? [{ coordinates: hit.coords, matchedAddress: addr }] : [] }
  }));
});

/* --- stub Stripe: counts calls so "never reached Stripe" is provable ------ */
let stripeCalls = 0;
const stripeStub = http.createServer((req, res) => {
  stripeCalls++;
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    id: 'cs_test_minstub_' + Date.now().toString(36),
    url: 'https://example.invalid/pay/cs_test_minstub',
    payment_intent: null
  }));
});

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

function headers(extra) { return Object.assign({ 'Content-Type': 'application/json' }, extra || {}); }
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
const get = (route, h) => req('GET', route, null, h);
const post = (route, body, h) => req('POST', route, body, h);

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'probe-print-key',
    KPOT_FLUSH_MS: '500',
    KPOT_GEOCODE_API_BASE: 'http://127.0.0.1:' + GEO_PORT,
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:' + STRIPE_PORT + '/v1/checkout/sessions',
    /* 24h open — the hours tick drives `open` from the clock every FLUSH_MS,
       so without this the manual open:true flip is clobbered mid-probe at
       off-hours. Production never sets this. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    STRIPE_SECRET_KEY: 'sk_test_min_probe_not_a_real_key'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { geoStub.close(); } catch (e) {}
  try { stripeStub.close(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
}
function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}

/* Delivery orders are for TOMORROW in a named window, so every delivery case
   needs a real bookable window — server-derived, never invented locally. */
let scheduleDays = [];
let scheduleCursor = 0;
function nextSchedule() {
  const days = scheduleDays || [];
  if (!days.length) return null;
  const day = days[scheduleCursor % days.length];
  const slots = (day._slots || []).filter((s) => !s.full && !s.outsideHours);
  if (!slots.length) return null;
  const slot = slots[scheduleCursor % slots.length];
  scheduleCursor++;
  return { date: day.iso, slot: slot.id };
}

/* An order built the way the guest page builds one. `when` carries the
   delivery address; every money figure comes from /api/price (server-derived)
   so nothing here can pass by agreeing with itself. */
async function pricedDelivery(items, token, extra) {
  const price = await post('/api/price', { orderType: 'delivery', items: items, tipAmount: 0 });
  if (price.status !== 200 || !price.j) {
    check('the server can price the delivery cart for ' + token, false, JSON.stringify(price.j));
    return { bad: price };
  }
  const o = Object.assign({
    no: 'KM-PROBE-' + token,
    token: 'min-' + token,
    orderType: 'delivery',
    table: '',
    customer: { name: 'Min Probe', phone: '(404) 555-0177', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
    items: items,
    subtotal: price.j.subtotal, deliveryFee: price.j.delivery,
    tax: price.j.tax, tip: 0, surcharge: 0,
    total: price.j.total,
    payMethod: 'stripe',
    paymentStatus: 'unverified',
    paid: false,
    source: 'probe',
    schedule: nextSchedule()
  }, extra || {});
  return { o: o, price: price.j };
}

async function main() {
  await new Promise((r) => geoStub.listen(GEO_PORT, '127.0.0.1', r));
  await new Promise((r) => stripeStub.listen(STRIPE_PORT, '127.0.0.1', r));
  await waitForHealth(80);
  console.log('the delivery minimum on the running server');
  console.log('='.repeat(74));
  console.log('server up on ' + BASE + ' (geocoder + Stripe stubbed locally)\n');
  check('the server did NOT start in live key mode',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* Delivery live at RUNTIME, the way the owner's board flips it. */
  const on = await post('/api/store', {
    open: true, acceptingOrders: true, orderTypes: { delivery: true }
  }, adminH());
  check('the owner can open the shop and switch Delivery on from the board',
    on.status === 200 && on.j && on.j.open === true && on.j.orderTypes && on.j.orderTypes.delivery === true,
    'status=' + on.status + ' ' + JSON.stringify(on.j));

  const sched = await get('/api/schedule');
  check('the schedule offers a bookable day',
    sched.status === 200 && sched.j && sched.j.enabled === true && Array.isArray(sched.j.days) && sched.j.days.length >= 1,
    JSON.stringify(sched.j && sched.j.enabled));
  for (const d of sched.j.days) {
    const di = await get('/api/schedule?date=' + encodeURIComponent(d.iso));
    d._slots = (di.j && di.j.slots) || [];
  }
  scheduleDays = sched.j.days;
  check('each bookable day publishes its windows', scheduleDays.every((d) => Array.isArray(d._slots)));

  /* ====================================================================== */
  section('order creation — POST /api/orders');

  /* $7.98 of food — under the $10 floor. */
  const small = await pricedDelivery([DONUTS, DONUTS], 'small');
  if (small.bad) return finishLater(1);
  check('the small cart really is under the floor',
    small.price.subtotal < 10, 'subtotal=' + small.price.subtotal);
  const smallOn = await post('/api/orders', small.o);
  check('a $7.98 delivery is REFUSED with delivery_below_minimum',
    smallOn.status === 409 && smallOn.j && smallOn.j.error === 'delivery_below_minimum',
    'status=' + smallOn.status + ' ' + JSON.stringify(smallOn.j));
  check('the refusal carries the floor and the shortfall',
    smallOn.j && smallOn.j.min === 10 && Math.abs(smallOn.j.short - (10 - small.price.subtotal)) < 0.005,
    'min=' + (smallOn.j && smallOn.j.min) + ' short=' + (smallOn.j && smallOn.j.short));
  check('and tells the guest exactly what to do',
    !!(smallOn.j && /add \$/.test(smallOn.j.message || '') && /Pickup or Dine-In/i.test(smallOn.j.message || '')),
    'message=' + JSON.stringify(smallOn.j && smallOn.j.message));

  /* The refused order must not exist anywhere: the board is what the kitchen
     cooks from, so a refusal that still writes is worse than no rule. */
  const board = await get('/api/orders', adminH());
  const boardIds = (board.j && board.j.orders || board.j || []).map((o) => o && o.no || o && o.id);
  check('the refused order is NOT on the kitchen board',
    !boardIds.some((id) => String(id).indexOf('KM-PROBE-small') !== -1),
    'board ids=' + JSON.stringify(boardIds));

  /* One cent under: $9.98 — the boundary that a `>` vs `>=` slip gets wrong. */
  const cent = await pricedDelivery([BALLS, DONUTS], 'cent');
  if (cent.bad) return finishLater(1);
  check('the boundary cart is $9.98 (one cent under)', Math.abs(cent.price.subtotal - 9.98) < 0.005,
    'subtotal=' + cent.price.subtotal);
  const centOn = await post('/api/orders', cent.o);
  check('a $9.98 delivery is still REFUSED (the floor is not a wall)',
    centOn.status === 409 && centOn.j && centOn.j.error === 'delivery_below_minimum',
    'status=' + centOn.status + ' ' + JSON.stringify(centOn.j));

  /* $10.97 of food — over the floor, the everyday case. */
  const big = await pricedDelivery([SOUP, DONUTS, DONUTS], 'big');
  if (big.bad) return finishLater(1);
  check('the control cart is over the floor', big.price.subtotal > 10, 'subtotal=' + big.price.subtotal);
  const bigOn = await post('/api/orders', big.o);
  check('a $10.97 delivery is ACCEPTED',
    bigOn.status === 200 && bigOn.j && bigOn.j.ok === true,
    'status=' + bigOn.status + ' ' + JSON.stringify(bigOn.j));

  /* The rule is DELIVERY-scoped: the same small cart as a PICKUP is fine —
     without this control, a bug refusing every small order would pass. */
  const smallPickup = await post('/api/orders', Object.assign({}, small.o, {
    no: 'KM-PROBE-smallpickup', token: 'min-smallpickup',
    orderType: 'pickup', schedule: null, total: small.price.total
  }));
  check('the SAME small cart as a PICKUP is fine (rule is delivery-only)',
    smallPickup.status === 200 && smallPickup.j && smallPickup.j.ok === true,
    'status=' + smallPickup.status + ' ' + JSON.stringify(smallPickup.j));

  /* ====================================================================== */
  section('checkout — POST /api/checkout (Stripe-stubbed)');
  /* The money gate. The stub counts calls: a refusal must arrive with the
     counter UNCHANGED, which is the offline proof that "money never moved"
     holds for a rule the full suite only reaches with a real Stripe key. */
  const beforeSmall = stripeCalls;
  const coSmall = await post('/api/checkout', {
    orderNo: 'KM-CO-SMALL', orderType: 'delivery', items: [DONUTS, DONUTS], tipAmount: 0,
    customer: { name: 'Min Probe', phone: '(404) 555-0177', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
    schedule: nextSchedule(), total: small.price.total
  });
  check('a $7.98 delivery checkout is REFUSED with delivery_below_minimum',
    coSmall.status === 409 && coSmall.j && coSmall.j.error === 'delivery_below_minimum',
    'status=' + coSmall.status + ' ' + JSON.stringify(coSmall.j));
  check('…and Stripe was never called for it (money never moved)',
    stripeCalls === beforeSmall, 'stripeCalls ' + beforeSmall + ' -> ' + stripeCalls);

  const beforeBig = stripeCalls;
  const coBig = await post('/api/checkout', {
    orderNo: 'KM-CO-BIG', orderType: 'delivery', items: [SOUP, DONUTS, DONUTS], tipAmount: 0,
    customer: { name: 'Min Probe', phone: '(404) 555-0177', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
    schedule: nextSchedule(), total: big.price.total
  });
  check('a $10.97 delivery checkout returns a Stripe session',
    coBig.status === 200 && coBig.j && /^https?:/.test(coBig.j.url || ''),
    'status=' + coBig.status + ' ' + JSON.stringify(coBig.j));
  check('…and the stub really was called for it',
    stripeCalls === beforeBig + 1, 'stripeCalls ' + beforeBig + ' -> ' + stripeCalls);

  /* Control: the small cart as a PICKUP checkout still pays. */
  const beforePickup = stripeCalls;
  const coPickup = await post('/api/checkout', {
    orderNo: 'KM-CO-PICKUP', orderType: 'pickup', items: [DONUTS, DONUTS], tipAmount: 0,
    customer: { name: 'Min Probe', phone: '(404) 555-0177' },
    total: small.price.total
  });
  check('the SAME small cart as a PICKUP checkout still pays',
    coPickup.status === 200 && coPickup.j && /^https?:/.test(coPickup.j.url || ''),
    'status=' + coPickup.status + ' ' + JSON.stringify(coPickup.j));
  check('…and the stub was called for the pickup too',
    stripeCalls === beforePickup + 1, 'stripeCalls ' + beforePickup + ' -> ' + stripeCalls);

  /* A refund note in the log proves the refusal is visible to the owner. */
  check('the minimum refusal is logged',
    /refused delivery order under the minimum|checkout refused — delivery below minimum/.test(serverLog),
    'no refusal line in server log');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n--- server log ---\n' + serverLog);
  finish(fail ? 1 : 0);
}

function finishLater(code) {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n--- server log ---\n' + serverLog);
  finish(code);
}

main().catch((e) => {
  console.log('  FAIL  could not run probe: ' + e.message);
  console.log(serverLog);
  finish(1);
});

