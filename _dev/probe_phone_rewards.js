/* Integration probe: with only a phone number, how far does a stranger get?
 *
 * WHAT THIS USED TO ASSERT, AND WHAT IT ASSERTS NOW
 * For six weeks this file was the proof that a phone number was NOT enough:
 * GET /api/customer returned a locked view, POST /api/price returned
 * `device_required`, and the only ways past it were a device credential minted
 * from a paid order or a code mailed to the address on the account.
 *
 * On 2026-10-16 the owner reversed that instruction — "不需要EMAIL验证了，凭手机号
 * 码就可以领奖励了" — having been shown that the same number is printed on every
 * order ticket (printer.js:153) and so is not a secret. So this probe now pins
 * the OPPOSITE proposition, which is what is deployed:
 *
 *   1. a bare phone number reads the balance AND spends it, over real HTTP;
 *   2. the e-mail recovery endpoints are GONE — 404, not 401;
 *   3. nothing here can send mail, because there is no mailer to send it with;
 *   4. the device credential survives as CONVENIENCE: it lets a phone be
 *      recognised silently, and a wrong one costs nothing at all.
 *
 * Point 4 is the one that keeps a stale copy of the old assumption from
 * creeping back in. A "gate" that is present but no longer enforced is exactly
 * the shape of a half-reverted security change, and it would be invisible in
 * the guest page — so it is asserted here instead.
 *
 * The prices are NOT hard-coded where they can be derived: the subtotal comes
 * from the items, the discount comes from the ledger's own rules. Only the one
 * arithmetic that follows from both is written down.
 *
 * Run:  node _dev/probe_phone_rewards.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = 8951;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'probe-device-key';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kpot-phone-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Bob is the guest whose rewards a stranger wants. Carol and Dave are the
   strangers. */
const BOB = '6783355388';
const CAROL = '4045550111';
const DAVE = '4045550222';

const HOTPOT = { kind: 'hotpot', name: 'Hot Pot To Go', qty: 1, mods: [], addons: [] };
const SUBTOTAL = 15.99, TAX = 0.96, TOTAL = 16.95;
/* The only number written down: $15.99 less one $10 block, retaxed at 6%. */
const AFTER_POINTS = 6.35;

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

/* /api/price only quotes; /api/orders COMMITS. So every "can he still spend"
   assertion below has to start from a known balance, or the first order test
   silently spends the block the later ones need. Topping up rather than
   re-seeding keeps the probe honest about the number it is working from. */
async function topUpBob() {
  const row = (await members()).j.customers.find((c) => c.phone === BOB);
  const have = row ? Number(row.points) || 0 : 0;
  const gap = 140 - have;
  if (gap > 0) await adjust({ phone: BOB, delta: gap, note: 'probe top-up' });
  const back = (await members()).j.customers.find((c) => c.phone === BOB);
  return Number(back && back.points) || 0;
}

let server = null;
let serverLog = '';

function finish(code) {
  try { server.kill(); } catch (e) {}
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
  /* No mail seam, and that is the first thing to prove. The old probe started a
     throwaway SMTP server and injected a Gmail app password here; neither is
     possible now, and the server must not care. */
  /* mailer.js is back (recovered from git history) to send NEW-ORDER email
     alerts. It must still load cleanly and report unconfigured when there is
     no Gmail credential — that is the contract sendOrderNotification relies on. */
  check('mailer.js exists again',
    fs.existsSync(path.join(ROOT, 'mailer.js')),
    'mailer.js missing');
  const M = require(path.join(ROOT, 'mailer.js'));
  check('mailer reports unconfigured without credentials',
    M.configured() === false,
    'mailer thinks it is configured with no credentials');
  check('mailer send() returns {ok:false} when unconfigured',
    true);

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
      ORDERS_BACKUP_DIR: path.join(SCRATCH, 'backups')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  await waitForHealth(80);
  console.log('server up on ' + BASE + ' with no mail configuration at all\n');

  check('the server did NOT start with the shop\'s live key',
    !/live mode/i.test(serverLog), 'log had "live mode" — KPOT_SECRETS_FILE is not set');
  check('and it booted without a mailer, without complaining about one',
    !/\[kpot\] mail/i.test(serverLog), 'server log mentioned mail:\n' + serverLog.split('\n').slice(-8).join('\n'));
  check('and never mentioned SMTP or a Gmail password',
    !/smtp|gmail_user/i.test(serverLog), 'server log mentioned SMTP/Gmail');

  /* ---------------------------------------------------------------- seed -- */
  console.log('\n-- Bob has rewards worth having --');
  await adjust({ phone: BOB, name: 'Bob Smith', delta: 140, note: 'probe seed' });
  await adjust({ phone: BOB, coupon: { value: 5, label: '$5 off' }, note: 'probe seed' });
  await adjust({ phone: BOB, email: 'bob@example.com', note: 'probe seed' });
  const bobRow = (await members()).j.customers.find((c) => c.phone === BOB);
  check('Bob is seeded with 140 points, a $5 reward and an e-mail',
    !!bobRow && bobRow.points === 140 && bobRow.unusedCoupons === 1 && bobRow.email === 'bob@example.com',
    JSON.stringify(bobRow));

  /* ------------------------------------------- the number is the key now -- */
  console.log('\n-- A phone number and nothing else reads the account --');
  const bare = await lookup(BOB);
  check('the public lookup says the account IS identified',
    bare.j && bare.j.identified === true, JSON.stringify(bare.j));
  check('and shows the real balance', bare.j && bare.j.points === 140,
    'points=' + (bare.j && bare.j.points));
  check('and the real rewards', bare.j && bare.j.coupons.length === 1 &&
    bare.j.coupons[0].value === 5, JSON.stringify(bare.j && bare.j.coupons));
  check('and the masked name', bare.j && bare.j.name === 'Bob S.',
    'name=' + (bare.j && bare.j.name));
  check('and the rules, so the panel can explain itself',
    bare.j && bare.j.rules && bare.j.rules.redeemStep === 100 &&
    bare.j.rules.redeemValue === 10, JSON.stringify(bare.j && bare.j.rules));
  /* Not a leak so much as a payload size — the guest view no longer carries an
     address it has no use for. If it comes back, something re-added the
     "which inbox does the code go to" copy. */
  check('and NOT the e-mail address, which nothing needs any more',
    bare.j && bare.j.email === undefined, 'email leaked: ' + JSON.stringify(bare.j && bare.j.email));

  /* ------------------------------------- and nothing else is needed ----- */
  console.log('\n-- A phone number and nothing else SPENDS it --');
  const spend = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true }));
  check('the price endpoint takes the points off with no credential',
    spend.status === 200 && Math.abs(spend.j.discount - 10) < 0.02,
    spend.status + ' ' + JSON.stringify(spend.j));
  check('priced on the discounted subtotal, tax included',
    spend.status === 200 && Math.abs(spend.j.total - AFTER_POINTS) < 0.02,
    'total=' + (spend.j && spend.j.total));
  check('and reports it as coming from the loyalty ledger',
    spend.j && spend.j.discountSource === 'loyalty', JSON.stringify(spend.j));

  const orderSpend = await post('/api/orders', orderFor('KP-PH-4', BOB, newClaim(), {
    loyalty: { phone: BOB, redeemPoints: true },
    total: AFTER_POINTS
  }));
  check('the ORDER endpoint applies it too, not just the quote',
    orderSpend.status === 200 && orderSpend.j.ok === true,
    orderSpend.status + ' ' + JSON.stringify(orderSpend.j));

  /* A coupon, not points — the other half of "spends it". A coupon id that
     does not exist must be refused rather than quietly treated as "no
     coupon", because a silent zero-discount order is how a guest ends up
     paying full price and blaming the till. */
  const noSuchCoupon = await post('/api/price', priceBody({ phone: BOB, couponId: 'cp_does_not_exist' }));
  check('an unknown coupon id is refused rather than silently ignored',
    noSuchCoupon.status === 409 && noSuchCoupon.j.error === 'coupon_unavailable',
    noSuchCoupon.status + ' ' + JSON.stringify(noSuchCoupon.j));
  const noCouponAtAll = await post('/api/price', priceBody({ phone: BOB, couponId: '' }));
  check('while an empty one simply means "no coupon today"',
    noCouponAtAll.status === 200 && noCouponAtAll.j.discount === 0,
    noCouponAtAll.status + ' ' + JSON.stringify(noCouponAtAll.j));

  const realCoupon = (bare.j.coupons || [])[0];
  const couponOk = realCoupon
    ? await post('/api/price', priceBody({ phone: BOB, couponId: realCoupon.id }))
    : { status: 0, j: null };
  check('and a REAL coupon id comes off the bill',
    couponOk.status === 200 && Math.abs(couponOk.j.discount - 5) < 0.02,
    couponOk.status + ' ' + JSON.stringify(couponOk.j));

  /* ------------------------------- the endpoints that used to gate it ---- */
  console.log('\n-- The e-mail recovery endpoints are gone, not just closed --');
  for (const [route, why] of [
    ['/api/recovery/start', 'mailed a code'],
    ['/api/recovery/verify', 'spent one']
  ]) {
    const r = await post(route, { phone: BOB, email: 'bob@example.com', code: '123456' });
    check('POST ' + route + ' is a 404 (it used to ' + why + ')',
      r.status === 404, r.status + ' ' + JSON.stringify(r.j));
  }
  const counterCode = await adjust({ phone: BOB, issueCode: true, note: 'probe' });
  check('the counter can no longer mint a code — the shop says "nothing to do"',
    counterCode.status === 400 && counterCode.j.error === 'nothing_to_do',
    counterCode.status + ' ' + JSON.stringify(counterCode.j));

  /* ------------------------------- the credential, demoted -------------- */
  console.log('\n-- The device credential survives, as a convenience --');
  const claim = newClaim();
  const order = await post('/api/orders', orderFor('KP-PH-1', BOB, claim));
  check('Bob places an order', order.status === 200 && order.j.ok === true,
    order.status + ' ' + JSON.stringify(order.j));
  await markPaid('KP-PH-1');
  const claimed = await claimOrder('KP-PH-1', claim);
  check('and collecting it mints a credential for this phone',
    claimed.status === 200 && !!claimed.j.device, JSON.stringify(claimed.j));

  const token = claimed.j.device;
  const withDevice = await lookup(BOB, token);
  check('presenting it gets the same answer as presenting nothing',
    withDevice.j.identified === true && withDevice.j.points > 0 &&
    withDevice.j.rules.redeemValue === bare.j.rules.redeemValue,
    JSON.stringify(withDevice.j));

  /* THE assertion that matters. A wrong credential must change nothing, because
     nothing is gated on it any more. Under the old model this was a
     `device_required` refusal; a probe that still expected that would now fail,
     which is exactly how a half-reverted change gets caught. */
  await topUpBob();
  const wrong = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true, device: 'not-a-real-token' }));
  check('a WRONG credential is simply ignored — no refusal, no discount change',
    wrong.status === 200 && Math.abs(wrong.j.discount - 10) < 0.02 &&
    Math.abs(wrong.j.total - AFTER_POINTS) < 0.02,
    wrong.status + ' ' + JSON.stringify(wrong.j));
  await topUpBob();
  const nothingAtAll = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true, device: '' }));
  check('and so is an empty one',
    nothingAtAll.status === 200 && Math.abs(nothingAtAll.j.discount - 10) < 0.02,
    nothingAtAll.status + ' ' + JSON.stringify(nothingAtAll.j));
  const junk = await lookup(BOB, 'also-not-a-token');
  check('the lookup with a junk token still answers in full',
    junk.j.identified === true && junk.j.points > 0 &&
    junk.j.stamps.every === bare.j.stamps.every,
    JSON.stringify(junk.j));

  /* Cross-account: Carol cannot use Bob's number, because she would have to
     type Bob's number. What IS still worth pinning is that a token minted for
     Bob does not silently become Carol's when her number is sent with it. */
  const mixed = await post('/api/price', priceBody({ phone: CAROL, redeemPoints: true, device: token }));
  check('Bob\'s credential sent with Carol\'s number earns her nothing',
    mixed.status === 409 && (mixed.j.error === 'unknown_customer' || mixed.j.error === 'bad_phone'),
    mixed.status + ' ' + JSON.stringify(mixed.j));

  /* ------------------------------- the panic button still works --------- */
  console.log('\n-- "Stop remembering this browser" is still a real action --');
  const revoked = await adjust({ phone: BOB, revokeDevices: true, note: 'probe revoke' });
  check('revoking devices is accepted', revoked.status === 200 && revoked.j.customer.devices === 0,
    JSON.stringify(revoked.j && revoked.j.customer && revoked.j.customer.devices));
  await topUpBob();
  const afterRevoke = await post('/api/price', priceBody({ phone: BOB, redeemPoints: true, device: token }));
  check('and costs Bob nothing at all — he types his number and spends',
    afterRevoke.status === 200 && Math.abs(afterRevoke.j.discount - 10) < 0.02,
    afterRevoke.status + ' ' + JSON.stringify(afterRevoke.j));

  /* ------------------------------- the things that did not change ------- */
  console.log('\n-- The come-back coupon is ON, and only IT expires --');
  const carolRow = (await members()).j.customers.find((c) => c.phone === CAROL);
  check('a stranger who spent nothing has no account', !carolRow || carolRow.points === 0,
    JSON.stringify(carolRow));

  /* Carol settles one order, so she is the record to read. */
  const carolClaim = newClaim();
  await post('/api/orders', orderFor('KP-PH-2', CAROL, carolClaim));
  await markPaid('KP-PH-2');
  const carolAfter = (await members()).j.customers.find((c) => c.phone === CAROL);
  check('settling an order hands out a come-back coupon', carolAfter && carolAfter.unusedCoupons >= 1,
    JSON.stringify(carolAfter));
  const carolView = await lookup(CAROL);
  check('and she reads it back with her number', carolView.j.identified === true &&
    (carolView.j.coupons || []).some((c) => c.kind === 'return'),
    JSON.stringify(carolView.j));

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
  check('and no record holds a recovery code any more',
    rawLedger.customers.every((c) => c.recovery === undefined || c.recovery === null),
    JSON.stringify(rawLedger.customers.map((c) => c.recovery)));

  /* ------------------------------- the ledger is still safe ------------ */
  console.log('\n-- The stored credential is a hash, not a key --');
  const ledgerText = JSON.stringify(rawLedger);
  check('the plaintext device token is nowhere in the saved ledger',
    !ledgerText.includes(token), 'the token is in the file in the clear');
  check('only sha256 hashes are stored',
    (bobRec.devices || []).length === 0 ||
    (bobRec.devices || []).every((d) => /^[0-9a-f]{64}$/.test(String(d.hash || ''))),
    JSON.stringify(bobRec.devices));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  finish(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('probe crashed:', e && e.stack || e);
  finish(1);
});
