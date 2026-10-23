/* ==========================================================================
   Integration probe: the 2-mile delivery rule, as the RUNNING server applies
   it — at order creation, at checkout, and through the advisory endpoint.

   _dev/test_delivery_geo.js proves geo.js right. This proves the server
   WIRED IT IN, at both gates that move money:

     1. POST /api/orders   — a delivery to a far address is refused with
        delivery_out_of_range (the board never sees it).
     2. POST /api/checkout — the same address never reaches Stripe. A
        delivery INSIDE the radius sails through to a (stubbed) Stripe.

   Plus the coverage this shop was missing entirely: POST /api/checkout is
   exercised OFFLINE. It used to be reachable only through e2e_real_stripe.js
   (STRIPE_TEST_KEY), so a `schedule is not defined` typo in that handler
   500'd every online payment in production while the offline suite stayed
   green. Case 9 below — a plain pickup checkout returning a session URL — is
   the regression test for exactly that.

   Two stubs, both on 127.0.0.1: a Census-shaped geocoder (KPOT_GEOCODE_API_BASE)
   and a Stripe-shaped checkout-sessions API (KPOT_STRIPE_API_BASE). No suite
   here reaches the network. Everything writes to SCRATCH.

   Run:  node _dev/probe_delivery_geo_http.js
   ========================================================================== */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8975;
const GEO_PORT = 8976;
const STRIPE_PORT = 8978;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-geo-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-geo-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };

/* --- stub geocoder: Census-shaped, addressed by keyword ------------------- */
const GEO_RESPONSES = [
  { key: 'NEAR', coords: { x: -84.461181, y: 33.880479 + 1.0 / 69.0 } },  /* ~1 mi */
  { key: 'FAR', coords: { x: -122.084, y: 37.422 } }                      /* Mountain View */
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

/* --- stub Stripe: enough of /v1/checkout/sessions to be handed a session --- */
let stripeCalls = 0;
const stripeStub = http.createServer((req, res) => {
  stripeCalls++;
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    id: 'cs_test_geostub_' + Date.now().toString(36),
    url: 'https://example.invalid/pay/cs_test_geostub',
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
    /* 24h open. The store-hours tick drives `open` from the clock every
       FLUSH_MS (500ms here), so without this the manual open:true flip below
       is clobbered mid-probe at off-hours and the scheduled-delivery checkout
       case dies of a clock race rather than of distance. Production never
       sets this. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    STRIPE_SECRET_KEY: 'sk_test_geo_probe_not_a_real_key'
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

/* Delivery orders need a real next-day window. Rotate through day/slot
   combinations so a per-slot capacity cap can never fail a later case for a
   reason that has nothing to do with distance. */
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
let scheduleDays = [];

/* An order, built the way the guest page builds one. `when` carries the
   delivery address on a delivery order (the same input the guest types it
   into), and payMethod is prepaid online — counter is refused on delivery
   for unrelated reasons and must not be what fails these cases. */
function orderFor(no, total, extra) {
  const o = Object.assign({
    no: no,
    token: 'geo-' + no,
    orderType: 'delivery',
    table: '',
    customer: { name: 'Alex Smith', phone: '' },
    items: [HOTPOT],
    subtotal: 0, deliveryFee: 0, tax: 0, tip: 0, surcharge: 0,
    total: total,
    payMethod: 'stripe',
    paymentStatus: 'unverified',
    paid: false,
    source: 'probe'
  }, extra || {});
  return o;
}

async function main() {
  await new Promise((r) => geoStub.listen(GEO_PORT, '127.0.0.1', r));
  await new Promise((r) => stripeStub.listen(STRIPE_PORT, '127.0.0.1', r));
  await waitForHealth(80);
  console.log('the 2-mile delivery rule on the running server');
  console.log('='.repeat(74));
  console.log('server up on ' + BASE + ' (geocoder + Stripe stubbed locally)\n');
  check('the server did NOT start in live key mode',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* Delivery must be live at RUNTIME, exactly as the owner's board flips it.
     `open` matters too: the store-hours tick may have closed the shop (this
     probe runs at any hour), and storeGate refuses an immediate order while
     closed — which is correct behavior, not a bug to route around. Scheduled
     DELIVERIES are the legitimate exception and are what the real guest flow
     always sends, so the checkout cases below are scheduled deliveries. */
  const on = await post('/api/store', {
    open: true, acceptingOrders: true, orderTypes: { delivery: true }
  }, adminH());
  check('the owner can open the shop and switch Delivery on from the board',
    on.status === 200 && on.j && on.j.open === true && on.j.orderTypes && on.j.orderTypes.delivery === true,
    'status=' + on.status + ' ' + JSON.stringify(on.j));

  /* A real next-day window to book into. */
  const sched = await get('/api/schedule');
  check('the schedule is enabled and offers a bookable day',
    sched.status === 200 && sched.j && sched.j.enabled === true && Array.isArray(sched.j.days) && sched.j.days.length >= 1,
    JSON.stringify(sched.j && sched.j.enabled));
  for (const d of sched.j.days) {
    const di = await get('/api/schedule?date=' + encodeURIComponent(d.iso));
    d._slots = (di.j && di.j.slots) || [];
  }
  scheduleDays = sched.j.days;
  check('each bookable day publishes its windows', scheduleDays.every((d) => Array.isArray(d._slots)));

  const price = (orderType) => post('/api/price', { orderType: orderType, items: [HOTPOT], tipAmount: 0 });
  const dPrice = await price('delivery');
  const pPrice = await price('pickup');
  check('the server can price both channels', dPrice.status === 200 && pPrice.status === 200,
    'delivery=' + dPrice.status + ' pickup=' + pPrice.status);
  const dTotal = dPrice.j.total;
  const pTotal = pPrice.j.total;

  /* ====================================================================== */
  section('order creation — POST /api/orders');
  const far = await post('/api/orders', orderFor('GEO-FAR', dTotal, {
    customer: { name: 'Alex Smith', phone: '', when: '1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR' },
    schedule: nextSchedule()
  }));
  check('a delivery to a 2000-mile address is REFUSED',
    far.status === 409 && far.j && far.j.error === 'delivery_out_of_range',
    'status=' + far.status + ' ' + JSON.stringify(far.j));
  check('the refusal carries the distance and the radius',
    far.j && far.j.miles > 100 && far.j.radius === 2, JSON.stringify(far.j));
  check('and steers the guest to Pickup / Dine-In, not a dead end',
    far.j && /Pickup|Dine-In/i.test(far.j.message || ''), far.j && far.j.message);

  const near = await post('/api/orders', orderFor('GEO-NEAR', dTotal, {
    customer: { name: 'Alex Smith', phone: '', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
    schedule: nextSchedule()
  }));
  check('a delivery ~1 mi away is ACCEPTED',
    near.status === 200 && near.j && near.j.ok === true, 'status=' + near.status + ' ' + JSON.stringify(near.j));

  const zipFar = await post('/api/orders', orderFor('GEO-ZIPFAR', dTotal, {
    customer: { name: 'Alex Smith', phone: '', when: 'Somewhere in Kennesaw, GA 30101' },
    schedule: nextSchedule()
  }));
  check('an unknown street in a far ZIP is refused by the ZIP ruler',
    zipFar.status === 409 && zipFar.j && zipFar.j.error === 'delivery_out_of_range',
    'status=' + zipFar.status + ' ' + JSON.stringify(zipFar.j));

  const zipOk = await post('/api/orders', orderFor('GEO-ZIPOK', dTotal, {
    customer: { name: 'Alex Smith', phone: '', when: 'A brand new street, Atlanta, GA 30339' },
    schedule: nextSchedule()
  }));
  check('an unknown street in the shop\'s own ZIP is accepted (ZIP ruler)',
    zipOk.status === 200 && zipOk.j && zipOk.j.ok === true, 'status=' + zipOk.status + ' ' + JSON.stringify(zipOk.j));

  const zipUnknown = await post('/api/orders', orderFor('GEO-ZIPUNK', dTotal, {
    customer: { name: 'Alex Smith', phone: '', when: '123 Nowhere Ln, Metropolis, GA 99999' },
    schedule: nextSchedule()
  }));
  check('an address in NO known ZIP fails OPEN (an outage must not stop the shop)',
    zipUnknown.status === 200 && zipUnknown.j && zipUnknown.j.ok === true,
    'status=' + zipUnknown.status + ' ' + JSON.stringify(zipUnknown.j));

  /* ====================================================================== */
  section('the rule is DELIVERY-scoped — the control');
  const pickupFar = await post('/api/orders', orderFor('GEO-PICKUP', pTotal, {
    orderType: 'pickup',
    customer: { name: 'Alex Smith', phone: '', when: '1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR' }
  }));
  check('the SAME far address on a PICKUP order is fine',
    pickupFar.status === 200 && pickupFar.j && pickupFar.j.ok === true,
    'status=' + pickupFar.status + ' ' + JSON.stringify(pickupFar.j));

  /* ====================================================================== */
  section('checkout — POST /api/checkout (Stripe-stubbed)');
  /* Scheduled deliveries: the real guest flow (delivery is windowed for the
     next day) and hours-independent, so these are deterministic at any hour
     the suite runs. */
  const coFar = await post('/api/checkout', {
    orderNo: 'GEO-CO-FAR', orderType: 'delivery', items: [HOTPOT], tipAmount: 0,
    customer: { name: 'Alex Smith', phone: '', when: '1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR' },
    schedule: nextSchedule(), total: dTotal
  });
  check('a far delivery never reaches Stripe',
    coFar.status === 409 && coFar.j && coFar.j.error === 'delivery_out_of_range',
    'status=' + coFar.status + ' ' + JSON.stringify(coFar.j));

  const coNear = await post('/api/checkout', {
    orderNo: 'GEO-CO-NEAR', orderType: 'delivery', items: [HOTPOT], tipAmount: 0,
    customer: { name: 'Alex Smith', phone: '', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
    schedule: nextSchedule(), total: dTotal
  });
  check('a near delivery reaches Stripe and gets a session URL back',
    coNear.status === 200 && coNear.j && !!coNear.j.url,
    'status=' + coNear.status + ' ' + JSON.stringify(coNear.j && coNear.j.url));

  /* The regression test for the `schedule is not defined` 500 that took the
     live shop's online payments down: the plainest possible checkout must
     return a session or the correct hours refusal — never internal_error.
     Which one depends on the clock, so both count; the session-URL path is
     already proven deterministically by the scheduled case above. */
  const coPickup = await post('/api/checkout', {
    orderNo: 'GEO-CO-PICKUP', orderType: 'pickup', items: [HOTPOT], tipAmount: 0,
    customer: { name: 'Alex Smith', phone: '' }, total: pTotal
  });
  const pickupGotSession = coPickup.status === 200 && coPickup.j && !!coPickup.j.url;
  const pickupClosedNow = coPickup.status === 409 && coPickup.j && coPickup.j.error === 'closed';
  check('a plain pickup checkout never 500s — a session, or the hours refusal',
    pickupGotSession || pickupClosedNow,
    'status=' + coPickup.status + ' ' + JSON.stringify(coPickup.j));
  if (pickupClosedNow) {
    check('(shop is hours-closed right now — the hours gate refused, as designed)', true);
  } else {
    check('(shop is open) and that checkout really returns a session URL', pickupGotSession);
  }
  check('the server never logged "schedule is not defined"',
    !/schedule is not defined/.test(serverLog), 'found in server log');

  /* ====================================================================== */
  section('the advisory endpoint — POST /api/delivery/check');
  const cFar = await post('/api/delivery/check', { address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR' });
  check('a far address is reported blocked',
    cFar.status === 200 && cFar.j && cFar.j.status === 'blocked' && cFar.j.ok === false,
    'status=' + cFar.status + ' ' + JSON.stringify(cFar.j));
  check('with the miles and the radius for the UI',
    cFar.j && cFar.j.miles > 100 && cFar.j.radius === 2 && cFar.j.source === 'street', JSON.stringify(cFar.j));

  const cNear = await post('/api/delivery/check', { address: '1 NEAR Test Rd, Atlanta, GA 30339' });
  check('a near address is reported ok',
    cNear.status === 200 && cNear.j && cNear.j.status === 'ok' && cNear.j.ok === true
      && cNear.j.source === 'street', JSON.stringify(cNear.j));

  const cZip = await post('/api/delivery/check', { address: 'Somewhere in Marietta, GA 30060' });
  check('an unknown street in a far ZIP is blocked by the ZIP ruler',
    cZip.status === 200 && cZip.j && cZip.j.status === 'blocked' && cZip.j.source === 'zip', JSON.stringify(cZip.j));

  const cJunk = await post('/api/delivery/check', { address: 'asdf' });
  check('nonsense is reported unknown, and ALLOWED (fail open)',
    cJunk.status === 200 && cJunk.j && cJunk.j.status === 'unknown' && cJunk.j.ok === true,
    JSON.stringify(cJunk.j));

  const cEmpty = await post('/api/delivery/check', { address: '' });
  check('an empty address is unknown and allowed',
    cEmpty.status === 200 && cEmpty.j && cEmpty.j.status === 'unknown' && cEmpty.j.ok === true,
    JSON.stringify(cEmpty.j));

  const cGet = await get('/api/delivery/check');
  check('the endpoint is POST-only', cGet.status === 405, 'status=' + cGet.status);

  const cBad = await post('/api/delivery/check', { nope: 1 });
  check('a body with no address is unknown, not a crash',
    cBad.status === 200 && cBad.j && cBad.j.status === 'unknown', 'status=' + cBad.status);

  /* ====================================================================== */
  section('what the server logged');
  check('the out-of-range refusals are logged for the owner',
    /out.of.range/.test(serverLog), 'no out-of-range line in the log');
  check('and it did NOT log any internal error',
    !/internal_error|unhandled:/.test(serverLog), 'found an internal error in the log');
  check('the stubbed Stripe was reached exactly as many times as a session was expected',
    stripeCalls === 1 + (pickupGotSession ? 1 : 0),
    'stripeCalls=' + stripeCalls + ' (near delivery' + (pickupGotSession ? ' + open pickup' : '') + ')');

  finish(pass && fail === 0 ? 0 : 1);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
}

main().catch((e) => {
  console.error('FATAL', e);
  console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  finish(1);
});
