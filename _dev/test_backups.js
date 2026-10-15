#!/usr/bin/env node
/* ==========================================================================
   Order backups — the guarantee that actually holds on Windows.

   This replaces test_shutdown_backup.js, which asserted that a shutdown hook
   writes a backup. On Windows that can never happen: Node kills the process
   outright and neither `process.on('SIGTERM')` nor `process.on('exit')` runs.
   So that test could only ever be red, and a permanently red test is worse than
   no test — it teaches everyone to ignore red.

   It had also gone stale in a second way: it looked for a hardcoded
   `orders-2026-10-04.json`, so it broke the day after it was written.

   What is actually true, and what this test now pins down:

     1. a snapshot is written at STARTUP, so a restart never leaves a day with
        no backup at all;
     2. a backup is written again whenever the board CHANGES (the periodic
        flush), which is what bounds worst-case loss to one flush interval;
     3. the data is on disk without any shutdown hook ever running — proved by
        a SIGKILL, which no handler can intercept.

   The filename is date-based, so nothing here hardcodes a date: it finds
   whatever the server wrote.

   Run:  node _dev/test_backups.js
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8982', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'backup-test-admin-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-backups-'));
const ORDERS = path.join(SCRATCH, 'orders.local.json');
const BACKUPS = path.join(SCRATCH, 'backups');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

/* Find the newest backup the server wrote, whatever it decided to call it. */
function latestBackup() {
  let files;
  try { files = fs.readdirSync(BACKUPS); } catch (e) { return null; }
  const jsons = files.filter((f) => /^orders-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!jsons.length) return null;
  const name = jsons[jsons.length - 1];
  try {
    return { name, ...JSON.parse(fs.readFileSync(path.join(BACKUPS, name), 'utf8')) };
  } catch (e) { return null; }
}

function boot() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ADMIN_KEY: ADMIN,
      ORDERS_BACKUP_DIR: BACKUPS,
      KPOT_ORDERS_FILE: ORDERS,
      KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS), 'customers.local.json'),
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      STRIPE_SECRET_KEY: 'sk_test_backup_not_a_real_key',
      KPOT_FLUSH_MS: '700'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
  }
  return false;
}

async function main() {
  console.log('order backups — startup snapshot + periodic flush (no shutdown hook)');
  console.log('='.repeat(74));

  let srv = null;
  try {
    srv = boot();
    let log = '';
    srv.stdout.on('data', (d) => { log += d.toString(); });
    srv.stderr.on('data', (d) => { log += d.toString(); });
    if (!await waitUp()) throw new Error('server never came up');

    /* ---- 1. the startup snapshot ---------------------------------------- */
    const boot1 = latestBackup();
    check('a backup is written at startup', !!boot1, boot1 ? boot1.name : '(none found)');
    check('and it is labelled "startup"', boot1 && boot1.reason === 'startup',
      'reason=' + (boot1 && boot1.reason));
    check('the filename is date-based, not hardcoded',
      !!boot1 && /^orders-\d{4}-\d{2}-\d{2}\.json$/.test(boot1.name), boot1 && boot1.name);

    /* ---- 2. a change produces a periodic backup ------------------------- */
    const token = 'backup-probe-' + Date.now();
    const created = await fetch(BASE + '/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        no: '', token, orderType: 'pickup', payMethod: 'counter', total: 10.58,
        customer: { name: 'Backup Probe', phone: '555-0101' },
        items: [{ kind: 'simple', groupId: 'bubbletea', name: 'Thai Milk Tea', qty: 2, unit: 4.99 }]
      })
    }).then((r) => r.json());
    check('order created', !!created.id, 'id=' + (created.id || JSON.stringify(created)));

    let after = null;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      after = latestBackup();
      if (after && after.reason === 'periodic') break;
    }
    check('a backup is written again after the board changes',
      after && after.reason === 'periodic', 'reason=' + (after && after.reason));
    check('and it contains the new order',
      !!(after && (after.orders || []).some((o) => o.clientToken === token)),
      'count=' + (after && after.count));

    /* ---- 3. data on disk without any shutdown hook ---------------------- */
    console.log('\n  (SIGKILL — no handler can run, which is the Windows reality)');
    srv.kill('SIGKILL');
    await sleep(700);

    const onDisk = JSON.parse(fs.readFileSync(ORDERS, 'utf8'));
    check('the order is on disk despite the hard kill',
      onDisk.some((o) => o.clientToken === token),
      'orders on disk=' + onDisk.length);

    const final = latestBackup();
    check('the backup file survives the kill', !!final, final && final.name);
    /* Informational: on Windows this reason will never be 'shutdown-*'. Asserting
       it would make the test platform-dependent, and the whole point is that we
       do NOT depend on the shutdown path. */
    console.log('  note  the last backup reason was "' + (final && final.reason) +
      '" — a shutdown-* reason is impossible on Windows and is not relied on');

    /* ---- 4. it all comes back after a restart --------------------------- */
    srv = boot();
    if (!await waitUp()) throw new Error('server did not come back up');
    const list = await (await fetch(BASE + '/api/orders', { headers: { 'X-Admin-Key': ADMIN } })).json();
    check('the order is on the board again after a restart',
      (list.orders || []).some((o) => o.clientToken === token),
      'orders=' + (list.orders || []).length);
  } catch (e) {
    check('test ran to completion', false, e.message);
  } finally {
    try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
