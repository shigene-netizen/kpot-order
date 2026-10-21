/* ==========================================================================
   LUCKY 66 — running-server probe (offline, scratch files, stubbed mail)
   --------------------------------------------------------------------------
   Proves the RULES are WIRED IN and that the gates hold:

     A. with the feature flag OFF (the production default) nothing opens —
        the customer cannot register, cannot verify, and the draw refuses.
     B. with the flag ON (test seam only):
        1. valid e-mail registration succeeds and a verification mail exists
        2. verification succeeds and creates exactly one entry
        3. unverified addresses never count and never win
        4. duplicate e-mail never adds an entry
        5. marketing opt-OUT never blocks entry; opt-in records consent
        6. 200 verified entries fill the round
        7. concurrent verification cannot produce entry 201
        8. the 201st verification is refused politely
        9. a round can close short of 200 and still be drawn
       10. the draw selects exactly one verified entry, idempotently
       11. repeated draw requests cannot change the result
       12. the prize cannot be issued twice
       13. admin endpoints refuse the missing/wrong key
       16. nothing in the flow touches payment (Stripe stub never called)
       17. a verification token cannot be replayed
       18. no public response carries an e-mail address
       19. unsubscribe works and suppresses marketing consent

   The mail adapter is forced to a local outbox (KPOT_GIVEAWAY_OUTBOX), so
   the suite reads the "sent" mail instead of talking to any SMTP server.

   Run:  node _dev/probe_giveaway_http.js
   ========================================================================== */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const GW = require('../assets/giveaway.js');

const ROOT = path.dirname(__dirname);
const PORT_A = 8975;          /* disabled-gate server  */
const PORT_B = 8976;          /* enabled server          */
const STRIPE_PORT = 8977;
const ADMIN = 'probe-gw-admin-' + Date.now().toString(36);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-gw-http-'));
const GIVEAWAY_FILE = path.join(SCRATCH, 'giveaway.local.json');
const OUTBOX = path.join(SCRATCH, 'outbox.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stripeCalls = 0;
const stripeStub = http.createServer((req, res) => {
  stripeCalls++;
  res.setHeader('Content-Type', 'application/json');
  res.end('{}');
});

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

function spawnServer(port, giveawayEnabled) {
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'probe-gw-print',
    DRIVER_KEY: 'probe-gw-driver',
    KPOT_FLUSH_MS: '500',
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    KPOT_GIVEAWAY_FILE: GIVEAWAY_FILE,
    KPOT_GIVEAWAY_OUTBOX: OUTBOX,
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:' + STRIPE_PORT + '/v1/checkout/sessions',
    STRIPE_SECRET_KEY: 'sk_test_gw_probe_not_real'
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
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/health');
      if (r.ok) return true;
    } catch (e) {}
    await sleep(150);
  }
  return false;
}

function req(port, method, route, body, h) {
  return fetch('http://127.0.0.1:' + port + route, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.text().then((t) => {
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, j: j };
  }));
}
const adminH = () => ({ 'X-Admin-Key': ADMIN });
const RULES = 'LUCKY66-2026-10-20';

/* Synthetic guests each arrive from their own address, the way real guests
   arrive from their own phones on the shop wifi. The per-IP ceilings exist
   for bots, so simulating 200 humans from one IP would prove nothing —
   and the X-Forwarded-For header is what the proxy sets in production. */
let guestSeq = 0;
function guestH() {
  guestSeq++;
  return { 'X-Forwarded-For': '10.9.' + Math.floor(guestSeq / 250) + '.' + ((guestSeq % 250) + 1) };
}

/* ---- outbox: the "sent" mail ------------------------------------------------ */
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
  const m = /verify=([0-9a-f]{64})/.exec(mail.text || '');
  return m ? m[1] : null;
}

/* __PROBE_PART2__ */

async function main() {
  console.log('LUCKY 66 — running server, offline');
  console.log('='.repeat(74));

  let serverA = null, serverB = null;
  const kill = () => {
    [serverA, serverB].forEach((s) => { try { if (s) s.kill('SIGKILL'); } catch (e) {} });
  };
  process.on('exit', kill);
  await new Promise((r) => stripeStub.listen(STRIPE_PORT, r));

  /* ==================================================================== */
  section('A. production default: the feature is OFF');
  serverA = spawnServer(PORT_A, false);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT_A + '/api/health'); if (r.ok) break; } catch (e) {}
    await sleep(150);
  }
  await sleep(600);
  const stOff = await req(PORT_A, 'GET', '/api/giveaway/status');
  check('status reports the giveaway as disabled',
    stOff.status === 200 && stOff.j && stOff.j.enabled === false);
  const regOff = await req(PORT_A, 'POST', '/api/giveaway/register',
    { email: 'someone@example.com', eligibilityAck: true, rulesVersion: RULES });
  check('registration is refused while disabled', regOff.status === 404 && regOff.j.reason === 'disabled');
  const verOff = await req(PORT_A, 'GET', '/api/giveaway/verify?token=' + 'a'.repeat(64));
  check('verification is refused while disabled', verOff.status === 404 && verOff.j.reason === 'disabled');
  const pageOff = await fetch('http://127.0.0.1:' + PORT_A + '/giveaway.html').then((r) => r.text());
  check('the page still loads but offers nothing while disabled',
    pageOff.indexOf('not open yet') >= 0);
  const idxOff = await fetch('http://127.0.0.1:' + PORT_A + '/').then((r) => r.text());
  check('the ordering page hides the banner while disabled',
    /id="lucky66Banner"[^>]*\shidden/.test(idxOff));
  const jsOff = await fetch('http://127.0.0.1:' + PORT_A + '/assets/app.js').then((r) => r.text());
  /* The banner reveal must be SERVER-authoritative and fail closed: the owner
     can switch the giveaway on at runtime (store.local.json) without a
     redeploy, so the browser's own copy of the static flag would be stale the
     moment the switch moved. Asserting the old string here would be asserting
     the thing that was deliberately removed. */
  check('the banner reveal asks the server (fail-closed), not the local config alone',
    jsOff.indexOf('syncLucky66Banner') >= 0 && jsOff.indexOf('/api/giveaway/status') >= 0);
  try { serverA.kill('SIGKILL'); } catch (e) {}
  serverA = null;

  /* ==================================================================== */
  section('B. enabled (test seam) — the full flow');
  serverB = spawnServer(PORT_B, true);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT_B + '/api/health'); if (r.ok) break; } catch (e) {}
    await sleep(150);
  }
  await sleep(600);

  const stOn = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('status reports the giveaway as enabled',
    stOn.status === 200 && stOn.j && stOn.j.enabled === true);
  check('no round yet', stOn.j.round && stOn.j.round.hasRound === false);

  /* ---- create + open a round (admin) ---- */
  const opensAt = new Date(Date.now() - 60 * 1000).toISOString();
  const closesAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const mk = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds',
    { opensAt: opensAt, closesAt: closesAt, maxEntries: 200, openNow: true }, adminH());
  check('an admin round is created and opened',
    mk.status === 200 && mk.j.ok && mk.j.round.status === 'OPEN' && mk.j.round.verifiedCount === 0);
  const ROUND = mk.j.round.id;

  /* Reversed dates must be refused: the owner cannot accidentally open a
     round that closed before it opened. */
  const badDates = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds',
    { opensAt: closesAt, closesAt: opensAt, openNow: true }, adminH());
  check('closing before opening is refused', badDates.status === 400 && badDates.j.reason === 'bad_dates');

  /* ---- 1: registration + verification (2) ---- */
  const reg1 = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'First.Guest@Example.com', eligibilityAck: true, rulesVersion: RULES, marketingOptIn: false
  });
  check('1/2. a valid registration succeeds', reg1.status === 200 && reg1.j.ok === true);
  let mail = newMails();
  check('a verification e-mail was produced', mail.length === 1 && mail[0].kind === 'verify');
  const token1 = tokenFrom(mail[0]);
  check('the verification link carries a 256-bit single-use token',
    !!token1 && mail[0].text.indexOf('verify=' + token1) >= 0);
  check('the verification mail mentions no purchase',
    /no purchase/i.test(mail[0].text));

  const ver1 = await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + token1);
  check('2/2. verification succeeds and returns a reference',
    ver1.status === 200 && ver1.j.ok === true && /^L66-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ver1.j.ref));
  check('the count is honest (1/200)',
    ver1.j.verifiedCount === 1 && ver1.j.maxEntries === 200);
  check('a confirmation e-mail was produced', newMails().some((m) => m.kind === 'entered' && m.text.indexOf(ver1.j.ref) >= 0));

  /* ---- 17: replay ---- */
  const replay = await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + token1);
  check('17. the same token cannot be replayed',
    replay.status === 400 && replay.j.reason === 'invalid_token');
  const forged = await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + 'b'.repeat(64));
  check('a forged token is refused', forged.status === 400 && forged.j.reason === 'invalid_token');

  /* ---- 4: duplicate e-mail ---- */
  const dup = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'first.guest@example.com', eligibilityAck: true, rulesVersion: RULES
  });
  check('4. a duplicate e-mail is refused',
    dup.status === 400 && dup.j.reason === 'already_entered');
  const stDup = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('the duplicate did not add an entry', stDup.j.round.verifiedCount === 1);

  /* ---- 3: unverified never counts ---- */
  const regPending = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'never-confirms@example.com', eligibilityAck: true, rulesVersion: RULES, marketingOptIn: false
  });
  const pendingMail = newMails().find((m) => m.kind === 'verify');
  const pendingToken = pendingMail ? tokenFrom(pendingMail) : null;
  check('3. a second registration succeeds (pending, not entered)', regPending.status === 200 && regPending.j.ok);
  const stPend = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('the unverified address takes no slot',
    stPend.j.round.verifiedCount === 1 && stPend.j.round.pendingCount === 1);

  /* ---- 5: marketing opt-out never blocks ---- */
  const mktOff = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'nomarketing@example.com', eligibilityAck: true, rulesVersion: RULES, marketingOptIn: false
  });
  const mktMail = newMails().find((m) => m.kind === 'verify');
  const mktOffVer = await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + tokenFrom(mktMail));
  check('5. an opt-OUT entrant is entered like anyone else',
    mktOff.status === 200 && mktOffVer.status === 200 && mktOffVer.j.ok === true);
  const consents = await req(PORT_B, 'GET', '/api/giveaway/admin/consents', null, adminH());
  check('the opt-OUT entrant is NOT in the marketing ledger',
    (consents.j.consents || []).every((c) => c.emailMasked !== 'n***@example.com'));

  const mktOnReg = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'yesmarketing@example.com', eligibilityAck: true, rulesVersion: RULES, marketingOptIn: true
  });
  const mktOnMail = newMails().find((m) => m.kind === 'verify');
  await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + tokenFrom(mktOnMail));
  const consents2 = await req(PORT_B, 'GET', '/api/giveaway/admin/consents', null, adminH());
  check('an opt-IN entrant IS recorded (masked) with a timestamp and notice version',
    consents2.j.consents.some((c) => c.emailMasked === 'y***@example.com' && c.marketingOptIn === true && c.at && c.noticeVersion));
  check('the consent ledger never shows a raw e-mail',
    JSON.stringify(consents2.j).indexOf('yesmarketing@example.com') === -1);

  /* ---- 19: unsubscribe + suppression ---- */
  /* The unsubscribe token is never exposed by any API (it only ever travels
     in a marketing e-mail), so the probe plants a known token exactly the
     way the shop's own consent record would hold it. */
  const stored = JSON.parse(fs.readFileSync(GIVEAWAY_FILE, 'utf8'));
  const unsubToken = 'c'.repeat(64);
  const target = Object.keys(stored.consents)[0];
  stored.consents[target].unsubTokenHash = GW.hashToken(unsubToken);
  fs.writeFileSync(GIVEAWAY_FILE + '.tmp', JSON.stringify(stored, null, 2));
  fs.renameSync(GIVEAWAY_FILE + '.tmp', GIVEAWAY_FILE);
  /* the server keeps the store in memory — restart to pick up the planted file */
  try { serverB.kill('SIGKILL'); } catch (e) {}
  serverB = spawnServer(PORT_B, true);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT_B + '/api/health'); if (r.ok) break; } catch (e) {}
    await sleep(150);
  }
  await sleep(600);
  const unsub = await req(PORT_B, 'POST', '/api/giveaway/unsubscribe', { token: unsubToken });
  check('19. an unsubscribe token suppresses marketing consent',
    unsub.status === 200 && unsub.j.ok === true);
  const unsubAgain = await req(PORT_B, 'POST', '/api/giveaway/unsubscribe', { token: unsubToken });
  check('a reused unsubscribe token is idempotent, not re-applied', unsubAgain.status === 200 && unsubAgain.j.already === true);
  const bogusUnsub = await req(PORT_B, 'POST', '/api/giveaway/unsubscribe', { token: 'd'.repeat(64) });
  check('an unknown unsubscribe token is refused', bogusUnsub.status === 400 && bogusUnsub.j.reason === 'invalid_token');
  check('the suppression is visible in the ledger',
    (await req(PORT_B, 'GET', '/api/giveaway/admin/consents', null, adminH())).j.consents
      .some((c) => c.unsubscribedAt));

  /* ---- 6 + 7 + 8: fill the round to exactly 200, concurrently ---- */
  /* 96 registered so far (1+1 pending + 2 + …): recount from the server. */
  const beforeFill = await req(PORT_B, 'GET', '/api/giveaway/status');
  const already = beforeFill.j.round.verifiedCount;
  const need = 200 - already;
  check('6. the round needs exactly ' + need + ' more verified entries to fill', need > 0 && need < 200);

  /* Register the remainder, then verify them ALL AT ONCE. This is the
     concurrency case that matters: N simultaneous verifications against
     fewer than N remaining slots must produce exactly N remaining slots'
     worth of entries — never one over. */
  const tokens = [];
  for (let i = 0; i < need - 5; i++) {           /* leave 5 slots short */
    const r = await req(PORT_B, 'POST', '/api/giveaway/register', {
      email: 'bulk' + i + '@example.com', eligibilityAck: true, rulesVersion: RULES
    }, guestH());
    if (r.status !== 200) { check('bulk registration ' + i + ' succeeded', false, JSON.stringify(r.j)); break; }
    const m = newMails().find((x) => x.kind === 'verify');
    if (!m) { check('bulk mail ' + i, false); break; }
    tokens.push(tokenFrom(m));
  }
  /* Verify the whole batch in ONE concurrent burst. This is the real
     concurrency stress: N verifications racing for N slots must produce
     exactly N entries — never one over. */
  const bulkResults = await Promise.all(tokens.map((t) =>
    req(PORT_B, 'GET', '/api/giveaway/verify?token=' + t, null, guestH())));
  const bulkOk = bulkResults.filter((r) => r.status === 200).length;
  const midFill = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('the bulk burst verified ' + bulkOk + ' of ' + tokens.length + ' and left the round 5 short',
    bulkOk === tokens.length && midFill.j.round.verifiedCount === 95,
    'bulkOk=' + bulkOk + '/' + tokens.length + ', verifiedCount=' + midFill.j.round.verifiedCount);

  /* ---- 7: SIX verifications racing for FIVE slots -----------------------
     Register 6 more, then verify all 6 at the same instant. Exactly 5 may
     win; the 6th must be refused politely and must NOT create an entry.
     This is the test that proves the 201st entry cannot happen. */
  const raceTokens = [];
  for (let i = 0; i < 6; i++) {
    const r = await req(PORT_B, 'POST', '/api/giveaway/register', {
      email: 'race' + i + '@example.com', eligibilityAck: true, rulesVersion: RULES
    }, guestH());
    if (r.status !== 200) { check('race registration ' + i + ' succeeded', false, JSON.stringify(r.j)); break; }
    const m = newMails().find((x) => x.kind === 'verify');
    if (m) raceTokens.push(tokenFrom(m));
  }
  const results = await Promise.all(raceTokens.map((t) =>
    req(PORT_B, 'GET', '/api/giveaway/verify?token=' + t, null, guestH())));
  const winners = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status === 409);
  const afterRace = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('7. six concurrent verifications for five slots yield exactly five entries',
    winners.length === 5 && refused.length === 1 && afterRace.j.round.verifiedCount === 200,
    'winners=' + winners.length + ', refused=' + refused.length +
      ', verifiedCount=' + afterRace.j.round.verifiedCount);
  check('the losing verification was refused politely (no entry created)',
    refused.length === 1 && /Thank you/.test(refused[0].j.message));

  /* Fill whatever remains, one at a time, then try the 201st. */
  const stNow = await req(PORT_B, 'GET', '/api/giveaway/status');
  let guard = 0;
  while (stNow.j.round.verifiedCount < 200 && guard++ < 50) {
    await req(PORT_B, 'POST', '/api/giveaway/register', {
      email: 'topup' + guard + '@example.com', eligibilityAck: true, rulesVersion: RULES
    });
    const m = newMails().find((x) => x.kind === 'verify');
    if (m) await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + tokenFrom(m));
    const s = await req(PORT_B, 'GET', '/api/giveaway/status');
    stNow.j.round.verifiedCount = s.j.round.verifiedCount;
  }
  const full = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('6/8. the round holds exactly 200 verified entries', full.j.round.verifiedCount === 200);
  check('and the page would say FULL', full.j.round.reason === 'full' && full.j.round.acceptsEntries === false);

  /* 8: the 201st participant. Registration checks capacity too, so a full
     round refuses at the form — politely, and without sending a verification
     link that could only fail. The race above already proved the same refusal
     at the verification gate. */
  const reg201 = await req(PORT_B, 'POST', '/api/giveaway/register', {
    email: 'one-hundred-first@example.com', eligibilityAck: true, rulesVersion: RULES
  }, guestH());
  check('8. the 201st registration is refused politely when the round is full',
    reg101.status === 409 && reg101.j.reason === 'full' && /Thank you/.test(reg101.j.message),
    JSON.stringify(reg101.j));
  const pendingBefore201 = (await req(PORT_B, 'GET', '/api/giveaway/status')).j.round.pendingCount;
  const after201 = await req(PORT_B, 'GET', '/api/giveaway/status');
  check('the refusal did not create an entry', after101.j.round.verifiedCount === 200);
  /* The round already holds pending records from earlier steps, so an absolute
     zero would be the wrong assertion. What must be true is that the refused
     address added NOTHING: no new pending row, and no new verification mail. */
  const mailFor201 = newMails().some((m) =>
    m.kind === 'verify' && m.to === 'one-hundred-first@example.com');
  check('and no verification link was queued for it',
    after101.j.round.pendingCount === pendingBefore201 && mailFor201 === false,
    'pending ' + pendingBefore201 + ' -> ' + after101.j.round.pendingCount + ', mail=' + mailFor201);

  /* ---- 10/11/12: close, draw, prize, redeem ---- */
  const close = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/transition',
    { to: 'CLOSED', note: 'cap reached — probe' }, adminH());
  check('the round closes on transition', close.status === 200 && close.j.round.status === 'CLOSED');

  const draw = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/draw', {}, adminH());
  check('10. the draw selects exactly one winner',
    draw.status === 200 && draw.j.ok === true && /^L66-/.test(draw.j.draw.winnerRef) &&
    draw.j.draw.entriesCount === 200);
  const winnerMail = newMails().find((m) => m.kind === 'winner');
  check('the winner is notified by e-mail',
    !!winnerMail && winnerMail.text.indexOf(draw.j.draw.winnerRef) >= 0);
  check('3. the unverified address was never eligible and was not notified',
    !winnerMail || winnerMail.to !== 'never-confirms@example.com');

  const draw2 = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/draw', {}, adminH());
  check('11. a repeated draw cannot change the result',
    draw2.status === 409 && draw2.j.reason === 'already_drawn' &&
    draw2.j.draw.winnerRef === draw.j.draw.winnerRef);
  const drawMails = newMails().filter((m) => m.kind === 'winner');
  check('no second winner notification was sent', drawMails.length === 0);

  const issue = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/prize',
    { code: 'GW-1234-5678-ABCD', note: 'probe card' }, adminH());
  check('12. the prize is issued once', issue.status === 200 && issue.j.round.prizeIssued === true);
  const issue2 = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/prize',
    { code: 'GW-9999-9999-9999', note: 'probe card' }, adminH());
  check('12. a second issuance is refused',
    issue2.status === 409 && issue2.j.reason === 'already_issued');
  const prizeMail = newMails().filter((m) => m.kind === 'winner');
  check('the prize code was e-mailed to the winner exactly once',
    prizeMail.length === 1 && prizeMail[0].text.indexOf('GW-1234-5678-ABCD') >= 0);

  const redeem = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/redeem',
    { balanceAfter: 20.5, note: 'spent at counter' }, adminH());
  check('the redemption is recorded and completes the round',
    redeem.status === 200 && redeem.j.round.status === 'COMPLETED' &&
    redeem.j.round.redeemedAt !== null);

  /* ---- 9: a round that closes short of 200 still draws ---- */
  const opens2 = new Date(Date.now() - 3600 * 1000).toISOString();
  const closes2 = new Date(Date.now() + 3600 * 1000).toISOString();
  const mk2 = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds',
    { opensAt: opens2, closesAt: closes2, maxEntries: 200, openNow: true }, adminH());
  const ROUND2 = mk2.j.round.id;
  for (const e of ['short1@example.com', 'short2@example.com', 'short3@example.com']) {
    await req(PORT_B, 'POST', '/api/giveaway/register', { email: e, eligibilityAck: true, rulesVersion: RULES });
    const m = newMails().find((x) => x.kind === 'verify');
    if (m) await req(PORT_B, 'GET', '/api/giveaway/verify?token=' + tokenFrom(m));
  }
  await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND2 + '/transition', { to: 'CLOSED' }, adminH());
  const draw3 = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND2 + '/draw', {}, adminH());
  check('9. a round with 3 of 200 entries still draws one winner at its deadline',
    draw3.status === 200 && draw3.j.draw.entriesCount === 3);
  const shortWinnerMail = newMails().find((m) => m.kind === 'winner');
  check('the short-round winner is one of its three verified entrants',
    !!shortWinnerMail && ['short1@example.com', 'short2@example.com', 'short3@example.com']
      .indexOf(shortWinnerMail.to) >= 0,
    shortWinnerMail ? shortWinnerMail.to : 'no mail');

  /* ---- 13: unauthorized admin ---- */
  const noKey = await req(PORT_B, 'GET', '/api/giveaway/admin/rounds');
  check('13. admin data without a key is 401', noKey.status === 401);
  const badKey = await req(PORT_B, 'GET', '/api/giveaway/admin/rounds', null, { 'X-Admin-Key': 'wrong' });
  check('a wrong key is 401', badKey.status === 401);
  const drawNoKey = await req(PORT_B, 'POST', '/api/giveaway/admin/rounds/' + ROUND + '/draw', {});
  check('the draw cannot be triggered without a key', drawNoKey.status === 401);
  const exportNoKey = await fetch('http://127.0.0.1:' + PORT_B +
    '/api/giveaway/admin/rounds/' + ROUND + '/export?format=json').then((r) => r.status);
  check('the export cannot be fetched without a key', exportNoKey === 401);

  /* ---- 18: no PII in public responses ---- */
  const pubJson = JSON.stringify(await req(PORT_B, 'GET', '/api/giveaway/status'));
  check('18. the public status carries no e-mail, hash or reference',
    pubJson.indexOf('@example.com') === -1 && pubJson.indexOf('@') === -1 &&
    pubJson.indexOf('L66-') === -1);
  const expJson = await req(PORT_B, 'GET',
    '/api/giveaway/admin/rounds/' + ROUND + '/export?format=json', null, adminH());
  const expText = JSON.stringify(expJson.j);
  /* Masking KEEPS the domain on purpose (the owner needs to see where entries
     came from) and hides the local part — so "@example.com" appearing is
     correct. What must never appear is a complete raw address. */
  const rawAddrs = ['first.guest@example.com', 'topup1@example.com', 'race0@example.com'];
  check('even the admin export is masked (no raw address, masked shape everywhere)',
    expJson.status === 200 &&
    rawAddrs.every((a) => expText.indexOf(a) === -1) &&
    expJson.j.entries.length === 200 &&
    expJson.j.entries.every((e) => /^.\*\*\*@[^@]*$/.test(e.emailMasked)),
    'rawFound=' + rawAddrs.filter((a) => expText.indexOf(a) >= 0).join(',') +
      ', entries=' + (expJson.j.entries ? expJson.j.entries.length : 'n/a'));
  const expCsv = await fetch('http://127.0.0.1:' + PORT_B +
    '/api/giveaway/admin/rounds/' + ROUND + '/export?format=csv', { headers: { 'X-Admin-Key': ADMIN } })
    .then((r) => r.text());
  const csvLines = expCsv.split('\n');
  check('the CSV export is masked too (header + masked rows, no raw address)',
    csvLines[0] === 'ref,email_masked,verified_at,notice_version,marketing_opt_in' &&
    csvLines.length === 201 &&
    rawAddrs.every((a) => expCsv.indexOf(a) === -1) &&
    csvLines.slice(1).every((l) => /^.\*\*\*@[^@]*$/.test((l.split(',')[1] || ''))),
    csvLines.slice(0, 2).join(' | '));

  /* ---- 16: no payment anywhere in the flow ---- */
  check('16. the Stripe stub was never called — nothing in the flow moves money',
    stripeCalls === 0, 'stripeCalls=' + stripeCalls);
  const checkoutClean = await req(PORT_B, 'POST', '/api/checkout', { lines: [] }).catch(() => ({ status: 0 }));
  check('the giveaway never touched the checkout endpoint',
    checkoutClean.status !== 200 || stripeCalls === 0);

  /* ---- the store file on disk holds the addresses, 0600 ---- */
  try {
    fs.statSync(GIVEAWAY_FILE);
    /* POSIX permission bits are only meaningful on non-Windows platforms.
       On Windows the store is still written atomically and kept out of the
       shop's other data files; the 0600 guarantee is a Linux-deploy property,
       so it is asserted there and recorded (not failed) here. */
    if (process.platform === 'win32') {
      check('the giveaway store file exists (0600 is enforced on the Linux deploy, not Windows)',
        true, '(platform=win32)');
    } else {
      const mode = (fs.statSync(GIVEAWAY_FILE).mode & 0o777).toString(8);
      check('the giveaway store file is 0600', mode === '600', mode);
    }
  } catch (e) { check('the giveaway store file exists', false, e.message); }
  const rawStore = fs.readFileSync(GIVEAWAY_FILE, 'utf8');
  check('tokens are stored only as hashes',
    rawStore.indexOf(token1) === -1 && rawStore.indexOf('token-for') === -1);
  check('the store keeps the winner and audit trail',
    rawStore.indexOf('drawn') >= 0 && rawStore.indexOf('audit') >= 0);

  /* __P6__ */
}

main().then(() => {
  try { stripeStub.close(); } catch (e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILURES: ' + fail); process.exit(1); }
  console.log('PASS — LUCKY 66 server probe (' + pass + ' checks)');
  process.exit(0);
}).catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
