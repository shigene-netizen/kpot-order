#!/usr/bin/env node
/* ==========================================================================
   The Apple Pay domain-verification file, and only that file.

   WHY THIS EXISTS
   ---------------
   Apple Pay on the web is gated by Stripe on a verified domain: the domain
   must serve `/.well-known/apple-developer-merchantid-domain-association`.
   order.kpotexpress.com currently 404s it (checked 2026-10-22: Stripe's
   domain list holds only two unverified *.agentos-app.run entries), so the
   Apple Pay button cannot render on the shop even though the Dashboard
   toggle is on. This route is the shop's half of that fix; the owner's half
   is registering the domain in the Dashboard and dropping the file in.

   WHAT THIS PROVES
   ----------------
     1. with the file present, the exact path is served byte-for-byte with a
        text content type;
     2. with the file absent, the same path is 404 — the route never invents
        content and never leaks what the file would have been;
     3. every OTHER dot-path still 404s. The hidden-segment rule in
        serveStatic is a security boundary (it is what keeps secrets.local.json
        and .git unreachable); an exception for one filename must not become
        a hole for all of /.well-known;
     4. ordinary files are unaffected.

   Hermetic: the verification file is a scratch file, pinned with
   KPOT_APPLE_PAY_FILE — nothing here reads or writes the repo's own
   .well-known directory, and no shop data file is touched.

   Run:  node _dev/test_apple_pay_file.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-applepay-'));
const PORT = 8971;
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Stand-in for the file Stripe hands out: JSON, exactly as Stripe serves it. */
const FAKE_VERIFICATION = JSON.stringify({
  merchantIdentifier: 'merchant.com.stripe.test',
  domainName: 'order.kpotexpress.com',
  displayName: 'KPOT EXPRESS'
});
const PRESENT = path.join(SCRATCH, 'present', 'apple-developer-merchantid-domain-association');
const ABSENT = path.join(SCRATCH, 'absent', 'apple-developer-merchantid-domain-association');
fs.mkdirSync(path.dirname(PRESENT), { recursive: true });
fs.writeFileSync(PRESENT, FAKE_VERIFICATION);

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

function boot(applePayFile) {
  const dir = path.join(SCRATCH, 'data-' + path.basename(path.dirname(applePayFile)));
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      KPOT_APPLE_PAY_FILE: applePayFile,
      KPOT_ORDERS_FILE: path.join(dir, 'orders.local.json'),
      KPOT_CUSTOMERS_FILE: path.join(dir, 'customers.local.json'),
      /* The hours tick SAVES store status on every transition — unpinned, an
         evening run rewrites the shop's own switches. */
      KPOT_STORE_FILE: path.join(dir, 'store.local.json'),
      KPOT_PRINT_FILE: path.join(dir, 'print.local.json'),
      KPOT_SECRETS_FILE: path.join(dir, 'secrets.local.json'),
      KPOT_FLUSH_MS: '500',
      STRIPE_SECRET_KEY: 'sk_test_applepay_not_real',
      ADMIN_KEY: 'applepay-test-admin',
      PRINT_KEY: 'applepay-test-print'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc._log = '';
  proc.stdout.on('data', (d) => { proc._log += d.toString(); });
  proc.stderr.on('data', (d) => { proc._log += d.toString(); });
  return proc;
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

async function get(p) {
  const r = await fetch(BASE + p, { redirect: 'manual' });
  const t = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', body: t };
}

async function withServer(applePayFile, fn) {
  const proc = boot(applePayFile);
  try {
    if (!(await waitUp())) throw new Error('server never became healthy:\n' + proc._log);
    await fn();
  } finally {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

async function main() {
  console.log('Apple Pay domain-verification file');
  console.log('='.repeat(60));

  await withServer(PRESENT, async () => {
    const r = await get('/.well-known/apple-developer-merchantid-domain-association');
    check('the exact verification path is served when the file is present',
      r.status === 200, 'status=' + r.status);
    check('byte-for-byte, with no rewriting',
      r.body === FAKE_VERIFICATION, JSON.stringify(r.body.slice(0, 60)));
    check('as text, not a download',
      /^text\/plain/.test(r.type), r.type);

    /* Ordinary files must be untouched by the exception. */
    const home = await get('/');
    check('the menu page still serves normally alongside it',
      home.status === 200 && /</.test(home.body), 'status=' + home.status);
  });

  await withServer(ABSENT, async () => {
    const r = await get('/.well-known/apple-developer-merchantid-domain-association');
    check('the same path is 404 when the file is absent',
      r.status === 404 && r.body.indexOf('apple-developer') === -1,
      'status=' + r.status + ' body=' + JSON.stringify(r.body.slice(0, 40)));

    /* The exception must not open the rest of /.well-known. */
    for (const p of ['/.well-known/security.txt', '/.well-known/', '/.env', '/.git/config']) {
      const rr = await get(p);
      check('still 404: ' + p, rr.status === 404, 'status=' + rr.status);
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILURES: ' + fail); process.exit(1); }
  console.log('PASS — the verification route serves exactly one file, and nothing else (' + pass + ' checks)');
  process.exit(0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
