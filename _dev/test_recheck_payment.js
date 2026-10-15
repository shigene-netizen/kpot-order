#!/usr/bin/env node
/* Can staff settle a paid order the guest never confirmed?

   THE BUG THIS EXISTS FOR
   -----------------------
   An order is recorded on the board before the guest is handed to Stripe, and
   the Stripe session id is handed to the GUEST'S BROWSER, which keeps it in
   localStorage. The server never sees it. So the board only learns "paid" when
   the guest's browser comes back from Stripe and calls /api/verify-session.

   If the guest pays and then closes the tab, that call never happens. The money
   is taken, Stripe says "paid", and the board still says the payment is
   unconfirmed — for ever. Staff cannot tell it from an order nobody paid for,
   so they either collect twice or hand food over unsure.

   A real order did exactly this (KP-261007-001: $13.77, cs_live_…, paid on
   Stripe, stuck unconfirmed on the board). That is why this exists.

   THE FIX
   -------
   POST /api/orders/:id/recheck-payment  (admin-gated)
   looks the session up SERVER-SIDE by the order number we put in
   client_reference_id, asks Stripe what happened, and settles the board from
   Stripe's own answer. A human presses it; nothing is trusted from the caller.

   WHAT THIS TEST PROVES
   ---------------------
   Against the REAL server, with a stub standing in for api.stripe.com (so it
   runs with no key and no network), it checks the settlement, the auth, the
   lookup strategy, and — most importantly — the failure mode that would be
   WORSE than the bug: a lookup that finds nothing must NOT cancel the order.

   Hermetic: every file the server writes goes to a scratch dir. The shop's own
   orders.local.json is never opened.

   Usage:  node _dev/test_recheck_payment.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8951', 10);
const STUB_PORT = parseInt(process.env.STRIPE_STUB_PORT || '8952', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const STUB_BASE = 'http://127.0.0.1:' + STUB_PORT;
const STRIPE_BASE = STUB_BASE + '/v1/checkout/sessions';

/* Deliberately NOT the shop's real keys: a security test that reads the owner's
   live credential file is both unsafe and unreproducible. The sk_test_ prefix
   also means the server logs "test mode", which we assert. */
const ADMIN_KEY = 'test-admin-key-recheck';
const PRINT_KEY = 'test-print-key-recheck';
const SECRET_KEY = 'sk_test_recheck_not_a_real_key';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-recheck-'));
const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');
const SECRETS_FILE = path.join(SCRATCH, 'secrets.local.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n' + t); }

/* -------------------------------------------------------------------------- */
/* Stub Stripe                                                                 */
/* -------------------------------------------------------------------------- */
/* Stands in for api.stripe.com so the lookup can be driven deterministically —
   including the cases that are hard to produce against real Stripe: a session
   outside the time window, two sessions for one order, a 500. */

let sessions = [];          // {id, client_reference_id, payment_status, status, created}
let stubFail = false;       // make every call return 500
let stubPageSize = 100;     // force the server to page
let calls = [];             // {path, auth, limit, startingAfter}

function stubSession(id, orderId, paymentStatus, createdOffsetSec) {
  return {
    id: id,
    object: 'checkout.session',
    client_reference_id: orderId,
    payment_status: paymentStatus,
    status: paymentStatus === 'paid' ? 'complete' : 'open',
    amount_total: 1695,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000) + (createdOffsetSec || 0)
  };
}

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  calls.push({
    path: u.pathname,
    auth: String(req.headers.authorization || ''),
    limit: u.searchParams.get('limit'),
    startingAfter: u.searchParams.get('starting_after')
  });

  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (stubFail) return send(500, { error: { message: 'stub upstream failure' } });

  const LIST = '/v1/checkout/sessions';
  if (u.pathname === LIST) {
    /* Stripe returns newest first. */
    let rows = sessions.slice().sort((a, b) => b.created - a.created);
    const gte = parseInt(u.searchParams.get('created[gte]') || '0', 10);
    const lte = parseInt(u.searchParams.get('created[lte]') || '0', 10);
    if (gte) rows = rows.filter((s) => s.created >= gte);
    if (lte) rows = rows.filter((s) => s.created <= lte);
    const after = u.searchParams.get('starting_after');
    if (after) {
      const i = rows.findIndex((s) => s.id === after);
      rows = i >= 0 ? rows.slice(i + 1) : [];
    }
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '100', 10), stubPageSize);
    const page = rows.slice(0, limit);
    return send(200, { object: 'list', data: page, has_more: rows.length > limit });
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
/* Seeded board                                                                */
/* -------------------------------------------------------------------------- */

function mkOrder(id, over) {
  const now = new Date().toISOString();
  return Object.assign({
    id: id,
    at: now,
    updatedAt: now,
    status: 'received',
    orderType: 'pickup',
    table: '',
    payMethod: 'stripe',
    paymentStatus: 'pending',
    paid: false,
    customer: { name: 'Recheck Probe', phone: '', when: 'ASAP' },
    items: [{ name: 'Hot Pot To Go', qty: 1, unit: 15.99, mods: [], addons: [] }],
    subtotal: 15.99, deliveryFee: 0, tax: 0.96, tip: 0, surcharge: 0, total: 16.95,
    source: 'recheck-test'
  }, over || {});
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* -------------------------------------------------------------------------- */

const jpost = (p, key, body) => fetch(BASE + p, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { 'x-admin-key': key } : {}),
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

const jget = (p, key) => fetch(BASE + p, { headers: key ? { 'x-admin-key': key } : {} })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

let server = null;

async function main() {
  console.log('payment re-check — can staff settle an order the guest never confirmed?');
  console.log('='.repeat(76));

  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

  /* Sessions are created relative to NOW so they fall inside the ±6h window the
     lookup searches. One is deliberately 3 days old to prove the window is
     actually applied (see the "outside the window" case). */
  sessions = [
    stubSession('cs_test_paid_1', 'KP-RC-PAID', 'paid', -120),
    stubSession('cs_test_completed_1', 'KP-RC-COMPLETED', 'paid', -90),
    stubSession('cs_test_unpaid_1', 'KP-RC-UNPAID', 'unpaid', -60),
    stubSession('cs_test_old_1', 'KP-RC-OLD', 'paid', -3 * 24 * 3600),
    /* Two sessions for one order: the guest retried. The PAID one is OLDER, so a
       "newest wins" implementation would pick the unpaid one and wrongly report
       the order as unpaid. */
    stubSession('cs_test_multi_unpaid', 'KP-RC-MULTI', 'unpaid', -30),
    stubSession('cs_test_multi_paid', 'KP-RC-MULTI', 'paid', -300),
    stubSession('cs_test_cancel_paid', 'KP-RC-CANCELLED', 'paid', -200),
    /* The guest walked away and came back later, so this session was created
       HOURS after the order. A window that stopped 6h after the order would
       miss it and report the order unpaid — see the "late retry" case below. */
    stubSession('cs_test_late_paid', 'KP-RC-LATE', 'paid', +8 * 3600)
  ];

  fs.writeFileSync(ORDERS_FILE, JSON.stringify([
    mkOrder('KP-RC-PAID'),
    mkOrder('KP-RC-COMPLETED', { status: 'completed' }),
    mkOrder('KP-RC-UNPAID'),
    mkOrder('KP-RC-NOSESSION'),
    mkOrder('KP-RC-OLD'),
    mkOrder('KP-RC-MULTI'),
    mkOrder('KP-RC-CANCELLED', { status: 'cancelled', paymentStatus: 'unpaid' }),
    mkOrder('KP-RC-LATE'),
    mkOrder('KP-RC-COUNTER', { payMethod: 'counter', paymentStatus: 'counter' })
  ], null, 2));

  fs.writeFileSync(SECRETS_FILE, JSON.stringify({
    stripeSecretKey: SECRET_KEY, adminKey: ADMIN_KEY, printKey: PRINT_KEY
  }, null, 2));

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      /* The seam under test: without it this suite would talk to real Stripe. */
      KPOT_STRIPE_API_BASE: STRIPE_BASE,
      /* Scratch everything — this suite writes orders, so it must not write them
         into the shop's board. */
      KPOT_ORDERS_FILE: ORDERS_FILE,
      KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS_FILE), 'customers.local.json'),
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      KPOT_SECRETS_FILE: SECRETS_FILE,
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
      /* Clear any inherited key so the scratch secrets file is what is used —
         an empty STRIPE_SECRET_KEY falls through to the file, but a real one
         inherited from the shell would silently override it. */
      STRIPE_SECRET_KEY: '',
      ADMIN_KEY: '',
      PRINT_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });

  try {
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { const j = await r.json(); if (j && j.checkout !== undefined) { health = j; break; } }
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }
    if (!health) throw new Error('server never became healthy');

    /* ---- boot hygiene ---------------------------------------------------- */
    section('boot');
    check('the server booted against the stub, not api.stripe.com',
      log.indexOf('api.stripe.com') === -1, 'log mentions api.stripe.com');
    check('the redirect is announced loudly (so it can never be silent)',
      /WARNING: Stripe API redirected/.test(log), 'no redirect warning in the boot log');
    check('the test key is reported as test mode, not live',
      health.keyMode === 'test' && !/\blive\b/.test(log),
      'keyMode=' + health.keyMode + ' logHasLive=' + /\blive\b/.test(log));

    /* ---- auth ------------------------------------------------------------ */
    section('auth — re-checking payment is a staff action');
    const noKey = await jpost('/api/orders/KP-RC-PAID/recheck-payment', null);
    check('no key is refused with 401', noKey.status === 401,
      'status=' + noKey.status + ' body=' + JSON.stringify(noKey.j));

    const printKeyTry = await jpost('/api/orders/KP-RC-PAID/recheck-payment', PRINT_KEY);
    check('the PRINT key is refused (it may fetch jobs, not settle money)',
      printKeyTry.status === 401,
      'status=' + printKeyTry.status + ' body=' + JSON.stringify(printKeyTry.j));

    const getTry = await jget('/api/orders/KP-RC-PAID/recheck-payment', ADMIN_KEY);
    check('GET is refused with 405', getTry.status === 405,
      'status=' + getTry.status);

    /* ---- the main case --------------------------------------------------- */
    section('a paid order the guest never confirmed');
    const missing = await jpost('/api/orders/KP-RC-NOPE/recheck-payment', ADMIN_KEY);
    check('an unknown order is 404', missing.status === 404,
      'status=' + missing.status + ' body=' + JSON.stringify(missing.j));

    const counter = await jpost('/api/orders/KP-RC-COUNTER/recheck-payment', ADMIN_KEY);
    check('a pay-at-counter order is refused as not-a-card-order',
      counter.status === 400 && counter.j && counter.j.error === 'not_a_card_order',
      'status=' + counter.status + ' body=' + JSON.stringify(counter.j));

    const paid = await jpost('/api/orders/KP-RC-PAID/recheck-payment', ADMIN_KEY);
    check('the paid order settles: ok + paid + the session id',
      paid.status === 200 && paid.j && paid.j.ok === true && paid.j.paid === true &&
        paid.j.sessionId === 'cs_test_paid_1',
      'status=' + paid.status + ' body=' + JSON.stringify(paid.j));

    const after = await jget('/api/orders/KP-RC-PAID', ADMIN_KEY);
    check('the BOARD now shows it as verified (this is what the badge reads)',
      after.j && after.j.paymentStatus === 'verified',
      'paymentStatus=' + (after.j && after.j.paymentStatus));

    const list = await jget('/api/orders', ADMIN_KEY);
    const row = (list.j && list.j.orders || []).find((o) => o.id === 'KP-RC-PAID');
    check('the order list the board polls carries the settled status',
      !!row && row.paymentStatus === 'verified',
      'row=' + JSON.stringify(row && { id: row.id, paymentStatus: row.paymentStatus }));

    /* The user's actual report: a COMPLETED order showing an unconfirmed
       payment. Settling must not disturb the order's own progress. */
    const done = await jpost('/api/orders/KP-RC-COMPLETED/recheck-payment', ADMIN_KEY);
    const doneAfter = await jget('/api/orders/KP-RC-COMPLETED', ADMIN_KEY);
    check('a COMPLETED order settles to paid too',
      done.j && done.j.paid === true && doneAfter.j && doneAfter.j.paymentStatus === 'verified',
      'body=' + JSON.stringify(done.j));
    check('settling payment does NOT move a completed order backwards',
      doneAfter.j && doneAfter.j.status === 'completed',
      'status=' + (doneAfter.j && doneAfter.j.status));

    const again = await jpost('/api/orders/KP-RC-PAID/recheck-payment', ADMIN_KEY);
    check('pressing it twice is safe and gives the same answer',
      again.status === 200 && again.j && again.j.ok === true && again.j.paid === true,
      'status=' + again.status + ' body=' + JSON.stringify(again.j));

    /* ---- the caller is not trusted --------------------------------------- */
    section('the caller cannot assert anything');
    const spoof = await jpost('/api/orders/KP-RC-NOSESSION/recheck-payment', ADMIN_KEY,
      { paid: true, paymentStatus: 'verified', total: 0 });
    check('a body claiming "paid" is ignored — Stripe is the only witness',
      spoof.status === 200 && spoof.j && spoof.j.error === 'session_not_found',
      'status=' + spoof.status + ' body=' + JSON.stringify(spoof.j));

    const spoofAfter = await jget('/api/orders/KP-RC-NOSESSION', ADMIN_KEY);
    check('and that order is left ALONE, not marked paid',
      spoofAfter.j && spoofAfter.j.paymentStatus !== 'verified',
      'paymentStatus=' + (spoofAfter.j && spoofAfter.j.paymentStatus));

    /* ---- the dangerous failure mode -------------------------------------- */
    section('when Stripe has no payment for the order');
    /* THE MOST IMPORTANT ASSERTION HERE. "No session found" is not evidence that
       the guest did not pay — it can equally mean the lookup missed, the window
       was wrong, or Stripe was slow. Cancelling on that would destroy a real
       order. The order must be left exactly as it was, for a human to decide. */
    check('an order with no Stripe session is NOT cancelled',
      spoofAfter.j && spoofAfter.j.status !== 'cancelled',
      'status=' + (spoofAfter.j && spoofAfter.j.status));

    const old = await jpost('/api/orders/KP-RC-OLD/recheck-payment', ADMIN_KEY);
    const oldAfter = await jget('/api/orders/KP-RC-OLD', ADMIN_KEY);
    check('a session outside the search window is not picked up',
      old.j && old.j.error === 'session_not_found',
      'body=' + JSON.stringify(old.j));
    check('and that order is left alone too',
      oldAfter.j && oldAfter.j.status !== 'cancelled' && oldAfter.j.paymentStatus !== 'verified',
      'status=' + (oldAfter.j && oldAfter.j.status) + ' payment=' + (oldAfter.j && oldAfter.j.paymentStatus));

    /* ---- a session that exists but was never completed ------------------- */
    section('a session that exists but was never paid');
    const unpaid = await jpost('/api/orders/KP-RC-UNPAID/recheck-payment', ADMIN_KEY);
    check('Stripe says unpaid: ok, paid=false',
      unpaid.status === 200 && unpaid.j && unpaid.j.ok === true && unpaid.j.paid === false,
      'status=' + unpaid.status + ' body=' + JSON.stringify(unpaid.j));
    const unpaidAfter = await jget('/api/orders/KP-RC-UNPAID', ADMIN_KEY);
    check('the board reflects that: the order is cancelled',
      unpaidAfter.j && unpaidAfter.j.status === 'cancelled',
      'status=' + (unpaidAfter.j && unpaidAfter.j.status));
    check('and it no longer claims to be merely pending',
      unpaidAfter.j && unpaidAfter.j.paymentStatus !== 'pending',
      'paymentStatus=' + (unpaidAfter.j && unpaidAfter.j.paymentStatus));

    /* ---- cancelled, but the guest had actually paid ---------------------- */
    section('cancelled here, but paid on Stripe (a refund is owed)');
    const canc = await jpost('/api/orders/KP-RC-CANCELLED/recheck-payment', ADMIN_KEY);
    const cancAfter = await jget('/api/orders/KP-RC-CANCELLED', ADMIN_KEY);
    check('the re-check reveals the payment',
      canc.j && canc.j.paid === true,
      'body=' + JSON.stringify(canc.j));
    check('the order stays cancelled — re-checking must not resurrect it',
      cancAfter.j && cancAfter.j.status === 'cancelled',
      'status=' + (cancAfter.j && cancAfter.j.status));
    check('but it is now visibly paid, which is the refund signal',
      cancAfter.j && cancAfter.j.paymentStatus === 'verified',
      'paymentStatus=' + (cancAfter.j && cancAfter.j.paymentStatus));

    /* ---- a retry that happened long after the order ---------------------- */
    section('the guest came back hours later and paid then');
    /* The order was recorded first, so the session is always created after it.
       A retry creates a SECOND session, hours later. A window that ended too
       soon after the order would find neither and report the order unpaid —
       telling staff not to hand over food the guest had already paid for. */
    const late = await jpost('/api/orders/KP-RC-LATE/recheck-payment', ADMIN_KEY);
    check('a session created 8h after the order is still found',
      late.j && late.j.ok === true && late.j.paid === true &&
        late.j.sessionId === 'cs_test_late_paid',
      'body=' + JSON.stringify(late.j));
    const lateAfter = await jget('/api/orders/KP-RC-LATE', ADMIN_KEY);
    check('and the board settles to verified',
      lateAfter.j && lateAfter.j.paymentStatus === 'verified',
      'paymentStatus=' + (lateAfter.j && lateAfter.j.paymentStatus));

    /* ---- picking the right session --------------------------------------- */
    section('an order with more than one session');
    const multi = await jpost('/api/orders/KP-RC-MULTI/recheck-payment', ADMIN_KEY);
    check('the PAID session wins even though the unpaid one is newer',
      multi.j && multi.j.sessionId === 'cs_test_multi_paid' && multi.j.paid === true,
      'body=' + JSON.stringify(multi.j));

    /* ---- paging ---------------------------------------------------------- */
    section('the lookup pages rather than giving up on page one');
    /* Force tiny pages so the matching session cannot be on the first one. */
    calls = [];
    stubPageSize = 2;
    const paged = await jpost('/api/orders/KP-RC-PAID/recheck-payment', ADMIN_KEY);
    const listCalls = calls.filter((c) => c.path === '/v1/checkout/sessions');
    stubPageSize = 100;
    check('it still finds the session when the first page is too small',
      paged.j && paged.j.paid === true && paged.j.sessionId === 'cs_test_paid_1',
      'body=' + JSON.stringify(paged.j));
    check('by following starting_after to the next page',
      listCalls.length >= 2 && listCalls.some((c) => c.startingAfter),
      'list calls=' + listCalls.length + ' ' + JSON.stringify(listCalls.map((c) => c.startingAfter)));

    /* ---- the key really is used ------------------------------------------ */
    section('the request to Stripe');
    const authed = calls.length ? calls[calls.length - 1] : null;
    check('every call carries the configured secret key as a Bearer token',
      !!authed && authed.auth === 'Bearer ' + SECRET_KEY,
      'auth=' + (authed && authed.auth.replace(/(Bearer \w{8}).*/, '$1…')));

    /* ---- Stripe being broken -------------------------------------------- */
    section('when Stripe itself fails');
    stubFail = true;
    const broken = await jpost('/api/orders/KP-RC-PAID/recheck-payment', ADMIN_KEY);
    stubFail = false;
    check('a Stripe 500 surfaces as 502 stripe_error, not a false verdict',
      broken.status === 502 && broken.j && broken.j.error === 'stripe_error',
      'status=' + broken.status + ' body=' + JSON.stringify(broken.j));
    const brokenAfter = await jget('/api/orders/KP-RC-PAID', ADMIN_KEY);
    check('and the already-settled order is not damaged by it',
      brokenAfter.j && brokenAfter.j.paymentStatus === 'verified',
      'paymentStatus=' + (brokenAfter.j && brokenAfter.j.paymentStatus));

    const never = await jpost('/api/orders/KP-RC-NOSESSION/recheck-payment', ADMIN_KEY);
    const neverAfter = await jget('/api/orders/KP-RC-NOSESSION', ADMIN_KEY);
    check('a broken Stripe lookup does not cancel the order either',
      neverAfter.j && neverAfter.j.status !== 'cancelled',
      'status=' + (neverAfter.j && neverAfter.j.status) + ' body=' + JSON.stringify(never.j));

    console.log('\n--- server log (tail) ---');
    console.log(log.split('\n').filter(Boolean).slice(-10).join('\n'));
  } catch (e) {
    check('suite ran to completion', false, e.stack || e.message);
    console.log('\n--- server log ---\n' + log);
  } finally {
    if (server) { try { server.kill(); } catch (e) {} }
    try { stub.close(); } catch (e) {}
    await sleep(200);
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    console.log('\nscratch files removed — the shop\'s own orders.local.json was never touched');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
