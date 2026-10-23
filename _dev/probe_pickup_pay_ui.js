#!/usr/bin/env node
/* ==========================================================================
   Pickup prepayment, as the GUEST sees it: over $20, pay before the kitchen.
   (index.html, real browser + real server)

   The rule (owner, 2026-10-22): a PICKUP order over $20 must be paid before
   it is sent to the kitchen. The server enforces it (probe_pickup_prepay_http.js
   proves that); what is checked here is the part the server cannot do for the
   guest — the counter card is shown DISABLED with the reason, and the guest is
   never left selected on an option the server would refuse. A guest who only
   finds out at "Place Order" has already lost.

   Four things this file exists to catch, all rendered-state bugs that pure
   logic cannot see:

     1. THE BLOCKED CARD. On a pickup order over the threshold, pay-at-counter
        is visible but disabled, marked aria-disabled, and its blurb names the
        PICKUP rule — not the general $30 ceiling, not the delivery ban.

     2. THE FALLBACK. The guest is moved to an online method rather than left
        on a card that would be refused, and the hint under the options says
        why.

     3. THE TWO CONTROLS. The same over-threshold cart on DINE-IN offers the
        counter again (the guest is in the building — the rule is
        pickup-scoped), and a SMALL pickup cart offers it too (the threshold
        is the whole point: a $12 bowl still pays at the counter). Without
        these, a bug that disabled the counter card everywhere would pass
        checks 1 and 2 happily.

   Pitfall: the failure mode is a *rendered* one (which card carries .on,
   whether the option is really disabled), so it is asserted against the DOM,
   never against the state variable that produced it.

   Run:  node _dev/probe_pickup_pay_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8956', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9384', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'pickup-pay-key-' + Date.now().toString(36);

/* Hermetic: every state file the server knows about points at scratch, so
   this probe cannot read or write the shop's real orders, switches, menu,
   ledger or secrets. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-pickup-pay-'));

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
      /* An expression that THROWS has NOT succeeded — keep polling. Turning
         the error into a truthy string made waitFor return early on a
         condition that was never met (the false-pass bug). */
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

const PAY_CARDS = `(() => Array.from(document.querySelectorAll('#sheetBody [data-pay]')).map((b) => ({
  pay: b.dataset.pay,
  on: b.classList.contains('on'),
  disabled: b.disabled === true,
  ariaDisabled: b.getAttribute('aria-disabled'),
  name: ((b.querySelector('b') || {}).textContent || '').trim(),
  sub: ((b.querySelector('small') || {}).textContent || '').trim()
})))()`;

const TOTAL_ROW = (sel) => `(() => {
  const r = Array.from(document.querySelectorAll('${sel} .trow'))
    .find((x) => /Total/.test((x.querySelector('span') || {}).textContent || ''));
  return r ? ((r.querySelector('b') || {}).textContent || '').trim() : null;
})()`;

const PAY_HINT = `(() => ((document.querySelector('#payHint') || {}).textContent || '').trim())()`;

/* Cart seeding. The cart lives in localStorage and survives a reload, so the
   item shapes below are exactly what addToCart() would have written — same
   fields, same prices as the menu (the server re-prices regardless). One bowl
   is $15.99 and a side of fries $2.99, so bowl + fries = $18.98 + 6% tax =
   $20.12: just over the $20 threshold and under the $30 counter ceiling, so
   a refusal here can only be the pickup rule. */
const BOWL = { uid: 'probe-bowl', qty: 1, name: 'Hot Pot To Go', unit: 15.99, kind: 'hotpot', mods: [], addons: [], note: '', sig: '["Hot Pot To Go",[],[]]' };
const FRIES = { uid: 'probe-fries', qty: 1, name: 'Side of Fries', unit: 2.99, kind: 'simple', mods: [], addons: [], note: '', sig: '["Side of Fries",[]]' };

const seedCart = (items) => `(() => { try {
  localStorage.setItem('kpot.cart.v1', JSON.stringify(${JSON.stringify(items)}));
  localStorage.removeItem('kpot.last.v1');
  localStorage.removeItem('kpot.history.v1');
} catch (e) {} })()`;

/* Open the page with a seeded cart on the Pickup channel and drive it to the
   CART sheet. Stops there on purpose: clicking through to checkout REPLACES
   the sheet body, so #cartTotals must be read before that click (reading it
   afterwards gets an empty node list, which reads as "no total" rather than
   as the mistake it is). */
async function openPickupCart(cdp, items) {
  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor('!!document.querySelector("[data-cat]")', 15000, 'the menu to render');
  await cdp.evalJs(seedCart(items));
  await cdp.send('Page.navigate', { url: BASE + '/?type=pickup' });
  await cdp.waitFor('!!document.querySelector("#otGrid .ot-card.on")', 15000, 'the channel cards');

  const picked = await cdp.evalJs('(() => { const b = document.querySelector("#otGrid .ot-card.on"); return b ? b.dataset.ot : null; })()');
  if (picked !== 'pickup') throw new Error('expected the Pickup channel, got ' + picked);

  await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
  await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
  await cdp.waitFor('!!document.querySelector("#cartTotals .trow")', 8000, 'the cart totals');
}

/* Cart sheet → checkout sheet. #checkoutTotals is filled AFTER the sheet is
   built, so waiting for the pay cards to exist is what proves the checkout
   finished — waiting on the sheet itself would read a half-built DOM. */
async function clickToCheckout(cdp) {
  await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
  await cdp.waitFor('!!document.querySelector("#sheetBody [data-pay]")', 10000, 'the payment options');
  await cdp.waitFor('!!document.querySelector("#checkoutTotals .trow")', 8000, 'the checkout totals');
}

async function main() {
  console.log('pickup prepayment as the guest sees it — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-pickup-pay-chrome-' + Date.now());

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
        /* 24h open: the business-hours tick holds `open` on the hours clock,
           and a guest page that will not accept orders cannot be driven
           through a cart at all. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_CREDITS_FILE: path.join(SCRATCH, 'credits.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
        KPOT_APPLE_PAY_FILE: path.join(SCRATCH, 'apple-domain-association'),
        KPOT_GIVEAWAY_OUTBOX: path.join(SCRATCH, 'giveaway-mail-outbox.jsonl'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        /* A real (fake) key is what makes "Pay Online" an available fallback —
           without one the pickup rule switches itself off, exactly as on the
           server, and this probe would be measuring nothing. */
        STRIPE_SECRET_KEY: 'sk_test_pickup_pay_not_a_real_key'
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
    section('a $20.12 pickup order — pay online, before the kitchen');
    await openPickupCart(cdp, [BOWL, FRIES]);

    /* The cart is really over the threshold — asserted from the BILL, so a
       seeded-cart mistake cannot masquerade as the rule working. */
    const cartTotal = await cdp.evalJs(TOTAL_ROW('#cartTotals'));
    check('the cart totals $20.12 — over the $20 threshold, under the $30 ceiling',
      !!cartTotal && /20\.12/.test(cartTotal), 'cartTotal=' + cartTotal);

    await clickToCheckout(cdp);

    const coTotal = await cdp.evalJs(TOTAL_ROW('#checkoutTotals'));
    check('and the checkout shows the same total', !!coTotal && /20\.12/.test(coTotal), 'checkoutTotal=' + coTotal);

    const cards = await cdp.evalJs(PAY_CARDS);
    const counter = (cards || []).find((c) => c.pay === 'counter') || null;
    const chosen = (cards || []).filter((c) => c.on).map((c) => c.pay);

    check('the payment options rendered', (cards || []).length >= 2, JSON.stringify(cards));
    check('pay-at-counter is still SHOWN on the pickup order (not silently hidden)',
      !!counter, JSON.stringify(cards));
    check('but it is disabled', !!counter && counter.disabled === true,
      'disabled=' + (counter && counter.disabled));
    check('and marked aria-disabled for screen readers',
      !!counter && counter.ariaDisabled === 'true', 'aria-disabled=' + (counter && counter.ariaDisabled));
    check('the reason names the PICKUP rule and the $20 threshold',
      !!counter && /pickup orders over \$20\.00 must be paid online/i.test(counter.sub || ''),
      'sub=' + JSON.stringify(counter && counter.sub));
    check('the guest is NOT left selected on the refused option',
      chosen.length > 0 && chosen.indexOf('counter') === -1,
      'selected=' + JSON.stringify(chosen));
    /* The hint describes the SELECTED method — the auto-fallback — so it has
       to be the online one, not the counter one the guest was moved off. */
    const hint = await cdp.evalJs(PAY_HINT);
    check('and the hint under the options describes the online method the guest was moved to',
      /card, apple pay and google pay/i.test(hint), 'hint=' + JSON.stringify(hint));

    /* ================================================================== */
    section('the same $20.12 cart on DINE-IN — the control');
    /* The rule is pickup-scoped: a guest sitting at a table in the building
       is the case the $30 ceiling exists for, and $20.12 is under it. The
       channel card is clicked while the checkout sheet is open — the
       delegated handler re-runs openCheckout(), which re-evaluates the
       block. */
    await cdp.evalJs(`document.querySelector('#otGrid .ot-card[data-ot="dinein"]').click()`);
    await cdp.waitFor(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.disabled === false); })()`,
      10000, 'the counter card to be enabled again on Dine-In');

    const dCards = await cdp.evalJs(PAY_CARDS);
    const dCounter = (dCards || []).find((c) => c.pay === 'counter') || null;
    check('pay-at-counter is ENABLED on the dine-in order (the rule is pickup-scoped)',
      !!dCounter && dCounter.disabled !== true, JSON.stringify(dCounter));
    check('and it carries its normal blurb, not a refusal',
      !!dCounter && !/must be paid online/i.test(dCounter.sub || ''),
      'sub=' + JSON.stringify(dCounter && dCounter.sub));
    check('the blurb is the ordinary counter one',
      !!dCounter && /cash or card/i.test(dCounter.sub || ''),
      'sub=' + JSON.stringify(dCounter && dCounter.sub));
    /* A disabled card must not become selectable just because some browser
       still fires the handler — prove the re-enabled one really is pickable. */
    await cdp.evalJs(`document.querySelector('[data-pay="counter"]').click()`);
    const dChosen = await cdp.evalJs(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.classList.contains('on')); })()`);
    check('and the guest can actually pick it', dChosen === true, 'on=' + dChosen);

    /* ================================================================== */
    section('back to PICKUP — the block returns');
    await cdp.evalJs(`document.querySelector('#otGrid .ot-card[data-ot="pickup"]').click()`);
    await cdp.waitFor(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.disabled === true); })()`,
      10000, 'the counter card to be disabled again on Pickup');

    const pCards = await cdp.evalJs(PAY_CARDS);
    const pCounter = (pCards || []).find((c) => c.pay === 'counter') || null;
    const pChosen = (pCards || []).filter((c) => c.on).map((c) => c.pay);
    check('switching back to Pickup disables the counter card the guest had chosen',
      !!pCounter && pCounter.disabled === true, JSON.stringify(pCounter));
    check('and MOVES the guest off it, instead of leaving a refused option selected',
      pChosen.length > 0 && pChosen.indexOf('counter') === -1, 'selected=' + JSON.stringify(pChosen));
    check('with the pickup reason, not the ceiling one',
      !!pCounter && /pickup orders over \$20\.00/i.test(pCounter.sub || ''),
      'sub=' + JSON.stringify(pCounter && pCounter.sub));

    /* ================================================================== */
    section('a $16.95 pickup order — the small-cart control');
    /* The threshold is the whole point: a small counter order must still go
       straight to the kitchen. A bug that disabled the counter card on every
       pickup order would pass every check above. */
    await openPickupCart(cdp, [BOWL]);

    const sTotal = await cdp.evalJs(TOTAL_ROW('#cartTotals'));
    check('the control cart totals $16.95 — under the threshold',
      !!sTotal && /16\.95/.test(sTotal), 'cartTotal=' + sTotal);

    await clickToCheckout(cdp);

    const sCards = await cdp.evalJs(PAY_CARDS);
    const sCounter = (sCards || []).find((c) => c.pay === 'counter') || null;
    check('pay-at-counter is ENABLED on the small pickup order',
      !!sCounter && sCounter.disabled !== true, JSON.stringify(sCounter));
    check('and it carries its normal blurb',
      !!sCounter && !/must be paid online/i.test(sCounter.sub || ''),
      'sub=' + JSON.stringify(sCounter && sCounter.sub));
    await cdp.evalJs(`document.querySelector('[data-pay="counter"]').click()`);
    const sChosen = await cdp.evalJs(
      `(() => { const c = document.querySelector('[data-pay="counter"]'); return !!(c && c.classList.contains('on')); })()`);
    check('and the guest can pick it', sChosen === true, 'on=' + sChosen);
    const sHint = await cdp.evalJs(PAY_HINT);
    check('the hint is the ordinary counter one ("pay when you pick up")',
      /pay when you pick up/i.test(sHint), 'hint=' + JSON.stringify(sHint));

    /* ================================================================== */
    section('the page must have thrown nothing');
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
