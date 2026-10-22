#!/usr/bin/env node
/* ==========================================================================
   Delivery, as the GUEST sees it: free, and not payable at the counter.
   (index.html, real browser + real server)

   Three things this file exists to catch, all of which are rendered-state bugs
   that pure logic cannot see:

     1. THE FREE DELIVERY LINE. The shop charges $0 for delivery right now (a
        promotion) and shows the old $1.99 struck through so the guest can see
        the saving. A free line is exactly the case where a renderer decides to
        DROP the row instead of showing "FREE" — and the totals are built in
        three separate places in app.js, which is how they drifted before. So
        both the cart sheet and the checkout are checked, not just one.

     2. PAY AT THE COUNTER IS REFUSED ON DELIVERY. The rule is enforced on the
        server (probe_counter_cap_http.js proves that). What is checked here is
        the part the server cannot do for the guest: the counter card is shown
        DISABLED with the reason, and the guest is not left selected on an
        option that would be refused. A guest who only finds out at "Place
        Order" has already lost.

     3. AND THAT IT IS DELIVERY-SCOPED. Pickup must still offer pay-at-counter.
        Without this control, a bug that disabled the counter card for every
        order would pass checks 1 and 2 happily.

   Pitfall 10 applies throughout: the failure mode is a *rendered* one (which
   card carries .on, whether the option is really disabled), so it is asserted
   against the DOM, never against the state variable that produced it.

   Run:  node _dev/probe_delivery_pay.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8955', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9375', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'delivery-pay-key-' + Date.now().toString(36);

/* Hermetic: every state file the server knows about points at scratch, so this
   probe cannot read or write the shop's real orders, switches, menu or secrets.
   It POSTs /api/store to switch Delivery on, which is exactly the kind of call
   that would otherwise leave the owner's channel switches flipped. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-delivery-pay-'));

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

/* ---- page readers --------------------------------------------------------- */

/* The delivery line, from whatever totals block is passed in. Reads the DOM the
   guest actually sees: the bold label, whether an <s> was emitted at all, and
   the COMPUTED strike-through (asking "is there a <s> tag" would pass even if
   the stylesheet had been edited to un-strike it). */
const deliveryRow = (sel) => `(() => {
  const rows = Array.from(document.querySelectorAll('${sel} .trow'));
  const row = rows.find((r) => /^\\s*Delivery\\s*$/.test(((r.querySelector('span') || {}).textContent || '')));
  if (!row) return { present: false, rows: rows.map((r) => (r.textContent || '').trim()) };
  const b = row.querySelector('b');
  const s = row.querySelector('s');
  return {
    present: true,
    label: b ? b.textContent.trim() : null,
    boldClass: b ? String(b.className) : null,
    hasStrike: !!s,
    strikeText: s ? s.textContent.trim() : null,
    strikeDecoration: s ? getComputedStyle(s).textDecorationLine : null,
    boldColor: b ? getComputedStyle(b).color : null,
    strikeColor: s ? getComputedStyle(s).color : null
  };
})()`;

const PAY_CARDS = `(() => Array.from(document.querySelectorAll('#sheetBody [data-pay]')).map((b) => ({
  pay: b.dataset.pay,
  on: b.classList.contains('on'),
  disabled: b.disabled === true,
  ariaDisabled: b.getAttribute('aria-disabled'),
  name: ((b.querySelector('b') || {}).textContent || '').trim(),
  sub: ((b.querySelector('small') || {}).textContent || '').trim()
})))()`;

const CART_EMPTY = `(() => {
  const b = document.querySelector('#cartBadge');
  return !b || /^\\s*0?\\s*$/.test(b.textContent || '');
})()`;

async function setStore(body) {
  return fetch(BASE + '/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));
}

/* Put one side in the cart, then open the cart sheet. The cart survives a
   reload (it is in localStorage), so the second call reuses the item.

   Deliberately stops at the cart sheet: #cartTotals only exists while that
   sheet is open, and clicking through to checkout REPLACES the sheet body. An
   earlier version of this probe read #cartTotals after the click and got an
   empty node list, which it reported as "no delivery row" — a false failure
   that said nothing about the code. */
async function openCart(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('!!document.querySelector("[data-cat=\\"sides\\"]")', 15000, 'the menu to render');

  if (await cdp.evalJs(CART_EMPTY)) {
    await cdp.evalJs(`document.querySelector('[data-cat="sides"]').click()`);
    await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 10000, 'the A La Carte list');
    await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
    await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 8000, 'the add to settle');
  }

  await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
  await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
  await cdp.waitFor('!!document.querySelector("#cartTotals .trow")', 8000, 'the cart totals');
}

/* Cart sheet → checkout sheet. #checkoutTotals is filled by
   renderTotalsInCheckout() AFTER the sheet is built, so waiting for the pay
   cards to exist is what proves the checkout finished — waiting on the sheet
   itself would read a half-built DOM. */
async function clickToCheckout(cdp) {
  await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
  await cdp.waitFor('!!document.querySelector("#sheetBody [data-pay]")', 10000, 'the payment options');
  await cdp.waitFor('!!document.querySelector("#checkoutTotals .trow")', 8000, 'the checkout totals');
}

async function main() {
  console.log('delivery as the guest sees it — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-delivery-pay-chrome-' + Date.now());

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
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_delivery_pay_not_a_real_key'
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

    /* The channel switch is the OWNER's, flipped through the board's own
       endpoint — not a config edit. The shipped config seeds it off. */
    const on = await setStore({ orderTypes: { delivery: true } });
    check('the owner can switch Delivery on from the board',
      on.status === 200 && on.j && on.j.orderTypes && on.j.orderTypes.delivery === true,
      'status=' + on.status + ' ' + JSON.stringify(on.j));

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
    section('a guest picks Delivery (?type=delivery)');
    await openCart(cdp, BASE + '/?type=delivery');

    const picked = await cdp.evalJs('(() => { const b = document.querySelector("#otGrid .ot-card.on"); return b ? b.dataset.ot : null; })()');
    check('the guest is on the Delivery channel', picked === 'delivery', 'selected=' + picked);

    /* ---- the free delivery line, in the CART -------------------------- */
    /* Read before clicking through: the two totals blocks are built by two
       different functions (cartTotalsHTML / renderTotalsInCheckout) and are
       exactly the pair that drifted before, so both get checked. */
    const cartRow = await cdp.evalJs(deliveryRow('#cartTotals'));
    check('the cart sheet: a Delivery line is shown (a free fee must not drop the row)',
      !!cartRow && cartRow.present === true, JSON.stringify(cartRow));
    check('the cart sheet: it reads FREE',
      !!cartRow && /FREE/.test(cartRow.label || ''), JSON.stringify(cartRow && cartRow.label));
    check('the cart sheet: FREE is tinted like the discount rows, not like a charge',
      !!cartRow && cartRow.boldClass === 'free', 'class=' + (cartRow && cartRow.boldClass));
    check('the cart sheet: the old $1.99 is shown, struck through',
      !!cartRow && cartRow.hasStrike === true && /1\.99/.test(cartRow.strikeText || ''),
      JSON.stringify(cartRow && { hasStrike: cartRow.hasStrike, text: cartRow.strikeText }));
    check('the cart sheet: the strike-through is really rendered (computed, not just a <s> tag)',
      !!cartRow && /line-through/.test(cartRow.strikeDecoration || ''),
      'textDecorationLine=' + (cartRow && cartRow.strikeDecoration));
    check('the cart sheet: the struck price is muted, so FREE is what the eye lands on',
      !!cartRow && cartRow.strikeColor !== cartRow.boldColor,
      'was=' + (cartRow && cartRow.strikeColor) + ' now=' + (cartRow && cartRow.boldColor));

    await clickToCheckout(cdp);

    /* ---- the same line, in the CHECKOUT ------------------------------- */
    const coRow = await cdp.evalJs(deliveryRow('#checkoutTotals'));
    check('the checkout: a Delivery line is shown (a free fee must not drop the row)',
      !!coRow && coRow.present === true, JSON.stringify(coRow));
    check('the checkout: it reads FREE',
      !!coRow && /FREE/.test(coRow.label || ''), JSON.stringify(coRow && coRow.label));
    check('the checkout: FREE is tinted like the discount rows, not like a charge',
      !!coRow && coRow.boldClass === 'free', 'class=' + (coRow && coRow.boldClass));
    check('the checkout: the old $1.99 is shown, struck through',
      !!coRow && coRow.hasStrike === true && /1\.99/.test(coRow.strikeText || ''),
      JSON.stringify(coRow && { hasStrike: coRow.hasStrike, text: coRow.strikeText }));
    check('the checkout: the strike-through is really rendered (computed, not just a <s> tag)',
      !!coRow && /line-through/.test(coRow.strikeDecoration || ''),
      'textDecorationLine=' + (coRow && coRow.strikeDecoration));
    check('the checkout: the struck price is muted, so FREE is what the eye lands on',
      !!coRow && coRow.strikeColor !== coRow.boldColor,
      'was=' + (coRow && coRow.strikeColor) + ' now=' + (coRow && coRow.boldColor));

    /* ---- pay at the counter is refused -------------------------------- */
    const cards = await cdp.evalJs(PAY_CARDS);
    const counter = (cards || []).find((c) => c.pay === 'counter') || null;
    const chosen = (cards || []).filter((c) => c.on).map((c) => c.pay);

    check('the payment options rendered', (cards || []).length >= 2, JSON.stringify(cards));
    check('pay-at-counter is still SHOWN on a delivery (not silently hidden)',
      !!counter, JSON.stringify(cards));
    check('but it is disabled', !!counter && counter.disabled === true,
      'disabled=' + (counter && counter.disabled));
    check('and marked aria-disabled for screen readers',
      !!counter && counter.ariaDisabled === 'true', 'aria-disabled=' + (counter && counter.ariaDisabled));
    check('the reason names DELIVERY, not the size of the order',
      !!counter && /delivery/i.test(counter.sub || '') && /paid online/i.test(counter.sub || ''),
      'sub=' + JSON.stringify(counter && counter.sub));
    check('the guest is NOT left selected on the refused option',
      chosen.length > 0 && chosen.indexOf('counter') === -1,
      'selected=' + JSON.stringify(chosen));

    /* ================================================================== */
    section('the same guest, on Pickup — the control');
    await openCart(cdp, BASE + '/?type=pickup');

    const pickedP = await cdp.evalJs('(() => { const b = document.querySelector("#otGrid .ot-card.on"); return b ? b.dataset.ot : null; })()');
    check('the guest is on the Pickup channel', pickedP === 'pickup', 'selected=' + pickedP);

    const pCartRow = await cdp.evalJs(deliveryRow('#cartTotals'));
    check('no Delivery line in the cart on a pickup order',
      !pCartRow || pCartRow.present === false, JSON.stringify(pCartRow && pCartRow.rows));

    await clickToCheckout(cdp);

    const sub = await cdp.evalJs(`(() => {
      const r = Array.from(document.querySelectorAll('#checkoutTotals .trow'))
        .find((x) => /Subtotal/.test((x.querySelector('span') || {}).textContent || ''));
      return r ? (r.querySelector('b') || {}).textContent : null;
    })()`);
    /* The counter ceiling is $30, so a single side must be well under it —
       otherwise the control below would be measuring the ceiling, not the
       delivery rule, and would fail for the wrong reason. */
    check('the control cart is under the $30 counter ceiling', !!sub, 'subtotal=' + sub);

    const pRow = await cdp.evalJs(deliveryRow('#checkoutTotals'));
    check('no Delivery line in the checkout on a pickup order',
      !pRow || pRow.present === false, JSON.stringify(pRow && pRow.rows));

    const pCards = await cdp.evalJs(PAY_CARDS);
    const pCounter = (pCards || []).find((c) => c.pay === 'counter') || null;
    check('pay-at-counter is ENABLED on a pickup order (the rule is delivery-scoped)',
      !!pCounter && pCounter.disabled !== true, JSON.stringify(pCounter));
    check('and it carries its normal blurb, not a refusal',
      !!pCounter && !/must be paid online/i.test(pCounter.sub || ''),
      'sub=' + JSON.stringify(pCounter && pCounter.sub));

    /* ================================================================== */
    section('a guest who CHOSE pay-at-counter, then switches to Delivery');
    /* This is the case the auto-switch exists for, and the one the section
       above cannot see: there the guest never picked a method, so the DEFAULT
       (online) was already selected and a missing fallback would go unnoticed.
       Here the guest has explicitly chosen the counter, so payChosen is true
       and nothing else would move them off it. The channel card is clicked
       while the checkout sheet is open — the delegated handler re-runs
       openCheckout(), which is where the fallback lives. */
    await cdp.evalJs(`document.querySelector('[data-pay="counter"]').click()`);
    const choseCounter = await cdp.evalJs(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.classList.contains('on')); })()`);
    check('the guest can pick pay-at-counter while on Pickup', choseCounter === true, 'on=' + choseCounter);

    await cdp.evalJs(`document.querySelector('#otGrid .ot-card[data-ot="delivery"]').click()`);
    await cdp.waitFor(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.disabled === true); })()`,
      10000, 'the counter card to be disabled after switching to Delivery');

    const after = await cdp.evalJs(PAY_CARDS);
    const aCounter = (after || []).find((c) => c.pay === 'counter') || null;
    const aChosen = (after || []).filter((c) => c.on).map((c) => c.pay);
    check('switching to Delivery disables the counter card the guest had chosen',
      !!aCounter && aCounter.disabled === true, JSON.stringify(aCounter));
    check('and MOVES the guest off it, instead of leaving a refused option selected',
      aChosen.length > 0 && aChosen.indexOf('counter') === -1, 'selected=' + JSON.stringify(aChosen));
    check('and gives the delivery reason, not the ceiling one',
      !!aCounter && /delivery/i.test(aCounter.sub || ''), 'sub=' + JSON.stringify(aCounter && aCounter.sub));

    /* ================================================================== */
    section('the delivery DATE and TIME picker — the guest must be able to choose');
    /* The reported bug: the chips rendered, so the picker LOOKED right, but
       renderScheduleBox() replaces the box's innerHTML and openCheckout()
       re-renders straight after bindScheduleBox() — so the per-chip onclick
       handlers were destroyed before the guest could tap anything. Nothing
       threw; the picker simply did nothing. Asserted with real clicks, and
       against the DOM, never the state variable that produced it. */
    await cdp.waitFor('!!document.querySelector("#scheduleBox .sch-date")', 15000, 'the date chips');
    await cdp.waitFor('!!document.querySelector("#scheduleBox .sch-slot")', 15000, 'the time slots');

    const CHIPS = `(() => Array.from(document.querySelectorAll('#scheduleBox .sch-date')).map((b) => ({
      big: ((b.querySelector('span') || {}).textContent || '').trim(),
      small: ((b.querySelector('small') || {}).textContent || '').trim(),
      iso: b.dataset.schDate,
      on: b.classList.contains('on')
    })))()`;

    const chips = await cdp.evalJs(CHIPS);
    check('the picker offers several days', (chips || []).length >= 2, JSON.stringify(chips));
    /* Sunday is weekday 0. The old chip read `d.weekday || d.iso`, so Sunday
       printed its raw ISO date and every other day printed a bare number. */
    check('every date chip names a real weekday, not a number or a raw date',
      (chips || []).length > 0 && chips.every((c) => /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(c.big)),
      JSON.stringify(chips));
    check('and shows the month/day underneath',
      (chips || []).every((c) => /^\d{1,2}\/\d{1,2}$/.test(c.small)), JSON.stringify(chips));
    check('no chip falls back to printing the ISO string',
      (chips || []).every((c) => c.big !== c.iso), JSON.stringify(chips));

    /* Click the SECOND day — a day the guest did not start on, so the click
       has to do real work. */
    await cdp.evalJs(`document.querySelectorAll('#scheduleBox .sch-date')[1].click()`);
    await cdp.waitFor(
      `(() => { const b = document.querySelectorAll('#scheduleBox .sch-date')[1]; return !!(b && b.classList.contains('on')); })()`,
      12000, 'the second date to become selected');
    await cdp.waitFor('!!document.querySelector("#scheduleBox .sch-slot")', 12000,
      'the slots for the newly picked day');

    const afterDate = await cdp.evalJs(CHIPS);
    check('clicking a date actually selects it',
      (afterDate || []).filter((c) => c.on).length === 1 && afterDate[1].on === true,
      JSON.stringify(afterDate));

    /* Now pick a time. */
    const firstSlotLabel = await cdp.evalJs(
      `((document.querySelector('#scheduleBox .sch-slot span') || {}).textContent || '').trim()`);
    await cdp.evalJs(`document.querySelector('#scheduleBox .sch-slot').click()`);
    await cdp.waitFor(
      `(() => { const b = document.querySelector('#scheduleBox .sch-slot'); return !!(b && b.classList.contains('on')); })()`,
      12000, 'the first time slot to become selected');

    const PICK = `(() => ({
      dates: Array.from(document.querySelectorAll('#scheduleBox .sch-date')).map((b) => b.classList.contains('on')),
      slots: Array.from(document.querySelectorAll('#scheduleBox .sch-slot')).filter((b) => b.classList.contains('on')).length,
      note: Array.from(document.querySelectorAll('#scheduleBox .small.ok')).map((n) => n.textContent.trim()).join(' | ')
    }))()`;
    const pickState = await cdp.evalJs(PICK);
    check('clicking a time slot actually selects exactly one',
      pickState.slots === 1, JSON.stringify(pickState));
    check('and the picker says the choice back to the guest',
      /Delivering/i.test(pickState.note) && /\d{1,2}:\d{2}\s*(AM|PM)/i.test(pickState.note) &&
      /on \d{1,2}\/\d{1,2}/.test(pickState.note),
      'slot=' + JSON.stringify(firstSlotLabel) + ' note=' + JSON.stringify(pickState.note));
    check('and the day the guest clicked is still the one selected',
      pickState.dates[1] === true, JSON.stringify(pickState.dates));

    /* Moving to a THIRD day must drop that choice: a slot id means a different
       thing on a different day, and a lit chip over a stale date is the guest
       reading one thing while the kitchen gets another. */
    await cdp.evalJs(`document.querySelectorAll('#scheduleBox .sch-date')[2].click()`);
    await cdp.waitFor(
      `(() => { const b = document.querySelectorAll('#scheduleBox .sch-date')[2]; return !!(b && b.classList.contains('on')); })()`,
      12000, 'the third date to become selected');
    await cdp.waitFor('!!document.querySelector("#scheduleBox .sch-slot")', 12000, 'the third day\'s slots');

    const moved = await cdp.evalJs(PICK);
    check('changing the day clears the time picked on the old day',
      moved.slots === 0, JSON.stringify(moved));
    check('and stops claiming a delivery time it is not going to send',
      !/Delivering/i.test(moved.note), 'note=' + JSON.stringify(moved.note));

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
