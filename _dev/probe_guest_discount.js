#!/usr/bin/env node
/* ==========================================================================
   The discount box, in a REAL browser.

   The rules are proven in test_discount.js and the wiring in
   probe_discount_http.js. What neither can see is the guest-facing part:

     * does the coupon row actually render, with the right amount and sign;
     * does the TOTAL on the page move, or does it still show the old number
       (a row that renders into a div nobody reads is worse than no row);
     * does changing the quantity re-ask the server instead of leaving a stale
       discount on the bill;
     * does anything throw on the way.

   That last one is not hypothetical: the field where the guest types has to
   survive the sheet being re-rendered under it, which is exactly the class of
   bug that only shows up when a human actually types.

   Run:  node _dev/probe_guest_discount.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8953', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9373', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'guest-discount-key-' + Date.now().toString(36);

/* Every state file the server knows about is pointed at scratch, so this probe
   cannot read or write the shop's real orders, codes, switches or secrets. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-guest-discount-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

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
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('[error] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  async function evalJs(expression) {
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
          throw new Error('IN-PAGE ERROR: ' + String(desc).split('\n')[0]);
        }
        return r.result ? (r.result.value !== undefined ? r.result.value : r.result.description) : undefined;
      } catch (e) {
        if (/IN-PAGE ERROR/.test(e.message)) throw e;
        lastErr = e; await sleep(400);
      }
    }
    throw lastErr;
  }

  async function waitFor(expr, timeoutMs, label) {
    const until = Date.now() + timeoutMs;
    let last;
    let lastErr = null;
    while (Date.now() < until) {
      /* An expression that THROWS has NOT succeeded. It nearly always means
         the element it reads is not in the DOM yet — which is the entire
         point of waiting. Turning the error into a truthy string made
         waitFor return early on a condition that was never met: for about
         one run in ten, probe_guest_discount's discount-row expression threw
         for the ~10 ms the row was absent while the credit re-price was in
         flight, so the wait "passed" instantly and the next check read a row
         that was not there. Keep polling; the error is reported only if we
         genuinely time out. */
      try { last = await evalJs(expr); lastErr = null; }
      catch (e) { last = null; lastErr = e.message; }
      if (last) return last;
      await sleep(350);
    }
    throw new Error('timed out waiting for ' + label + ' — last: ' + JSON.stringify(last) +
      (lastErr ? ' (last error: ' + lastErr + ')' : ''));
  }

  return { ws, send, evalJs, waitFor, logs };
}

/* One Hot Pot To Go bowl, $15.99. */
const CART = [{
  uid: 'probedish1', sig: 'probesig', kind: 'hotpot', name: 'Hot Pot To Go',
  unit: 15.99, qty: 1, mods: [], addons: [], note: ''
}];

const CODES = [
  { code: 'TEN', type: 'percent', value: 10, active: true },
  { code: 'FIVE', type: 'amount', value: 5, active: true },
  { code: 'NOPE2', type: 'amount', value: 5, active: false },
  { code: 'SHIPFREE', type: 'freeship', value: 0, active: true },
  { code: 'BIGSPEND', type: 'amount', value: 5, active: true, minSubtotal: 30 }
];

/* A store-credit code — the LUCKY 66 prize, as the guest meets it. Seeded
   through credits.js itself so the on-disk format is the module's own, not a
   hand-written guess about it. */
const CR = require(path.join(ROOT, 'credits.js'));
const CREDITS_FILE = path.join(SCRATCH, 'credits.local.json');
const CREDIT_CODE = 'KPOT-PROBE-GUEST-01';
/* Two more, for the shortfall journey at the bottom: one whose balance the
   guest PAYS the rest of online, and one they walk away from. Both $5 against
   $31.98 of food, so neither covers the order. */
const CREDIT_SMALL = 'KPOT-PROBE-GUEST-02';
const CREDIT_BACK = 'KPOT-PROBE-GUEST-03';
const seedCredits = CR.blankStore();
CR.issue(seedCredits, CREDIT_CODE, 66, { roundId: 'probe-guest', now: new Date().toISOString() });
CR.issue(seedCredits, CREDIT_SMALL, 5, { roundId: 'probe-guest', now: new Date().toISOString() });
CR.issue(seedCredits, CREDIT_BACK, 5, { roundId: 'probe-guest', now: new Date().toISOString() });
CR.saveCredits(CREDITS_FILE, seedCredits);

const creditBalance = (code) => {
  const r = CR.balanceOf(CR.loadCredits(CREDITS_FILE), code);
  return r.ok ? r.balance : null;
};

/* ---- a Stripe stub, so the shortfall can actually be paid ----------------
   The guest page will not offer a card payment the server cannot create a
   session for, and a test must not call the real api.stripe.com. So a stub
   stands in for both halves the app needs:

     POST /v1/checkout/sessions      — create one, and hand back a URL;
     GET  /v1/checkout/sessions/:id  — "was this one paid?" (/api/verify-session);
     GET  /pay/:id                   — the page the browser is handed to.

   The pay URL is LOCAL rather than https://stub.invalid/… because the browser
   has to be able to navigate there: the redirect is the real thing, only the
   card form at the end of it is a stub. `stubWillPay` is what a real Stripe
   decides — the guest either pays or backs out, and the probe sets it. */
const STRIPE_PORT = parseInt(process.env.STRIPE_PORT || '8954', 10);
const STRIPE_BASE = 'http://127.0.0.1:' + STRIPE_PORT;
let stubSessions = [];     // {id, orderNo, payment_status, amount_total, body}
let stubCoupons = [];      // {id, amount_off} — what a coupon takes off
let stubWillPay = true;
let stripeBodies = [];

const stripeStub = http.createServer((req, res) => {
  const u = new URL(req.url, STRIPE_BASE);
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  /* The card form the guest lands on. Deliberately plain: nothing here is
     under test, it only has to exist so the redirect is real. */
  if (u.pathname.indexOf('/pay/') === 0) {
    return send(200, '<!doctype html><meta charset="utf-8"><title>Stripe (stub)</title>' +
      '<body style="font:16px system-ui;padding:40px;text-align:center">' +
      '<h2>Stripe — stub</h2><p>This is where the card form would be.</p>' +
      '<script>window.__stubSession = ' + JSON.stringify(u.pathname.slice(5)) + ';</script>' +
      '</body>', 'text/html');
  }

  if (req.method === 'POST' && u.pathname === '/v1/coupons') {
    /* Stripe has no "take $1.38 off" other than a coupon, so the server mints
       a one-shot coupon for the exact amount. It fails CLOSED if this call
       fails, so the stub has to answer or the whole card path is refused. */
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      stripeBodies.push(body);
      const params = new URLSearchParams(body);
      const c = {
        id: 'coupon_stub' + Math.random().toString(36).slice(2, 10),
        object: 'coupon',
        amount_off: parseInt(params.get('amount_off') || '0', 10) || 0,
        currency: 'usd',
        duration: 'once',
        max_redemptions: 1
      };
      stubCoupons.push(c);
      send(200, c);
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      stripeBodies.push(body);
      /* client_reference_id is the order number we put there; the server reads
         it back off the session to find the board entry. */
      const params = new URLSearchParams(body);
      const orderNo = params.get('client_reference_id') || '';
      /* What the guest is actually charged, computed the way Stripe computes
         it: every line item's unit_amount × quantity, less any coupon applied.
         The store credit reaches the guest through that coupon, so this number
         IS the shortfall — which is the whole point of the check below. */
      let gross = 0;
      for (const [k, v] of params) {
        const m = k.match(/^line_items\[(\d+)\]\[price_data\]\[unit_amount\]$/);
        if (!m) continue;
        const q = parseInt(params.get('line_items[' + m[1] + '][quantity]') || '1', 10) || 1;
        gross += (parseInt(v, 10) || 0) * q;
      }
      const couponId = params.get('discounts[0][coupon]') || '';
      const coupon = stubCoupons.find((x) => x.id === couponId);
      const s = {
        id: 'cs_test_stub' + Math.random().toString(36).slice(2, 12),
        object: 'checkout.session',
        client_reference_id: orderNo,
        payment_status: stubWillPay ? 'paid' : 'unpaid',
        status: stubWillPay ? 'complete' : 'open',
        amount_total: Math.max(0, gross - (coupon ? coupon.amount_off : 0)),
        coupon_off: coupon ? coupon.amount_off : 0,
        currency: 'usd',
        created: Math.floor(Date.now() / 1000),
        body: body
      };
      stubSessions.push(s);
      send(200, { id: s.id, url: STRIPE_BASE + '/pay/' + s.id });
    });
    return;
  }

  const one = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (one) {
    const s = stubSessions.find((x) => x.id === decodeURIComponent(one[1]));
    if (!s) return send(404, { error: { message: 'No such checkout session' } });
    return send(200, s);
  }
  return send(404, { error: { message: 'stub: nothing at ' + u.pathname } });
});

/* Read one row out of the cart's totals block by its label. */
const ROW = (label) => `(() => {
  const rows = Array.from(document.querySelectorAll('#cartTotals .trow'));
  const r = rows.find((x) => x.querySelector('span') && x.querySelector('span').textContent.indexOf(${JSON.stringify(label)}) === 0);
  return r ? (r.querySelector('b') ? r.querySelector('b').textContent : r.textContent) : null;
})()`;

const DISC_ROW = `(() => { const r = document.querySelector('#cartTotals .trow.disc');
  return r ? r.textContent : null; })()`;
const DISC_STYLE = `(() => { const r = document.querySelector('#cartTotals .trow.disc');
  return r && r.querySelector('b') ? r.querySelector('b').textContent : null; })()`;

async function typeCode(cdp, code) {
  await cdp.evalJs(`(() => {
    const i = document.querySelector('#couponInput');
    if (!i) return false;
    i.value = ${JSON.stringify(code)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const b = document.querySelector('#couponApply');
    if (b) b.click();
    return true;
  })()`);
}

/* Same shape, the other box. The two boxes share the .coupon class, so every
   read below is scoped through #creditInput's own container — otherwise the
   coupon box's messages would answer for the credit box's. */
async function typeCredit(cdp, code) {
  await cdp.evalJs(`(() => {
    const i = document.querySelector('#creditInput');
    if (!i) return false;
    i.value = ${JSON.stringify(code)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const b = document.querySelector('#creditApply');
    if (b) b.click();
    return true;
  })()`);
}
const CREDIT_BOX_TEXT = `(() => {
  const box = document.querySelector('#creditInput');
  const c = box && box.closest('.coupon');
  return c ? Array.from(c.querySelectorAll('.small')).map((x) => x.textContent).join(' | ') : '';
})()`;

/* The guest's details, typed the way a guest types them, then the button that
   actually places the order. All three are required by placeOrder() — a missing
   one is a toast, not a silent no-op, so the probe would hang rather than
   fail confusingly. */
async function fillGuestAndPay(cdp) {
  await cdp.evalJs(`(() => {
    const set = (sel, v) => {
      const e = document.querySelector(sel);
      if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    set('#cName', 'Probe Guest');
    set('#cPhone', '4045550111');
    set('#cEmail', 'probe@example.invalid');
  })()`);
  await cdp.evalJs(`document.querySelector('#placeOrder').click()`);
}
const COUPON_BOX_TEXT = `(() => {
  const box = document.querySelector('#couponInput');
  const c = box && box.closest('.coupon');
  return c ? Array.from(c.querySelectorAll('.small')).map((x) => x.textContent).join(' | ') : '';
})()`;

async function main() {
  console.log('guest discount box — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-guest-discount-chrome-' + Date.now());

  const cleanup = async () => {
    try { stripeStub.closeAllConnections(); } catch (e) {}
    try { stripeStub.close(); } catch (e) {}
    await teardown([chrome, server], [SCRATCH, profile]);
  };

  /* Listening before the server boots, so the first checkout finds it. */
  await new Promise((r) => stripeStub.listen(STRIPE_PORT, '127.0.0.1', r));

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ADMIN_KEY,
        KPOT_FLUSH_MS: '500',
        /* The business-hours tick holds `open` strictly on the hours clock —
           after closing time it closes the shop under this probe within one
           flush, and a guest page that will not accept orders cannot be
           driven through a cart at all. A 24h spec keeps the shop open at any
           clock; production never sets this. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_CREDITS_FILE: CREDITS_FILE,
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        /* Without this the server would call the REAL api.stripe.com with the
           fake key below, and the card path could never be driven. */
        KPOT_STRIPE_API_BASE: STRIPE_BASE + '/v1/checkout/sessions',
        STRIPE_SECRET_KEY: 'sk_test_guest_discount_not_a_real_key'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    /* Wait for the server before seeding the codes — a PUT that lands while
       nothing is listening is a fetch failure, not a code save. */
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { const j = await r.json(); if (j && j.ok) { health = j; break; } }
      } catch (e) {}
      await sleep(250);
    }
    if (!health) throw new Error('server never became healthy');
    console.log('server up on ' + BASE + '\n');

    /* Seed the owner's codes through the API, exactly as the console does. */
    const seed = await fetch(BASE + '/api/discounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ codes: CODES })
    });
    check('the owner saved ' + CODES.length + ' codes for this test', seed.ok, 'status=' + seed.status);

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
    if (!list) throw new Error('Chrome did not start');

    const target = list.find((t) => t.type === 'page');
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await new Promise((r) => cdp.ws.addEventListener('open', r));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* Seed the cart in localStorage, then let the app load it from there —
       the same path a returning guest takes. */
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('!!document.querySelector("#cartBar")', 15000, 'the page to boot');
    await cdp.evalJs(`localStorage.setItem('kpot.cart.v1', ${JSON.stringify(JSON.stringify(CART))})`);
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('!!document.querySelector("#cartBar.on")', 15000, 'the cart bar to show an item');

    /* #cartBtn opens the sheet; #cartBar is the little bar that appears. */
    await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
    await cdp.waitFor('!!document.querySelector("#couponInput")', 10000, 'the cart sheet with the coupon box');
    await cdp.waitFor('!!document.querySelector("#cartTotals")', 10000, 'the totals to render');

    /* ---- baseline ---- */
    check('no discount yet: total is $16.95', (await cdp.evalJs(ROW('Total'))) === '$16.95',
      'total=' + (await cdp.evalJs(ROW('Total'))));
    check('no discount yet: tax is $0.96', (await cdp.evalJs(ROW('Tax'))) === '$0.96',
      'tax=' + (await cdp.evalJs(ROW('Tax'))));
    check('no discount row is shown before a code is applied', (await cdp.evalJs(DISC_ROW)) === null);

    /* ---- a code that does not apply ---- */
    await typeCode(cdp, 'SHIPFREE');
    await cdp.waitFor(`!!(document.querySelector('#couponRemove') || document.querySelector('.coupon .small.err'))`,
      10000, 'a message for the code that applies to nothing');
    check('free-delivery code on a pickup order says it does not apply',
      /does not apply/i.test(await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`)),
      await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`));
    check('and no discount row appears for it', (await cdp.evalJs(DISC_ROW)) === null);
    check('total is still $16.95', (await cdp.evalJs(ROW('Total'))) === '$16.95');

    /* ---- a switched-off code ---- */
    await typeCode(cdp, 'nope2');
    await cdp.waitFor(`!!document.querySelector('.coupon .small.err')`, 10000, 'the refused-code message');
    check('a switched-off code is refused with the server\'s own wording',
      /no longer active/i.test(await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`)),
      await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`));
    check('and the total is untouched', (await cdp.evalJs(ROW('Total'))) === '$16.95');

    /* ---- a valid code ---- */
    await typeCode(cdp, 'ten');
    await cdp.waitFor('!!document.querySelector("#cartTotals .trow.disc")', 10000, 'the discount row to appear');
    check('the discount row shows the code name and the amount',
      /TEN/.test((await cdp.evalJs(DISC_ROW)) || '') && /-\$1\.60/.test((await cdp.evalJs(DISC_ROW)) || ''),
      'row=' + (await cdp.evalJs(DISC_ROW)));
    check('tax is recalculated on the discounted amount ($0.86)',
      (await cdp.evalJs(ROW('Tax'))) === '$0.86', 'tax=' + (await cdp.evalJs(ROW('Tax'))));
    check('the TOTAL on the page actually moves: $16.95 → $15.25',
      (await cdp.evalJs(ROW('Total'))) === '$15.25', 'total=' + (await cdp.evalJs(ROW('Total'))));
    check('the discount row is styled, not left to its default colour',
      (await cdp.evalJs(`(() => { const b = document.querySelector('#cartTotals .trow.disc b');
        return b ? getComputedStyle(b).color === getComputedStyle(document.querySelector('#cartTotals .trow.grand b')).color ? 'same-as-total' : 'styled' : 'missing'; })()`)) === 'styled');

    /* ---- the cart changes, so the discount must be re-asked ---- */
    await cdp.evalJs(`document.querySelector('#sheetBody [data-q="1"][data-u="probedish1"]').click()`);
    await cdp.waitFor('!!document.querySelector("#cartTotals .trow.disc")', 10000, 'the discount row to survive');
    /* Subtotal is now $31.98, so 10% off is $3.20. */
    await cdp.waitFor(`((document.querySelector('#cartTotals .trow.disc b')||{}).textContent||'') === '-$3.20'`,
      12000, 'the discount to be re-priced for the new quantity');
    check('after the quantity changes, the discount is re-priced to $3.20',
      (await cdp.evalJs(DISC_STYLE)) === '-$3.20', 'discount=' + (await cdp.evalJs(DISC_STYLE)));
    check('and the total moves to $30.51',
      (await cdp.evalJs(ROW('Total'))) === '$30.51', 'total=' + (await cdp.evalJs(ROW('Total'))));

    /* ---- remove it ---- */
    await cdp.evalJs(`document.querySelector('#couponRemove').click()`);
    await cdp.waitFor(`!!document.querySelector('#cartTotals .trow.grand') && !document.querySelector('#cartTotals .trow.disc')`,
      10000, 'the discount row to go away');
    check('removing the code restores the full total ($33.90 for 2 bowls)',
      (await cdp.evalJs(ROW('Total'))) === '$33.90', 'total=' + (await cdp.evalJs(ROW('Total'))));
    check('and restores tax to $1.92',
      (await cdp.evalJs(ROW('Tax'))) === '$1.92', 'tax=' + (await cdp.evalJs(ROW('Tax'))));

    /* ---- an unknown code ---- */
    await typeCode(cdp, 'DOESNOTEXIST');
    await cdp.waitFor(`!!document.querySelector('.coupon .small.err')`, 10000, 'the unknown-code message');
    check('an unknown code is refused',
      /not valid/i.test(await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`)),
      await cdp.evalJs(`(document.querySelector('.coupon .small')||{}).textContent||''`));

    /* ---- store credit: a balance, not a one-shot code ------------------
       Two bowls ($31.98 of food, $33.90 with tax) against a $66 code: the
       whole food subtotal comes off, the tax follows it down to nothing, and
       the page says what will be LEFT on the code — the rules promise that
       after payment, and there is no reason to make the guest wait for the
       ticket to learn it. */
    check('the store-credit box is on the sheet',
      (await cdp.evalJs('!!document.querySelector("#creditInput")')) === true);
    await typeCredit(cdp, CREDIT_CODE);
    await cdp.waitFor('!!document.querySelector("#cartTotals .trow.disc")', 10000, 'the credit discount row');
    check('the discount row names the store credit and takes the food subtotal',
      /Store credit/.test((await cdp.evalJs(DISC_ROW)) || '') &&
      /-\$31\.98/.test((await cdp.evalJs(DISC_ROW)) || ''),
      'row=' + (await cdp.evalJs(DISC_ROW)));
    check('tax is recomputed on the discounted amount ($0.00)',
      (await cdp.evalJs(ROW('Tax'))) === '$0.00', 'tax=' + (await cdp.evalJs(ROW('Tax'))));
    check('the TOTAL on the page actually reaches $0.00',
      (await cdp.evalJs(ROW('Total'))) === '$0.00', 'total=' + (await cdp.evalJs(ROW('Total'))));
    check('the remaining balance is shown while the guest is still deciding',
      /\$34\.02 will be left/.test(await cdp.evalJs(CREDIT_BOX_TEXT)),
      await cdp.evalJs(CREDIT_BOX_TEXT));

    /* One discount per order, whichever kind it is: picking the credit up
       puts the coupon down. */
    await cdp.evalJs(`document.querySelector('#creditRemove').click()`);
    await cdp.waitFor(`!!document.querySelector('#cartTotals .trow.grand') && !document.querySelector('#cartTotals .trow.disc')`,
      10000, 'the credit row to go away');
    await typeCode(cdp, 'ten');
    await cdp.waitFor('!!document.querySelector("#cartTotals .trow.disc")', 10000, 'the coupon discount row');
    check('with the coupon applied the total is $30.51 again',
      (await cdp.evalJs(ROW('Total'))) === '$30.51', 'total=' + (await cdp.evalJs(ROW('Total'))));
    await typeCredit(cdp, CREDIT_CODE);
    /* The `||''` matters: while the credit re-price is in flight the discount
       row is briefly REMOVED from the DOM (the setters clear the amount before
       they ask), and `(x||{}).textContent` is then `undefined` — `.indexOf` on
       it throws. A throw used to read as a truthy "done" in waitFor. */
    await cdp.waitFor(`((document.querySelector('#cartTotals .trow.disc')||{}).textContent||'').indexOf('Store credit') >= 0`,
      10000, 'the store credit to replace the coupon');
    check('applying the credit puts the coupon down — one discount per order',
      /Store credit/.test((await cdp.evalJs(DISC_ROW)) || '') &&
      (await cdp.evalJs(COUPON_BOX_TEXT)) === '',
      'row=' + (await cdp.evalJs(DISC_ROW)) + ' couponBox=' + (await cdp.evalJs(COUPON_BOX_TEXT)));
    check('and the total goes back to $0.00',
      (await cdp.evalJs(ROW('Total'))) === '$0.00', 'total=' + (await cdp.evalJs(ROW('Total'))));

    await cdp.evalJs(`document.querySelector('#creditRemove').click()`);
    await cdp.waitFor(`!!document.querySelector('#cartTotals .trow.grand') && !document.querySelector('#cartTotals .trow.disc')`,
      10000, 'the credit row to go away again');
    check('removing the credit restores the full $33.90',
      (await cdp.evalJs(ROW('Total'))) === '$33.90', 'total=' + (await cdp.evalJs(ROW('Total'))));

    /* ---- an unknown credit code ---- */
    await typeCredit(cdp, 'KPOT-NOPE-NOPE-01');
    await cdp.waitFor(`(() => { const t = (${CREDIT_BOX_TEXT}); return /recognise/i.test(t); })()`,
      10000, 'the unknown-credit message');
    check('an unknown store-credit code is refused in the server\'s own words',
      /recognise/i.test(await cdp.evalJs(CREDIT_BOX_TEXT)),
      await cdp.evalJs(CREDIT_BOX_TEXT));
    check('and no discount row appears for it', (await cdp.evalJs(DISC_ROW)) === null);
    check('the total is untouched', (await cdp.evalJs(ROW('Total'))) === '$33.90');

    /* ---- the shortfall: the credit runs out, the card pays the rest -------
       The owner's promise about the prize, end to end in a real browser. A $5
       code against $31.98 of food does not cover the order, so the guest pays
       the difference another way. Everything here is the real thing except the
       card form at the very end of the redirect: the server prices the
       shortfall, creates the session, the browser is handed over, and the
       ticket that comes back has to show BOTH halves of the payment. */
    await typeCredit(cdp, CREDIT_SMALL);
    await cdp.waitFor(`((document.querySelector('#cartTotals .trow.disc')||{}).textContent||'').indexOf('Store credit') >= 0`,
      10000, 'the store credit to take its share');
    check('a $5 code against $31.98 of food takes $5.00, not the whole subtotal',
      /-\$5\.00/.test((await cdp.evalJs(DISC_ROW)) || ''),
      'row=' + (await cdp.evalJs(DISC_ROW)));
    check('tax is recomputed on what is left ($1.62)',
      (await cdp.evalJs(ROW('Tax'))) === '$1.62', 'tax=' + (await cdp.evalJs(ROW('Tax'))));
    check('the TOTAL is what the card still has to collect: $28.60',
      (await cdp.evalJs(ROW('Total'))) === '$28.60', 'total=' + (await cdp.evalJs(ROW('Total'))));
    check('the page says the code will be empty afterwards',
      /\$0\.00 will be left/.test(await cdp.evalJs(CREDIT_BOX_TEXT)),
      await cdp.evalJs(CREDIT_BOX_TEXT));

    /* Pay it. The cart sheet only carries the button that OPENS the checkout
       sheet — #placeOrder lives there, next to the guest's details. */
    stubWillPay = true;
    stubSessions = [];
    await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
    await cdp.waitFor('!!document.querySelector("#placeOrder")', 10000, 'the checkout sheet');
    /* The checkout sheet keeps its own totals block (#checkoutTotals, not
       #cartTotals) — the cart sheet is still in the DOM behind it, so reading
       the wrong one would answer for the wrong sheet. */
    const CO_TOTAL = `(() => { const r = Array.from(document.querySelectorAll('#checkoutTotals .trow'))
      .find((x) => x.querySelector('span') && x.querySelector('span').textContent.indexOf('Total') === 0);
      return r ? (r.querySelector('b') ? r.querySelector('b').textContent : r.textContent) : null; })()`;
    check('the shortfall survives the move to the checkout sheet',
      (await cdp.evalJs(CO_TOTAL)) === '$28.60', 'total=' + (await cdp.evalJs(CO_TOTAL)));
    await fillGuestAndPay(cdp);
    await cdp.waitFor(`location.href.indexOf(${JSON.stringify(STRIPE_BASE + '/pay/')}) === 0`,
      25000, 'the browser to be handed to the Stripe stub');

    check('the session was created for the SHORTFALL, not the whole order',
      stubSessions.length === 1 && stubSessions[0].amount_total === 2860,
      'sessions=' + stubSessions.length + ' charged=' +
        (stubSessions[0] && stubSessions[0].amount_total) + ' coupon_off=' +
        (stubSessions[0] && stubSessions[0].coupon_off));
    check('…and it carries our order number, so the board can be found again',
      /^KP-/.test((stubSessions[0] && stubSessions[0].client_reference_id) || ''),
      'ref=' + (stubSessions[0] && stubSessions[0].client_reference_id));
    check('the $5 was spent the moment the order was created — before any card',
      creditBalance(CREDIT_SMALL) === 0, 'balance=' + creditBalance(CREDIT_SMALL));

    /* The guest pays at the stub (the probe flips the session, which is what a
       real Stripe decides), then comes back the way Stripe sends them. */
    await cdp.send('Page.navigate', { url: BASE + '/?paid=1' });
    await cdp.waitFor('!!document.querySelector(".tk-tot")', 25000, 'the ticket to come back');

    const TICKET = `(() => { const t = document.querySelector('.ticket');
      return t ? t.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`;
    const ticket = await cdp.evalJs(TICKET);
    check('the ticket confirms the CARD payment, by Stripe',
      /Payment confirmed by Stripe/.test(ticket) && /Pay Online/.test(ticket),
      ticket.slice(0, 220));
    check('it shows the store-credit half: -$5.00 off',
      /-\$5\.00/.test(ticket), ticket.slice(0, 260));
    check('it says what is left on the code: $0.00',
      /Store credit left\s*\$0\.00/.test(ticket), ticket.slice(0, 300));
    check('and the total is the shortfall the card paid: $28.60',
      /Total\s*\$28\.60/.test(ticket), ticket.slice(0, 320));
    check('the credit is still spent — paying the rest is not a refund',
      creditBalance(CREDIT_SMALL) === 0, 'balance=' + creditBalance(CREDIT_SMALL));

    /* ---- and the guest who changes their mind at the card form ------------
       Same order, same spent credit, but the money never arrives. The credit
       has to come back, or the prize quietly costs the guest $5 for nothing.

       The paid order above cleared the cart, so seed it again the way a
       returning guest gets it — the same trick this probe used at the start. */
    await cdp.evalJs(`localStorage.setItem('kpot.cart.v1', ${JSON.stringify(JSON.stringify(CART))})`);
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('!!document.querySelector("#cartBar.on")', 20000, 'the cart bar to show an item');
    await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
    await cdp.waitFor('!!document.querySelector("#creditInput")', 10000, 'the cart sheet again');
    await typeCredit(cdp, CREDIT_BACK);
    await cdp.waitFor(`((document.querySelector('#cartTotals .trow.disc')||{}).textContent||'').indexOf('Store credit') >= 0`,
      10000, 'the second code to take its share');
    check('the second $5 code is applied the same way',
      /-\$5\.00/.test((await cdp.evalJs(DISC_ROW)) || ''), 'row=' + (await cdp.evalJs(DISC_ROW)));

    stubWillPay = false;      // the guest backs out of the card form
    stubSessions = [];
    await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
    await cdp.waitFor('!!document.querySelector("#placeOrder")', 10000, 'the checkout sheet again');
    await fillGuestAndPay(cdp);
    await cdp.waitFor(`location.href.indexOf(${JSON.stringify(STRIPE_BASE + '/pay/')}) === 0`,
      25000, 'to be handed to the Stripe stub again');
    check('the $5 is spent before the guest has paid anything',
      creditBalance(CREDIT_BACK) === 0, 'balance=' + creditBalance(CREDIT_BACK));

    await cdp.send('Page.navigate', { url: BASE + '/?canceled=1' });
    await cdp.waitFor(`!!document.querySelector("#cartBar")`, 25000, 'the app to come back');

    /* The client's cancel notice is fire-and-forget, so poll the ledger rather
       than assume the request landed. */
    let given = null;
    for (let i = 0; i < 40; i++) {
      given = creditBalance(CREDIT_BACK);
      if (given === 5) break;
      await sleep(250);
    }
    check('the $5 is back on the code — walking away costs the guest nothing',
      given === 5, 'balance=' + given);

    const errs = cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l));
    check('the page logged no JavaScript errors', errs.length === 0, errs.slice(0, 3).join('\n         '));

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const dir = path.join(__dirname, 'screens');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'guest-discount.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('\nscreenshot: ' + out);
    } catch (e) { console.log('(screenshot skipped: ' + e.message + ')'); }
  } catch (e) {
    check('probe ran to completion', false, e.message);
    console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-20).join('\n'));
  } finally {
    await cleanup();
    await sleep(300);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
