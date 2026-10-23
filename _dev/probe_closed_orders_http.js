/* ==========================================================================
   Integration probe: is an order still ACCEPTED while the shop is closed?

   POST /api/checkout has enforced the owner's business hours since the first
   import (storeGate). POST /api/orders — the endpoint that actually puts an
   order on the kitchen board — never has. The guest page guards every UI
   path (add to cart, open cart, checkout, channel switch all refuse when
   ordersBlocked()), so an honest browser cannot get there. A hand-crafted
   POST can: it lands an order on the board while the kitchen is shut, and
   dings the owner's phone with the new-order push + e-mail.

   This probe asserts the enforcement that is MISSING, so it is RED on
   purpose until the gate exists:

     a counter order while closed        -> 409 closed   (not 200)
     it stays refused when the owner's
       manual switch says open           -> 409 closed   (hours win; the
                                            client computes openNow the same
                                            way — see applyStoreStatus)
     the same order with the shop open
       and the clock inside hours        -> 200 ok       (control)

   Not registered in _dev/run_all.sh on purpose: a red file in the suite
   would fail the whole run. It graduates there together with the fix.

   It writes to SCRATCH only and never touches the network.

   Run:  node _dev/probe_closed_orders_http.js
   ========================================================================== */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8981;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-closed-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-closed-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };

/* A window that is closed at every hour this suite is likely to run in:
   only 20:00–20:01 counts as open, so the default clock is "closed". The
   control case opens it up with the KPOT_HOURS_SPEC seam (see the second
   server below) rather than by waiting for a wall-clock moment. */
const CLOSED_SPEC = '{"openMinute":1200,"closeSunThu":1201,"closeFriSat":1201}';

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

function spawnServer(extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ADMIN_KEY: ADMIN,
      PRINT_KEY: 'probe-print-key',
      KPOT_FLUSH_MS: '500',
      KPOT_HOURS_SPEC: CLOSED_SPEC,
      KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
      KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
      KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
      KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
      /* handleCheckout checks the Stripe key BEFORE the store gate, so the
         control below needs a key present to reach the hours check at all.
         No session is ever created: the gate refuses first. */
      STRIPE_SECRET_KEY: 'sk_test_closed_probe_not_a_real_key'
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

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

/* An order built the way the guest page builds one. `payMethod: 'counter'`
   is the path where NO money has moved yet — the guest would pay at the
   counter, which is shut. */
function orderFor(no, total, extra) {
  return Object.assign({
    no: no,
    token: 'closed-' + no,
    /* DINE-IN: since 2026-10-22 pay-at-counter is refused on pickup and
       delivery, and these suites are about money/printing, not channels. */
    orderType: 'dinein',
    table: '5',
    customer: { name: 'Alex Smith', phone: '(404) 555-0199' },
    items: [HOTPOT],
    subtotal: 0, deliveryFee: 0, tax: 0, tip: 0, surcharge: 0,
    total: total,
    payMethod: 'counter',
    paymentStatus: 'unpaid',
    paid: false,
    source: 'probe'
  }, extra || {});
}

async function main() {
  const server = spawnServer();
  hookLog(server);
  try {
    await waitForHealth(80);
    console.log('order acceptance while the shop is closed');
    console.log('='.repeat(74));
    console.log('server up on ' + BASE + ' — hours: only 20:00–20:01 open, ' +
      'so the clock says CLOSED\n');

    /* Sanity: the environment really is closed, and the shop agrees. */
    const store = await get('/api/store');
    check('the shop reports itself closed (store.open=false, openNow=false)',
      store.j && store.j.open === false && store.j.openNow === false,
      JSON.stringify(store.j));

    const price = await post('/api/price', { orderType: 'pickup', items: [HOTPOT], tipAmount: 0 });
    check('the server can price a pickup order', price.status === 200, 'status=' + price.status);
    const total = price.j.total;

    /* ===================================================================== */
    section('POST /api/orders while closed');

    const closedOrder = await post('/api/orders', orderFor('CLOSED-1', total));
    check('a pay-at-counter order is REFUSED while the shop is closed',
      closedOrder.status === 409 && closedOrder.j && /closed|hours/i.test(closedOrder.j.error || ''),
      'status=' + closedOrder.status + ' ' + JSON.stringify(closedOrder.j));

    /* The owner's manual switch is already true-or-false on the clock; making
       it open must NOT be enough to order outside the configured hours — the
       guest page computes openNow from the server's hoursSpec the same way
       (state.storeOpen = store.open && store.openNow). */
    const on = await post('/api/store', { open: true, acceptingOrders: true }, adminH());
    check('the owner can still flip the manual switch', on.status === 200 && on.j && on.j.open === true,
      'status=' + on.status + ' ' + JSON.stringify(on.j));

    const closedOrder2 = await post('/api/orders', orderFor('CLOSED-2', total));
    check('and an outside-hours order is still refused with the switch open',
      closedOrder2.status === 409 && closedOrder2.j && /closed|hours/i.test(closedOrder2.j.error || ''),
      'status=' + closedOrder2.status + ' ' + JSON.stringify(closedOrder2.j));

    /* ===================================================================== */
    section('the exemption — online orders are NEVER turned away');

    /* The guest page writes this order the moment Stripe hands back a
       session, i.e. minutes before the money lands, and a guest who paid at
       21:29 must not come back at 21:31 to find their order gone. */
    const inflight = await post('/api/orders', orderFor('INFLIGHT-1', total, {
      orderType: 'pickup', payMethod: 'stripe', paymentStatus: 'pending'
    }));
    check('an order the guest is paying for online is ACCEPTED while closed',
      inflight.status === 200 && inflight.j && inflight.j.ok === true,
      'status=' + inflight.status + ' ' + JSON.stringify(inflight.j));
    const board0 = await get('/api/orders', adminH());
    const inflightRow = (board0.j && board0.j.orders || [])
      .find((o) => (o.id || o.no) === 'INFLIGHT-1');
    check('it lands UNPAID on the board, so the kitchen can see it is not settled',
      !!inflightRow && inflightRow.paid !== true && inflightRow.paymentStatus !== 'paid',
      JSON.stringify(inflightRow && { paid: inflightRow.paid, ps: inflightRow.paymentStatus }));

    /* Dine-In is the other pre-pay channel — same rule, and it is the shop's
       default channel on the guest page. */
    const dinein = await post('/api/orders', orderFor('CLOSED-DINEIN', total, { orderType: 'dinein' }));
    check('a Dine-In pay-at-counter order is refused while closed too',
      dinein.status === 409 && dinein.j && dinein.j.error === 'closed',
      'status=' + dinein.status + ' ' + JSON.stringify(dinein.j));

    /* The board must not have been written to — that is the whole point. */
    const board = await get('/api/orders', adminH());
    const leaked = (board.j && board.j.orders || []).filter((o) => /^CLOSED-/.test(o.id || o.no || ''));
    check('neither refused order reached the board', leaked.length === 0,
      'board has ' + leaked.length + ' of them: ' + JSON.stringify(leaked.map((o) => o.no)));

    /* ===================================================================== */
    section('the control — checkout already refuses (proving the seam)');
    const co = await post('/api/checkout', {
      orderNo: 'CLOSED-CO', orderType: 'pickup', items: [HOTPOT], tipAmount: 0,
      customer: { name: 'Alex Smith', phone: '(404) 555-0199' }, total: total
    });
    check('POST /api/checkout refuses the same order (the behaviour /api/orders lacks)',
      co.status === 409 && co.j && co.j.error === 'closed',
      'status=' + co.status + ' ' + JSON.stringify(co.j));

    /* ===================================================================== */
    section('with the clock inside hours, the order goes through (control)');
    server.kill();
    await sleep(400);
    const server2 = spawnServer({
      KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}'
    });
    hookLog(server2);
    let code = 1;
    try {
      await waitForHealth(80);
      const p2 = await post('/api/price', { orderType: 'pickup', items: [HOTPOT], tipAmount: 0 });
      const okOrder = await post('/api/orders', orderFor('OPEN-1', p2.j.total));
      check('the same order is ACCEPTED inside opening hours',
        okOrder.status === 200 && okOrder.j && okOrder.j.ok === true,
        'status=' + okOrder.status + ' ' + JSON.stringify(okOrder.j));

      /* The owner's pause is a different refusal from "closed", and the
         guest page reads it the same way — prove the gate honours it. */
      const paused = await post('/api/store', { acceptingOrders: false }, adminH());
      check('the owner can pause online orders', paused.status === 200 && paused.j && paused.j.acceptingOrders === false,
        'status=' + paused.status + ' ' + JSON.stringify(paused.j));
      const pausedOrder = await post('/api/orders', orderFor('OPEN-2', p2.j.total));
      check('a counter order is refused while orders are paused',
        pausedOrder.status === 409 && pausedOrder.j && pausedOrder.j.error === 'not_accepting',
        'status=' + pausedOrder.status + ' ' + JSON.stringify(pausedOrder.j));

      code = fail === 0 ? 0 : 1;
    } catch (e) {
      console.error('probe error:', e && e.message);
      code = 1;
    } finally {
      try { server2.kill(); } catch (e) {}
      finish(code);
    }
  } catch (e) {
    console.error('probe error:', e && e.message);
    finish(1);
  }
}

function finish(code) {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + '='.repeat(74));
  console.log(pass + ' passed, ' + fail + ' failed' +
    (fail ? '  <-- /api/orders did not enforce the hours' : '  — /api/orders refuses counter orders while closed'));
  setTimeout(() => process.exit(code), 300);
}

main();
