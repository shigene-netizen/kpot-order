#!/usr/bin/env node
/* ==========================================================================
   The print endpoints' auth boundary.

   Why this gets its own test: the print agent runs on a PC sitting in the
   restaurant, and it is the one credential in this system that lives on a
   machine nobody thinks about. The rules that matter are:

     * with a dedicated printKey configured, the agent must be able to fetch
       jobs — and must NOT be able to reach anything else, in particular not
       the owner's console endpoints;
     * the admin key must NEVER double as a print key, even when no dedicated
       print key is configured — otherwise rotating the print key is meaningless
       and a kitchen PC would effectively carry the console password;
     * when ADMIN_KEY is set but no printKey exists, the print endpoint is
       LOCKED (not open, not admin-gated) — the owner must set a dedicated key;
     * and with nothing configured at all, the endpoints are open — which is a
       dev convenience, so it is asserted explicitly rather than assumed.

   Each case boots the real server with its OWN secrets file (KPOT_SECRETS_FILE)
   so nothing here reads or depends on the shop's real keys.

   Run:  node _dev/test_print_auth.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-print-auth-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

/* Boot a server with exactly the keys we want, on a free port. */
async function bootServer(label, port, secrets, env) {
  const dir = path.join(SCRATCH, label);
  fs.mkdirSync(dir, { recursive: true });
  const secretsFile = path.join(dir, 'secrets.local.json');
  fs.writeFileSync(secretsFile, JSON.stringify(secrets));

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      KPOT_SECRETS_FILE: secretsFile,
      KPOT_ORDERS_FILE: path.join(dir, 'orders.local.json'),
      KPOT_CUSTOMERS_FILE: path.join(dir, 'customers.local.json'),
      KPOT_PRINT_FILE: path.join(dir, 'print.local.json'),
      KPOT_FLUSH_MS: '500',
      /* Never inherit a real key from the parent environment. */
      STRIPE_SECRET_KEY: 'sk_test_auth_not_a_real_key',
      PRINT_KEY: '',
      ADMIN_KEY: ''
    }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });

  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok && (await r.json()).ok) return { proc, base, log: () => log };
    } catch (e) {}
    await sleep(200);
  }
  proc.kill();
  throw new Error('server "' + label + '" never became healthy:\n' + log);
}

const status = (base, headers) => fetch(base + '/api/print/jobs', { headers: headers || {} })
  .then((r) => r.status);
const statusOf = (base, headers) => fetch(base + '/api/print/status', { headers: headers || {} })
  .then((r) => r.status);

async function main() {
  console.log('print endpoints — auth boundary');
  console.log('='.repeat(74));

  let a = null, b = null, c = null;
  try {
    /* ================= A. dedicated printKey + admin key ================= */
    console.log('\n--- A. printKey AND adminKey both set ---');
    a = await bootServer('a', 8951, { adminKey: 'ADMIN-KEY-A', printKey: 'PRINT-KEY-A' });

    check('the agent can fetch jobs with the print key',
      (await status(a.base, { 'X-Print-Key': 'PRINT-KEY-A' })) === 200);
    check('the ADMIN key is REJECTED on print jobs once a print key exists',
      (await status(a.base, { 'X-Print-Key': 'ADMIN-KEY-A' })) === 401,
      'this is what makes rotating the print key meaningful');
    check('a wrong print key is rejected',
      (await status(a.base, { 'X-Print-Key': 'nope' })) === 401);
    check('no key at all is rejected', (await status(a.base)) === 401);
    check('the print key is NOT accepted as an admin key',
      (await fetch(a.base + '/api/orders', { headers: { 'X-Admin-Key': 'PRINT-KEY-A' } })).status === 401,
      'the agent must not be able to read the order board');

    check('the agent can read print status with its own key',
      (await statusOf(a.base, { 'X-Print-Key': 'PRINT-KEY-A' })) === 200);
    check('the owner can read print status with the admin key',
      (await statusOf(a.base, { 'X-Admin-Key': 'ADMIN-KEY-A' })) === 200,
      'the console needs this to show the printer health line');
    check('the admin key is NOT a print key on the status endpoint either',
      (await statusOf(a.base, { 'X-Print-Key': 'ADMIN-KEY-A' })) === 401);

    const ack = (k) => fetch(a.base + '/api/print/jobs/some-job/ack', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, k ? { 'X-Print-Key': k } : {}),
      body: JSON.stringify({ ok: true })
    }).then((r) => r.status);
    check('ack requires the print key', (await ack(null)) === 401);
    check('ack accepts the print key', (await ack('PRINT-KEY-A')) !== 401);

    const reprint = (k) => fetch(a.base + '/api/orders/X/reprint', {
      method: 'POST',
      headers: k ? { 'X-Print-Key': k } : {}
    }).then((r) => r.status);
    check('reprint is NOT reachable with the print key (it is a staff action)',
      (await reprint('PRINT-KEY-A')) === 401,
      'a compromised kitchen PC must not be able to spam the printer');

    /* ============ B. admin key set, but NO dedicated print key ============== */
    console.log('\n--- B. adminKey set, no printKey (print endpoint LOCKED) ---');
    b = await bootServer('b', 8952, { adminKey: 'ADMIN-KEY-B' });

    check('with admin set but NO printKey, the print endpoint is LOCKED',
      (await status(b.base, { 'X-Print-Key': 'ADMIN-KEY-B' })) === 401,
      'separation: the admin key is never a print key; set a dedicated printKey');
    check('a wrong key is rejected',
      (await status(b.base, { 'X-Print-Key': 'nope' })) === 401);
    check('no key is rejected', (await status(b.base)) === 401);
    check('the server warns that printing is locked until a printKey is set',
      /PRINT_KEY is not/.test(b.log()),
      b.log().split('\n').filter((l) => /PRINT_KEY/.test(l))[0] || '');

    /* ================= C. nothing configured (dev/open) ================== */
    console.log('\n--- C. no keys at all (dev / open mode) ---');
    c = await bootServer('c', 8953, {});

    check('with no keys configured, print jobs are open',
      (await status(c.base)) === 200,
      'dev convenience — asserted so it is a known state, not a surprise');
    check('the server warns loudly about open mode',
      /ADMIN_KEY not set/.test(c.log()), c.log().split('\n').filter(Boolean)[0] || '');
  } catch (e) {
    check('test ran to completion', false, e.message);
  } finally {
    for (const s of [a, b, c]) { try { if (s) s.proc.kill(); } catch (e) {} }
    await sleep(300);
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
