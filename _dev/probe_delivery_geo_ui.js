#!/usr/bin/env node
/* ==========================================================================
   Delivery distance, as the GUEST experiences it: the answer arrives while
   the address is being typed, an out-of-range address refuses politely with
   a one-tap way out, and the rule is delivery-scoped.
   (index.html, real browser + real server, stubbed geocoder)

   _dev/probe_delivery_geo_http.js proves the SERVER enforces the 2-mile
   rule. This proves the browser half, which is what the guest actually
   lives through:

     1. Typing a far address shows the refusal BEFORE any money moves, and
        disables Place Order (offering a button the server will refuse is
        how a guest ends up paying for food nobody cooks).
     2. The refusal offers a way out — "Switch to Pickup" moves the guest to
        the Pickup channel through the SAME handler a tap on the card uses.
     3. A near address gets the quiet green confirmation, and Place Order
        works again.
     4. All of this is DELIVERY-scoped: on Pickup the same field is a pickup
        time and nothing checks anything.

   Pitfall 43 applies throughout (innerHTML re-renders eat handlers): every
   assertion is against the DOM after a real interaction, never against the
   state variable that produced it.

   Run:  node _dev/probe_delivery_geo_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8958', 10);
const GEO_PORT = 8959;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9376', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'geo-ui-key-' + Date.now().toString(36);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-geo-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Census-shaped geocoder stub: keyword -> coordinates. */
const GEO_RESPONSES = [
  { key: 'NEAR', coords: { x: -84.461181, y: 33.880479 + 1.0 / 69.0 } },  /* ~1 mi */
  { key: 'FAR', coords: { x: -122.084, y: 37.422 } }                      /* Mountain View */
];
const geoStub = http.createServer((req, res) => {
  const addr = decodeURIComponent((req.url.split('?address=')[1] || '')).toUpperCase();
  const hit = GEO_RESPONSES.find((r) => addr.indexOf(r.key) !== -1);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    result: { addressMatches: hit ? [{ coordinates: hit.coords, matchedAddress: addr }] : [] }
  }));
});

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
      await sleep(400);
    }
    throw new Error('timed out waiting for ' + label + ' — last: ' + JSON.stringify(last));
  }

  return { ws, send, evalJs, waitFor, logs };
}

/* Type into #cWhen the way a guest does: set the value, fire `input`. */
function typeAddress(addr) {
  return `(() => {
    const el = document.querySelector('#cWhen');
    if (!el) return 'no-input';
    el.value = ${JSON.stringify(addr)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`;
}

const GEO_BOX = `(() => {
  const box = document.querySelector('#geoBox');
  if (!box) return { present: false };
  const warn = box.querySelector('.geo-in');
  const ok = box.querySelector('.small.ok');
  const dim = box.querySelector('.small.dim');
  const po = document.querySelector('#placeOrder');
  return {
    warn: warn ? (warn.textContent || '').trim() : null,
    hasPickupBtn: !!box.querySelector('[data-geo-pickup]'),
    ok: ok ? (ok.textContent || '').trim() : null,
    dim: dim ? (dim.textContent || '').trim() : null,
    placeOrderDisabled: po ? po.disabled === true : null
  };
})()`;

async function setStore(body) {
  return fetch(BASE + '/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));
}

/* One side in the cart, then the checkout sheet — the same path the guest
   takes. Stops at the checkout sheet like probe_delivery_pay.js does. */
async function openCheckoutSheet(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('!!document.querySelector("[data-cat=\\"sides\\"]")', 15000, 'the menu to render');
  const cartEmpty = await cdp.evalJs(`(() => {
    const b = document.querySelector('#cartBadge');
    return !b || /^\\s*0?\\s*$/.test(b.textContent || '');
  })()`);
  if (cartEmpty) {
    await cdp.evalJs(`document.querySelector('[data-cat="sides"]').click()`);
    await cdp.waitFor('!!document.querySelector(".add-btn[data-side]")', 10000, 'the A La Carte list');
    await cdp.evalJs(`document.querySelector('.add-btn[data-side]').click()`);
  }
  await cdp.evalJs(`document.querySelector('#cartBtn').click()`);
  await cdp.waitFor('!!document.querySelector("#toCheckout")', 10000, 'the cart sheet');
  await cdp.evalJs(`document.querySelector('#toCheckout').click()`);
  await cdp.waitFor('!!document.querySelector("#cWhen")', 10000, 'the checkout details');
}

async function main() {
  console.log('delivery distance as the guest sees it — real browser + real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-geo-ui-chrome-' + Date.now());

  const cleanup = async () => {
    await teardown([chrome, server], [SCRATCH, profile]);
    try { geoStub.close(); } catch (e) {}
  };

  try {
    /* The stub must be listening BEFORE the server can geocode anything —
       otherwise every check fails open on ECONNREFUSED and the probe proves
       only that the shop stays open, not that the rule works. */
    await new Promise((r) => geoStub.listen(GEO_PORT, '127.0.0.1', r));

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ADMIN_KEY,
        KPOT_FLUSH_MS: '500',
        /* 24h hours spec: the business-hours tick holds `open` strictly on the
           clock, and this probe runs at any hour. See hoursSpec() in
           server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_GEOCODE_API_BASE: 'http://127.0.0.1:' + GEO_PORT,
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
        STRIPE_SECRET_KEY: 'sk_test_geo_ui_not_a_real_key'
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

    /* The owner's board opens the shop and turns Delivery on at runtime. */
    const on = await setStore({ open: true, acceptingOrders: true, orderTypes: { delivery: true } });
    check('the owner can open the shop and switch Delivery on',
      on.status === 200 && on.j && on.j.open === true,
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
    section('a guest on Delivery types an address OUTSIDE the radius');
    await openCheckoutSheet(cdp, BASE + '/?type=delivery');

    const blank = await cdp.evalJs(GEO_BOX);
    check('before anything is typed, there is no verdict and no disabled button',
      blank.warn === null && blank.ok === null && blank.placeOrderDisabled === false,
      JSON.stringify(blank));

    await cdp.evalJs(typeAddress('1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR'));
    const typed = await cdp.evalJs(`(() => {
      const el = document.querySelector('#cWhen');
      return el ? el.value.slice(0, 30) + ' len=' + el.value.length : 'NO-INPUT';
    })()`);
    check('the address really landed in the field', /len=5\d/.test(typed || ''), 'typed=' + typed);

    const blocked = await cdp.waitFor(
      `(() => {
        const box = document.querySelector('#geoBox');
        return box && box.querySelector('.geo-in')
          ? JSON.stringify({
              warn: (box.querySelector('.geo-in').textContent || '').trim(),
              hasPickupBtn: !!box.querySelector('[data-geo-pickup]'),
              poDisabled: document.querySelector('#placeOrder').disabled === true
            })
          : null;
      })()`,
      15000, 'the out-of-range refusal');
    const b = JSON.parse(blocked);
    check('the refusal appears while typing — before any money moves',
      !!b.warn, JSON.stringify(b));
    check('it says the address is too far / names the 2-mile rule',
      /outside|2 miles|far/i.test(b.warn || ''), b.warn);
    check('and offers a way out to Pickup', b.hasPickupBtn === true, JSON.stringify(b));
    check('Place Order is disabled — no paying for a refused delivery',
      b.poDisabled === true, 'poDisabled=' + b.poDisabled);

    /* ================================================================== */
    section('the way out: "Switch to Pickup"');
    await cdp.evalJs(`document.querySelector('#geoBox [data-geo-pickup]').click()`);
    await cdp.waitFor(
      `(() => {
        const card = document.querySelector('#otGrid .ot-card[data-ot="pickup"]');
        const box = document.querySelector('#geoBox');
        const po = document.querySelector('#placeOrder');
        return card && card.classList.contains('on') && box && box.innerHTML === ''
          && po && po.disabled === false;
      })()`,
      10000, 'the Pickup channel after the switch');
    check('the guest lands on Pickup, geo box cleared, Place Order usable again', true);
    const afterPickup = await cdp.evalJs(GEO_BOX);
    check('and the verdict is gone with the channel', afterPickup.warn === null, JSON.stringify(afterPickup));

    /* ================================================================== */
    section('the control: the same field on Pickup checks NOTHING');
    await cdp.evalJs(typeAddress('1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR'));
    await sleep(1600);   /* longer than the debounce + a round trip */
    const pickupQuiet = await cdp.evalJs(GEO_BOX);
    check('a far "address" typed as a pickup time raises nothing',
      pickupQuiet.warn === null && pickupQuiet.placeOrderDisabled === false,
      JSON.stringify(pickupQuiet));

    /* ================================================================== */
    section('back to Delivery, an address INSIDE the radius');
    await cdp.evalJs(`document.querySelector('#otGrid .ot-card[data-ot="pickup"]').click()`);  /* no-op safety */
    await cdp.evalJs(`document.querySelector('#otGrid .ot-card[data-ot="delivery"]').click()`);
    await cdp.waitFor('!!document.querySelector("#cWhen")', 10000, 'the checkout sheet again');
    await cdp.evalJs(typeAddress('1 NEAR Test Rd, Atlanta, GA 30339'));
    const okLine = await cdp.waitFor(
      `(() => {
        const box = document.querySelector('#geoBox');
        const ok = box && box.querySelector('.small.ok');
        return ok ? (ok.textContent || '').trim() : null;
      })()`,
      15000, 'the within-range confirmation');
    check('a near address gets the quiet green confirmation',
      /within our delivery area/i.test(okLine || ''), okLine);
    const nearBox = await cdp.evalJs(GEO_BOX);
    check('and Place Order stays usable', nearBox.placeOrderDisabled === false, JSON.stringify(nearBox));
    check('the confirmation is not a refusal card', nearBox.warn === null, JSON.stringify(nearBox));

    /* ================================================================== */
    section('an address that cannot be located at all');
    await cdp.evalJs(typeAddress('123 Mystery Rd, Metropolis, GA 99999'));
    const soft = await cdp.waitFor(
      `(() => {
        const box = document.querySelector('#geoBox');
        const dim = box && box.querySelector('.small.dim');
        const warn = box && box.querySelector('.geo-in');
        const po = document.querySelector('#placeOrder');
        return dim && !warn && po.disabled === false
          ? (dim.textContent || '').trim() : null;
      })()`,
      15000, 'the soft unverifiable note');
    check('an unlocatable address gets a soft note, NOT a refusal',
      /could not verify|2 miles/i.test(soft || ''), soft);
    const softBox = await cdp.evalJs(GEO_BOX);
    check('and Place Order is NOT disabled (the shop must not stop over a geocode miss)',
      softBox.placeOrderDisabled === false, JSON.stringify(softBox));

    /* ================================================================== */
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
