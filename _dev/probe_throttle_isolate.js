#!/usr/bin/env node
/* ==========================================================================
   Throttle ISOLATION — one endpoint's traffic is not another's budget.

   throttled() keeps ONE counter per key, and five endpoints used to key it by
   the caller's bare IP. So they all incremented the same number and compared
   it against their own limit, which meant the tightest limit in the group was
   the one everybody got:

       GET  /api/customer        60/min   (typing a number, twice per guest)
       POST /api/price           40/min   (the page re-prices on EVERY tap)
       POST /api/checkout        20/min
       GET  /api/verify-session  60/min
       POST /api/orders          30/min

   The guest page re-prices on every item tap and every reward choice, so a
   basket fiddled with 30 times in a minute hit the ORDER wall before the
   guest had paid for anything. And on the shop's wifi every table shares one
   address, so it was never just that one guest.

   The same namespacing this probe pins down was already in place for the
   claim and recovery endpoints; these five simply never got it.

   Run standalone it is the only thing on the wire, so the budgets are known:
   35 re-prices is under /api/price's own 40 (so all 35 must succeed) but over
   the 30 the order endpoint used to impose on that same shared counter. That
   exact number is what makes this probe go red without the fix.

   Run:  node _dev/probe_throttle_isolate.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8964', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'throttle-probe-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-throttle-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 35: under /api/price's 40, over the 30 /api/orders used to share. */
const REPRICES = 35;

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}

const post = (route, body) => fetch(BASE + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then((r) => r.text().then((t) => {
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = t; }
  return { status: r.status, j: j };
}));

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };
const priceBody = () => ({ orderType: 'pickup', items: [HOTPOT], tipAmount: 0 });
/* A number with no wallet, so this order cannot disturb anyone's balance —
   the same trick probe_loyalty.js uses for its forged-payment section. */
const THROTTLE_PHONE = '4045550777';
const orderFor = (no, total) => ({
  no: no,
  token: 'thr-' + no,
  /* DINE-IN: since 2026-10-22 pay-at-counter is refused on pickup and
     delivery, and these suites are about money/discounts, not channels. */
  orderType: 'dinein',
  table: '5',
  customer: { name: 'Throttle Probe', phone: THROTTLE_PHONE },
  items: [HOTPOT],
  subtotal: 15.99, deliveryFee: 0, tax: 0.96, tip: 0, surcharge: 0,
  total: total, payMethod: 'counter', paymentStatus: 'counter',
  paid: false, source: 'probe'
});

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'throttle-print-key',
    KPOT_FLUSH_MS: '60000',
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:9',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
       refuses those outside opening hours. The clock must not decide these
       cases. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
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

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}

waitForHealth(80).then(() => {
  console.log('throttle isolation — ' + BASE + '\n');

  /* The order goes FIRST, on an untouched counter, so the two results below
     are directly comparable: same code path, same order, only the traffic
     before it differs. */
  return post('/api/orders', orderFor('KP-THR-1', 16.95));
}).then((r) => {
  check('an order is accepted on a fresh counter',
    r.status === 200 && r.j && r.j.ok === true,
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* Now do exactly what the guest page does: re-price, over and over, as the
     basket is fiddled with. */
  const reprices = [];
  for (let i = 0; i < REPRICES; i++) reprices.push(post('/api/price', priceBody()));
  return Promise.all(reprices);
}).then((priced) => {
  const ok = priced.filter((r) => r.status === 200).length;
  check('re-pricing ' + REPRICES + ' times in a row is allowed (that is the page\'s own budget)',
    ok === REPRICES,
    '200s=' + ok + ' of ' + REPRICES + ' — a rate_limited here would mean the price limit is too tight');

  /* THE POINT: the order must still work. Before the namespacing this came
     back 429 "too many orders" — the guest had paid nothing and touched no
     order endpoint, but the shared counter said they had had enough. */
  return post('/api/orders', orderFor('KP-THR-2', 16.95));
}).then((r) => {
  check('and the ORDER still goes through, on its own budget',
    r.status === 200 && r.j && r.j.ok === true,
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* The public lookup, which the page now makes to prove the phone number.
     It sits behind the re-pricing in the guest flow, so it has to survive
     having priced a basket first. */
  const reads = [];
  for (let i = 0; i < 25; i++) reads.push(fetch(BASE + '/api/customer?phone=4045550777').then((r) => r.status));
  return Promise.all(reads);
}).then((codes) => {
  const ok = codes.filter((s) => s === 200).length;
  check('and the lookup that proves the phone number still works after all that',
    ok === codes.length,
    '200s=' + ok + ' of ' + codes.length + ' (statuses: ' + [...new Set(codes)].join(', ') + ')');

  /* Each limit still has to bite on its own, or the namespacing has just
     replaced one shared counter with five that never fire. */
  const burst = [];
  for (let i = 0; i < 45; i++) burst.push(post('/api/price', priceBody()));
  return Promise.all(burst);
}).then((priced) => {
  const limited = priced.filter((r) => r.status === 429).length;
  check('the price limit STILL bites past 40 (the namespacing did not simply open it up)',
    limited > 0, '429s=' + limited + ' of ' + priced.length);

  const burst = [];
  for (let i = 0; i < 40; i++) burst.push(post('/api/orders', orderFor('KP-THR-3', 16.95)));
  return Promise.all(burst);
}).then((r2) => {
  const limited = r2.filter((r) => r.status === 429).length;
  check('and the order limit STILL bites past 30',
    limited > 0, '429s=' + limited + ' of ' + r2.length);
  check('with the order-shaped message, so the guest is told what to do',
    limited > 0 && r2.some((r) => /too many orders/i.test(String((r.j || {}).message || ''))),
    JSON.stringify(r2.find((r) => r.status === 429) || {}));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { server.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}).catch((e) => {
  console.log('  FAIL  harness threw: ' + e.message + '\n' + serverLog.split('\n').slice(-12).join('\n'));
  try { server.kill('SIGKILL'); } catch (e2) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e2) {}
  setTimeout(() => process.exit(1), 300);
});
