/* Integration probe: does the RUNNING server enforce the prepayment rule —
 * pay BEFORE the kitchen, on pickup AND delivery?
 *
 * The unit test (_dev/test_prepay.js) proves the RULES are right. This proves
 * the rules are WIRED IN — that handleCreateOrder really refuses pay-at-counter
 * on pickup and delivery, and that handleUpdateOrder really holds an unpaid one
 * out of the kitchen. A correct function nobody calls is the classic silent
 * failure.
 *
 * The owner's rule (2026-10-22, final): every pickup and every delivery order
 * must be paid before it is sent to the kitchen; pay-at-counter is not accepted
 * on either. Two arms, both covered here:
 *
 *   1. PAYMENT ARM — POST /api/orders with payMethod 'counter' on a pickup or
 *      delivery order is REFUSED (counter_not_allowed) at ANY total. The same
 *      order paid online is accepted.
 *
 *   2. KITCHEN ARM — a staff PATCH moving an unpaid pickup/delivery order to
 *      'preparing' is REFUSED (unpaid_before_kitchen), and no ticket is
 *      queued. Confirming the payment (💵 Collected) releases it.
 *
 * Controls, without which a bug that blocked every order would still pass:
 *   - the same cart on DINE-IN still pays at the counter and cooks unpaid —
 *     the guest is at a table, that is the design;
 *   - a very large DINE-IN tab is still refused by the $30 ceiling, so the
 *     ceiling is provably still alive behind the channel rule;
 *   - a legacy counter pickup order (seeded, as pre-deploy data would be) is
 *     held the same way and released by Collected — including a $16.95 one,
 *     which the retired $20 threshold would have let straight through;
 *   - with no online method configured the refusal still happens, and its
 *     message tells the guest to phone the shop instead of pointing at a
 *     Pay Online button that does not exist.
 *
 * Everything is server-derived: money comes from /api/price, never a number
 * invented here (total_mismatch would refuse anything else anyway). It runs
 * against SCRATCH files — every KPOT_*_FILE the server honours is pinned, so
 * the shop's real orders, switches, ledger and secrets are never touched.
 *
 * Run:  node _dev/probe_prepay_http.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = parseInt(process.env.PORT || '8975', 10);
const PORT2 = parseInt(process.env.PORT2 || '8976', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const BASE2 = 'http://127.0.0.1:' + PORT2;
const ADMIN = 'probe-prepay-admin';
const PRINT = 'probe-prepay-print';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-prepay-http-'));
const SCRATCH2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-prepay-nokey-'));

/* Item DESCRIPTORS only — the server prices them from the menu file. One bowl
   is $15.99 and a side of fries is $2.99, so bowl + fries = $18.98 + 6% tax =
   $20.12. That number matters twice: it is under the $30 table-tab ceiling
   (so a refusal of it cannot be the ceiling), and it is exactly the kind of
   cart the old $20 pickup threshold used to catch. */
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
async function price(base, orderType, items) {
  const r = await api(base, '/api/price', { orderType: orderType, items: items, tipAmount: 0 });
  if (r.status !== 200 || !r.j) throw new Error('could not price: ' + JSON.stringify(r));
  return r.j;
}

function orderFor(id, items, money, payMethod, token, over) {
  return Object.assign({
    no: id,
    token: 'probe-prepay-' + token,
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

/* A delivery order needs a booked window — the server refuses one without
   (schedule_required), and that refusal comes BEFORE the counter rule, so a
   delivery case without a schedule would prove nothing. Read the real picker
   rather than inventing a slot id. */
let scheduleDays = [];
let scheduleCursor = 0;
async function loadSchedule(base) {
  const s = await getJSON(base, '/api/schedule');
  scheduleDays = (s && s.days) || [];
  for (const d of scheduleDays) {
    const di = await getJSON(base, '/api/schedule?date=' + encodeURIComponent(d.iso));
    d._slots = (di && di.slots) || [];
  }
}
function nextSchedule() {
  const days = scheduleDays || [];
  if (!days.length) return null;
  const day = days[scheduleCursor % days.length];
  const slots = (day._slots || []).filter((s) => !s.full && !s.outsideHours);
  if (!slots.length) return null;
  const slot = slots[scheduleCursor % slots.length];
  scheduleCursor++;
  return { date: day.iso, slot: slot.id };
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
  console.log('prepayment on the running server — pay before the kitchen (pickup + delivery)');
  console.log('='.repeat(78));

  const TOKEN = Date.now().toString(36);

  /* A legacy counter pickup order, exactly as pre-deploy data would sit on the
     board: unpaid, small ($16.95), waiting for a human. Seeded BEFORE the
     server boots — while it runs, the in-memory map is the truth and the next
     save would overwrite the file.

     The SIZE is the point: under the retired $20 threshold this order cooked
     unpaid without a murmur. It must now be held, which is what makes this
     seed a test of the change rather than of the plumbing. */
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
    items: [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: 15.99, mods: [], addons: [], note: '' }],
    lines: [{ name: 'Hot Pot To Go', desc: '', unit: 15.99, qty: 1 }],
    subtotal: 15.99, delivery: 0, tax: 0.96, tip: 0, total: 16.95,
    discountAmount: 0, discount: null, credit: null,
    source: 'seed'
  }], null, 2));

  server = boot(PORT, scratchEnv(SCRATCH, PORT, { STRIPE_SECRET_KEY: 'sk_test_prepay_probe_not_a_real_key' }));
  await waitForHealth(BASE, 60);
  console.log('server up on ' + BASE + '\n');

  const PRINT_FILE = path.join(SCRATCH, 'print.local.json');

  /* Delivery is off in config.js, so the channel has to be switched on before
     a delivery order can even be considered — otherwise the refusal would be
     "delivery is closed" and prove nothing about the counter. */
  const storeOn = await api(BASE, '/api/store',
    { open: true, acceptingOrders: true, orderTypes: { pickup: true, dinein: true, delivery: true } }, adminH);
  check('delivery switched on for the probe',
    storeOn.status === 200 && storeOn.j && storeOn.j.orderTypes && storeOn.j.orderTypes.delivery === true,
    'status=' + storeOn.status + ' body=' + JSON.stringify(storeOn.j && storeOn.j.orderTypes));

  await loadSchedule(BASE);
  check('the delivery picker offers a bookable window (the delivery cases need one)',
    scheduleDays.some((d) => (d._slots || []).some((s) => !s.full && !s.outsideHours)),
    'days=' + scheduleDays.length);

  /* ---- the carts, priced by the server -------------------------------- */
  const small = await price(BASE, 'pickup', [BOWL]);                    // $16.95
  const mid = await price(BASE, 'pickup', [BOWL, FRIES]);               // $20.12
  const big = await price(BASE, 'pickup', [{ ...BOWL, qty: 2 }]);       // $33.90

  section('the carts (server-priced)');
  check('a single bowl prices at $' + small.total.toFixed(2) + ' (under every old threshold)',
    small.total < 20, 'small=' + small.total);
  check('bowl + fries prices at $' + mid.total.toFixed(2) + ' (under the $30 table-tab ceiling)',
    mid.total > 20 && mid.total <= 30,
    'mid=' + mid.total + ' (subtotal ' + mid.subtotal + ' + tax ' + mid.tax + ')');
  check('two bowls price at $' + big.total.toFixed(2) + ' (over the ceiling)',
    big.total > 30, 'big=' + big.total);

  /* ---- payment arm ----------------------------------------------------- */
  section('payment arm — pay-at-counter is refused on pickup and delivery');

  const refusedSmall = await post(BASE,
    orderFor('KP-PP-REF-SMALL-' + TOKEN, [BOWL], small, 'counter', 'refsmall'));
  check('counter $' + small.total.toFixed(2) + ' pickup → REFUSED with counter_not_allowed',
    refusedSmall.status === 400 && refusedSmall.j && refusedSmall.j.error === 'counter_not_allowed',
    'status=' + refusedSmall.status + ' body=' + JSON.stringify(refusedSmall.j));
  check('the refusal names the channel (pickup)',
    refusedSmall.j && refusedSmall.j.channel === 'pickup',
    'channel=' + (refusedSmall.j && refusedSmall.j.channel));
  check('the refusal tells the guest what to do',
    !!(refusedSmall.j && /paid online/i.test(refusedSmall.j.message || '')),
    'message=' + JSON.stringify(refusedSmall.j && refusedSmall.j.message));
  check('and NO order reached the board',
    (await orderAt(BASE, 'KP-PP-REF-SMALL-' + TOKEN)) === null);

  const refusedBig = await post(BASE,
    orderFor('KP-PP-REF-BIG-' + TOKEN, [{ ...BOWL, qty: 2 }], big, 'counter', 'refbig'));
  check('counter $' + big.total.toFixed(2) + ' pickup → REFUSED too (there is no threshold to sit under)',
    refusedBig.status === 400 && refusedBig.j && refusedBig.j.error === 'counter_not_allowed',
    'status=' + refusedBig.status + ' body=' + JSON.stringify(refusedBig.j));

  const refusedDelivery = await post(BASE,
    orderFor('KP-PP-REF-DLV-' + TOKEN, [BOWL, FRIES], mid, 'counter', 'refdlv',
      { orderType: 'delivery', schedule: nextSchedule() }));
  check('counter $' + mid.total.toFixed(2) + ' delivery → REFUSED with counter_not_allowed',
    refusedDelivery.status === 400 && refusedDelivery.j && refusedDelivery.j.error === 'counter_not_allowed',
    'status=' + refusedDelivery.status + ' body=' + JSON.stringify(refusedDelivery.j));
  check('the refusal names the channel (delivery)',
    refusedDelivery.j && refusedDelivery.j.channel === 'delivery',
    'channel=' + (refusedDelivery.j && refusedDelivery.j.channel));

  const pickupStripe = await post(BASE,
    orderFor('KP-PP-STRIPE-' + TOKEN, [BOWL, FRIES], mid, 'stripe', 'stripe'));
  check('the same $' + mid.total.toFixed(2) + ' paid online → accepted',
    pickupStripe.status === 200 && pickupStripe.j && pickupStripe.j.ok === true,
    'status=' + pickupStripe.status + ' body=' + JSON.stringify(pickupStripe.j));

  const deliveryStripe = await post(BASE,
    orderFor('KP-PP-DLV-' + TOKEN, [BOWL, FRIES], mid, 'stripe', 'dlv',
      { orderType: 'delivery', schedule: nextSchedule() }));
  check('a delivery paid online → accepted',
    deliveryStripe.status === 200 && deliveryStripe.j && deliveryStripe.j.ok === true,
    'status=' + deliveryStripe.status + ' body=' + JSON.stringify(deliveryStripe.j));

  /* Control: the SAME cart on DINE-IN still pays at the counter. The guest is
     at a table, in the building, and the tab is the design. */
  const dinein = await post(BASE,
    orderFor('KP-PP-DINE-' + TOKEN, [BOWL, FRIES], mid, 'counter', 'dinein',
      { orderType: 'dinein', table: '5' }));
  check('control: the same $' + mid.total.toFixed(2) + ' on DINE-IN, counter → accepted',
    dinein.status === 200 && dinein.j && dinein.j.ok === true,
    'status=' + dinein.status + ' body=' + JSON.stringify(dinein.j));

  /* Control: the table-tab ceiling is still alive BEHIND the channel rule —
     otherwise "dine-in may pay at the counter" would be unbounded. */
  const dineinBig = await post(BASE,
    orderFor('KP-PP-DINE-BIG-' + TOKEN, [{ ...BOWL, qty: 2 }], big, 'counter', 'dineinbig',
      { orderType: 'dinein', table: '6' }));
  check('control: a $' + big.total.toFixed(2) + ' DINE-IN tab is still refused by the $30 ceiling',
    dineinBig.status === 400 && dineinBig.j && dineinBig.j.error === 'counter_over_cap',
    'status=' + dineinBig.status + ' body=' + JSON.stringify(dineinBig.j));

  /* ---- kitchen arm ----------------------------------------------------- */
  section('kitchen arm — an unpaid pickup/delivery order cannot be cooked');

  const pickupId = 'KP-PP-STRIPE-' + TOKEN;
  const heldPickup = await patch(BASE, pickupId, { status: 'preparing' });
  check('staff tapping PREPARING on the unpaid pickup order → REFUSED with unpaid_before_kitchen',
    heldPickup.status === 409 && heldPickup.j && heldPickup.j.error === 'unpaid_before_kitchen',
    'status=' + heldPickup.status + ' body=' + JSON.stringify(heldPickup.j));
  check('the refusal tells staff how to release it',
    !!(heldPickup.j && /(Re-check|Collected)/i.test(heldPickup.j.message || '')),
    'message=' + JSON.stringify(heldPickup.j && heldPickup.j.message));
  check('the order is still on the board, still received (a refusal writes nothing)',
    (await orderAt(BASE, pickupId) || {}).status === 'received');
  check('and no ticket was queued',
    readJobs(PRINT_FILE).filter((j) => j.orderId === pickupId).length === 0,
    'jobs=' + readJobs(PRINT_FILE).length);

  const deliveryId = 'KP-PP-DLV-' + TOKEN;
  const heldDelivery = await patch(BASE, deliveryId, { status: 'preparing' });
  check('staff tapping PREPARING on the unpaid DELIVERY → REFUSED with unpaid_before_kitchen',
    heldDelivery.status === 409 && heldDelivery.j && heldDelivery.j.error === 'unpaid_before_kitchen',
    'status=' + heldDelivery.status + ' body=' + JSON.stringify(heldDelivery.j));
  check('…and the hold names the delivery channel',
    heldDelivery.j && heldDelivery.j.channel === 'delivery',
    'channel=' + (heldDelivery.j && heldDelivery.j.channel));

  const collected = await patch(BASE, pickupId, { paymentStatus: 'paid' });
  check('marking it Collected (💵) is accepted',
    collected.status === 200 && collected.j && collected.j.ok === true,
    'status=' + collected.status + ' body=' + JSON.stringify(collected.j));

  const released = await patch(BASE, pickupId, { status: 'preparing' });
  check('and NOW the pickup order goes to the kitchen',
    released.status === 200 && released.j && released.j.status === 'preparing',
    'status=' + released.status + ' body=' + JSON.stringify(released.j));
  const jobs = await jobsWait(PRINT_FILE, pickupId, 1);
  check('with exactly one kitchen ticket', jobs.length === 1 && jobs[0].kind === 'kitchen',
    'jobs=' + JSON.stringify(jobs.map((j) => j.id)));
  check('and the ticket is real bytes', typeof jobs[0].bytes === 'string' && jobs[0].bytes.length > 100,
    jobs[0].bytes.length + ' base64 chars');

  /* Putting the money BACK to unconfirmed while re-saving 'preparing' is
     refused too: the gate judges the order the PATCH would create, not the one
     that is already stored. */
  const unpay = await patch(BASE, pickupId, { status: 'preparing', paymentStatus: 'counter' });
  check('re-saving it as UNPAID while it is in the kitchen → REFUSED (judged on the next state)',
    unpay.status === 409 && unpay.j && unpay.j.error === 'unpaid_before_kitchen',
    'status=' + unpay.status + ' body=' + JSON.stringify(unpay.j));
  check('…and the stored payment status was not overwritten by the refusal',
    (await orderAt(BASE, pickupId) || {}).paymentStatus === 'paid',
    'paymentStatus=' + (await orderAt(BASE, pickupId) || {}).paymentStatus);

  /* Control: dine-in cooks unpaid — that is the design, not a hole. */
  const dineinId = 'KP-PP-DINE-' + TOKEN;
  const dineinPrep = await patch(BASE, dineinId, { status: 'preparing' });
  check('control: the DINE-IN order cooks UNPAID',
    dineinPrep.status === 200 && dineinPrep.j && dineinPrep.j.status === 'preparing',
    'status=' + dineinPrep.status + ' body=' + JSON.stringify(dineinPrep.j));

  /* The legacy counter order: held exactly like a fresh one, released by the
     same tap. $16.95 — the retired threshold would have waved it through. */
  section('a legacy counter pickup order (pre-deploy data, $16.95)');
  const legacyHeld = await patch(BASE, LEGACY, { status: 'preparing' });
  check('held out of the kitchen the same way',
    legacyHeld.status === 409 && legacyHeld.j && legacyHeld.j.error === 'unpaid_before_kitchen',
    'status=' + legacyHeld.status + ' body=' + JSON.stringify(legacyHeld.j));
  const legacyPaid = await patch(BASE, LEGACY, { paymentStatus: 'paid' });
  check('released by Collected', legacyPaid.status === 200 && legacyPaid.j && legacyPaid.j.ok === true,
    'status=' + legacyPaid.status + ' body=' + JSON.stringify(legacyPaid.j));
  const legacyPrep = await patch(BASE, LEGACY, { status: 'preparing' });
  check('and then cooks', legacyPrep.status === 200 && legacyPrep.j && legacyPrep.j.status === 'preparing',
    'status=' + legacyPrep.status + ' body=' + JSON.stringify(legacyPrep.j));
  await jobsWait(PRINT_FILE, LEGACY, 1);
  check('with its ticket', readJobs(PRINT_FILE).filter((j) => j.orderId === LEGACY).length === 1);

  /* ---- no online method: the refusal stands, and says so honestly -------- */
  section('no card processing configured (second server, no Stripe key)');
  server2 = boot(PORT2, scratchEnv(SCRATCH2, PORT2, { STRIPE_SECRET_KEY: '' }));
  await waitForHealth(BASE2, 60);
  const nokeyMid = await price(BASE2, 'pickup', [BOWL, FRIES]);
  const nokey = await post(BASE2, orderFor('KP-PP-NOKEY-' + TOKEN, [BOWL, FRIES], nokeyMid, 'counter', 'nokey'));
  check('a counter pickup is STILL refused (the rule has no online-fallback carve-out)',
    nokey.status === 400 && nokey.j && nokey.j.error === 'counter_not_allowed',
    'status=' + nokey.status + ' body=' + JSON.stringify(nokey.j));
  check('…and the message phones the shop instead of pointing at a button that is not there',
    !!(nokey.j && /call /i.test(nokey.j.message || '')),
    'message=' + JSON.stringify(nokey.j && nokey.j.message));

  /* The order can still EXIST — an online order is written to the board before
     the guest pays. It just cannot be cooked until the money is confirmed,
     which on this server means a staff tap. */
  const nokeyOrder = await post(BASE2,
    orderFor('KP-PP-NOKEY-STRIPE-' + TOKEN, [BOWL, FRIES], nokeyMid, 'stripe', 'nokeystripe'));
  check('an online pickup order is still accepted without a Stripe key',
    nokeyOrder.status === 200 && nokeyOrder.j && nokeyOrder.j.ok === true,
    'status=' + nokeyOrder.status + ' body=' + JSON.stringify(nokeyOrder.j));
  const nokeyPrep = await patch(BASE2, 'KP-PP-NOKEY-STRIPE-' + TOKEN, { status: 'preparing' });
  check('but it is still held out of the kitchen until the money is confirmed',
    nokeyPrep.status === 409 && nokeyPrep.j && nokeyPrep.j.error === 'unpaid_before_kitchen',
    'status=' + nokeyPrep.status + ' body=' + JSON.stringify(nokeyPrep.j));
  const nokeyCollected = await patch(BASE2, 'KP-PP-NOKEY-STRIPE-' + TOKEN, { paymentStatus: 'paid' });
  const nokeyCook = await patch(BASE2, 'KP-PP-NOKEY-STRIPE-' + TOKEN, { status: 'preparing' });
  check('and a staff tap releases it on that server too',
    nokeyCollected.status === 200 && nokeyCook.status === 200 && nokeyCook.j.status === 'preparing',
    'collected=' + nokeyCollected.status + ' prep=' + nokeyCook.status);

  /* Dine-in is untouched by any of this, even with no online method at all. */
  const nokeyDine = await post(BASE2,
    orderFor('KP-PP-NOKEY-DINE-' + TOKEN, [BOWL, FRIES], nokeyMid, 'counter', 'nokeydine',
      { orderType: 'dinein', table: '7' }));
  check('control: DINE-IN still accepts pay-at-counter with no online method',
    nokeyDine.status === 200 && nokeyDine.j && nokeyDine.j.ok === true,
    'status=' + nokeyDine.status + ' body=' + JSON.stringify(nokeyDine.j));

  console.log('\n' + '='.repeat(78));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finish(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL  could not run probe: ' + e.message);
  finish(1);
});
