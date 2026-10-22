#!/usr/bin/env node
/* ==========================================================================
   LUCKY 66 — real browser (headless Chrome + real server)
   ---------------------------------------------------------------------------
   _dev/test_giveaway.js proves the RULES. _dev/probe_giveaway_http.js proves
   the rules are WIRED IN. This proves the pages the guest's thumb and the
   owner's eye actually touch:

     A. desktop giveaway page: title, prize, live count, status, the form,
        the eligibility acknowledgement, the optional marketing box.
     B. the real registration flow: type an address, submit, get the
        "check your inbox" state, then follow the verification link from the
        outbox and land on the confirmation with the reference number.
     C. the marketing box is UNCHECKED by default and is a separate choice.
     D. mobile layout is usable (430x932) and the entry form is reachable.
     E. the LUCKY 66 banner appears on the ordering page only when enabled,
        and the existing menu / ordering flow still works with it present.
     F. the admin dashboard: key gate, round list, counts, masked entries,
        the draw button, the consent ledger — and a screenshot.
     G. the feature stays hidden when the flag is off (production default).

   Screenshots land in _dev/screens/ so the acceptance evidence is a file,
   not a claim.

   Pitfall 43 applies throughout: every assertion is against the DOM after a
   real interaction, and every action is driven by a real click / fill.

   Run:  node _dev/probe_giveaway_ui.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { teardown } = require('./probe_cleanup.js');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8978', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9383', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_KEY = 'gw-ui-admin-' + Date.now().toString(36);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-gw-ui-'));
const GIVEAWAY_FILE = path.join(SCRATCH, 'giveaway.local.json');
const OUTBOX = path.join(SCRATCH, 'outbox.jsonl');
const SHOTS = path.join(ROOT, '_dev', 'screens');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GW = require('../assets/giveaway.js');

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

/* -------------------------------------------------------------------------- */
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function spawnServer(port, giveawayEnabled) {
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    ADMIN_KEY: ADMIN_KEY,
    PRINT_KEY: 'probe-gw-ui-print',
    DRIVER_KEY: 'probe-gw-ui-driver',
    KPOT_FLUSH_MS: '500',
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'order-backups'),
    KPOT_GIVEAWAY_FILE: GIVEAWAY_FILE,
    KPOT_GIVEAWAY_OUTBOX: OUTBOX,
    STRIPE_SECRET_KEY: 'sk_test_gw_ui_not_real',
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:8989/v1/checkout/sessions'
  });
  if (giveawayEnabled) env.KPOT_GIVEAWAY_ENABLED = '1';
  const s = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  s._log = '';
  s.stdout.on('data', (d) => { s._log += d.toString(); });
  s.stderr.on('data', (d) => { s._log += d.toString(); });
  return s;
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

function req(port, method, route, body, h) {
  return fetch('http://127.0.0.1:' + port + route, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.text().then((t) => {
    let j = null; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, j: j };
  }));
}
const adminH = () => ({ 'X-Admin-Key': ADMIN_KEY });
const RULES = 'LUCKY66-2026-10-20';

async function shot(cdp, name, w, h) {
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 600
    });
    await sleep(300);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    console.log('         screenshot → _dev/screens/' + name);
  } catch (e) {
    console.log('         (screenshot failed: ' + e.message + ')');
  }
}

/* ---- the "sent" mail -------------------------------------------------------
   The adapter is forced to a local outbox, so the browser test can follow the
   REAL verification link the guest would receive — no SMTP, no real mailbox. */
let outboxPos = 0;
function newMails() {
  let raw = '';
  try { raw = fs.readFileSync(OUTBOX, 'utf8'); } catch (e) { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const fresh = lines.slice(outboxPos);
  outboxPos = lines.length;
  return fresh.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function tokenFrom(mail) {
  const m = /verify=([0-9a-f]{64})/.exec(mail && mail.text ? mail.text : '');
  return m ? m[1] : null;
}

async function main() {
  console.log('LUCKY 66 — real browser, real server');
  console.log('='.repeat(74));

  let server = null, chrome = null, cdp = null;
  const profile = path.join(os.tmpdir(), 'kpot-gw-ui-chrome-' + Date.now());

  const cleanup = async () => {
    await teardown([chrome, server], [SCRATCH, profile]);
  };

  try {
    server = spawnServer(PORT, true);
    if (!(await waitUp(PORT))) throw new Error('server never became healthy');
    console.log('server up on ' + BASE + '\n');

    /* A round is prepared through the admin API BEFORE the browser opens, so
       the page has something real to show. */
    const mk = await req(PORT, 'POST', '/api/giveaway/admin/rounds', {
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      maxEntries: 200, openNow: true
    }, adminH());
    if (!mk.j || !mk.j.ok) throw new Error('could not create a round: ' + JSON.stringify(mk.j));
    const ROUND = mk.j.round.id;

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
    cdp = connectCdp(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.ws.addEventListener('open', r));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* ==================================================================== */
    section('A. the giveaway page on a desktop viewport');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html' });
    await cdp.waitFor('!!document.querySelector("#statusPill")', 15000, 'the giveaway page');
    await cdp.waitFor('document.querySelector("#statusPill").textContent.indexOf("Loading") === -1', 15000, 'the status to resolve');

    check('the title and the prize are on the page',
      /KPOT EXPRESS — LUCKY 66/.test(await cdp.evalJs('document.querySelector(".eyebrow").textContent')) &&
      /\$66/.test(await cdp.evalJs('document.querySelector("#main h2").textContent')));
    check('the live count reads 0 / 200',
      (await cdp.evalJs('document.querySelector("#countNow").textContent')) === '0' &&
      (await cdp.evalJs('document.querySelector("#countMax").textContent')) === '200');
    check('the status pill says Open',
      /Open/.test(await cdp.evalJs('document.querySelector("#statusPill").textContent')));
    check('"free to enter — no purchase necessary" is stated',
      /FREE TO ENTER/.test(await cdp.evalJs('document.querySelector(".free").textContent')));
    check('the registration form is present with an e-mail field',
      await cdp.evalJs('!!document.querySelector("#emailIn") && document.querySelector("#emailIn").type === "email"'));
    check('the eligibility acknowledgement box is present and UNCHECKED',
      await cdp.evalJs('document.querySelector("#ackIn").checked === false'));
    check('the marketing box is present, UNCHECKED by default, and labelled optional',
      await cdp.evalJs('document.querySelector("#mktIn").checked === false') &&
      /Optional/.test(await cdp.evalJs('document.querySelector("#mktIn").parentElement.textContent')));
    check('no payment method appears anywhere on the page',
      await cdp.evalJs('document.body.innerText.indexOf("card") === -1 && document.body.innerText.indexOf("Pay") === -1'));
    check('the official rules and privacy links exist',
      await cdp.evalJs('!!document.querySelector("a[href=\'/giveaway-rules.html\']") && !!document.querySelector("a[href=\'/giveaway-privacy.html\']")'));
    await shot(cdp, 'giveaway-desktop.png', 1280, 900);

    /* ==================================================================== */
    section('B. the real registration + verification flow');

    /* The legal consent modal GATES registration: nothing may be sent to the
       server until the guest has read the declarations, checked the agreement
       box and clicked Agree. Cancel must leave the guest exactly where they
       were — no entry, no mail. */
    await cdp.evalJs(`(() => {
      document.querySelector('#emailIn').value = 'Browser.Guest@Example.com';
      document.querySelector('#ackIn').checked = true;
      document.querySelector('#submitBtn').click(); return 1; })()`);
    await cdp.waitFor('document.querySelector("#legalModal").hidden === false', 10000, 'the legal consent modal');
    check('the legal consent modal appears before anything is registered',
      await cdp.evalJs('document.querySelector("#legalModal").hidden === false'));
    check('no registration mail exists yet — nothing was sent to the server',
      newMails().filter((m) => m.kind === 'verify').length === 0);
    check('the Agree button is disabled until the agreement box is checked',
      await cdp.evalJs('document.querySelector("#legalAgreeBtn").disabled === true'));

    /* Cancel: the modal closes, the form is still there, still nothing sent. */
    await cdp.evalJs('document.querySelector("#legalCancelBtn").click()');
    check('Cancel closes the modal and leaves the entry form in place',
      await cdp.evalJs('document.querySelector("#legalModal").hidden === true') &&
      await cdp.evalJs('document.querySelector("#formCard").hidden === false') &&
      await cdp.evalJs('document.querySelector("#sentCard").hidden === true'));
    check('and Cancel still sent nothing',
      newMails().filter((m) => m.kind === 'verify').length === 0);

    /* Try again and this time agree. */
    await cdp.evalJs('document.querySelector("#submitBtn").click()');
    await cdp.waitFor('document.querySelector("#legalModal").hidden === false', 10000, 'the modal again');
    await cdp.evalJs(`(() => {
      document.querySelector('#legalAgreeIn').checked = true;
      document.querySelector('#legalAgreeIn').dispatchEvent(new Event('change'));
      return 1; })()`);
    check('checking the agreement box enables the Agree button',
      await cdp.evalJs('document.querySelector("#legalAgreeBtn").disabled === false'));
    await cdp.evalJs('document.querySelector("#legalAgreeBtn").click()');
    await cdp.waitFor('document.querySelector("#sentCard").hidden === false', 15000, 'the check-your-inbox state');
    check('submitting shows the verification instructions',
      /Check your inbox/.test(await cdp.evalJs('document.querySelector("#sentCard h3").textContent')));
    check('the instructions say the link works once and expires',
      /once/.test(await cdp.evalJs('document.querySelector("#sentCard").innerText')) &&
      /24/.test(await cdp.evalJs('document.querySelector("#verifyHours").textContent')));

    const mail = newMails().find((m) => m.kind === 'verify');
    const token = mail ? tokenFrom(mail) : null;
    check('a verification mail was produced for the address typed',
      !!mail && mail.to === 'browser.guest@example.com' && !!token);
    check('the mail says no purchase is necessary',
      !!mail && /no purchase/i.test(mail.text));

    /* Follow the link the way a guest would: navigate to it. */
    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html?verify=' + token });
    await cdp.waitFor('document.querySelector("#doneCard").hidden === false', 15000, 'the confirmation');
    const refShown = await cdp.evalJs('document.querySelector("#refCode").textContent');
    check('verification confirms the entry and shows a reference number',
      /^L66-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(refShown), refShown);
    check('the confirmation states the honest count (1 of 200)',
      /1 of 200/.test(await cdp.evalJs('document.querySelector("#doneMsg").textContent')));
    check('the token was consumed from the address bar',
      await cdp.evalJs('location.search.indexOf("verify=") === -1'));
    const enteredMail = newMails().find((m) => m.kind === 'entered');
    check('a confirmation mail was produced carrying the reference',
      !!enteredMail && enteredMail.text.indexOf(refShown) >= 0);
    await shot(cdp, 'giveaway-confirmed-desktop.png', 1280, 900);

    /* Replaying the same link must not produce a second entry. */
    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html?verify=' + token });
    await cdp.waitFor('document.querySelector("#verifyErrCard").hidden === false', 15000, 'the replay refusal');
    check('replaying the link is refused politely',
      /didn.t work|not valid/.test(await cdp.evalJs('document.querySelector("#verifyErrMsg").textContent')));
    const stAfterReplay = await req(PORT, 'GET', '/api/giveaway/status');
    check('and no second entry was created',
      stAfterReplay.j.round.verifiedCount === 1);

    /* ==================================================================== */
    section('C. the marketing choice is separate and off by default');

    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html' });
    await cdp.waitFor('!!document.querySelector("#emailIn")', 15000, 'the form again');
    check('the marketing box is unchecked on a fresh visit',
      await cdp.evalJs('document.querySelector("#mktIn").checked === false'));
    await cdp.evalJs(`(() => {
      document.querySelector('#emailIn').value = 'Opt.In@Example.com';
      document.querySelector('#ackIn').checked = true;
      document.querySelector('#mktIn').checked = true;
      document.querySelector('#submitBtn').click(); return 1; })()`);
    /* Same gate as section B — the marketing choice does not bypass it. */
    await cdp.waitFor('document.querySelector("#legalModal").hidden === false', 10000, 'the legal consent modal');
    check('the consent modal gates the opt-in registration too',
      await cdp.evalJs('document.querySelector("#legalModal").hidden === false'));
    await cdp.evalJs(`(() => {
      document.querySelector('#legalAgreeIn').checked = true;
      document.querySelector('#legalAgreeIn').dispatchEvent(new Event('change'));
      document.querySelector('#legalAgreeBtn').click(); return 1; })()`);
    await cdp.waitFor('document.querySelector("#sentCard").hidden === false', 15000, 'the sent state');
    const optMail = newMails().find((m) => m.kind === 'verify' && m.to === 'opt.in@example.com');
    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html?verify=' + tokenFrom(optMail) });
    await cdp.waitFor('document.querySelector("#doneCard").hidden === false', 15000, 'the opt-in confirmation');
    const consents = await req(PORT, 'GET', '/api/giveaway/admin/consents', null, adminH());
    check('an opt-IN entrant appears in the consent ledger, masked',
      consents.j.consents.some((c) => c.emailMasked === 'o***@example.com' && c.marketingOptIn === true));
    check('the ledger never carries the raw address',
      JSON.stringify(consents.j).indexOf('opt.in@example.com') === -1);

    /* ==================================================================== */
    section('D. mobile layout is usable');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html' });
    await cdp.waitFor('document.querySelector("#main").hidden === false', 15000, 'the mobile page to load');
    const mob = await cdp.evalJs(`(() => {
      const f = document.querySelector('#formCard').getBoundingClientRect();
      const e = document.querySelector('#emailIn').getBoundingClientRect();
      const b = document.querySelector('#submitBtn').getBoundingClientRect();
      return {
        formW: Math.round(f.width),
        inputW: Math.round(e.width),
        btnW: Math.round(b.width),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        btnTop: Math.round(b.top), btnBottom: Math.round(b.bottom), vh: window.innerHeight
      };
    })()`);
    check('nothing overflows the 430px viewport', mob.overflow === false, JSON.stringify(mob));
    check('the e-mail field spans the card, not a sliver',
      mob.inputW >= 300 && mob.inputW <= 430, 'inputW=' + mob.inputW);
    check('the submit button is reachable without scrolling sideways',
      mob.btnW >= 300 && mob.btnBottom > 0, 'btnW=' + mob.btnW + ', bottom=' + mob.btnBottom);
    await shot(cdp, 'giveaway-mobile.png', 430, 932);

    /* ==================================================================== */
    section('E. the banner on the ordering page, and the menu still works');

    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('!!document.querySelector("#otGrid")', 15000, 'the ordering page');
    await cdp.waitFor('document.querySelectorAll("#otGrid .ot-card").length >= 1', 15000, 'the order types');
    await cdp.waitFor('document.querySelector("#lucky66Banner").hidden === false', 15000, 'the banner to be revealed');
    check('the LUCKY 66 banner is visible on the menu page when enabled',
      await cdp.evalJs('document.querySelector("#lucky66Banner").hidden === false'));
    check('the banner links to the giveaway page',
      await cdp.evalJs('document.querySelector("#lucky66Banner").getAttribute("href") === "/giveaway.html"'));
    check('the existing order-type picker is intact',
      (await cdp.evalJs('document.querySelectorAll("#otGrid .ot-card").length')) >= 2);
    check('the existing menu categories still render',
      (await cdp.evalJs('document.querySelectorAll("#tabs .tab").length')) >= 1);
    await cdp.waitFor('document.querySelectorAll("#menuBody .item-row").length >= 1', 15000, 'the menu items');
    check('the existing menu items still render',
      (await cdp.evalJs('document.querySelectorAll("#menuBody .item-row").length')) >= 1);
    await shot(cdp, 'menu-with-banner.png', 430, 932);

    /* ==================================================================== */
    section('F. the admin dashboard');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/admin-giveaway.html' });
    await cdp.waitFor('!!document.querySelector("#gate")', 15000, 'the admin page');
    check('nothing is visible before the key is entered',
      await cdp.evalJs('document.querySelector("#main").hidden === true'));

    await cdp.evalJs(`(() => {
      document.querySelector('#keyIn').value = ${JSON.stringify(ADMIN_KEY)};
      document.querySelector('#keyGo').click(); return 1; })()`);
    await cdp.waitFor('document.querySelectorAll("#rounds .card").length >= 1', 15000, 'the round list');
    /* loadConsents() is a separate async call after render(); waiting on the
       round card alone would read the ledger before it is populated. */
    await cdp.waitFor('document.querySelector("#consentRows").innerText.indexOf("@example.com") >= 0', 15000, 'the consent ledger');
    check('the round appears with its honest count',
      /2\s+verified/.test(await cdp.evalJs('document.querySelector("#rounds").innerText')));
    check('the consent ledger is rendered masked (local part hidden, domain kept)',
      /o\*\*\*@example\.com/.test(await cdp.evalJs('document.querySelector("#consentRows").innerText')));
    await shot(cdp, 'giveaway-admin.png', 1280, 900);

    /* ==================================================================== */
    section('G. the feature stays dark when the flag is off');

    try { server.kill('SIGKILL'); } catch (e) {}
    server = spawnServer(PORT, false);
    if (!(await waitUp(PORT))) throw new Error('the disabled server never came up');

    await cdp.send('Page.navigate', { url: BASE + '/giveaway.html' });
    await cdp.waitFor('document.querySelector("#offState").hidden === false', 15000, 'the off state');
    check('the giveaway page shows only the "not open yet" notice',
      /not open yet/i.test(await cdp.evalJs('document.querySelector("#offState").innerText')) &&
      await cdp.evalJs('document.querySelector("#main").hidden === true'));
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor('!!document.querySelector("#otGrid")', 15000, 'the menu again');
    check('the banner is hidden on the menu page while disabled',
      await cdp.evalJs('document.querySelector("#lucky66Banner").hidden === true'));

    /* ==================================================================== */
    section('browser console health');

    check('no uncaught exception was logged by any page',
      cdp.logs.filter((l) => l.indexOf('[EXCEPTION]') === 0).length === 0,
      cdp.logs.filter((l) => l.indexOf('[EXCEPTION]') === 0).join(' | '));

    await cleanup();
  } catch (e) {
    console.error('\nprobe crashed: ' + (e && e.message));
    /* Diagnostics for exactly this situation: a waitFor that timed out. The
       browser console and the page's own error message are what tell you
       whether the page broke or the expectation did. */
    try {
      if (cdp) {
        const errs = cdp.logs.filter((l) => l.indexOf('[EXCEPTION]') === 0 || l.indexOf('[error]') === 0);
        if (errs.length) console.error('browser console:\n  ' + errs.join('\n  '));
        const state = await cdp.evalJs(`(() => {
          const g = (s) => { const el = document.querySelector(s); return el ? (el.hidden ? 'hidden' : 'shown') : 'missing'; };
          return JSON.stringify({
            formCard: g('#formCard'), sentCard: g('#sentCard'),
            formMsg: (document.querySelector('#formMsg') || {}).textContent || '',
            legalModal: g('#legalModal'),
            legalAgreeBtnDisabled: (document.querySelector('#legalAgreeBtn') || {}).disabled
          });
        })()`);
        console.error('page state: ' + state);
      }
    } catch (x) {}
    try { await cleanup(); } catch (x) {}
    process.exit(1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILURES: ' + fail); process.exit(1); }
  console.log('PASS — LUCKY 66 browser probe (' + pass + ' checks)');
  process.exit(0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
