#!/usr/bin/env node
/* ==========================================================================
   Marketing tracking — does the shop know WHICH poster produced an order?

   Every printed QR code, flyer and table tent carries its own ?src= on the
   URL. Without it, "did the window poster pay for itself?" is a question
   nobody can answer, and the marketing budget is guesswork. The server has
   always stored `source` on an order (defaulting to 'storefront'); this
   closes the two halves that were missing:

     * the guest page actually SENDS it, read from ?src= and sanitised —
       a URL is user input, and it ends up in the owner's spreadsheet and on
       the kitchen ticket, so it is narrowed to [a-z0-9_-] and capped;
     * the CSV export carries it, because that is where the owner looks.

   Driven in a real browser through the real cart, because the value has to
   survive the whole guest flow — not just a hand-written POST.

   Run:  node _dev/probe_source_tracking.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8961', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9381', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'src-probe-key-' + Date.now().toString(36);
const GUEST_NAME = 'Src Probe';
const GUEST_PHONE = '4045550199';

/* A value a hostile poster could carry: mixed case, spaces and markup. The
   stored source must be the narrowed token, not this string. */
const RAW_SRC = 'Window Poster! <b>';
const CLEAN_SRC = 'window-poster-b';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-src-probe-'));

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

  /* An expression that THROWS has NOT succeeded — it usually means the element
     is not in the DOM yet, which is the whole point of waiting. */
  async function waitFor(expr, timeoutMs, label) {
    const until = Date.now() + timeoutMs;
    let last, lastErr = null;
    while (Date.now() < until) {
      try { last = await evalJs(expr); lastErr = null; }
      catch (e) { last = null; lastErr = e.message; }
      if (last) return last;
      await sleep(400);
    }
    throw new Error('timed out waiting for ' + label + ' — last: ' + JSON.stringify(last) +
      (lastErr ? ' (last error: ' + lastErr + ')' : ''));
  }

  return { ws, send, evalJs, waitFor, logs };
}

const jpost = (p, body, headers) => fetch(BASE + p, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));

const adminH = () => ({ 'X-Admin-Key': ADMIN_KEY });

/* --------------------------------------------------------------------------
   The same order shape the guest page builds, for the no-?src= control case.
   Dine-in + pay-at-counter: since 2026-10-22 pickup and delivery must be
   prepaid, and this probe is about marketing, not money.
   -------------------------------------------------------------------------- */
function apiOrder(extra) {
  const unit = 15.99;
  const subtotal = unit;
  const tax = Math.round(subtotal * 0.06 * 100) / 100;
  return Object.assign({
    no: 'KP-SRC-' + Date.now().toString(36),
    orderNo: 'KP-SRC-' + Date.now().toString(36),
    token: 'src-' + Date.now().toString(36),
    orderType: 'dinein',
    table: '5',
    customer: { name: GUEST_NAME, phone: GUEST_PHONE, when: 'ASAP', notes: '' },
    items: [{ kind: 'hotpot', name: 'Build Your Own Bowl', qty: 1, unit, mods: ['Broth: Japanese Miso'], addons: [], note: '' }],
    subtotal, deliveryFee: 0, tax, tip: 0, surcharge: 0,
    total: Math.round((subtotal + tax) * 100) / 100,
    payMethod: 'counter',
    paymentStatus: 'counter',
    paid: false,
    source: 'storefront'
  }, extra || {});
}

async function main() {
  console.log('marketing source tracking — real browser + real server + CSV export');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-src-probe-chrome-' + Date.now());

  const cleanup = async () => {
    await teardown([chrome, server], [SCRATCH, profile]);
  };

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ADMIN_KEY,
        KPOT_FLUSH_MS: '500',
        /* The suite must run at any hour — the real opening clock must not
           decide whether a guest page can be driven through a cart. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        /* EVERY *_FILE the server knows about is pinned to scratch. Sealing is
           per-FILE, not per-suite: a probe that pins nine of them still writes
           the tenth, and the tenth has been the shop's real data before. */
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        KPOT_CREDITS_FILE: path.join(SCRATCH, 'credits.local.json'),
        KPOT_APPLE_PAY_FILE: path.join(SCRATCH, 'apple-pay.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_src_probe_not_a_real_key'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

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

    /* ---- 1. a guest arrives from a printed poster ---------------------- */
    console.log('--- a guest scans a poster: ?src=' + JSON.stringify(RAW_SRC) + ' ---');
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--window-size=900,1200', 'about:blank'
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

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { sessionStorage.setItem("kpotAdminKey", ' + JSON.stringify(ADMIN_KEY) + '); } catch (e) {}'
    });

    await cdp.send('Page.navigate', {
      url: BASE + '/?src=' + encodeURIComponent(RAW_SRC)
    });
    /* #cartBar is static HTML and exists before app.js has booted — wait for
       something only the running app renders. */
    await cdp.waitFor('!!document.querySelector("[data-cat=\\"sides\\"]")', 20000, 'the menu tabs to render');

    /* The real cart, the real checkout, the real POST. */
    await cdp.evalJs(`document.querySelector('[data-cat="sides"]').click()`);
    await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 10000, 'the A La Carte list');
    await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
    await cdp.waitFor('document.querySelector("#cartBadge").textContent === "1"', 10000, 'the item to land in the cart');

    await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
    await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
    await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
    await cdp.waitFor('!!document.querySelector("#placeOrder")', 10000, 'the checkout sheet');
    await cdp.evalJs(`(() => {
      const n = document.querySelector('#cName'); if (n) n.value = ${JSON.stringify(GUEST_NAME)};
      const p = document.querySelector('#cPhone'); if (p) { p.value = '${GUEST_PHONE}'; p.dispatchEvent(new Event('input', { bubbles: true })); }
      const e = document.querySelector('#cEmail'); if (e) e.value = 'src-probe@example.invalid';
      const c = document.querySelector('[data-pay="counter"]'); if (c) c.click();
      return true;
    })()`);
    /* Typing the number is what a guest does; assigning .value alone fires no
       input event, so the page would still be holding the pre-discount total
       and the server would refuse the order as a total mismatch. Wait for the
       first-time-guest discount to reach the totals before submitting. */
    await cdp.waitFor('!!document.querySelector("#firstVisitBanner.on")',
      10000, 'the first-time-guest discount to apply');
    await cdp.evalJs(`document.querySelector('#placeOrder').click()`);

    /* Wait for the SERVER to have it, not for a toast. */
    let placed = null;
    const until = Date.now() + 25000;
    while (Date.now() < until && !placed) {
      await sleep(400);
      const r = await fetch(BASE + '/api/orders', { headers: adminH() }).then((x) => x.json()).catch(() => null);
      placed = ((r && r.orders) || []).find((o) => (o.customer || {}).phone === GUEST_PHONE);
    }
    check('the order from the poster reached the board', !!placed,
      placed ? 'id=' + placed.id : '(never appeared)');

    check('and it carries the poster it came from',
      !!(placed && placed.source === CLEAN_SRC),
      'source=' + JSON.stringify(placed && placed.source) + ' (from ?src=' + JSON.stringify(RAW_SRC) + ')');
    check('the value was narrowed to a safe token — no spaces, no markup',
      !!(placed && placed.source === CLEAN_SRC),
      'source=' + JSON.stringify(placed && placed.source));

    const errs = cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l));
    check('the page threw nothing while doing it', errs.length === 0, errs.slice(0, 3).join('\n         '));

    /* ---- 2. a guest who came straight to the site ---------------------- */
    console.log('\n--- a guest with no poster: the default ---');
    const plain = await jpost('/api/orders', apiOrder({ token: 'src-plain-' + Date.now().toString(36) }));
    check('a plain order is still recorded', plain.status === 200 && !!plain.j && !!plain.j.id,
      'status=' + plain.status);

    const list2 = await fetch(BASE + '/api/orders', { headers: adminH() }).then((x) => x.json());
    const plainOrder = ((list2 && list2.orders) || []).find((o) => o.id === plain.j.id);
    check('and it is marked storefront, not blank',
      !!(plainOrder && plainOrder.source === 'storefront'),
      'source=' + JSON.stringify(plainOrder && plainOrder.source));

    /* ---- 3. the owner's spreadsheet ----------------------------------- */
    console.log('\n--- the CSV export the owner actually opens ---');
    const csv = await fetch(BASE + '/api/orders/export.csv', { headers: adminH() }).then((r) => r.text());
    const lines = csv.replace(/^\ufeff/, '').split('\r\n').filter(Boolean);
    const head = (lines[0] || '').split(',').map((s) => s.replace(/^"|"$/g, ''));
    const srcCol = head.indexOf('source');
    check('the export has a source column', srcCol !== -1, 'header=' + head.join(','));
    check('and it sits before the item summary, where a human looks for it',
      srcCol !== -1 && srcCol < head.indexOf('itemsSummary'), 'index=' + srcCol);

    const posterRow = (lines.slice(1) || []).find((l) => l.indexOf(placed.id) !== -1) || '';
    const posterCells = posterRow.split(',').map((s) => s.replace(/^"|"$/g, ''));
    check('the poster order exports its source',
      !!posterRow && posterCells[srcCol] === CLEAN_SRC,
      'row source=' + JSON.stringify(posterCells[srcCol]));

    const plainRow = (lines.slice(1) || []).find((l) => l.indexOf(plain.j.id) !== -1) || '';
    const plainCells = plainRow.split(',').map((s) => s.replace(/^"|"$/g, ''));
    check('the plain order exports storefront',
      !!plainRow && plainCells[srcCol] === 'storefront',
      'row source=' + JSON.stringify(plainCells[srcCol]));

    /* A poster nobody controls must not be able to inject a formula or markup
       into the owner's spreadsheet. The client narrows ?src=; this is the
       backstop for a hand-crafted POST that skips the page entirely. */
    const hostile = await jpost('/api/orders', apiOrder({
      token: 'src-hostile-' + Date.now().toString(36),
      source: '=cmd|\' /c calc\'!A1<b>'
    }));
    check('the hostile order is still recorded rather than dropped',
      hostile.status === 200 && !!hostile.j && !!hostile.j.id,
      'status=' + hostile.status + ' id=' + (hostile.j && hostile.j.id));

    const csv2 = await fetch(BASE + '/api/orders/export.csv', { headers: adminH() }).then((r) => r.text());
    const hRow = csv2.split('\r\n').filter(Boolean)
      .find((l) => hostile.j && l.indexOf(hostile.j.id) !== -1) || '';
    check('and it is neutralised in the export, not executed',
      hRow.indexOf("'=cmd") !== -1,
      'row=' + hRow.slice(0, 140));
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
