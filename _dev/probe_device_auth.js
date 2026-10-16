/* Integration probe: can a stranger spend your rewards with just your phone
 * number?
 *
 * THE BUG THIS EXISTS FOR
 * The account IS the mobile number, and the checkout is a public web form. So
 * before this, POST /api/price took `loyalty.phone` straight out of the
 * request body and resolved it against the ledger — meaning anyone who knew a
 * guest's number could put an order in their name and take the $5 off it, and
 * GET /api/customer would read back their balance and their coupons. No
 * account, no password, no proof of anything.
 *
 * THE FIX, AND WHAT IS ASSERTED HERE
 * A phone number identifies; it does not authorise. Two things authorise, and
 * both are proven end to end over real HTTP:
 *
 *   1. a DEVICE CREDENTIAL, minted for one browser when it collects a PAID
 *      order it created itself (it must present the claim secret it generated
 *      at checkout — a hash of it is all the server keeps);
 *   2. a RECOVERY CODE, mailed to the address on the account, single-use.
 *
 * Every "locked" assertion below is paired with the unlocked one, because a
 * gate that refuses everything is not a fix, it is an outage.
 *
 * The mail never leaves the machine: a throwaway SMTP server on localhost
 * stands in for Gmail (see fake_smtp.js). run_all.sh fingerprints the shop's
 * real data files; this probe also uses scratch files for everything.
 *
 * Run:  node _dev/probe_device_auth.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SMTP = require('./fake_smtp.js');

const ROOT = path.dirname(__dirname);
const PORT = 8951;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-device-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-device-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Bob is the guest whose rewards are worth stealing. Carol and Dave are the
   strangers. */
const BOB = '6783355388';
const CAROL = '4045550111';
const DAVE = '4045550222';
const ERIN = '4045550333';

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };
const SUBTOTAL = 15.99, TAX = 0.96, TOTAL = 16.95;

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

const newClaim = () => crypto.randomBytes(32).toString('hex');

const priceBody = (loyalty) => {
  const b = { orderType: 'pickup', items: [HOTPOT], tipAmount: 0 };
  if (loyalty) b.loyalty = loyalty;
  return b;
};

const orderFor = (no, phone, claim, extra) => Object.assign({
  no: no,
  token: 'dev-' + no,
  claim: claim,
  orderType: 'pickup',
  table: '',
  customer: { name: 'Guest', phone: phone },
  items: [HOTPOT],
  subtotal: SUBTOTAL,
  deliveryFee: 0,
  tax: TAX,
  tip: 0,
  surcharge: 0,
  total: TOTAL,
  payMethod: 'counter',
  paymentStatus: 'counter',
  paid: false,
  source: 'probe'
}, extra || {});

const lookup = (phone, device) => get('/api/customer?phone=' + encodeURIComponent(phone) +
  (device ? '&device=' + encodeURIComponent(device) : ''));
const claimOrder = (id, claim) => post('/api/orders/' + encodeURIComponent(id) + '/claim', { claim: claim });
const markPaid = (id) => patch('/api/orders/' + encodeURIComponent(id), { paymentStatus: 'paid' });
const adjust = (body) => post('/api/customers/adjust', body, adminH());
const members = () => get('/api/customers', adminH());

let smtp = null;
let server = null;
let serverLog = '';

function finish(code) {
  try { server.kill(); } catch (e) {}
  try { if (smtp) smtp.close(); } catch (e) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
}

function waitForHealth(tries) {
  if (tries <= 0) return Promise.reject(new Error('server never became healthy'));
  return fetch(BASE + '/api/health').then((r) => r.ok ? r.json() : null)
    .then((j) => { if (j && j.ok) return true; throw new Error('not ready'); })
    .catch(() => sleep(250).then(() => waitForHealth(tries - 1)));
}

async function main() {
  smtp = await SMTP.start({});

  server = spawn(process.execPath, ['server.js'], {
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
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups'),
      /* The mail seam. Never Google, never a real password. */
      KPOT_SMTP_HOST: '127.0.0.1',
      KPOT_SMTP_PORT: String(smtp.port),
      KPOT_SMTP_PLAIN: '1',
      GMAIL_USER: 'kpot.probe@gmail.com',
      GMAIL_APP_PASSWORD: 'probe-app-password',
      KPOT_MAIL_FROM: 'kpot.probe@gmail.com'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  await waitForHealth(80);
  console.log('server up on ' + BASE + '  ·  fake SMTP on 127.0.0.1:' + smtp.port + '\n');

  check('the server did NOT start with the shop\'s live key',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');

  /* ---------------------------------------------------------------- seed -- */
  console.log('\n-- Bob has rewards worth stealing --');
  await adjust({ phone: BOB, name: 'Bob Smith', delta: 140, note: 'probe seed' });
  await adjust({ phone: BOB, coupon: { value: 5, label: '$5 off' }, note: 'probe seed' });
  await adjust({ phone: BOB, email: 'bob@example.com', note: 'probe seed' });
  const bobRow = (await members()).j.customers.find((c) => c.phone === BOB);
  check('Bob is seeded with 140 points, a $5 reward and an e-mail',
    !!bobRow && bobRow.points === 140 && bobRow.unusedCoupons === 1 && bobRow.email === 'bob@example.com',
    JSON.stringify(bobRow));

  /* ------------------------------------------------- the hole, closed ----- */
  console.log('\n-- A phone number alone gets you nothing --');
  const locked = await lookup(BOB);
  check('the public lookup reports the account is NOT identified',
    locked.j && locked.j.identified === false, JSON.stringify(locked.j));
  check('and shows zero points', locked.j && locked.j.points === 0, JSON.stringify(locked.j && locked.j.points));
  check('and no coupons at all',
    locked.j && Array.isArray(locked.j.coupons) && locked.j.coupons.length === 0,
    JSON.stringify(locked.j && locked.j.coupons));
  check('and not even the guest\'s name',
    locked.j && locked.j.name === undefined, 'name leaked: ' + JSON.stringify(locked.j && locked.j.name));
  check('but it does say there is something waiting, so the guest can act',
    locked.j && locked.j.hasRewards === true && locked.j.hasEmail === true,
    JSON.stringify(locked.j));
  check('and it publishes the rules so the panel can still explain itself',
    locked.j && locked.j.rules && locked.j.rules.redeemStep === 100, JSON.stringify(locked.j && locked.j.rules));

  const junk = await lookup(BOB, 'not-a-real-token');
  check('a made-up device token is refused like no token at all',
    junk.j && junk.j.identified === false && junk.j.points === 0, JSON.stringify(junk.j));

  const noDevice = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true }));
  check('THE HOLE: pricing an order against a bare phone number is refused',
    noDevice.status === 409 && noDevice.j.error === 'device_required',
    noDevice.status + ' ' + JSON.stringify(noDevice.j));
  check('and the refusal explains itself rather than failing silently',
    noDevice.j && /confirm this mobile number/i.test(String(noDevice.j.message)),
    JSON.stringify(noDevice.j));

  const plainPrice = await post('/api/price', priceBody(null));
  check('ordinary pricing still works with no rewards involved',
    plainPrice.status === 200 && Math.abs(plainPrice.j.total - TOTAL) < 0.02,
    plainPrice.status + ' ' + JSON.stringify(plainPrice.j));

  /* -------------------------------------------------- the claim handshake -- */
  console.log('\n-- A credential comes from a PAID order you placed yourself --');
  const carolClaim = newClaim();
  const o1 = await post('/api/orders', orderFor('KP-DEV-1', CAROL, carolClaim));
  check('an order with a claim secret is accepted', o1.status === 200 && o1.j.ok === true,
    o1.status + ' ' + JSON.stringify(o1.j));

  const early = await claimOrder('KP-DEV-1', carolClaim);
  check('but an UNPAID order hands out no credential',
    early.status === 409 && early.j.error === 'not_paid', early.status + ' ' + JSON.stringify(early.j));

  const wrongSecret = await claimOrder('KP-DEV-1', newClaim());
  check('and a wrong claim secret is refused outright',
    wrongSecret.status === 403 && wrongSecret.j.error === 'bad_claim',
    wrongSecret.status + ' ' + JSON.stringify(wrongSecret.j));

  await markPaid('KP-DEV-1');
  const carol = await claimOrder('KP-DEV-1', carolClaim);
  check('once staff confirm the payment, the claim mints a credential',
    carol.status === 200 && typeof carol.j.device === 'string' && carol.j.device.length === 64,
    carol.status + ' ' + JSON.stringify(carol.j).slice(0, 160));
  const carolToken = carol.j.device;

  const noClaimOrder = await post('/api/orders', orderFor('KP-DEV-2', DAVE, ''));
  check('an order placed without a claim secret still goes through', noClaimOrder.status === 200);
  await markPaid('KP-DEV-2');
  const unclaimable = await claimOrder('KP-DEV-2', newClaim());
  check('but it can never be claimed (fail closed, not fail open)',
    unclaimable.status === 409 && unclaimable.j.error === 'claim_unavailable',
    unclaimable.status + ' ' + JSON.stringify(unclaimable.j));

  /* A credential is for ONE account, not a master key. */
  const crossLookup = await lookup(BOB, carolToken);
  check('Carol\'s credential does NOT unlock Bob\'s account',
    crossLookup.j && crossLookup.j.identified === false && crossLookup.j.points === 0,
    JSON.stringify(crossLookup.j));
  const crossSpend = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true, device: carolToken }));
  check('and Carol cannot spend Bob\'s points with it either',
    crossSpend.status === 409 && crossSpend.j.error === 'device_required',
    crossSpend.status + ' ' + JSON.stringify(crossSpend.j));

  /* Bob, on his own phone, paying for his own order. */
  const bobClaim = newClaim();
  await post('/api/orders', orderFor('KP-DEV-3', BOB, bobClaim, {
    customer: { name: 'Bob Smith', phone: BOB, email: 'bob@example.com' }
  }));
  await markPaid('KP-DEV-3');
  const bob = await claimOrder('KP-DEV-3', bobClaim);
  check('Bob\'s own paid order mints Bob a credential',
    bob.status === 200 && typeof bob.j.device === 'string', bob.status + ' ' + JSON.stringify(bob.j).slice(0, 160));
  const bobToken = bob.j.device;

  console.log('\n-- ...and now the same calls DO work --');
  const open = await lookup(BOB, bobToken);
  check('the lookup is identified', open.j && open.j.identified === true, JSON.stringify(open.j).slice(0, 120));
  /* Compared against the LEDGER rather than a number typed here. The balance
     moves as this probe settles orders, so "the guest sees 140" would break
     for a reason that has nothing to do with the gate. */
  const openRow = (await members()).j.customers.find((c) => c.phone === BOB);
  check('and shows exactly the balance the ledger holds',
    open.j.points === openRow.points && open.j.points > 0,
    JSON.stringify({ seen: open.j.points, ledger: openRow.points }));
  check('and every reward the ledger holds — the seeded $5 and the earned one',
    open.j.coupons.length === openRow.unusedCoupons && open.j.coupons.length >= 2,
    JSON.stringify({ seen: open.j.coupons.map((c) => c.label), ledger: openRow.unusedCoupons }));
  check('and the masked name', open.j && open.j.name === 'Bob S.', JSON.stringify(open.j && open.j.name));

  const spend = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true, device: bobToken }));
  check('and the points actually come off the bill',
    spend.status === 200 && Math.abs(spend.j.discount - 10) < 0.02,
    spend.status + ' ' + JSON.stringify(spend.j));
  check('priced on the discounted subtotal, tax included',
    spend.status === 200 && Math.abs(spend.j.total - 6.35) < 0.02,
    'total=' + (spend.j && spend.j.total));
  check('and the reward is reported as coming from the loyalty ledger',
    spend.j && spend.j.discountSource === 'loyalty', JSON.stringify(spend.j));

  /* An order placed through the gated path too — /api/price is only the quote. */
  const orderSpend = await post('/api/orders', orderFor('KP-DEV-4', BOB, newClaim(), {
    loyalty: { phone: BOB, redeemPoints: true, device: bobToken },
    total: 6.35
  }));
  check('the ORDER endpoint applies it too, not just the quote',
    orderSpend.status === 200 && orderSpend.j.ok === true,
    orderSpend.status + ' ' + JSON.stringify(orderSpend.j));

  const orderNoDevice = await post('/api/orders', orderFor('KP-DEV-5', BOB, newClaim(), {
    loyalty: { phone: BOB, redeemPoints: true },
    total: 6.35
  }));
  check('while the same order without a credential is refused',
    orderNoDevice.status === 409 && orderNoDevice.j.error === 'device_required',
    orderNoDevice.status + ' ' + JSON.stringify(orderNoDevice.j));

  /* ------------------------------------------------------- e-mail capture -- */
  console.log('\n-- The recovery address is filled once, never rewritten --');
  const afterCapture = (await members()).j.customers.find((c) => c.phone === BOB);
  check('the paid order put Bob\'s e-mail on the account', afterCapture.email === 'bob@example.com',
    JSON.stringify(afterCapture.email));

  const evilClaim = newClaim();
  await post('/api/orders', orderFor('KP-DEV-6', BOB, evilClaim, {
    customer: { name: 'Bob Smith', phone: BOB, email: 'attacker@evil.example' }
  }));
  await markPaid('KP-DEV-6');
  await claimOrder('KP-DEV-6', evilClaim);
  const afterEvil = (await members()).j.customers.find((c) => c.phone === BOB);
  check('a later order carrying somebody else\'s address does NOT overwrite it',
    afterEvil.email === 'bob@example.com', 'became ' + JSON.stringify(afterEvil.email));

  /* ------------------------------------------------------- e-mail recovery -- */
  console.log('\n-- A new phone: a code to the address on the account --');
  const wrongEmail = await post('/api/recovery/start', { phone: BOB, email: 'not-bob@example.com' });
  check('asking with the WRONG e-mail answers exactly like the right one',
    wrongEmail.status === 200 && wrongEmail.j.ok === true, wrongEmail.status + ' ' + JSON.stringify(wrongEmail.j));
  check('and no mail is sent for it', smtp.messages.length === 0, 'messages=' + smtp.messages.length);

  const start = await post('/api/recovery/start', { phone: BOB, email: 'BOB@Example.com' });
  check('the right e-mail is accepted (and matched case-insensitively)',
    start.status === 200 && start.j.ok === true, start.status + ' ' + JSON.stringify(start.j));
  await sleep(200);
  check('and a code really is delivered to that address',
    smtp.messages.length === 1 && smtp.messages[0].to === 'bob@example.com',
    JSON.stringify(smtp.messages.map((m) => m.to)));
  const code = smtp.lastCode();
  check('the mail carries a six-digit code', !!code && /^\d{6}$/.test(code), 'code=' + code);
  check('and the code is nowhere in the server log',
    !serverLog.includes(code), 'the code was logged');

  const badCode = await post('/api/recovery/verify', { phone: BOB, code: '000000' });
  check('a wrong code is refused',
    badCode.status === 400 && badCode.j.error === 'recovery_bad_code',
    badCode.status + ' ' + JSON.stringify(badCode.j));

  const verified = await post('/api/recovery/verify', { phone: BOB, code: code });
  check('the right code mints a credential for THIS phone',
    verified.status === 200 && typeof verified.j.device === 'string' && verified.j.device.length === 64,
    verified.status + ' ' + JSON.stringify(verified.j).slice(0, 160));
  const recovered = verified.j.device;
  check('a recovered credential is different from the checkout one',
    recovered !== bobToken, 'the same token came back twice');

  const afterRecovery = await lookup(BOB, recovered);
  /* Both lookups run back to back with nothing in between, so they must agree
     exactly: the recovery path mints a credential, it does not mint a
     different KIND of access. */
  const viaCheckout = await lookup(BOB, bobToken);
  check('and it opens the account', afterRecovery.j && afterRecovery.j.identified === true,
    JSON.stringify(afterRecovery.j).slice(0, 140));
  check('showing exactly what the checkout credential shows — a credential is a credential',
    afterRecovery.j.points === viaCheckout.j.points &&
    afterRecovery.j.coupons.length === viaCheckout.j.coupons.length &&
    afterRecovery.j.name === viaCheckout.j.name,
    JSON.stringify({ checkout: { p: viaCheckout.j.points, c: viaCheckout.j.coupons.length },
      recovered: { p: afterRecovery.j.points, c: afterRecovery.j.coupons.length } }));

  const replay = await post('/api/recovery/verify', { phone: BOB, code: code });
  check('the same code cannot be used a second time',
    replay.status === 400 && replay.j.error === 'recovery_none',
    replay.status + ' ' + JSON.stringify(replay.j));

  /* ----------------------------------------------------------- lockout ----- */
  console.log('\n-- Six digits is guessable, so guessing is capped --');
  await adjust({ phone: ERIN, name: 'Erin', email: 'erin@example.com', note: 'probe seed' });
  await post('/api/recovery/start', { phone: ERIN, email: 'erin@example.com' });
  await sleep(200);
  const erinCode = smtp.lastCode();
  check('Erin gets a code too', !!erinCode, 'code=' + erinCode);

  const attempts = [];
  for (let i = 0; i < 5; i++) {
    attempts.push(await post('/api/recovery/verify', { phone: ERIN, code: '111111' }));
  }
  check('five wrong guesses are all refused',
    attempts.every((r) => r.status === 400 && r.j.error === 'recovery_bad_code'),
    JSON.stringify(attempts.map((r) => r.j.error)));
  const afterLock = await post('/api/recovery/verify', { phone: ERIN, code: erinCode });
  check('and the CORRECT code no longer works after the cap — the code is dead',
    afterLock.status === 400 && afterLock.j.error === 'recovery_none',
    afterLock.status + ' ' + JSON.stringify(afterLock.j));

  /* --------------------------------------------------- per-number throttle -- */
  console.log('\n-- The form cannot be used to flood one guest\'s inbox --');
  const sends = [];
  for (let i = 0; i < 4; i++) sends.push(await post('/api/recovery/start', { phone: ERIN, email: 'erin@example.com' }));
  const capped = sends.filter((r) => r.status === 429);
  check('a fourth code to the same number in an hour is refused',
    capped.length >= 1 && capped[0].j.error === 'rate_limited',
    JSON.stringify(sends.map((r) => r.status)));
  check('and the refusal is about that NUMBER, not about the caller',
    /already sent a code to that number/i.test(String(capped[0] && capped[0].j.message)),
    JSON.stringify(capped[0] && capped[0].j));

  /* ------------------------------------------------------ owner controls --- */
  console.log('\n-- The counter can still sort a guest out --');
  /* Measured, not assumed: the point is that a revoke changes NOTHING about
     what the guest owns. Hard-coding the balance here would have made this
     fail the moment a rule changed, for a reason that has nothing to do with
     devices. */
  const beforeRevoke = (await members()).j.customers.find((c) => c.phone === BOB);
  const revoked = await adjust({ phone: BOB, revokeDevices: true, note: 'probe revoke' });
  check('staff can sign every device out at once', revoked.status === 200, JSON.stringify(revoked.j).slice(0, 140));
  const afterRevoke = await lookup(BOB, bobToken);
  check('and the old credential stops working immediately',
    afterRevoke.j && afterRevoke.j.identified === false, JSON.stringify(afterRevoke.j));
  const afterRevoke2 = await lookup(BOB, recovered);
  check('every credential, not just the newest',
    afterRevoke2.j && afterRevoke2.j.identified === false, JSON.stringify(afterRevoke2.j));

  const bobAfter = (await members()).j.customers.find((c) => c.phone === BOB);
  check('but nothing was confiscated — the points are untouched',
    bobAfter.points === beforeRevoke.points && bobAfter.lifetimePoints === beforeRevoke.lifetimePoints,
    JSON.stringify({ was: beforeRevoke.points, now: bobAfter.points }));
  check('and neither are the rewards',
    bobAfter.unusedCoupons === beforeRevoke.unusedCoupons && bobAfter.unusedCoupons > 0,
    JSON.stringify({ was: beforeRevoke.unusedCoupons, now: bobAfter.unusedCoupons }));
  check('and the console can see the address and how many devices are signed in',
    bobAfter.email === 'bob@example.com' && bobAfter.devices === 0,
    JSON.stringify({ email: bobAfter.email, devices: bobAfter.devices }));

  const fixed = await adjust({ phone: BOB, email: 'bob.smith@example.com', note: 'typo fix' });
  const fixedRow = (await members()).j.customers.find((c) => c.phone === BOB);
  check('the owner CAN rewrite an address (the storefront never can)',
    fixed.status === 200 && fixedRow.email === 'bob.smith@example.com', JSON.stringify(fixedRow.email));

  /* --------------------------------------------- the counter's own door ----
     The guest with NO e-mail on the account would otherwise have no way in at
     all: the panel tells them to ask at the counter, and the counter had no
     code to hand over. So the owner mints one, reads it out, and the guest
     types it into the very same box the mailed code goes in.

     Dave is that guest — no address, no device, nothing. This is the path the
     owner actually asked for when they said "需要安全的账户恢复方式". */
  console.log('\n-- The counter can mint a code for a guest with no e-mail --');
  const daveIssued = await adjust({ phone: DAVE, issueCode: true, note: 'probe counter code' });
  check('the counter mints a code', daveIssued.status === 200 && !!daveIssued.j.recoveryCode,
    JSON.stringify(daveIssued.j).slice(0, 140));
  const counterCode1 = String(daveIssued.j.recoveryCode);
  check('and it is six digits, like the mailed one',
    /^[0-9]{6}$/.test(counterCode1), 'code=' + counterCode1);
  check('and it is quoted with its own lifetime', daveIssued.j.recoveryMinutes >= 5,
    'minutes=' + daveIssued.j.recoveryMinutes);
  check('the console can see one is outstanding before it is used',
    (daveIssued.j.customer || {}).recoveryPending === true,
    JSON.stringify(daveIssued.j.customer));

  const daveOpen = await post('/api/recovery/verify', { phone: DAVE, code: counterCode1 });
  check('a guest with no e-mail can unlock with it', daveOpen.status === 200 && !!daveOpen.j.device,
    'status=' + daveOpen.status + ' ' + JSON.stringify(daveOpen.j));
  const daveToken = daveOpen.j.device;
  check('and it opens the account', (await lookup(DAVE, daveToken)).j.identified === true);
  check('the console sees it is no longer pending',
    (await members()).j.customers.find((c) => c.phone === DAVE).recoveryPending === false);

  const counterReplay = await post('/api/recovery/verify', { phone: DAVE, code: counterCode1 });
  check('and the code works once only — a replay is refused',
    counterReplay.status === 400 && counterReplay.j.error === 'recovery_none',
    'status=' + counterReplay.status);

  const counterCode2 = String((await adjust({ phone: DAVE, issueCode: true, note: 'second probe code' })).j.recoveryCode);
  const counterStale = await post('/api/recovery/verify', { phone: DAVE, code: counterCode1 });
  /* The invariant is "no credential comes out", not a particular error string:
     a new code IS live, so a spent one answers recovery_bad_code rather than
     recovery_none. Either way the account stays shut. */
  check('issuing a NEW code kills the one before it',
    counterStale.status === 400 && !counterStale.j.device,
    'status=' + counterStale.status + ' ' + JSON.stringify(counterStale.j));
  const dave2 = await post('/api/recovery/verify', { phone: DAVE, code: counterCode2 });
  check('and the fresh one works', dave2.status === 200 && !!dave2.j.device, 'status=' + dave2.status);
  check('and issues a DIFFERENT credential, not the same one again',
    dave2.j.device !== daveToken, 'same token came back twice');

  /* The digits are a credential while the code lives, so they must be stored
     the same way a device token is: hashed, never in the clear. */
  const ledgerNow = fs.readFileSync(path.join(SCRATCH, 'customers.local.json'), 'utf8');
  check('neither counter code is in the ledger in the clear',
    !ledgerNow.includes(counterCode1) && !ledgerNow.includes(counterCode2),
    'a live code was written to disk');
  check('only its hash is', /"hash": "[0-9a-f]{64}"/.test(ledgerNow));

  /* ------------------------------------------------- come-back coupon ----- */
  /* The owner asked for this NOT to be switched off again. It is the one
     reward that carries a countdown, and a countdown next to a points balance
     is what made them think the points expired — so pin the distinction down:
     the coupon expires, the points and the stamp rewards never do.

     Carol settled one order (KP-DEV-1), so she is the record to read. Bob
     holds both kinds — a staff-given $5 and an earned come-back — which is
     what makes the contrast assertable in one place. */
  console.log('\n-- The come-back coupon is ON, and only IT expires --');
  const carolRow = (await members()).j.customers.find((c) => c.phone === CAROL);
  check('settling an order hands out a come-back coupon', carolRow.unusedCoupons >= 1,
    JSON.stringify(carolRow.unusedCoupons));
  const carolLookup = await lookup(CAROL);
  check('the rules still advertise it', carolLookup.j.rules.returnValue === 3 && carolLookup.j.rules.returnDays === 7,
    JSON.stringify(carolLookup.j.rules));

  const rawLedger = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'customers.local.json'), 'utf8'));
  const carolRec = rawLedger.customers.find((c) => c.phone === CAROL);
  const bobRec = rawLedger.customers.find((c) => c.phone === BOB);
  const earnedReturn = (carolRec.coupons || []).find((c) => c.kind === 'return');
  const staffStamp = (bobRec.coupons || []).find((c) => c.kind === 'stamp');
  check('the come-back coupon carries an expiry date',
    !!earnedReturn && !!earnedReturn.expiresAt, JSON.stringify(earnedReturn));
  check('and a reward earned from the stamp card does NOT',
    !!staffStamp && !staffStamp.expiresAt, JSON.stringify(staffStamp));
  check('and the points carry no expiry field at all',
    carolRec.pointsExpireAt === undefined && carolRec.expiresAt === undefined,
    JSON.stringify(Object.keys(carolRec)));

  /* ------------------------------------------------------------ ledger ----- */
  console.log('\n-- The stored credential is a hash, not a key --');
  const raw = fs.readFileSync(path.join(SCRATCH, 'customers.local.json'), 'utf8');
  check('the plaintext device token is nowhere in the saved ledger',
    !raw.includes(bobToken) && !raw.includes(recovered) && !raw.includes(carolToken),
    'a live token was written to disk');
  check('only sha256 hashes are stored', /"hash": "[0-9a-f]{64}"/.test(raw));

  /* A spent code must be gone; an outstanding one must be a hash. Erin was
     sent a fresh code at the end of the throttle section and never used it, so
     she is the record that should still carry one. */
  const bobStored = rawLedger.customers.find((c) => c.phone === BOB);
  const erinStored = rawLedger.customers.find((c) => c.phone === ERIN);
  check('a spent recovery code is cleared from the ledger',
    !bobStored.recovery, JSON.stringify(bobStored.recovery));
  check('an outstanding one is kept, so it survives a restart',
    !!erinStored.recovery && !!erinStored.recovery.expiresAt, JSON.stringify(erinStored.recovery));
  check('and even that one is stored as a hash, never the six digits',
    !!erinStored.recovery && erinStored.recovery.hash !== erinCode &&
    /^[0-9a-f]{64}$/.test(String(erinStored.recovery.hash)),
    'a usable code was written to disk');

  /* -------------------------------------------------------- hermeticity ---- */
  check('no real customers file was created in the repo',
    !fs.existsSync(path.join(ROOT, 'customers.local.json')),
    'customers.local.json appeared in the repo!');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  finish(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL  harness threw: ' + (e && e.stack || e) + '\n' + serverLog);
  finish(1);
});
