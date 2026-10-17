/* ==========================================================================
   KPOT To Go — mailer
   --------------------------------------------------------------------------
   Sends one thing: a six-digit account-recovery code.

   WHY THIS IS HAND-ROLLED
   The project has no dependencies on purpose (package.json declares none, and
   Stripe is called with the global fetch() rather than the SDK). Nodemailer
   would be the obvious choice and would also be the only third-party package
   in the tree — a supply-chain surface on the machine that holds the orders
   and the member ledger, for one e-mail a week. So: a small SMTP client over
   Node's own net/tls. It does EHLO, STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA and
   nothing else.

   CONFIGURATION (environment only — never a file in the repo)
     GMAIL_USER            the Gmail address that sends the codes
     GMAIL_APP_PASSWORD    a Google *app password* (16 chars, not the login
                           password — Google refuses the login password to
                           SMTP, and app passwords need 2FA switched on)
     KPOT_MAIL_FROM        optional From: override, defaults to GMAIL_USER
     KPOT_SMTP_HOST/PORT   test seam. Defaults smtp.gmail.com:465. A test run
                           points these at a local fake server so the suite
                           never talks to Google.
     KPOT_SMTP_PLAIN       test seam, DANGEROUS. "1" drops TLS entirely so the
                           suite can talk to a throwaway server on localhost.
                           AUTH LOGIN would then put the app password on the
                           wire in clear, so the server shouts about it at
                           boot — exactly like KPOT_STRIPE_API_BASE. Never set
                           it anywhere a real mailbox is involved.

   If it is not configured the server still runs: the recovery flow says so
   out loud and the guest is told to ask at the counter. A hard failure at
   boot would take the whole ordering site down over a feature nobody is
   using at that moment.

   Port 465 is implicit TLS; anything else (587, 25) is plain + STARTTLS.
   Oracle Cloud blocks outbound 25 but not 587, so 587 is a valid fallback if
   465 ever stops answering.
   ========================================================================== */

'use strict';

const net = require('net');
const tls = require('tls');
const { once } = require('events');

const TIMEOUT_MS = 15000;

function loadSecrets() {
  const file = process.env.KPOT_SECRETS_FILE || require('path').join(__dirname, 'secrets.local.json');
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8')) || {};
  } catch (e) { return {}; }
}
function config() {
  const sec = loadSecrets();
  const port = Number(process.env.KPOT_SMTP_PORT || sec.smtpPort || 465) || 465;
  const user = String(process.env.GMAIL_USER || sec.gmailUser || '').trim();
  const plain = String(process.env.KPOT_SMTP_PLAIN || '') === '1';
  const passRaw = process.env.GMAIL_APP_PASSWORD || sec.gmailAppPassword || '';
  return {
    host: String(process.env.KPOT_SMTP_HOST || sec.smtpHost || 'smtp.gmail.com').trim(),
    port,
    /* Google shows app passwords in four groups of four; strip the spaces so
       a copy-paste out of the account page works. */
    user,
    pass: String(passRaw).replace(/\s+/g, ''),
    from: String(process.env.KPOT_MAIL_FROM || sec.mailFrom || user).trim(),
    plain,
    implicitTls: !plain && port === 465
  };
}

function configured() {
  const c = config();
  return !!(c.user && c.pass && c.from);
}

/* Safe to log or show in the console: never the password, and the address is
   reduced to its first character. */
function status() {
  const c = config();
  return {
    configured: configured(),
    host: c.host,
    port: c.port,
    tls: c.plain ? 'PLAIN (test only)' : (c.implicitTls ? 'implicit' : 'starttls'),
    plain: c.plain,
    user: c.user ? c.user.charAt(0) + '***' + (c.user.indexOf('@') >= 0 ? c.user.slice(c.user.indexOf('@')) : '') : '',
    from: c.from
  };
}

/* -------------------------------------------------------------------------- */
/* A very small SMTP conversation                                              */
/* -------------------------------------------------------------------------- */

/* Read one complete reply. SMTP replies are one or more lines; the last line
   has a space after the code ("250 OK") and the continuation lines have a
   hyphen ("250-SIZE 35882577"), so we keep reading until we see the space.

   This function owns `st.buf` exclusively — it is the only thing that appends
   to it. A second 'data' listener appending the same chunk was how the
   greeting got read twice and the EHLO reply came back as a stray "220". */
async function readReply(sock, st) {
  const lines = [];
  for (;;) {
    const idx = st.buf.indexOf('\r\n');
    if (idx < 0) {
      const [chunk] = await once(sock, 'data');
      st.buf += chunk.toString('utf8');
      continue;
    }
    const line = st.buf.slice(0, idx);
    st.buf = st.buf.slice(idx + 2);
    lines.push(line);
    const m = /^(\d{3})([ -])/.exec(line);
    if (m && m[2] === ' ') return { code: Number(m[1]), text: lines.join('\n') };
    /* A line that is not a reply at all — bail rather than spin forever. */
    if (!m) return { code: 0, text: lines.join('\n') };
  }
}

async function cmd(sock, st, line, want) {
  sock.write(line + '\r\n');
  const r = await readReply(sock, st);
  if (want && !want.includes(r.code)) {
    const e = new Error('SMTP ' + r.code + ' after "' + line.split(' ')[0] + '": ' + r.text);
    e.smtpCode = r.code;
    throw e;
  }
  return r;
}

function encodeHeaderValue(v) {
  const s = String(v == null ? '' : v);
  /* Anything outside ASCII has to be an RFC 2047 encoded word or Gmail will
     mangle it — and the store's own name has no business being mangled. */
  return /^[\x20-\x7e]*$/.test(s) ? s
    : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

/* RFC 5322 wants CRLF everywhere, and a line that starts with "." must be
   doubled or the server reads it as the end of the message. */
function toData(body) {
  const normalised = String(body == null ? '' : body).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return normalised.split('\r\n').map((l) => (l.charAt(0) === '.' ? '.' + l : l)).join('\r\n');
}

function buildMessage(cfg, to, subject, body) {
  const boundary = 'kpot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const headers = [
    'From: ' + encodeHeaderValue(cfg.from.indexOf('<') >= 0 ? cfg.from : 'KPOT To Go <' + cfg.from + '>'),
    'To: <' + to + '>',
    'Subject: ' + encodeHeaderValue(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + boundary + '@' + (cfg.host || 'kpot') + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated'
  ];
  return headers.join('\r\n') + '\r\n\r\n' + toData(body) + '\r\n';
}

async function openSocket(cfg) {
  const sock = cfg.implicitTls
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true })
    : net.connect({ host: cfg.host, port: cfg.port });
  sock.setTimeout(TIMEOUT_MS);
  sock.once('timeout', () => { sock.destroy(new Error('SMTP timeout after ' + TIMEOUT_MS + 'ms')); });
  await once(sock, cfg.implicitTls ? 'secureConnect' : 'connect');
  return sock;
}

/* Returns { ok:true } or { ok:false, error }. Never throws — a caller sending
   a recovery code must be able to tell the guest "we could not send that"
   rather than 500 into the void. */
async function send(opts) {
  const cfg = config();
  if (!configured()) return { ok: false, error: 'mail_not_configured' };

  const to = String((opts && opts.to) || '').trim();
  if (!to) return { ok: false, error: 'no_recipient' };

  let sock = null;
  const st = { buf: '' };
  try {
    sock = await openSocket(cfg);

    let r = await readReply(sock, st);
    if (r.code !== 220) throw new Error('bad greeting: ' + r.text);

    await cmd(sock, st, 'EHLO kpot.local', [250]);

    if (!cfg.implicitTls && !cfg.plain) {
      await cmd(sock, st, 'STARTTLS', [220]);
      const plain = sock;
      sock = tls.connect({ socket: plain, servername: cfg.host, rejectUnauthorized: true });
      sock.setTimeout(TIMEOUT_MS);
      sock.once('timeout', () => { sock.destroy(new Error('SMTP timeout after ' + TIMEOUT_MS + 'ms')); });
      await once(sock, 'secureConnect');
      st.buf = '';
      await cmd(sock, st, 'EHLO kpot.local', [250]);
    }

    await cmd(sock, st, 'AUTH LOGIN', [334]);
    await cmd(sock, st, Buffer.from(cfg.user, 'utf8').toString('base64'), [334]);
    await cmd(sock, st, Buffer.from(cfg.pass, 'utf8').toString('base64'), [235]);

    await cmd(sock, st, 'MAIL FROM:<' + cfg.from + '>', [250]);
    await cmd(sock, st, 'RCPT TO:<' + to + '>', [250, 251]);
    await cmd(sock, st, 'DATA', [354]);
    const message = buildMessage(cfg, to, (opts && opts.subject) || 'KPOT', (opts && opts.text) || '');
    sock.write(message + '\r\n.\r\n');
    r = await readReply(sock, st);
    if (r.code !== 250) throw new Error('message refused: ' + r.text);

    try { await cmd(sock, st, 'QUIT', [221]); } catch (e) { /* the mail is already accepted */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'smtp_failed' };
  } finally {
    try { if (sock) sock.destroy(); } catch (e) { /* already gone */ }
  }
}

/* The recovery code itself. Kept here so the wording lives with the transport
   and the server only has to say "send this guest a code". */
function recoveryMessage(code, storeName, minutes) {
  return {
    subject: 'Your ' + (storeName || 'KPOT To Go') + ' rewards code: ' + code,
    text: [
      'Your rewards code is ' + code + '.',
      '',
      'Type it in on the checkout screen within ' + (minutes || 10) + ' minutes and your',
      'points and rewards will be available on this phone.',
      '',
      'If you did not ask for this, you can ignore this message — the code',
      'expires on its own and nothing has changed on your account.',
      '',
      storeName || 'KPOT To Go'
    ].join('\r\n')
  };
}

module.exports = { config, configured, status, send, recoveryMessage, encodeHeaderValue, toData, buildMessage };
