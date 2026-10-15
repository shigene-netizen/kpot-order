/* Integration probe: scheduled (next-day, windowed) delivery.
 *
 * _dev/test_schedule.js proves the RULES (schedule.js) are right. This proves
 * the RUNNING server WIRED THEM IN, and pins the two things that make a
 * windowed order different from every other order:
 *
 *   1. A scheduled delivery order does NOT auto-prepare — even with kitchen
 *      automation switched ON — until its window arrives. Printing hangs off
 *      the status->preparing transition, so the ticket waits with it without
 *      the print queue knowing anything about schedules.
 *   2. The channel switch the owner flips on the board is ALSO the schedule
 *      gate. This shop ships with delivery.enabled:false, so the probe must
 *      turn Delivery on at RUNTIME before the scheduler will answer with
 *      anything but "delivery is not taking orders".
 *
 * The contract below was read off server.js, not guessed:
 *   POST /api/orders { schedule:{date,slot} }
 *     pickup + a window          -> 400 schedule_not_delivery
 *     delivery, no window        -> 400 schedule_required
 *     resolveSchedule refusal    -> 409 <error>
 *   total_mismatch (400) runs FIRST, so every order carries the server's own
 *   total (POST /api/price), never a number invented here.
 *
 * Everything runs against SCRATCH files, never the shop's own.
 *
 * Run:  node _dev/probe_schedule.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8963;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-schedule-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-schedule-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}

function headers(extra) { return Object.assign({ 'Content-Type': 'application/json' }, extra || {}); }
const adminH = () => headers({ 'X-Admin-Key': ADMIN });

function req(method, route, body, h) {
  return fetch(BASE + route, {
    method, headers: h || headers(), body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.text().then((t) => {
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, j: j };
  }));
}
const get = (route, h) => req('GET', route, null, h);
const post = (route, body, h) => req('POST', route, body, h);
const patch = (route, body) => req('PATCH', route, body, adminH());

/* Local YYYY-MM-DD, exactly as schedule.js builds it — the server and this
   probe share one machine and one timezone. */
function dateKey(ms) {
  const d = new Date(ms);
  return String(d.getFullYear()).padStart(4, '0') + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const priceBody = (orderType) => ({ orderType: orderType, items: [HOTPOT], tipAmount: 0 });
const orderFor = (no, total, extra) => Object.assign({
  no: no,
  token: 'sched-' + no,
  orderType: 'delivery',
  table: '',
  customer: { name: 'Alex Smith', phone: '(404) 555-0199' },
  items: [HOTPOT],
  subtotal: 0, deliveryFee: 0, tax: 0, tip: 0, surcharge: 0,
  total: total,
  payMethod: 'counter',
  paymentStatus: 'counter',
  paid: false,
  source: 'probe'
}, extra || {});

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'probe-print-key',
    KPOT_FLUSH_MS: '2000',
    KPOT_STRIPE_API_BASE: 'http://127.0.0.1:9',
    KPOT_ORDERS_FILE: path.join(SCRATCH, 'orders.local.json'),
    KPOT_CUSTOMERS_FILE: path.join(SCRATCH, 'customers.local.json'),
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups')
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
}
function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}
const adminOrders = () => get('/api/orders', adminH());

async function main() {
  await waitForHealth(80);
  console.log('server up on ' + BASE + '\n');
  check('the server did NOT start with the shop\'s live key',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* ======================================================================
     THE CHANNEL SWITCH IS THE SCHEDULE GATE
     ====================================================================== */
  const initial = await get('/api/schedule');
  check('with the shipped config, Delivery is OFF at runtime',
    initial.j && initial.j.enabled === false,
    'enabled=' + (initial.j && initial.j.enabled));

  /* Turn the channel on AT RUNTIME — exactly what the owner's board does. */
  const on = await post('/api/store', { orderTypes: { delivery: true } }, adminH());
  check('the owner can switch Delivery on from the board',
    on.status === 200 && on.j && on.j.orderTypes && on.j.orderTypes.delivery === true,
    'status=' + on.status + ' ' + JSON.stringify(on.j && on.j.orderTypes));

  /* Automation ON, so the "a future order waits" rule is actually exercised. */
  const autoOn = await post('/api/store', { autoPrepare: true }, adminH());
  check('and can turn auto-start-cooking on too',
    autoOn.status === 200 && autoOn.j && autoOn.j.autoPrepare === true,
    'status=' + autoOn.status + ' ' + JSON.stringify(autoOn.j));

  /* ======================================================================
     /api/schedule — the picker, now that Delivery is live
     ====================================================================== */
  const sched = await get('/api/schedule');
  check('the schedule is now public and enabled',
    sched.status === 200 && sched.j.enabled === true, 'status=' + sched.status);
  check('it publishes the delivery fee', typeof sched.j.fee === 'number', 'fee=' + sched.j.fee);
  check('and the per-window cap', sched.j.perDayPerSlot > 0, 'cap=' + sched.j.perDayPerSlot);
  check('and the booking horizon', sched.j.maxDaysAhead >= 1, 'maxDaysAhead=' + sched.j.maxDaysAhead);
  check('and offers at least one bookable day',
    Array.isArray(sched.j.days) && sched.j.days.length >= 1, 'days=' + JSON.stringify(sched.j.days));

  const day = sched.j.days[0];
  check('the first bookable day is TOMORROW, never today',
    day && day.daysAhead === 1, JSON.stringify(day));

  const dayInfo = await get('/api/schedule?date=' + encodeURIComponent(day.iso));
  check('asking for a day returns its windows',
    dayInfo.status === 200 && Array.isArray(dayInfo.j.slots), JSON.stringify(dayInfo.j && dayInfo.j.date));
  check('and confirms the shop is open that day', dayInfo.j.open === true, 'open=' + dayInfo.j.open);

  const usable = (dayInfo.j.slots || []).find((s) => !s.full && !s.outsideHours);
  check('at least one window is pickable', !!usable, JSON.stringify(dayInfo.j.slots));
  check('a fresh window reports full head-room',
    usable && usable.used === 0 && usable.remaining === usable.cap && usable.cap > 0,
    JSON.stringify(usable));

  /* ======================================================================
     SERVER-DERIVED TOTALS (total_mismatch runs before the schedule checks)
     ====================================================================== */
  const dPrice = await post('/api/price', priceBody('delivery'));
  const pPrice = await post('/api/price', priceBody('pickup'));
  check('the server can price a delivery order',
    dPrice.status === 200 && typeof dPrice.j.total === 'number', JSON.stringify(dPrice.j));
  const dTotal = dPrice.j.total;
  const pTotal = pPrice.j.total;
  /* The runtime channel switch, not the static config seed, decides the fee:
     the board turns Delivery on, and the guest must be charged for it. Under
     the old static-config read this equality held (fee priced $0) — so this
     assertion is what pins deliveryPricingOpts() into the pricer. */
  check('and charges the delivery fee while the channel is on (runtime switch, not the static seed)',
    dTotal > pTotal, 'delivery=' + dTotal + ' pickup=' + pTotal);

  /* ======================================================================
     THE FOUR CREATE-ORDER CHECKS
     ====================================================================== */
  const nd = await post('/api/orders', orderFor('SCH-ND', pTotal, {
    orderType: 'pickup', schedule: { date: day.iso, slot: usable.id }
  }));
  check('a pickup order carrying a delivery window is refused',
    nd.status === 400 && nd.j && nd.j.error === 'schedule_not_delivery',
    'status=' + nd.status + ' ' + JSON.stringify(nd.j));

  const nr = await post('/api/orders', orderFor('SCH-NR', dTotal, { orderType: 'delivery' }));
  check('a delivery order with no day/window is refused',
    nr.status === 400 && nr.j && nr.j.error === 'schedule_required',
    'status=' + nr.status + ' ' + JSON.stringify(nr.j));

  const bd = await post('/api/orders', orderFor('SCH-BD', dTotal, {
    schedule: { date: '2026-02-30', slot: usable.id }
  }));
  check('a day that does not exist is refused (not rolled to Mar 2)',
    bd.status === 409 && bd.j && bd.j.error === 'bad_date',
    'status=' + bd.status + ' ' + JSON.stringify(bd.j));

  const bs = await post('/api/orders', orderFor('SCH-BS', dTotal, {
    schedule: { date: day.iso, slot: 'midnight' }
  }));
  check('an invented window is refused',
    bs.status === 409 && bs.j && bs.j.error === 'bad_slot',
    'status=' + bs.status + ' ' + JSON.stringify(bs.j));

  const soon = await post('/api/orders', orderFor('SCH-SOON', dTotal, {
    schedule: { date: dateKey(Date.now()), slot: usable.id }
  }));
  check('booking for today is refused',
    soon.status === 409 && soon.j && soon.j.error === 'date_too_soon',
    'status=' + soon.status + ' ' + JSON.stringify(soon.j));

  const farKey = dateKey(Date.now() + (sched.j.maxDaysAhead + 1) * 86400000);
  const far = await post('/api/orders', orderFor('SCH-FAR', dTotal, {
    schedule: { date: farKey, slot: usable.id }
  }));
  check('booking past the horizon is refused',
    far.status === 409 && far.j && far.j.error === 'date_too_far',
    'status=' + far.status + ' ' + JSON.stringify(far.j));

  /* ======================================================================
     A VALID NEXT-DAY ORDER — and it does NOT start cooking
     ====================================================================== */
  const ok1 = await post('/api/orders', orderFor('SCH-OK-1', dTotal, {
    schedule: { date: day.iso, slot: usable.id }
  }));
  check('a valid next-day order is accepted',
    ok1.status === 200 && ok1.j && ok1.j.ok === true,
    'status=' + ok1.status + ' ' + JSON.stringify(ok1.j));
  const id1 = ok1.j && ok1.j.id;

  const board = await adminOrders();
  const o1 = (board.j.orders || []).find((o) => o.id === id1);
  check('the board shows it against the chosen day and window',
    o1 && o1.deliveryDate === day.iso && o1.deliverySlot === usable.id,
    JSON.stringify(o1 && { d: o1.deliveryDate, s: o1.deliverySlot }));
  check('with a scheduledFor timestamp in the future',
    o1 && Date.parse(o1.scheduledFor) > Date.now(), o1 && o1.scheduledFor);
  check('and it is NOT cooking yet, even with automation ON',
    o1 && o1.status === 'received', 'status=' + (o1 && o1.status));

  /* ======================================================================
     CAPACITY — the window fills, then closes
     ====================================================================== */
  const after1 = await get('/api/schedule?date=' + encodeURIComponent(day.iso));
  const slot1 = (after1.j.slots || []).find((s) => s.id === usable.id);
  check('the window shows one seat taken',
    slot1 && slot1.used === 1 && slot1.remaining === slot1.cap - 1,
    JSON.stringify(slot1));

  let last = null;
  for (let i = 2; i <= usable.cap; i++) {
    last = await post('/api/orders', orderFor('SCH-FILL-' + i, dTotal, {
      schedule: { date: day.iso, slot: usable.id }
    }));
  }
  check('the window can be filled to its cap',
    last && last.status === 200, 'status=' + (last && last.status) + ' ' + JSON.stringify(last && last.j));

  const overflow = await post('/api/orders', orderFor('SCH-OVER', dTotal, {
    schedule: { date: day.iso, slot: usable.id }
  }));
  check('the next guest is told the window is FULL (not silently overbooked)',
    overflow.status === 409 && overflow.j && overflow.j.error === 'slot_full',
    'status=' + overflow.status + ' ' + JSON.stringify(overflow.j));

  /* ======================================================================
     MOVING A WINDOW — and re-picking the SAME one is not "already there"
     ====================================================================== */
  const other = (dayInfo.j.slots || []).find((s) => s.id !== usable.id && !s.outsideHours);
  if (other) {
    const mv = await patch('/api/orders/' + encodeURIComponent(id1), {
      schedule: { date: day.iso, slot: other.id }
    });
    check('staff can move a booked order to another window',
      mv.status === 200 && mv.j && mv.j.ok === true,
      'status=' + mv.status + ' ' + JSON.stringify(mv.j));

    const again = await patch('/api/orders/' + encodeURIComponent(id1), {
      schedule: { date: day.iso, slot: other.id }
    });
    check('re-picking the window it is already in is refused only if truly full (self excluded)',
      again.status === 200, 'status=' + again.status + ' ' + JSON.stringify(again.j));

    const moved = await adminOrders();
    const oMoved = (moved.j.orders || []).find((o) => o.id === id1);
    check('the board reflects the new window',
      oMoved && oMoved.deliverySlot === other.id, JSON.stringify(oMoved && oMoved.deliverySlot));
  } else {
    check('(skipped the move test — only one usable window configured)', true);
  }

  /* ======================================================================
     SWITCHING DELIVERY OFF TAKES THE WHOLE THING DOWN
     ====================================================================== */
  await post('/api/store', { orderTypes: { delivery: false } }, adminH());
  const off = await get('/api/schedule');
  check('switching Delivery off takes the picker down too',
    off.j && off.j.enabled === false, 'enabled=' + (off.j && off.j.enabled));

  const dPriceOff = await post('/api/price', priceBody('delivery'));
  const blocked = await post('/api/orders', orderFor('SCH-OFF', dPriceOff.j.total, {
    schedule: { date: day.iso, slot: usable.id }
  }));
  check('and a delivery order is refused while the channel is off',
    blocked.status === 409 && blocked.j && blocked.j.error === 'delivery_unavailable',
    'status=' + blocked.status + ' ' + JSON.stringify(blocked.j));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finish(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL  harness threw: ' + e.message + '\n' + serverLog);
  finish(1);
});
