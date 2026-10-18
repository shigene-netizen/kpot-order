#!/usr/bin/env node
/* ==========================================================================
   Kitchen automation — can the owner stop tapping PREPARING?

   THE FEATURE UNDER TEST
   ----------------------
   With `autoPrepare` switched on (from the board, saved in store.local.json),
   an order goes to the kitchen by itself:

     * dine-in  — on arrival. The guest is at the table.
     * pickup / delivery — the moment the money is confirmed, and only from a
       source the server trusts: Stripe's own answer (the guest's phone
       returning from checkout, or staff tapping Re-check), or an admin PATCH.

   Printing is the same code path as the manual tap — same rendered ticket,
   same idempotent queue — so "auto" is really only about WHO moves the order.

   WHAT WOULD GO WRONG
   -------------------
   The dangerous version of this feature is not "fails to automate". It is
   "automates an unpaid order". So most of these checks are about the doors
   staying shut:

     * the checkout payload is public — anyone can POST
       {"orderType":"pickup","paymentStatus":"verified"} with curl. A claimed
       payment must NOT start a grill.
     * an order staff already tapped PREPARING must not print twice when the
       payment later confirms.
     * an unrecognised order type must fail closed.
     * the switch defaults to OFF, and turning it OFF must stop automation
       immediately — including for staff-set payment status.

   Run:  node _dev/test_auto_prepare.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8961', 10);
const PORT2 = parseInt(process.env.PORT2 || '8962', 10);
const STUB_PORT = parseInt(process.env.STRIPE_STUB_PORT || '8963', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const BASE2 = 'http://127.0.0.1:' + PORT2;
const STUB_BASE = 'http://127.0.0.1:' + STUB_PORT;
const STRIPE_BASE = STUB_BASE + '/v1/checkout/sessions';

/* Deliberately bogus test keys: this suite must never hold the shop's real
   credentials, and the startup log is checked for "live" below. */
const ADMIN_KEY = 'test-admin-key-autoprepare';
const PRINT_KEY = 'test-print-key-autoprepare';
const SECRET_KEY = 'sk_test_autoprepare_not_a_real_key';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-autoprepare-'));
const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');
const PRINT_FILE = path.join(SCRATCH, 'print.local.json');
const STORE_FILE = path.join(SCRATCH, 'store.local.json');
const SECRETS_FILE = path.join(SCRATCH, 'secrets.local.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n' + t); }

async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error('timed out waiting for ' + label);
}

/* -------------------------------------------------------------------------- */
/* Stub Stripe                                                                 */
/* -------------------------------------------------------------------------- */
/* The same seam the re-check suite uses: the server is pointed at
   KPOT_STRIPE_API_BASE, so verify-session and recheck-payment talk to this
   instead of api.stripe.com and the answers are deterministic. */
let sessions = [];

function stubSession(id, orderId, paymentStatus) {
  return {
    id,
    object: 'checkout.session',
    client_reference_id: orderId,
    payment_status: paymentStatus,
    status: paymentStatus === 'paid' ? 'complete' : 'open',
    amount_total: 1695,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000) - 60
  };
}

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (u.pathname === '/v1/checkout/sessions') {
    const gte = parseInt(u.searchParams.get('created[gte]') || '0', 10);
    const lte = parseInt(u.searchParams.get('created[lte]') || '0', 10);
    let rows = sessions.slice().sort((a, b) => b.created - a.created);
    if (gte) rows = rows.filter((s) => s.created >= gte);
    if (lte) rows = rows.filter((s) => s.created <= lte);
    return send(200, { object: 'list', data: rows, has_more: false });
  }

  const one = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (one) {
    const s = sessions.find((x) => x.id === decodeURIComponent(one[1]));
    if (!s) return send(404, { error: { message: 'No such checkout session' } });
    return send(200, s);
  }
  return send(404, { error: { message: 'unexpected stub path ' + u.pathname } });
});

/* -------------------------------------------------------------------------- */
/* Server boot                                                                 */
/* -------------------------------------------------------------------------- */

function bootServer(port, extraEnv) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      ADMIN_KEY,
      PRINT_KEY,
      KPOT_ORDERS_FILE: ORDERS_FILE,
      KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS_FILE), 'customers.local.json'),
      KPOT_PRINT_FILE: PRINT_FILE,
      KPOT_STORE_FILE: STORE_FILE,
      /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
         refuses those outside opening hours. The clock must not decide these
         cases. See hoursSpec() in server.js. */
      KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
      KPOT_SECRETS_FILE: SECRETS_FILE,
      KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
      KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
      STRIPE_SECRET_KEY: SECRET_KEY,
      KPOT_STRIPE_API_BASE: STRIPE_BASE,
      KPOT_FLUSH_MS: '500'
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { proc, log: '' };
  proc.stdout.on('data', (d) => { state.log += d.toString(); });
  proc.stderr.on('data', (d) => { state.log += d.toString(); });
  return state;
}

async function waitHealthy(base, srv, label) {
  const ok = await waitFor(async () => {
    try {
      const r = await fetch(base + '/api/health');
      const j = await r.json();
      return !!(j && j.ok);
    } catch (e) { return false; }
  }, 15000, label || 'server');
  if (!ok) throw new Error('server never became healthy: ' + srv.log.slice(-800));
}

/* Reused for the restart checks: a just-killed server's port can take a moment
   to come back, so a boot that races it is retried rather than trusted. */
async function bootHealthy(port, extraEnv) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(600);
    const srv = bootServer(port, extraEnv);
    try {
      await waitHealthy('http://127.0.0.1:' + port, srv, 'server on ' + port);
      return srv;
    } catch (e) {
      try { srv.proc.kill(); } catch (e2) {}
    }
  }
  throw new Error('server never became healthy on ' + port);
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* -------------------------------------------------------------------------- */

const jreq = (base, method, p, body, headers) => fetch(base + p, {
  method,
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

const jpost = (base, p, body, headers) => jreq(base, 'POST', p, body, headers);
/* /api/store is SET with POST (the board's own toggle row does it that way);
   only /api/orders/:id is PATCHed. */
const jsetstore = (base, body, headers) => jreq(base, 'POST', '/api/store', body, headers);
const jpatch = (base, p, body, headers) => jreq(base, 'PATCH', p, body, headers);
const jget = (base, p, headers) => fetch(base + p, { headers: headers || {} })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
const admin = { 'x-admin-key': ADMIN_KEY };

/* -------------------------------------------------------------------------- */
/* Orders + tickets                                                            */
/* -------------------------------------------------------------------------- */

const TOKEN = Date.now().toString(36);
let seq = 0;

/* An order type the server does not recognise. The only honest way to get one
   onto the board is a hand-edited orders file, so it is seeded BEFORE the
   server boots and then paid for with a real (stubbed) session. Seeding it
   while the server runs would be overwritten by the next save — the in-memory
   map is the server's truth. */
const WEIRD = 'KP-AO-WEIRD-' + TOKEN;

function mkOrder(id, over) {
  seq++;
  const unit = 15.99;
  const subtotal = round2(unit);
  const tax = round2(subtotal * 0.06);
  const o = {
    no: id,
    orderNo: id,
    token: 'autoprep-' + TOKEN + '-' + seq,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Auto Prepare', phone: '4045550142', when: 'ASAP', notes: '' },
    items: [{ kind: 'hotpot', name: 'Build Your Own Bowl', qty: 1, unit, mods: [], addons: [], note: '' }],
    subtotal, deliveryFee: 0, tax, tip: 0, surcharge: 0,
    total: round2(subtotal + tax),
    payMethod: 'stripe',
    paymentStatus: 'pending',
    paid: false,
    source: 'autoprepare-test'
  };
  return Object.assign(o, over || {});
}

/* The durable record of what the kitchen would print. Polled rather than read
   once: the print queue is snapshotted on an 800 ms debounce, so a tick can
   land before the file catches up. */
function readJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(PRINT_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
async function jobsWait(orderId, n, timeoutMs) {
  await waitFor(async () => readJobs().filter((j) => j.orderId === orderId).length >= n,
    timeoutMs || 6000, n + ' kitchen job(s) for ' + orderId);
  return readJobs().filter((j) => j.orderId === orderId);
}
async function orderAt(base, id) {
  const r = await jget(base, '/api/orders?since=1970-01-01T00:00:00Z', admin);
  const list = (r.j && r.j.orders) || [];
  return list.find((o) => o.id === id) || null;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

let srv1 = null, srv2 = null;

async function main() {
  console.log('kitchen automation — who moves the order to the kitchen?');
  console.log('='.repeat(74));

  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

  const cleanup = async () => {
    try { if (srv1) srv1.proc.kill(); } catch (e) {}
    try { if (srv2) srv2.proc.kill(); } catch (e) {}
    try { stub.close(); } catch (e) {}
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', () => { try { cleanup(); } catch (e) {} });

  try {
    /* ---- boot: no store file yet, so autoPrepare must default OFF ------- */
    /* The unknown-type order is on the board from the first moment. It has no
       session yet; one is handed to it later, at the point where a normal
       pickup order would have been confirmed. */
    /* A checkout payload has none of the three fields below — the server adds
       them. A snapshot on disk needs all of them: `id` or loadOrders() drops
       it, `at` or listOrders() filters it out of the board, and `status` or
       there is nothing to assert against. */
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([
      mkOrder(WEIRD, {
        id: WEIRD, at: new Date().toISOString(), updatedAt: new Date().toISOString(),
        status: 'received',
        orderType: 'teleport', payMethod: 'stripe'
      })
    ], null, 2));

    srv1 = bootServer(PORT);
    await waitHealthy(BASE, srv1);
    section('boot');
    const modeLine = (srv1.log.match(/\[kpot\] stripe key: .*/) || [''])[0];
    check('server booted without a live Stripe key', !/live/.test(modeLine), modeLine.trim() || '(no key line)');
    check('the default is OFF', !/auto-prepare on/.test(srv1.log), srv1.log.split('\n').filter((l) => /store status loaded/.test(l)).join(''));

    /* ---- switch OFF: nothing moves by itself ---------------------------- */
    section('switch OFF (default)');
    const d1 = 'KP-AO-DINE-OFF-' + TOKEN;
    const r1 = await jpost(BASE, '/api/orders', mkOrder(d1, { orderType: 'dinein', table: '7', payMethod: 'counter', paymentStatus: 'counter' }));
    check('a dine-in order is recorded, not cooked', r1.status === 200 && r1.j && r1.j.status === 'received', JSON.stringify(r1.j));
    check('and no ticket was queued', readJobs().length === 0, 'jobs=' + readJobs().length);

    const p1 = 'KP-AO-PICK-OFF-' + TOKEN;
    const r2 = await jpost(BASE, '/api/orders', mkOrder(p1));
    check('a pickup order is recorded, not cooked', r2.status === 200 && r2.j && r2.j.status === 'received', JSON.stringify(r2.j));

    /* ---- switch validation ---------------------------------------------- */
    section('switch validation (admin only, booleans only)');
    const noKey = await jsetstore(BASE, { autoPrepare: true });
    check('POST /api/store needs the admin key', noKey.status === 401, 'status=' + noKey.status);
    const bad = await jsetstore(BASE, { autoPrepare: 'yes' }, admin);
    check('a non-boolean is refused, not coerced', bad.status === 400 && bad.j && bad.j.error === 'bad_value', JSON.stringify(bad.j));
    const nothing = await jsetstore(BASE, { nonsense: true }, admin);
    check('an unknown key changes nothing', nothing.status === 400 && nothing.j && nothing.j.error === 'nothing_to_update', JSON.stringify(nothing.j));

    /* ---- switch ON ------------------------------------------------------ */
    section('switch ON');
    const on = await jsetstore(BASE, { autoPrepare: true }, admin);
    check('the owner can turn it on', on.status === 200 && on.j && on.j.autoPrepare === true, JSON.stringify(on.j));
    check('and it landed in the saved file', (() => {
      try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).autoPrepare === true; } catch (e) { return false; }
    })(), STORE_FILE);

    const d2 = 'KP-AO-DINE-ON-' + TOKEN;
    const r3 = await jpost(BASE, '/api/orders', mkOrder(d2, { orderType: 'dinein', table: '9', payMethod: 'counter', paymentStatus: 'counter' }));
    check('a dine-in order arrives already cooking', r3.j && r3.j.status === 'preparing', JSON.stringify(r3.j));
    check('the guest-facing status says so too', (await orderAt(BASE, d2) || {}).status === 'preparing');
    const d2jobs = await jobsWait(d2, 1);
    check('exactly one ticket was queued for it', d2jobs.length === 1 && d2jobs[0].kind === 'kitchen', JSON.stringify(d2jobs.map((j) => j.id)));
    check('and the ticket is real bytes', typeof d2jobs[0].bytes === 'string' && d2jobs[0].bytes.length > 100,
      d2jobs[0].bytes.length + ' base64 chars');

    const p2 = 'KP-AO-PICK-WAIT-' + TOKEN;
    const r4 = await jpost(BASE, '/api/orders', mkOrder(p2));
    check('a pickup order still waits for its money', r4.j && r4.j.status === 'received', JSON.stringify(r4.j));
    check('and no ticket was queued for it', readJobs().filter((j) => j.orderId === p2).length === 0);

    /* The security door. */
    const p3 = 'KP-AO-PICK-LIE-' + TOKEN;
    const r5 = await jpost(BASE, '/api/orders', mkOrder(p3, { paymentStatus: 'verified' }));
    check('a CLAIM of payment does not cook the order', r5.j && r5.j.status === 'received', JSON.stringify(r5.j));
    check('and still queues no ticket', readJobs().filter((j) => j.orderId === p3).length === 0);

    /* ---- Delivery is now next-day and windowed --------------------------
       Two doors this pins, both "shut":
         * the channel ships OFF, so a delivery order cannot be placed at all;
         * once the owner turns it on, a delivery must book a day and a window
           out of /api/schedule, and pays a fee that is part of the taxed base.
       The total is taken from the SERVER's own /api/price, never hand-computed:
       a hard-coded fee is exactly how this suite went stale when the flat
       delivery fee became a windowed one, and when the fee started following
       the runtime switch rather than the static config seed. */
    const dl0 = 'KP-AO-DELIV-OFF-' + TOKEN;
    const r6off = await jpost(BASE, '/api/orders', mkOrder(dl0, { orderType: 'delivery' }));
    check('a delivery order is refused while the channel is off',
      r6off.status === 409 && r6off.j && r6off.j.error === 'delivery_unavailable', JSON.stringify(r6off.j));

    /* Turn the channel on the way the OWNER does — the board's runtime switch —
       not by editing the config seed. The static line stays false. */
    const dlOn = await jsetstore(BASE, { orderTypes: { delivery: true } }, admin);
    check('the owner can switch Delivery on from the board', dlOn.status === 200, JSON.stringify(dlOn.j));

    const sched = await jget(BASE, '/api/schedule');
    check('the schedule turns on with the channel',
      sched.status === 200 && sched.j && sched.j.enabled === true,
      JSON.stringify(sched.j && { enabled: sched.j.enabled, fee: sched.j.fee }));
    const day = (sched.j && sched.j.days && sched.j.days[0]) || null;
    check('the first bookable day is TOMORROW, never today',
      !!day && day.daysAhead === 1, JSON.stringify(sched.j && sched.j.days));
    const dayView = await jget(BASE, '/api/schedule?date=' + encodeURIComponent((day && day.iso) || '2099-12-31'));
    const slot = ((dayView.j && dayView.j.slots) || []).find((s) => !s.full && !s.outsideHours) || null;
    check('and it offers at least one usable window', !!slot, JSON.stringify(dayView.j && dayView.j.slots));

    const dl1 = 'KP-AO-DELIV-WAIT-' + TOKEN;
    const dlPrice = await jpost(BASE, '/api/price', mkOrder(dl1, { orderType: 'delivery' }));
    /* Delivery is FREE as shipped (config.delivery.fee = 0) — a promotion.
       This used to assert $1.99. What matters to this probe is not the amount
       but that the SERVER prices the order and its numbers are what we then
       echo back into the create payload (total_mismatch would refuse anything
       else), so the assertion follows the server rather than a price list. */
    check('the server prices the delivery line into the bill (free as shipped)',
      dlPrice.status === 200 && dlPrice.j && dlPrice.j.delivery === 0, JSON.stringify(dlPrice.j));

    const r6 = await jpost(BASE, '/api/orders', mkOrder(dl1, {
      orderType: 'delivery',
      deliveryFee: (dlPrice.j && dlPrice.j.delivery) || 0,
      tax: (dlPrice.j && dlPrice.j.tax) || 0,
      total: (dlPrice.j && dlPrice.j.total) || 0,
      schedule: { date: (day && day.iso) || '2099-12-31', slot: (slot && slot.id) || 'lunch' }
    }));
    check('a scheduled delivery order is accepted', r6.status === 200 && r6.j && r6.j.status === 'received', JSON.stringify(r6.j));
    /* The create response is deliberately thin ({ok,id,status}) — the schedule
       fields live on the stored order, so read it back from the board rather
       than expecting scheduledFor on the ack. */
    const dlStored = await orderAt(BASE, dl1);
    check('and it carries a FUTURE window, not "now"',
      !!dlStored && !!dlStored.scheduledFor && Date.parse(dlStored.scheduledFor) > Date.now(),
      dlStored ? (dlStored.deliveryDate + ' ' + dlStored.deliverySlot + ' -> ' + dlStored.scheduledFor) : '(missing)');
    check('and queues no ticket', readJobs().filter((j) => j.orderId === dl1).length === 0);

    /* ---- the money arrives --------------------------------------------- */
    section('money confirmed');
    sessions = [
      stubSession('cs_test_aopickpaid' + TOKEN, p2, 'paid'),
      stubSession('cs_test_aodelivpaid' + TOKEN, dl1, 'paid')
    ];

    const v1 = await jget(BASE, '/api/verify-session?id=cs_test_aopickpaid' + TOKEN);
    check("the guest's returning phone confirms the payment", v1.status === 200 && v1.j && v1.j.verified === true, JSON.stringify(v1.j));
    check('and the pickup order joins the kitchen', (await orderAt(BASE, p2) || {}).status === 'preparing');
    await jobsWait(p2, 1);
    check('one ticket for it', readJobs().filter((j) => j.orderId === p2).length === 1);

    /* Verify twice: a flaky network retries, and a retry must be free. */
    await jget(BASE, '/api/verify-session?id=cs_test_aopickpaid' + TOKEN);
    await sleep(400);
    check('calling verify again prints nothing new', readJobs().filter((j) => j.orderId === p2).length === 1);

    /* A paid delivery for TOMORROW must NOT cook now, and must print nothing:
       the window guard in shouldAutoPrepare() holds even though the money is
       confirmed. This is the other side of the same rule the scheduled probe
       pins — money is necessary but not sufficient for a future order. */
    const v2 = await jget(BASE, '/api/verify-session?id=cs_test_aodelivpaid' + TOKEN);
    const dlAfterPay = await orderAt(BASE, dl1);
    check('a paid delivery for tomorrow does NOT jump into the kitchen yet',
      v2.status === 200 && !!dlAfterPay && dlAfterPay.status === 'received',
      dlAfterPay ? dlAfterPay.status : '(missing)');
    check('its money IS confirmed, so it is not stuck unpaid either',
      !!dlAfterPay && dlAfterPay.paymentStatus === 'verified',
      dlAfterPay && dlAfterPay.paymentStatus);
    await sleep(400);
    check('and no ticket was printed for it', readJobs().filter((j) => j.orderId === dl1).length === 0);

    /* Staff tapped first: the human wins, and no second ticket appears when
       the payment afterwards confirms. */
    const p4 = 'KP-AO-PICK-TAPPED-' + TOKEN;
    await jpost(BASE, '/api/orders', mkOrder(p4));
    const tap = await jpatch(BASE, '/api/orders/' + encodeURIComponent(p4), { status: 'preparing' }, admin);
    check('staff can still tap PREPARING by hand', tap.status === 200 && tap.j && tap.j.status === 'preparing');
    await jobsWait(p4, 1);
    sessions.push(stubSession('cs_test_aotapped' + TOKEN, p4, 'paid'));
    await jget(BASE, '/api/verify-session?id=cs_test_aotapped' + TOKEN);
    await sleep(400);
    check('a later payment confirmation prints nothing new', readJobs().filter((j) => j.orderId === p4).length === 1);

    /* Staff Re-check is the other trusted source. */
    const p5 = 'KP-AO-PICK-RECHECK-' + TOKEN;
    await jpost(BASE, '/api/orders', mkOrder(p5));
    sessions.push(stubSession('cs_test_aorecheck' + TOKEN, p5, 'paid'));
    const rc = await jpost(BASE, '/api/orders/' + encodeURIComponent(p5) + '/recheck-payment', {}, admin);
    check('Re-check payment settles the order', rc.status === 200 && rc.j && rc.j.ok === true && rc.j.paid === true, JSON.stringify(rc.j));
    check('and it reaches the kitchen', (await orderAt(BASE, p5) || {}).status === 'preparing');
    await jobsWait(p5, 1);

    /* Staff correcting a payment status by hand also counts. */
    const p6 = 'KP-AO-PICK-STAFFSET-' + TOKEN;
    await jpost(BASE, '/api/orders', mkOrder(p6));
    const st = await jpatch(BASE, '/api/orders/' + encodeURIComponent(p6), { paymentStatus: 'verified' }, admin);
    check('a staff payment-status fix moves the order', st.status === 200 && st.j && st.j.status === 'preparing', JSON.stringify(st.j));
    await jobsWait(p6, 1);

    /* ---- fail closed ---------------------------------------------------- */
    section('doors that stay shut');
    /* The unknown order type was seeded at boot. It now gets paid for with a
       real (stubbed) session, exactly like a pickup order would. */
    sessions.push(stubSession('cs_test_aoweird' + TOKEN, WEIRD, 'paid'));
    await jget(BASE, '/api/verify-session?id=cs_test_aoweird' + TOKEN);
    await sleep(400);
    const weirdNow = await orderAt(BASE, WEIRD);
    const board = (await jget(BASE, '/api/orders?since=1970-01-01T00:00:00Z', admin)).j || {};
    const boardIds = ((board.orders || []).map((o) => o.id + ':' + o.status)).join(', ');
    check('an unknown order type fails closed', !!weirdNow && weirdNow.status === 'received',
      (weirdNow ? weirdNow.status : '(order missing from the board)') + ' | board: ' + boardIds);
    check('and got no ticket', readJobs().filter((j) => j.orderId === WEIRD).length === 0);

    /* An unpaid session cancels the order instead of cooking it. */
    const p7 = 'KP-AO-PICK-UNPAID-' + TOKEN;
    await jpost(BASE, '/api/orders', mkOrder(p7));
    sessions.push(stubSession('cs_test_aounpaid' + TOKEN, p7, 'unpaid'));
    await jget(BASE, '/api/verify-session?id=cs_test_aounpaid' + TOKEN);
    await sleep(400);
    const gone = await orderAt(BASE, p7);
    check('an unpaid session is cancelled, not cooked', !!gone && gone.status === 'cancelled' && gone.paymentStatus !== 'verified',
      gone ? gone.status + '/' + gone.paymentStatus : '(missing)');
    check('and printed nothing', readJobs().filter((j) => j.orderId === p7).length === 0);

    /* ---- survives a restart -------------------------------------------- */
    section('restart');
    srv2 = await bootHealthy(PORT2);
    check('the switch is still on after a restart', /auto-prepare on/.test(srv2.log), srv2.log.split('\n').filter((l) => /store status loaded/.test(l)).join(''));
    const d3 = 'KP-AO-DINE-RESTART-' + TOKEN;
    const r7 = await jpost(BASE2, '/api/orders', mkOrder(d3, { orderType: 'dinein', table: '3', payMethod: 'counter', paymentStatus: 'counter' }));
    check('and a dine-in order still auto-cooks on the new process', r7.j && r7.j.status === 'preparing', JSON.stringify(r7.j));
    await jobsWait(d3, 1);

    /* ---- switch OFF again ---------------------------------------------- */
    section('switch OFF again');
    const off = await jsetstore(BASE, { autoPrepare: false }, admin);
    check('the owner can turn it off', off.status === 200 && off.j && off.j.autoPrepare === false, JSON.stringify(off.j));

    const d4 = 'KP-AO-DINE-OFF2-' + TOKEN;
    const r8 = await jpost(BASE, '/api/orders', mkOrder(d4, { orderType: 'dinein', table: '4', payMethod: 'counter', paymentStatus: 'counter' }));
    check('a dine-in order waits for a human again', r8.j && r8.j.status === 'received', JSON.stringify(r8.j));

    const p8 = 'KP-AO-PICK-OFF2-' + TOKEN;
    await jpost(BASE, '/api/orders', mkOrder(p8));
    sessions.push(stubSession('cs_test_aoff2' + TOKEN, p8, 'paid'));
    await jget(BASE, '/api/verify-session?id=cs_test_aoff2' + TOKEN);
    const st2 = await jpatch(BASE, '/api/orders/' + encodeURIComponent(p8), { paymentStatus: 'verified' }, admin);
    check('paid but not auto-cooked once switched off', st2.j && st2.j.status === 'received', JSON.stringify(st2.j));

    /* Off survives a restart too — the safe direction. */
    srv2.proc.kill();
    await sleep(500);
    srv2 = await bootHealthy(PORT2);
    check('OFF survives a restart as well', !/auto-prepare on/.test(srv2.log));
    const d5 = 'KP-AO-DINE-OFF3-' + TOKEN;
    const r9 = await jpost(BASE2, '/api/orders', mkOrder(d5, { orderType: 'dinein', table: '5', payMethod: 'counter', paymentStatus: 'counter' }));
    check('and nothing cooks by itself after that restart', r9.j && r9.j.status === 'received', JSON.stringify(r9.j));
  } finally {
    await cleanup();
  }

  console.log('\n' + '='.repeat(74));
  const tail = fail === 0 ? 'PASS — ' + pass + ' checks, 0 failed' : 'FAIL — ' + pass + ' passed, ' + fail + ' failed';
  console.log(tail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('suite crashed:', e && e.stack ? e.stack : e);
  try {
    if (srv1) srv1.proc.kill();
    if (srv2) srv2.proc.kill();
    stub.close();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch (e2) {}
  process.exit(1);
});
