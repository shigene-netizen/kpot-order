/* ==========================================================================
   KPOT EXPRESS — LUCKY 66 · giveaway store
   --------------------------------------------------------------------------
   Own JSON file. Deliberately NOT orders/customers/menu/discounts: the
   loyalty ledger (SARANG Rewards) and customer data must not be reused by
   this feature, and one shared file would make that boundary a matter of
   discipline instead of structure.

   API is synchronous by design. Every handler that reads the file, mutates
   it and writes it back does so inside one synchronous block, so two
   concurrent verifications can never both observe "99 entries" and both
   write the 100th and the 101st. The write is atomic (tmp + rename) with
   0600 perms — this file holds e-mail addresses.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const GW = require('./assets/giveaway.js');

const ROOT = __dirname;
const FILE = process.env.KPOT_GIVEAWAY_FILE || path.join(ROOT, 'giveaway.local.json');

let mem = null;

function freshStore() {
  return {
    version: 1,
    rulesVersion: GW.DEFAULTS.rulesVersion,
    rounds: [],
    people: {},        /* emailHash -> { email, createdAt }  (server-side only) */
    consents: {},      /* emailHash -> marketing consent record */
    counters: { round: 0, entry: 0 }
  };
}

function load() {
  if (mem) return mem;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.rounds)) {
      mem = Object.assign(freshStore(), j);
    } else {
      console.error('[kpot] giveaway store is not the expected shape — starting a fresh one');
      mem = freshStore();
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[kpot] giveaway store unreadable (' + e.message + ') — starting fresh');
    }
    mem = freshStore();
  }
  return mem;
}

function save(store) {
  mem = store || mem;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch (e) { /* best effort on non-POSIX */ }
  return mem;
}

/* The person behind an address. Stored ONCE here; entries, pending records
   and consents all point at emailHash. */
function upsertPerson(store, email) {
  const emailHash = GW.sha256Hex(email);
  if (!store.people[emailHash]) {
    store.people[emailHash] = { email: email, createdAt: new Date().toISOString() };
  }
  return store.people[emailHash];
}

function nextRoundId(store) {
  store.counters.round = (store.counters.round || 0) + 1;
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
  return 'L66-' + stamp + '-' + String(store.counters.round).padStart(3, '0');
}

function uniqueRef(store) {
  for (;;) {
    const ref = GW.newEntryRef();
    const taken = (store.rounds || []).some(function (r) {
      return (r.entries || []).some(function (e) { return e.ref === ref; });
    });
    if (!taken) return ref;
  }
}

module.exports = {
  FILE,
  load,
  save,
  freshStore,
  upsertPerson,
  nextRoundId,
  uniqueRef
};
