#!/usr/bin/env node
/* ==========================================================================
   Which order channel does a guest land on? (index.html, real browser)

   The order-type row is the very first thing a guest interacts with, and the
   default is set in two places that must agree:

     * assets/config.js  orderTypes[]  — its ORDER is the display order, and
                                         its first entry is the fallback
     * assets/app.js     state.orderType — the initial selection

   resolveOrderType() returns the guest's current choice if it is still
   available, otherwise the first AVAILABLE entry of CONFIG.orderTypes. So if
   the two disagree, a guest whose default channel is switched off by the owner
   silently lands on whatever happens to be first in CONFIG — which is not
   necessarily the leading card they can see.

   This is a browser test because the failure mode is a *rendered* one: which
   card carries the `.on` class, and whether the fallback moved the ring to the
   card next to it. Pure logic tests cannot see it (that lesson is already in
   the README as pitfall 10, from the payment default).

   Run:  node _dev/probe_guest_defaults.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8951', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9371', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'guest-defaults-key-' + Date.now().toString(36);

/* Hermetic: every state file the server knows about is pointed at scratch, so
   this probe cannot read or write the shop's real orders, switches, menu or
   secrets. STORE_FILE and MENU_FILE were hard-coded until 2026-10-07 — a probe
   that POSTs /api/store would have overwritten the owner's real channel
   switches without any test noticing. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-guest-defaults-'));

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
      await sleep(400);
    }
    throw new Error('timed out waiting for ' + label + ' — last: ' + JSON.stringify(last) +
      (lastErr ? ' (last error: ' + lastErr + ')' : ''));
  }

  return { ws, send, evalJs, waitFor, logs };
}

/* ---- what the page currently shows --------------------------------------- */
const SEL_SELECTED = '(() => { const b = document.querySelector("#otGrid .ot-card.on"); ' +
  'return b ? b.dataset.ot : null; })()';
const SEL_CARDS = '(() => Array.from(document.querySelectorAll("#otGrid .ot-card"))' +
  '.map((b) => b.dataset.ot))()';
const SEL_OFF = '(() => Array.from(document.querySelectorAll("#otGrid .ot-card"))' +
  '.filter((b) => b.classList.contains("off") || b.disabled).map((b) => b.dataset.ot))()';

async function setStore(cdp, body) {
  return fetch(BASE + '/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));
}

async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('!!document.querySelector("#otGrid .ot-card")', 15000, 'the order-type row to render');
}

async function main() {
  console.log('guest defaults — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-guest-defaults-chrome-' + Date.now());

  const cleanup = async () => {
    /* See probe_cleanup.js — killing only the process we spawned and deleting
       the profile straight away leaves a 10–95 MB temp dir behind on Windows,
       silently, every run. */
    await teardown([chrome, server], [SCRATCH, profile]);
  };

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
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_guest_defaults_not_a_real_key'
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

    /* ================================================================== */
    console.log('--- a guest opens the plain link (no query) ---');
    await goto(cdp, BASE + '/');

    const cards = await cdp.evalJs(SEL_CARDS);
    /* Delivery is deliberately hidden from the guest while the channel is off —
       the shipped config's delivery.enabled:false seeds the runtime switch off,
       and the page does not advertise a channel the shop is not taking orders
       on. The card comes back (driven by the RUNTIME switch, not the config
       seed) only once the guest date/window picker exists; surfacing it before
       then would let a guest pick Delivery and hit schedule_required. */
    check('the channel row is Dine-In first, then Pickup (Delivery stays hidden while the channel is off)',
      JSON.stringify(cards) === JSON.stringify(['dinein', 'pickup']),
      'DOM order: ' + JSON.stringify(cards));

    const selected = await cdp.evalJs(SEL_SELECTED);
    check('Dine-In is the selected card by default', selected === 'dinein', 'selected=' + selected);
    check('the header says Dine-In, not Pickup',
      /Dine-In/i.test(await cdp.evalJs('document.querySelector("#storeTag").textContent')),
      await cdp.evalJs('document.querySelector("#storeTag").textContent'));
    check('the table-number field is offered (dine-in needs it)',
      await cdp.evalJs('document.querySelector("#tableWrap").classList.contains("on")'),
      await cdp.evalJs('document.querySelector("#tableWrap").className'));

    /* ================================================================== */
    console.log('\n--- a guest scans a table QR (?table=7) ---');
    await goto(cdp, BASE + '/?table=7');
    check('a table link still selects Dine-In',
      (await cdp.evalJs(SEL_SELECTED)) === 'dinein');
    check('and pre-fills the table number',
      (await cdp.evalJs('document.querySelector("#tableNo").value')) === '7',
      'value=' + (await cdp.evalJs('document.querySelector("#tableNo").value')));

    /* ================================================================== */
    console.log('\n--- a guest explicitly asks for pickup (?type=pickup) ---');
    await goto(cdp, BASE + '/?type=pickup');
    check('an explicit choice beats the default',
      (await cdp.evalJs(SEL_SELECTED)) === 'pickup',
      'selected=' + (await cdp.evalJs(SEL_SELECTED)));

    /* ================================================================== */
    console.log('\n--- the owner switches Dine-In OFF ---');
    const off = await setStore(cdp, { orderTypes: { dinein: false } });
    check('the owner could switch dine-in off', off.status === 200, 'status=' + off.status);

    await cdp.send('Page.navigate', { url: BASE + '/' });
    /* Wait for the switch to actually arrive — the page learns the store state
       from /api/store, so asserting the selection before it lands would read
       the pre-fetch render. */
    await cdp.waitFor('(() => { const b = document.querySelector(\'#otGrid .ot-card[data-ot="dinein"]\'); ' +
      'return !!(b && (b.classList.contains("off") || b.disabled)); })()',
      15000, 'the dine-in card to be marked unavailable');

    const offList = await cdp.evalJs(SEL_OFF);
    check('the dine-in card is shown as unavailable', offList.includes('dinein'),
      'unavailable: ' + JSON.stringify(offList));
    const fallback = await cdp.evalJs(SEL_SELECTED);
    check('the guest falls back to the first AVAILABLE channel (Pickup), not to a dead card',
      fallback === 'pickup', 'selected=' + fallback);
    check('and the table field is hidden again, since the guest is not dining in',
      !(await cdp.evalJs('document.querySelector("#tableWrap").classList.contains("on")')),
      await cdp.evalJs('document.querySelector("#tableWrap").className'));

    /* ================================================================== */
    console.log('\n--- the owner switches Dine-In back ON ---');
    const on = await setStore(cdp, { orderTypes: { dinein: true } });
    check('the owner could switch dine-in back on', on.status === 200, 'status=' + on.status);

    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('(() => { const b = document.querySelector(\'#otGrid .ot-card.on\'); ' +
      'return b && b.dataset.ot === "dinein"; })()',
      15000, 'Dine-In to be the default again');
    check('Dine-In is the default again — the fallback did not stick',
      (await cdp.evalJs(SEL_SELECTED)) === 'dinein',
      'selected=' + (await cdp.evalJs(SEL_SELECTED)));

    /* ---- the page must have thrown nothing --------------------------- */
    const errs = cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l));
    check('the page logged no JavaScript errors', errs.length === 0, errs.slice(0, 3).join('\n         '));

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const dir = path.join(__dirname, 'screens');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'guest-defaults.png');
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
