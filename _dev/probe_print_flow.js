#!/usr/bin/env node
/* ==========================================================================
   End-to-end test of the kitchen print path — no printer required.

   Real server.js  +  real print-agent/agent.js  +  a fake printer socket.

   The whole chain, exactly as it runs in the shop:

     POST an order
       -> PATCH it to 'preparing'          (what the board's button does)
       -> server queues a rendered ticket
       -> the agent collects it and writes the bytes to TCP 9100
       -> the fake printer records them
       -> the agent acks; the board shows "printed"

   Then the things that actually go wrong in a restaurant:

     * tapping Preparing twice must NOT print twice
     * a reprint must print again
     * a wrong print key must print nothing at all
     * a printer that is switched off must NOT be reported as printed
       (otherwise the ticket is lost and nobody knows)
     * a ticket reprinted after a failure must stop being counted as failed
       (a board that never stops crying wolf gets ignored, and then the next
       real failure gets missed too)
     * a cancelled order's failed ticket is not outstanding work either

   Run:  node _dev/probe_print_flow.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createFakePrinter } = require('./fake_printer.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8943', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9107', 10);
const PRINT_KEY = 'probe-print-key-' + Date.now().toString(36);

/* Hermetic scratch state. The shop's real orders.local.json and print.local.json
   are never touched, so a hard kill mid-run cannot damage them — which the old
   backup/restore approach could not promise.

   This matters more than it looks. The first version inherited the real
   print.local.json, and a stale *pending* job left behind by the previous run's
   "printer switched off" scenario got printed at the top of the next run —
   the probe then saw tickets it had not asked for and reported false failures.
   A queue that survives restarts is exactly the thing that makes a test
   non-hermetic, so give each run its own. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-print-probe-'));
const ORDERS_FILE = path.join(SCRATCH, 'orders.local.json');
const PRINT_FILE = path.join(SCRATCH, 'print.local.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

/* Keep only the human-readable text: drop the escape sequences, then anything
   that is not printable ASCII. Lets the test assert on what the paper says. */
function ticketText(buf) {
  let s = buf.toString('latin1');
  s = s.replace(/\x1b@/g, '');
  s = s.replace(/\x1b[\x61\x45\x64\x74][\s\S]/g, '');     // ESC a/E/d/t + 1 arg
  s = s.replace(/\x1d\x21[\s\S]/g, '');                     // GS ! n
  s = s.replace(/\x1d\x56[\s\S]{1,2}/g, '');                // GS V m [n]
  return s.replace(/[^\x20-\x7E\n]/g, '');
}

async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(150);
  }
  throw new Error('timed out waiting for ' + label);
}

/* Order updates are PATCH on this server (/api/orders/:id). POST is 405 —
   which is exactly what the first run of this probe reported, so the helper
   below is deliberately explicit about the verb instead of guessing. */
const jreq = (method, p, body, headers) => fetch(BASE + p, {
  method,
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));

const jpost = (p, body, headers) => jreq('POST', p, body, headers);
const jpatch = (p, body, headers) => jreq('PATCH', p, body, headers);

const jget = (p, headers) => fetch(BASE + p, { headers: headers || {} })
  .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j })));

function makeOrder(token, payMethod) {
  const unit = 15.99;
  const subtotal = round2(unit);
  const tax = round2(subtotal * 0.06);
  return {
    no: 'KP-PRINT-' + token,
    orderNo: 'KP-PRINT-' + token,
    token: 'print-' + token,
    /* DINE-IN: since 2026-10-22 pay-at-counter is refused on pickup and
       delivery, and these suites are about money/printing, not channels. */
    orderType: 'dinein',
    table: '5',
    customer: { name: 'Print Probe', phone: '', when: 'ASAP', notes: 'no chopsticks' },
    items: [{ kind: 'hotpot', name: 'Build Your Own Bowl', qty: 1, unit, mods: ['Broth: Japanese Miso'], addons: [], note: '' }],
    subtotal, deliveryFee: 0, tax, tip: 0, surcharge: 0,
    total: round2(subtotal + tax),
    payMethod: payMethod || 'counter',
    paymentStatus: payMethod === 'stripe' ? 'verified' : 'counter',
    paid: false,
    source: 'print-probe'
  };
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('kitchen print — end-to-end (real server + real agent + fake printer)');
  console.log('='.repeat(74));

  /* Nothing to back up: the server is pointed at SCRATCH (see env below), so
     there is no shop data in play and no restore to get wrong. */
  const restore = () => {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  };

  const printer = createFakePrinter();
  let server = null;
  let agent = null;
  let agentLog = '';
  let serverLog = '';

  const cleanup = () => {
    try { if (agent) agent.kill(); } catch (e) {}
    try { if (server) server.kill(); } catch (e) {}
    return printer.close();
  };

  try {
    await printer.listen(PRINTER_PORT, '127.0.0.1');
    console.log('fake printer listening on 127.0.0.1:' + PRINTER_PORT + '\n');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PRINT_KEY,
        KPOT_FLUSH_MS: '1000',
        KPOT_ORDERS_FILE: ORDERS_FILE,
        KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS_FILE), 'customers.local.json'),
        /* The store-hours tick SAVES store status on every open/close
           transition — an unpinned suite run after closing time rewrites the
           shop's own switches. */
        KPOT_STORE_FILE: path.join(path.dirname(ORDERS_FILE), 'store.local.json'),
        /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
           refuses those outside opening hours. The clock must not decide these
           cases. See hoursSpec() in server.js. */
        KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
        KPOT_PRINT_FILE: PRINT_FILE,
        /* Reach "failed" on the first attempt. The real backoff runs 2s, 4s,
           8s … 60s, so waiting out 10 attempts would add ~5 minutes to the
           suite; the state under test is the same either way. */
        KPOT_PRINT_MAX_ATTEMPTS: '1',
        /* This probe is about paper, not money — but an EMPTY env var does NOT
           disable Stripe: loadSecretKey() falls through to secrets.local.json,
           so the first run of this probe booted the server in LIVE mode. Never
           hand this process a live key: inject a deliberately bogus test key so
           any accidental Stripe call fails harmlessly instead of charging a
           real card. Asserted below. */
        STRIPE_SECRET_KEY: 'sk_test_probe_not_a_real_key'
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

    /* Guard: this probe must never hold a live Stripe key. */
    const modeLine = (serverLog.match(/\[kpot\] stripe key: .*/) || [''])[0];
    check('server booted without a live Stripe key', !/live/.test(modeLine),
      modeLine.trim() || '(no key line)');

    /* ---- 1. an order arrives ------------------------------------------- */
    const token = Date.now().toString(36);
    const order = makeOrder(token, 'counter');
    const created = await jpost('/api/orders', order);
    const orderNo = created.j && created.j.id;
    check('order recorded', created.status === 200 && !!orderNo, 'id=' + orderNo);

    const before = printer.received.length;
    check('nothing printed before Preparing is tapped', before === 0, 'tickets=' + before);

    /* ---- 2. staff tap PREPARING ---------------------------------------- */
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

    await sleep(1200);   // let the agent do its startup check
    const patched = await jpatch('/api/orders/' + encodeURIComponent(orderNo), { status: 'preparing' },
      { 'X-Admin-Key': adminKey() });
    check('board moved the order to preparing',
      patched.status === 200 && patched.j && patched.j.status === 'preparing',
      'status=' + patched.status + ' body=' + JSON.stringify(patched.j));

    await waitFor(() => printer.received.length >= 1, 15000, 'the ticket to reach the printer');
    const ticket = printer.received[0];
    const text = ticketText(ticket);
    check('a ticket reached the printer', printer.received.length === 1, 'tickets=' + printer.received.length);
    check('the ticket names the order', text.includes(orderNo), text.split('\n').slice(0, 8).join(' / '));
    check('the ticket says the item', text.includes('Build Your Own Bowl'));
    check('the ticket shouts UNPAID for a pay-at-counter order',
      /UNPAID/.test(text) && /COLLECT \$16\.95/.test(text),
      (text.match(/.*(UNPAID|COLLECT).*/g) || []).join(' | '));
    check('the ticket carries the customer note', /no chopsticks/.test(text));
    check('the ticket is cut at the end', ticket.slice(-4).toString('hex') === '1d564200',
      'last bytes: ' + ticket.slice(-4).toString('hex'));

    /* ---- 3. the board learns it printed -------------------------------- */
    await waitFor(async () => {
      const r = await jget('/api/orders', { 'X-Admin-Key': adminKey() });
      const o = (r.j && r.j.orders || []).find((x) => x.id === orderNo);
      return o && o.print && o.print.status === 'printed';
    }, 10000, 'the board to show printed').then(
      () => check('the board shows the ticket as PRINTED', true, ''),
      (e) => check('the board shows the ticket as PRINTED', false, e.message));

    /* ---- 4. tapping Preparing again must not double-print -------------- */
    await jpatch('/api/orders/' + encodeURIComponent(orderNo), { status: 'preparing' },
      { 'X-Admin-Key': adminKey() });
    await sleep(2500);
    check('re-tapping Preparing does NOT print a second ticket',
      printer.received.length === 1, 'tickets=' + printer.received.length);

    /* ---- 5. an explicit reprint does print again ----------------------- */
    const re = await jpost('/api/orders/' + encodeURIComponent(orderNo) + '/reprint', {},
      { 'X-Admin-Key': adminKey() });
    check('reprint request accepted', re.status === 200 && re.j && re.j.ok === true,
      'status=' + re.status + ' body=' + JSON.stringify(re.j));
    await waitFor(() => printer.received.length >= 2, 15000, 'the reprinted ticket');
    check('the reprint actually printed', printer.received.length === 2, 'tickets=' + printer.received.length);

    /* ---- 6. a wrong key prints nothing --------------------------------- */
    const badKey = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT,
      env: Object.assign({}, agentEnv, { KPOT_PRINT_KEY: 'definitely-not-the-key', KPOT_POLL_MS: '400' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let badLog = '';
    badKey.stdout.on('data', (d) => { badLog += d.toString(); });
    badKey.stderr.on('data', (d) => { badLog += d.toString(); });
    await sleep(2500);
    badKey.kill();
    check('a wrong print key is rejected and prints nothing',
      printer.received.length === 2, 'tickets=' + printer.received.length);
    check('the rejected agent says why', /401|print key/i.test(badLog),
      (badLog.match(/.*(401|print key).*/gi) || []).join(' | ').slice(0, 160));

    /* ---- 7. status endpoint tells the truth ---------------------------- */
    const st = await jget('/api/print/status', { 'X-Admin-Key': adminKey() });
    check('print status reports printed jobs',
      st.status === 200 && st.j && st.j.counts && st.j.counts.printed >= 1,
      JSON.stringify(st.j && st.j.counts));
    check('print status reports a recent agent check-in',
      !!(st.j && st.j.lastAgentPoll), 'lastAgentPoll=' + (st.j && st.j.lastAgentPoll));

    /* ---- 8. a switched-off printer must not look like success ---------- */
    agent.kill();
    await sleep(300);
    await printer.close();                     // "printer switched off"
    const order2 = makeOrder(Date.now().toString(36), 'counter');
    const c2 = await jpost('/api/orders', order2);
    const no2 = c2.j && c2.j.id;
    await jpatch('/api/orders/' + encodeURIComponent(no2), { status: 'preparing' }, { 'X-Admin-Key': adminKey() });

    agent = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    agent.stdout.on('data', (d) => { agentLog += d.toString(); });
    agent.stderr.on('data', (d) => { agentLog += d.toString(); });
    /* Wait for the SERVER to record the failure rather than sleeping a fixed
       time: how many times the agent retries is the agent's business, and a
       fixed sleep is a race on a slow machine. */
    let failedJobs = [];
    const fUntil = Date.now() + 30000;
    while (Date.now() < fUntil) {
      const s = await jget('/api/print/status', { 'X-Admin-Key': adminKey() });
      failedJobs = (s.j && s.j.failed) || [];
      if (failedJobs.length) break;
      await sleep(250);
    }

    const o2 = await jget('/api/orders', { 'X-Admin-Key': adminKey() });
    const rec2 = (o2.j && o2.j.orders || []).find((x) => x.id === no2);
    check('with the printer off, the ticket is NOT marked printed',
      !!(rec2 && rec2.print && rec2.print.status !== 'printed'),
      'print state=' + JSON.stringify(rec2 && rec2.print));
    check('the failure is recorded with a reason',
      failedJobs.length >= 1 || /refused|ECONNREFUSED|FAILED/i.test(agentLog),
      'failed=' + JSON.stringify(failedJobs.slice(0, 2)));
    check('and the reason names the address the agent tried',
      failedJobs.length >= 1 &&
        String(failedJobs[failedJobs.length - 1].error || '').indexOf('127.0.0.1:' + PRINTER_PORT) !== -1,
      'error=' + JSON.stringify(failedJobs.length ? failedJobs[failedJobs.length - 1].error : null));

    /* ---- 9. a MOVED printer: the reason must name the address ---------- */
    /* This is the failure the shop actually hit. The printer had come back on a
       different IP, so the connection went nowhere and timed out — and the
       board only said "failed to print", which is a dead end. 192.0.2.1 is
       TEST-NET-1: reserved for documentation and guaranteed not to answer, so a
       moved printer is reproduced deterministically (verified: it yields exactly
       "timed out after 0/965 bytes", the same message the shop saw). */
    agent.kill();
    await sleep(300);
    const timeoutAgent = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT,
      env: Object.assign({}, agentEnv, {
        KPOT_PRINTER_HOST: '192.0.2.1',
        KPOT_PRINT_TIMEOUT: '1500'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let timeoutLog = '';
    timeoutAgent.stdout.on('data', (d) => { timeoutLog += d.toString(); });
    timeoutAgent.stderr.on('data', (d) => { timeoutLog += d.toString(); });

    const order3 = makeOrder(Date.now().toString(36) + 't', 'counter');
    const c3 = await jpost('/api/orders', order3);
    const no3 = c3.j && c3.j.id;
    await jpatch('/api/orders/' + encodeURIComponent(no3), { status: 'preparing' },
      { 'X-Admin-Key': adminKey() });

    let timedOut = null;
    const tUntil = Date.now() + 40000;
    while (Date.now() < tUntil) {
      const s = await jget('/api/print/status', { 'X-Admin-Key': adminKey() });
      const mine = ((s.j && s.j.failed) || []).filter((j) => j.orderId === no3);
      if (mine.length) { timedOut = mine[mine.length - 1]; break; }
      await sleep(300);
    }
    timeoutAgent.kill();

    check('a timed-out print is recorded as failed', !!timedOut, JSON.stringify(timedOut));
    check('and it is reported as a timeout, not as a refusal',
      !!(timedOut && /timed out/i.test(timedOut.error || '')),
      timedOut && timedOut.error);
    check('and the reason names the address it could not reach',
      !!(timedOut && timedOut.error.indexOf('192.0.2.1:' + PRINTER_PORT) !== -1),
      timedOut && timedOut.error);

    /* ---- 10. a reprinted failure stops being counted -------------------- */
    /* The shop's actual complaint. Two tickets had failed during a network
       outage; one of them was reprinted successfully at 19:01 and its badge
       went green, yet the board still read "2 ticket(s) failed to print" the
       next morning — the printer line counted every failed job in history,
       while the per-order badge counted only the latest attempt. A line that
       never clears teaches staff to ignore it, which is how the next REAL
       failure gets missed. So a healed failure must drop out of the count. */
    const good = spawn(process.execPath, [path.join(ROOT, 'print-agent', 'agent.js')], {
      cwd: ROOT, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    good.stdout.on('data', (d) => { agentLog += d.toString(); });
    good.stderr.on('data', (d) => { agentLog += d.toString(); });

    /* The printer was switched off in section 8. Bring the SAME one back so
       `received` keeps counting: a printer that was off and is reachable
       again. Retry the bind — a port freed a moment ago is not always
       instantly re-bindable, and a flaky bind would masquerade as a failure. */
    let back = false;
    for (let i = 0; i < 20 && !back; i++) {
      try { await printer.listen(PRINTER_PORT, '127.0.0.1'); back = true; } catch (e) { await sleep(250); }
    }
    check('the printer is reachable again', back);

    const heal = await jpost('/api/orders/' + encodeURIComponent(no3) + '/reprint', {},
      { 'X-Admin-Key': adminKey() });
    check('the timed-out ticket can be reprinted', heal.status === 200 && heal.j && heal.j.ok === true,
      'status=' + heal.status + ' body=' + JSON.stringify(heal.j));
    await waitFor(() => printer.received.length >= 3, 20000, 'the reprinted ticket to come out');
    check('and it really came out of the printer', printer.received.length === 3,
      'tickets=' + printer.received.length);

    /* Give the server a moment to settle the job, then read the two views
       that must now agree. */
    await sleep(1200);
    const after = await jget('/api/print/status', { 'X-Admin-Key': adminKey() });
    check('a reprinted ticket is no longer counted as failed',
      !!(after.j && after.j.counts && after.j.counts.failed === 1),
      'counts=' + JSON.stringify(after.j && after.j.counts));
    check('and the only failure left is the one nobody reprinted',
      !!(after.j && after.j.failed && after.j.failed.length === 1 && after.j.failed[0].orderId === no2),
      'failed=' + JSON.stringify(after.j && after.j.failed));

    const after3 = await jget('/api/orders', { 'X-Admin-Key': adminKey() });
    const rec3 = (after3.j && after3.j.orders || []).find((x) => x.id === no3);
    check('and the order\'s own badge shows the reprint, not the failure',
      !!(rec3 && rec3.print && rec3.print.status === 'printed' && rec3.print.reprint === true),
      'print=' + JSON.stringify(rec3 && rec3.print));

    /* ---- 11. a cancelled order's ticket is not outstanding work --------- */
    /* The second half of the shop's complaint, found on the live board after
       the reprint fix: the one failure left was KP-261022-004, whose order had
       been cancelled 45 seconds after the ticket failed for good. Printing a
       dead order into the kitchen makes them cook food nobody ordered, and
       nobody will ever reprint it — so the line must stop counting it too.
       A COMPLETED order's failure is deliberately NOT excused: the food is out,
       but the ticket really never printed, and that is worth knowing. */
    const cancelled = await jpatch('/api/orders/' + encodeURIComponent(no2), { status: 'cancelled' },
      { 'X-Admin-Key': adminKey() });
    check('the unreprinted order can be cancelled',
      cancelled.status === 200 && cancelled.j && cancelled.j.status === 'cancelled',
      'status=' + cancelled.status + ' body=' + JSON.stringify(cancelled.j));

    await sleep(600);
    const gone = await jget('/api/print/status', { 'X-Admin-Key': adminKey() });
    check('a cancelled order\'s failed ticket stops counting',
      !!(gone.j && gone.j.counts && gone.j.counts.failed === 0),
      'counts=' + JSON.stringify(gone.j && gone.j.counts));
    check('and the failed list is empty',
      !!(gone.j && Array.isArray(gone.j.failed) && gone.j.failed.length === 0),
      'failed=' + JSON.stringify(gone.j && gone.j.failed));
    /* The history is still there — only the *outstanding* count changed. */
    check('the history is still counted in total',
      !!(gone.j && gone.j.counts.total >= 5), 'counts=' + JSON.stringify(gone.j && gone.j.counts));

    good.kill();

    console.log('\n--- agent log (tail) ---');
    console.log(agentLog.split('\n').filter(Boolean).slice(-12).join('\n'));
  } catch (e) {
    check('probe ran to completion', false, e.message);
    console.log('\n--- server log (tail) ---');
    console.log(serverLog.split('\n').slice(-20).join('\n'));
  } finally {
    await cleanup();
    restore();
    await sleep(300);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

function adminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.local.json'), 'utf8')).adminKey || ''; }
  catch (e) { return ''; }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
