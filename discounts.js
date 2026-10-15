/* ==========================================================================
   KPOT To Go — Discount codes
   --------------------------------------------------------------------------
   Codes live on disk (discounts.local.json) so they survive a redeploy, the
   same reason the owner's channel switches and menu live on disk.

   Every file path is a PARAMETER, never a constant: tests pass a temp file so
   a test run can never touch the owner's real codes. See the "hermetic" rule
   in README.

   Nothing in here decides money — that is pricing.js. This module only answers
   "is this a real code, and is it allowed right now?".
   ========================================================================== */

'use strict';

const fs = require('fs');

const TYPES = ['percent', 'amount', 'freeship'];
const MAX_CODES = 100;

/* "welcome 10", "Welcome-10!", "WELCOME10" are all one code.

   Everything that is not a letter or a digit is dropped, dashes and
   underscores INCLUDED. A poster printed "SUMMER-25" must still work for a
   guest who types "summer25" — the code is theirs to type on a phone keyboard,
   and making them guess whether the dash counts is a support call waiting to
   happen. The trade is that "A-B" and "AB" are one code; validateList() spots
   that collision rather than letting it through. */
function normalizeCode(c) {
  return String(c == null ? '' : c)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

const isNum = (x) => typeof x === 'number' && isFinite(x) && x >= 0;

/* Returns an error string, or null when the entry is usable. Deliberately
   strict: a half-valid code would apply differently in different places. */
function validateDiscount(d) {
  if (!d || typeof d !== 'object') return 'each discount must be an object';
  if (!normalizeCode(d.code)) return 'a discount needs a code (letters/numbers)';

  if (!TYPES.includes(d.type)) return 'type must be percent, amount, or freeship';

  const v = Number(d.value);
  if (d.type === 'percent') {
    if (!isFinite(v) || v <= 0 || v > 100) return 'percent must be between 0 and 100';
  } else if (d.type === 'amount') {
    if (!isFinite(v) || v <= 0) return 'amount must be a number greater than 0';
  }

  if (d.minSubtotal != null && !isNum(Number(d.minSubtotal))) {
    return 'minSubtotal must be a number ≥ 0';
  }
  if (d.maxUses != null) {
    const m = Number(d.maxUses);
    if (!isFinite(m) || m < 1 || Math.floor(m) !== m) return 'maxUses must be a whole number ≥ 1';
  }
  if (d.expiresAt != null) {
    if (isNaN(Date.parse(d.expiresAt))) return 'expiresAt must be a date';
  }
  if (d.active != null && typeof d.active !== 'boolean') return 'active must be true or false';
  return null;
}

/* Shape used by pricing.js — nothing else leaks out of this module. */
function toDescriptor(d) {
  return {
    type: d.type,
    value: Number(d.value) || 0,
    code: normalizeCode(d.code),
    source: 'code'
  };
}

function loadDiscounts(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.codes)) {
      const codes = j.codes.filter((c) => !validateDiscount(c)).map(normalizeOne);
      return { codes, loaded: true };
    }
  } catch (e) { /* no file yet, or unreadable — start empty */ }
  return { codes: [], loaded: false };
}

function normalizeOne(c) {
  return {
    id: c.id ? String(c.id).slice(0, 40) : 'c' + Math.random().toString(36).slice(2, 10),
    code: normalizeCode(c.code),
    type: c.type,
    value: Number(c.value) || 0,
    minSubtotal: isNum(Number(c.minSubtotal)) ? Number(c.minSubtotal) : 0,
    maxUses: c.maxUses == null ? null : Number(c.maxUses),
    used: isNum(Number(c.used)) ? Math.floor(Number(c.used)) : 0,
    expiresAt: c.expiresAt == null ? null : String(c.expiresAt),
    active: c.active === false ? false : true
  };
}

function saveDiscounts(file, codes) {
  const payload = { codes, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return payload.updatedAt;
}

/* Validate a whole list before it is stored — checks the OWNER's input, which
   is stricter than validateDiscount alone (it must also be internally
   consistent: no duplicate codes, not too many). */
function validateList(list) {
  if (!Array.isArray(list)) return 'expected a list of discounts';
  if (list.length > MAX_CODES) return 'too many discount codes (max ' + MAX_CODES + ')';

  const seen = new Set();
  for (const d of list) {
    const err = validateDiscount(d);
    if (err) return err;
    const code = normalizeCode(d.code);
    if (seen.has(code)) return 'duplicate code: ' + code;
    seen.add(code);
  }
  return null;
}

/* Is this code real, and may it be used on this order right now?
   `subtotal` and `now` are passed in (not read from the clock) so the rule is
   testable without waiting for a code to actually expire. */
function resolveCode(codes, rawCode, subtotal, now) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'empty_code', message: 'Enter a discount code.' };

  const hit = codes.find((c) => normalizeCode(c.code) === code);
  if (!hit) return { ok: false, error: 'unknown_code', message: 'That code is not valid.' };
  if (!hit.active) return { ok: false, error: 'inactive', message: 'That code is no longer active.' };

  if (hit.expiresAt) {
    const exp = Date.parse(hit.expiresAt);
    if (isFinite(exp) && (now || Date.now()) > exp) {
      return { ok: false, error: 'expired', message: 'That code has expired.' };
    }
  }

  if (hit.maxUses != null && hit.used >= hit.maxUses) {
    return { ok: false, error: 'used_up', message: 'That code has already been used.' };
  }

  const min = Number(hit.minSubtotal) || 0;
  if (min > 0 && Number(subtotal) < min) {
    return {
      ok: false,
      error: 'min_subtotal',
      min: min,
      message: 'That code needs a subtotal of at least $' + min.toFixed(2) + '.'
    };
  }

  return { ok: true, code: hit, discount: toDescriptor(hit) };
}

/* A code is spent only when the order is actually placed — handing a guest to
   Stripe is not a purchase. Returns the updated list. */
function spendCode(codes, entry) {
  if (!entry) return codes;
  return codes.map((c) => (c === entry ? Object.assign({}, c, { used: (c.used || 0) + 1 }) : c));
}

module.exports = {
  TYPES, MAX_CODES,
  normalizeCode, validateDiscount, validateList, normalizeOne,
  loadDiscounts, saveDiscounts, resolveCode, spendCode
};
