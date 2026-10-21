/* ==========================================================================
   KPOT EXPRESS — LUCKY 66 · pure giveaway logic
   --------------------------------------------------------------------------
   Runs in the server (Node) AND in the browser (the customer page uses the
   same rules to decide what to show). No DOM access, no fs, no network —
   everything here is a function of its arguments, which is what makes the
   rules testable without a server.

   Money path lives in server.js; this module is the RULES.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GIVEAWAY = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ---- Config normalisation -------------------------------------------------
     Fail CLOSED on garbage: an unreadable config must not open a paid lottery
     by accident. Unknown numbers fall back to the shipped conservative values
     (200 entries, $66 prize), never to something bigger. */
  var DEFAULTS = {
    enabled: false,            // production gate — see server.js giveawayEnabled()
    maxEntries: 200,
    prizeValue: 66,
    prizeDesc: 'KPOT EXPRESS $66 Store-Credit Code',
    rulesVersion: 'LUCKY66-2026-10-20',
    noticeVersion: '1',
    verifyHours: 24,
    pagePath: '/giveaway.html'
  };

  function sanitizeGiveawayConfig(cfg) {
    cfg = cfg || {};
    var n = Number(cfg.maxEntries);
    var v = Number(cfg.prizeValue);
    return {
      enabled: cfg.enabled === true,
      maxEntries: isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.maxEntries,
      prizeValue: isFinite(v) && v > 0 ? v : DEFAULTS.prizeValue,
      prizeDesc: String(cfg.prizeDesc || DEFAULTS.prizeDesc),
      rulesVersion: String(cfg.rulesVersion || DEFAULTS.rulesVersion),
      noticeVersion: String(cfg.noticeVersion || DEFAULTS.noticeVersion),
      verifyHours: isFinite(Number(cfg.verifyHours)) && Number(cfg.verifyHours) > 0
        ? Number(cfg.verifyHours) : DEFAULTS.verifyHours,
      pagePath: String(cfg.pagePath || DEFAULTS.pagePath)
    };
  }

  /* ---- State machine --------------------------------------------------------
     DRAFT → OPEN → CLOSED → DRAWN → PRIZE ISSUED → COMPLETED
     PAUSED freezes entry acceptance without closing; CANCELLED is terminal. */
  var STATUS = {
    DRAFT: 'DRAFT',
    OPEN: 'OPEN',
    CLOSED: 'CLOSED',
    DRAWN: 'DRAWN',
    PRIZE_ISSUED: 'PRIZE_ISSUED',
    COMPLETED: 'COMPLETED',
    PAUSED: 'PAUSED',
    CANCELLED: 'CANCELLED'
  };

  var TRANSITIONS = {
    DRAFT: ['OPEN', 'CANCELLED'],
    OPEN: ['CLOSED', 'PAUSED', 'CANCELLED'],
    PAUSED: ['OPEN', 'CLOSED', 'CANCELLED'],
    CLOSED: ['DRAWN', 'CANCELLED'],
    DRAWN: ['PRIZE_ISSUED', 'CANCELLED'],
    PRIZE_ISSUED: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: []
  };

  var STATUS_LABEL = {
    DRAFT: 'Draft',
    OPEN: 'Open',
    CLOSED: 'Closed',
    DRAWN: 'Winner selected',
    PRIZE_ISSUED: 'Prize issued',
    COMPLETED: 'Completed',
    PAUSED: 'Paused',
    CANCELLED: 'Cancelled'
  };

  function nextStatuses(from) { return (TRANSITIONS[from] || []).slice(); }
  function canTransition(from, to) { return nextStatuses(from).indexOf(to) >= 0; }
  function statusLabel(s) { return STATUS_LABEL[s] || s || ''; }
  function entryCount(round) { return (round && round.entries ? round.entries.length : 0); }
  function pendingCount(round) { return (round && round.pending ? round.pending.length : 0); }

  /* ---- E-mail ---------------------------------------------------------------
     Pragmatic checks: the SMTP server is the final authority. The regex below
     accepts what real mailboxes use and rejects the shapes that are always
     typos (spaces, missing @, missing dot, leading/trailing dot). */
  function normalizeEmail(e) {
    var s = String(e == null ? '' : e).trim().toLowerCase();
    if (s.indexOf('<') >= 0 && s.indexOf('>') > s.indexOf('<')) {
      s = s.slice(s.indexOf('<') + 1, s.indexOf('>')).trim();
    }
    return s;
  }
  function isValidEmail(e) {
    var s = normalizeEmail(e);
    if (!s || s.length > 254) return false;
    if (/^\.|\.$|\.\./.test(s)) return false;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
  }
  function maskEmail(e) {
    var s = normalizeEmail(e);
    var at = s.indexOf('@');
    if (at <= 0 || at === s.length - 1) return '***';
    var dom = s.slice(at + 1);
    return s.charAt(0) + '***@' + dom;
  }

  /* ---- Randomness & tokens ---------------------------------------------------
     Verification tokens are 256-bit, stored only as a SHA-256 hash, and
     single-use. Entry references are human-readable but carry no meaning. */
  var REF_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; /* Crockford base32, no I/L/O/U */
  function randomBytesHex(n) {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto)
      || (typeof require === 'function' ? require('crypto') : null);
    if (c && c.randomFillSync) {
      var b = Buffer.alloc(n);
      c.randomFillSync(b);
      return Buffer.from(b).toString('hex');
    }
    if (c && c.getRandomValues) {
      var a = new Uint8Array(n);
      c.getRandomValues(a);
      return Array.prototype.map.call(a, function (x) {
        return ('0' + x.toString(16)).slice(-2);
      }).join('');
    }
    throw new Error('no crypto available');
  }
  function sha256Hex(s) {
    if (typeof require === 'function') {
      var cc = require('crypto');
      return cc.createHash('sha256').update(String(s), 'utf8').digest('hex');
    }
    throw new Error('sha256Hex is server-only');
  }
  function newToken() { return randomBytesHex(32); }
  function hashToken(t) { return sha256Hex(String(t == null ? '' : t)); }
  function newEntryRef() {
    var raw = randomBytesHex(8);
    var out = [];
    for (var i = 0; i < 8; i++) {
      out.push(REF_ABC[parseInt(raw.slice(i * 2, i * 2 + 2), 16) % REF_ABC.length]);
    }
    return 'L66-' + out.slice(0, 4).join('') + '-' + out.slice(4).join('');
  }
  function isValidEntryRef(r) {
    return /^L66-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(String(r || ''));
  }

  /* ---- Capacity & deadlines ---------------------------------------------------
     The 200-person cap is judged at VERIFICATION time, not at registration:
     an unverified address takes nothing. That is what stops a bot filling the
     round with junk e-mails, and what makes "rejected politely after 200" a
     real, reachable state. */
  var REASONS = {
    bad_email: 'That e-mail address does not look right — please check it.',
    ack_required: 'Please confirm the eligibility statement and the Official Rules.',
    rules_stale: 'The Official Rules were updated. Please reload and try again.',
    already_entered: 'That e-mail address is already entered in this round.',
    already_pending: 'We already sent a confirmation link to that address. Check your inbox (and spam), or request a new one.',
    expired: 'That confirmation link expired. Please request a new one.',
    invalid_token: 'That confirmation link is not valid. Please request a new one.',
    not_open: 'This giveaway is not taking entries right now.',
    not_started: 'This round has not opened yet.',
    deadline_passed: 'This round has closed. Thank you!',
    full: 'This round is full — 200 verified entries. Thank you!',
    disabled: 'The Lucky 66 giveaway is not open yet.',
    rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
    no_round: 'There is no active round right now.'
  };
  function reasonText(code) { return REASONS[code] || 'Something went wrong. Please try again.'; }

  function capacityVerdict(round, nowMs) {
    if (!round) return { ok: false, reason: 'no_round' };
    if (round.status !== STATUS.OPEN) return { ok: false, reason: 'not_open' };
    var opens = Date.parse(round.opensAt || '') || 0;
    var closes = Date.parse(round.closesAt || '') || 0;
    if (opens && nowMs < opens) return { ok: false, reason: 'not_started' };
    if (closes && nowMs > closes) return { ok: false, reason: 'deadline_passed' };
    if (entryCount(round) >= Math.max(1, Number(round.maxEntries) || 1)) {
      return { ok: false, reason: 'full' };
    }
    return { ok: true, remaining: Math.max(1, Number(round.maxEntries) || 1) - entryCount(round) };
  }

  /* The one open round, if any. Earliest opening wins so a re-opened round
     can never double-dip against an older one still marked OPEN. */
  function currentRound(rounds, nowMs) {
    var best = null;
    (rounds || []).forEach(function (r) {
      if (r.status !== STATUS.OPEN) return;
      if (!best || Date.parse(r.opensAt || '') < Date.parse(best.opensAt || '')) best = r;
    });
    return best;
  }

  /* ---- Registration -----------------------------------------------------------
     Pure: reads the round, decides, and the server writes. */
  function registerVerdict(round, input, cfg, nowMs) {
    cfg = sanitizeGiveawayConfig(cfg);
    input = input || {};
    nowMs = nowMs || Date.now();
    var email = normalizeEmail(input.email);
    if (!isValidEmail(email)) return { ok: false, reason: 'bad_email' };
    if (input.eligibilityAck !== true) return { ok: false, reason: 'ack_required' };
    if (String(input.rulesVersion || '') !== cfg.rulesVersion) return { ok: false, reason: 'rules_stale' };

    var cap = capacityVerdict(round, nowMs);
    if (!cap.ok) return cap;

    var hash = sha256Hex(email);
    var dup = roundDuplicate(round, hash, nowMs);
    if (dup) return { ok: false, reason: dup };
    return { ok: true, emailHash: hash, email: email };
  }

  /* 'already_entered' beats 'already_pending': someone who verified is in,
     and no amount of pending state changes that. */
  function roundDuplicate(round, emailHash, nowMs) {
    nowMs = nowMs || Date.now();
    var i;
    for (i = 0; i < (round.entries || []).length; i++) {
      if (round.entries[i].emailHash === emailHash) return 'already_entered';
    }
    for (i = 0; i < (round.pending || []).length; i++) {
      if (round.pending[i].emailHash === emailHash &&
          Date.parse(round.pending[i].expiresAt || '') > nowMs) {
        return 'already_pending';
      }
    }
    return null;
  }

  /* ---- Verification -----------------------------------------------------------
     findPendingByToken compares HASHES — the raw token only ever travels in
     the e-mail link. A used token is gone from the array, and an expired one
     is refused, so replay is structurally impossible. */
  function findPendingByToken(round, token) {
    if (!round || !token) return null;
    var h = hashToken(token);
    var list = round.pending || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].tokenHash === h) return { pending: list[i], index: i };
    }
    return null;
  }
  function verifyVerdict(round, token, nowMs) {
    var hit = findPendingByToken(round, token);
    if (!hit) return { ok: false, reason: 'invalid_token' };
    if (Date.parse(hit.pending.expiresAt || '') <= nowMs) return { ok: false, reason: 'expired' };
    var cap = capacityVerdict(round, nowMs);
    if (!cap.ok) return cap;
    return { ok: true, pending: hit.pending };
  }

  /* ---- Drawing ----------------------------------------------------------------
     Pure selection: the winner is entries[index] where index comes from a
     CSPRNG the CALLER supplies (server: crypto.randomInt; test: a stub).
     Every entry therefore has exactly 1/n probability and no stored preference
     can steer the result. The audit record below is what makes the draw
     reproducible in the "which entry won" sense without exposing PII. */
  function drawVerdict(round) {
    if (!round) return { ok: false, reason: 'no_round' };
    /* "Already drawn" is checked BEFORE the status: a second request after a
       successful draw lands here with status DRAWN, and the honest answer is
       that the round was already drawn (with the unchanged result), not that
       it was never closed. */
    if (round.draw) return { ok: false, reason: 'already_drawn', draw: round.draw };
    if (round.status !== STATUS.CLOSED) return { ok: false, reason: 'not_closed' };
    if (entryCount(round) < 1) return { ok: false, reason: 'no_entries' };
    return { ok: true };
  }
  function pickIndex(n, rng) {
    var f = typeof rng === 'function' ? rng : function (max) {
      return require('crypto').randomInt(max);
    };
    var i = Math.floor(Number(f(n)) || 0);
    if (!(i >= 0 && i < n)) throw new Error('rng returned an out-of-range index');
    return i;
  }
  function drawRecord(round, rng, ctx) {
    ctx = ctx || {};
    var entries = round.entries || [];
    var idx = pickIndex(entries.length, rng);
    var winner = entries[idx];
    return {
      winnerEntryId: winner.id,
      winnerRef: winner.ref,
      drawnAt: ctx.at || new Date().toISOString(),
      by: ctx.by || 'admin',
      entriesCount: entries.length,
      algorithm: 'crypto.randomInt(0, entries.length)',
      snapshot: entries.map(function (e) { return { id: e.id, ref: e.ref }; })
    };
  }

  /* ---- Prize ------------------------------------------------------------------
     Issuance is one-shot: a second call refuses unless the operator passes
     reissue:true, and the refusal is audited. */
  function issueVerdict(round) {
    if (!round) return { ok: false, reason: 'no_round' };
    if (!round.draw) return { ok: false, reason: 'no_winner' };
    if (round.prizeIssue && !round.prizeIssue.revokedAt) return { ok: false, reason: 'already_issued' };
    return { ok: true };
  }

  /* ---- Views ------------------------------------------------------------------
     What the CUSTOMER page may see: counts and dates, never a single e-mail. */
  function publicRound(round, nowMs, cfg) {
    cfg = sanitizeGiveawayConfig(cfg);
    var view = {
      enabled: false,
      hasRound: !!round,
      status: round ? round.status : 'NONE',
      statusLabel: statusLabel(round ? round.status : 'NONE'),
      prizeValue: cfg.prizeValue,
      prizeDesc: cfg.prizeDesc,
      maxEntries: round ? Math.max(1, Number(round.maxEntries) || 1) : cfg.maxEntries,
      verifiedCount: entryCount(round),
      pendingCount: pendingCount(round),
      opensAt: round ? round.opensAt : null,
      closesAt: round ? round.closesAt : null,
      rulesVersion: cfg.rulesVersion,
      noticeVersion: cfg.noticeVersion,
      acceptsEntries: false,
      reason: round ? capacityVerdict(round, nowMs).reason : 'no_round',
      winnerAnnounced: !!(round && round.draw && round.draw.winnerRef)
    };
    var cap = round ? capacityVerdict(round, nowMs) : { ok: false };
    view.acceptsEntries = !!cap.ok;
    if (!cap.ok && cap.reason) view.reason = cap.reason;
    return view;
  }

  /* Masked admin rows: reference + when, never the raw address. */
  function reportEntries(round) {
    return (round.entries || []).map(function (e) {
      return {
        ref: e.ref,
        emailMasked: e.emailMasked,
        verifiedAt: e.verifiedAt,
        noticeVersion: e.noticeVersion,
        source: e.source || '',
        marketingOptIn: !!e.marketingOptIn
      };
    });
  }

  /* ---- Suspicion flags (admin only) --------------------------------------------
     Duplicates are IMPOSSIBLE by construction (e-mail hash is the identity),
     so what this finds is the shapes worth an eyeball before a draw: one IP
     behind many entries, or a burst inside the same second. */
  function suspicionFlags(round) {
    var flags = [];
    var byIp = {};
    (round.entries || []).forEach(function (e) {
      if (e.ipHash) byIp[e.ipHash] = byIp[e.ipHash] || [];
      if (e.ipHash) byIp[e.ipHash].push(e);
    });
    Object.keys(byIp).forEach(function (ip) {
      if (byIp[ip].length > 2) {
        flags.push({
          kind: 'shared_ip',
          count: byIp[ip].length,
          refs: byIp[ip].map(function (e) { return e.ref; })
        });
      }
    });
    var bySecond = {};
    (round.entries || []).forEach(function (e) {
      var k = String(e.verifiedAt || '').slice(0, 19);
      bySecond[k] = bySecond[k] || [];
      bySecond[k].push(e);
    });
    Object.keys(bySecond).forEach(function (k) {
      if (bySecond[k].length > 5) {
        flags.push({
          kind: 'burst',
          count: bySecond[k].length,
          second: k,
          refs: bySecond[k].map(function (e) { return e.ref; })
        });
      }
    });
    return flags;
  }

  /* ---- Rate limiting -------------------------------------------------------------
     In-memory, per process (a restart clears the counters — documented in the
     security review as a known limitation; the verification token is the real
     gate). Returns ok:false with retryAfterMs so the caller can send 429. */
  function rateCheck(hits, key, nowMs, windowMs, max) {
    var arr = hits[key] || [];
    arr = arr.filter(function (t) { return nowMs - t < windowMs; });
    if (arr.length >= max) {
      hits[key] = arr;
      return { ok: false, retryAfterMs: windowMs - (nowMs - arr[0]) };
    }
    arr.push(nowMs);
    hits[key] = arr;
    return { ok: true };
  }

  return {
    DEFAULTS: DEFAULTS,
    STATUS: STATUS,
    TRANSITIONS: TRANSITIONS,
    STATUS_LABEL: STATUS_LABEL,
    sanitizeGiveawayConfig: sanitizeGiveawayConfig,
    nextStatuses: nextStatuses,
    canTransition: canTransition,
    statusLabel: statusLabel,
    entryCount: entryCount,
    pendingCount: pendingCount,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    maskEmail: maskEmail,
    randomBytesHex: randomBytesHex,
    sha256Hex: sha256Hex,
    newToken: newToken,
    hashToken: hashToken,
    newEntryRef: newEntryRef,
    isValidEntryRef: isValidEntryRef,
    REASONS: REASONS,
    reasonText: reasonText,
    capacityVerdict: capacityVerdict,
    currentRound: currentRound,
    registerVerdict: registerVerdict,
    roundDuplicate: roundDuplicate,
    findPendingByToken: findPendingByToken,
    verifyVerdict: verifyVerdict,
    drawVerdict: drawVerdict,
    pickIndex: pickIndex,
    drawRecord: drawRecord,
    issueVerdict: issueVerdict,
    publicRound: publicRound,
    reportEntries: reportEntries,
    suspicionFlags: suspicionFlags,
    rateCheck: rateCheck
  };
});
