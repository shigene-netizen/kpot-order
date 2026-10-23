/* ==========================================================================
   Integration probe: the driver's delivery run — the queue endpoint and the
   driver's one allowed action.

   _dev/test_dispatch.js proves the SEQUENCE RULES right. This proves the
   server wired them in and that the weakest credential in the system stays
   weak:

     - GET /api/driver/queue with no key / a wrong key / a print key  -> 401
     - with the driver key -> the day's run, in order                -> 200
     - with the OWNER's admin key -> the same run (the owner is
       allowed to look at their own deliveries)                       -> 200
     - a server with NO driver key configured is LOCKED, not open    -> 401
       (unlike the print endpoint, which opens in dev mode: this one
       carries guest addresses and phone numbers)

     - a driver may mark a DELIVERY completed — nothing else:
       any other status, any extra field, a pickup order, a cancelled
       order, a reschedule, a payment-status change -> refused
     - the OWNER can still do all of that (control)
     - the run shrinks and renumbers when the driver finishes one

     - the measured point from the 2-mile gate is KEPT on the order, so the
       run can sort by distance without geocoding again

   Everything writes to SCRATCH; the only listener besides the server is a
   Census-shaped geocoder stub. No network.

   Run:  node _dev/probe_driver_http.js
   ========================================================================== */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8983;
const GEO_PORT = 8984;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-admin-key';
const DRIVER = 'probe-driver-key';
const PRINT = 'probe-print-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-driver-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISP = require('../dispatch.js');

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };

/* --- stub geocoder: Census-shaped, addressed by keyword ------------------- */
const geoStub = http.createServer((req, res) => {
  const addr = decodeURIComponent((req.url.split('?address=')[1] || '')).toUpperCase();
  /* "NEAR" lands ~1 mi north of the store; anything else matches nothing. */
  const hit = addr.indexOf('NEAR') !== -1
    ? { x: -84.461181, y: 33.880479 + 1.0 / 69.0 }
    : null;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    result: { addressMatches: hit ? [{ coordinates: hit, matchedAddress: addr }] : [] }
  }));
});

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }
function headers(extra) { return Object.assign({ 'Content-Type': 'application/json' }, extra || {}); }
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
const patch = (route, body, h) => req('PATCH', route, body, h);
const driverH = () => headers({ 'X-Driver-Key': DRIVER });
const adminH = () => headers({ 'X-Admin-Key': ADMIN });
const printH = () => headers({ 'X-Print-Key': PRINT });

/* --------------------------------------------------------------------------
   A seeded day. Slot ids are the SHOP'S OWN (config.js offers 12pm..4pm), not
   this probe's invention: the server looks window starts up in its real slot
   table, and a made-up id would silently fall back to scheduledFor and make
   the test prove nothing about windows.

   `miles` is what the 2-mile gate measured when the order was created; the
   coordinates walk due north from the store so the distance is the distance.
   -------------------------------------------------------------------------- */
const SLOTS = [
  { id: '12pm', label: '12:00 PM – 1:00 PM', start: 720, end: 780 },
  { id: '2pm', label: '2:00 PM – 3:00 PM', start: 840, end: 900 },
  { id: '4pm', label: '4:00 PM – 5:00 PM', start: 960, end: 1020 }
];
const TODAY = DISP.localDateKey(Date.now());
const TOMORROW = DISP.localDateKey(Date.now() + 24 * 60 * 60 * 1000);
const YESTERDAY = DISP.localDateKey(Date.now() - 24 * 60 * 60 * 1000);

function seeded(no, extra) {
  const o = {
    id: no,
    no: no,
    at: TODAY + 'T09:00:00.000Z',
    updatedAt: TODAY + 'T09:00:00.000Z',
    status: 'received',
    paymentStatus: 'paid',
    payMethod: 'stripe',
    orderType: 'delivery',
    deliveryDate: TODAY,
    deliverySlot: '12pm',
    deliverySlotLabel: '12:00 PM – 1:00 PM',
    scheduledFor: TODAY + 'T16:30:00.000Z',
    table: '',
    customer: { name: 'Alex Smith', phone: '', when: '1 NEAR Rd, Atlanta, GA 30339', notes: '' },
    items: [{ name: 'Pick 2 Proteins Bowl', qty: 1 }],
    lines: [{ name: 'Pick 2 Proteins Bowl', qty: 1, unit: 15.99, desc: '' }],
    subtotal: 15.99, tax: 0.96, tip: 0, delivery: 0, total: 16.95,
    source: 'probe'
  };
  return Object.assign(o, extra || {});
}
function atMiles(no, miles, extra) {
  const lat = 33.880479 + miles / 69.0;
  return seeded(no, Object.assign({
    geo: { lat: lat, lon: -84.461181, miles: miles, source: 'street' }
  }, extra || {}));
}

const SEED = [
  atMiles('DRV-FAR', 1.9, { customer: { name: 'Far Away', phone: '', when: '19 NEAR Test Rd, Atlanta, GA 30339', notes: '' } }),
  atMiles('DRV-NEAR', 0.7, { customer: { name: 'Next Door', phone: '(404) 555-0202', when: '7 NEAR Test Rd, Atlanta, GA 30339', notes: 'Gate code 1234' } }),
  atMiles('DRV-EVENING', 0.5, {
    deliverySlot: '4pm', deliverySlotLabel: '4:00 PM – 5:00 PM',
    scheduledFor: TODAY + 'T19:30:00.000Z',
    customer: { name: 'Late One', phone: '', when: '5 NEAR Test Rd, Atlanta, GA 30339', notes: '' }
  }),
  atMiles('DRV-TOMORROW', 0.6, { deliveryDate: TOMORROW }),
  atMiles('DRV-DONE', 0.6, { status: 'completed' }),
  atMiles('DRV-CANCELLED', 0.6, { status: 'cancelled' }),
  seeded('PICK-1', { orderType: 'pickup', deliveryDate: '', deliverySlot: '', deliverySlotLabel: '', scheduledFor: '' }),
  atMiles('DRV-OVERDUE', 1.0, {
    deliveryDate: YESTERDAY, deliverySlot: '2pm', deliverySlotLabel: '2:00 PM – 3:00 PM',
    scheduledFor: YESTERDAY + 'T18:30:00.000Z',
    customer: { name: 'Yesterday', phone: '', when: '10 NEAR Test Rd, Atlanta, GA 30339', notes: '' }
  }),
  seeded('DRV-UNPAID', {
    paymentStatus: 'pending', payMethod: 'stripe',
    customer: { name: 'Not Paid Yet', phone: '', when: '3 NEAR Test Rd, Atlanta, GA 30339', notes: '' },
    geo: { lat: 33.89, lon: -84.46, miles: 0.8, source: 'street' }
  }),
  /* A DINE-IN order, so it is NOT part of the run this suite sequences — it is
     here for one reason only: it gives '(404) 555-0202' a prior order, so that
     number is a RETURNING customer. Since 2026-10-23 a brand-new mobile number
     earns an automatic 10% welcome discount (resolveFirstTime in server.js),
     which would move the total of the first order it places and refuse it as a
     mismatch. The server decides "first-timer" from the order history
     (isFirstTimeCustomer), so the history is what has to say otherwise. Every
     other number in this suite posts its order with no phone at all — a guest
     who gives no number is never identified as a first-timer. */
  seeded('DRV-WARM', {
    orderType: 'dinein',
    deliveryDate: '', deliverySlot: '', deliverySlotLabel: '', scheduledFor: '',
    customer: { name: 'Next Door', phone: '(404) 555-0202', when: '7 NEAR Test Rd, Atlanta, GA 30339', notes: '' }
  })
];

const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');
const STORE_FILE = path.join(SCRATCH, 'store.local.json');

function writeSeeds() {
  writeFileAtomic(ORDERS_FILE, JSON.stringify(SEED, null, 2));
  writeFileAtomic(STORE_FILE, JSON.stringify({
    open: true, acceptingOrders: true, orderTypes: { pickup: true, dinein: true, delivery: true },
    updatedAt: new Date().toISOString()
  }, null, 2));
}
/* Same shape the server's own saver uses: write to a tmp file, then rename,
   so a reader never sees half a file. */
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function spawnServer(extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ADMIN_KEY: ADMIN,
      DRIVER_KEY: DRIVER,
      PRINT_KEY: PRINT,
      KPOT_FLUSH_MS: '500',
      KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
      KPOT_GEOCODE_API_BASE: 'http://127.0.0.1:' + GEO_PORT,
      KPOT_ORDERS_FILE: ORDERS_FILE,
      KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
      KPOT_STORE_FILE: STORE_FILE,
      KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups')
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
let server = null;
let serverLog = '';
function hookLog(s) {
  s.stdout.on('data', (d) => { serverLog += d.toString(); });
  s.stderr.on('data', (d) => { serverLog += d.toString(); });
}
function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}
function stop(s) { try { s.kill(); } catch (e) {} }

async function main() {
  writeSeeds();
  await new Promise((r) => geoStub.listen(GEO_PORT, '127.0.0.1', r));
  server = spawnServer();
  hookLog(server);
  let code = 1;
  try {
    await waitForHealth(80);
    console.log('the driver delivery run');
    console.log('='.repeat(74));
    console.log('server up on ' + BASE + ' — today is ' + TODAY + ' (local)\n');

    /* ===================================================================== */
    section('who may see the run');

    const noKey = await get('/api/driver/queue');
    check('no key at all -> 401', noKey.status === 401, 'status=' + noKey.status);
    const wrongKey = await get('/api/driver/queue', headers({ 'X-Driver-Key': 'wrong' }));
    check('a wrong driver key -> 401', wrongKey.status === 401, 'status=' + wrongKey.status);
    const printKey = await get('/api/driver/queue', printH());
    check('the PRINTER key does not open the driver run', printKey.status === 401,
      'status=' + printKey.status + ' ' + JSON.stringify(printKey.j));
    const asDriver = await get('/api/driver/queue', driverH());
    check('the driver key -> the run', asDriver.status === 200 && asDriver.j && asDriver.j.ok === true,
      'status=' + asDriver.status + ' ' + JSON.stringify(asDriver.j));
    const asAdmin = await get('/api/driver/queue', adminH());
    check('the OWNER key also sees the run (it is their own shop)',
      asAdmin.status === 200 && asAdmin.j && asAdmin.j.count === asDriver.j.count,
      'status=' + asAdmin.status);
    const postQueue = await post('/api/driver/queue', {}, driverH());
    check('the queue is GET-only', postQueue.status === 405, 'status=' + postQueue.status);

    /* ===================================================================== */
    section('the run itself');

    const q = asDriver.j;
    check('the response names the day', q.date === TODAY, q.date + ' vs ' + TODAY);
    check("tomorrow's booking is NOT in today's run",
      !q.seq.some((e) => e.id === 'DRV-TOMORROW'), JSON.stringify(q.seq.map((e) => e.id)));
    check('a completed order is gone from the run', !q.seq.some((e) => e.id === 'DRV-DONE'));
    check('a cancelled order is gone from the run', !q.seq.some((e) => e.id === 'DRV-CANCELLED'));
    check('a pickup order was never in it', !q.seq.some((e) => e.id === 'PICK-1'));

    /* 12pm window nearest-first (0.7, 0.8, 1.9), then the 2pm overdue order —
       a window from YESTERDAY still out there — then the 4pm one, even though
       the 4pm address is the closest of the three: the window decides. */
    check('the run is window first, then nearest',
      q.seq.map((e) => e.id).join(' ') === 'DRV-NEAR DRV-UNPAID DRV-FAR DRV-OVERDUE DRV-EVENING',
      q.seq.map((e) => e.id).join(' '));

    const first = q.seq[0];
    check('the entries are numbered 1..n', q.seq.every((e, i) => e.seq === i + 1),
      JSON.stringify(q.seq.map((e) => e.seq)));
    check('the first entry is the nearest one inside the first window',
      first.id === 'DRV-NEAR' && first.miles !== null && Math.abs(first.miles - 0.7) < 0.02,
      JSON.stringify(first.miles));
    check('an entry carries its window', first.windowLabel === '12:00 PM – 1:00 PM', first.windowLabel);
    check('its address, tappable into Maps',
      first.address === '7 NEAR Test Rd, Atlanta, GA 30339' &&
        first.mapsUrl === 'https://maps.google.com/?q=' + encodeURIComponent(first.address),
      first.mapsUrl);
    check('the customer and a place to call them',
      first.customer.name === 'Next Door' && first.customer.phone === '(404) 555-0202',
      JSON.stringify(first.customer));
    check('what is in the bag, from the kitchen lines',
      first.itemsText === '1× Pick 2 Proteins Bowl', first.itemsText);
    check('a paid delivery is marked paid', q.seq[0].paid === true);
    check('an unpaid delivery is NOT marked paid',
      q.seq.find((e) => e.id === 'DRV-UNPAID').paid === false);

    const overdue = q.seq.find((e) => e.id === 'DRV-OVERDUE');
    check("yesterday's still-open order is in the run and FLAGGED", overdue && overdue.overdue === true,
      JSON.stringify(overdue));
    check('the count matches the run length', q.count === q.seq.length, q.count + ' vs ' + q.seq.length);
    check('the overdue count is reported', q.overdue === 1, String(q.overdue));

    /* ===================================================================== */
    section('a driver may mark a delivery done — and only that');

    const done = await patch('/api/orders/' + encodeURIComponent('DRV-NEAR'), { status: 'completed' }, driverH());
    check('marking the nearest delivery delivered -> 200',
      done.status === 200, 'status=' + done.status + ' ' + JSON.stringify(done.j));
    check('the run shrinks and renumbers',
      (await get('/api/driver/queue', driverH())).j.seq.map((e) => e.seq).join(',') === '1,2,3,4',
      JSON.stringify((await get('/api/driver/queue', driverH())).j.seq.map((e) => e.seq)));
    check('the finished order is gone from the run',
      !(await get('/api/driver/queue', driverH())).j.seq.some((e) => e.id === 'DRV-NEAR'));
    check('and the log says the driver did it', /driver marked order DRV-NEAR delivered/.test(serverLog),
      'no such line in the log');
    const again = await patch('/api/orders/' + encodeURIComponent('DRV-NEAR'), { status: 'completed' }, driverH());
    check('tapping twice is harmless (idempotent)', again.status === 200, 'status=' + again.status);

    const otherStatus = await patch('/api/orders/' + encodeURIComponent('DRV-FAR'), { status: 'preparing' }, driverH());
    check('a driver may not move an order to any other status',
      otherStatus.status === 403 && otherStatus.j.error === 'driver_readonly',
      'status=' + otherStatus.status + ' ' + JSON.stringify(otherStatus.j));

    const extraField = await patch('/api/orders/' + encodeURIComponent('DRV-FAR'),
      { status: 'completed', total: 0.01 }, driverH());
    check('not even alongside the one thing they may do',
      extraField.status === 403 && extraField.j.error === 'driver_readonly',
      'status=' + extraField.status + ' ' + JSON.stringify(extraField.j));

    const pickup = await patch('/api/orders/PICK-1', { status: 'completed' }, driverH());
    check('a driver may not complete a PICKUP order',
      pickup.status === 403 && pickup.j.error === 'driver_not_delivery',
      'status=' + pickup.status + ' ' + JSON.stringify(pickup.j));

    const resched = await patch('/api/orders/' + encodeURIComponent('DRV-FAR'),
      { status: 'completed', schedule: { date: TOMORROW, slot: '12pm' } }, driverH());
    check('a driver may not reschedule', resched.status === 403, 'status=' + resched.status);

    const payStatus = await patch('/api/orders/' + encodeURIComponent('DRV-FAR'),
      { paymentStatus: 'paid' }, driverH());
    check('a driver may not touch payment status', payStatus.status === 403, 'status=' + payStatus.status);

    const cancelled = await patch('/api/orders/DRV-CANCELLED', { status: 'completed' }, driverH());
    check('a cancelled order cannot be delivered after the fact',
      cancelled.status === 409 && cancelled.j.error === 'order_cancelled',
      'status=' + cancelled.status + ' ' + JSON.stringify(cancelled.j));

    const noKeyPatch = await patch('/api/orders/DRV-FAR', { status: 'completed' });
    check('and none of this is reachable without the key',
      noKeyPatch.status === 401, 'status=' + noKeyPatch.status);

    /* ===================================================================== */
    section('the OWNER can still do everything (control)');

    const ownerPrepare = await patch('/api/orders/PICK-1', { status: 'preparing' }, adminH());
    check('the owner moves a pickup order to preparing',
      ownerPrepare.status === 200, 'status=' + ownerPrepare.status + ' ' + JSON.stringify(ownerPrepare.j));
    const ownerPay = await patch('/api/orders/DRV-FAR', { paymentStatus: 'paid' }, adminH());
    check('the owner corrects a payment status', ownerPay.status === 200, 'status=' + ownerPay.status);
    const ownerDiscount = await patch('/api/orders/DRV-FAR', { discount: { type: 'amount', value: 3 } }, adminH());
    check('the owner applies a staff discount', ownerDiscount.status === 200, 'status=' + ownerDiscount.status);
    /* The slot ids are the SHOP's own (config.js), not this probe's invention:
       they run 12pm..5pm, so booking the real window the creation test will
       use later keeps this valid. */
    const book = await get('/api/schedule');
    const bDay = (book.j.days || [])[0];
    const bSlots = bDay ? ((await get('/api/schedule?date=' + encodeURIComponent(bDay.iso))).j.slots || []) : [];
    const bSlot = bSlots.find((s) => !s.full && !s.outsideHours);
    const ownerResched = await patch('/api/orders/DRV-EVENING',
      { schedule: { date: bDay.iso, slot: bSlot.id } }, adminH());
    check('the owner reschedules a delivery', ownerResched.status === 200,
      'status=' + ownerResched.status + ' ' + JSON.stringify(ownerResched.j));

    /* ===================================================================== */
    section('the measured point is kept on the order');

    /* A brand-new delivery, created for tomorrow: the 2-mile gate geocodes
       it on the way in, and the point must land on the order so the run can
       sort it without geocoding again. Read it back from the scratch board. */
    const sched = await get('/api/schedule');
    const day = (sched.j.days || [])[0];
    const slots = day ? ((await get('/api/schedule?date=' + encodeURIComponent(day.iso))).j.slots || []) : [];
    const bookable = slots.find((s) => !s.full && !s.outsideHours);
    check('the schedule offers a window to book', !!bookable, JSON.stringify(day && day.iso));

    const price = await post('/api/price', { orderType: 'delivery', items: [HOTPOT], tipAmount: 0 });
    const created = await post('/api/orders', {
      no: 'DRV-NEW', token: 'drv-new', orderType: 'delivery', items: [HOTPOT], tipAmount: 0,
      customer: { name: 'New One', phone: '', when: '1 NEAR Test Rd, Atlanta, GA 30339' },
      schedule: { date: day.iso, slot: bookable.id }, total: price.j.total,
      payMethod: 'stripe', paymentStatus: 'pending', paid: false
    });
    check('the order is created', created.status === 200 && created.j && created.j.ok === true,
      'status=' + created.status + ' ' + JSON.stringify(created.j));
    /* The board is written on a debounce (saveOrdersSoon), so the file lags the
       response by up to a second. Poll it rather than assuming the write has
       landed — reading too early finds the SEED file and proves nothing. */
    let fresh = null;
    for (let i = 0; i < 20 && !fresh; i++) {
      await sleep(200);
      try {
        fresh = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')).find((o) => o.id === 'DRV-NEW') || null;
      } catch (e) { /* file being rewritten right now — try again */ }
    }
    check('the new order reached the board file', !!fresh, 'DRV-NEW never appeared on disk');
    check('the point the gate measured is ON the order',
      !!fresh && !!fresh.geo && Math.abs(fresh.geo.miles - 1.0) < 0.02 && fresh.geo.source === 'street',
      JSON.stringify(fresh && fresh.geo));
    check('with both coordinates, so dispatch.js can re-measure if it must',
      !!fresh && !!fresh.geo.lat && !!fresh.geo.lon, JSON.stringify(fresh && fresh.geo));

    /* ===================================================================== */
    section('a server with NO driver key is locked, not open');

    stop(server);
    await sleep(400);
    const bare = spawnServer({ DRIVER_KEY: '' });
    hookLog(bare);
    try {
      await waitForHealth(80);
      const locked = await get('/api/driver/queue');
      check('with no driver key configured, no key gets in',
        locked.status === 401, 'status=' + locked.status + ' ' + JSON.stringify(locked.j));
      const ownerStill = await get('/api/driver/queue', adminH());
      check('the owner key still works (it is the stronger credential)',
        ownerStill.status === 200, 'status=' + ownerStill.status);
      check('the server warned that the endpoint is locked',
        /DRIVER_KEY not set/.test(serverLog), 'no warning in the log');
    } finally {
      stop(bare);
    }

    code = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('probe error:', e && e.message);
    code = 1;
  } finally {
    try { geoStub.close(); } catch (e) {}
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    console.log('\n' + '='.repeat(74));
    console.log(pass + ' passed, ' + fail + ' failed');
    setTimeout(() => process.exit(code), 300);
  }
}

main();
