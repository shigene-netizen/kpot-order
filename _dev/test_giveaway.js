/* ==========================================================================
   LUCKY 66 — pure rules suite (no server, no network)
   --------------------------------------------------------------------------
   Proves the RULES in assets/giveaway.js are right:
     · state machine, capacity judged at VERIFICATION time
     · unverified addresses never take a slot
     · one entry per e-mail; duplicates never add an entry
     · marketing opt-out never blocks entry
     · 200 verified fills a round; the 201st is refused politely
     · a round closes at its deadline with fewer than 200
     · the draw yields exactly one winner from the verified pool only
     · a repeated draw cannot change the result
     · a prize cannot be issued twice
     · verification tokens cannot be replayed
     · no e-mail address appears in any public view

   Run:  node _dev/test_giveaway.js
   ========================================================================== */

'use strict';

const GW = require('../assets/giveaway.js');

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

const CFG = GW.sanitizeGiveawayConfig({
  enabled: true, maxEntries: 200, prizeValue: 66, rulesVersion: 'LUCKY66-TEST'
});
const NOW = Date.parse('2026-10-25T12:00:00.000Z');

function round(over) {
  return Object.assign({
    id: 'L66-TEST-001',
    status: GW.STATUS.OPEN,
    prize: { value: 66, currency: 'USD', desc: 'KPOT EXPRESS $66 Store-Credit Code' },
    maxEntries: 200,
    opensAt: '2026-10-18T00:00:00.000Z',
    closesAt: '2026-11-15T00:00:00.000Z',
    entries: [], pending: [],
    draw: null, prizeIssue: null, audit: []
  }, over || {});
}
function entry(r, email, at) {
  r.entries.push({
    id: 'E' + r.entries.length, ref: 'L66-AAAA-' + String(1000 + r.entries.length).slice(-4),
    emailHash: GW.sha256Hex(email), emailMasked: GW.maskEmail(email),
    verifiedAt: at || new Date(NOW).toISOString(), noticeVersion: '1', source: 'test',
    marketingOptIn: false, ipHash: ''
  });
}
function pendingOf(r, email, hoursAgo) {
  const p = {
    id: 'P' + r.pending.length, emailHash: GW.sha256Hex(email),
    tokenHash: GW.hashToken('token-for-' + email),
    sentAt: new Date(NOW - (hoursAgo || 0) * 3600000).toISOString(),
    expiresAt: new Date(NOW - (hoursAgo || 0) * 3600000 + 24 * 3600000).toISOString(),
    marketingOptIn: false, noticeVersion: '1', source: 'test', ipHash: ''
  };
  r.pending.push(p);
  return p;
}

/* ============================================================ */
section('state machine');

check('DRAFT can open', GW.canTransition('DRAFT', 'OPEN'));
check('OPEN can close, pause, cancel',
  GW.canTransition('OPEN', 'CLOSED') && GW.canTransition('OPEN', 'PAUSED') && GW.canTransition('OPEN', 'CANCELLED'));
check('PAUSED can reopen or close', GW.canTransition('PAUSED', 'OPEN') && GW.canTransition('PAUSED', 'CLOSED'));
check('CLOSED can be drawn', GW.canTransition('CLOSED', 'DRAWN'));
check('DRAWN -> PRIZE ISSUED -> COMPLETED',
  GW.canTransition('DRAWN', 'PRIZE_ISSUED') && GW.canTransition('PRIZE_ISSUED', 'COMPLETED'));
check('no skip: OPEN cannot jump to DRAWN', !GW.canTransition('OPEN', 'DRAWN'));
check('no skip: CLOSED cannot jump to PRIZE ISSUED', !GW.canTransition('CLOSED', 'PRIZE_ISSUED'));
check('terminal states stay terminal',
  GW.nextStatuses('COMPLETED').length === 0 && GW.nextStatuses('CANCELLED').length === 0);
check('statuses have human labels', GW.statusLabel('PRIZE_ISSUED') === 'Prize issued');

/* ============================================================ */
section('e-mail rules');

check('a real address validates', GW.isValidEmail('guest@kpotexpress.com'));
check('uppercase + spaces normalise', GW.normalizeEmail('  Guest@KPOT.com ') === 'guest@kpot.com');
check('no @ is refused', !GW.isValidEmail('guest.example.com'));
check('no dot in domain is refused', !GW.isValidEmail('guest@localhost'));
check('spaces are refused', !GW.isValidEmail('gue st@example.com'));
check('mask keeps the domain but hides the local part',
  GW.maskEmail('Alice.Smith@Gmail.com') === 'a***@gmail.com');
check('mask never shows the full address',
  GW.maskEmail('abcdefghij@kpotexpress.com').indexOf('abcdefghij') === -1);

/* ============================================================ */
section('capacity — judged at VERIFICATION time');

let r = round();
for (let i = 0; i < 199; i++) entry(r, 'guest' + i + '@example.com');
pendingOf(r, 'unverified@example.com');
let v = GW.capacityVerdict(r, NOW);
check('99 verified + 1 unverified still has room', v.ok && v.remaining === 1);
check('the unverified address takes no slot', GW.entryCount(r) === 199 && GW.pendingCount(r) === 1);

entry(r, 'guest199@example.com');
v = GW.capacityVerdict(r, NOW);
check('at 200 the round is full', !v.ok && v.reason === 'full');
check('full is explained politely',
  GW.reasonText('full').indexOf('200 verified entries') >= 0);

/* ============================================================ */
section('registration verdicts');

r = round();
check('a clean registration passes',
  GW.registerVerdict(r, { email: 'new@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).ok);
check('a bad address is refused',
  GW.registerVerdict(r, { email: 'nope', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).reason === 'bad_email');
check('an unacknowledged rules change is refused',
  GW.registerVerdict(r, { email: 'new@example.com', eligibilityAck: true, rulesVersion: 'OLD' }, CFG, NOW).reason === 'rules_stale');
check('an unchecked eligibility box is refused',
  GW.registerVerdict(r, { email: 'new@example.com', eligibilityAck: false, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).reason === 'ack_required');

entry(r, 'dup@example.com');
check('a verified address cannot register again',
  GW.registerVerdict(r, { email: 'DUP@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).reason === 'already_entered');

r = round();
pendingOf(r, 'pending@example.com');
check('a live pending link blocks a second send',
  GW.registerVerdict(r, { email: 'pending@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).reason === 'already_pending');
r = round();
const stale = pendingOf(r, 'stale@example.com', 48);
stale.expiresAt = new Date(NOW - 25 * 3600000).toISOString();
check('an expired pending link does not block a fresh one',
  GW.registerVerdict(r, { email: 'stale@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST' }, CFG, NOW).ok);

/* the marketing flag is recorded, never a gate: the verdict above passes
   with marketingOptIn absent, which is the OFF default */
r = round();
check('marketing opt-OUT (false) does not block registration',
  GW.registerVerdict(r, { email: 'nomkt@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST', marketingOptIn: false }, CFG, NOW).ok);
check('marketing opt-IN also passes (it is a separate choice)',
  GW.registerVerdict(r, { email: 'yesmkt@example.com', eligibilityAck: true, rulesVersion: 'LUCKY66-TEST', marketingOptIn: true }, CFG, NOW).ok);

/* ============================================================ */
section('verification — single use, expiring, capacity-at-verify');

r = round();
for (let i = 0; i < 200; i++) entry(r, 'fill' + i + '@example.com');
pendingOf(r, 'late@example.com');
let vv = GW.verifyVerdict(r, 'token-for-late@example.com', NOW);
check('the 201st verification is refused politely', !vv.ok && vv.reason === 'full');
check('the refusal message thanks them, not insults them',
  GW.reasonText('full').indexOf('Thank you') >= 0);

r = round();
pendingOf(r, 'ok@example.com');
vv = GW.verifyVerdict(r, 'token-for-ok@example.com', NOW);
check('a good token verifies', vv.ok && vv.pending.emailHash === GW.sha256Hex('ok@example.com'));
/* simulate the server writing the entry and consuming the token */
entry(r, 'ok@example.com');
r.pending.splice(0, 1);
check('the same token cannot be replayed',
  !GW.verifyVerdict(r, 'token-for-ok@example.com', NOW).ok &&
  GW.verifyVerdict(r, 'token-for-ok@example.com', NOW).reason === 'invalid_token');
check('a token nobody issued is refused',
  GW.verifyVerdict(r, 'token-for-ok@example', NOW).reason === 'invalid_token');

r = round();
const exp = pendingOf(r, 'exp@example.com');
exp.expiresAt = new Date(NOW - 1000).toISOString();
check('an expired token is refused as expired',
  GW.verifyVerdict(r, 'token-for-exp@example.com', NOW).reason === 'expired');

/* ============================================================ */
section('deadline closing short of 200');

r = round();
for (let i = 0; i < 7; i++) entry(r, 'early' + i + '@example.com');
const AFTER = Date.parse('2026-11-16T00:00:00.000Z');
let cap = GW.capacityVerdict(r, AFTER);
check('after the deadline the round takes no more entries', !cap.ok && cap.reason === 'deadline_passed');
r.status = GW.STATUS.CLOSED;
check('a short round can still be drawn once closed', GW.drawVerdict(r).ok);
check('open rounds cannot be drawn', (function () {
  const o = round(); entry(o, 'a@b.com');
  return GW.drawVerdict(o).reason === 'not_closed';
})());
const empty = round(); empty.status = GW.STATUS.CLOSED;
check('an empty round cannot be drawn', GW.drawVerdict(empty).reason === 'no_entries');

/* ============================================================ */
section('drawing — one winner, equal odds, idempotent');

r = round();
for (let i = 0; i < 200; i++) entry(r, 'draw' + i + '@example.com');
r.status = GW.STATUS.CLOSED;
check('draw verdict passes on a closed, non-empty round', GW.drawVerdict(r).ok);

/* every index is reachable and maps to exactly that entry */
let seen = {};
let allDistinct = true;
for (let i = 0; i < 200; i++) {
  const rec = GW.drawRecord(r, function (n) { return i; });
  if (i === 0) seen = {};
  const w = r.entries[i];
  if (rec.winnerRef !== w.ref) allDistinct = false;
  seen[rec.winnerRef] = (seen[rec.winnerRef] || 0) + 1;
}
check('each index selects exactly that entry (uniform 1/n, no bias)',
  allDistinct && Object.keys(seen).length === 200 && Object.keys(seen).every((k) => seen[k] === 1));
const rec0 = GW.drawRecord(r, function () { return 42; });
check('the audit record carries the snapshot and the algorithm',
  rec0.entriesCount === 200 && rec0.snapshot.length === 200 &&
  rec0.algorithm.indexOf('crypto.randomInt') === 0);
r.draw = rec0;
check('a repeated draw is refused and the result is unchanged',
  !GW.drawVerdict(r).ok && GW.drawVerdict(r).reason === 'already_drawn' &&
  GW.drawVerdict(r).draw.winnerRef === rec0.winnerRef);
const outOfRange = (function () {
  try { GW.drawRecord(r, function (n) { return n; }); return false; } catch (e) { return true; }
})();
check('an rng that returns out-of-range throws instead of misdrawing', outOfRange);

/* ============================================================ */
section('prize issuance is one-shot');

check('a drawn round can be issued to', GW.issueVerdict(r).ok);
r.prizeIssue = { issuedAt: new Date().toISOString(), by: 'admin', codeRef: 'ABCD…12', revokedAt: null };
check('a second issuance is refused', !GW.issueVerdict(r).ok && GW.issueVerdict(r).reason === 'already_issued');
const noWinnerRound = round(); noWinnerRound.status = GW.STATUS.CLOSED;
check('a round with no winner cannot be issued to',
  !GW.issueVerdict(noWinnerRound).ok && GW.issueVerdict(noWinnerRound).reason === 'no_winner');

/* ============================================================ */
section('public views leak nothing');

r = round();
for (let i = 0; i < 45; i++) entry(r, 'view' + i + '@example.com');
const view = GW.publicRound(r, NOW, CFG);
check('the count is public and honest', view.verifiedCount === 45 && view.maxEntries === 200);
check('the prize is a config fact', view.prizeValue === 66 && view.prizeDesc === 'KPOT EXPRESS $66 Store-Credit Code');
const json = JSON.stringify(view);
check('no e-mail address, hash or reference leaks to the customer page',
  json.indexOf('@example.com') === -1 && json.indexOf('sha') === -1 && json.indexOf('L66-') === -1);
check('the winner is announced without being named',
  view.winnerAnnounced === false && GW.publicRound(Object.assign(round(), { draw: rec0 }), NOW, CFG).winnerAnnounced === true);
check('report rows are masked',
  GW.reportEntries(r).every((e) => e.emailMasked === GW.maskEmail('view' + GW.reportEntries(r).indexOf(e) + '@example.com')));

/* ============================================================ */
section('rate limiter');

const hits = {};
let rlOk = true;
for (let i = 0; i < 5; i++) rlOk = GW.rateCheck(hits, 'ip1', NOW, 3600000, 5).ok && rlOk;
const sixth = GW.rateCheck(hits, 'ip1', NOW + 1000, 3600000, 5);
check('five attempts pass, the sixth is throttled', rlOk && !sixth.ok && sixth.retryAfterMs > 0);
check('a different key is unaffected', GW.rateCheck(hits, 'ip2', NOW, 3600000, 5).ok);
check('the window expires',
  !GW.rateCheck(hits, 'ip1', NOW + 3600001, 3600000, 5).ok === false);

/* ============================================================ */
section('suspicion flags');

r = round();
for (let i = 0; i < 3; i++) {
  entry(r, 'sameip' + i + '@example.com', '2026-11-01T12:00:00.000Z');
  r.entries[r.entries.length - 1].ipHash = 'deadbeefdeadbeef';
}
const flags = GW.suspicionFlags(r);
check('three entries from one IP raise a flag', flags.some((f) => f.kind === 'shared_ip' && f.count === 3));
check('the flag points at references, not addresses',
  flags[0].refs.every((x) => GW.isValidEntryRef(x) || x.indexOf('L66-') === 0));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILURES: ' + fail); process.exit(1); }
console.log('PASS — LUCKY 66 pure rules (' + pass + ' checks)');
