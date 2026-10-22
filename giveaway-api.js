/* ==========================================================================
   KPOT EXPRESS — LUCKY 66 · API handlers
   --------------------------------------------------------------------------
   Thin HTTP shell over the pure rules (assets/giveaway.js), the store
   (giveaway-store.js) and the mail adapter (giveaway-mail.js). Everything
   that touches a file or a socket sits here; nothing that decides a rule
   does.

   The feature is FLAGGED OFF by default. config.giveaway.enabled must be
   true for any public endpoint or the draw; the store-local runtime switch
   and the KPOT_GIVEAWAY_ENABLED test seam are the two overrides.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const GW = require('./assets/giveaway.js');
const STORE = require('./giveaway-store.js');
const MAILGW = require('./giveaway-mail.js');

/* ---- Config & the production gate ---------------------------------------------
   Order of authority (highest first):
     1. KPOT_GIVEAWAY_ENABLED — test seam, logged, never set in production
     2. store.local.json giveaway.enabled — the owner's runtime switch
     3. config.js giveaway.enabled — the shipped default (false)            */
let GATE_WARNED = false;
function giveawayEnabled(st) {
  if (process.env.KPOT_GIVEAWAY_ENABLED === '1' || process.env.KPOT_GIVEAWAY_ENABLED === '0') {
    if (!GATE_WARNED) {
      console.warn('[kpot] WARNING: giveaway enabled=' + (process.env.KPOT_GIVEAWAY_ENABLED === '1') +
        ' via KPOT_GIVEAWAY_ENABLED — tests only, never set this in production.');
      GATE_WARNED = true;
    }
    return process.env.KPOT_GIVEAWAY_ENABLED === '1';
  }
  if (st && st.giveaway && typeof st.giveaway.enabled === 'boolean') return st.giveaway.enabled;
  const cfg = (context().ASSETS.CONFIG || {}).giveaway || {};
  return cfg.enabled === true;
}

let CTX = null;
function context() { return CTX || { ASSETS: { CONFIG: {} } }; }

function cfg() {
  return GW.sanitizeGiveawayConfig((context().ASSETS.CONFIG || {}).giveaway || {});
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
    .split(',')[0].trim();
}

/* ---- Rate limits (per process — see the security review) -----------------------
   Per-EMAIL is the meaningful gate (it stops mail-bombing one address). The
   per-IP ceilings are deliberately loose because a restaurant's guests share
   one public IP behind the shop wifi / carrier NAT — a tight per-IP limit
   would lock out real customers, and a bot's real cost is the verification
   step, not the form. IP is taken from the proxy header when present, same
   convention as the existing throttle in server.js. */
const regHits = {};      /* ip  -> [ts] */
const emailHits = {};    /* email -> [ts] */
const verifyHits = {};   /* ip  -> [ts] */
const HOUR = 60 * 60 * 1000;
const REG_PER_IP = 50;   /* registrations per IP per hour */
const REG_PER_EMAIL = 5; /* registrations + resends per address per hour */
const VERIFY_PER_IP = 60;/* verification attempts per IP per hour */
function ipHash(req) { return GW.sha256Hex(clientIp(req)).slice(0, 16); }

function tooMany(store, key, now, windowMs, max) {
  const v = GW.rateCheck(store, key, now, windowMs, max);
  return !v.ok;
}

/* ---- Router entry ---------------------------------------------------------------
   server.js calls this for anything under /api/giveaway (before the generic
   404), and passes its own primitives so this module stays free of them. */
async function handle(req, res, pathname, url, ctx) {
  CTX = ctx || {};
  const P = context();
  const send = P.sendJSON, readBody = P.readBody, adminAuthorized = P.adminAuthorized;
  const baseUrl = P.requestBaseUrl ? P.requestBaseUrl(req) : '';

  const st = P.getStoreStatus ? P.getStoreStatus() : {};
  const enabled = giveawayEnabled(st);
  const C = cfg();

  /* ================= public ================= */
  if (pathname === '/api/giveaway/status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
    if (!enabled) {
      return send(res, 200, { ok: true, enabled: false });
    }
    const store = STORE.load();
    const round = GW.currentRound(store.rounds, Date.now());
    return send(res, 200, {
      ok: true,
      enabled: true,
      round: GW.publicRound(round, Date.now(), C),
      mail: MAILGW.status().transport
    });
  }

  if (pathname === '/api/giveaway/register') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!enabled) return send(res, 404, { ok: false, reason: 'disabled' });
    const ip = clientIp(req);
    if (tooMany(regHits, ip, Date.now(), HOUR, REG_PER_IP)) {
      return send(res, 429, { ok: false, reason: 'rate_limited', message: GW.reasonText('rate_limited') });
    }
    let body;
    try { body = JSON.parse(await readBody(req, 2048) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const email = GW.normalizeEmail(body.email);
    if (tooMany(emailHits, email, Date.now(), HOUR, REG_PER_EMAIL)) {
      return send(res, 429, { ok: false, reason: 'rate_limited', message: GW.reasonText('rate_limited') });
    }

    const store = STORE.load();
    const round = GW.currentRound(store.rounds, Date.now());
    const verdict = GW.registerVerdict(round, Object.assign({}, body, { email: email }), C);
    if (!verdict.ok) {
      return send(res, verdict.reason === 'full' ? 409 : 400, {
        ok: false, reason: verdict.reason, message: GW.reasonText(verdict.reason)
      });
    }

    const token = GW.newToken();
    const person = STORE.upsertPerson(store, email);
    const now = new Date();
    round.pending.push({
      id: 'P' + now.getTime().toString(36),
      emailHash: GW.sha256Hex(email),
      tokenHash: GW.hashToken(token),
      sentAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + C.verifyHours * 3600 * 1000).toISOString(),
      marketingOptIn: body.marketingOptIn === true,
      noticeVersion: C.noticeVersion,
      source: String(body.source || 'lucky66').slice(0, 40),
      ipHash: ipHash(req)
    });
    STORE.save(store);

    const link = baseUrl + C.pagePath + '?verify=' + token;
    const m = await MAILGW.send('verify', {
      to: email,
      link: link,
      verifyHours: C.verifyHours,
      prizeDesc: C.prizeDesc,
      storeName: ((context().ASSETS.CONFIG || {}).store || {}).name || 'KPOT EXPRESS',
      storeAddress: ((context().ASSETS.CONFIG || {}).store || {}).address || '',
      rulesUrl: baseUrl + '/giveaway-rules.html'
    });
    return send(res, 200, {
      ok: true,
      message: 'Check your inbox to confirm your entry.',
      mail: m.ok ? 'sent' : 'failed'
    });
  }

  if (pathname === '/api/giveaway/resend') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!enabled) return send(res, 404, { ok: false, reason: 'disabled' });
    let body;
    try { body = JSON.parse(await readBody(req, 2048) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const email = GW.normalizeEmail(body.email);
    if (!GW.isValidEmail(email)) return send(res, 400, { ok: false, reason: 'bad_email', message: GW.reasonText('bad_email') });
    if (tooMany(emailHits, email, Date.now(), HOUR, REG_PER_EMAIL)) {
      return send(res, 429, { ok: false, reason: 'rate_limited', message: GW.reasonText('rate_limited') });
    }

    const store = STORE.load();
    const round = GW.currentRound(store.rounds, Date.now());
    const hash = GW.sha256Hex(email);
    const dup = round ? GW.roundDuplicate(round, hash) : null;
    if (dup === 'already_entered') {
      return send(res, 200, { ok: true, message: 'That address is already entered in this round.' });
    }
    const pending = round ? (round.pending || []).find(function (p) { return p.emailHash === hash; }) : null;
    if (!pending) {
      /* Nothing pending — treat as a fresh registration so the flow is the
         same one button. If the round filled meanwhile, registerVerdict says so. */
      const verdict = GW.registerVerdict(round, {
        email: email, eligibilityAck: true, rulesVersion: C.rulesVersion
      }, C);
      if (!verdict.ok) {
        return send(res, verdict.reason === 'full' ? 409 : 400, {
          ok: false, reason: verdict.reason, message: GW.reasonText(verdict.reason)
        });
      }
    }

    const token = GW.newToken();
    const now = new Date();
    if (pending) {
      pending.tokenHash = GW.hashToken(token);
      pending.sentAt = now.toISOString();
      pending.expiresAt = new Date(now.getTime() + C.verifyHours * 3600 * 1000).toISOString();
    } else {
      round.pending.push({
        id: 'P' + now.getTime().toString(36),
        emailHash: hash,
        tokenHash: GW.hashToken(token),
        sentAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + C.verifyHours * 3600 * 1000).toISOString(),
        marketingOptIn: body.marketingOptIn === true,
        noticeVersion: C.noticeVersion,
        source: String(body.source || 'lucky66').slice(0, 40),
        ipHash: ipHash(req)
      });
      STORE.upsertPerson(store, email);
    }
    STORE.save(store);

    const link = baseUrl + C.pagePath + '?verify=' + token;
    const m = await MAILGW.send('verify', {
      to: email, link: link, verifyHours: C.verifyHours, prizeDesc: C.prizeDesc,
      storeName: ((context().ASSETS.CONFIG || {}).store || {}).name || 'KPOT EXPRESS',
      storeAddress: ((context().ASSETS.CONFIG || {}).store || {}).address || '',
      rulesUrl: baseUrl + '/giveaway-rules.html'
    });
    return send(res, 200, {
      ok: true,
      message: 'If that address can enter, a new confirmation link is on its way.',
      mail: m.ok ? 'sent' : 'failed'
    });
  }

  if (pathname === '/api/giveaway/verify') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
    if (!enabled) return send(res, 404, { ok: false, reason: 'disabled' });
    const ip = clientIp(req);
    if (tooMany(verifyHits, ip, Date.now(), HOUR, VERIFY_PER_IP)) {
      return send(res, 429, { ok: false, reason: 'rate_limited', message: GW.reasonText('rate_limited') });
    }
    const token = String(url.searchParams.get('token') || '');
    if (!token || token.length < 20) {
      return send(res, 400, { ok: false, reason: 'invalid_token', message: GW.reasonText('invalid_token') });
    }

    const store = STORE.load();
    let round = null, hit = null;
    for (const r of store.rounds) {
      if (r.status !== GW.STATUS.OPEN && r.status !== GW.STATUS.PAUSED) continue;
      hit = GW.findPendingByToken(r, token);
      if (hit) { round = r; break; }
    }
    const verdict = GW.verifyVerdict(round, token, Date.now());
    if (!verdict.ok) {
      return send(res, verdict.reason === 'full' ? 409 : 400, {
        ok: false, reason: verdict.reason, message: GW.reasonText(verdict.reason)
      });
    }

    const now = new Date();
    const email = (store.people[hit.pending.emailHash] || {}).email || '';
    const ref = STORE.uniqueRef(store);
    round.pending.splice(hit.index, 1);          /* single use */
    round.entries.push({
      id: 'E' + now.getTime().toString(36) + '-' + ref.slice(-4),
      ref: ref,
      emailHash: hit.pending.emailHash,
      emailMasked: GW.maskEmail(email),
      verifiedAt: now.toISOString(),
      marketingOptIn: hit.pending.marketingOptIn === true,
      noticeVersion: hit.pending.noticeVersion,
      source: hit.pending.source || 'lucky66',
      ipHash: hit.pending.ipHash || ''
    });
    if (hit.pending.marketingOptIn === true) {
      const uToken = GW.newToken();
      store.consents[hit.pending.emailHash] = {
        marketingOptIn: true,
        noticeVersion: hit.pending.noticeVersion,
        source: hit.pending.source || 'lucky66',
        at: now.toISOString(),
        unsubTokenHash: GW.hashToken(uToken),
        unsubscribedAt: null
      };
    }
    STORE.save(store);

    const m = await MAILGW.send('entered', {
      to: email, ref: ref, prizeDesc: C.prizeDesc, closesAt: round.closesAt || '',
      storeName: ((context().ASSETS.CONFIG || {}).store || {}).name || 'KPOT EXPRESS',
      storeAddress: ((context().ASSETS.CONFIG || {}).store || {}).address || '',
      rulesUrl: baseUrl + '/giveaway-rules.html'
    });
    return send(res, 200, {
      ok: true,
      ref: ref,
      verifiedCount: GW.entryCount(round),
      maxEntries: Math.max(1, Number(round.maxEntries) || 1),
      mail: m.ok ? 'sent' : 'failed'
    });
  }

  if (pathname === '/api/giveaway/unsubscribe') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    let body;
    try { body = JSON.parse(await readBody(req, 2048) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const token = String(body.token || '');
    const store = STORE.load();
    const h = GW.hashToken(token);
    let found = null;
    for (const k of Object.keys(store.consents || {})) {
      if (store.consents[k].unsubTokenHash === h) { found = k; break; }
    }
    if (!found) return send(res, 400, { ok: false, reason: 'invalid_token' });
    if (store.consents[found].unsubscribedAt) {
      return send(res, 200, { ok: true, already: true, message: 'That address is already unsubscribed.' });
    }
    store.consents[found].unsubscribedAt = new Date().toISOString();
    STORE.save(store);
    return send(res, 200, { ok: true, message: 'You have been unsubscribed from KPOT EXPRESS marketing e-mail.' });
  }

  /* ================= admin ================= */
  if (pathname.indexOf('/api/giveaway/admin/') === 0) {
    if (!adminAuthorized(req)) return send(res, 401, { ok: false, reason: 'unauthorized' });
    const rest = pathname.slice('/api/giveaway/admin'.length);
    return adminRoute(rest, req, res, url, {
      send: send, readBody: readBody, enabled: enabled, C: C, baseUrl: baseUrl,
      /* the store-credit ledger — prize issuance must create a real balance */
      credits: P.credits
    });
  }

  return send(res, 404, { ok: false, reason: 'not_found' });
}

/* ---- Admin routes ----------------------------------------------------------------
   adminAuthorized() already ran. Creation and lifecycle transitions work
   while the public gate is OFF (that is how a round gets prepared); DRAW and
   PRIZE ISSUANCE additionally require the gate ON, because those two are the
   production actions the owner has to explicitly enable. */
async function adminRoute(rest, req, res, url, ctx) {
  const send = ctx.send, readBody = ctx.readBody, C = ctx.C;
  const parts = rest.split('/').filter(Boolean);   /* ['rounds', id, action?] */
  const store = STORE.load();
  const by = 'admin';

  function audit(round, action, note) {
    round.audit.push({ at: new Date().toISOString(), action: action, by: by, note: note || '' });
  }
  function findRound(id) {
    return (store.rounds || []).find(function (r) { return r.id === id; }) || null;
  }

  /* GET /admin/rounds */
  if (parts.length === 1 && parts[0] === 'rounds' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      mail: MAILGW.status().transport,
      rounds: store.rounds.map(function (r) {
        return {
          id: r.id,
          status: r.status,
          maxEntries: r.maxEntries,
          verifiedCount: GW.entryCount(r),
          pendingCount: GW.pendingCount(r),
          opensAt: r.opensAt,
          closesAt: r.closesAt,
          prize: r.prize,
          winnerRef: r.draw ? r.draw.winnerRef : null,
          prizeIssued: !!(r.prizeIssue && !r.prizeIssue.revokedAt),
          redeemedAt: r.prizeRedeem ? r.prizeRedeem.redeemedAt : null
        };
      })
    });
  }

  /* POST /admin/rounds — create DRAFT (or OPEN immediately with openNow) */
  if (parts.length === 1 && parts[0] === 'rounds' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const opensAt = Date.parse(body.opensAt || '');
    const closesAt = Date.parse(body.closesAt || '');
    if (!opensAt || !closesAt || closesAt <= opensAt) {
      return send(res, 400, { ok: false, reason: 'bad_dates', message: 'Opening and closing must both be set, closing after opening.' });
    }
    const maxEntries = Number(body.maxEntries);
    const prizeValue = Number(body.prizeValue);
    const round = {
      id: STORE.nextRoundId(store),
      status: GW.STATUS.DRAFT,
      prize: {
        value: isFinite(prizeValue) && prizeValue > 0 ? prizeValue : C.prizeValue,
        currency: 'USD',
        desc: String(body.prizeDesc || C.prizeDesc)
      },
      maxEntries: isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : C.maxEntries,
      opensAt: new Date(opensAt).toISOString(),
      closesAt: new Date(closesAt).toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: by,
      entries: [], pending: [],
      draw: null, prizeIssue: null, prizeRedeem: null,
      audit: []
    };
    store.rounds.push(round);
    audit(round, 'created', 'max=' + round.maxEntries);
    if (body.openNow === true && GW.canTransition(round.status, GW.STATUS.OPEN)) {
      round.status = GW.STATUS.OPEN;
      audit(round, 'transition', 'DRAFT -> OPEN');
    }
    STORE.save(store);
    return send(res, 200, { ok: true, round: roundSummary(round) });
  }

  /* GET /admin/consents — masked marketing ledger, never raw addresses */
  if (parts.length === 1 && parts[0] === 'consents' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      consents: Object.keys(store.consents || {}).map(function (k) {
        const c = store.consents[k];
        const p = store.people[k] || {};
        return {
          emailMasked: GW.maskEmail(p.email || ''),
          marketingOptIn: c.marketingOptIn,
          unsubscribedAt: c.unsubscribedAt,
          noticeVersion: c.noticeVersion,
          source: c.source,
          at: c.at
        };
      })
    });
  }

  if (parts[0] !== 'rounds' || !parts[1]) return send(res, 404, { ok: false, reason: 'not_found' });
  const round = findRound(decodeURIComponent(parts[1]));
  if (!round) return send(res, 404, { ok: false, reason: 'no_round' });
  const action = parts[2] || '';

  /* GET /admin/rounds/:id — detail, masked, with suspicion flags */
  if (!action && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      round: Object.assign(roundSummary(round), {
        entries: GW.reportEntries(round),
        pending: (round.pending || []).map(function (p) {
          const person = store.people[p.emailHash] || {};
          return {
            id: p.id, emailMasked: GW.maskEmail(person.email || ''), sentAt: p.sentAt,
            expiresAt: p.expiresAt, source: p.source
          };
        }),
        audit: round.audit || [],
        draw: round.draw || null,
        prizeIssue: round.prizeIssue ? Object.assign({}, round.prizeIssue, { codePreview: prizeCodePreview(round) }) : null,
        prizeRedeem: round.prizeRedeem || null,
        suspicion: GW.suspicionFlags(round),
        nextStatuses: GW.nextStatuses(round.status)
      })
    });
  }

  /* POST /admin/rounds/:id/transition */
  if (action === 'transition' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const to = String(body.to || '').toUpperCase();
    if (!GW.canTransition(round.status, to)) {
      return send(res, 409, {
        ok: false, reason: 'bad_transition',
        message: round.status + ' cannot move to ' + to + '.',
        nextStatuses: GW.nextStatuses(round.status)
      });
    }
    audit(round, 'transition', round.status + ' -> ' + to + (body.note ? ' · ' + String(body.note).slice(0, 200) : ''));
    round.status = to;
    STORE.save(store);
    return send(res, 200, { ok: true, round: roundSummary(round) });
  }

  /* POST /admin/rounds/:id/draw — CSPRNG, frozen snapshot, idempotent */
  if (action === 'draw' && req.method === 'POST') {
    if (!ctx.enabled) {
      return send(res, 409, { ok: false, reason: 'disabled', message: 'Enable the giveaway before drawing.' });
    }
    const verdict = GW.drawVerdict(round);
    if (!verdict.ok) {
      const msg = verdict.reason === 'already_drawn'
        ? 'This round has already been drawn.'
        : verdict.reason === 'no_entries'
          ? 'There are no verified entries to draw from.'
          : 'A round can only be drawn after it is CLOSED.';
      return send(res, 409, { ok: false, reason: verdict.reason, draw: verdict.draw || null, message: msg });
    }
    const rec = GW.drawRecord(round, function (n) { return crypto.randomInt(n); }, { by: by });
    round.draw = rec;
    audit(round, 'drawn', rec.winnerRef + ' from ' + rec.entriesCount + ' entries (' + rec.algorithm + ')');
    if (GW.canTransition(round.status, GW.STATUS.DRAWN)) round.status = GW.STATUS.DRAWN;
    const winnerEmail = getPersonEmail(store, round, rec.winnerEntryId);
    STORE.save(store);

    const m = await MAILGW.send('winner', {
      to: winnerEmail || '', ref: rec.winnerRef, entriesCount: rec.entriesCount,
      prizeDesc: round.prize.desc,
      prizeNote: 'Reply to this e-mail (or call the shop) within 14 days to claim your prize with entry reference ' + rec.winnerRef + '.',
      storeName: ((context().ASSETS.CONFIG || {}).store || {}).name || 'KPOT EXPRESS',
      storeAddress: ((context().ASSETS.CONFIG || {}).store || {}).address || '',
      rulesUrl: ctx.baseUrl + '/giveaway-rules.html'
    });
    return send(res, 200, {
      ok: true,
      draw: { winnerRef: rec.winnerRef, entriesCount: rec.entriesCount, algorithm: rec.algorithm },
      mail: m.ok ? 'sent' : 'failed',
      round: roundSummary(round)
    });
  }

  /* POST /admin/rounds/:id/prize — one-shot issuance, audited */
  if (action === 'prize' && req.method === 'POST') {
    if (!ctx.enabled) {
      return send(res, 409, { ok: false, reason: 'disabled', message: 'Enable the giveaway before issuing a prize.' });
    }
    let body;
    try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    const verdict = GW.issueVerdict(round);
    if (!verdict.ok) {
      return send(res, 409, { ok: false, reason: verdict.reason, message: 'A prize has already been issued for this round.' });
    }
    /* The prize is a store-credit code, and the code is the credential: it must
       exist as a real, spendable balance in the ledger (credits.js), or the
       e-mail below would promise money the shop never created. No adapter = no
       issuance — fail closed rather than send a dead code. */
    const CRED = ctx.credits;
    if (!CRED) {
      return send(res, 500, { ok: false, reason: 'credit_unavailable', message: 'The store-credit ledger is unavailable; nothing was issued.' });
    }
    const prizeValue = Number(round.prize && round.prize.value) || 0;
    if (!isFinite(prizeValue) || prizeValue <= 0) {
      return send(res, 409, { ok: false, reason: 'bad_value', message: 'This round has no prize value configured.' });
    }
    /* Admin may paste a code they chose, or leave it blank and get a strong one. */
    let code = CRED.normalizeCode(body.code);
    if (!code) code = CRED.generateCode();
    if (!CRED.isValidCode(code)) {
      return send(res, 400, { ok: false, reason: 'bad_code', message: 'Enter the store-credit code (' + CRED.minLength + '+ characters), or leave it blank to generate one.' });
    }
    const issued = CRED.issue(code, prizeValue, {
      roundId: round.id,
      note: String(body.note || '').slice(0, 200)
    });
    if (!issued.ok) {
      return send(res, 409, {
        ok: false, reason: 'credit_' + issued.reason,
        message: issued.reason === 'duplicate'
          ? 'That code is already in the credit ledger — pick another one.'
          : 'Could not create the store-credit entry (' + issued.reason + ').'
      });
    }
    const winnerEmail = getPersonEmail(store, round, round.draw.winnerEntryId);
    round.prizeIssue = {
      issuedAt: new Date().toISOString(),
      by: by,
      codeRef: issued.entry.codeRef,        /* never the full code in the store */
      creditHash: issued.entry.codeHash,    /* the ledger entry, addressed */
      creditValue: issued.entry.value,
      note: String(body.note || '').slice(0, 200),
      revokedAt: null
    };
    audit(round, 'prize_issued', 'code ' + round.prizeIssue.codeRef + ' ($' + prizeValue.toFixed(2) + ' store credit)');
    if (GW.canTransition(round.status, GW.STATUS.PRIZE_ISSUED)) round.status = GW.STATUS.PRIZE_ISSUED;
    STORE.save(store);

    const m = await MAILGW.send('winner', {
      to: winnerEmail || '', ref: round.draw.winnerRef,
      prizeDesc: round.prize.desc,
      prizeNote: 'Your ' + round.prize.desc + ' code: ' + code + '\r\n\r\nKeep this e-mail — it is your prize. Terms: ' + (ctx.baseUrl + '/giveaway-rules.html'),
      storeName: ((context().ASSETS.CONFIG || {}).store || {}).name || 'KPOT EXPRESS',
      storeAddress: ((context().ASSETS.CONFIG || {}).store || {}).address || '',
      rulesUrl: ctx.baseUrl + '/giveaway-rules.html'
    });
    return send(res, 200, { ok: true, round: roundSummary(round), mail: m.ok ? 'sent' : 'failed' });
  }

  /* POST /admin/rounds/:id/redeem — record the redemption, keep the balance */
  if (action === 'redeem' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) {
      return send(res, 400, { ok: false, reason: 'bad_request' });
    }
    if (!round.prizeIssue || round.prizeIssue.revokedAt) {
      return send(res, 409, { ok: false, reason: 'not_issued', message: 'Nothing has been issued to redeem yet.' });
    }
    if (round.prizeRedeem) {
      return send(res, 409, { ok: false, reason: 'already_redeemed', message: 'This prize is already marked redeemed.' });
    }
    /* The balance can be typed by hand (the owner may have spent it across
       several orders) or read straight off the ledger when the code is pasted
       in — the ledger is the authority, so prefer it when both are given. */
    let bal = Number(body.balanceAfter);
    const CRED = ctx.credits;
    if (CRED && body.code && (!isFinite(bal) || bal < 0)) {
      const v = CRED.balanceOf(String(body.code));
      if (v.ok) bal = v.balance;
    }
    round.prizeRedeem = {
      redeemedAt: new Date().toISOString(),
      by: by,
      balanceAfter: isFinite(bal) && bal >= 0 ? bal : null,
      note: String(body.note || '').slice(0, 200)
    };
    audit(round, 'redeemed', round.prizeRedeem.note || '');
    if (GW.canTransition(round.status, GW.STATUS.COMPLETED)) round.status = GW.STATUS.COMPLETED;
    STORE.save(store);
    return send(res, 200, { ok: true, round: roundSummary(round) });
  }

  /* GET /admin/rounds/:id/export — masked, access-controlled */
  if (action === 'export' && req.method === 'GET') {
    const fmt = String(url.searchParams.get('format') || 'json');
    const rows = GW.reportEntries(round);
    audit(round, 'exported', fmt);
    STORE.save(store);
    if (fmt === 'csv') {
      const csv = ['ref,email_masked,verified_at,notice_version,marketing_opt_in']
        .concat(rows.map(function (r) {
          return [r.ref, r.emailMasked, r.verifiedAt, r.noticeVersion, r.marketingOptIn ? 'yes' : 'no'].join(',');
        })).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + round.id + '-entries.csv"'
      });
      return res.end(csv);
    }
    return send(res, 200, { ok: true, round: round.id, count: rows.length, entries: rows, draw: round.draw || null });
  }

  return send(res, 404, { ok: false, reason: 'not_found' });
}

function roundSummary(r) {
  return {
    id: r.id, status: r.status, statusLabel: GW.statusLabel(r.status),
    maxEntries: r.maxEntries, verifiedCount: GW.entryCount(r), pendingCount: GW.pendingCount(r),
    opensAt: r.opensAt, closesAt: r.closesAt, prize: r.prize,
    winnerRef: r.draw ? r.draw.winnerRef : null,
    prizeIssued: !!(r.prizeIssue && !r.prizeIssue.revokedAt),
    redeemedAt: r.prizeRedeem ? r.prizeRedeem.redeemedAt : null,
    nextStatuses: GW.nextStatuses(r.status)
  };
}
function prizeCodePreview(round) {
  return round.prizeIssue ? round.prizeIssue.codeRef : null;
}
function getPersonEmail(store, round, entryId) {
  const e = (round.entries || []).find(function (x) { return x.id === entryId; });
  return e && store.people[e.emailHash] ? store.people[e.emailHash].email : '';
}

module.exports = { handle };
