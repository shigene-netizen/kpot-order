#!/usr/bin/env node
/* ==========================================================================
   The rewards panel, in a REAL browser.

   Every other loyalty test stops at the API. This one covers the panel the
   guest actually taps, and it exists because of two bugs that no API test can
   see:

     1. THE ROWS STOPPED RESPONDING. bindLoyaltyBox() attached an onclick to
        each row, but renderLoyaltyBox() replaces the box's innerHTML — and it
        runs again after every reprice. The handlers were gone before the guest
        could tap. Nothing threw; the panel simply did nothing. So the probe
        taps the SAME row twice: the second tap only works if the handler
        survived the re-render the first tap caused.

     2. A COUNTDOWN NEXT TO A POINTS BALANCE. The owner read "$5 off — come
        back within 14 days / Expires 10/29" next to "You have 12 points" and
        concluded the POINTS expire. That reward is now switched off, and the
        panel has to say so out loud: nothing may carry an expiry, and the
        points line must state that points never expire.

   Asserted against the DOM — which row carries .on and what the TOTAL reads —
   never against the state variable that produced it (pitfall 10).

   Run:  node _dev/probe_loyalty_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8957', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9377', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'loyalty-ui-key-' + Date.now().toString(36);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-loyalty-ui-'));
const CUSTOMERS_FILE = path.join(SCRATCH, 'customers.local.json');

const PHONE = '6783355388';
const PHONE_TYPED = '(678) 335-5388';
/* The state in the owner's screenshot: a guest still short of the first block. */
const PHONE_LOW = '6783355399';
const PHONE_LOW_TYPED = '(678) 335-5399';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

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

/* The guests, as the ledger stores them: one with 120 points (so a $5 block is
   redeemable) plus a NON-EXPIRING $10 stamp reward, and one still short of the
   first block — the state in the owner's screenshot. */
const guest = (phone, name, points, lifetime, settled, coupons) => ({
  phone: phone,
  name: name,
  points: points,
  lifetimePoints: lifetime,
  settledOrders: settled,
  stampsIssued: 0,
  coupons: coupons || [],
  settledOrderIds: [],
  log: [],
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  memberUntil: null,
  memberCouponIssuedFor: null
});

const seedCustomer = () => ({
  updatedAt: new Date().toISOString(),
  customers: [
    guest(PHONE, 'Bob Smith', 120, 260, 10, [{
      id: 'cp_probe_stamp_1',
      kind: 'stamp',
      value: 10,
      label: '$10 reward — 10 orders',
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      usedAt: null,
      usedOn: '',
      orderId: ''
    }]),
    guest(PHONE_LOW, 'Carol Jones', 12, 12, 2, [])
  ]
});

/* Everything the panel shows, in one read. */
const PANEL = `(() => {
  const box = document.querySelector('#loyaltyBox');
  if (!box) return { present: false };
  const rows = Array.from(box.querySelectorAll('.loy-row')).map((b) => ({
    loy: b.dataset.loy,
    on: b.classList.contains('on'),
    text: (b.textContent || '').replace(/\\s+/g, ' ').trim()
  }));
  const notes = Array.from(box.querySelectorAll('.loy-note')).map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim());
  return { present: true, rows: rows, notes: notes, all: (box.textContent || '').replace(/\\s+/g, ' ').trim() };
})()`;

const GRAND = `(() => {
  const b = document.querySelector('#checkoutTotals .trow.grand b');
  return b ? b.textContent.trim() : null;
})()`;

/* The whole totals block, so the expected new total can be DERIVED rather than
   hard-coded: the discount comes off before tax, so a reward changes the
   total twice (the reward, and the tax on what is left). */
const TOTALS = `(() => {
  const rows = Array.from(document.querySelectorAll('#checkoutTotals .trow'));
  const get = (name) => {
    const r = rows.find((x) => x.querySelector('span') && x.querySelector('span').textContent.trim().indexOf(name) === 0);
    return r ? (r.querySelector('b') ? r.querySelector('b').textContent : '') : '';
  };
  return { subtotal: get('Subtotal'), tax: get('Tax'), total: get('Total') };
})()`;

const money = (s) => {
  const n = Number(String(s || '').replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : NaN;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* Wait for the total to BECOME the value we are about to assert. Reading the
   total straight after a tap reads the pre-reprice number, because
   chooseLoyalty() re-asks the server before it repaints — pitfall 27. */
async function waitForTotal(cdp, expected, label) {
  await cdp.waitFor(`(() => {
    const b = document.querySelector('#checkoutTotals .trow.grand b');
    if (!b) return false;
    const n = Number(String(b.textContent).replace(/[^0-9.]/g, ''));
    return Math.abs(n - ${expected}) < 0.02;
  })()`, 12000, label);
}

async function addItemAndOpenCheckout(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('!!document.querySelector("[data-cat=\\"sides\\"]")', 15000, 'the menu to render');
  await cdp.evalJs(`document.querySelector('[data-cat="sides"]').click()`);
  await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 10000, 'the A La Carte list');
  /* ONE item on purpose. The basket stays small enough that the $10 reward is
     CLAMPED to the subtotal — the same clamp pricing.js applies to a dollar
     code — and expectedTotal() mirrors that, so the assertion is exact rather
     than a shrug at a zero. */
  await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
  await cdp.waitFor(`(() => { const b = document.querySelector('#cartBadge'); return !!(b && /[1-9]/.test(b.textContent)); })()`,
    8000, 'the cart to hold an item');
  await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
  await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
  await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
  await cdp.waitFor('!!document.querySelector("#cPhone")', 10000, 'the checkout form');
  await cdp.waitFor('!!document.querySelector("#checkoutTotals .trow")', 8000, 'the checkout totals');
}

async function typePhone(cdp, typed, expectName) {
  await cdp.evalJs(`(() => {
    const i = document.querySelector('#cPhone');
    i.value = ${JSON.stringify(typed)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  })()`);
  /* Wait for THIS guest, not merely for a panel: the previous guest's rows are
     still on screen, so waiting for ".loy-row" would pass instantly and read
     the wrong person's balance. */
  await cdp.waitFor(`(() => {
    const b = document.querySelector('#loyaltyBox');
    return !!(b && b.textContent.indexOf(${JSON.stringify(expectName)}) !== -1);
  })()`, 12000, 'the panel to show ' + expectName);
  await cdp.waitFor('!!document.querySelector("#loyaltyBox .loy-row")', 8000, 'the rewards panel');
}

async function clickRow(cdp, loy) {
  await cdp.evalJs(`(() => {
    const b = document.querySelector('#loyaltyBox .loy-row[data-loy="' + ${JSON.stringify(loy)} + '"]');
    if (!b) throw new Error('no row ' + ${JSON.stringify(loy)});
    b.click();
    return true;
  })()`);
}

async function main() {
  console.log('the rewards panel — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-loyalty-ui-chrome-' + Date.now());

  const cleanup = async () => {
    await teardown([chrome, server], [SCRATCH, profile]);
  };

  try {
    /* Seeded BEFORE the server starts, so it is the ledger it boots with. */
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(seedCustomer(), null, 2));

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ADMIN_KEY,
        KPOT_FLUSH_MS: '500',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: CUSTOMERS_FILE,
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_loyalty_ui_not_a_real_key'
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
    section('the guest types their number and the panel appears');
    await addItemAndOpenCheckout(cdp, BASE + '/?type=pickup');
    const t0 = await cdp.evalJs(TOTALS);
    const sub0 = money(t0.subtotal);
    const before = money(t0.total);
    const rate = money(t0.tax) / sub0;
    /* What the total should become once `disc` comes off — the reward, then the
       tax on what is left. The server CLAMPS a reward to the subtotal (the same
       clamp pricing.js applies to a dollar code), so mirror that here or the
       expectation would be a negative total. */
    const expectedTotal = (disc) => {
      const d = Math.min(disc, sub0);
      return round2((sub0 - d) + round2((sub0 - d) * rate));
    };
    await typePhone(cdp, PHONE_TYPED, 'Bob S.');

    const panel = await cdp.evalJs(PANEL);
    check('the rewards panel rendered', panel.present === true, JSON.stringify(panel));
    check('it shows the points balance and what that block is worth',
      /120 points/.test(panel.all) && /Use 100 points/i.test(panel.all) && /-\$5\.00/.test(panel.all),
      panel.all);
    check('and it names the $10 order reward',
      /\$10 reward/.test(panel.all), panel.all);

    /* ================================================================== */
    section('nothing on the panel carries a countdown');
    /* The owner's exact complaint: a date next to a points balance reads as
       "your points expire". */
    /* Look for a COUNTDOWN, not the word: the panel now says "never expire",
       which a naive /expire/ would flag. What must not be there is an expiry
       claim or a date. */
    check('no expiry date anywhere in the panel',
      !/expires/i.test(panel.all) && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(panel.all), panel.all);
    check('and the points line states the promise, even when it CAN be redeemed',
      /never expire/i.test(panel.all), panel.all);
    check('the rows on offer are: later / points / the reward',
      panel.rows.length === 3, JSON.stringify(panel.rows));
    check('with "keep for later" chosen by default',
      panel.rows[0].on === true && panel.rows.filter((r) => r.on).length === 1,
      JSON.stringify(panel.rows));

    /* ================================================================== */
    section('the guest can actually TAP a reward');
    await clickRow(cdp, 'points');
    await waitForTotal(cdp, expectedTotal(5), 'the bill to drop by $5');
    const withPoints = await cdp.evalJs(PANEL);
    const afterPoints = money(await cdp.evalJs(GRAND));
    check('tapping the points row selects it',
      withPoints.rows.find((r) => r.loy === 'points').on === true, JSON.stringify(withPoints.rows));
    check('and the bill really moves (100 points = $5, tax recomputed)',
      Math.abs(afterPoints - expectedTotal(5)) < 0.02,
      'subtotal=' + sub0 + ' before=' + before + ' after=' + afterPoints +
      ' expected=' + expectedTotal(5));

    /* The re-render happened on that tap. Tapping a DIFFERENT row now only
       works if the handler survived it — which is the whole bug. */
    await clickRow(cdp, 'cp_probe_stamp_1');
    await waitForTotal(cdp, expectedTotal(10), 'the bill to drop by $10');
    const withCoupon = await cdp.evalJs(PANEL);
    const afterCoupon = money(await cdp.evalJs(GRAND));
    check('a SECOND tap still works after the panel re-rendered',
      withCoupon.rows.find((r) => r.loy === 'cp_probe_stamp_1').on === true,
      JSON.stringify(withCoupon.rows));
    check('one reward at a time: the points row let go',
      withCoupon.rows.find((r) => r.loy === 'points').on === false,
      JSON.stringify(withCoupon.rows));
    check('and the bill now shows the $10 reward instead',
      Math.abs(afterCoupon - expectedTotal(10)) < 0.02,
      'after=' + afterCoupon + ' expected=' + expectedTotal(10));

    /* ================================================================== */
    section('and can take it back off');
    await clickRow(cdp, '');
    await waitForTotal(cdp, before, 'the bill to go back to full price');
    const cleared = await cdp.evalJs(PANEL);
    const afterClear = money(await cdp.evalJs(GRAND));
    check('"keep my rewards for later" clears the choice',
      cleared.rows.filter((r) => r.on).length === 1 && cleared.rows[0].on === true,
      JSON.stringify(cleared.rows));
    check('and the bill goes back to full price',
      Math.abs(afterClear - before) < 0.02, 'before=' + before + ' after=' + afterClear);

    /* ================================================================== */
    section('a guest who is not there yet — the state in the screenshot');
    /* This is the exact panel the owner read as "my points expire": a balance
       under 100, with a countdown beside it. The countdown is gone, and the
       promise is spelled out instead. */
    await typePhone(cdp, PHONE_LOW_TYPED, 'Carol J.');
    const low = await cdp.evalJs(PANEL);
    check('the guest is recognised', /Carol J\./.test(low.all), low.all);
    check('the balance and how far to go are shown',
      /12 points/.test(low.all) && /88 more for \$5 off/i.test(low.all), low.all);
    check('and the promise is stated right there',
      /Points never expire/i.test(low.all), low.all);
    check('with no expiry claim and no date anywhere',
      !/expires/i.test(low.all) && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(low.all), low.all);
    check('and nothing to redeem yet, so only "keep for later" is offered',
      low.rows.length === 1 && low.rows[0].on === true, JSON.stringify(low.rows));

    /* ---- the page must have thrown nothing --------------------------- */
    const errs = cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l));
    check('the page logged no JavaScript errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
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
