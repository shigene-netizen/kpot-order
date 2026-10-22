/* Store-credit ledger rules.
 *
 * The LUCKY 66 prize is a $66 store-credit code, and "store credit" means a
 * BALANCE, not a one-shot coupon: it comes off order after order until it runs
 * out. That makes the ledger the one place where a bug is not a wrong price on
 * one bill — it is money the shop owes, or money it gave away twice.
 *
 * What is pinned down here:
 *
 *   - CAPS. appliedFor() never takes more off an order than the order's food
 *     subtotal, and spendEntry() never lets a balance go below zero. A $66
 *     code on a $3 order takes $3 and leaves $63 — the other way round hands
 *     out food nobody paid for.
 *   - IDEMPOTENCE OF RESTORE. A cancelled order puts its money back, but a
 *     double refund (a re-check, a repeated PATCH) must not push the balance
 *     above what the code started with. restore() caps at the original value.
 *   - THE PLAINTEXT NEVER TOUCHES DISK. Codes are addressed by sha256. The
 *     one thing this file asserts about the file format is that a round-trip
 *     preserves balances, not that it preserves secrets.
 *   - EXPIRY. A code that expired is refused at spend time even though its
 *     balance is still sitting there.
 *
 * These are the RULES. That the server actually calls them — at BOTH money
 * gates, and only once per order — is _dev/probe_credit_http.js's job.
 *
 * Run:  node _dev/test_credit.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.dirname(__dirname);
const CR = require(path.join(ROOT, 'credits.js'));

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + want + '  got=' + got);
}
function ok(desc, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + desc + (cond ? '' : '\n         ' + (detail || '')));
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

/* ------------------------------------------------------------------ */
/* 1. Codes are matched forgivingly, but the separator is part of them  */
/* ------------------------------------------------------------------ */

check('normalizeCode trims', CR.normalizeCode('  kpot-ab12  '), 'KPOT-AB12');
check('normalizeCode collapses inner spaces', CR.normalizeCode('kpot  ab12'), 'KPOT AB12');
check('normalizeCode uppercases', CR.normalizeCode('kpot-ab12'), 'KPOT-AB12');
check('normalizeCode of nothing is empty', CR.normalizeCode(null), '');
ok('the separator is part of the code — "kpot ab12" is NOT "KPOT-AB12"',
  CR.hashCode('kpot ab12') !== CR.hashCode('kpot-ab12'));
ok('case does not matter — "kpot-ab12" IS "KPOT-AB12"',
  CR.hashCode('kpot-ab12') === CR.hashCode('KPOT-AB12'));
ok('a hash is 64 hex chars', /^[0-9a-f]{64}$/.test(CR.hashCode('KPOT-AB12-CD34')));
check('hashCode of nothing is empty', CR.hashCode(''), '');

check('a short code masks to one character plus an ellipsis', CR.maskCode('KPOT12'), 'K…');
check('a long code masks to first4…last2', CR.maskCode('KPOT-AB12-CD34-EF56'), 'KPOT…56');
check('isValidCode wants 8+ characters', CR.isValidCode('KPOT-12'), false);
check('isValidCode accepts a generated code', CR.isValidCode('KPOT-AB12-CD34-EF56'), true);
check('isValidCode counts after normalising', CR.isValidCode('  kpot-ab12-cd34-ef56 '), true);

/* ------------------------------------------------------------------ */
/* 2. Generated codes are strong and unambiguous                        */
/* ------------------------------------------------------------------ */

const gen = CR.generateCode();
ok('a generated code has the KPOT-XXXX-XXXX-XXXX shape',
  /^KPOT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(gen), gen);
ok('the alphabet drops the characters people confuse (no O/0, no I/1)',
  !/[OI01]/.test(gen.replace('KPOT', '')), gen);
const gens = {};
for (let i = 0; i < 500; i++) gens[CR.generateCode()] = 1;
ok('500 draws produced 500 distinct codes',
  Object.keys(gens).length === 500, Object.keys(gens).length + ' distinct');

/* ------------------------------------------------------------------ */
/* 3. Issue                                                             */
/* ------------------------------------------------------------------ */

let s = CR.blankStore();
const r1 = CR.issue(s, 'KPOT-AAAA-BBBB-CCCC', 66, { now: new Date(NOW).toISOString() });
ok('issuing a code succeeds', r1.ok === true);
check('the entry starts at its value', r1.entry.value, 66);
check('the balance starts at its value', r1.entry.balance, 66);
check('the entry stores only the mask', r1.entry.codeRef, 'KPOT…CC');
ok('the entry stores the hash, never the code',
  r1.entry.codeHash === CR.hashCode('KPOT-AAAA-BBBB-CCCC') &&
  JSON.stringify(s).indexOf('KPOT-AAAA-BBBB-CCCC') === -1);
check('expiry is 12 months out (in 30-day months)',
  Date.parse(r1.entry.expiresAt) - Date.parse(r1.entry.issuedAt), 12 * 30 * DAY);
ok('the issue is in the history', r1.entry.history.length === 1 && r1.entry.history[0].kind === 'issued');

const dup = CR.issue(s, 'kpot-aaaa-bbbb-cccc', 10);
ok('issuing the same code twice is refused (duplicate)',
  dup.ok === false && dup.reason === 'duplicate');
const badVal = CR.issue(s, 'KPOT-DDDD-EEEE-FFFF', 0);
ok('issuing a zero-value code is refused', badVal.ok === false && badVal.reason === 'bad_value');
const badCode = CR.issue(s, 'short', 10);
ok('issuing a short code is refused', badCode.ok === false && badCode.reason === 'bad_code');
check('the ledger holds exactly one code', Object.keys(s.codes).length, 1);

/* ------------------------------------------------------------------ */
/* 4. Verdicts — ok / revoked / expired / unknown                       */
/* ------------------------------------------------------------------ */

ok('a fresh code is spendable', CR.verdict(s, 'KPOT-AAAA-BBBB-CCCC', NOW).ok === true);
ok('an unknown code is not_found', CR.verdict(s, 'KPOT-ZZZZ-ZZZZ-ZZZZ', NOW).reason === 'not_found');
CR.revoke(s, 'KPOT-AAAA-BBBB-CCCC', { now: new Date(NOW).toISOString() });
ok('a revoked code is revoked', CR.verdict(s, 'KPOT-AAAA-BBBB-CCCC', NOW).reason === 'revoked');
ok('a revoked code keeps its balance but cannot be spent',
  CR.balanceOf(s, 'KPOT-AAAA-BBBB-CCCC').ok === false);

let s2 = CR.blankStore();
CR.issue(s2, 'KPOT-1111-2222-3333', 20, {
  now: new Date(NOW - 400 * DAY).toISOString(), months: 12
});
ok('a code past its expiry is expired', CR.verdict(s2, 'KPOT-1111-2222-3333', NOW).reason === 'expired');
ok('an expired code still reports its balance for display',
  CR.balanceOf(s2, 'KPOT-1111-2222-3333').reason === 'expired');

/* ------------------------------------------------------------------ */
/* 5. appliedFor — never more than the order's food subtotal            */
/* ------------------------------------------------------------------ */

let s3 = CR.blankStore();
CR.issue(s3, 'KPOT-5555-6666-7777', 66);
const e3 = CR.find(s3, 'KPOT-5555-6666-7777');
check('a $66 code on a $3 order takes $3', CR.appliedFor(e3, 3), 3);
check('a $66 code on a $66 order takes $66', CR.appliedFor(e3, 66), 66);
check('a $66 code on a $200 order takes $66 (not $200)', CR.appliedFor(e3, 200), 66);
check('a $66 code on an empty order takes $0', CR.appliedFor(e3, 0), 0);
check('an empty code on any order takes $0', CR.appliedFor(null, 50), 0);

/* ------------------------------------------------------------------ */
/* 6. Spending — and refusing to overspend                              */
/* ------------------------------------------------------------------ */

let s4 = CR.blankStore();
CR.issue(s4, 'KPOT-8888-9999-0000', 10);
const sp1 = CR.spendByCode(s4, 'KPOT-8888-9999-0000', 4, { orderId: 'KP-1' });
ok('a $4 spend on a $10 code succeeds', sp1.ok === true);
check('$4 comes off', sp1.applied, 4);
check('$6 is left', sp1.balanceAfter, 6);
const sp2 = CR.spendByCode(s4, 'KPOT-8888-9999-0000', 7, { orderId: 'KP-2' });
ok('a $7 spend on the remaining $6 is refused, not silently clamped',
  sp2.ok === false && sp2.reason === 'insufficient');
check('the refusal reports the real balance', sp2.balance, 6);
const sp3 = CR.spendByCode(s4, 'KPOT-8888-9999-0000', 6, { orderId: 'KP-2' });
ok('the exact remaining balance can still be spent', sp3.ok === true && sp3.balanceAfter === 0);
const sp4 = CR.spendByCode(s4, 'KPOT-8888-9999-0000', 0.01);
ok('an empty code refuses anything above zero', sp4.ok === false && sp4.reason === 'insufficient');
const sp5 = CR.spendByCode(s4, 'KPOT-NOPE-NOPE-NOPE', 1);
ok('spending an unknown code is refused', sp5.ok === false && sp5.reason === 'not_found');
const sp6 = CR.spendByCode(s4, 'KPOT-8888-9999-0000', 0);
ok('a zero spend is refused (nothing to do)', sp6.ok === false && sp6.reason === 'bad_amount');

let s5 = CR.blankStore();
CR.issue(s5, 'KPOT-ABCD-EFGH-IJKL', 30);
CR.revoke(s5, 'KPOT-ABCD-EFGH-IJKL');
ok('a revoked code cannot be spent', CR.spendByCode(s5, 'KPOT-ABCD-EFGH-IJKL', 1).reason === 'revoked');

let s6 = CR.blankStore();
CR.issue(s6, 'KPOT-MMMM-NNNN-OOOO', 30, {
  now: new Date(NOW - 400 * DAY).toISOString(), months: 12
});
ok('an expired code cannot be spent', CR.spendByCode(s6, 'KPOT-MMMM-NNNN-OOOO', 1).reason === 'expired');

/* spendByHash — how a cancellation finds the entry again, with no code */
let s7 = CR.blankStore();
CR.issue(s7, 'KPOT-PQRS-TUVW-XYZ0', 25);
const h7 = CR.hashCode('KPOT-PQRS-TUVW-XYZ0');
ok('spendByHash works like spendByCode',
  CR.spendByHash(s7, h7, 5).ok === true && CR.balanceOf(s7, 'KPOT-PQRS-TUVW-XYZ0').balance === 20);
ok('spendByHash with an unknown hash is refused',
  CR.spendByHash(s7, 'f'.repeat(64), 1).reason === 'not_found');

/* ------------------------------------------------------------------ */
/* 7. Restore — cancelled orders get their money back, exactly once      */
/* ------------------------------------------------------------------ */

let s8 = CR.blankStore();
CR.issue(s8, 'KPOT-REPL-ACEM-ENT1', 66);
CR.spendByCode(s8, 'KPOT-REPL-ACEM-ENT1', 20);
const re1 = CR.restore(s8, CR.hashCode('KPOT-REPL-ACEM-ENT1'), 20, { orderId: 'KP-9' });
ok('a cancelled order puts its $20 back', re1.ok === true && re1.balanceAfter === 66);
const re2 = CR.restore(s8, CR.hashCode('KPOT-REPL-ACEM-ENT1'), 20, { orderId: 'KP-9' });
ok('a SECOND restore of the same order is refused — the balance caps at the original value',
  re2.ok === false && re2.reason === 'would_exceed_original');
check('the balance is still exactly the original $66', CR.balanceOf(s8, 'KPOT-REPL-ACEM-ENT1').balance, 66);
ok('restoring an unknown hash is refused',
  CR.restore(s8, 'e'.repeat(64), 5).reason === 'not_found');
ok('restoring a zero amount is refused',
  CR.restore(s8, CR.hashCode('KPOT-REPL-ACEM-ENT1'), 0).reason === 'bad_amount');

/* History — the audit trail a code carries on itself */
const hist = CR.find(s8, 'KPOT-REPL-ACEM-ENT1').history;
ok('every movement is in the history (issued, spent, restored)',
  hist.length === 3 && hist[0].kind === 'issued' && hist[1].kind === 'spent' && hist[2].kind === 'restored',
  JSON.stringify(hist.map((h) => h.kind)));

/* ------------------------------------------------------------------ */
/* 8. Persistence — the file round-trips, and a broken one is not fatal  */
/* ------------------------------------------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-credit-'));
const file = path.join(tmp, 'credits.local.json');
CR.saveCredits(file, s8);
const back = CR.loadCredits(file);
check('the balance survives a save/load round-trip',
  CR.balanceOf(back, 'KPOT-REPL-ACEM-ENT1').balance, 66);
check('the expiry survives a save/load round-trip',
  Date.parse(CR.verdict(back, 'KPOT-REPL-ACEM-ENT1', NOW + 400 * DAY).entry.expiresAt) > 0, true);
ok('a missing file loads as a blank store, not a crash',
  CR.loadCredits(path.join(tmp, 'nope.json')).codes && Object.keys(CR.loadCredits(path.join(tmp, 'nope.json')).codes).length === 0);
fs.writeFileSync(path.join(tmp, 'broken.json'), '{not json at all');
ok('a corrupt file loads as a blank store rather than throwing',
  Object.keys(CR.loadCredits(path.join(tmp, 'broken.json')).codes).length === 0);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

/* ------------------------------------------------------------------ */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
