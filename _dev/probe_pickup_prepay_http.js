/* Integration probe: does the RUNNING server enforce the pickup prepayment
 * rule — pay BEFORE the kitchen?
 *
 * The unit test (_dev/test_pickup_prepay.js) proves the RULES are right. This
 * proves the rules are WIRED IN — that handleCreateOrder really refuses a
 * pay-at-counter pickup order over the threshold, and that handleUpdateOrder
 * really holds an unpaid one out of the kitchen. A correct function nobody
 * calls is the classic silent failure.
 *
 * The owner's rule (2026-10-22): a PICKUP order over $20 must be paid before
 * it is sent to the kitchen. Two arms, both covered here:
 *
 *   1. PAYMENT ARM — POST /api/orders with payMethod 'counter' on a pickup
 *      order over the threshold is REFUSED (pickup_prepay_required). The
 *      same order paid online is accepted.
 *
 *   2. KITCHEN ARM — a staff PATCH moving an unpaid pickup order over the
 *      threshold to 'preparing' is REFUSED (pickup_awaiting_payment), and no
 *      ticket is queued. Confirming the payment (💵 Collected) releases it.
 *
 * Controls, without which a bug that blocked every order would still pass:
 *   - a pickup order UNDER the threshold pays at the counter and goes
 *     straight to the kitchen — the threshold is the whole point;
 *   - the SAME over-threshold cart on Dine-In is accepted and cooks — the
 *     guest is in the building, the rule is pickup-scoped;
 *   - a legacy counter pickup order (seeded, as pre-deploy data would be) is
 *     held the same way and released by Collected;
 *   - with no online method configured the payment arm fails OPEN, so a shop
 *     without card processing can still take a large pickup order.
 *
 * Everything is server-derived: money comes from /api/price, never a number
 * invented here (total_mismatch would refuse anything else anyway). It runs
 * against SCRATCH files — every KPOT_*_FILE the server honours is pinned, so
 * the shop's real orders, switches, ledger and secrets are never touched.
 *
 * Run:  node _dev/probe_pickup_prepay_http.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8965', 10);
const PORT2 = parseInt(process.env.PORT2 || '8966', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const BASE2 = 'http://127.0.0.1:' + PORT2;
const ADMIN = 'probe-pickup-admin';
const PRINT = 'probe-pickup-print';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-pickup-http-'));
const SCRATCH2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-pickup-nokey-'));

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Menu prices come from the menu file via /api/price — these are only the
   ITEM DESCRIPTORS. One bowl is $15.99 (builder base) and a side of fries is
   $2.99, so bowl + fries = $18.98 + 6% tax = $20.12: just over the $20
   threshold and comfortably under the $30 pay-at-counter ceiling, which is
   what makes it the right cart for the pickup tests. */
const BOWL = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: 15.99, mods: [], addons: [], note: '' };
const FRIES = { kind: 'simple', name: 'Side of Fries', qty: 1, unit: 2.99, mods: [], addons: [], note: '' };

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

function api(base, route, body, h) {
  return fetch(base + route, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
}
const post = (base, body) => api(base, '/api/orders', body);
const patch = (base, id, body) => fetch(base + '/api/orders/' + encodeURIComponent(id), {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN },
  body: JSON.stringify(body)
}).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
const getJSON = (base, route) => fetch(base + route, {
  headers: { 'X-Admin-Key': ADMIN }
}).then((r) => r.json().catch(() => null));
const adminH = { 'X-Admin-Key': ADMIN };

/* Money is the SERVER's, never a number invented here. */
async function pricePickup(base, items) {
  const r = await api(base, '/api/price', { orderType: 'pickup', items: items, tipAmount: 0 });
  if (r.status !== 200 || !r.j) throw new Error('could not price: ' + JSON.stringify(r));
  return r.j;
}

function orderFor(id, items, money, payMethod, token, over) {
  return Object.assign({
    no: id,
    token: 'probe-pickup-' + token,
    orderType: 'pickup',
    table: '',
    customer: { name: 'Probe', phone: '', when: 'ASAP' },
    items: items,
    subtotal: money.subtotal,
    deliveryFee: money.delivery,
    tax: money.tax,
    tip: money.tip,
    surcharge: 0,
    total: money.total,
    payMethod: payMethod,
    paymentStatus: payMethod === 'counter' ? 'counter' : 'unverified',
    paid: false,
    source: 'probe'
  }, over || {});
}

/* The durable record of what the kitchen would print. Polled, because the
   print queue is snapshotted on a debounce. */
function readJobs(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
async function jobsWait(file, orderId, n, timeoutMs) {
  const until = Date.now() + (timeoutMs || 6000);
  while (Date.now() < until) {
    if (readJobs(file).filter((j) => j.orderId === orderId).length >= n) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return readJobs(file).filter((j) => j.orderId === orderId);
}
async function orderAt(base, id) {
  const r = await getJSON(base, '/api/orders?since=1970-01-01T00:00:00Z');
  const list = (r && r.orders) || [];
  return list.find((o) => o.id === id) || null;
}

function waitForHealth(base, tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(base + '/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => new Promise((res) => setTimeout(res, 250)).then(() => waitForHealth(base, tries - 1)));
}

/* Every state file the server knows about points at scratch. The list is
   copied from server.js, not from memory: hermeticity is per-FILE, and a
   suite that pins only the files it remembers is how the shop's real
   discount codes got clobbered once already. */
function scratchEnv(dir, port, extra) {
  return Object.assign({}, process.env, {
    PORT: String(port),
    KPOT_ORDERS_FILE: path.join(dir, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(dir, 'customers.local.json'),
    KPOT_CREDITS_FILE: path.join(dir, 'credits.local.json'),
    KPOT_PRINT_FILE: path.join(dir, 'print.local.json'),
    KPOT_STORE_FILE: path.join(dir, 'store.local.json'),
    KPOT_MENU_FILE: path.join(dir, 'menu.local.json'),
    KPOT_SECRETS_FILE: path.join(dir, 'secrets.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(dir, 'discounts.local.json'),
    KPOT_APPLE_PAY_FILE: path.join(dir, 'apple-domain-association'),
    KPOT_GIVEAWAY_OUTBOX: path.join(dir, 'giveaway-mail-outbox.jsonl'),
    ORDERS_BACKUP_DIR: path.join(dir, 'order-backups'),
    /* 24h open: this probe posts pay-at-counter orders, and /api/orders
       refuses those outside opening hours. The clock must not decide these
       cases. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    ADMIN_KEY: ADMIN,
    PRINT_KEY: PRINT,
    KPOT_FLUSH_MS: '400'
  }, extra || {});
}

function boot(port, env) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { proc, log: '' };
  proc.stdout.on('data', (d) => { state.log += d.toString(); });
  proc.stderr.on('data', (d) => { state.log += d.toString(); });
  return state;
}

let server = null, server2 = null;

function finish(code) {
  for (const s of [server, server2]) { try { if (s) s.proc.kill(); } catch (e) {} }
  for (const d of [SCRATCH, SCRATCH2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  setTimeout(() => process.exit(code), 250);
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('pickup prepayment on the running server — pay before the kitchen');
  console.log('='.repeat(74));

  const TOKEN = Date.now().toString(36);

  /* A legacy counter pickup order, exactly as pre-deploy data would sit on
     the board: unpaid, over the threshold, waiting for a human. Seeded
     BEFORE the server boots — while it runs, the in-memory map is the truth
     and the next save would overwrite the file. */
  const LEGACY = 'KP-PP-LEGACY-' + TOKEN;
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(SCRATCH, 'orders.local.json'), JSON.stringify([{
    id: LEGACY,
    no: LEGACY,
    orderNo: LEGACY,
    at: nowIso,
    updatedAt: nowIso,
    status: 'received',
    orderType: 'pickup',
    payMethod: 'counter',
    paymentStatus: 'counter',
    table: '',
    customer: { name: 'Legacy', phone: '', when: 'ASAP' },
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: 15.99, mods: [], addons: [], note: '' },
            { kind: 'simple', name: 'Side of Fries', qty: 1, unit: 2.99, mods: [], addons: [], note: '' }],
    lines: [{ name: 'Hot Pot To Go', desc: '', unit: 15.99, qty: 1 },
            { name: 'Side of Fries', desc: '', unit: 2.99, qty: 1 }],
    subtotal: 18.98, delivery: 0, tax: 1.14, tip: 0, total: 20.12,
    discountAmount: 0, discount: null, credit: null,
    source: 'seed'
  }], null, 2));

  server = boot(PORT, scratchEnv(SCRATCH, PORT, { STRIPE_SECRET_KEY: 'sk_test_pickup_probe_not_a_real_key' }));
  await waitForHealth(BASE, 60);
  console.log('server up on ' + BASE + '\n');

  const PRINT_FILE = path.join(SCRATCH, 'print.local.json');

  /* ---- the three carts, priced by the server ---------------------------- */
  const small = await pricePickup(BASE, [BOWL]);                 // $16.95
  const justOver = await pricePickup(BASE, [BOWL, FRIES]);       // $20.12
  const big = await pricePickup(BASE, [{ ...BOWL, qty: 2 }]);    // $33.90

  section('the carts (server-priced)');
  check('a single bowl prices under the threshold', small.total <= 20,
    'small=' + small.total);
  check('bowl + fries prices just OVER the threshold', justOver.total > 20,
    'justOver=' + justOver.total + ' (subtotal ' + justOver.subtotal + ' + tax ' + justOver.tax + ')');
  check('and still under the $30 counter ceiling, so the ceiling cannot be the refuser',
    justOver.total <= 30, 'justOver=' + justOver.total);
  check('two bowls price well over', big.total > 30, 'big=' + big.total);

  /* ---- payment arm ------------------------------------------------------- */
  section('payment arm — pay-at-counter on a pickup order over $20');

  const refused = await post(BASE, orderFor('KP-PP-REFUSED-' + TOKEN, [BOWL, FRIES], justOver, 'counter', 'refused'));
  check('counter $' + justOver.total.toFixed(2) + ' pickup → REFUSED with pickup_prepay_required',
    refused.status === 400 && refused.j && refused.j.error === 'pickup_prepay_required',
    'status=' + refused.status + ' body=' + JSON.stringify(refused.j));
  check('the refusal names the threshold and the total',
    refused.j && refused.j.over === 20 && refused.j.total === justOver.total,
    'over=' + (refused.j && refused.j.over) + ' total=' + (refused.j && refused.j.total));
  check('the refusal tells the guest what to do',
    !!(refused.j && /paid online/i.test(refused.j.message || '')),
    'message=' + JSON.stringify(refused.j && refused.j.message));
  check('and NO order reached the board',
    (await orderAt(BASE, 'KP-PP-REFUSED-' + TOKEN)) === null);

  const smallCounter = await post(BASE, orderFor('KP-PP-SMALL-' + TOKEN, [BOWL], small, 'counter', 'small'));
  check('counter $' + small.total.toFixed(2) + ' pickup (under) → accepted',
    smallCounter.status === 200 && smallCounter.j && smallCounter.j.ok === true,
    'status=' + smallCounter.status + ' body=' + JSON.stringify(smallCounter.j));

  const justOverStripe = await post(BASE, orderFor('KP-PP-STRIPE-' + TOKEN, [BOWL, FRIES], justOver, 'stripe', 'stripe'));
  check('the same $' + justOver.total.toFixed(2) + ' paid online → accepted',
    justOverStripe.status === 200 && justOverStripe.j && justOverStripe.j.ok === true,
    'status=' + justOverStripe.status + ' body=' + JSON.stringify(justOverStripe.j));

  const bigStripe = await post(BASE, orderFor('KP-PP-BIG-' + TOKEN, [{ ...BOWL, qty: 2 }], big, 'stripe', 'bigstripe'));
  check('a $' + big.total.toFixed(2) + ' online pickup → accepted (prepaid, no ceiling of ours applies)',
    bigStripe.status === 200 && bigStripe.j && bigStripe.j.ok === true,
    'status=' + bigStripe.status + ' body=' + JSON.stringify(bigStripe.j));

  /* Control: the SAME over-threshold cart on another channel. Dine-in is in
     the building, so the pickup rule must not touch it. (Delivery would be
     refused too — by its own ban — so it proves nothing here.) */
  const dinein = await post(BASE, orderFor('KP-PP-DINE-' + TOKEN, [BOWL, FRIES], justOver, 'counter', 'dinein',
    { orderType: 'dinein', table: '5' }));
  check('control: the same $' + justOver.total.toFixed(2) + ' on DINE-IN, counter → accepted (rule is pickup-scoped)',
    dinein.status === 200 && dinein.j && dinein.j.ok === true,
    'status=' + dinein.status + ' body=' + JSON.stringify(dinein.j));

  /* ---- kitchen arm ------------------------------------------------------- */
  section('kitchen arm — an unpaid pickup order over $20 cannot be cooked');

  const stripeOrder = 'KP-PP-STRIPE-' + TOKEN;
  const held = await patch(BASE, stripeOrder, { status: 'preparing' });
  check('staff tapping PREPARING on the unpaid order → REFUSED with pickup_awaiting_payment',
    held.status === 409 && held.j && held.j.error === 'pickup_awaiting_payment',
    'status=' + held.status + ' body=' + JSON.stringify(held.j));
  check('the refusal tells staff how to release it',
    !!(held.j && /(Re-check|Collected)/i.test(held.j.message || '')),
    'message=' + JSON.stringify(held.j && held.j.message));
  check('the order is still on the board, still received',
    (await orderAt(BASE, stripeOrder) || {}).status === 'received');
  check('and no ticket was queued',
    readJobs(PRINT_FILE).filter((j) => j.orderId === stripeOrder).length === 0,
    'jobs=' + readJobs(PRINT_FILE).length);

  const collected = await patch(BASE, stripeOrder, { paymentStatus: 'paid' });
  check('marking it Collected (💵) is accepted', collected.status === 200 && collected.j && collected.j.ok === true,
    'status=' + collected.status + ' body=' + JSON.stringify(collected.j));

  const released = await patch(BASE, stripeOrder, { status: 'preparing' });
  check('and NOW the order goes to the kitchen',
    released.status === 200 && released.j && released.j.status === 'preparing',
    'status=' + released.status + ' body=' + JSON.stringify(released.j));
  const jobs = await jobsWait(PRINT_FILE, stripeOrder, 1);
  check('with exactly one kitchen ticket', jobs.length === 1 && jobs[0].kind === 'kitchen',
    'jobs=' + JSON.stringify(jobs.map((j) => j.id)));
  check('and the ticket is real bytes', typeof jobs[0].bytes === 'string' && jobs[0].bytes.length > 100,
    jobs[0].bytes.length + ' base64 chars');

  /* Control: the under-threshold counter order goes straight to the kitchen,
     unpaid — that is the threshold doing its job, not a bug. */
  const smallOrder = 'KP-PP-SMALL-' + TOKEN;
  const smallPrep = await patch(BASE, smallOrder, { status: 'preparing' });
  check('control: the $' + small.total.toFixed(2) + ' counter pickup cooks UNPAID (threshold-scoped)',
    smallPrep.status === 200 && smallPrep.j && smallPrep.j.status === 'preparing',
    'status=' + smallPrep.status + ' body=' + JSON.stringify(smallPrep.j));
  await jobsWait(PRINT_FILE, smallOrder, 1);
  check('and got its ticket', readJobs(PRINT_FILE).filter((j) => j.orderId === smallOrder).length === 1);

  /* Control: dine-in with the same money is never held. */
  const dineinOrder = 'KP-PP-DINE-' + TOKEN;
  const dineinPrep = await patch(BASE, dineinOrder, { status: 'preparing' });
  check('control: the dine-in order over $20 cooks without the hold',
    dineinPrep.status === 200 && dineinPrep.j && dineinPrep.j.status === 'preparing',
    'status=' + dineinPrep.status + ' body=' + JSON.stringify(dineinPrep.j));

  /* The legacy counter order: held exactly like a fresh one, released by the
     same tap. This is the shape every real over-threshold counter order
     created before the rule shipped would have. */
  section('a legacy counter pickup order (pre-deploy data)');
  const legacyHeld = await patch(BASE, LEGACY, { status: 'preparing' });
  check('held out of the kitchen the same way',
    legacyHeld.status === 409 && legacyHeld.j && legacyHeld.j.error === 'pickup_awaiting_payment',
    'status=' + legacyHeld.status + ' body=' + JSON.stringify(legacyHeld.j));
  const legacyPaid = await patch(BASE, LEGACY, { paymentStatus: 'paid' });
  check('released by Collected', legacyPaid.status === 200 && legacyPaid.j && legacyPaid.j.ok === true,
    'status=' + legacyPaid.status + ' body=' + JSON.stringify(legacyPaid.j));
  const legacyPrep = await patch(BASE, LEGACY, { status: 'preparing' });
  check('and then cooks', legacyPrep.status === 200 && legacyPrep.j && legacyPrep.j.status === 'preparing',
    'status=' + legacyPrep.status + ' body=' + JSON.stringify(legacyPrep.j));
  await jobsWait(PRINT_FILE, LEGACY, 1);
  check('with its ticket', readJobs(PRINT_FILE).filter((j) => j.orderId === LEGACY).length === 1);

  /* ---- no online method: the payment arm must fail OPEN ------------------ */
  section('no card processing configured (second server, no Stripe key)');
  server2 = boot(PORT2, scratchEnv(SCRATCH2, PORT2, { STRIPE_SECRET_KEY: '' }));
  await waitForHealth(BASE2, 60);
  const nokeyPrice = await pricePickup(BASE2, [BOWL, FRIES]);
  const nokey = await post(BASE2, orderFor('KP-PP-NOKEY-' + TOKEN, [BOWL, FRIES], nokeyPrice, 'counter', 'nokey'));
  check('a counter pickup order over the threshold is still ACCEPTED (never lock out large orders)',
    nokey.status === 200 && nokey.j && nokey.j.ok === true,
    'status=' + nokey.status + ' body=' + JSON.stringify(nokey.j));
  /* …and the kitchen arm still holds it, so the no-show risk does not come
     back with the carve-out. */
  const nokeyPrep = await patch(BASE2, 'KP-PP-NOKEY-' + TOKEN, { status: 'preparing' });
  check('but it is still held out of the kitchen until the cash is confirmed',
    nokeyPrep.status === 409 && nokeyPrep.j && nokeyPrep.j.error === 'pickup_awaiting_payment',
    'status=' + nokeyPrep.status + ' body=' + JSON.stringify(nokeyPrep.j));

  console.log('\n' + '='.repeat(74));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finish(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL  could not run probe: ' + e.message);
  finish(1);
});
