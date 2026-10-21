/* ==========================================================================
   KPOT EXPRESS — LUCKY 66 · transactional e-mail adapter
   --------------------------------------------------------------------------
   Three e-mails exist in this feature, all TRANSACTIONAL (they are the
   verification link, the entry confirmation and the prize notification —
   they are not marketing and are sent whether or not the entrant opted in):

       verify   "confirm your LUCKY 66 entry"   + single-use, 24h link
       entered  "you're in"                     + entry reference
       winner   "you won the $66 store-credit code" + claim instructions

   Transport, in order:
     1. the shop's existing SMTP mailer (mailer.js / Gmail app password),
        when it is configured;
     2. a LOCAL OUTBOX file otherwise — nothing is invented, nothing is
        sent, and the test suite reads the outbox to prove the link exists.

   KPOT_GIVEAWAY_OUTBOX forces the outbox regardless (test seam, logged like
   every other seam in this project). Marketing campaigns are NOT sent from
   here — consents are recorded, campaigns wait for legal sign-off.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const STORE_FILE = require('./giveaway-store.js').FILE;

let MAIL = null;
try { MAIL = require('./mailer.js'); } catch (e) { MAIL = null; }

const OUTBOX_FILE = process.env.KPOT_GIVEAWAY_OUTBOX ||
  path.join(path.dirname(STORE_FILE), 'giveaway-mail-outbox.jsonl');

if (process.env.KPOT_GIVEAWAY_OUTBOX) {
  console.warn('[kpot] WARNING: giveaway mail forced to the local outbox ' +
    OUTBOX_FILE + ' (KPOT_GIVEAWAY_OUTBOX) — tests only, never set this in production.');
}

function transport() {
  if (process.env.KPOT_GIVEAWAY_OUTBOX) return 'outbox';
  if (MAIL && MAIL.configured()) return 'smtp';
  return 'outbox';
}

function status() {
  return {
    transport: transport(),
    smtp: MAIL ? MAIL.status() : { configured: false },
    outbox: OUTBOX_FILE
  };
}

/* ---- Message bodies -----------------------------------------------------------
   Plain text only (the rest of the shop's mail is plain text too). The
   postal address and store name are facts; the sponsor's LEGAL name is a
   placeholder until legal review, and the Official Rules say so. */
function body(kind, p) {
  var store = p.storeName || 'KPOT EXPRESS';
  var addr = p.storeAddress || '';
  var head = '';
  if (kind === 'verify') {
    head = [
      'Confirm your LUCKY 66 entry',
      '',
      'Tap the link below to confirm this e-mail address and take your',
      'entry for the ' + p.prizeDesc + '.',
      '',
      p.link,
      '',
      'This link works once and expires in ' + (p.verifyHours || 24) + ' hours.',
      'If you did not request it, ignore this message — nothing was entered.',
      ''
    ].join('\r\n');
  } else if (kind === 'entered') {
    head = [
      "You're in — LUCKY 66 entry " + p.ref,
      '',
      'Your entry for the ' + p.prizeDesc + ' is confirmed.',
      'Your entry reference is ' + p.ref + ' (keep it — it is how you claim',
      'the prize if you win).',
      '',
      'The winner is drawn at random from all verified entries when the',
      'round closes' + (p.closesAt ? ' (' + p.closesAt + ')' : '') + '.',
      ''
    ].join('\r\n');
  } else if (kind === 'winner') {
    head = [
      'You won the ' + p.prizeDesc + '!',
      '',
      'Your entry reference ' + p.ref + ' was selected at random from ' +
        (p.entriesCount || '') + ' verified entries.',
      '',
      (p.prizeNote || 'The shop will follow up with your prize details.'),
      '',
      'Congratulations, and thank you for entering!',
      ''
    ].join('\r\n');
  }
  var foot = [
    store + (addr ? ' · ' + addr : ''),
    'Free to enter — no purchase necessary. Full terms: ' + (p.rulesUrl || ''),
    ''
  ].join('\r\n');
  var subject = kind === 'verify'
    ? 'Confirm your LUCKY 66 entry'
    : kind === 'entered'
      ? "You're in — LUCKY 66 entry " + (p.ref || '')
      : 'You won a ' + (p.prizeDesc || 'KPOT EXPRESS $66 store-credit code') + '!';
  return { subject: subject, text: head + foot };
}

/* Never throws. Returns { ok, via, error }. */
async function send(kind, p) {
  p = p || {};
  const msg = body(kind, p);
  const to = String(p.to || '').trim();
  if (!to) return { ok: false, via: transport(), error: 'no_recipient' };

  if (transport() === 'outbox') {
    try {
      const dir = path.dirname(OUTBOX_FILE);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(OUTBOX_FILE, JSON.stringify({
        at: new Date().toISOString(), kind: kind, to: to, subject: msg.subject, text: msg.text
      }) + '\n');
      return { ok: true, via: 'outbox' };
    } catch (e) {
      return { ok: false, via: 'outbox', error: e.message };
    }
  }

  if (!MAIL) return { ok: false, via: 'smtp', error: 'mailer_missing' };
  const r = await MAIL.send({ to: to, subject: msg.subject, text: msg.text });
  return { ok: !!r.ok, via: 'smtp', error: r.error || null };
}

module.exports = { send, status, body, OUTBOX_FILE };
