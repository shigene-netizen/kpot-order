/* Integration probe: does the RUNNING server actually honour a monthly
 * membership?
 *
 * _dev/test_member.js proves the rules are right. This proves the server WIRED
 * THEM IN — that a member really gets 5% off, that a cancelled member stops
 * getting it, that the points multiplier comes from the ledger and NOT from the
 * order payload, and that a member discount and a discount code cannot both
 * ride on one bill.
 *
 * The one worth reading twice: the multiplier. A guest who POSTs
 * {loyalty:{pointsMultiplier:50}} must be ignored, exactly as a guest who POSTs
 * {paymentStatus:'verified'} must be ignored. The membership is a fact about
 * the ledger, not a claim in the payload. probe_loyalty.js already pins the
 * payment half of that rule down; this pins the multiplier half.
 *
 * Everything runs against SCRATCH files, never the shop's own.
 *
 * Run:  node _dev/probe_member.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8961;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-member-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-member-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The shop's real number, so the tests read like the counter. */
const PHONE = '6783355388';
const OTHER = '4045550199';
const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}

function headers(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}
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
const post = (route, body, h) => req('POST', route, body, h);
const get = (route, h) => req('GET', route, null, h);
const patch = (route, body) => req('PATCH', route, body, adminH());

const priceBody = (items, loyalty, couponCode, orderType) => {
  const b = { orderType: orderType || 'pickup', items: items, tipAmount: 0 };
  /* Every loyalty request carries this device's credential, exactly as the
     guest page does. Until one has been collected it is the empty string and
     the server refuses the spend — a boundary probe_device_auth.js pins in
     full, so this probe does not assert it twice. */
  if (loyalty) b.loyalty = Object.assign({ device: DEVICE }, loyalty);
  if (couponCode) b.couponCode = couponCode;
  return b;
};
const orderFor = (no, total, extra) => Object.assign({
  no: no,
  token: 'mem-' + no,
  orderType: 'pickup',
  table: '',
  customer: { name: 'Bob Smith', phone: '(678) 335-5388' },
  items: [HOTPOT],
  subtotal: 15.99,
  deliveryFee: 0,
  tax: 0.96,
  tip: 0,
  surcharge: 0,
  total: total,
  payMethod: 'counter',
  paymentStatus: 'counter',
  paid: false,
  source: 'probe'
}, extra || {});
/* ---- The membership credential -----------------------------------------
   A phone number no longer reads or spends an account on its own
   (probe_device_auth.js pins that boundary in full). This probe is about the
   EARNING rules, so it has to hold a credential, just as a real guest's
   browser does.

   It cannot claim one off an order the way probe_loyalty.js does: membership
   is enrolled at the counter through `adjust`, so there is no order to claim.
   It uses the counter's OWN recovery path instead — the owner mints a code
   with `issueCode: true`, the guest trades it at /api/recovery/verify — which
   is exactly the door a real guest with no e-mail on file walks through. */
let DEVICE = '';
const dev = () => (DEVICE ? '&device=' + encodeURIComponent(DEVICE) : '');
function unlockWithCode() {
  /* Deliberately returns false rather than throwing. A thrown harness hides
     the blast radius — the whole point of red-verifying this is to see how
     many later assertions a broken unlock drags down with it. */
  return post('/api/customers/adjust', { phone: PHONE, issueCode: true, note: 'probe unlock' }, adminH())
    .then((r) => {
      const code = r.j && r.j.recoveryCode;
      if (!code) return false;
      return post('/api/recovery/verify', { phone: PHONE, code: code });
    })
    .then((r) => {
      if (r && r.status === 200 && r.j && r.j.device) { DEVICE = r.j.device; return true; }
      return false;
    });
}

const member = () => get('/api/customer?phone=' + encodeURIComponent(PHONE) + dev());
const membersAdmin = () => get('/api/customers', adminH());

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    PRINT_KEY: 'probe-print-key',
    KPOT_FLUSH_MS: '1000',
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

waitForHealth(80).then(() => {
  console.log('server up on ' + BASE + '\n');
  check('the server did NOT start with the shop\'s live key',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* ---- the published rules ---- */
  return get('/api/customers', adminH());
}).then((r) => {
  check('the member list works with the key', r.status === 200, 'status=' + r.status);
  check('and publishes the member rules',
    r.j && r.j.memberRules && r.j.memberRules.percent === 5,
    JSON.stringify(r.j && r.j.memberRules));
  check('with the fee the owner set', r.j && r.j.memberRules.fee === 9.99);
  check('and the 2x multiplier', r.j && r.j.memberRules.pointsMultiplier === 2);

  /* ---- earn the credential the way a guest with no e-mail must ----
     Everything past this point presents it, so if the unlock breaks every
     later assertion goes red together — which is exactly what should happen. */
  return unlockWithCode().then((ok) => {
    check('a guest with no e-mail unlocks with a counter-issued code', ok === true);
    return post('/api/customers/adjust', { phone: PHONE, member: 'confirm', note: 'probe enrolment' }, adminH());
  });
}).then((r) => {
  check('enrolling a member needs no prior ledger entry',
    r.status === 200 && r.j && r.j.customer.memberUntil, 'status=' + r.status + ' ' + JSON.stringify(r.j));
  const until = Date.parse(r.j.customer.memberUntil);
  check('and gives them 30 days',
    Math.round((until - Date.now()) / 86400000) >= 29 && Math.round((until - Date.now()) / 86400000) <= 30,
    'until=' + r.j.customer.memberUntil);
  check('and the view reports them as a member',
    r.j.customer.member === true, JSON.stringify(r.j.customer.member));

  /* A wallet was minted for the period. */
  check('and a reward went into their wallet',
    r.j.customer.coupons.length === 1, 'coupons=' + r.j.customer.coupons.length);
  check('of member kind', r.j.customer.coupons[0].kind === 'member');
  check('worth $5', r.j.customer.coupons[0].value === 5);
  check('and it expires (it is not a forever coupon)',
    r.j.customer.coupons[0].expiresAt !== null);

  /* ---- the owner tapping twice ---- */
  return post('/api/customers/adjust', { phone: PHONE, member: 'confirm' }, adminH());
}).then((r) => {
  check('tapping renew a second time in the same period says so',
    r.status === 200 && r.j && r.j.member === 'already_current',
    'status=' + r.status + ' ' + JSON.stringify(r.j));
  check('and mints NO second coupon',
    r.j && r.j.customer.coupons.length === 1,
    'coupons=' + (r.j && r.j.customer.coupons.length));

  /* ---- the bare number must NOT be enough ----
     Paired with the unlocked read immediately below. This is the exact
     vulnerability the owner found, pinned at the HTTP layer: knowing a mobile
     number buys you the fact that an account exists, and nothing else. */
  return get('/api/customer?phone=' + encodeURIComponent(PHONE));
}).then((r) => {
  check('a bare phone number does not identify the account',
    r.j && r.j.identified === false && r.j.found === true, JSON.stringify(r.j));
  check('and hands back no points, no rewards and not even the name',
    r.j && r.j.points === 0 && (r.j.coupons || []).length === 0 && r.j.name === undefined,
    JSON.stringify(r.j));
  check('but does confirm rewards are waiting, so the guest can self-serve',
    r.j && r.j.hasRewards === true, JSON.stringify(r.j));
  return member();
}).then((r) => {
  check('the guest sees they are a member', r.j && r.j.member.is === true, JSON.stringify(r.j && r.j.member));
  check('with days left', r.j && r.j.member.daysLeft >= 29, String(r.j && r.j.member.daysLeft));

  /* ---- the discount is real money ----
     $15.99 of hot pot, 5% off = $0.80. The tax is charged on what is LEFT
     ($15.19), because the guest should not pay tax on money they did not
     spend: 6% of 15.19 = $0.91. Total = 15.19 + 0.91 = $16.10. */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_percent' }));
}).then((r) => {
  check('a member gets 5% off the $15.99 hot pot',
    r.j && r.j.discount === 0.8, JSON.stringify(r.j));
  check('and tax is recalculated on the discounted amount',
    r.j && r.j.tax === 0.91, 'tax=' + (r.j && r.j.tax) + ' (expected 0.91 = 6% of 15.19)');
  check('so the total is $16.10', r.j && r.j.total === 16.1, 'total=' + (r.j && r.j.total));
  check('labelled for the guest', /Member 5% off/.test(r.j && r.j.discountLabel),
    'label=' + (r.j && r.j.discountLabel));
  check('and marked as a member discount, not a code',
    r.j && r.j.discountSource === 'member', 'source=' + (r.j && r.j.discountSource));

  /* ---- the fourth benefit: free delivery ----
     The FEE itself is a CONFIG decision (assets/config.js `delivery.fee`), and
     this shop's config has the delivery channel switched off — so there is no
     fee to waive here. _dev/test_member.js pins the rule itself ("a delivery
     order gets TWO member options", fee 4.99). What the HTTP layer must still
     get right is the shape of a perk that does not apply: refusing it, rather
     than silently pricing a $0 discount the guest thinks is a bargain. */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_freeship' }, null, 'delivery'));
}).then((r) => {
  check('with no delivery fee to waive, free delivery is refused',
    r.status === 409 && r.j && r.j.error === 'member_unavailable',
    'status=' + r.status + ' ' + JSON.stringify(r.j));
  check('and nothing was given away',
    r.j === undefined || r.j.discount === undefined || r.j.discount === 0, JSON.stringify(r.j));

  /* ---- a member discount and a code cannot both ride ----
     A REAL code, not a typo: resolveCoupon() runs first and a mistyped code
     is reported on its own, so 'ANYCODE' would only ever prove that. */
  return post('/api/discounts', { codes: [{ code: 'MEMBERPROBE', type: 'amount', value: 2 }] }, adminH());
}).then((r) => {
  check('the owner can publish a discount code',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));

  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_percent' }, 'MEMBERPROBE'));
}).then((r) => {
  check('a code AND a member perk together are refused',
    r.status === 409 && r.j && r.j.error === 'one_discount_only',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ---- points and a member perk cannot both ride either ---- */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_percent', redeemPoints: true }));
}).then((r) => {
  check('points AND a member perk together are refused',
    r.status === 409 && r.j && r.j.error === 'one_reward_only',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ---- a non-member cannot claim the perk ---- */
  return post('/api/price', priceBody([HOTPOT], { phone: OTHER, memberChoice: 'member_percent' }));
}).then((r) => {
  check('a number with no member record is refused',
    r.status === 409 && r.j && r.j.error === 'unknown_customer',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ---- an invented choice string is refused, not ignored ---- */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_ninety_percent' }));
}).then((r) => {
  check('an invented member perk is refused, not silently ignored',
    r.status === 409 && r.j && r.j.error === 'member_unavailable',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ======================================================================
     THE EARN PATH. The 2x multiplier is read off the LEDGER at award time,
     never off the order payload. A pay-at-counter order earns nothing until
     a staff member taps Collected — the same rule probe_loyalty.js pins.
     ====================================================================== */
  return post('/api/price', priceBody([HOTPOT])).then((p) => {
    const total = p.j && p.j.total;
    return post('/api/orders', orderFor('KP-MEM-1', total, {
      /* The forged claim: an order payload insisting it earns 50x. The server
         must not read this — the multiplier is a fact about the membership. */
      loyalty: { pointsMultiplier: 50 }
    })).then((o) => ({ o: o, total: total }));
  });
}).then((res) => {
  const o = res.o;
  check('a pay-at-counter order is accepted',
    o.status === 200 && o.j && o.j.ok === true, 'status=' + o.status + ' ' + JSON.stringify(o.j));

  return member().then((m) => {
    check('an unpaid order earns nothing yet',
      m.j && m.j.points === 0, 'points=' + (m.j && m.j.points));
    return patch('/api/orders/' + encodeURIComponent(o.j.id), { paymentStatus: 'paid' });
  }).then(() => member());
}).then((r) => {
  /* $15.99 of food earns 15 points for everyone. A 2x member earns 30 — and
     the forged 50 in the payload bought them nothing. */
  check('the SETTLED order earns 2x the points (30, not 750)',
    r.j && r.j.points === 30, 'points=' + (r.j && r.j.points) + ' (expected 30 = floor(15.99) * 2)');

  return membersAdmin().then((m) => {
    const row = m.j && m.j.customers && m.j.customers[0];
    check('the ledger itself records the honest figure',
      row && row.lifetimePoints === 30, JSON.stringify(row));
    return post('/api/customers/adjust', { phone: PHONE, member: 'cancel' }, adminH());
  });
}).then((r) => {
  check('cancelling the membership works',
    r.status === 200 && r.j && r.j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.j));
  return membersAdmin();
}).then((r) => {
  const row = r.j && r.j.customers && r.j.customers[0];
  check('the ledger stops counting them as a member',
    row && row.member === false && row.memberUntil === null, JSON.stringify(row));
  return member();
}).then((r) => {
  check('the guest is no longer a member',
    r.j && r.j.member.is === false, JSON.stringify(r.j && r.j.member));

  /* The perk is gone with the membership. */
  return post('/api/price', priceBody([HOTPOT], { phone: PHONE, memberChoice: 'member_percent' }));
}).then((r) => {
  check('a cancelled member cannot claim the perk',
    r.status === 409 && r.j && r.j.error === 'member_unavailable',
    'status=' + r.status + ' ' + JSON.stringify(r.j));

  /* ...and the multiplier went with it: the next settled order earns 1x. */
  return post('/api/price', priceBody([HOTPOT])).then((p) => {
    return post('/api/orders', orderFor('KP-MEM-2', p.j.total, {
      loyalty: { pointsMultiplier: 50 }
    }));
  });
}).then((o) => {
  check('a second order is accepted',
    o.status === 200 && o.j && o.j.ok === true, 'status=' + o.status + ' ' + JSON.stringify(o.j));
  return patch('/api/orders/' + encodeURIComponent(o.j.id), { paymentStatus: 'paid' }).then(() => member());
}).then((r) => {
  check('without the membership it earns plain points (45 = 30 + 15)',
    r.j && r.j.points === 45, 'points=' + (r.j && r.j.points));
  check('the forged multiplier never once applied',
    r.j && r.j.points !== 30 + 750, 'points=' + (r.j && r.j.points));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finish(fail ? 1 : 0);
}).catch((e) => { console.log('  FAIL  harness threw: ' + e.message + '\n' + serverLog); finish(1); });
