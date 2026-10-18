#!/usr/bin/env node
/* ==========================================================================
   The driver's page, in a real browser: the key gate, the run in order, and
   the one action the driver has.
   (driver.html, real headless Chrome + real server)

   _dev/probe_driver_http.js proves the endpoint and the permissions. This
   proves the page the driver's thumb actually touches:

     1. Nothing is visible before a key is entered — the addresses stay
        behind the gate.
     2. A wrong key does not get in; the right one does.
     3. The cards are in RUN order — the order on screen is the order to
        drive, and the sequence numbers on the cards say so.
     4. Each card carries what a driver needs at the door: the window, the
        distance, a tappable address that opens Maps, the customer, the bag.
     5. Tapping Delivered removes that card, renumbers the rest, and the run
        shrinks — the server is the one who decided it is done.
     6. When the last one is delivered the empty state appears.
     7. "Forget this phone" takes the key off the device and re-locks.

   Pitfall 43 applies throughout (innerHTML re-renders eat handlers): every
   assertion is against the DOM after a real interaction.

   Run:  node _dev/probe_driver_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8962', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9382', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'driver-ui-key-' + Date.now().toString(36);
const DRIVER_KEY = 'driver-ui-driver-' + Date.now().toString(36);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-driver-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISP = require('../dispatch.js');

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

/* --------------------------------------------------------------------------
   A seeded day: same shop slot ids the shop actually offers (12pm/2pm/4pm),
   distances the 2-mile gate measured, one left over from yesterday, one
   unpaid. Written before the server starts so it loads them at boot.
   -------------------------------------------------------------------------- */
const TODAY = DISP.localDateKey(Date.now());
const YESTERDAY = DISP.localDateKey(Date.now() - 24 * 60 * 60 * 1000);

function seeded(no, extra) {
  return Object.assign({
    id: no, no: no,
    at: TODAY + 'T09:00:00.000Z', updatedAt: TODAY + 'T09:00:00.000Z',
    status: 'received', paymentStatus: 'paid', payMethod: 'stripe', orderType: 'delivery',
    deliveryDate: TODAY, deliverySlot: '12pm', deliverySlotLabel: '12:00 PM – 1:00 PM',
    scheduledFor: TODAY + 'T16:30:00.000Z', table: '',
    customer: { name: 'Alex Smith', phone: '(404) 555-0199', when: '1 NEAR Rd, Atlanta, GA 30339', notes: '' },
    items: [{ name: 'Pick 2 Proteins Bowl', qty: 2 }],
    lines: [{ name: 'Pick 2 Proteins Bowl', qty: 2, unit: 15.99, desc: '' }],
    subtotal: 31.98, tax: 1.92, tip: 0, delivery: 0, total: 33.9, source: 'probe'
  }, extra || {});
}
function atMiles(no, miles, extra) {
  return seeded(no, Object.assign({
    geo: { lat: 33.880479 + miles / 69.0, lon: -84.461181, miles: miles, source: 'street' }
  }, extra || {}));
}

const SEED = [
  atMiles('DRV-NEAR', 0.7, { customer: { name: 'Next Door', phone: '(404) 555-0202', when: '7 NEAR Test Rd, Atlanta, GA 30339', notes: 'Gate code 1234' } }),
  atMiles('DRV-UNPAID', 0.8, { paymentStatus: 'pending', customer: { name: 'Not Paid Yet', phone: '(404) 555-0205', when: '3 NEAR Test Rd, Atlanta, GA 30339', notes: '' } }),
  atMiles('DRV-FAR', 1.9, { customer: { name: 'Far Away', phone: '(404) 555-0201', when: '19 NEAR Test Rd, Atlanta, GA 30339', notes: '' } }),
  atMiles('DRV-EVENING', 0.5, {
    deliverySlot: '4pm', deliverySlotLabel: '4:00 PM – 5:00 PM', scheduledFor: TODAY + 'T19:30:00.000Z',
    customer: { name: 'Late One', phone: '(404) 555-0203', when: '5 NEAR Test Rd, Atlanta, GA 30339', notes: '' }
  }),
  atMiles('DRV-OVERDUE', 1.0, {
    deliveryDate: YESTERDAY, deliverySlot: '2pm', deliverySlotLabel: '2:00 PM – 3:00 PM',
    customer: { name: 'Yesterday', phone: '(404) 555-0204', when: '10 NEAR Test Rd, Atlanta, GA 30339', notes: '' }
  })
];
/* Same atomic shape the server's own saver uses. */
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/* Read the run as the driver sees it: one line per card. The address is the
   link's first TEXT NODE — `textContent` would include the "OPEN IN MAPS ›"
   label that lives inside the same anchor. */
const RUN = `(() => {
  const cards = Array.from(document.querySelectorAll('#cards .card'));
  return cards.map((c) => {
    const a = c.querySelector('a.addr');
    return {
      seq: (c.querySelector('.seq') || {}).textContent,
      win: (c.querySelector('.win') || {}).textContent,
      mi: (c.querySelector('.pill.mi') || {}).textContent || null,
      zip: !!(c.querySelector('.pill.mi.zip')),
      overdue: !!c.querySelector('.pill.overdue'),
      paid: (c.querySelector('.pill.paid, .pill.unpaid') || {}).textContent || null,
      addr: a ? (a.childNodes[0].textContent || '').trim() : null,
      maps: a ? a.getAttribute('href') : null,
      tel: (c.querySelector('.who a[href^="tel:"]') || {}).getAttribute
        ? c.querySelector('.who a[href^="tel:"]').getAttribute('href') : null,
      bag: (c.querySelector('.bag') || {}).textContent || null,
      note: (c.querySelector('.note') || {}).textContent || null,
      tot: (c.querySelector('.tot') || {}).textContent || null,
      deliver: !!c.querySelector('button.deliver')
    };
  });
})()`;

async function main() {
  console.log('the driver page — real browser, real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  let serverLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-driver-ui-chrome-' + Date.now());

  const cleanup = async () => {
    await teardown([chrome, server], [SCRATCH, profile]);
  };

  try {
    writeAtomic(path.join(SCRATCH, 'orders.local.json'), JSON.stringify(SEED, null, 2));
    writeAtomic(path.join(SCRATCH, 'store.local.json'), JSON.stringify({
      open: true, acceptingOrders: true, orderTypes: { pickup: true, dinein: true, delivery: true },
      updatedAt: new Date().toISOString()
    }, null, 2));

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        ADMIN_KEY,
        DRIVER_KEY,
        KPOT_FLUSH_MS: '500',
        /* 24h hours spec: the tick holds `open` on the clock, and this probe
           runs at any hour. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
        ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups')
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
    const page = list.find((t) => t.type === 'page');
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await new Promise((r) => cdp.ws.addEventListener('open', r));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* ==================================================================== */
    section('the key gate comes first');

    await cdp.send('Page.navigate', { url: BASE + '/driver.html' });
    await cdp.waitFor('!!document.querySelector("#gate")', 15000, 'the driver page');

    check('the run is hidden before a key is entered',
      await cdp.evalJs(`(() => { const r = document.querySelector('#run');
        return r.hidden === true && document.querySelectorAll('#cards .card').length === 0; })()`));
    check('no address is on screen yet',
      await cdp.evalJs(`document.body.innerText.indexOf('NEAR Test Rd') === -1`));

    /* ==================================================================== */
    section('a wrong key does not get in');

    await cdp.evalJs(`(() => { const i = document.querySelector('#keyIn');
      i.value = 'definitely-not-the-key';
      document.querySelector('#keyGo').click(); return 1; })()`);
    await cdp.waitFor(`(() => { const e = document.querySelector('#keyErr');
      return e && e.textContent.length > 0; })()`, 10000, 'the rejection message');
    check('the page says the key was not accepted',
      /not accepted/i.test(await cdp.evalJs(`document.querySelector('#keyErr').textContent`)));
    check('and the run stays hidden',
      await cdp.evalJs(`document.querySelector('#run').hidden === true`));

    /* ==================================================================== */
    section('the right key opens the run');

    await cdp.evalJs(`(() => { const i = document.querySelector('#keyIn');
      i.value = ${JSON.stringify(DRIVER_KEY)};
      document.querySelector('#keyGo').click(); return 1; })()`);
    await cdp.waitFor(`document.querySelectorAll('#cards .card').length >= 1`, 15000, 'the run to load');

    const first = await cdp.evalJs(RUN);
    check('every seeded delivery is on the page',
      first.length === 5, 'got ' + first.length + ' cards: ' + JSON.stringify(first.map((c) => c.addr)));
    check('the cards are in RUN order (window first, then nearest)',
      first.map((c) => c.addr).join(' | ') ===
        '7 NEAR Test Rd, Atlanta, GA 30339 | 3 NEAR Test Rd, Atlanta, GA 30339 | 19 NEAR Test Rd, Atlanta, GA 30339 | 10 NEAR Test Rd, Atlanta, GA 30339 | 5 NEAR Test Rd, Atlanta, GA 30339',
      first.map((c) => c.addr).join(' | '));
    check('the sequence numbers count up 1..n',
      first.map((c) => c.seq).join(',') === '1,2,3,4,5',
      first.map((c) => c.seq).join(','));
    check('the summary says how many are left',
      /5\s+deliveries to go/.test(await cdp.evalJs(`document.querySelector('#summary').textContent`)),
      await cdp.evalJs(`document.querySelector('#summary').textContent`));

    /* ==================================================================== */
    section('what the first card carries');

    const c0 = first[0];
    check('the window', c0.win === '12:00 PM – 1:00 PM', c0.win);
    check('the measured distance', c0.mi === '0.7 mi', c0.mi);
    check('a paid badge, because it is paid', c0.paid === 'Paid', c0.paid);
    check('the address, big and tappable into Maps',
      c0.maps === 'https://maps.google.com/?q=' + encodeURIComponent('7 NEAR Test Rd, Atlanta, GA 30339'),
      c0.maps);
    check('the customer, with a tap-to-call link',
      c0.tel === 'tel:4045550202', c0.tel);
    check('what is in the bag', c0.bag === '2× Pick 2 Proteins Bowl', c0.bag);
    check('the note from the guest', c0.note === 'Gate code 1234', c0.note);
    check('the total', c0.tot === '$33.90', c0.tot);
    check('and a Delivered button', c0.deliver === true);

    const second = first[1];
    check('the unpaid one is marked loudly', second.paid === 'NOT PAID', second.paid);
    /* The leftover from yesterday sits in the 2pm window, so it is the 4th
       card — the 4pm order is later in the day even though it is nearer. */
    const leftover = first[3];
    check("yesterday's leftover is flagged", leftover.overdue === true, JSON.stringify(leftover.overdue));
    check('and the last card of the day is the 4pm one', first[4].win === '4:00 PM – 5:00 PM', first[4].win);

    /* ==================================================================== */
    section('tapping Delivered');

    await cdp.evalJs(`document.querySelector('#cards button.deliver').click()`);
    await cdp.waitFor(`document.querySelectorAll('#cards .card').length === 4`, 15000, 'the card to go');
    const after = await cdp.evalJs(RUN);
    check('the delivered card is gone', after.every((c) => c.addr.indexOf('7 NEAR') === -1));
    check('the rest renumber from 1',
      after.map((c) => c.seq).join(',') === '1,2,3,4', after.map((c) => c.seq).join(','));
    check('and the summary counts down',
      /4\s+deliveries to go/.test(await cdp.evalJs(`document.querySelector('#summary').textContent`)),
      await cdp.evalJs(`document.querySelector('#summary').textContent`));

    /* ==================================================================== */
    section('the empty state');

    for (let i = 0; i < 4; i++) {
      await cdp.evalJs(`document.querySelector('#cards button.deliver').click()`);
      await sleep(600);
    }
    await cdp.waitFor(`document.querySelector('#empty').hidden === false`, 15000, 'the empty state');
    check('when nothing is left, the page says so',
      /Nothing left to deliver/.test(await cdp.evalJs(`document.querySelector('#empty').innerText`)),
      await cdp.evalJs(`document.querySelector('#empty').innerText`));
    check('and no cards remain',
      await cdp.evalJs(`document.querySelectorAll('#cards .card').length === 0`));

    /* ==================================================================== */
    section('forget this phone');

    await cdp.evalJs(`document.querySelector('#forget').click()`);
    check('the key is gone and the gate is back',
      await cdp.evalJs(`(() => { const r = document.querySelector('#run');
        return r.hidden === true && localStorage.getItem('kpotDriverKey') === null; })()`));

    check('the page never threw',
      cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l)).length === 0,
      cdp.logs.join('\n'));

    /* ==================================================================== */
    section('what the server logged');

    /* Poll for the line: serverLog is filled from a pipe, so the last write
       may not have reached this process yet when the last card disappeared. */
    let sawDriverLog = false;
    for (let i = 0; i < 20 && !sawDriverLog; i++) {
      sawDriverLog = /driver marked order DRV-NEAR delivered/.test(serverLog);
      if (!sawDriverLog) await sleep(250);
    }
    check('the driver completing orders was logged', sawDriverLog,
      'no such line in the server log');

    const code = fail === 0 ? 0 : 1;
    console.log('\n' + '='.repeat(74));
    console.log(pass + ' passed, ' + fail + ' failed');
    await cleanup();
    setTimeout(() => process.exit(code), 300);
  } catch (e) {
    console.error('probe error:', e && e.message);
    await cleanup();
    setTimeout(() => process.exit(1), 300);
  }
}

main();
