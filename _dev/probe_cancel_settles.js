#!/usr/bin/env node
/* Does backing out of Stripe actually take the order OFF the kitchen board?

   The order is recorded on the board BEFORE the guest is handed to Stripe (it
   has to be — that is how the number is reserved). If the guest then backs
   out, the guest is told "your order was not placed" — so the board must not
   keep it as an active ticket, or the kitchen cooks an order nobody wants.

   The guest cannot fix this itself: PATCH /api/orders/:id is admin-gated.
   The cancel path therefore routes through /api/verify-session, and the
   SERVER cancels the order once Stripe confirms the session is unpaid.

   This probe proves that, against the REAL Stripe API, with no browser:

     create order -> create real session -> verify (unpaid)
       -> order must be 'cancelled' on the board

   It expires the session and restores orders.local.json on the way out.

   Usage:
     KPOT_KEY_FILE=C:/test/kpot-test-key.txt node _dev/probe_cancel_settles.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8941', 10);
const BASE = 'http://127.0.0.1:' + PORT;
/* Scratch, not the shop's board — see the note on the spawn env below. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-cancel-'));
const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');

const KEY = (() => {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  const f = process.env.KPOT_KEY_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
})();
if (!KEY) { console.error('no key: set KPOT_KEY_FILE or STRIPE_SECRET_KEY'); process.exit(2); }
if (/^(?:sk|rk)_live_/.test(KEY)) { console.error('refusing to run against a LIVE key'); process.exit(2); }

const adminKey = (() => {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.local.json'), 'utf8')).adminKey || ''; }
  catch (e) { return ''; }
})();

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

/* One 'Hot Pot To Go' bowl = $15.99 -> $16.95 with 6% tax. */
function makeOrder(token) {
  const unit = 15.99;
  const subtotal = round2(unit);
  const tax = round2(subtotal * 0.06);
  return {
    no: 'KP-CANCEL-' + token,
    orderNo: 'KP-CANCEL-' + token,
    token: 'cancel-' + token,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Cancel Probe', phone: '', when: 'ASAP' },
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: unit, mods: [], addons: [], note: '' }],
    subtotal: subtotal, deliveryFee: 0, tax: tax, tip: 0, surcharge: 0,
    total: round2(subtotal + tax),
    payMethod: 'stripe', paymentStatus: 'pending', paid: false,
    source: 'cancel-probe'
  };
}

const jpost = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));

const jget = (p, headers) => fetch(BASE + p, { headers: headers || {} })
  .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));

async function main() {
  console.log('cancel-path probe — does an abandoned Stripe order leave the board?');
  console.log('='.repeat(72));
  console.log('key mode: test\n');


  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STRIPE_SECRET_KEY: KEY,
      STRIPE_ENABLED: '1',
      /* Scratch files: this probe writes orders, so it must not write them into
         the shop's own board. */
      KPOT_ORDERS_FILE: ORDERS_FILE,
      KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS_FILE), 'customers.local.json'),
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });

  let sessionId = null;
  try {
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { const j = await r.json(); if (j && j.checkout) { health = j; break; } }
      } catch (e) {}
      await sleep(250);
    }
    if (!health) throw new Error('server never became healthy');
    console.log('server up, keyMode=' + health.keyMode + '\n');

    const token = Date.now().toString(36);
    const order = makeOrder(token);

    /* 1. The guest places the order — it lands on the board as UNPAID. */
    const created = await jpost('/api/orders', order);
    check('order recorded on the board as pending',
      created.status === 200 && created.j && created.j.ok === true,
      'status=' + created.status + ' body=' + JSON.stringify(created.j));
    const orderNo = (created.j && created.j.id) || order.no;

    /* 2. The guest is handed to Stripe — a REAL session is created. */
    const co = await jpost('/api/checkout', order);
    sessionId = (co.j && co.j.id) || null;
    check('a real Stripe session was created',
      co.status === 200 && !!sessionId && sessionId.startsWith('cs_test_'),
      'status=' + co.status + ' sessionId=' + sessionId);

    /* 3. The guest clicks "Back" on Stripe -> /?canceled=1 -> the app calls
          verify-session for the abandoned order. */
    const ver = await jget('/api/verify-session?id=' + encodeURIComponent(sessionId));
    check('verify reports the abandoned session as NOT paid',
      ver.status === 200 && ver.j && ver.j.verified === false,
      'status=' + ver.status + ' body=' + JSON.stringify(ver.j));

    await sleep(600);

    /* 4. THE POINT: the order must no longer be an active ticket. */
    const got = await jget('/api/orders/' + encodeURIComponent(orderNo));
    check('the abandoned order is CANCELLED on the board',
      got.status === 200 && got.j && got.j.status === 'cancelled',
      'status=' + got.status + ' order=' + JSON.stringify(got.j));

    /* 5. And it must not sit there looking unpaid-but-live either. */
    check('its payment status is no longer "pending"',
      got.j && got.j.paymentStatus !== 'pending',
      'paymentStatus=' + (got.j && got.j.paymentStatus));

    console.log('\n--- server log (tail) ---');
    console.log(log.split('\n').slice(-12).join('\n'));
  } catch (e) {
    check('probe ran to completion', false, e.message);
    console.log('\n--- server log ---\n' + log);
  } finally {
    if (sessionId) {
      try {
        const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + sessionId + '/expire', {
          method: 'POST', headers: { Authorization: 'Bearer ' + KEY }
        });
        console.log('\ncleanup: expire ' + sessionId + ' → HTTP ' + r.status +
          (r.status === 400 ? ' (already completed — nothing to clean up)' : ''));
      } catch (e) { console.log('\ncleanup: could not expire ' + sessionId); }
    }
    try { server.kill(); } catch (e) {}
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    await sleep(300);
    console.log('scratch order files removed (the shop\'s board was never touched)');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
