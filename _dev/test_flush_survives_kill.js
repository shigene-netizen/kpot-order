/* Proves the periodic flush persists orders WITHOUT relying on shutdown
   signals — which is the whole point, since Windows never delivers them.
   1. boot the server
   2. place an order
   3. kill it HARD (SIGKILL, no handler can run)
   4. reboot and confirm the order survived

   Runs against SCRATCH files, not the shop's real ones. It used to write into
   the live orders.local.json ("that's what we're testing") — which meant every
   run left a junk order on the owner's board. What is under test is the flush
   mechanism, not that particular filename, so scratch is just as valid and
   leaves no trace. KPOT_ORDERS_FILE (server.js) exists for exactly this.
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE = process.execPath;
const DIR = path.resolve(__dirname, '..');
const PORT = 8981;
const ADMIN = 'flush-test-admin-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-flush-'));
const ORDERS = path.join(SCRATCH, 'orders.local.json');

function boot(extraEnv) {
  return spawn(NODE, ['server.js'], {
    cwd: DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_KEY: ADMIN,
      KPOT_ORDERS_FILE: ORDERS,
      KPOT_CUSTOMERS_FILE: path.join(path.dirname(ORDERS), 'customers.local.json'),
      /* The store-hours tick SAVES store status on every open/close
         transition — an unpinned suite run after closing time rewrites the
         shop's own switches. */
      KPOT_STORE_FILE: path.join(path.dirname(ORDERS), 'store.local.json'),
      /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
         refuses those outside opening hours. The clock must not decide these
         cases. See hoursSpec() in server.js. */
      KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
      KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
      STRIPE_SECRET_KEY: 'sk_test_flush_not_a_real_key',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    await sleep(250);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch (e) {}
  }
  return false;
}

async function main() {
  // Scratch orders file (see the note at the top) and a scratch backup dir.
  const bk = path.join(SCRATCH, 'backups');
  fs.rmSync(bk, { recursive: true, force: true });

  console.log('--- boot #1');
  let srv = boot({ ORDERS_BACKUP_DIR: bk, KPOT_FLUSH_MS: '1000' });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  if (!await waitUp()) { console.error('no boot'); srv.kill('SIGKILL'); process.exit(1); }

  const token = 'flush-probe-' + Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      no: '', token, orderType: 'dinein', table: '3', payMethod: 'counter', total: 10.58,
      customer: { name: 'Flush Probe', phone: '555-0177' },
      items: [{ kind: 'simple', groupId: 'bubbletea', name: 'Thai Milk Tea', qty: 2, unit: 4.99 }]
    })
  });
  const created = await r.json();
  console.log('order:', created.id || JSON.stringify(created));

  // Give the debounce (800ms) + flush loop a moment.
  await sleep(2500);

  console.log('--- HARD KILL (SIGKILL): no handler can possibly run');
  srv.kill('SIGKILL');
  await sleep(800);

  console.log('--- boot #2: did the order survive?');
  srv = boot({ ORDERS_BACKUP_DIR: bk });
  let log2 = '';
  srv.stdout.on('data', (d) => { log2 += d.toString(); });
  if (!await waitUp()) { console.error('no boot 2'); srv.kill('SIGKILL'); process.exit(1); }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/orders`, {
    headers: { 'X-Admin-Key': ADMIN }
  })).json();

  const survived = (list.orders || []).some((o) => o.clientToken === token);
  console.log('orders on board after restart:', (list.orders || []).length);
  console.log('our order survived hard kill :', survived);
  console.log('\nboot1 log:\n' + log.split('\n').filter(l => l.includes('[kpot]')).join('\n'));
  console.log('\nboot2 log:\n' + log2.split('\n').filter(l => l.includes('[kpot]')).join('\n'));

  srv.kill('SIGKILL');
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  console.log(survived ? '\nPASS — periodic flush saved the order without any shutdown handler'
                       : '\nFAIL — order lost on hard kill');
  process.exit(survived ? 0 : 2);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
