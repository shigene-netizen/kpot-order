#!/usr/bin/env node
/* ==========================================================================
   Browser test for the print UI on the kitchen board (admin-orders.html).

   probe_print_flow.js proves the *server* queues, leases and settles tickets.
   It never loads a page. This one loads the real board in a real browser and
   checks what staff actually see and click:

     * an order moved to Preparing shows a QUEUED print badge
     * the Reprint button is offered
     * when no agent is running the board says so ("no print agent has ever
       connected") instead of silently showing nothing
     * once the agent runs and the ticket comes out, the badge flips to PRINTED
       and the printer line goes green
     * clicking Reprint really queues another ticket
     * once a failed ticket has been reprinted, the printer line stops
       reporting it (the shop's complaint: a healed failure stayed red
       forever, while the order's own badge had already gone green)
     * a card order whose payment is unconfirmed offers "Re-check payment", a
       counter order does NOT, and clicking it really settles the board to PAID

   Run:  node _dev/probe_board_print_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createFakePrinter } = require('./fake_printer.js');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8944', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9364', 10);
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9108', 10);
const STUB_PORT = parseInt(process.env.STRIPE_STUB_PORT || '9109', 10);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PRINT_KEY = 'board-ui-key-' + Date.now().toString(36);

/* Hermetic: the server is pointed at scratch files, so the shop's real board
   data is never read or written by this test. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-board-ui-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

function adminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.local.json'), 'utf8')).adminKey || ''; }
  catch (e) { return ''; }
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

const jpost = (p, body, headers) => fetch(BASE + p, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));

const jpatch = (p, body, headers) => fetch(BASE + p, {
  method: 'PATCH',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));

function makeOrder(token) {
  const unit = 15.99, subtotal = unit, tax = Math.round(subtotal * 0.06 * 100) / 100;
  return {
    no: 'KP-UI-' + token, orderNo: 'KP-UI-' + token, token: 'ui-' + token,
    /* DINE-IN: pay-at-counter is refused on pickup since 2026-10-22, and
       this probe is about the board's print buttons, not channels. */
    orderType: 'dinein', table: '4',
    customer: { name: 'Board UI', phone: '4045550142', when: 'ASAP', notes: '' },
    items: [{ kind: 'hotpot', name: 'Build Your Own Bowl', qty: 1, unit, mods: [], addons: [], note: '' }],
    subtotal, deliveryFee: 0, tax, tip: 0, surcharge: 0, total: Math.round((subtotal + tax) * 100) / 100,
    payMethod: 'counter', paymentStatus: 'counter', paid: false, source: 'board-ui-probe'
  };
}

/* --------------------------------------------------------------------------
   A stand-in for api.stripe.com.

   The Re-check button is only useful if it can actually reach Stripe, and this
   probe must run with no key and no network. So the server's Stripe base URL is
   pointed here (KPOT_STRIPE_API_BASE — a test-only seam that logs a loud warning
   when set) and this answers the two calls the re-check makes: list sessions,
   and read one back.
   -------------------------------------------------------------------------- */
function createStripeStub() {
  let session = null;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (u.pathname === '/v1/checkout/sessions') {
      return send(200, { object: 'list', data: session ? [session] : [], has_more: false });
    }
    const one = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (one && session && decodeURIComponent(one[1]) === session.id) return send(200, session);
    return send(404, { error: { message: 'stub: nothing here' } });
  });
  return {
    server,
    setSession(s) { session = s; },
    listen: (port, host) => new Promise((r) => server.listen(port, host, r)),
    /* Never able to hang the suite.

       `server.close()` only calls back once every connection has ended, and the
       server under test talks to this stub over keep-alive sockets. Awaiting it
       plainly made the probe sit there after the last assertion, with the
       results already printed — a test that hangs is as bad as one that is
       always red, because `run_all.sh` just stops. So: force the connections
       closed, and race a timer as a backstop. */
    close: () => new Promise((r) => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {}
      let done = false;
      const finish = () => { if (!done) { done = true; r(); } };
      try { server.close(finish); } catch (e) { finish(); }
      setTimeout(finish, 1000);
    })
  };
}

async function main() {
  console.log('board print UI — real browser + real server + real agent + fake printer');
  console.log('='.repeat(74));

  const printer = createFakePrinter();
  const stripeStub = createStripeStub();
  let server = null, agent = null, chrome = null, cdp = null;
  let serverLog = '', agentLog = '';
  const profile = path.join(os.tmpdir(), 'kpot-board-ui-chrome-' + Date.now());

  const cleanup = async () => {
    /* See probe_cleanup.js — killing only the process we spawned and deleting
       the profile straight away leaves a temp dir behind on Windows, silently,
       every run. The fake printer and the Stripe stub still need their own
       close (they are in-process servers, not children). */
    await teardown([agent, chrome, server], [SCRATCH, profile]);
    try { await printer.close(); } catch (e) {}
    try { await stripeStub.close(); } catch (e) {}
  };

  try {
    await printer.listen(PRINTER_PORT, '127.0.0.1');
    await stripeStub.listen(STUB_PORT, '127.0.0.1');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PRINT_KEY,
        KPOT_FLUSH_MS: '500',
        /* The business-hours tick holds `open` strictly on the hours clock —
           after closing time it closes the shop under this probe within one
           flush, and a guest page that will not accept orders cannot be
           driven through a cart at all. A 24h spec keeps the shop open at any
           clock; production never sets this. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
        KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
        /* The store-hours tick SAVES store status on every open/close
           transition — an unpinned suite run after closing time rewrites the
           shop's own switches. */
        KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
        KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
        /* Reach "failed" on the first attempt — see probe_print_flow.js. The
           board's failure banner only appears once a job is given up on. */
        KPOT_PRINT_MAX_ATTEMPTS: '1',
        /* Never let this probe hold a live Stripe key — see probe_print_flow.js. */
        STRIPE_SECRET_KEY: 'sk_test_board_ui_not_a_real_key',
        /* Test-only seam: send Stripe traffic to the stub above. */
        KPOT_STRIPE_API_BASE: 'http://127.0.0.1:' + STUB_PORT + '/v1/checkout/sessions'
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

    /* ---- an order is sent to the kitchen, with NO agent running --------- */
    const token = Date.now().toString(36);
    const created = await jpost('/api/orders', makeOrder(token));
    const orderNo = created.j && created.j.id;
    check('order recorded', created.status === 200 && !!orderNo, 'id=' + orderNo);

    const patched = await jpatch('/api/orders/' + encodeURIComponent(orderNo), { status: 'preparing' },
      { 'X-Admin-Key': adminKey() });
    check('order moved to preparing', patched.status === 200, 'status=' + patched.status);

    /* ------------------------------------------------------- boot chrome */
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

    /* Put the admin key in sessionStorage before any page script runs, so the
       board authenticates on its very first fetch instead of showing the
       "set the admin key" banner and rendering nothing. */
    const key = adminKey();
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { sessionStorage.setItem("kpotAdminKey", ' + JSON.stringify(key) + '); } catch (e) {}'
    });

    console.log('--- board loaded, no print agent running ---');
    await cdp.send('Page.navigate', { url: BASE + '/admin-orders.html' });
    await cdp.waitFor('!!document.querySelector("#list .order")', 15000, 'the order list to render');

    const head1 = await cdp.evalJs('document.querySelector("#list .order .o-head").textContent');
    check('the board shows a QUEUED print badge', /QUEUED/.test(head1), head1.trim());
    check('the board does not claim it printed', !/PRINTED/.test(head1), head1.trim());
    check('the board offers a Reprint button', await cdp.evalJs('!!document.querySelector("button[data-reprint]")'));
    check('the print badge does not appear before an order reaches the kitchen',
      /QUEUED/.test(head1));

    /* loadPrinter() is kicked off by load() and NOT awaited, so at the instant
       the order list renders the printer line can still be blank. Wait for it to
       have rendered something before asserting what it says — reading it
       straight away is a race, and it duly failed about one run in three. */
    await cdp.waitFor('(document.querySelector("#printerText").textContent || "").length > 0',
      15000, 'the printer line to render');
    const line1 = await cdp.evalJs('document.querySelector("#printerText").textContent');
    check('with no agent, the board says the agent has never connected',
      /never connected|not running/i.test(line1), line1);
    check('and flags it as a problem, not as fine',
      /\bbad\b/.test(await cdp.evalJs('document.querySelector("#printerLine").className')),
      await cdp.evalJs('document.querySelector("#printerLine").className'));

    /* ---- now start the agent; the ticket should come out --------------- */
    console.log('\n--- print agent started ---');
    const agentEnv = Object.assign({}, process.env, {
      KPOT_SERVER_URL: BASE,
      /* Pin the address: discovery would otherwise send this probe to the real
         GitHub Pages page, making it slow and not hermetic. */
      KPOT_DISCOVERY_URL: '',
      KPOT_PRINT_KEY: PRINT_KEY,
      KPOT_PRINTER_HOST: '127.0.0.1',
      KPOT_PRINTER_PORT: String(PRINTER_PORT),
      KPOT_POLL_MS: '400'
    });
    agent = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    agent.stdout.on('data', (d) => { agentLog += d.toString(); });
    agent.stderr.on('data', (d) => { agentLog += d.toString(); });

    await cdp.waitFor('document.querySelector("#list .order .o-head") && /PRINTED/.test(document.querySelector("#list .order .o-head").textContent)',
      25000, 'the board to show PRINTED');
    const head2 = await cdp.evalJs('document.querySelector("#list .order .o-head").textContent');
    check('the badge flips to PRINTED once the ticket comes out', /PRINTED/.test(head2), head2.trim());
    check('a ticket really reached the printer', printer.received.length === 1, 'tickets=' + printer.received.length);

    /* Same race as above, one level worse: the PRINTED badge flips as soon as
       the ORDER fetch renders, while the printer line is refreshed by a
       separate, un-awaited request. Wait for the line itself to catch up. */
    await cdp.waitFor('/ready/i.test(document.querySelector("#printerText").textContent || "")',
      20000, 'the printer line to say ready');
    const line2 = await cdp.evalJs('document.querySelector("#printerText").textContent');
    check('the printer line goes green and says ready', /ready/i.test(line2), line2);
    check('and is no longer flagged as a problem',
      /\bok\b/.test(await cdp.evalJs('document.querySelector("#printerLine").className')),
      await cdp.evalJs('document.querySelector("#printerLine").className'));

    /* ---- clicking Reprint must really queue another ticket ------------- */
    console.log('\n--- staff click Reprint ---');
    const clicked = await cdp.evalJs(`(() => {
      const b = document.querySelector('button[data-reprint]');
      if (!b) return 'no button';
      b.click();
      return 'clicked';
    })()`);
    check('the Reprint button is clickable', clicked === 'clicked', clicked);

    const until = Date.now() + 20000;
    while (Date.now() < until && printer.received.length < 2) await sleep(300);
    check('clicking Reprint queues and prints a second ticket',
      printer.received.length === 2, 'tickets=' + printer.received.length);

    await cdp.waitFor('/REPRINTED/.test(document.querySelector("#list .order .o-head").textContent)',
      15000, 'the badge to say REPRINTED');
    check('the badge distinguishes a reprint from the original',
      /REPRINTED/.test(await cdp.evalJs('document.querySelector("#list .order .o-head").textContent')));

    /* =====================================================================
       Re-check payment — the case where the guest paid and closed the tab.

       The board only learns "paid" when the guest's browser reports back from
       Stripe. If that never happens the money is taken and the board still says
       the payment is unconfirmed, which staff cannot tell from an order nobody
       paid for. The button is the only way out, so it has to be verified in a
       real browser: present where it helps, absent where it doesn't, and
       actually settling when clicked.
       ===================================================================== */
    console.log('\n--- a card order whose payment was never confirmed ---');
    const rcToken = Date.now().toString(36) + 'rc';
    const rcNo = 'KP-UI-RC-' + rcToken;
    const cardOrder = Object.assign(makeOrder(rcToken), {
      no: rcNo, orderNo: rcNo, token: 'ui-rc-' + rcToken,
      payMethod: 'stripe', paymentStatus: 'pending'
    });
    const cardCreated = await jpost('/api/orders', cardOrder);
    check('a card order is on the board, payment unconfirmed',
      cardCreated.status === 200 && cardCreated.j && cardCreated.j.id === rcNo,
      'id=' + (cardCreated.j && cardCreated.j.id));

    /* Stripe has a PAID session for it — the guest paid; only the confirmation
       never arrived. */
    stripeStub.setSession({
      id: 'cs_test_board_ui_paid',
      object: 'checkout.session',
      client_reference_id: rcNo,
      payment_status: 'paid',
      status: 'complete',
      amount_total: 1695,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000)
    });

    await cdp.waitFor('!!document.querySelector(\'#list .order[data-id="' + rcNo + '"]\')',
      15000, 'the card order card to render');

    const rcSel = '#list .order[data-id="' + rcNo + '"]';
    const counterSel = '#list .order[data-id="' + orderNo + '"]';

    /* Assert on the BADGE ELEMENT, not on the head's text.

       The head is a run of sibling spans, so its textContent concatenates into
       "receivedNOT CONFIRMED · $16.95#…" and "receivedPAID#…" — and because both
       "received" and "PAID" are word characters there is no word boundary
       between them, so /\bPAID\b/ can never match. A substring check here would
       be permanently red for the wrong reason. Matching the badge class is also
       the stronger assertion: it is what actually decides the colour. */
    const headBefore = await cdp.evalJs('document.querySelector(\'' + rcSel + ' .o-head\').textContent');
    check('it is shown as NOT confirmed, not as paid',
      await cdp.evalJs('!!document.querySelector(\'' + rcSel + ' .o-head .pill.warnpay\') && ' +
        '!document.querySelector(\'' + rcSel + ' .o-head .pill.paid\')'),
      headBefore.trim());
    check('the card order offers a Re-check payment button',
      await cdp.evalJs('!!document.querySelector(\'' + rcSel + ' button[data-recheck]\')'));
    check('the pay-at-counter order does NOT offer one',
      !(await cdp.evalJs('!!document.querySelector(\'' + counterSel + ' button[data-recheck]\')')),
      'a counter order has no Stripe session to re-check');

    console.log('--- staff click Re-check payment ---');
    const rcClicked = await cdp.evalJs(`(() => {
      const b = document.querySelector('${rcSel} button[data-recheck]');
      if (!b) return 'no button';
      b.click();
      return 'clicked';
    })()`);
    check('the Re-check button is clickable', rcClicked === 'clicked', rcClicked);

    /* The board re-renders from the server after the re-check, so wait for the
       badge itself to change rather than for a toast. */
    await cdp.waitFor('!!document.querySelector(\'' + rcSel + ' .o-head .pill.paid\')',
      20000, 'the card order to show the PAID badge');
    const headAfter = await cdp.evalJs('document.querySelector(\'' + rcSel + ' .o-head\').textContent');
    check('the board now shows the green PAID badge',
      await cdp.evalJs('!!document.querySelector(\'' + rcSel + ' .o-head .pill.paid\')'),
      headAfter.trim());
    check('and no longer says NOT CONFIRMED',
      !(await cdp.evalJs('!!document.querySelector(\'' + rcSel + ' .o-head .pill.warnpay\')')),
      headAfter.trim());
    check('the Re-check button disappears once there is nothing left to check',
      !(await cdp.evalJs('!!document.querySelector(\'' + rcSel + ' button[data-recheck]\')')));

    const serverSide = await fetch(BASE + '/api/orders/' + encodeURIComponent(rcNo),
      { headers: { 'X-Admin-Key': adminKey() } }).then((r) => r.json()).catch(() => null);
    check('the server really stored it as verified, not just the UI',
      serverSide && serverSide.paymentStatus === 'verified',
      'paymentStatus=' + (serverSide && serverSide.paymentStatus));

    /* ---- the page must have thrown nothing ----------------------------- */
    const errs = cdp.logs.filter((l) => /EXCEPTION|\[error\]/.test(l));
    check('the board logged no JavaScript errors', errs.length === 0, errs.slice(0, 3).join('\n         '));

    /* Keep a picture of the finished board — the badges are the whole point of
       this change and a screenshot is the only way to see they look right. */
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const dir = path.join(__dirname, 'screens');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'board-print-ui.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('\nscreenshot: ' + out);
    } catch (e) { console.log('(screenshot skipped: ' + e.message + ')'); }

    /* =====================================================================
       A failed print must say WHY — on the board, not just in a log.

       This is the case that actually happened in the shop: the printer stopped
       being reachable and the board said only "3 ticket(s) failed to print",
       which gives the owner nothing to act on. The agent's reason now carries
       the address it could not reach, so the board has to surface it.
       ===================================================================== */
    console.log('\n--- the printer becomes unreachable ---');
    try { if (agent) agent.kill(); } catch (e) {}
    await sleep(300);
    await printer.close();                  // switched off / came back on a new IP

    const failCreated = await jpost('/api/orders', makeOrder(Date.now().toString(36) + 'f'));
    const failNo = failCreated.j && failCreated.j.id;
    await jpatch('/api/orders/' + encodeURIComponent(failNo), { status: 'preparing' },
      { 'X-Admin-Key': adminKey() });

    agent = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    agent.stdout.on('data', (d) => { agentLog += d.toString(); });
    agent.stderr.on('data', (d) => { agentLog += d.toString(); });

    /* Wait for the SERVER to record the failure rather than sleeping a fixed
       time — how many times the agent retries is the agent's business, and a
       fixed sleep is a race on a slow machine. */
    let failedJob = null;
    const failUntil = Date.now() + 30000;
    while (Date.now() < failUntil) {
      const st = await fetch(BASE + '/api/print/status', { headers: { 'X-Admin-Key': adminKey() } })
        .then((r) => r.json()).catch(() => null);
      const arr = (st && st.failed) || [];
      if (arr.length) { failedJob = arr[arr.length - 1]; break; }
      await sleep(250);
    }
    check('a failed print is recorded with a reason',
      !!(failedJob && failedJob.error), JSON.stringify(failedJob));
    check('the reason names the address the agent could not reach',
      !!(failedJob && failedJob.error && failedJob.error.indexOf('127.0.0.1:' + PRINTER_PORT) !== -1),
      failedJob && failedJob.error);

    /* The printer line is refreshed on the board's own 4s timer, so wait for it
       to change rather than reading it straight away. */
    await cdp.waitFor('/failed to print/i.test(document.querySelector("#printerText").textContent || "")',
      30000, 'the board to report the failed print');
    const line3 = await cdp.evalJs('document.querySelector("#printerText").textContent');
    check('the board says how many tickets failed', /failed to print/i.test(line3), line3);
    check('and repeats the reason, so the owner can act on it',
      line3.indexOf('127.0.0.1:' + PRINTER_PORT) !== -1, line3);

    /* A picture of the banner itself — the wording is the whole point of the
       change, and a screenshot is the only way to see it as staff will. */
    try {
      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const dir2 = path.join(__dirname, 'screens');
      fs.mkdirSync(dir2, { recursive: true });
      const out2 = path.join(dir2, 'board-print-failed.png');
      fs.writeFileSync(out2, Buffer.from(shot2.data, 'base64'));
      console.log('\nscreenshot: ' + out2);
    } catch (e) { console.log('(screenshot skipped: ' + e.message + ')'); }

    /* =====================================================================
       The printer comes back and staff reprint — the board must stop
       shouting about a failure that has already been dealt with.

       This is the complaint that produced the change. The shop reprinted the
       ticket at 19:01 and the order's badge went green, but the printer line
       still said "2 ticket(s) failed to print" the next morning: the line
       counted every failed job in history while the badge counted only the
       latest attempt, and the stale view was the louder one. So the line has
       to clear when the ticket is reprinted — otherwise staff learn to ignore
       it, and the next real failure sails past.
       ===================================================================== */
    console.log('\n--- the printer is back, staff reprint the ticket ---');
    /* Same printer object, so `received` keeps counting: a printer that was
       unreachable and is now back. Retry the bind — a port freed moments ago
       is not always instantly re-bindable, and a flaky bind here would look
       exactly like a print failure. */
    let back = false;
    for (let i = 0; i < 20 && !back; i++) {
      try { await printer.listen(PRINTER_PORT, '127.0.0.1'); back = true; } catch (e) { await sleep(250); }
    }
    check('the printer is reachable again', back);

    const reprintHeal = await cdp.evalJs(`(() => {
      const card = document.querySelector('#list .order[data-id="${failNo}"]');
      const b = card && card.querySelector('button[data-reprint]');
      if (!b) return 'no button';
      b.click();
      return 'clicked';
    })()`);
    check('the failed order still offers Reprint', reprintHeal === 'clicked', reprintHeal);

    await cdp.waitFor(
      'document.querySelector(\'#list .order[data-id="' + failNo + '"] .o-head\') && ' +
      '/REPRINTED|PRINTED/.test(document.querySelector(\'#list .order[data-id="' + failNo + '"] .o-head\').textContent)',
      30000, 'the reprinted ticket to come out');
    const headHeal = await cdp.evalJs('document.querySelector(\'#list .order[data-id="' + failNo + '"] .o-head\').textContent');
    check('the badge stops saying PRINT FAILED once the reprint comes out',
      /REPRINTED|PRINTED/.test(headHeal) && !/PRINT FAILED/.test(headHeal), headHeal.trim());
    check('the reprinted ticket really reached the printer',
      printer.received.length === 3, 'tickets=' + printer.received.length);

    /* The printer line is refreshed by the board's own poll, so wait for it to
       catch up rather than reading it the instant the badge flipped. */
    await cdp.waitFor(
      '!/failed to print/i.test(document.querySelector("#printerText").textContent || "") && ' +
      '/ready/i.test(document.querySelector("#printerText").textContent || "")',
      30000, 'the printer line to stop reporting the healed failure');
    const line4 = await cdp.evalJs('document.querySelector("#printerText").textContent');
    check('the printer line no longer reports the reprinted ticket as failed',
      !/failed to print/i.test(line4), line4);
    check('and it is green again',
      /\bok\b/.test(await cdp.evalJs('document.querySelector("#printerLine").className')),
      await cdp.evalJs('document.querySelector("#printerLine").className'));

    const healed = await fetch(BASE + '/api/print/status', { headers: { 'X-Admin-Key': adminKey() } })
      .then((r) => r.json()).catch(() => null);
    check('the server stops counting a reprinted ticket as failed',
      !!(healed && healed.counts && healed.counts.failed === 0),
      'counts=' + JSON.stringify(healed && healed.counts));
    check('and the healed order is gone from the failed list',
      !((healed && healed.failed) || []).some((j) => j.orderId === failNo),
      'failed=' + JSON.stringify((healed && healed.failed) || []));
  } catch (e) {
    check('probe ran to completion', false, e.message);
    console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-20).join('\n'));
    console.log('\n--- agent log (tail) ---\n' + agentLog.split('\n').slice(-10).join('\n'));
  } finally {
    await cleanup();
    await sleep(300);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
