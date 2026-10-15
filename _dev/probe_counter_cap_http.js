/* Integration probe: does the RUNNING server actually enforce the
 * pay-at-counter ceiling?
 *
 * The unit test (_dev/test_counter_cap.js) proves the RULE is right. This
 * proves the rule is WIRED IN — that handleCreateOrder really calls it. A
 * correct function nobody calls is the classic silent failure.
 *
 * It boots the real server on a scratch port, posts real orders, and checks
 * the HTTP status + error code.
 *
 * It runs against SCRATCH files, not the shop's own orders.local.json. The
 * comment here used to claim "orders.local.json is backed up by the caller and
 * restored afterwards" — nothing of the sort happened, and every run quietly
 * left two junk orders on the owner's board. KPOT_ORDERS_FILE exists so a test
 * never has to touch real data.
 *
 * Run:  node _dev/probe_counter_cap_http.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8931;
const BASE = 'http://127.0.0.1:' + PORT;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-cap-http-'));

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* One 'Hot Pot To Go' bowl is $15.99 (builder base price). */
function orderFor(qty, payMethod, token) {
  const unit = 15.99;
  const subtotal = round2(unit * qty);
  const tax = round2(subtotal * 0.06);
  const total = round2(subtotal + tax);
  return {
    no: 'KP-PROBE-' + token,
    token: 'probe-' + token,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Probe', phone: '', when: 'ASAP' },
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: qty, unit: unit, mods: [], addons: [], note: '' }],
    subtotal: subtotal,
    deliveryFee: 0,
    tax: tax,
    tip: 0,
    surcharge: 0,
    total: total,
    payMethod: payMethod,
    paymentStatus: payMethod === 'counter' ? 'counter' : 'unverified',
    paid: false,
    source: 'probe'
  };
}

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}

function post(body) {
  return fetch(BASE + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
}

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.checkout) return true; throw new Error('not ready'); })
    .catch(() => new Promise((res) => setTimeout(res, 250)).then(() => waitForHealth(tries - 1)));
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
    STRIPE_SECRET_KEY: 'sk_test_cap_probe_not_a_real_key'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 250);
}

waitForHealth(60)
  .then(() => {
    console.log('server up on ' + BASE + '\n');
    /* Small counter order — under the $30 ceiling, must be accepted. */
    return post(orderFor(1, 'counter', 'small')).then((r) => {
      check('counter $16.95 (under cap) → accepted',
        r.status === 200 && r.j && r.j.ok === true,
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      return post(orderFor(3, 'counter', 'big'));
    }).then((r) => {
      /* $50.85 — over the ceiling, must be REFUSED. */
      check('counter $50.85 (over cap) → REFUSED with counter_over_cap',
        r.status === 400 && r.j && r.j.error === 'counter_over_cap',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      check('refusal names the cap and the total',
        r.j && r.j.cap === 30 && r.j.total === 50.85,
        'cap=' + (r.j && r.j.cap) + ' total=' + (r.j && r.j.total));
      check('refusal tells the guest what to do',
        !!(r.j && /paid online/i.test(r.j.message || '')),
        'message=' + JSON.stringify(r.j && r.j.message));
      /* The same size order paid online is fine — it is prepaid, so the
         ceiling does not apply to it. */
      return post(orderFor(3, 'stripe', 'bigstripe'));
    }).then((r) => {
      check('stripe $50.85 (over cap) → accepted (prepaid, cap does not apply)',
        r.status === 200 && r.j && r.j.ok === true,
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      /* Exactly at the ceiling — must be allowed. */
      return post(orderFor(2, 'counter', 'exact'));
    }).then((r) => {
      check('counter $33.90 (over cap) → refused',
        r.status === 400 && r.j && r.j.error === 'counter_over_cap',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      if (fail) console.log('\n--- server log ---\n' + serverLog);
      finish(fail ? 1 : 0);
    });
  })
  .catch((e) => {
    console.log('  FAIL  could not run probe: ' + e.message);
    console.log(serverLog);
    finish(1);
  });
