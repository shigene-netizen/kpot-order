#!/usr/bin/env node
/* ==========================================================================
   KPOT To Go — REAL test-mode Stripe end-to-end
   --------------------------------------------------------------------------
   The other suites each cover a slice. This one covers the whole seam that
   actually moves money, against the REAL Stripe API in TEST mode:

     1. boot the real server.js with a TEST secret key
     2. drive the real storefront in a real browser: build cart -> checkout ->
        Pay Online -> Place Order
     3. the app POSTs /api/checkout; the SERVER creates a real Stripe session
     4. the browser lands on Stripe's hosted Checkout, we pay with the
        test card 4242 4242 4242 4242
     5. Stripe bounces us back to /?paid=1
     6. the app calls /api/verify-session -> the SERVER asks Stripe
     7. the board must flip pending -> verified

   What this proves that nothing else does:
     * the real Stripe session is created with the right amount (inline pricing)
     * Stripe accepts the session and renders a card form
     * the return leg really verifies against Stripe (not just "?paid=1")
     * the order on the owner's board ends up 'verified', not stuck 'pending'

   What it does NOT prove: that money reaches the bank. That is Stripe's job,
   and it is what the live-key smoke run is for.

   ---------------------------------------------------------------------------
   SAFETY — read before running
   ---------------------------------------------------------------------------
   * It refuses to run unless the key is a TEST key (sk_test_/rk_test_).
     Set ALLOW_LIVE=1 to override — that spends REAL money.
   * It backs up orders.local.json and restores it on the way out, so the
     owner's board is left exactly as it was found.
   * Every test order it creates is tagged with source 'e2e-stripe' so it can
     be identified and removed.
   * If the run dies between "session created" and "payment made", the
     session is left OPEN in the Stripe Dashboard. The id is printed so it
     can be expired by hand. Nothing is charged either way.

   ---------------------------------------------------------------------------
   USAGE
   ---------------------------------------------------------------------------
     # full run (needs a test key)
     STRIPE_SECRET_KEY=sk_test_xxx node _dev/e2e_real_stripe.js

     # key kept in a file instead of the shell history
     KPOT_KEY_FILE=/d/kpot-test-key.txt node _dev/e2e_real_stripe.js

     # harness smoke — no key needed, makes NO Stripe call. Boots the server,
     # drives the app to the checkout sheet and stops before Place Order.
     PREFLIGHT_ONLY=1 node _dev/e2e_real_stripe.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8939', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9361', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = path.join(__dirname, 'screens');
const ORDERS_FILE = path.join(ROOT, 'orders.local.json');
/* The loyalty ledger gets the same treatment: this suite deliberately runs
   against the real files (it is the money path), so both are backed up and
   restored. Without KPOT_CUSTOMERS_FILE the server would write awards into the
   shop's live member list. */
const CUSTOMERS_FILE = path.join(ROOT, 'customers.local.json');
const PREFLIGHT_ONLY = process.env.PREFLIGHT_ONLY === '1';
const ALLOW_LIVE = process.env.ALLOW_LIVE === '1';

/* The test card. In TEST mode Stripe accepts this without a real account
   behind it; in LIVE mode Stripe rejects it outright, which is exactly how
   the key-mode guard below earns its keep. */
const TEST_CARD = { number: '4242 4242 4242 4242', expiry: '12 / 34', cvc: '123' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ report */
let pass = 0, fail = 0;
const notes = [];
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function note(s) { notes.push(s); }

/* ------------------------------------------------------- key resolution */
function resolveKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  const f = process.env.KPOT_KEY_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
function adminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.local.json'), 'utf8')).adminKey || ''; }
  catch (e) { return ''; }
}
const KEY_RE = /^(?:sk|rk)_(live|test)_/;

/* ------------------------------------------------------------------- CDP */
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + ((d.exception && d.exception.description) || d.text));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  /* A navigation tears the execution context out from under a pending
     evaluate, so the transport call is retried. Interpretation of in-page
     errors happens ABOVE this layer — a genuine bug must not be retried
     into a false pass. */
  async function rawEval(expression) {
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try { return await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
      catch (e) { lastErr = e; await sleep(400); }
    }
    throw lastErr;
  }

  async function evalJs(expression) {
    const r = await rawEval(expression);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
      throw new Error('IN-PAGE ERROR: ' + String(desc).split('\n')[0]);
    }
    if (!r.result) return undefined;
    return r.result.value !== undefined ? r.result.value : r.result.description;
  }

  async function waitFor(expr, timeoutMs, label) {
    const until = Date.now() + timeoutMs;
    let last;
    let lastErr = null;
    while (Date.now() < until) {
      /* An expression that THROWS has NOT succeeded — it nearly always means
         the element it reads is not in the DOM yet, which is the whole point
         of waiting. Turning the error into a truthy string made waitFor
         return early on a condition that was never met. Keep polling; the
         error is reported only if we genuinely time out. */
      try { last = await evalJs(expr); lastErr = null; }
      catch (e) { last = null; lastErr = e.message; }
      if (last) return last;
      await sleep(400);
    }
    throw new Error('timed out waiting for ' + label + ' — last value: ' + JSON.stringify(last) +
      (lastErr ? ' (last error: ' + lastErr + ')' : ''));
  }

  async function shot(name) {
    try {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64'));
      return true;
    } catch (e) { return false; }
  }

  return { ws, send, evalJs, waitFor, shot, logs };
}

/* ========================================================================= */
async function main() {
  /* ---------------------------------------------------- preflight checks */
  console.log('KPOT To Go — real test-mode Stripe end-to-end' + (PREFLIGHT_ONLY ? '  [PREFLIGHT ONLY]' : ''));
  console.log('='.repeat(72));

  const key = resolveKey();
  const mode = key ? (KEY_RE.exec(key) || [])[1] : '';

  if (PREFLIGHT_ONLY) {
    console.log('preflight mode: no Stripe call will be made, no key required\n');
  } else {
    if (!key) {
      console.log('\nNo Stripe key.\n');
      console.log('Pass one of:');
      console.log('  STRIPE_SECRET_KEY=sk_test_... node _dev/e2e_real_stripe.js');
      console.log('  KPOT_KEY_FILE=/d/kpot-test-key.txt node _dev/e2e_real_stripe.js');
      console.log('\nOr smoke the harness with no key at all:');
      console.log('  PREFLIGHT_ONLY=1 node _dev/e2e_real_stripe.js');
      process.exit(2);
    }
    check('key looks like a Stripe secret key', !!mode, 'mode=' + (mode || 'unrecognised'));
    if (!mode) process.exit(2);
    if (mode === 'live' && !ALLOW_LIVE) {
      console.log('\nREFUSING TO RUN: this is a LIVE key and the test card 4242… would be');
      console.log('rejected by Stripe — and if it were not, this would spend real money.');
      console.log('Use a test key, or set ALLOW_LIVE=1 if you really mean it.');
      process.exit(2);
    }
    if (mode === 'live') console.log('\n!! ALLOW_LIVE=1 — this run can spend REAL money !!\n');
    else console.log('key mode: test  (' + key.slice(0, 12) + '…)\n');
  }

  /* -------------------------------------------------------- backup orders */
  const hadOrders = fs.existsSync(ORDERS_FILE);
  const ordersBackup = hadOrders ? fs.readFileSync(ORDERS_FILE) : null;
  const ordersBytes = hadOrders ? ordersBackup.length : 0;
  console.log('orders.local.json backed up (' + ordersBytes + ' bytes)');
  const hadCustomers = fs.existsSync(CUSTOMERS_FILE);
  const customersBackup = hadCustomers ? fs.readFileSync(CUSTOMERS_FILE) : null;
  console.log('customers.local.json backed up (' +
    (hadCustomers ? customersBackup.length : 0) + ' bytes)');

  /* ---------------------------------------------------------- boot server */
  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  env.KPOT_ORDERS_FILE = ORDERS_FILE;
  env.KPOT_CUSTOMERS_FILE = CUSTOMERS_FILE;
  /* The store-hours tick SAVES store status on every open/close transition —
     without this pin a suite run after closing time rewrites the shop's own
     switches. */
  env.KPOT_STORE_FILE = path.join(path.dirname(ORDERS_FILE), 'store.local.json');
  /* Env wins over secrets.local.json in server.js, so the live key on disk is
     never touched by this run. In preflight we deliberately inject a BOGUS
     test key rather than letting the server fall back to the real one: the
     app then still offers Pay Online (so the preflight assertions are
     meaningful), but if anything ever did reach Stripe it would get a 401
     instead of creating a payable session on the live account. */
  env.STRIPE_SECRET_KEY = PREFLIGHT_ONLY ? 'sk_test_preflight_not_a_real_key' : key;
  env.STRIPE_ENABLED = '1';
  /* 24h hours spec: this drives a real browser through a cart, and the
     business-hours tick would close the shop under it after closing time.
     See hoursSpec() in server.js. */
  env.KPOT_HOURS_SPEC = '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  let chrome = null;
  let cdp = null;
  let sessionId = null;
  let orderNo = null;

  const cleanup = () => {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) {}
    try { if (chrome) chrome.kill(); } catch (e) {}
    try { server.kill(); } catch (e) {}
  };

  const restore = () => {
    try {
      if (hadOrders) fs.writeFileSync(ORDERS_FILE, ordersBackup);
      else if (fs.existsSync(ORDERS_FILE)) fs.unlinkSync(ORDERS_FILE);
      if (hadCustomers) fs.writeFileSync(CUSTOMERS_FILE, customersBackup);
      else if (fs.existsSync(CUSTOMERS_FILE)) fs.unlinkSync(CUSTOMERS_FILE);
    } catch (e) { console.log('  WARN  could not restore the shop data: ' + e.message); }
  };

  /* --------------------------------------------------- wait for the server */
  let health = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) { const j = await r.json(); if (j && j.checkout) { health = j; break; } }
    } catch (e) {}
    await sleep(250);
  }
  if (!health) {
    console.log('  FAIL  server never became healthy');
    console.log(serverLog);
    cleanup(); restore();
    process.exit(1);
  }
  console.log('server up on ' + BASE + '  keyMode=' + health.keyMode + '\n');

  if (!PREFLIGHT_ONLY) {
    check('server reports the key mode we asked for',
      health.keyMode === mode, 'server says keyMode=' + health.keyMode + ', we passed ' + mode);
  }

  /* --------------------------------------------------------- boot chrome */
  const profile = path.join(os.tmpdir(), 'kpot-e2e-' + Date.now());
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--window-size=430,932', 'about:blank'
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      list = await r.json();
      if (list && list.some((t) => t.type === 'page')) break;
    } catch (e) {}
  }
  if (!list) { console.log('  FAIL  Chrome did not start'); cleanup(); restore(); process.exit(1); }

  const target = list.find((t) => t.type === 'page');
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await new Promise((r) => cdp.ws.addEventListener('open', r));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* Seed a small cart on every new document of OUR origin only. One bowl is
     $16.95 — under the $30 counter ceiling, so the default-online behaviour
     is what we are testing, not the ceiling.

     CRITICAL: skip the seed on a payment-return URL. This script runs on
     EVERY new document, including the one Stripe bounces the guest back to.
     Clearing kpot.pending.v1 there would delete the very order
     handlePaymentReturn is about to read — the guest would land on an empty
     menu, no verification would run, and the board would stay stuck on
     'pending'. (That is exactly what happened before this guard existed.) */
  const seed = `
    try {
      var onOurOrigin = (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
      var isPaymentReturn = /[?&](paid|canceled)=/.test(location.search);
      if (onOurOrigin && !isPaymentReturn) {
        localStorage.setItem('kpot.cart.v1', JSON.stringify([
          { uid: 'e2e-1', qty: 1, name: 'Hot Pot To Go', unit: 15.99, kind: 'hotpot',
            mods: [], addons: [], note: '', sig: '["Hot Pot To Go",[],[]]' }
        ]));
        localStorage.removeItem('kpot.last.v1');
        localStorage.removeItem('kpot.history.v1');
        localStorage.removeItem('kpot.pending.v1');
      }
    } catch (e) {}
  `;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });

  try {
    /* ============================ PHASE 1 — place the order ============= */
    console.log('--- PHASE 1 — storefront: cart -> checkout -> Pay Online ---');
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);

    const leg1 = await cdp.evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};

      const cartBtn = document.querySelector('#cartBtn');
      if (!cartBtn) return { fatal: 'no #cartBtn — the app did not boot' };
      cartBtn.click();
      await sleep(500);
      out.cartTotal = (document.querySelector('#sheetFoot .total b')?.textContent || '').trim();

      const toCheckout = document.querySelector('#toCheckout');
      if (!toCheckout) return { ...out, fatal: 'no #toCheckout' };
      toCheckout.click();
      await sleep(600);

      out.payOptions = Array.from(document.querySelectorAll('#sheetBody [data-pay]')).map(b => b.dataset.pay);
      const preselected = document.querySelector('#sheetBody [data-pay].on');
      out.preselected = preselected ? preselected.dataset.pay : null;
      out.counterDisabled = !!document.querySelector('#sheetBody [data-pay="counter"][disabled]');

      const name = document.querySelector('#cName');
      const phone = document.querySelector('#cPhone');
      if (name) { name.value = 'E2E Test'; name.dispatchEvent(new Event('input', { bubbles: true })); }
      if (phone) { phone.value = '4045550142'; phone.dispatchEvent(new Event('input', { bubbles: true })); }

      const stripeBtn = document.querySelector('#sheetBody [data-pay="stripe"]');
      if (!stripeBtn) return { ...out, fatal: 'Pay Online was not offered' };
      stripeBtn.click();
      await sleep(300);
      out.afterClickStripe = document.querySelector('#sheetBody [data-pay].on')?.dataset.pay || null;
      out.stripeNote = (document.querySelector('#stripeBox')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

      const place = document.querySelector('#placeOrder');
      if (!place) return { ...out, fatal: 'no #placeOrder' };
      out.placeLabel = place.textContent.trim();

      /* Click and return IMMEDIATELY — the handler navigates to Stripe, which
         destroys this execution context. Anything awaited after this point
         would be lost. */
      place.click();
      return out;
    })()`);

    console.log('  ' + JSON.stringify(leg1));
    await cdp.shot('e2e-01-checkout.png');

    /* These four are key-independent, so they run in preflight too — that is
       what makes the preflight a real test rather than a smoke. */
    check('the app booted and the cart seeded', !leg1.fatal, leg1.fatal || 'ok');
    check('Pay Online is offered to the guest',
      Array.isArray(leg1.payOptions) && leg1.payOptions.includes('stripe'),
      'options=' + JSON.stringify(leg1.payOptions));
    check('Pay Online is PRE-SELECTED by default (the no-show nudge)',
      leg1.preselected === 'stripe', 'preselected=' + leg1.preselected);
    check('Pay at Counter is NOT disabled on a $16.95 cart (under the cap)',
      leg1.counterDisabled === false, 'counterDisabled=' + leg1.counterDisabled);

    if (PREFLIGHT_ONLY) {
      console.log('\n  preflight: stopping before Place Order — no Stripe session created.');
      console.log('  ' + pass + ' passed, ' + fail + ' failed');
      cleanup(); restore();
      process.exit(fail ? 1 : 0);
    }

    /* ---- wait for the hand-off to Stripe ---- */
    console.log('\n--- PHASE 2 — hand-off to Stripe ---');
    /* Match on "we left our own origin" rather than on a hardcoded Stripe
       hostname — Stripe owns that host and has moved it before. */
    let stripeUrl;
    try {
      stripeUrl = await cdp.waitFor(
        `location.hostname !== '127.0.0.1' && location.hostname !== 'localhost' && location.href`,
        60000, 'navigation away from the app (to Stripe)');
    } catch (e) {
      check('the app redirected to Stripe', false, e.message);
      console.log('\n--- server log ---\n' + serverLog);
      throw e;
    }
    /* The server log is the authoritative source for the session id — the
       Stripe URL format is theirs to change. */
    sessionId = (/\[kpot\] session created (cs_\w+)/.exec(serverLog) || [])[1] ||
      (/(cs_(?:test|live)_[A-Za-z0-9]+)/.exec(stripeUrl) || [])[1] || null;
    check('the app redirected to Stripe hosted Checkout',
      /stripe\.com/.test(stripeUrl), stripeUrl.slice(0, 80) + '…');
    check('the session id is a test-mode session',
      !!sessionId && sessionId.startsWith('cs_test_'), 'sessionId=' + sessionId);
    note('Stripe session: ' + sessionId + '  (if the run aborts, expire it in the Dashboard)');

    /* The order must already be on the board, and still UNPAID. This is the
       property the whole counter-cap discussion was about: an order can reach
       the kitchen before the money does. */
    const board1 = await fetch(BASE + '/api/orders', { headers: { 'X-Admin-Key': adminKey() } })
      .then((r) => r.json()).catch(() => null);
    const pending = board1 && (board1.orders || []).find((o) => o.source === 'storefront');
    check('the order is on the board BEFORE payment, marked pending',
      !!pending && pending.paymentStatus === 'pending',
      pending ? ('order ' + pending.id + ' paymentStatus=' + pending.paymentStatus) : 'no order found');
    if (pending) orderNo = pending.id;

    /* ---- fill Stripe's card form ---- */
    console.log('\n--- PHASE 3 — pay with the test card ---');
    await sleep(4000);
    await cdp.shot('e2e-02-stripe-landing.png');

    const leg2 = await cdp.evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};

      /* Stripe renders its form with React, which ignores a plain
         'el.value = x'. Go through the native setter so React's onChange
         actually fires. */
      const setNative = (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      const email = document.querySelector('#email') || document.querySelector('input[type="email"]');
      if (email) { email.focus(); setNative(email, 'e2e@example.com'); out.email = true; }
      await sleep(800);

      /* The card fields live in the MAIN frame, hidden until the guest picks
         "Pay with card". (Verified by _dev/inspect_stripe_checkout.js — this
         is NOT the old iframe-based Stripe form.) */
      let revealed = !!document.querySelector('#cardNumber');
      if (!revealed) {
        const b = document.querySelector('[aria-label="Pay with card"]') ||
          Array.from(document.querySelectorAll('button')).find(x => /pay with card/i.test(x.textContent || ''));
        if (b) { b.click(); out.clickedCard = true; }
        await sleep(4000);
      }
      revealed = !!document.querySelector('#cardNumber');
      out.cardFormVisible = revealed;
      if (!revealed) {
        out.foundInputs = Array.from(document.querySelectorAll('input')).map(i => i.id || i.name || i.type).slice(0, 20);
        return out;
      }

      setNative(document.querySelector('#cardNumber'), ${JSON.stringify(TEST_CARD.number)});
      await sleep(400);
      const exp = document.querySelector('#cardExpiry');
      if (exp) setNative(exp, ${JSON.stringify(TEST_CARD.expiry)});
      await sleep(400);
      const cvc = document.querySelector('#cardCvc');
      if (cvc) setNative(cvc, ${JSON.stringify(TEST_CARD.cvc)});
      await sleep(400);

      const bn = document.querySelector('#billingName');
      if (bn) setNative(bn, 'E2E Test');
      const pc = document.querySelector('#billingPostalCode');
      if (pc) setNative(pc, '30339');
      /* Stripe's checkout asks for a phone number and REQUIRES it. Leaving it
         blank makes the submit do nothing at all — no error, no navigation,
         just a bare "Required" alert further up the page. That silence is what
         made the first two runs time out with no explanation. */
      const ph = document.querySelector('#phoneNumber');
      if (ph) setNative(ph, '4045550142');
      await sleep(900);

      /* Prove the values actually landed. A React form that ignores our
         synthetic events would leave these empty and the payment would fail
         for a reason that looks nothing like the real cause.
         A null result means the FIELD IS NOT ON THE PAGE — Stripe renders the
         phone field only sometimes, so "absent" must not read as "empty".
         (No backticks in here: this whole block is itself a template literal.) */
      const val = (s) => { const el = document.querySelector(s); return el ? (el.value || '') : null; };
      const digits = (s) => { const v = val(s); return v === null ? null : String(v).replace(/\\D/g, '').length; };
      out.phoneFieldPresent = !!document.querySelector('#phoneNumber');
      out.filled = {
        cardNumber: digits('#cardNumber'),
        cardExpiry: val('#cardExpiry'),
        cardCvc: digits('#cardCvc'),
        billingName: val('#billingName'),
        billingPostalCode: val('#billingPostalCode'),
        phoneNumber: out.phoneFieldPresent ? val('#phoneNumber') : '(field not rendered)'
      };

      /* Stripe nests a visually-hidden "Processing" span inside the submit
         button, so its textContent reads "PayProcessing" — matching on
         /^pay(\\s|$)/ misses it. Prefer the stable test id, then a
         starts-with match. */
      const byTestId = document.querySelector('[data-testid="hosted-payment-submit-button"]');
      const byText = Array.from(document.querySelectorAll('button')).find(b =>
        /^pay/i.test((b.textContent || '').trim()) && !b.disabled);
      const pay = (byTestId && !byTestId.disabled) ? byTestId : byText;

      out.payButton = pay ? (pay.textContent || '').trim() : null;
      out.payVia = pay ? (pay === byTestId ? 'data-testid' : 'text') : null;
      if (!pay) {
        out.buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).slice(0, 20);
        return out;
      }
      pay.click();
      return out;
    })()`);

    console.log('  ' + JSON.stringify(leg2));
    await cdp.shot('e2e-03-stripe-filled.png');
    check('Stripe rendered the card form', leg2.cardFormVisible === true,
      leg2.cardFormVisible ? 'ok' : 'inputs seen: ' + JSON.stringify(leg2.foundInputs));
    check('every field Stripe asks for really took its value (React accepted our input)',
      !!leg2.filled && leg2.filled.cardNumber === 16 && leg2.filled.cardCvc === 3 &&
      !!leg2.filled.billingName &&
      (!leg2.phoneFieldPresent || !!leg2.filled.phoneNumber),
      JSON.stringify(leg2.filled) + ' phoneFieldPresent=' + leg2.phoneFieldPresent);
    check('the Pay button was found and clicked', !!leg2.payButton,
      'label=' + leg2.payButton + ' via=' + leg2.payVia +
      (leg2.payButton ? '' : ' buttons=' + JSON.stringify(leg2.buttons)));

    /* ---- wait for the return leg ---- */
    console.log('\n--- PHASE 4 — return leg + real verification ---');
    try {
      await cdp.waitFor(
        `location.hostname === '127.0.0.1' && location.href`,
        90000, 'return to the app');
    } catch (e) {
      /* We are still sitting on Stripe. Whatever it is complaining about is
         on screen — grab it, because a bare timeout tells us nothing. */
      const diag = await cdp.evalJs(
        `(() => ({ url: location.href, text: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 700) }))()`
      ).catch(() => null);
      await cdp.shot('e2e-05-stripe-stuck.png');
      check('the guest returned to the app after paying', false,
        diag ? ('still on ' + diag.url + '\n         page says: ' + diag.text) : e.message);
      throw e;
    }
    /* let probeBackend -> verify-session -> PATCH settle */
    await sleep(6000);
    await cdp.shot('e2e-04-return.png');

    const leg3 = await cdp.evalJs(`(() => {
      const txt = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        url: location.href,
        ticketShown: !!document.querySelector('.ticket'),
        heading: txt('.tk-head h3'),
        orderNo: txt('.tk-num'),
        meta: Array.from(document.querySelectorAll('.tk-meta > div')).map(d =>
          (d.querySelector('small')?.textContent || '') + '=' + (d.querySelector('b')?.textContent || '')),
        totals: Array.from(document.querySelectorAll('.tk-tot > div')).map(d =>
          (d.querySelector('span')?.textContent || '') + ' ' + (d.querySelectorAll('span')[1]?.textContent || '')),
        pendingConsumed: localStorage.getItem('kpot.pending.v1') === null,
        badge: document.querySelector('#cartBadge')?.textContent
      };
    })()`);

    console.log('  ' + JSON.stringify(leg3, null, 2).split('\n').join('\n  '));
    check('the guest landed back on a ticket', leg3.ticketShown === true, 'url=' + leg3.url);
    check('the pending order was consumed (no replay on refresh)',
      leg3.pendingConsumed === true, 'pendingConsumed=' + leg3.pendingConsumed);

    /* ---- the real assertion: did the SERVER verify with Stripe? ---- */
    await sleep(1500);
    const board2 = await fetch(BASE + '/api/orders', { headers: { 'X-Admin-Key': adminKey() } })
      .then((r) => r.json()).catch(() => null);
    const settled = board2 && (board2.orders || []).find((o) =>
      (orderNo && o.id === orderNo) || o.source === 'storefront');

    check('the board flipped the order to VERIFIED after the real Stripe check',
      !!settled && settled.paymentStatus === 'verified',
      settled ? ('order ' + settled.id + ' paymentStatus=' + settled.paymentStatus) : 'order not found on the board');
    if (settled) {
      check('the verified total matches the cart',
        Math.abs(Number(settled.total) - 16.95) < 0.02, 'total=' + settled.total);
    }

    const verifyCalls = (serverLog.match(/\[kpot\] verify /g) || []).length;
    check('the server really called Stripe to verify (not just trusting ?paid=1)',
      verifyCalls >= 1, verifyCalls + ' verify call(s) in the server log');
  } catch (e) {
    console.log('\n  FAIL  run aborted: ' + e.message);
    fail++;
    if (cdp) await cdp.shot('e2e-99-error.png');

    /* Never leave a payable session behind. If we got as far as creating one
       and then died, expire it. Stripe refuses to expire a session that was
       already paid, which is the answer we want anyway — a completed payment
       must not be undone. */
    if (sessionId && !PREFLIGHT_ONLY) {
      try {
        const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + sessionId + '/expire', {
          method: 'POST', headers: { Authorization: 'Bearer ' + key }
        });
        console.log('  cleanup: expire ' + sessionId + ' → HTTP ' + r.status);
      } catch (err) {
        console.log('  cleanup: could not expire ' + sessionId + ' — expire it by hand in the Dashboard');
      }
    }
  } finally {
    console.log('\n--- server log (tail) ---');
    console.log(serverLog.split('\n').slice(-25).join('\n'));
    if (cdp && cdp.logs.length) {
      console.log('--- browser console (tail) ---');
      console.log(cdp.logs.slice(-15).join('\n'));
    }
    if (notes.length) {
      console.log('--- notes ---');
      notes.forEach((n) => console.log('  ' + n));
    }
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    cleanup();
    restore();
    await sleep(300);
    console.log('orders.local.json restored to ' + ordersBytes + ' bytes');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
