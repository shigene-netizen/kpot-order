#!/usr/bin/env node
/* ==========================================================================
   Button feedback, in a REAL browser.

   The discount probe proves the guest can see their money; this one proves
   the guest can see their TAPS. Three questions no unit test can answer:

     * does the Add button actually turn green with a check, or does the
       class land on an element nobody renders (the classic "CSS written,
       never seen" failure);
     * does the cart badge bounce and the bar pulse when an item lands —
       the animations are ~400ms wide, so they are captured with
       animationstart listeners rather than polled for;
     * does submitting an order hold the button busy for the whole server
       round trip — and does a second tap inside that window really cost
       nothing? The second question is the money one: until this change the
       counter path left the button live while the server was still
       deciding the order number, so an impatient double-tap recorded TWO
       orders. Here the POST is deliberately slowed (window.fetch is
       wrapped) so the whole busy window is observable.

   Run:  node _dev/probe_button_fx.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8954', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9374', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'button-fx-key-' + Date.now().toString(36);
const GUEST = 'Probe Guest';

/* Every state file the server knows about is pointed at scratch, so this
   probe cannot read or write the shop's real orders, switches or secrets. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-button-fx-'));

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

/* The live state of the button we tapped, read straight out of the DOM. */
const ADD_BTN_STATE = `(() => {
  const b = document.querySelector('.add-btn[data-side]');
  if (!b) return null;
  return {
    busy: b.dataset.fxBusy === '1',
    text: b.textContent.trim(),
    inlineBg: b.style.background,
    computedBg: getComputedStyle(b).backgroundColor,
    pinnedWidth: b.style.minWidth !== ''
  };
})()`;

async function main() {
  console.log('button feedback — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-button-fx-chrome-' + Date.now());

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
        /* The business-hours tick holds `open` strictly on the hours clock —
           after closing time it closes the shop under this probe within one
           flush, and a guest page that will not accept orders cannot be
           driven through a cart at all. A 24h spec keeps the shop open at any
           clock; production never sets this. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_button_fx_not_a_real_key'
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

    /* The suite runs at any hour — the shop's real hours must not decide
       whether this probe can place an order. */
    const open = await fetch(BASE + '/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ open: true, acceptingOrders: true })
    });
    check('the store is forced open for this run (hours must not gate the probe)', open.ok, 'status=' + open.status);

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

    await cdp.send('Page.navigate', { url: BASE + '/' });
    /* #cartBar is static HTML, so it exists before app.js has booted — wait
       for something only the running app renders. */
    await cdp.waitFor('!!document.querySelector("[data-cat=\\"sides\\"]")', 15000, 'the menu tabs to render');

    /* The animations are ~400ms wide — far too short to poll for reliably,
       so their START is recorded in the page and read once at the end. */
    await cdp.evalJs(`(() => {
      window.__fx = { bumped: false, attn: false };
      const badge = document.querySelector('#cartBadge');
      if (badge) badge.addEventListener('animationstart', (e) => {
        if (e.animationName === 'fxBump') window.__fx.bumped = true;
      });
      const barBtn = document.querySelector('#cartBarBtn');
      if (barBtn) barBtn.addEventListener('animationstart', (e) => {
        if (e.animationName === 'fxAttn') window.__fx.attn = true;
      });
      return true;
    })()`);

    /* ---- the add flash ------------------------------------------------- */
    section('tapping Add');
    await cdp.evalJs(`document.querySelector('[data-cat="sides"]').click()`);
    await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 10000, 'the A La Carte list');

    await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
    /* addToCart runs to completion synchronously — no await happens before
       flashAdded() — so the state below is read while the flash is still on. */
    const st = await cdp.evalJs(ADD_BTN_STATE);
    check('the tapped Add button is in its flash state', !!st && st.busy, JSON.stringify(st));
    check('it says "Added" with a check, not just a toast somewhere else',
      !!st && /Added/.test(st.text), 'text=' + (st && st.text));
    check('the green is set inline on the element itself', !!st && st.inlineBg === 'var(--green)',
      'inline=' + (st && st.inlineBg));
    check('its width is pinned so the row does not jump', !!st && st.pinnedWidth);

    const badgeTxt = await cdp.evalJs(`document.querySelector('#cartBadge').textContent`);
    check('the cart badge counts the item', badgeTxt === '1', 'badge=' + badgeTxt);

    section('the badge bounce');
    const bounced = await cdp.waitFor('window.__fx && window.__fx.bumped === true', 4000, 'the badge animation to start');
    check('the badge bounce animation really started', bounced === true);

    /* .stepper button carries a .14s all-properties transition, so the green
       FADES in. Read the computed colour after the fade, not before it —
       otherwise this asserts the red it is still showing at t=0. */
    await sleep(260);
    const painted = await cdp.evalJs(`(() => {
      const b = document.querySelector('.add-btn[data-side]');
      return b ? { busy: b.dataset.fxBusy === '1', bg: getComputedStyle(b).backgroundColor } : null;
    })()`);
    check('once the 140ms fade is done, the button is really green on screen',
      !!painted && painted.busy && painted.bg === 'rgb(52, 199, 123)', JSON.stringify(painted));

    section('the button puts itself back');
    await sleep(1200);
    const back = await cdp.evalJs(ADD_BTN_STATE);
    check('about a second later the button is a plain "Add" again',
      !!back && !back.busy && back.text === 'Add' && back.inlineBg === '',
      JSON.stringify(back));

    const barOn = await cdp.evalJs(`document.querySelector('#cartBar').classList.contains('on')`);
    check('the cart bar is showing', barOn === true);
    const attn = await cdp.evalJs(`window.__fx.attn === true`);
    check('and it pulsed once when it appeared', attn === true);

    section('a second tap during the flash is ignored');
    await cdp.evalJs(`(() => {
      const b = document.querySelector('.add-btn[data-side]');
      b.click(); b.click();
      return true;
    })()`);
    const afterDouble = await cdp.evalJs(`document.querySelector('#cartBadge').textContent`);
    check('two fast taps add ONE item, not two (the flash doubles as a tap lock)',
      afterDouble === '2', 'badge=' + afterDouble);

    /* ---- the submit button --------------------------------------------- */
    section('submitting');
    await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
    await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
    await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
    await cdp.waitFor('!!document.querySelector("#placeOrder")', 10000, 'the checkout sheet');

    await cdp.evalJs(`(() => {
      const n = document.querySelector('#cName'); if (n) n.value = ${JSON.stringify(GUEST)};
      const p = document.querySelector('#cPhone'); if (p) p.value = '4045550142';
      /* E-mail became required (order-ready notification + reward contact) —
         a probe that leaves it blank is stopped by the same validation a
         guest is, before the submit path this probe exists to test. */
      const e = document.querySelector('#cEmail'); if (e) e.value = 'button-fx-probe@example.invalid';
      const c = document.querySelector('[data-pay="counter"]'); if (c) c.click();
      return true;
    })()`);

    /* Slow the POST that records the order, so the whole busy window is
       observable instead of a few milliseconds of luck. */
    await cdp.evalJs(`(() => {
      const orig = window.fetch;
      window.fetch = function (u, o) {
        if (String(u).indexOf('/api/orders') !== -1 && o && o.method === 'POST') {
          return new Promise((res) => setTimeout(() => res(orig.apply(this, arguments)), 1500));
        }
        return orig.apply(this, arguments);
      };
      return true;
    })()`);

    await cdp.evalJs(`document.querySelector('#placeOrder').click()`);
    const busy = await cdp.evalJs(`(() => {
      const b = document.querySelector('#placeOrder');
      if (!b) return null;
      return { disabled: b.disabled, spinner: !!b.querySelector('.fx-spin'), label: b.textContent.trim(), cls: b.className };
    })()`);
    check('while the server decides, the button is disabled with a spinner',
      !!busy && busy.disabled && busy.spinner, JSON.stringify(busy));
    check('and it says so in words', !!busy && /Submitting/.test(busy.label), 'label=' + (busy && busy.label));

    /* The impatient double-tap, inside the busy window. */
    await cdp.evalJs(`document.querySelector('#placeOrder').click()`);
    await sleep(300);
    const stillBusy = await cdp.evalJs(`(() => {
      const b = document.querySelector('#placeOrder');
      return b ? b.disabled : null;
    })()`);
    check('a second tap changes nothing — the button is locked', stillBusy === true);

    /* Wait for the (single) order to land on the board. */
    let mine = [];
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const r = await fetch(BASE + '/api/orders?since=1970-01-01T00:00:00Z', { headers: { 'x-admin-key': ADMIN_KEY } });
      const j = await r.json().catch(() => ({}));
      mine = (j.orders || []).filter((o) => o.customer && o.customer.name === GUEST);
      if (mine.length) break;
      await sleep(400);
    }
    check('ONE order reached the board — the double-tap cost nothing',
      mine.length === 1, 'orders=' + mine.length);
    if (mine.length) {
      check('it went through as a pay-at-counter order',
        mine[0].payMethod === 'counter' && mine[0].paymentStatus === 'counter',
        'payMethod=' + mine[0].payMethod + ' paymentStatus=' + mine[0].paymentStatus);
      check('and the two sides are on it', mine[0].items && mine[0].items.length >= 1,
        'items=' + (mine[0].items || []).map((i) => i.name + ' x' + i.qty).join(', '));
    }

    const cartEmpty = await cdp.waitFor(`!document.querySelector('#cartBar.on')`, 8000, 'the cart to empty after the order');
    check('the cart emptied itself once the order was placed', cartEmpty === true);

    check('nothing threw in the page', cdp.logs.length === 0, cdp.logs.slice(0, 3).join(' | '));
    check('the server never reached for a live key',
      !/live mode/.test(serverLog), serverLog.split('\n').filter((l) => /key/i.test(l)).slice(0, 2).join(''));

    console.log('\n' + '-'.repeat(74));
    console.log(pass + ' passed, ' + fail + ' failed');
    await cleanup();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nPROBE ERROR: ' + e.message);
    if (cdp && cdp.logs.length) console.error('page logs: ' + cdp.logs.slice(0, 5).join('\n'));
    console.error('server log tail: ' + serverLog.slice(-600));
    await cleanup();
    process.exit(1);
  }
}

function section(t) { console.log('\n' + t); }

main();
