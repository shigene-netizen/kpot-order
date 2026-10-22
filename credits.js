/* ==========================================================================
   KPOT To Go — Store credit: the $66 LUCKY 66 prize code, as real money
   --------------------------------------------------------------------------
   WHAT THIS IS
   ------------
   The sweepstakes prize is a store-credit code: the winner gets a code, every
   order deducts from its balance until it is used up, and if the balance is
   short the guest pays the difference with another payment method. The
   Official Rules (section 5) promise exactly that, so this file is what makes
   the promise true — the code is spendable in the ordering app like any other
   discount, and the balance is a ledger here.

   THE CODE IS THE CREDENTIAL
   --------------------------
   Whoever holds the code can spend the balance — the same trade the owner
   already made with the loyalty phone number (see customers.js). Two rules
   follow, and both are enforced here:

     * the PLAINTEXT code is never written to disk. Only sha256(code) is, so a
       leaked store file cannot be redeemed — same rule as the giveaway's
       verification tokens. An order keeps the HASH (it is the lookup key, not
       a secret) so a cancellation can find the entry again.
     * every read of a balance and every spend is a pure function on a plain
       object, with file I/O taking the path as an argument — a test can never
       touch the shop's real ledger.

   WHEN THE BALANCE MOVES
   ----------------------
   Exactly two moments, mirroring the loyalty ledger:

     * DECREMENTED when the order is RECORDED (server.js money gate 2, after
       Stripe has been handed the priced session and the order exists).
       Handing a guest to Stripe is not a purchase, and a guest who opens
       Stripe and walks away must not drain the code.
     * RESTORED if that order is cancelled — the abandoned-session path and
       the staff-cancel path both, each guarded by the order's own `released`
       flag so nothing can be refunded twice.

   A spend re-validates against the CURRENT balance, so two orders racing for
   the last dollars cannot both win: the second is refused with a 409 rather
   than silently over-discounting the food.

   Nothing here decides the price. It answers "how much may this code take off
   THIS order?" and hands the answer to pricing.js as an ordinary amount
   discount — exactly like a coupon.
   ========================================================================== */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

/* ---- The rules, in one place -------------------------------------------- */

/* 12 × 30-day months from issuance, per the Official Rules ("expires 12
   months after issuance"). Applies to the CODE, not to each dollar of it: a
   half-spent code still dies on its first birthday. */
const EXPIRY_MONTHS = 12;

/* Sanity ceilings. A ledger that grows without bound is a ledger that
   eventually fails to load. One code per round plus the owner's own test
   codes will never approach this; it is here so a bug cannot. */
const MAX_CODES = 5000;
const MAX_HISTORY = 40;         // per code

/* A code an owner types by hand must be at least this long. Four characters
   is a bike-lock combination, and this thing is money. Issuance can also
   generate a strong one, which is what the prize flow does by default. */
const MIN_CODE_LENGTH = 8;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ---- Normalisation -------------------------------------------------------- *
   Codes are typed by hand and read off an e-mail, so matching is forgiving:
   surrounding space goes, inner runs of space collapse, case is ignored.
   'kpot ab12' and 'KPOT-AB12' are NOT the same code — the separator is part
   of it — but 'kpot-ab12' and 'KPOT-AB12' are.                                            */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/* sha256, hex. Never store or log the plaintext. */
function hashCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return '';
  return crypto.createHash('sha256').update(code).digest('hex');
}

/* What the owner sees in place of the code: enough to recognise, never
   enough to redeem. Same shape the giveaway's prize issuance already uses. */
function maskCode(raw) {
  const code = normalizeCode(raw);
  if (code.length <= 6) return code.slice(0, 1) + '…';
  return code.slice(0, 4) + '…' + code.slice(-2);
}

/* A strong code for issuance: KPOT-XXXX-XXXX-XXXX, ~48 bits of entropy in the
   body, unambiguous alphabet (no O/0, no I/1) because it gets read aloud and
   retyped. */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => {
    const b = crypto.randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[b[i] % alphabet.length];
    return s;
  };
  return 'KPOT-' + group() + '-' + group() + '-' + group();
}

function isValidCode(raw) {
  return normalizeCode(raw).length >= MIN_CODE_LENGTH;
}

/* ---- The ledger object ---------------------------------------------------- */

function blankStore() {
  return { codes: {}, updatedAt: null };
}

function blankEntry(code, value, opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const months = isFinite(opts.months) && opts.months > 0 ? opts.months : EXPIRY_MONTHS;
  const issuedAt = Date.parse(now);
  return {
    codeHash: hashCode(code),
    codeRef: maskCode(code),
    value: round2(value),          // what it started as
    balance: round2(value),        // what is left
    issuedAt: now,
    expiresAt: new Date(issuedAt + months * 30 * 24 * 3600 * 1000).toISOString(),
    roundId: String(opts.roundId || '').slice(0, 40),
    revokedAt: null,
    history: []
  };
}

/* ---- Pure lookups ---------------------------------------------------------- */

function find(store, rawCode) {
  const h = hashCode(rawCode);
  if (!h || !store || !store.codes) return null;
  return store.codes[h] || null;
}

function findByHash(store, hash) {
  if (!hash || !store || !store.codes) return null;
  return store.codes[hash] || null;
}

/* Is this entry spendable at all? Reasons are stable strings — server.js maps
   them to HTTP codes and the guest page maps them to sentences. */
function entryVerdict(entry, nowMs) {
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.revokedAt) return { ok: false, reason: 'revoked', entry: entry };
  const now = nowMs || Date.now();
  if (Date.parse(entry.expiresAt || '') <= now) return { ok: false, reason: 'expired', entry: entry };
  return { ok: true, entry: entry };
}

function verdict(store, rawCode, nowMs) {
  return entryVerdict(find(store, rawCode), nowMs);
}

/* How much this code may take off THIS order. Never more than the order's
   food subtotal — a $66 code on a $3 order takes off $3, not $66, and the
   other $63 stays on the code for next time. */
function appliedFor(entry, subtotal) {
  if (!entry || !isFinite(Number(entry.balance))) return 0;
  const bal = round2(entry.balance);
  const sub = round2(subtotal);
  if (bal <= 0 || sub <= 0) return 0;
  return Math.min(bal, sub);
}

function balanceOf(store, rawCode) {
  const v = verdict(store, rawCode, Date.now());
  if (!v.ok) return { ok: false, reason: v.reason };
  return {
    ok: true,
    balance: round2(v.entry.balance),
    expiresAt: v.entry.expiresAt,
    codeRef: v.entry.codeRef
  };
}

/* ---- Mutations ------------------------------------------------------------- */

/* Issue a code into the ledger. Refuses a duplicate (the same code issued
   twice would silently merge two balances into one entry) and a non-positive
   value. */
function issue(store, rawCode, value, opts) {
  opts = opts || {};
  const code = normalizeCode(rawCode);
  if (!isValidCode(code)) return { ok: false, reason: 'bad_code' };
  const v = round2(Number(value));
  if (!isFinite(v) || v <= 0) return { ok: false, reason: 'bad_value' };
  if (!store || !store.codes) return { ok: false, reason: 'no_store' };
  const h = hashCode(code);
  if (store.codes[h]) return { ok: false, reason: 'duplicate' };
  if (Object.keys(store.codes).length >= MAX_CODES) return { ok: false, reason: 'too_many' };

  const entry = blankEntry(code, v, opts);
  store.codes[h] = entry;
  pushHistory(entry, 'issued', v, opts.note || '', opts.now);
  return { ok: true, entry: entry, code: code };
}

/* Take money off a code, addressed either by the code itself or by its hash
   (an order stores the hash, because the plaintext must never reach disk).
   Both go through spendEntry, which re-validates against the CURRENT balance:
   the caller priced the order a moment ago, and another order may have spent
   the code in between. Refusing is the only honest answer — an over-discount
   would hand out food nobody paid for. */
function spendByCode(store, rawCode, amount, opts) {
  return spendEntry(find(store, rawCode), amount, opts);
}

function spendByHash(store, codeHash, amount, opts) {
  return spendEntry(findByHash(store, codeHash), amount, opts);
}

function spendEntry(entry, amount, opts) {
  opts = opts || {};
  if (!entry) return { ok: false, reason: 'not_found' };
  const v = entryVerdict(entry, Date.now());
  if (!v.ok) return { ok: false, reason: v.reason };

  const amt = round2(Number(amount));
  if (!isFinite(amt) || amt <= 0) return { ok: false, reason: 'bad_amount' };
  if (amt > round2(entry.balance) + 0.001) return { ok: false, reason: 'insufficient', balance: round2(entry.balance) };

  const before = round2(entry.balance);
  entry.balance = round2(before - amt);
  pushHistory(entry, 'spent', -amt, opts.orderId || '', opts.now);
  return { ok: true, applied: amt, balanceAfter: entry.balance, balanceBefore: before };
}

/* Put money back on a cancelled order. The caller guards against a second
   release (order.credit.released), so this does not need to — but it does
   refuse to push a balance above the code's original value, which is what
   would happen if the same order were somehow refunded twice. */
function restore(store, codeHash, amount, opts) {
  opts = opts || {};
  const entry = findByHash(store, codeHash);
  if (!entry) return { ok: false, reason: 'not_found' };
  const amt = round2(Number(amount));
  if (!isFinite(amt) || amt <= 0) return { ok: false, reason: 'bad_amount' };
  const before = round2(entry.balance);
  const after = round2(before + amt);
  if (after > round2(entry.value) + 0.001) {
    return { ok: false, reason: 'would_exceed_original', balance: before };
  }
  entry.balance = after;
  pushHistory(entry, 'restored', amt, opts.orderId || '', opts.now);
  return { ok: true, applied: amt, balanceAfter: after, balanceBefore: before };
}

function revoke(store, rawCode, opts) {
  opts = opts || {};
  const entry = find(store, rawCode);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.revokedAt) return { ok: false, reason: 'already_revoked' };
  entry.revokedAt = opts.now || new Date().toISOString();
  pushHistory(entry, 'revoked', 0, opts.note || '', entry.revokedAt);
  return { ok: true, entry: entry };
}

function pushHistory(entry, kind, delta, note, now) {
  entry.history = entry.history || [];
  entry.history.push({
    at: now || new Date().toISOString(),
    kind: String(kind || '').slice(0, 24),
    delta: round2(Number(delta) || 0),
    note: String(note || '').slice(0, 60)
  });
  if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
}

/* ---- Persistence ----------------------------------------------------------- */

function loadCredits(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.codes && typeof j.codes === 'object' && !Array.isArray(j.codes)) {
      const codes = {};
      for (const h of Object.keys(j.codes)) {
        const e = j.codes[h];
        if (!e || typeof e !== 'object' || !e.codeHash) continue;
        codes[e.codeHash] = {
          codeHash: String(e.codeHash),
          codeRef: String(e.codeRef || ''),
          value: round2(Number(e.value) || 0),
          balance: round2(Number(e.balance) || 0),
          issuedAt: String(e.issuedAt || ''),
          expiresAt: String(e.expiresAt || ''),
          roundId: String(e.roundId || ''),
          revokedAt: e.revokedAt ? String(e.revokedAt) : null,
          history: Array.isArray(e.history) ? e.history.slice(-MAX_HISTORY) : []
        };
      }
      return { codes, updatedAt: j.updatedAt || null, loaded: true };
    }
  } catch (e) { /* no file yet, or unreadable — start empty */ }
  return blankStore();
}

/* Same atomic-write shape the other stores use: a temp file and a rename, so
   a crash mid-write cannot leave half a ledger behind. */
function saveCredits(file, store) {
  const updatedAt = new Date().toISOString();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt, codes: store.codes }, null, 2));
  fs.renameSync(tmp, file);
  store.updatedAt = updatedAt;
  return updatedAt;
}

module.exports = {
  EXPIRY_MONTHS,
  MIN_CODE_LENGTH,
  normalizeCode,
  hashCode,
  maskCode,
  generateCode,
  isValidCode,
  blankStore,
  blankEntry,
  find,
  findByHash,
  verdict,
  entryVerdict,
  appliedFor,
  balanceOf,
  issue,
  spendByCode,
  spendByHash,
  restore,
  revoke,
  loadCredits,
  saveCredits
};
