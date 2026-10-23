/* Integration probe: does the RUNNING server actually enforce the
 * pay-at-counter rules?
 *
 * The unit test (_dev/test_counter_cap.js) proves the RULES are right. This
 * proves the rules are WIRED IN — that handleCreateOrder really calls them. A
 * correct function nobody calls is the classic silent failure, and it is not
 * hypothetical here: the delivery feature once shipped half-wired, with the
 * channel switched on but the schedule checks never reached.
 *
 * It boots the real server on a scratch port, posts real orders, and checks
 * the HTTP status + error code. The rules covered:
 *   - the $30 ceiling (counter_over_cap) — now purely a TABLE-TAB rule, since
 *     the counter is dine-in only
 *   - the channel ban on delivery (counter_not_allowed)
 *   - and the interaction that makes the ceiling a table rule: the same big
 *     cart on PICKUP is refused by the channel rule, which sits in front of
 *     the ceiling, so the reason quoted is the one that actually applies
 *
 * It runs against SCRATCH files, not the shop's own orders.local.json. The
 * comment here used to claim "orders.local.json is backed up by the caller and
 * restored afterwards" — nothing of the sort happened, and every run quietly
 * left two junk orders on the owner's board. KPOT_ORDERS_FILE exists so a test
 * never has to touch real data. The delivery section below also switches the
 * channel on through the board's own endpoint, so KPOT_STORE_FILE and ADMIN_KEY
 * are set too — without them this probe would flip the owner's real
 * store.local.json and leave Delivery ON in the shop. Every other *_FILE the
 * server honours is pinned as well: hermeticity is per-FILE, and a probe that
 * pins only the files it remembers is how the shop's real discount codes got
 * clobbered once already.
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
const ADMIN = 'probe-cap-admin';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-cap-http-'));

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* One 'Hot Pot To Go' bowl is $15.99 (builder base price). `orderType` is a
   parameter because the ceiling's remaining job is DINE-IN: since 2026-10-22
   (owner's final decision) pay-at-counter is refused on pickup and delivery
   outright (counter_not_allowed) — so a pickup cart over $30 would be
   measuring the wrong rule. The pickup interaction is pinned below instead. */
function orderFor(qty, payMethod, token, orderType) {
  const unit = 15.99;
  const subtotal = round2(unit * qty);
  const tax = round2(subtotal * 0.06);
  const total = round2(subtotal + tax);
  return {
    no: 'KP-PROBE-' + token,
    token: 'probe-' + token,
    orderType: orderType || 'dinein',
    table: orderType === 'dinein' ? '7' : '',
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

function api(route, body, h) {
  return fetch(BASE + route, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, j: j })));
}
const post = (body) => api('/api/orders', body);
const getJSON = (route) => fetch(BASE + route).then((r) => r.json().catch(() => null));

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
    KPOT_CREDITS_FILE: path.join(SCRATCH, 'credits.local.json'),
    KPOT_PRINT_FILE: path.join(SCRATCH, 'print.local.json'),
    /* The delivery section below flips the channel switch through the board's
       own endpoint — that writes this file, so it MUST be a scratch one. */
    KPOT_STORE_FILE: path.join(SCRATCH, 'store.local.json'),
    KPOT_MENU_FILE: path.join(SCRATCH, 'menu.local.json'),
    KPOT_SECRETS_FILE: path.join(SCRATCH, 'secrets.local.json'),
    KPOT_DISCOUNTS_FILE: path.join(SCRATCH, 'discounts.local.json'),
    KPOT_APPLE_PAY_FILE: path.join(SCRATCH, 'apple-domain-association'),
    KPOT_GIVEAWAY_OUTBOX: path.join(SCRATCH, 'giveaway-mail-outbox.jsonl'),
    /* 24h open: this suite posts pay-at-counter orders, and /api/orders now
       refuses those outside opening hours. The clock must not decide these
       cases. See hoursSpec() in server.js. */
    KPOT_HOURS_SPEC: '{"openMinute":0,"closeSunThu":1440,"closeFriSat":1440}',
    ADMIN_KEY: ADMIN,
    /* Set (and different) so the server does not log the "ADMIN_KEY set but
       PRINT_KEY not" warning and lock the print endpoint in this run. */
    PRINT_KEY: ADMIN + '-print',
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

/* ---- pay at the counter on DELIVERY -------------------------------------
   A delivery leaves the building: no counter to walk up to, nothing to
   collect afterwards. So the order must be prepaid, and the refusal has to
   come from the SERVER — the guest page only greys the option out.

   Everything here is server-derived on purpose: the channel is switched on
   through the board's own endpoint, the day and window come from /api/schedule,
   and the money comes from /api/price. Nothing is invented locally, so the
   probe cannot pass by agreeing with itself (and total_mismatch, which runs
   before this rule, cannot trip it). */
async function probeDeliveryBan() {
  const adminH = { 'X-Admin-Key': ADMIN };

  const on = await api('/api/store', { orderTypes: { delivery: true } }, adminH);
  check('the owner can switch Delivery on from the board',
    on.status === 200 && on.j && on.j.orderTypes && on.j.orderTypes.delivery === true,
    'status=' + on.status + ' body=' + JSON.stringify(on.j));

  const sched = await getJSON('/api/schedule');
  const day = sched && sched.days && sched.days[0];
  if (!day) {
    check('a bookable delivery day exists', false, JSON.stringify(sched));
    return;
  }
  const dayView = await getJSON('/api/schedule?date=' + encodeURIComponent(day.iso));
  const slot = ((dayView && dayView.slots) || []).find((s) => !s.full && !s.outsideHours);
  if (!slot) {
    check('a usable delivery window exists', false, JSON.stringify(dayView));
    return;
  }

  const items = [{ kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, unit: 15.99, mods: [], addons: [], note: '' }];
  const price = await api('/api/price', { orderType: 'delivery', items: items, tipAmount: 0 });
  check('the server can price a delivery order', price.status === 200 && !!price.j, JSON.stringify(price.j));
  if (price.status !== 200 || !price.j) return;

  /* Money is the SERVER's, never a number invented here — and taking it from
     /api/price means this probe keeps working whatever the delivery fee is
     (it is $0 right now, a promotion, not a permanent price). */
  const money = {
    subtotal: price.j.subtotal, deliveryFee: price.j.delivery,
    tax: price.j.tax, total: price.j.total
  };
  const dlOrder = (payMethod, token) => Object.assign({
    no: 'KP-PROBE-' + token,
    token: 'probe-' + token,
    orderType: 'delivery',
    table: '',
    customer: { name: 'Probe', phone: '', when: '' },
    items: items,
    tip: 0,
    surcharge: 0,
    payMethod: payMethod,
    paymentStatus: payMethod === 'counter' ? 'counter' : 'unverified',
    paid: false,
    source: 'probe',
    schedule: { date: day.iso, slot: slot.id }
  }, money);

  const bad = await post(dlOrder('counter', 'dlcounter'));
  check('delivery + pay-at-counter → REFUSED with counter_not_allowed',
    bad.status === 400 && bad.j && bad.j.error === 'counter_not_allowed' &&
      bad.j.channel === 'delivery',
    'status=' + bad.status + ' body=' + JSON.stringify(bad.j));
  check('the refusal tells the guest to pay online',
    !!(bad.j && /paid online/i.test(bad.j.message || '')),
    'message=' + JSON.stringify(bad.j && bad.j.message));

  /* The refusal must be about the METHOD, not about delivery: the same order
     paid online has to go through. Without this, a bug that refused EVERY
     delivery order would still pass the check above. */
  const good = await post(dlOrder('stripe', 'dlstripe'));
  check('the same delivery paid online → accepted',
    good.status === 200 && good.j && good.j.ok === true,
    'status=' + good.status + ' body=' + JSON.stringify(good.j));
}

waitForHealth(60)
  .then(() => {
    console.log('server up on ' + BASE + '\n');
    /* A SMALL pickup counter order — $16.95, under every ceiling the shop has
       ever had — must still be refused, because the rule is about the
       CHANNEL now, not the size. This is the check that would have passed
       under the retired $20 threshold. */
    return post(orderFor(1, 'counter', 'small', 'pickup')).then((r) => {
      check('counter $16.95 pickup → REFUSED with counter_not_allowed (size is irrelevant)',
        r.status === 400 && r.j && r.j.error === 'counter_not_allowed' &&
          r.j.channel === 'pickup',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      /* The interaction: the channel rule sits IN FRONT of the ceiling, so a
         big pickup order is refused for the channel, not for its size. */
      return post(orderFor(3, 'counter', 'bigpickup', 'pickup'));
    }).then((r) => {
      /* $50.85 — over the ceiling too, but the channel rule answers first. */
      check('counter $50.85 pickup → REFUSED for the CHANNEL, not the ceiling',
        r.status === 400 && r.j && r.j.error === 'counter_not_allowed',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      check('…and the guest is never told about the $30 cap here',
        !!(r.j && !/over \$30/i.test(r.j.message || '')),
        'message=' + JSON.stringify(r.j && r.j.message));
      return post(orderFor(3, 'counter', 'big'));
    }).then((r) => {
      /* $50.85 on dine-in — over the $30 ceiling, must be REFUSED by it. */
      check('counter $50.85 dine-in (over cap) → REFUSED with counter_over_cap',
        r.status === 400 && r.j && r.j.error === 'counter_over_cap',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      check('refusal names the cap and the total',
        r.j && r.j.cap === 30 && r.j.total === 50.85,
        'cap=' + (r.j && r.j.cap) + ' total=' + (r.j && r.j.total));
      check('refusal tells the guest what to do',
        !!(r.j && /paid online/i.test(r.j.message || '')),
        'message=' + JSON.stringify(r.j && r.j.message));
      /* The same size order paid online is fine — it is prepaid, so neither
         the ceiling nor the channel rule has anything to say about it. */
      return post(orderFor(3, 'stripe', 'bigstripe', 'pickup'));
    }).then((r) => {
      check('stripe $50.85 (over cap) → accepted (prepaid, cap does not apply)',
        r.status === 200 && r.j && r.j.ok === true,
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      /* Control: a dine-in order between the two thresholds pays at the
         counter — the pickup rule must not touch it. */
      return post(orderFor(1, 'counter', 'dinein20'));
    }).then((r) => {
      check('control: counter $16.95 dine-in → accepted (the counter is dine-in only, and this is dine-in)',
        r.status === 200 && r.j && r.j.ok === true,
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      /* Exactly at the ceiling — must be allowed. */
      return post(orderFor(2, 'counter', 'exact'));
    }).then((r) => {
      check('counter $33.90 dine-in (over cap) → refused',
        r.status === 400 && r.j && r.j.error === 'counter_over_cap',
        'status=' + r.status + ' body=' + JSON.stringify(r.j));
      console.log('\n--- pay at the counter on DELIVERY ---');
      return probeDeliveryBan();
    }).then(() => {
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
