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
    while (Date.now() < until) {
      try { last = await evalJs(expr); } catch (e) { last = '(ctx) ' + e.message; }
      if (last) return last;
      await sleep(350);
    }
    throw new Error('timed out waiting for ' + label + ' — last: ' + JSON.stringify(last));
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

async function main() {
  console.log('guest discount box — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-guest-discount-chrome-' + Date.now());

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
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
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
    await cdp.waitFor(`(document.querySelector('#cartTotals .trow.disc b')||{}).textContent === '-$3.20'`,
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
