/* ==========================================================================
   KPOT To Go — a throwaway SMTP server, for tests only
   --------------------------------------------------------------------------
   Accepts one conversation at a time and keeps every message it is handed, so
   a test can assert "a recovery code really was mailed to that address" and
   read the code back out without a Gmail account existing anywhere.

   Plain text, no TLS: pair it with KPOT_SMTP_PLAIN=1 (see mailer.js). It is
   only ever bound to 127.0.0.1 and only ever started by a test.

   Usable two ways:
     require('./fake_smtp.js')            → in-process, for a suite
     node _dev/fake_smtp.js 2525          → standalone, prints what arrives
   ========================================================================== */

'use strict';

const net = require('net');

function start(opts) {
  const messages = [];
  const sessions = [];
  const port = (opts && opts.port) || 0;

  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let data = '';
    let rcpt = '';
    let from = '';
    let authUser = '';
    let authState = '';

    const say = (line) => { sock.write(line + '\r\n'); };

    sock.on('error', () => {});
    say('220 fake.kpot.local ESMTP ready');

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ from, to: rcpt, data: data.replace(/\r\n\.\./g, '\r\n.'), raw: data });
            sessions.push({ from, to: rcpt });
            data = '';
            say('250 2.0.0 OK message accepted');
            continue;
          }
          data += line + '\r\n';
          continue;
        }

        const upper = line.toUpperCase();

        if (authState === 'user') { authUser = Buffer.from(line, 'base64').toString('utf8'); authState = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (authState === 'pass') { authState = ''; say('235 2.7.0 Accepted'); continue; }

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          say('250-fake.kpot.local');
          say('250-SIZE 35882577');
          say('250-8BITMIME');
          say('250 AUTH LOGIN PLAIN');
        } else if (upper.startsWith('AUTH LOGIN')) {
          authState = 'user';
          say('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM')) {
          from = line.slice(line.indexOf(':') + 1).trim();
          say('250 2.1.0 OK');
        } else if (upper.startsWith('RCPT TO')) {
          rcpt = line.slice(line.indexOf(':') + 1).trim().replace(/^<|>$/g, '');
          say('250 2.1.5 OK');
        } else if (upper === 'DATA') {
          inData = true;
          data = '';
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          say('221 2.0.0 Bye');
          sock.end();
        } else if (upper === 'RSET') {
          say('250 2.0.0 OK');
        } else {
          say('502 5.5.2 Command not recognised');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      resolve({
        port: bound,
        messages,
        sessions,
        /* Every 6-digit code seen, newest last — the shape a recovery mail
           always carries. */
        codes: () => messages.map((m) => (/(\d{6})/.exec(m.data) || [])[1]).filter(Boolean),
        lastCode: () => {
          const c = messages.map((m) => (/(\d{6})/.exec(m.data) || [])[1]).filter(Boolean);
          return c.length ? c[c.length - 1] : null;
        },
        reset: () => { messages.length = 0; sessions.length = 0; },
        close: () => new Promise((res) => { server.close(() => res()); })
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || 2525);
  start({ port }).then((s) => {
    console.log('[fake-smtp] listening on 127.0.0.1:' + s.port);
    const iv = setInterval(() => {
      if (s.messages.length) {
        const m = s.messages[s.messages.length - 1];
        console.log('[fake-smtp] to=' + m.to + ' code=' + s.lastCode());
        s.reset();
      }
    }, 500);
    iv.unref();
  }).catch((e) => { console.error(e); process.exit(1); });
}
