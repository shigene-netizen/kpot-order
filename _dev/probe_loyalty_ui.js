#!/usr/bin/env node
/* ==========================================================================
   The rewards panel, in a REAL browser.

   Every other loyalty test stops at the API. This one covers the panel the
   guest actually taps, and it exists because of bugs no API test can see:

     1. THE ROWS STOPPED RESPONDING. bindLoyaltyBox() attached an onclick to
        each row, but renderLoyaltyBox() replaces the box's innerHTML — and it
        runs again after every reprice. The handlers were gone before the guest
        could tap. Nothing threw; the panel simply did nothing. So the probe
        taps the SAME row twice: the second tap only works if the handler
        survived the re-render the first tap caused.

     2. A COUNTDOWN NEXT TO A POINTS BALANCE. The owner read "$5 off — come
        back within 14 days / Expires 10/29" next to "You have 12 points" and
        concluded the POINTS expire. So the panel may not put a date on the
        points line or the stamp card. Note the assertion is "no DATE", not
        "no /expire/" — the panel says "never expire" on purpose, and a naive
        /expire/ flags the fix itself (it did, on the first run).

     3. A PHONE NUMBER WAS ENOUGH, THEN IT WASN'T, THEN IT WAS AGAIN. The panel
        used to render a full balance for whoever typed a number; for six weeks
        it stayed locked until the browser proved the number was its own; and on
        2026-10-16 the owner reversed that ("不需要EMAIL验证了，凭手机号码就可以领奖
        励了"), having been shown that the number is printed on every order ticket
        (printer.js:153). So the panel shows the balance to whoever types the
        number — and this probe's job is to prove that typing a number is all it
        takes, with no unlock step in between. The old locked-panel and
        counter-code assertions are gone with the flow they tested;
        probe_phone_rewards.js pins the API half of the same decision.

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
   first block — the state in the owner's screenshot.

   NEITHER has a device credential, on purpose. That is the state a guest
   arrives in on a phone they have never ordered from, and the panel has to
   stay locked until they prove the number is theirs. */
const guest = (phone, name, points, lifetime, settled, coupons) => ({
  phone: phone,
  name: name,
  email: '',
  points: points,
  lifetimePoints: lifetime,
  settledOrders: settled,
  stampsIssued: 0,
  coupons: coupons || [],
  devices: [],
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
    guest(PHONE, 'Bob Smith', 120, 260, 10, [
      {
        id: 'cp_probe_stamp_1',
        kind: 'stamp',
        value: 7,
        label: '$7 reward — 10 orders',
        issuedAt: new Date().toISOString(),
        expiresAt: null,
        usedAt: null,
        usedOn: '',
        orderId: ''
      },
      /* The come-back coupon, which the owner asked to keep ON. It is the ONE
         reward that is meant to be used soon, so it is the one row allowed to
         carry a date — and the probe says so out loud, because "no date
         anywhere" would be the wrong rule for a reward with a deadline. */
      {
        id: 'cp_probe_return_1',
        kind: 'return',
        value: 3,
        label: '$3 off — come back soon',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
        usedAt: null,
        usedOn: '',
        orderId: ''
      }
    ]),
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
    clickable: b.tagName === 'BUTTON',
    text: (b.textContent || '').replace(/\\s+/g, ' ').trim()
  }));
  const notes = Array.from(box.querySelectorAll('.loy-note')).map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim());
  /* The stamp card's progress bar, read off the inline width it was drawn with. */
  const bars = Array.from(box.querySelectorAll('.loy-bar')).map((b) => {
    const i = b.querySelector('i');
    return { label: b.getAttribute('aria-label'), width: i ? i.style.width : '' };
  });
  /* The [data-rec] buttons were the unlock flow's — an e-mail form, a code
     box and the "I have a code from the counter" link. All three went on
     2026-10-16. The query stays so any that reappears is reported by name. */
  const buttons = Array.from(box.querySelectorAll('[data-rec]')).map((b) => b.dataset.rec);
  return {
    present: true, rows: rows, notes: notes, bars: bars, buttons: buttons,
    all: (box.textContent || '').replace(/\\s+/g, ' ').trim(),
    html: box.innerHTML
  };
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

/* A countdown is a DATE, not the word "expires" — the panel says "never
   expires" on purpose, and asserting on /expire/ would flag the fix itself. */
const hasDate = (t) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(String(t || ''));

/* Stands in for the owner's console: this is how a counter-issued code is
   minted. Admin-gated, exactly as the real back office is. */
const postJson = (route, body) => fetch(BASE + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
  body: JSON.stringify(body)
}).then((r) => r.json().catch(() => ({})));

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

/* Type a number and wait for the lookup to SETTLE.

   Deliberately not "wait for the locked panel" or "wait for the name": that
   would make the wait itself carry the assertion, so a broken panel would hang
   the probe at step one instead of reporting which expectations failed. This
   waits for the box to become SOMETHING NEW that is not the "checking…"
   placeholder, and leaves every claim about what it says to the checks. */
async function typePhone(cdp, typed) {
  const before = await cdp.evalJs(
    `(document.querySelector('#loyaltyBox') || {}).textContent || ''`);
  await cdp.evalJs(`(() => {
    const i = document.querySelector('#cPhone');
    i.value = ${JSON.stringify(typed)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor(`(() => {
    const b = document.querySelector('#loyaltyBox');
    if (!b) return false;
    const t = (b.textContent || '').trim();
    if (!t) return false;
    if (t.indexOf('Checking your rewards') !== -1) return false;
    return t !== ${JSON.stringify(before)};
  })()`, 12000, 'the rewards panel to settle');
}

/* Clear the field and type it again. The panel is cached against the number,
   so re-typing the SAME digits would only redraw what is already on screen —
   and the basket size is part of what that was computed with. */
async function retypePhone(cdp, typed) {
  await cdp.evalJs(`(() => {
    const i = document.querySelector('#cPhone');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor(`(() => {
    const b = document.querySelector('#loyaltyBox');
    return !!(b && !/[0-9] points|rewards on this number|Rewards ·/.test(b.textContent || ''));
  })()`, 8000, 'the panel to drop the guest');
  await typePhone(cdp, typed);
}

/* The counter-code unlock this used to drive is GONE with the e-mail recovery
   path it belonged to. There is nothing to unlock: a phone number IS the
   credential since 2026-10-16. */

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
        /* The business-hours tick holds `open` strictly on the hours clock —
           after closing time it closes the shop under this probe within one
           flush, and a guest page that will not accept orders cannot be
           driven through a cart at all. A 24h spec keeps the shop open at any
           clock; production never sets this. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
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
    let sub0 = money(t0.subtotal);
    let before = money(t0.total);
    const rate = money(t0.tax) / sub0;
    /* The basket holds N copies of the same side, so the total for any count
       is arithmetic on the first read. */
    const basketTotal = (n) => round2((sub0 * n) + round2((sub0 * n) * rate));
    /* What the total should become once `disc` comes off — the reward, then the
       tax on what is left. The server CLAMPS a reward to the subtotal (the same
       clamp pricing.js applies to a dollar code), so mirror that here or the
       expectation would be a negative total. */
    const expectedTotal = (disc) => {
      const d = Math.min(disc, sub0);
      return round2((sub0 - d) + round2((sub0 - d) * rate));
    };
    /* ================================================================== */
    section('a bare phone number is ALL it takes — the panel opens');
    await typePhone(cdp, PHONE_TYPED);

    /* No step in between: no e-mail form, no code box, no "confirm this
       number". The typed number IS the credential as of 2026-10-16. If a
       locked panel is ever rendered again, every assertion below this point is
       the thing that notices. */
    const panel = await cdp.evalJs(PANEL);
    check('the rewards panel rendered', panel.present === true, JSON.stringify(panel));
    check('and it shows the guest by name, straight from the typed number',
      /Bob S\./.test(panel.all), panel.all);
    check('with NO lock notice anywhere in the box',
      !/You have rewards on this number/.test(panel.all) &&
      !/data-rec/.test(panel.html || ''),
      panel.all);
    /* The basket is ONE $8.99 side and a points block is $10 — so the guest
       already HAS the points and still has nothing they can tap. The old note
       would have read "80 more for $10 off", which is a lie: what is missing is
       a big enough basket, not more points. This is the sentence the $10 block
       made necessary. */
    check('with a basket too small for a $10 block it says so',
      /120 points/.test(panel.all) && /enough for \$10 off on an order of \$10 or more/.test(panel.all),
      panel.all);
    check('and does NOT tell them to go and earn more points',
      !/more for \$10 off/.test(panel.all), panel.all);
    check('while still stating the promise', /Points never expire/i.test(panel.all), panel.all);
    check('and offers the $7 stamp reward on its own row',
      /Ready! Pick this to take \$7 off/.test(panel.all), panel.all);
    check('the stamp card is drawn as a progress bar, not a line of text',
      panel.bars.length === 1 && /of 10/.test(panel.bars[0].label || ''),
      JSON.stringify(panel.bars));
    check('and a completed card is a row the guest can PICK',
      panel.rows.some((r) => r.loy === 'cp_probe_stamp_1' && r.clickable === true),
      JSON.stringify(panel.rows));

    /* The basket for the rest of the probe is the SECOND side on the list —
       $12.99 — chosen because a points block is $10 and the first side ($8.99)
       is deliberately just under it. One item, one click: a second tap on the
       same button lands inside flashAdded()'s 950ms tap lock and is silently
       dropped, which is exactly the sort of thing a probe should not depend on.
       The under-$10 case is covered on its own below, with an empty basket. */

    /* ---- the basket grows past $10 -------------------------------------- */
    section('a bigger basket brings the points block into reach');
    /* A DIFFERENT button, not the same one twice: flashAdded() locks the
       button that was just tapped for 950ms and silently drops a second tap,
       and this probe moves fast enough to land inside that window. The second
       side is $12.99, which takes the basket over the $10 a block needs. */
    /* A guest who wants a bigger basket LEAVES the form, adds another side and
       comes back. That re-render is what makes the totals honest again: the
       totals block is drawn by openCheckout(), and adding from behind the
       sheet only moves the cart. Closing and reopening is therefore the
       realistic path, not a workaround. */
    await cdp.evalJs(`document.querySelector('.sheet .close[data-close]').click()`);
    await cdp.waitFor(`(() => !document.querySelector('.sheet.on'))()`, 8000, 'the form to close');
    /* Past flashAdded()'s 950ms tap lock on the button tapped at the start of
       the probe. This page is quick, and a second tap inside that window is
       dropped without a word — which is right for a double-tap and wrong for a
       probe that has not waited. */
    await sleep(1200);
    await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
    await sleep(500);
    await cdp.waitFor(`(() => { const b = document.querySelector('#cartBadge'); return !!(b && /[2-9]/.test(b.textContent)); })()`,
      8000, 'the cart to hold two sides');
    await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
    await cdp.waitFor('!!document.querySelector("#toCheckout")', 8000, 'the cart sheet');
    await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
    await cdp.waitFor('!!document.querySelector("#cPhone")', 8000, 'the checkout form');
    await waitForTotal(cdp, basketTotal(2), 'the second side on the basket');
    await retypePhone(cdp, PHONE_TYPED);

    const panel2 = await cdp.evalJs(PANEL);
    check('the points row is now there to tap, at its real value',
      /Use 100 points/i.test(panel2.all) && /-\$10\.00/.test(panel2.all), panel2.all);
    check('and the "order too small" sentence is gone',
      !/enough for \$10 off on an order/.test(panel2.all), panel2.all);

    /* ================================================================== */
    section('which rows carry a countdown — and which must not');
    /* The owner's exact complaint: a date next to a points balance reads as
       "your points expire". So the rule is NOT "no /expire/ anywhere" — the
       panel says "never expire" on purpose, and a naive /expire/ would flag
       the fix itself (it did, first run). The rule is: no DATE on the points
       line, none on the stamp card, and the come-back coupon is the one row
       that may — and must — carry its own.

       These read panel2 — the state where the points row is genuinely
       redeemable — because that is the exact panel the owner read as "my
       points expire". */
    const pointsRow = panel2.rows.find((r) => r.loy === 'points');
    check('the points line carries no date',
      !!pointsRow && !hasDate(pointsRow.text), JSON.stringify(pointsRow));
    check('and states the promise, even when it CAN be redeemed',
      !!pointsRow && /never expire/i.test(pointsRow.text), JSON.stringify(pointsRow));
    const stampRow = panel2.rows.find((r) => r.loy === 'cp_probe_stamp_1');
    check('the stamp card carries no date either',
      !!stampRow && !hasDate(stampRow.text), JSON.stringify(stampRow));
    const retRow = panel2.rows.find((r) => r.loy === 'cp_probe_return_1');
    check('the come-back coupon is ON — the owner asked for that',
      !!retRow, JSON.stringify(panel2.rows));
    check('and it is the one row WITH a countdown, because it has a deadline',
      !!retRow && /come back within/i.test(retRow.text) && hasDate(retRow.text),
      retRow ? retRow.text : JSON.stringify(panel2.rows));
    check('the rows on offer are: later / points / the stamp reward / the come-back coupon',
      panel2.rows.length === 4, JSON.stringify(panel2.rows));
    check('with "keep for later" chosen by default',
      panel2.rows[0].on === true && panel2.rows.filter((r) => r.on).length === 1,
      JSON.stringify(panel2.rows));
    check('and the panel says out loud that rewards do not stack',
      /One reward per order/i.test(panel2.all), panel2.all);

    /* Two of the same $8.99 side are on the basket now, so every total below is
       measured against that. `before` first: basketTotal() reads sub0, and
       reassigning it first would count the basket twice. */
    before = basketTotal(2);
    sub0 = round2(sub0 * 2);

    /* ================================================================== */
    section('the guest can actually TAP a reward');
    await clickRow(cdp, 'points');
    await waitForTotal(cdp, expectedTotal(10), 'the bill to drop by $10');
    const withPoints = await cdp.evalJs(PANEL);
    const afterPoints = money(await cdp.evalJs(GRAND));
    check('tapping the points row selects it',
      withPoints.rows.find((r) => r.loy === 'points').on === true, JSON.stringify(withPoints.rows));
    check('and the bill really moves (100 points = $10, tax recomputed)',
      Math.abs(afterPoints - expectedTotal(10)) < 0.02,
      'subtotal=' + sub0 + ' before=' + before + ' after=' + afterPoints +
      ' expected=' + expectedTotal(10));

    /* The re-render happened on that tap. Tapping a DIFFERENT row now only
       works if the handler survived it — which is the whole bug. */
    await clickRow(cdp, 'cp_probe_stamp_1');
    await waitForTotal(cdp, expectedTotal(7), 'the bill to drop by $7');
    const withCoupon = await cdp.evalJs(PANEL);
    const afterCoupon = money(await cdp.evalJs(GRAND));
    check('a SECOND tap still works after the panel re-rendered',
      withCoupon.rows.find((r) => r.loy === 'cp_probe_stamp_1').on === true,
      JSON.stringify(withCoupon.rows));
    check('one reward at a time: the points row let go',
      withCoupon.rows.find((r) => r.loy === 'points').on === false,
      JSON.stringify(withCoupon.rows));
    check('and the bill now shows the $7 reward instead',
      Math.abs(afterCoupon - expectedTotal(7)) < 0.02,
      'after=' + afterCoupon + ' expected=' + expectedTotal(7));

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
    /* A different number on the SAME browser. It used to have to be unlocked
       separately, because the credential was scoped to one number; now the
       number is the credential, so the panel simply shows Carol. What IS still
       worth pinning is that the panel rebuilds from Carol's own data rather
       than keeping Bob's rows on screen. */
    await typePhone(cdp, PHONE_LOW_TYPED);
    const carol = await cdp.evalJs(PANEL);
    check('a second number on the same browser shows that number\'s own panel',
      /Carol J\./.test(carol.all) && !/Bob S\./.test(carol.all), carol.all);

    /* ================================================================== */
    section('and the probe leaves nothing behind');
    cdp.logs.forEach((l) => console.log('      ' + l));
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
