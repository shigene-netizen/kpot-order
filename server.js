/* ==========================================================================
   KPOT To Go — server
   --------------------------------------------------------------------------
   Zero dependencies. Serves the storefront and exposes one API route that
   creates a Stripe Checkout Session with inline pricing, so no Products ever
   need to exist in the Stripe dashboard.

   Run:  PORT=3000 node server.js
   Key:  STRIPE_SECRET_KEY env var, or secrets.local.json (see the .example file)

   Security notes
   --------------
   * The Stripe secret key never leaves this process. It is never sent to the
     browser, never logged, and never served as a file.
   * Prices are recomputed here from assets/menu.js. The browser only says WHAT
     was ordered; it has no say in what it costs.
   * Static file serving is an allowlist: hidden files, secrets, source files
     and anything outside the project root are refused.
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadAssets, priceOrder, toStripeLineItems, round2, applyDiscount, discountAmountFor } = require('./pricing.js');
const { renderKitchenTicket } = require('./printer.js');
const D = require('./discounts.js');
const L = require('./customers.js');
const CR = require('./credits.js');
const MB = require('./member.js');
const SC = require('./schedule.js');
const G = require('./geo.js');
const DISP = require('./dispatch.js');
const GWAPI = require('./giveaway-api.js');
let MAIL = null;
try { MAIL = require('./mailer.js'); } catch (e) { MAIL = null; }

/* Web Push (real push to the owner's phone even when the board is closed).
   Wrapped so a missing package never stops the server from booting. */
let PUSH = null;
try { PUSH = require('./push.js'); } catch (e) { PUSH = null; }

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '3000', 10);

/* Stripe's Checkout Sessions endpoint.

   Overridable ONLY so a test can point it at a local stub: the payment re-check
   has to be exercised without a live key, and it cannot be exercised at all if
   the URL is welded shut. In production this must stay at api.stripe.com — the
   secret key travels in the Authorization header of every request, so pointing
   it elsewhere would hand the key to whoever set the variable. Anything that can
   set env vars here could read secrets.local.json anyway, so this is not a new
   capability; but it is silent, which is why the override logs a warning. */
const STRIPE_API_BASE = process.env.KPOT_STRIPE_API_BASE || 'https://api.stripe.com/v1/checkout/sessions';
if (process.env.KPOT_STRIPE_API_BASE) {
  console.warn('[kpot] WARNING: Stripe API redirected to ' + STRIPE_API_BASE +
    ' (KPOT_STRIPE_API_BASE) — this is for tests only and must never be set in production.');
}
const STRIPE_API = STRIPE_API_BASE;
const STRIPE_API_SESSION = STRIPE_API_BASE + '/';

/* Discounts are applied as a Stripe coupon, because Checkout refuses a
   negative line item ("Invalid non-negative integer"). Derived from the same
   base so the test stub only has to serve one extra path. */
const STRIPE_COUPON_API = process.env.KPOT_STRIPE_COUPON_API ||
  STRIPE_API_BASE.replace(/\/checkout\/sessions\/?$/, '/coupons');

/* -------------------------------------------------------------------------- */
/* Config & key                                                                */
/* -------------------------------------------------------------------------- */

let ASSETS;
try {
  ASSETS = loadAssets(ROOT);
} catch (e) {
  console.error('[kpot] FATAL: could not load menu/config —', e.message);
  process.exit(1);
}

/* --- Membership and delivery schedule -------------------------------------
   Read from config.js in exactly ONE place each, and normalised by the same
   pure modules the tests exercise. A host page or a hand-edited config can
   hand us anything, and both readers fail closed: a member discount of 0
   rather than 100%, a delivery fee of 0 rather than NaN.

   These are functions, not constants, so that a test which swaps config.js on
   disk and reloads assets does not have to know how to invalidate them. */
function memberCfg() {
  return MB.memberConfig((ASSETS.CONFIG || {}).member);
}
/* Does the static config offer delivery at all? Read once, at module load,
   because that is the only moment ASSETS exists and storeStatus is being
   built. Fail OPEN here on purpose: if config cannot be read, the runtime
   switch (default on) decides, and the owner can always turn it off — whereas
   a config typo silently killing a channel the shop does offer costs orders. */
function deliveryChannelConfigured() {
  try {
    const d = (ASSETS.CONFIG || {}).delivery || {};
    return d.enabled !== false;
  } catch (e) { return true; }
}
function scheduleCfg() {
  const d = (ASSETS.CONFIG || {}).delivery || {};
  /* The channel switch and the schedule live in the same block but mean
     different things: `enabled` turns the whole Delivery channel off (the same
     flag the owner's board flips), while `schedule.enabled` would only turn
     off the next-day windows. Flatten them here so schedule.js has one gate. */
  return SC.scheduleConfig(Object.assign({}, d.schedule, {
    /* The channel switch the OWNER can flip at runtime, not the static config
       line: the board writes storeStatus.orderTypes.delivery, and an owner who
       turns Delivery back on must get a working scheduler without a redeploy.
       Reading d.enabled here left every delivery order refused with
       schedule_disabled no matter what the board said — the schedule could
       never be used with the shipped config (delivery.enabled:false). */
    enabled: !storeTypeOff('delivery'),
    fee: d.fee
  }));
}
/* What the server tells pricing.js about the Delivery channel: the board's
   RUNTIME switch (storeStatus.orderTypes.delivery), never the static config
   seed. The shipped config has delivery.enabled:false, which only seeds the
   runtime switch off — but an owner who turns Delivery back on from the board
   must have the fee charged again, not silently dropped to $0. One reader here
   keeps the guest price, the server charge and the ticket from disagreeing. */
function deliveryPricingOpts() {
  return { deliveryEnabled: !storeTypeOff('delivery') };
}
/* Business hours, from config — or, for TESTS ONLY, from the environment.

   The seam exists because the store-hours tick holds `open` strictly on the
   hours clock: an owner's manual override is for early closes, not for
   staying open, so a browser probe that needs the shop open CANNOT get it
   through the board after closing time — and every probe that adds to a cart
   needs exactly that. Without this, the whole browser half of the suite goes
   red every night at 21:30 and stays red until noon, for a reason that has
   nothing to do with what any of them test. Production never sets the
   variable. Parsed once, cached — the tick calls this every flush. */
const HOURS_SPEC_OVERRIDE = (() => {
  if (!process.env.KPOT_HOURS_SPEC) return undefined;
  try {
    const spec = JSON.parse(process.env.KPOT_HOURS_SPEC);
    console.warn('[kpot] WARNING: business hours overridden (KPOT_HOURS_SPEC) — tests only, never set this in production.');
    return spec;
  } catch (e) {
    console.error('[kpot] KPOT_HOURS_SPEC is not valid JSON — ignoring:', e.message);
    return undefined;
  }
})();
function hoursSpec() {
  if (HOURS_SPEC_OVERRIDE !== undefined) return HOURS_SPEC_OVERRIDE;
  return ((ASSETS.CONFIG || {}).store || {}).hoursSpec || {};
}

/* Where the keys are read from. Overridable so a test can supply its own
   secrets instead of depending on the shop's real ones — a security test that
   reads the owner's live key file is both unsafe and not reproducible. */
const SECRETS_FILE = process.env.KPOT_SECRETS_FILE || path.join(ROOT, 'secrets.local.json');

function loadSecretKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  try {
    const p = SECRETS_FILE;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.stripeSecretKey) return String(j.stripeSecretKey).trim();
  } catch (e) { /* no local key file — fine */ }
  return '';
}

let SECRET_KEY = loadSecretKey();

/* Accept rk_ (restricted) keys as well as sk_ (standard secret) keys.
   A restricted key works fine for what this server does — create a Checkout
   Session and read it back — but if we only matched 'sk_live_' we'd report
   keyMode 'unknown' for a perfectly working live key, which sends anyone
   debugging a payment problem down the wrong path. Match on the mode segment,
   not the key class. */
function keyModeOf(k) {
  if (!k) return 'none';
  const m = String(k).match(/^(?:sk|rk)_(live|test)_/);
  return m ? m[1] : 'unknown';
}
const KEY_MODE = keyModeOf(SECRET_KEY);

/* -------------------------------------------------------------------------- */
/* Static files                                                                */
/* -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

// Never served, whatever the path says.
const BLOCKED = /^(secrets.*\.json|orders.*\.json|orders.*\.csv|menu.*\.json|store.*\.json|server\.js|pricing\.js|package(-lock)?\.json|make_qr\.py|README\.md|url\.txt)$/i;

/* The one dot-path that IS served: Apple Pay domain verification. */
const APPLE_PAY_VERIFICATION_PATH = '/.well-known/apple-developer-merchantid-domain-association';
const APPLE_PAY_FILE = process.env.KPOT_APPLE_PAY_FILE
  || path.join(ROOT, '.well-known', 'apple-developer-merchantid-domain-association');

/* Whole directories that must never be reachable over HTTP. order-backups/
   holds a full copy of every order — served, it would leak customer names and
   phone numbers to anyone who guessed the path. */
const BLOCKED_DIRS = new Set(['order-backups']);

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;

  /* ---- Apple Pay domain verification ------------------------------------
     Stripe will not render the Apple Pay button on a web domain until that
     domain serves this one exact file (Dashboard → Settings → Payment method
     domains → "Add domain" hands you the file). It lives under a dot
     directory, which the hidden-segment rule below would reject like every
     other dot-path — so the exception is written for this filename and
     nothing else. Every other .well-known path still 404s.

     The path is overridable so a test can point it at a scratch file: the
     real one only exists on the VM after the owner downloads it from Stripe
     and is committed to the repo. Absent file → 404, exactly as before. */
  if (rel === APPLE_PAY_VERIFICATION_PATH) {
    return fs.readFile(APPLE_PAY_FILE, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  const segments = rel.split('/').filter(Boolean);

  // reject hidden segments, the explicit block list, and private directories
  for (const s of segments) {
    if (s.startsWith('.')) return send(res, 404, 'Not found');
    if (BLOCKED_DIRS.has(s.toLowerCase())) return send(res, 404, 'Not found');
    if (BLOCKED.test(s)) return send(res, 404, 'Not found');
  }

  const filePath = path.join(ROOT, ...segments);

  // belt and braces: the resolved path must stay inside the project
  const relCheck = path.relative(ROOT, filePath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return send(res, 403, 'Forbidden');

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return send(res, 404, 'Not found');

  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* -------------------------------------------------------------------------- */
/* Stripe                                                                      */
/* -------------------------------------------------------------------------- */

function requestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT)).split(',')[0].trim();
  return proto + '://' + host;
}

async function createStripeSession(priced, order, base) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', base + '/?paid=1');
  form.set('cancel_url', base + '/?canceled=1');

  const ref = String(order.orderNo || '').slice(0, 200);
  if (ref) form.set('client_reference_id', ref);

  const items = toStripeLineItems(priced, 'usd');
  items.forEach((l, i) => {
    form.set('line_items[' + i + '][price_data][currency]', 'usd');
    form.set('line_items[' + i + '][price_data][product_data][name]', l.name);
    if (l.desc) form.set('line_items[' + i + '][price_data][product_data][description]', l.desc);
    form.set('line_items[' + i + '][price_data][unit_amount]', String(l.unit_amount));
    form.set('line_items[' + i + '][quantity]', String(l.quantity));
  });

  /* A discount cannot be sent as a negative line item — Stripe rejects it with
     "Invalid non-negative integer" — so the amount we computed becomes a
     one-shot coupon. The session then charges

         items + delivery + tax(net) + tip − coupon

     which is exactly priced.total, because tax here was already computed on
     the discounted base. */
  if (priced.discountAmount > 0) {
    const cents = Math.round(priced.discountAmount * 100);
    /* The guest sees this name on Stripe's page, so it has to say WHICH kind
       of give-away it was: an owner's code, a staff discount, or points they
       spent themselves. A loyalty reward carries no code, so without `label`
       it would be mislabelled "Staff discount". */
    const d = priced.discount || {};
    const label = d.label || d.code || (d.source === 'staff' ? 'Staff discount' : 'Discount');
    const c = await createDiscountCoupon(cents, label);
    if (c.error) {
      console.error('[kpot] discount coupon failed:', c.message);
      return { error: c.error, message: c.message };
    }
    form.set('discounts[0][coupon]', c.id);
  }

  // Show the order number on Stripe's page so the kitchen can match it up
  form.set('payment_intent_data[description]', 'KPOT To Go order ' + (ref || ''));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Stripe requires this for POSTs made without their SDK
        'Idempotency-Key': (ref || Date.now().toString(36)) + '-' + Math.random().toString(36).slice(2, 8)
      },
      body: form.toString(),
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || ('Stripe returned HTTP ' + resp.status);
    return { error: 'stripe_error', status: resp.status, message: msg };
  }
  if (!data.url) return { error: 'stripe_error', message: 'Stripe did not return a checkout URL' };

  /* payment_intent is null at creation time for hosted checkout — Stripe
     creates it lazily when the guest starts the flow. We return it anyway
     so the client can store it; if still null on return, verification falls
     back to checking the session itself. */
  return { url: data.url, id: data.id, paymentIntent: data.payment_intent || null };
}

/* Ask Stripe which payment methods a Checkout Session actually gets, then throw
   the probe session away. Used by the owner console to answer "where are Apple
   Pay and Google Pay?" — a question our own source code cannot answer, because
   the wallet buttons are added by Stripe based on Dashboard configuration and
   device capability.

   Notes for whoever reads the result:
     - `payment_method_types` lists the methods enabled for this account. Apple
       Pay and Google Pay are NOT listed as their own entries: both are delivered
       THROUGH `card`, and Stripe decides per-device whether to render the wallet
       button. So a session listing `card` is consistent with wallets working.
     - What actually makes them appear is the Dashboard toggle
       (Settings → Payment methods → Wallets) plus, for Apple Pay only, a
       verified domain under Settings → Payment method domains. */
async function probePaymentMethods() {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', 'https://example.invalid/probe');
  form.set('cancel_url', 'https://example.invalid/probe');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][product_data][name]', 'payment method probe');
  form.set('line_items[0][price_data][unit_amount]', '100');
  form.set('line_items[0][quantity]', '1');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': 'probe-' + Date.now().toString(36)
      },
      body: form.toString(),
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const session = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return {
      ok: false,
      reason: 'stripe_error',
      status: resp.status,
      message: (session.error && session.error.message) || ('HTTP ' + resp.status)
    };
  }

  /* Throw it away immediately so it can never be paid and never shows up in
     the Dashboard as an abandoned cart. */
  try {
    await fetch(STRIPE_API_SESSION + session.id + '/expire', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch (e) { /* best effort — an unexpired $1 probe is harmless */ }

  const types = session.payment_method_types || [];
  return {
    ok: true,
    keyMode: KEY_MODE,
    paymentMethodTypes: types,
    hasCard: types.includes('card'),
    /* Wallets ride on `card`; these flags tell the owner what to look for in the
       Dashboard rather than claiming the buttons will appear. */
    walletsCarriedByCard: types.includes('card'),
    otherMethods: types.filter((t) => t !== 'card')
  };
}

/* Write Stripe's verdict onto the board.
   Shared by the guest-return path (handleVerifySession) and the staff re-check
   path, so the two can never disagree about what "paid" means.

   The proof is always Stripe's own session data, never anything the caller
   asserts: client_reference_id carries our order number, so the mapping back to
   the board is exact and a caller would need a session id that Stripe itself
   reports as paid. */
function settleBoardFromStripe(out) {
  if (!out || !out.orderNo) return null;
  const o = orders.get(out.orderNo);
  if (!o) return null;
  const want = out.paid ? 'verified' : (out.paymentStatus || 'unverified');
  if (o.paymentStatus === want && (out.paid || o.status === 'cancelled')) return o;

  o.paymentStatus = want;
  o.paid = out.paid === true;
  /* A session Stripe does not report as paid must not leave an active order on
     the board — same intent the client had. */
  if (!out.paid) o.status = 'cancelled';
  o.updatedAt = new Date().toISOString();
  orders.set(out.orderNo, o);
  saveOrdersSoon();

  /* Money just got confirmed: with automation on, this is the moment a
     pickup/delivery order joins the kitchen. A dine-in order already went on
     arrival, and an unpaid session was cancelled just above, so there is
     nothing to advance in that direction. trustPayment because the verdict
     came from Stripe itself, not from anything the caller sent. */
  if (out.paid) {
    maybeAutoPrepare(o, 'payment confirmed', { trustPayment: true });
    /* …and this is also the only moment loyalty points are earned. Never at
       order creation: a guest who opens Stripe and walks away has not paid for
       anything. */
    awardLoyaltyFor(o, 'stripe confirmed');
  } else {
    /* The money never arrived and the order is cancelled, so whatever reward it
       was priced with goes back to the guest. */
    releaseLoyaltyFor(o, 'stripe says unpaid');
    releaseCreditFor(o, 'stripe says unpaid');
  }

  console.log('[kpot] board settled by Stripe: order ' + out.orderNo +
    ' -> ' + o.status + ' (' + o.paymentStatus + ')');
  return o;
}

/* -------------------------------------------------------------------------- */
/* Finding the Stripe session for an order, without trusting the browser       */
/* -------------------------------------------------------------------------- */
/* The session id is handed to the guest's browser and kept in its
   localStorage — the server never saw it. So when a guest pays and then closes
   the tab (or the phone dies) the confirmation never arrives and the order sits
   at 'pending' on the board forever, even though the money was taken.

   That is a money-safety problem, not a cosmetic one: staff cannot tell a paid
   order from an unpaid one, so they either collect twice or hand food over
   unsure. This finds the session server-side using the one thing we control —
   the order number we put in client_reference_id.

   Stripe's Search API is not available for checkout sessions on every account
   (verified: it returns "Received unknown parameters" here), so this lists
   sessions in a window around the order and filters. Bounded and paged, and it
   only ever runs when a human clicks "Re-check payment". */
async function findSessionForOrder(order) {
  const atMs = new Date(order.at || order.createdAt || Date.now()).getTime();

  /* The window is deliberately ASYMMETRIC.

     The order is written to the board before the guest is handed to Stripe (it
     has to be — that is how the number is reserved), so the session is always
     created AFTER the order. There is therefore little to look for before it:
     6h of slack covers nothing but clock skew.

     Forward is where the room is needed. A Checkout Session lives 24h, and a
     guest who walks away and comes back to retry gets a NEW session. If that
     retry landed outside the window we would find the OLD, unpaid session
     instead and report "not paid" — the exact wrong answer this feature exists
     to prevent. So the window runs out to 26h, just past Stripe's own expiry. */
  const gte = Math.floor((atMs - 6 * 60 * 60 * 1000) / 1000);    // 6h before
  const lte = Math.floor((atMs + 26 * 60 * 60 * 1000) / 1000);   // 26h after
  let startingAfter = null;

  /* Sessions come back newest first, so the walk starts at `lte` and goes
     backwards — in practice the match is on the first page. This cap is a
     safety net so a busy day cannot turn one button press into an unbounded
     crawl, not an expectation of how deep the answer sits. */
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    qs.set('created[gte]', String(gte));
    qs.set('created[lte]', String(lte));
    if (startingAfter) qs.set('starting_after', startingAfter);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let resp;
    try {
      resp = await fetch(STRIPE_API + '?' + qs.toString(), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + SECRET_KEY },
        signal: ac.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { error: 'stripe_error', status: resp.status,
        message: (data && data.error && data.error.message) || ('Stripe returned HTTP ' + resp.status) };
    }

    const rows = data.data || [];
    const mine = rows.filter((s) => s.client_reference_id === order.id);
    if (mine.length) {
      /* A guest who retried payment can have more than one session. Prefer one
         Stripe reports as paid; otherwise take the newest. */
      const paid = mine.filter((s) => s.payment_status === 'paid');
      const pick = (paid.length ? paid : mine).sort((a, b) => b.created - a.created)[0];
      return { sessionId: pick.id };
    }
    if (!data.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
  }
  return { error: 'session_not_found' };
}

/* Staff-facing: ask Stripe again and settle the board. */
async function recheckPayment(orderId) {
  const o = orders.get(orderId);
  if (!o) return { error: 'order_not_found' };
  if (!SECRET_KEY) return { error: 'stripe_not_configured' };
  if (o.payMethod !== 'stripe') return { error: 'not_a_card_order', message: 'This order was not paid online.' };

  const found = await findSessionForOrder(o);
  if (found.error) {
    return { error: found.error, message: found.message || 'No Stripe payment found for this order.' };
  }

  const out = await verifySession(found.sessionId);
  if (out.error) return { error: out.error, message: out.message };

  const settled = settleBoardFromStripe(out);
  console.log('[kpot] recheck', orderId, found.sessionId.slice(0, 20) + '…',
    '->', out.paymentStatus, settled ? settled.paymentStatus : '(order missing)');
  return {
    ok: true,
    sessionId: found.sessionId,
    paid: out.paid,
    paymentStatus: out.paymentStatus,
    sessionStatus: out.sessionStatus,
    amountTotal: out.amountTotal
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying that a payment actually happened                                  */
/* -------------------------------------------------------------------------- */
/* The success_url Stripe sends a guest back to is just a URL. Anyone can type
   it into the address bar, so it can NEVER be treated as proof of payment.
   This asks Stripe directly what happened to that session, and only a
   payment_status of "paid" counts.

   Only non-identifying fields are returned — no customer name, email or card
   details — so a leaked session id (they are high-entropy and unguessable)
   cannot be used to harvest anything. */
async function verifySession(id) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(STRIPE_API_SESSION + encodeURIComponent(id), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + SECRET_KEY },
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return {
      error: 'stripe_error',
      status: resp.status,
      message: (data && data.error && data.error.message) || ('Stripe returned HTTP ' + resp.status)
    };
  }

  return {
    paid: data.payment_status === 'paid',
    sessionStatus: data.status,             // 'open' | 'complete' | 'expired'
    paymentStatus: data.payment_status,     // 'paid' | 'unpaid' | 'no_payment_required'
    amountTotal: data.amount_total,
    currency: data.currency,
    orderNo: data.client_reference_id || ''
  };
}

/* Stripe session ids look like cs_test_<long> / cs_live_<long>. Reject anything
   else before spending a network round trip on it. */
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,220}$/;

/* -------------------------------------------------------------------------- */
/* Request handling                                                            */
/* -------------------------------------------------------------------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Very light per-IP throttle so one script cannot hammer Stripe. */
const hits = new Map();
function throttled(ip, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.n > max;
}

/* POST /api/price — what would this order cost, with this code?

   Exists because the guest has to SEE the discount before they pay, and
   because a pay-at-counter order never touches Stripe at all (so the checkout
   response is not available to tell them). It prices and reports only: it
   starts no payment, creates no order, and does not spend the code. */
async function handlePrice(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced. Every one of these endpoints used to key the counter by the
     bare IP, and throttled() keeps ONE counter per key — so a guest re-pricing
     their basket (which happens on every reward choice) spent the allowance
     that handleCreateOrder needed, and the shop's wifi hands every table the
     same address. Same reasoning as the claim key below. */
  if (throttled('price:' + ip, 40, 60000)) return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many attempts. Please wait a moment.' });

  let raw;
  try { raw = await readBody(req, 64 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  const base = priceOrder(body, ASSETS.MENU, ASSETS.CONFIG, deliveryPricingOpts());
  if (base.error) return sendJSON(res, 400, { error: base.error, message: 'Could not price that order.' });

  const reward = resolveOrderDiscount(body, base, body.orderType);
  if (reward.error) return sendJSON(res, 409, { error: reward.error, message: reward.message });

  const priced = reward.discount ? applyDiscount(base, reward.discount, ASSETS.CONFIG) : base;
  /* What the store credit is doing on THIS order, and what it will have left
     afterwards. The guest page shows both — the rules promise the remaining
     balance after every successful payment, and this is the number the ledger
     will actually hold once the order is recorded. */
  let credit = null;
  if (reward.kind === 'credit' && reward.entry) {
    credit = {
      applied: priced.discountAmount || 0,
      balanceAfter: round2((reward.entry.balance || 0) - (priced.discountAmount || 0)),
      codeRef: reward.entry.codeRef || '',
      expiresAt: reward.entry.expiresAt || ''
    };
  }
  return sendJSON(res, 200, {
    subtotal: priced.subtotal,
    delivery: priced.delivery,
    tax: priced.tax,
    tip: priced.tip,
    total: priced.total,
    discount: priced.discountAmount || 0,
    discountCode: (priced.discount && priced.discount.code) || '',
    discountLabel: (priced.discount && priced.discount.label) || '',
    discountSource: (priced.discount && priced.discount.source) || '',
    credit: credit
  });
}

async function handleCheckout(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced for the same reason as the others: this one creates Stripe
     sessions, and it must not be starved by re-pricing, nor starve ordering. */
  if (throttled('checkout:' + ip, 20, 60000)) return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many attempts. Please wait a moment.' });

  if (!SECRET_KEY) {
    return sendJSON(res, 503, {
      error: 'stripe_not_configured',
      message: 'Online payment is not set up yet. Please choose "Pay at Counter".'
    });
  }

  let raw;
  try {
    raw = await readBody(req, 64 * 1024);
  } catch (e) {
    return sendJSON(res, 413, { error: 'payload_too_large' });
  }

  let order;
  try {
    order = JSON.parse(raw);
  } catch (e) {
    return sendJSON(res, 400, { error: 'bad_json' });
  }

  const basePriced = priceOrder(order, ASSETS.MENU, ASSETS.CONFIG, deliveryPricingOpts());
  if (basePriced.error) {
    console.warn('[kpot] rejected order:', basePriced.error, basePriced.item || '');
    return sendJSON(res, 400, { error: basePriced.error, message: 'We could not price that order. Please try again.' });
  }

  /* Discount code — or the guest's own reward. Resolved and priced HERE: a
     guest can type any code they like into a request, so what it is worth has
     to be decided where the price is decided. Not spent yet: this only starts
     a payment. */
  const reward = resolveOrderDiscount(order, basePriced, order.orderType);
  if (reward.error) {
    console.warn('[kpot] discount refused —', reward.error);
    return sendJSON(res, 409, { error: reward.error, message: reward.message });
  }
  const priced = reward.discount ? applyDiscount(basePriced, reward.discount, ASSETS.CONFIG) : basePriced;

  /* Re-check the store switches HERE, not just in the browser. The guest page
     hides or greys out a switched-off channel, but the request that actually
     moves money arrives from the client — and a client is not a place to
     enforce a business rule. Delivery switched off mid-session must not be
     able to take a card payment.

     `scheduled` is read off the payload, the same field handleCreateOrder
     trusts (body.schedule): a delivery booked for tomorrow's window is
     legitimate while the shop is closed tonight, everything else is an
     immediate order and the business-hours check applies. It used to
     reference a variable that does not exist in this function, which threw
     on every checkout — a 500 for every guest trying to pay online. The
     lesson: a identifier that parses cleanly is not an identifier that
     exists. The suite that runs without STRIPE_TEST_KEY never reached this
     line, which is why nothing went red. */
  const sched = (order.schedule && typeof order.schedule === 'object') ? order.schedule : null;
  const gate = storeGate(order.orderType, {
    scheduled: !!(sched && sched.date && sched.slot),
    hoursSpec: hoursSpec()
  });
  if (gate.blocked) {
    console.warn('[kpot] checkout refused —', gate.code, '| type:', JSON.stringify(order.orderType));
    const msg = {
      closed: 'We are currently closed. Please try again during opening hours.',
      not_accepting: 'We are not accepting orders right now.',
      type_off: 'We are not taking ' + gate.label + ' orders right now.',
      unknown_type: 'That order type was not recognised. Please pick Pickup, Dine-In, or Delivery.'
    }[gate.code] || 'We could not accept that order type.';
    return sendJSON(res, 409, { error: gate.code, message: msg });
  }

  /* ---- Delivery distance — the 2-mile rule -------------------------------
     Same reasoning as the gate above, one business rule down: a guest outside
     the delivery radius must not be handed to Stripe. This is where money
     moves, so the check happens HERE as well as at order creation — the
     browser's live check is a courtesy, not the enforcement.

     Fail-open by design (geo.js): if the address cannot be verified the
     order proceeds and the kitchen sees the address on the ticket. Only a
     positive measurement — a coordinate beyond the radius — refuses. */
  if (order.orderType === 'delivery') {
    const geo = await G.deliveryCheck((order.customer || {}).when);
    if (geo.status === 'blocked') {
      console.warn('[kpot] checkout refused — delivery out of range —',
        geo.miles !== null ? geo.miles.toFixed(2) + ' mi (' + geo.source + ')' : geo.source,
        '| addr:', JSON.stringify(String((order.customer || {}).when || '').slice(0, 80)));
      return sendJSON(res, 409, {
        error: 'delivery_out_of_range',
        miles: geo.miles,
        radius: G.RADIUS_MI,
        message: geo.message || 'That address is outside our ' + G.RADIUS_MI +
          '-mile delivery area. Please choose Pickup or Dine-In.'
      });
    }
  }

  /* ---- Delivery minimum — the second money gate --------------------------
     Same rule, same order of business as handleCreateOrder: the radius
     decides WHERE we deliver, this decides HOW BIG an order has to be. Runs
     after the distance gate (a far-away small order is a distance problem,
     and the guest fixes the address or the type before the cart) and before
     Stripe, because there is no point taking a card for an order the kitchen
     will refuse at the door.

     Measured on `priced.subtotal` — the gross food line, which applyDiscount
     leaves untouched (it only re-computes tax and total), so a guest at $12
     who redeems a $3 reward still clears a $10 floor. */
  const minVerdict = deliveryMinVerdict(priced.subtotal, order.orderType, ASSETS.CONFIG);
  if (minVerdict.blocked) {
    console.warn('[kpot] checkout refused — delivery below minimum — $' +
      priced.subtotal.toFixed(2) + ' < $' + minVerdict.min.toFixed(2));
    return sendJSON(res, 409, {
      error: 'delivery_below_minimum',
      min: minVerdict.min,
      subtotal: minVerdict.subtotal,
      short: minVerdict.short,
      message: 'Delivery orders start at $' + minVerdict.min.toFixed(2) +
        ' of food — add $' + minVerdict.short.toFixed(2) +
        ' more, or choose Pickup or Dine-In.'
    });
  }

  try {
    /* The store credit's share of this order and what it will have left. The
       guest page adopts these onto the order so the ticket shown on return
       can state the remaining balance — the rules promise it after every
       successful payment. Nothing is SPENT here: handing a guest to Stripe is
       not a purchase (the balance moves in handleCreateOrder). */
    let credit = null;
    if (reward.kind === 'credit' && reward.entry) {
      credit = {
        codeHash: reward.entry.codeHash,
        codeRef: reward.entry.codeRef || '',
        applied: priced.discountAmount || 0,
        balanceAfter: round2((reward.entry.balance || 0) - (priced.discountAmount || 0)),
        expiresAt: reward.entry.expiresAt || ''
      };
    }

    /* ---- Fully covered by credit: no payment page at all ----------------
       A store-credit code can cover the whole bill — that is what a "$66
       store-credit code" is FOR. Stripe cannot charge $0 (an empty line-item
       list is refused), and walking a guest through a payment page for
       nothing would be absurd. The total was computed HERE from the menu and
       the code's own balance, so "nothing is owed" needs no trust in the
       browser: the only way to reach this branch is priced.total === 0. The
       credit itself is still spent in handleCreateOrder, exactly as for a
       part-paid order — nothing here moves money. */
    if (round2(priced.total) <= 0.005) {
      console.log('[kpot] order ' + (order.orderNo || '?') +
        ' fully covered by store credit — no payment needed');
      return sendJSON(res, 200, {
        url: null,
        covered: true,
        id: '',
        paymentIntent: null,
        total: 0,
        breakdown: {
          subtotal: priced.subtotal,
          delivery: priced.delivery,
          tax: priced.tax,
          tip: priced.tip,
          discount: priced.discountAmount || 0,
          discountCode: (priced.discount && priced.discount.code) || '',
          discountLabel: (priced.discount && priced.discount.label) || '',
          discountSource: (priced.discount && priced.discount.source) || '',
          credit: credit
        }
      });
    }

    const out = await createStripeSession(priced, order, requestBaseUrl(req));
    if (out.error) {
      console.error('[kpot] stripe error:', out.status || '', out.message);
      /* Never surface Stripe's raw text to a guest — it can name the key mode
         and expose internal detail. The full message is in the server log
         above; the guest gets something actionable. */
      const friendly = (out.status === 401 || out.status === 403)
        ? 'Online payment is temporarily unavailable. Please choose "Pay at Counter".'
        : 'We could not start the payment. Please try again, or choose "Pay at Counter".';
      return sendJSON(res, 502, { error: out.error, message: friendly });
    }
    console.log('[kpot] session created', out.id, 'order', order.orderNo, 'total $' + priced.total.toFixed(2));
    return sendJSON(res, 200, {
      url: out.url,
      id: out.id,
      paymentIntent: out.paymentIntent,
      total: priced.total,
      breakdown: {
        subtotal: priced.subtotal,
        delivery: priced.delivery,
        tax: priced.tax,
        tip: priced.tip,
        discount: priced.discountAmount || 0,
        discountCode: (priced.discount && priced.discount.code) || '',
        discountLabel: (priced.discount && priced.discount.label) || '',
        discountSource: (priced.discount && priced.discount.source) || '',
        credit: credit
      }
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    console.error('[kpot] checkout failed:', aborted ? 'stripe timeout' : e.message);
    return sendJSON(res, 502, {
      error: 'upstream_error',
      message: aborted ? 'Stripe took too long to respond. Please try again.' : 'Could not reach Stripe. Please try again.'
    });
  }
}

/* POST /api/delivery/check { address } — the guest's browser asks this while
   the delivery address is being typed, so an out-of-range address is caught
   BEFORE the guest pays rather than at "Place Order".

   Advisory only. The enforcing gates are the ones in handleCheckout and
   handleCreateOrder: anything a browser can be told, a guest can skip (a
   stale tab, a hand-built request). This endpoint exists so the honest
   answer reaches the guest early.

   Heavily throttled and tiny: it geocodes an address, so each call costs an
   outbound request, and a typing guest must not be able to turn that into a
   geocoding hammer. */
async function handleDeliveryCheck(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  if (throttled('geocheck:' + ip, 60, 60000)) {
    return sendJSON(res, 429, { error: 'rate_limited', status: 'unknown' });
  }

  let raw;
  try { raw = await readBody(req, 8 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json', status: 'unknown' }); }

  const address = String((body && body.address) || '').slice(0, 300);
  const geo = await G.deliveryCheck(address);
  return sendJSON(res, 200, {
    status: geo.status,                 /* 'ok' | 'blocked' | 'unknown' */
    ok: geo.status !== 'blocked',
    miles: geo.miles,
    radius: G.RADIUS_MI,
    source: geo.source,                 /* 'street' | 'zip' | 'unverified' | 'empty' */
    message: geo.message || ''
  });
}

/* GET /api/verify-session?id=cs_... — did this payment really go through?
   Deliberately cheap to call and read-only, so it gets a looser throttle than
   checkout: a guest returning from Stripe hits it once, but a flaky connection
   may retry. */
async function handleVerifySession(req, res, url) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced: the guest arrives here once per payment, and must not be
     turned away because their own re-pricing used up a shared counter. */
  if (throttled('verify:' + ip, 60, 60000)) {
    return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many checks. Please wait a moment.' });
  }

  if (!SECRET_KEY) {
    return sendJSON(res, 503, { error: 'stripe_not_configured', verified: false });
  }

  const id = url.searchParams.get('id') || '';
  if (!SESSION_ID_RE.test(id)) {
    return sendJSON(res, 400, { error: 'bad_session_id', verified: false });
  }

  const out = await verifySession(id);
  if (out.error) {
    console.error('[kpot] verify failed:', out.status || '', out.message);
    /* A failed lookup must never read as "paid". The client treats anything
       other than an explicit verified:true as unconfirmed. */
    return sendJSON(res, 502, { error: out.error, verified: false });
  }

  console.log('[kpot] verify', id.slice(0, 20) + '…',
    out.paymentStatus, '$' + ((out.amountTotal || 0) / 100).toFixed(2), 'order', out.orderNo || '-');

  /* Settle the board HERE, on the server, the moment Stripe confirms.

     The guest's browser used to PATCH the order itself after verifying — but
     PATCH is admin-gated (see handleUpdateOrder), so the guest's request came
     back 401 and a PAID order sat on the kitchen board still marked UNPAID.
     The stubbed test server has no auth on PATCH, which is exactly why that
     went unnoticed until a real Stripe run.

     Doing it here is better regardless: the proof is Stripe's own session
     data rather than anything the client asserts.

     NOTE this still depends on the guest's browser making the call at all. If
     they pay and close the tab, nothing arrives and the order stays 'pending'
     — which is what the staff-facing re-check (POST .../recheck-payment) is
     for. Do not remove it on the assumption that this covers every case. */
  settleBoardFromStripe(out);

  return sendJSON(res, 200, {
    verified: out.paid,
    sessionStatus: out.sessionStatus,
    paymentStatus: out.paymentStatus,
    amountTotal: out.amountTotal,
    currency: out.currency,
    orderNo: out.orderNo
  });
}

/* -------------------------------------------------------------------------- */
/* Order management — live board + customer status + store controls            */
/* -------------------------------------------------------------------------- */
/* The storefront is still a static SPA, but the owner needs a backend view of
   incoming orders and a way to flip their status (so the guest's ticket page
   can show "Being prepared" -> "Ready for pickup"). Orders live in memory and
   are snapshotted to orders.local.json so a restart doesn't lose the night's
   tickets. No database, no extra dependency. */

/* Admin key resolution. The environment wins, exactly like the Stripe key
   above: a host that injects ADMIN_KEY must not be silently overridden by a
   stale copy left in secrets.local.json. */
function loadAdminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY.trim();
  try {
    const p = SECRETS_FILE;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.adminKey) return String(j.adminKey).trim();
  } catch (e) { /* no local secrets — fine */ }
  return '';
}

let ADMIN_KEY = loadAdminKey();
if (!ADMIN_KEY) {
  console.warn('[kpot] ADMIN_KEY not set — order/admin endpoints are OPEN. ' +
    'Set adminKey in secrets.local.json before going live.');
}

/* The print agent's key. The agent runs on a machine in the restaurant, so it
   gets its own credential rather than the owner's console password — if that
   machine is ever compromised the blast radius stays "can fetch print jobs".
   This key is INDEPENDENT of ADMIN_KEY: the admin/console key is never accepted
   as a print key, so rotating the print key or the admin key does not weaken
   the other. If the console is locked with ADMIN_KEY but no printKey is set,
   the print endpoint is LOCKED — set printKey (a different value) to let the
   agent fetch jobs. Only when NO keys are configured at all does the endpoint
   run open (dev mode). */
function loadPrintKey() {
  if (process.env.PRINT_KEY) return process.env.PRINT_KEY.trim();
  try {
    const p = SECRETS_FILE;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.printKey) return String(j.printKey).trim();
  } catch (e) { /* no local secrets — fine */ }
  return '';
}
let PRINT_KEY = loadPrintKey();
if (!PRINT_KEY && ADMIN_KEY) {
  console.warn('[kpot] ADMIN_KEY is set but PRINT_KEY is not — the print agent');
  console.warn('       endpoint is LOCKED until you add a printKey to');
  console.warn('       secrets.local.json (a DIFFERENT value from adminKey).');
} else if (!PRINT_KEY) {
  console.warn('[kpot] PRINT_KEY not set — the print agent endpoint is OPEN (dev mode).');
}

/* The driver's key. Third independent credential, same shape as the print
   key: the driver's phone gets to see the day's delivery run (guest addresses
   and phone numbers) and to mark a delivery done, and NOTHING else — not the
   store controls, not the prices, not the whole board.

   Unlike the print key this one FAILS CLOSED. The queue is a list of where
   the shop's customers live; an unconfigured server must not publish it just
   because it is also unconfigured for printing. With DRIVER_KEY unset, GET
   /api/driver/queue answers 401 and driver.html says so on screen. */
function loadDriverKey() {
  if (process.env.DRIVER_KEY) return process.env.DRIVER_KEY.trim();
  try {
    const p = SECRETS_FILE;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.driverKey) return String(j.driverKey).trim();
  } catch (e) { /* no local secrets — fine */ }
  return '';
}
let DRIVER_KEY = loadDriverKey();
if (!DRIVER_KEY) {
  console.warn('[kpot] DRIVER_KEY not set — the driver queue endpoint is LOCKED.');
  console.warn('       Set driverKey in secrets.local.json (a DIFFERENT value from');
  console.warn('       adminKey) to let the driver page work.');
}

/* Accepts the driver key OR the owner's admin key: the owner is allowed to
   look at their own delivery run, and the console key is the stronger
   credential, so honouring it here adds no hole. The reverse is NOT true —
   the driver key never opens anything else (see handleUpdateOrder). */
function driverAuthorized(req) {
  if (DRIVER_KEY && String(req.headers['x-driver-key'] || '') === DRIVER_KEY) return true;
  if (ADMIN_KEY && String(req.headers['x-admin-key'] || '') === ADMIN_KEY) return true;
  return false;
}

/* ---- Outgoing mail ------------------------------------------------------
   Back on 2026-10-17, after a short removal: the owner dropped the e-mail
   recovery path on 2026-10-16 ("不需要EMAIL验证了，凭手机号码就可以领奖励了"),
   which briefly took the mailer with it, then asked for new-order e-mail
   notifications — so `mailer.js` (zero-dependency SMTP) is loaded at the top of
   this file and sends two messages: one to the owner when an order arrives,
   one to the guest when it is ready. Credentials live in
   secrets.local.json (gmailUser / gmailAppPassword); when they are missing the
   mailer reports `not configured` and every sender no-ops silently — orders
   still flow, only the notifications stop. */

/* ---- The shop's clock ---------------------------------------------------
   Every date this server computes is LOCAL-time arithmetic: dateKeyOf() decides
   what "today" is, selectableDates() decides what "tomorrow" is, and
   scheduledForMs() decides the exact moment the kitchen starts a scheduled
   delivery. All three are only correct if the host's clock sits in the shop's
   own timezone.

   This is not theoretical. The server first went live on a box running
   Etc/UTC and nothing complained: a 12:00 PM–1:00 PM Atlanta window was given
   a kitchen-start timestamp of 11:30 UTC — 7:30 AM in Atlanta — and between
   8 PM and midnight every night the server believed it was already tomorrow.
   Silently. So the mismatch is checked at boot and said out loud, because the
   symptom (food started four hours early) looks nothing like the cause.

   Pure, so _dev/test_schedule.js can exercise it without spawning anything. */
function timezoneWarning(hostTz, expectedTz) {
  if (!expectedTz) return null;                 // nothing declared, nothing to check
  if (!hostTz) return null;                     // host will not say — cannot judge
  if (hostTz === expectedTz) return null;
  return '[kpot] host timezone is ' + hostTz + ' but the shop is in ' + expectedTz +
    ' — every scheduled delivery will be computed against the wrong clock. Fix with: ' +
    'sudo timedatectl set-timezone ' + expectedTz;
}
{
  let hostTz = '';
  try { hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  const tzWarning = timezoneWarning(hostTz, ((ASSETS.CONFIG || {}).store || {}).timezone);
  if (tzWarning) { console.warn(tzWarning); console.warn('       (TZ env var or the host clock)'); }
}

const STATUS_LABELS = {
  received: 'Order received',
  preparing: 'Being prepared',
  ready: 'Ready for pickup',
  completed: 'Completed',
  cancelled: 'Cancelled'
};
const VALID_STATUS = Object.keys(STATUS_LABELS);

const orders = new Map();
/* Redirectable so a test can run against scratch files instead of the shop's
   real data. Defaults are unchanged, so production behaviour is identical. */
const ORDERS_FILE = process.env.KPOT_ORDERS_FILE || path.join(ROOT, 'orders.local.json');

/* The loyalty ledger. Declared HERE, next to the order board and well above
   writeBackup(), because `let` sits in the temporal dead zone until its own
   line runs — and the backup loop starts during module load, long before the
   loyalty section further down would have been reached. */
const CUSTOMERS_FILE = process.env.KPOT_CUSTOMERS_FILE || path.join(ROOT, 'customers.local.json');
let customers = [];

function loadCustomersStore() {
  const r = L.loadCustomers(CUSTOMERS_FILE);
  customers = r.customers;
  if (customers.length) {
    console.log('[kpot] loyalty: ' + customers.length + ' member(s) loaded from ' +
      path.basename(CUSTOMERS_FILE));
  }
}

function saveCustomersStore() {
  try {
    return L.saveCustomers(CUSTOMERS_FILE, customers);
  } catch (e) {
    console.error('[kpot] could not save customers:', e.message);
    return null;
  }
}

/* The store-credit ledger — the LUCKY 66 prize codes as spendable money.
   Same shape and same reason as the loyalty ledger above: redirectable so a
   test can never touch the shop's real balances, loaded at boot. The plaintext
   of a code never reaches this file; only its sha256 does (credits.js). */
const CREDITS_FILE = process.env.KPOT_CREDITS_FILE || path.join(ROOT, 'credits.local.json');
let credits = CR.blankStore();

function loadCreditsStore() {
  credits = CR.loadCredits(CREDITS_FILE);
  const n = Object.keys(credits.codes || {}).length;
  if (n) {
    console.log('[kpot] credits: ' + n + ' code(s) loaded from ' + path.basename(CREDITS_FILE));
  }
}

function saveCreditsStore() {
  try {
    return CR.saveCredits(CREDITS_FILE, credits);
  } catch (e) {
    console.error('[kpot] could not save credits:', e.message);
    return null;
  }
}

function loadOrders() {
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((o) => { if (o && o.id) orders.set(o.id, o); });
      console.log('[kpot] loaded ' + orders.size + ' orders from ' + path.basename(ORDERS_FILE));
    }
  } catch (e) { /* no snapshot yet — fresh start */ }
}

let saveTimer = null;

/* Write the board to disk right now. Used by the debounced saver and, more
   importantly, on shutdown — without this a restart landing inside the 800ms
   debounce window would silently drop the orders created in that window.

   ATOMICALLY. This is not tidiness: writeFileSync is not atomic, so a process
   killed part-way through one leaves the file TRUNCATED, and the next start
   then finds an unparseable board and drops every order on it. That is not
   hypothetical — it is exactly what test_backups.js caught: a SIGKILL landing
   inside a periodic flush left "Unexpected end of JSON input" on disk. Windows
   has no SIGTERM to give us a clean pause, so the only safe moment is one that
   cannot be interrupted half-done: temp file, then rename. */
function saveOrdersNow() {
  try {
    writeFileAtomic(ORDERS_FILE, JSON.stringify(Array.from(orders.values()), null, 2));
  } catch (e) { console.error('[kpot] could not save orders:', e.message); }
}

/* ---- The signal problem (read this before touching shutdown) --------------
   On Windows, SIGTERM is not a real signal: Node kills the process outright and
   neither `process.on('SIGTERM')` nor `process.on('exit')` ever runs. Verified
   on this machine — the child exits with signal=SIGTERM and prints nothing.

   Consequences:
     * On a Windows dev box the shutdown flush below CANNOT run, so anything
       still inside the 800ms debounce window is lost on Ctrl-C / taskkill.
     * On Linux (the deploy container) the handlers DO run, so the flush and the
       shutdown backup work as intended.

   Because we cannot rely on a clean shutdown anywhere, the real safety net is
   the SHORT DEBOUNCE plus the periodic backup — not the exit handler. Keep the
   debounce small and never make order durability depend on shutdown alone. */

/* Re-entrancy / recursion guard: writeBackup is called from `exit`, and any
   throw inside an exit handler can trigger another exit. */
let busySaving = false;

function saveOrdersNowSafe() {
  if (busySaving) return;
  busySaving = true;
  try { saveOrdersNow(); }
  catch (e) { console.error('[kpot] save failed:', e.message); }
  finally { busySaving = false; }
}

/* ---- CSV shaping (shared by the export endpoint and the daily backup) -----
   Declared up here on purpose: startBackupLoop() runs during startup, and a
   `const` further down the file would still be in its temporal dead zone. */

const CSV_COLUMNS = [
  'id', 'at', 'updatedAt', 'status', 'paymentStatus', 'payMethod', 'orderType',
  'table', 'customerName', 'customerPhone', 'subtotal', 'tax', 'tip',
  'delivery', 'total', 'source', 'itemsSummary'
];

function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  /* Quote everything and double any embedded quote — the safe universal form.
     Also neutralise a leading =/+/-/@ so a spreadsheet cannot treat a customer
     name as a formula. */
  const dangerous = /^[=+\-@]/.test(s);
  const body = s.replace(/"/g, '""');
  return '"' + (dangerous ? "'" + body : body) + '"';
}

/* One human-readable line per ordered item, e.g.
   "2x BBQ To Go (2 Meats) [Pork Belly, Beef Brisket]; 1x Thai Tea" */
function summariseItems(o) {
  const lines = Array.isArray(o.lines) && o.lines.length ? o.lines : (o.items || []);
  return lines.map((l) => {
    const qty = l.qty || l.quantity || 1;
    const name = l.name || l.n || 'Item';
    const mods = Array.isArray(l.mods) && l.mods.length ? ' [' + l.mods.join(', ') + ']' : '';
    const addons = Array.isArray(l.addons) && l.addons.length ? ' {' + l.addons.join(', ') + '}' : '';
    return qty + 'x ' + name + mods + addons;
  }).join('; ');
}

function orderToRow(o) {
  const c = o.customer || {};
  return [
    o.id, o.at, o.updatedAt, o.status, o.paymentStatus, o.payMethod, o.orderType,
    o.table, c.name, c.phone, o.subtotal, o.tax, o.tip, o.delivery, o.total,
    /* Which poster / flyer / campaign brought this order in. The owner needs it
       in the spreadsheet, not just in the JSON, or "did the window poster pay
       for itself?" is a question nobody can answer. */
    o.source || 'storefront',
    summariseItems(o)
  ];
}

function csvFor(arr) {
  const rows = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const o of arr) rows.push(orderToRow(o).map(csvCell).join(','));
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

/* ---- Rolling backups ------------------------------------------------------
   orders.local.json sits in the container and dies with it. Once a day (and on
   every clean shutdown) we also drop a dated CSV + JSON into BACKUP_DIR. If
   the platform maps that directory to persistent storage, the backups outlive
   the container; if it does not, the owner can still pull them via
   /api/orders/export.csv from the back office at any time.

   Written atomically (temp file + rename) so a crash mid-write can never leave
   a half-written backup where a good one used to be. */

const BACKUP_DIR = process.env.ORDERS_BACKUP_DIR || path.join(ROOT, 'order-backups');
const BACKUP_KEEP_DAYS = 30;

function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeBackup(reason) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const arr = Array.from(orders.values()).sort((a, b) => new Date(a.at) - new Date(b.at));
    const stamp = new Date().toISOString().slice(0, 10);

    writeFileAtomic(path.join(BACKUP_DIR, 'orders-' + stamp + '.csv'), csvFor(arr));
    writeFileAtomic(
      path.join(BACKUP_DIR, 'orders-' + stamp + '.json'),
      JSON.stringify({ exportedAt: new Date().toISOString(), reason, count: arr.length, orders: arr }, null, 2)
    );

    /* The loyalty ledger gets the same treatment. It is far smaller than the
       order board, but it is the one file a guest will come back and ask
       about — losing it is not something an apology fixes. */
    writeFileAtomic(path.join(BACKUP_DIR, 'members-' + stamp + '.csv'), L.toCsv(customers, Date.now()));
    writeFileAtomic(
      path.join(BACKUP_DIR, 'members-' + stamp + '.json'),
      JSON.stringify({
        exportedAt: new Date().toISOString(), reason,
        count: customers.length, customers
      }, null, 2)
    );
    pruneBackups();
  } catch (e) {
    /* A failed backup must never take the server down. */
    console.error('[kpot] backup failed:', e.message);
  }
}

/* Keep the directory from growing forever. */
function pruneBackups() {
  try {
    const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const m = /^(orders|members)-(\d{4}-\d{2}-\d{2})\.(csv|json)$/.exec(f);
      if (!m) continue;
      if (new Date(m[2] + 'T00:00:00Z').getTime() < cutoff) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
    }
  } catch (e) { /* first run, or nothing to prune — fine */ }
}

let backupTimer = null;

/* Snapshot at startup (captures the state we just loaded, so a restart never
   leaves the day with no backup at all), then once every 24h. */
function startBackupLoop() {
  writeBackup('startup');
  backupTimer = setInterval(() => writeBackup('daily'), 24 * 60 * 60 * 1000);
  if (backupTimer.unref) backupTimer.unref();
}

/* Belt-and-braces flush. On Windows no exit handler runs (see the note above),
   so a long-lived server must not depend on shutdown to get data to disk. This
   writes the board whenever it changed — cheap, and it bounds the worst-case
   loss to one interval even on a hard kill.

   Overridable so the test suite can prove the behaviour quickly. */
const FLUSH_MS = Math.max(500, parseInt(process.env.KPOT_FLUSH_MS || '', 10) || 30 * 1000);
let lastFlushSignature = '';
let flushTimer = null;

function orderSignature() {
  /* Cheap change-detector: count + newest updatedAt. Avoids re-serialising the
     whole board just to discover nothing changed. */
  let newest = '';
  for (const o of orders.values()) {
    if (o.updatedAt && o.updatedAt > newest) newest = o.updatedAt;
  }
  return orders.size + '|' + newest;
}

function startFlushLoop() {
  lastFlushSignature = orderSignature();
  flushTimer = setInterval(() => {
    const sig = orderSignature();
    if (sig !== lastFlushSignature) {
      lastFlushSignature = sig;
      saveOrdersNowSafe();
      writeBackup('periodic');
    }
  }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function saveOrdersSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveOrdersNow();
  }, 800);
}

loadOrders();
/* Snapshot immediately so the day starts with a backup on disk, even if the
   container is torn down before the first order arrives. */
startBackupLoop();
/* Independent of shutdown: get data to disk even if the process is killed
   hard and no exit handler runs (always the case on Windows). */
startFlushLoop();
startScheduleLoop();
startStoreHoursLoop();
if (PUSH) PUSH.init();

/* ---- The delivery window tick ---------------------------------------------
   A scheduled order sits on the board as `received` until its window opens,
   then joins the kitchen by itself. Nothing else moves it: the guest is not
   there to trigger anything, and there is no external cron.

   Deliberately narrow. It only ever touches orders that HAVE a scheduledFor in
   the past, so it can never reach a dine-in or pickup order that the arrival
   and payment paths already handle. `maybeAutoPrepare` is idempotent by
   status, so a tick that fires twice is a no-op the second time. */
function startScheduleLoop() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const o of orders.values()) {
      if (o.status !== 'received') continue;
      const due = scheduledForMsOf(o);
      if (!due || due > now) continue;
      if (maybeAutoPrepare(o, 'delivery window reached', { trustPayment: true })) {
        saveOrdersSoon();
        fireDispatch(o);
      }
    }
  }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/* ---- Store hours tick -------------------------------------------------------
   The owner's manual open/closed switch is for OVERRIDES (e.g. closing early
   for a private event). Day-to-day, the shop follows its configured business
   hours: when opening time arrives BOTH `open` and `acceptingOrders` flip to
   true; when closing time arrives BOTH flip to false. `open` is held strictly
   on the hours clock. `acceptingOrders` is re-synced to the hours state ONLY at
   an open/close transition (and on the very first tick, to heal a stale
   persisted value) — so an in-day manual pause of orders is preserved until
   the next transition, while the store still auto-opens and auto-closes both
   flags in lockstep with business hours. */
function startStoreHoursLoop() {
  let lastHoursOpen = null;
  const tick = () => {
    const closed = hoursClosedNow(hoursSpec());
    const wantOpen = !closed;
    let changed = false;
    /* `open` is always driven by the hours clock. */
    if (storeStatus.open !== wantOpen) {
      storeStatus.open = wantOpen;
      changed = true;
    }
    /* Sync `acceptingOrders` to the hours clock: heal any stale persisted value
       on the first tick, then re-sync only on an open/close transition so a
       manual in-day pause of orders survives until the next transition. */
    if (lastHoursOpen === null || lastHoursOpen !== wantOpen) {
      if (storeStatus.acceptingOrders !== wantOpen) {
        storeStatus.acceptingOrders = wantOpen;
        changed = true;
      }
    }
    if (changed) {
      saveStoreStatus();
      console.log('[kpot] store hours tick -> open=' + wantOpen +
        ' acceptingOrders=' + storeStatus.acceptingOrders);
    }
    lastHoursOpen = wantOpen;
  };
  /* Defer the first tick: storeStatus is declared with `let` further down
     in this module, so touching it synchronously here (during module load)
     hits the temporal dead zone. */
  setTimeout(tick, 0);
  const timer = setInterval(tick, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/* ---- Order numbers --------------------------------------------------------
   The SERVER owns order numbers. The old scheme generated KP-YYMMDD-NNN from a
   per-device counter, so every guest's first order of the day was -001 and two
   guests on different phones collided — the second order was silently merged
   into the first. Now the server issues the number, so that can never happen.
   The guest's suggested number is kept only when it is still free. */
function todayKey() {
  const d = new Date();
  return String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
let orderSeq = { day: todayKey(), n: 0 };

function syncSeqFromOrders() {
  const day = todayKey();
  let max = 0;
  for (const o of orders.values()) {
    const m = /^KP-(\d{6})-(\d+)$/.exec(o.id || '');
    if (m && m[1] === day) max = Math.max(max, parseInt(m[2], 10));
  }
  orderSeq = { day, n: max };
}

function nextServerOrderNo() {
  const day = todayKey();
  if (orderSeq.day !== day) orderSeq = { day, n: 0 };
  let id;
  do {
    orderSeq.n += 1;
    id = 'KP-' + day + '-' + String(orderSeq.n).padStart(3, '0');
  } while (orders.has(id));
  return id;
}
syncSeqFromOrders();

/* -------------------------------------------------------------------------- */
/* Store controls — manual open/closed + per-order-type availability           */
/* -------------------------------------------------------------------------- */
/* The owner can stop taking orders entirely, or switch off ONE channel
   (e.g. delivery driver called in sick → turn Delivery off, keep Pickup on).
   The guest page consults this before letting anyone start an order, and the
   checkout route re-checks it server-side, so a tampered browser cannot push
   through an order for a channel that is switched off.

   IMPORTANT: this used to live in memory only, so every redeploy silently
   reset the switches to "everything on" — the owner would turn Delivery off
   and it would quietly come back the next time we published. It is now
   persisted to store.local.json (gitignored) and reloaded at startup. */

const STORE_FILE = process.env.KPOT_STORE_FILE || path.join(ROOT, 'store.local.json');

/* The channels the owner can switch off, in display order. Kept as an explicit
   list so an unknown key from a client is rejected rather than written. */
const ORDER_TYPES = ['pickup', 'dinein', 'delivery'];

/* The payment statuses a BROWSER is allowed to declare. Every one of them means
   "not paid". Anything outside this list is treated as a forgery, and
   handleCreateOrder replaces it with what the pay method implies. Keeping the
   list here — next to the other fail-closed allowlists — means there is exactly
   one place to look when asking "what can a guest claim about money?". */
const UNPAID_STATUSES = ['counter', 'unverified', 'pending', 'unpaid'];

/* The runtime switches, plus the defaults the very first boot starts from.
   `orderTypes` is SEEDED from the static config rather than hard-coded: the
   guest page hides Delivery when config says the shop does not offer it, and a
   server that still accepted a crafted POST for it would be a promise the
   storefront never made. The store file then overrides the seed — the owner's
   runtime switch is the last word. */
let storeStatus = {
  open: true,
  acceptingOrders: true,
  orderTypes: {
    pickup: true,
    dinein: true,
    delivery: deliveryChannelConfigured()
  },
  /* Kitchen automation: skip the PREPARING tap. OFF by default — the owner
     turns it on from the board. Losing this switch silently to a default of
     ON would mean a re-publish starts cooking orders nobody checked, which is
     money, so the safe default is the one that needs a human to say yes. */
  autoPrepare: false,
  giveaway: { enabled: false },
  updatedAt: new Date().toISOString()
};

function loadStoreStatus() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (typeof j.open === 'boolean') storeStatus.open = j.open;
    if (typeof j.acceptingOrders === 'boolean') storeStatus.acceptingOrders = j.acceptingOrders;
    if (j.orderTypes && typeof j.orderTypes === 'object') {
      for (const k of ORDER_TYPES) {
        if (typeof j.orderTypes[k] === 'boolean') storeStatus.orderTypes[k] = j.orderTypes[k];
      }
    }
    if (typeof j.autoPrepare === 'boolean') storeStatus.autoPrepare = j.autoPrepare;
    if (j.giveaway && typeof j.giveaway === 'object' && typeof j.giveaway.enabled === 'boolean') {
      storeStatus.giveaway = { enabled: j.giveaway.enabled };
    }
    if (j.updatedAt) storeStatus.updatedAt = j.updatedAt;
    console.log('[kpot] store status loaded from ' + path.basename(STORE_FILE) +
      ' (' + ORDER_TYPES.filter((k) => storeStatus.orderTypes[k]).join(', ') + ' on' +
      (storeStatus.autoPrepare ? ', auto-prepare on' : '') + ')');
  } catch (e) { /* no saved status — keep the all-on defaults */ }
}

function saveStoreStatus() {
  storeStatus.updatedAt = new Date().toISOString();
  try {
    writeFileAtomic(STORE_FILE, JSON.stringify(storeStatus, null, 2));
  } catch (e) { console.error('[kpot] could not save store status:', e.message); }
}

/* Is this channel currently orderable? Unknown types are refused rather than
   silently allowed — a typo must fail closed, not open. */
function orderTypeEnabled(t) {
  if (!ORDER_TYPES.includes(t)) return false;
  return storeStatus.orderTypes[t] !== false;
}

/* Human-readable channel names, used in guest-facing refusals. */
const ORDER_TYPE_LABELS = { pickup: 'pickup', dinein: 'dine-in', delivery: 'delivery' };

/* The single rule for "may this order go through right now?".
   Both the guest page and the checkout route read it, so there is one place to
   change and no chance of the two drifting apart.

   Order matters: a fully-closed store is reported as `closed` rather than as a
   disabled channel, because "we are closed" is the truthful thing to tell
   someone during the night.

   An unrecognised type is REFUSED. Coercing junk to "pickup" would mean a
   tampered client sending {"orderType":"teleport"} gets served as a normal
   pickup order — a typo, or an attempt to slip past a switched-off channel,
   must fail closed. */
function storeGate(t, opts) {
  opts = opts || {};
  if (!ORDER_TYPES.includes(t)) {
    return { blocked: true, code: 'unknown_type', label: 'that' };
  }
  if (!storeStatus.open) {
    return { blocked: true, code: 'closed', label: ORDER_TYPE_LABELS[t] };
  }
  if (!storeStatus.acceptingOrders) {
    return { blocked: true, code: 'not_accepting', label: ORDER_TYPE_LABELS[t] };
  }
  if (storeStatus.orderTypes[t] === false) {
    return { blocked: true, code: 'type_off', label: ORDER_TYPE_LABELS[t] };
  }
  /* Business hours: only blocks IMMEDIATE orders. A scheduled delivery for
     tomorrow is legitimate even while the shop is closed tonight. */
  let _spec = null;
  try { _spec = (opts && opts.hoursSpec) || (typeof hoursSpec === 'function' ? hoursSpec() : null); } catch (e) { _spec = null; }
  if (!opts.scheduled && hoursClosedNow(_spec)) {
    return { blocked: true, code: 'closed', label: ORDER_TYPE_LABELS[t] };
  }
  return { blocked: false };
}

/* Pure, testable: is the store currently closed according to its configured
   hoursSpec? Returns true when the local clock falls outside the open window.
   Handles both normal-day (e.g. 12:00–21:30) and past-midnight windows.
   Exported via grab() in test_store_gate.js. */
function hoursClosedNow(spec) {
  if (!spec) return false;
  const now = new Date();
  const day = now.getDay();                     // 0 = Sunday
  const mins = now.getHours() * 60 + now.getMinutes();
  const closeFor = (d) => (d === 5 || d === 6) ? spec.closeFriSat : spec.closeSunThu;
  const open = parseInt(spec.openMinute, 10);
  if (!isFinite(open)) return false;
  const close = parseInt(closeFor(day), 10);
  if (!isFinite(close)) return false;
  /* Normal same-day window. */
  if (close >= open) {
    return !(mins >= open && mins < close);
  }
  /* Past-midnight window. */
  if (mins >= open) return false;
  const y = (day + 6) % 7;                      // yesterday
  const closeY = parseInt(closeFor(y), 10);
  if (!isFinite(closeY)) return false;
  return mins >= closeY;
}

/* Is this order type switched OFF by the owner? Only the per-channel switch —
   deliberately NOT the open/closed or accepting-orders flags, because those are
   about NOW, and a scheduled delivery is about tomorrow. A guest booking
   tomorrow's lunch at 11 PM has every right to do so while the kitchen is
   locked up. */
function storeTypeOff(t) {
  if (!ORDER_TYPES.includes(t)) return true;
  if (storeStatus.orderTypes[t] === false) return true;
  return false;
}

/* What the guest page is allowed to know. Deliberately a narrow projection of
   storeStatus — the file also carries updatedAt and could later carry notes
   that are for staff eyes only. */
function publicStoreView() {
  return {
    open: storeStatus.open,
    acceptingOrders: storeStatus.acceptingOrders,
    /* Time-based openness, derived from hoursSpec() on the server clock. The
       guest page uses this to show the closed banner even when the owner has
       not flipped the manual switch — the complaint was that the badge said
       closed but ordering still went through. */
    openNow: !hoursClosedNow(hoursSpec()),
    orderTypes: {
      pickup: storeStatus.orderTypes.pickup !== false,
      dinein: storeStatus.orderTypes.dinein !== false,
      delivery: storeStatus.orderTypes.delivery !== false
    },
    updatedAt: storeStatus.updatedAt
  };
}

loadStoreStatus();

/* ---- Kitchen automation (auto-prepare) ------------------------------------
   The owner can stop tapping PREPARING on the board: with the switch on, an
   order goes to the kitchen by itself and the ticket prints exactly as if a
   human had tapped — it is the same enqueue, the same idempotent queue, and
   there is still a Reprint button if the paper jams.

   Which orders may go through WITHOUT a human checking them first:

     * dine-in  — yes, on arrival. The guest is at the table, in the building,
       with staff walking past. A no-show would have to leave the restaurant.
       Payment state is irrelevant to this one, which also keeps it safe.
     * pickup / delivery — only once the money is confirmed (`isPaidStatus`:
       'verified' from Stripe's own answer, or 'paid' from staff tapping
       💵 Collected). A card order is written to the board BEFORE the guest
       pays, so auto-cooking on arrival would cook food for money that may
       never arrive — the same risk the pay-at-counter ceiling guards
       against. The confirm can come from the guest's phone returning from
       Stripe, from staff tapping Re-check, or from staff recording cash; all
       three end in a payment status the board trusts.

       (The kitchen hold in handleUpdateOrder is the same rule for the human
       path. Both use isPaidStatus so the two can never drift apart.)

   Two deliberate refusals:
     * the switch itself defaults to OFF and can only be turned on by an admin
       PATCH, so a re-publish can never silently start cooking orders;
     * an order type we do not recognise never auto-advances. A typo must fail
       closed here like everywhere else. */
function shouldAutoPrepare(order, opts) {
  if (!order || !storeStatus.autoPrepare) return false;
  if (!ORDER_TYPES.includes(order.orderType)) return false;
  /* A scheduled delivery order is for TOMORROW. Cooking it now would put a
     cold Korean BBQ on a van, and printing it now would put tomorrow's ticket
     on today's rail where the cook thinks it is due in twenty minutes. So it
     waits — and because printing is triggered by the transition into
     'preparing', the ticket waits with it without the print queue knowing
     anything about schedules. */
  if (scheduledForMsOf(order) > Date.now()) return false;
  if (order.orderType === 'dinein') return true;
  /* A pickup/delivery order needs confirmed money — but only when the caller
     is allowed to claim it. The checkout payload is PUBLIC: anyone can POST
     {"paymentStatus":"verified"} with curl. That number is stored and shown on
     the board (which is what Re-check exists to correct), yet it must not be
     the thing that starts a grill. At creation the caller is therefore NOT
     trusted; settleBoardFromStripe (Stripe's own answer) and the admin PATCH
     are. */
  if (!opts || opts.trustPayment !== true) return false;
  return L.isPaidStatus(order.paymentStatus);
}

/* Move an order to the kitchen if the rules above allow it. Only ever acts on
   an order still sitting in `received`: a staff member who already tapped
   PREPARING (or cancelled the order) wins, and an order the kitchen is already
   working on can never be re-queued. `opts.trustPayment` says whether the
   caller is entitled to claim the money is in — false for a public checkout
   payload, true for Stripe's answer or an admin PATCH. Returns true when it
   advanced the order, so callers can log honestly. */
function maybeAutoPrepare(order, why, opts) {
  if (!order || order.status !== 'received') return false;
  if (!shouldAutoPrepare(order, opts)) return false;
  order.status = 'preparing';
  order.updatedAt = new Date().toISOString();
  enqueueKitchenTicket(order);
  console.log('[kpot] order ' + order.id + ' auto-prepared (' + why + ', ' +
    order.paymentStatus + ')');
  return true;
}

function adminAuthorized(req) {
  if (!ADMIN_KEY) return true; // dev/open mode — see startup warning
  return String(req.headers['x-admin-key'] || '') === ADMIN_KEY;
}

/* Human wording for every way a delivery day/window can be refused. The guest
   has to be able to act on each one: "that day is full" means pick another day,
   "we are closed that day" means it will never be available, and "today is not
   bookable" means tomorrow is the earliest. One shared "not available" would
   turn three different conversations into the same shrug. */
const SCHEDULE_ERRORS = {
  schedule_disabled: 'Delivery is not scheduled at the moment.',
  schedule_required: 'Choose a delivery day and time window.',
  schedule_not_delivery: 'A delivery day and window only apply to delivery orders.',
  delivery_unavailable: 'Delivery is not taking orders right now. Please choose Pickup or Dine-In.',
  bad_date: 'That delivery date could not be read.',
  date_too_soon: 'Delivery is booked for the next day onwards — please pick tomorrow or later.',
  date_too_far: 'That date is further ahead than we are taking bookings.',
  date_not_open: 'We are closed that day.',
  bad_slot: 'That delivery window could not be read.',
  slot_full: 'That window is fully booked. Please choose another window or day.',
  slot_outside_hours: 'That window falls outside our opening hours.'
};

/* When the kitchen should start on a scheduled order. Returns a timestamp, or
   0 for an order with no schedule (everything except a windowed delivery).

   The value is stored on the order as `scheduledFor` when it is created and
   never recomputed from the slot afterwards: if staff move an order to a
   different window on the board, that is a different timestamp and it has to
   be written then. Reading a stale field would silently cook at the old time. */
function scheduledForMsOf(order) {
  if (!order || !order.scheduledFor) return 0;
  const t = Date.parse(order.scheduledFor);
  return isFinite(t) ? t : 0;
}

/* Best-effort e-mail to the owner when a new order arrives. Never blocks the
   request, never throws. Disabled when dispatch.notifyTo is blank or when the
   mailer is not configured. */
function sendOrderNotification(order) {
  if (!MAIL || !MAIL.configured) return;
  const to = ASSETS.CONFIG.dispatch && ASSETS.CONFIG.dispatch.notifyTo;
  if (!to) return;
  const lines = [];
  lines.push('New order ' + (order.id || '') + ' — ' + (order.payMethod || '') + ' $' + Number(order.total || 0).toFixed(2));
  lines.push('');
  lines.push('Type: ' + (order.orderType || ''));
  lines.push('Customer: ' + ((order.customer && order.customer.name) || '') + ' ' + ((order.customer && order.customer.phone) || ''));
  if (order.customer && order.customer.email) lines.push('Email: ' + order.customer.email);
  lines.push('');
  lines.push('Items:');
  (order.lines || order.items || []).forEach((it) => {
    lines.push('  ' + (it.qty || 1) + ' x ' + (it.name || it.n || '') + '  $' + Number(it.unit || it.price || 0).toFixed(2));
  });
  lines.push('');
  lines.push('Subtotal $' + Number(order.subtotal || 0).toFixed(2) +
    '  Tax $' + Number(order.tax || 0).toFixed(2) +
    '  Tip $' + Number(order.tip || 0).toFixed(2) +
    '  Total $' + Number(order.total || 0).toFixed(2));
  lines.push('');
  lines.push('Status: ' + (order.status || 'received'));
  MAIL.send({ to: to, subject: 'New KPOT order ' + (order.id || ''), text: lines.join('\r\n') })
    .then((r) => { if (!r || !r.ok) console.error('[kpot] order email failed:', (r && r.error) || 'unknown'); })
    .catch((e) => { console.error('[kpot] order email error:', e && e.message); });
}

/* Best-effort e-mail to the CUSTOMER when their order is ready. Never blocks the
   request, never throws. Only fires if the guest supplied an e-mail. */
function sendCustomerReadyEmail(order) {
  if (!MAIL || !MAIL.configured) return;
  const to = order.customer && order.customer.email;
  if (!to) return;
  const store = (ASSETS.CONFIG.store && ASSETS.CONFIG.store.name) || 'KPOT To Go';
  const lines = [];
  lines.push('Good news — your order is ready!');
  lines.push('');
  lines.push(store + ' · Order ' + (order.id || ''));
  if (order.customer && order.customer.name) lines.push('For: ' + order.customer.name);
  if (order.orderType === 'dinein') lines.push('Table: ' + (order.table || '?'));
  else if (order.orderType === 'pickup') lines.push('Pickup at the counter.');
  else if (order.orderType === 'delivery') lines.push('Your driver is on the way.');
  lines.push('');
  lines.push('Thank you for ordering with us!');
  MAIL.send({ to: to, subject: store + ' — your order ' + (order.id || '') + ' is ready', text: lines.join('\r\n') })
    .then((r) => { if (!r || !r.ok) console.error('[kpot] customer ready email failed:', (r && r.error) || 'unknown'); })
    .catch((e) => { console.error('[kpot] customer ready email error:', e && e.message); });
}

/* The Web Push payload for a fresh order. Must match what sw.js's `push` handler
   expects: { title, body, tag, url }. `tag` groups notifications so a burst of
   orders doesn't stack endlessly on the lock screen. */
function buildPushPayload(order) {
  const who = ((order.customer && order.customer.name) || 'Guest');
  const title = '🛎️ New KPOT order — #' + (order.id || '');
  const body = who + ' · $' + Number(order.total || 0).toFixed(2) +
    ((order.orderType === 'dinein') ? ' · Table ' + (order.table || '?') : ' · ' + (order.orderType || ''));
  return { title, body, tag: 'kpot-new-' + (order.id || Date.now()), url: 'admin-orders.html' };
}

/* A harmless push used by the admin "test push" button — proves the link is live
   without creating an order, printing a ticket, or touching rewards. */
function buildTestPushPayload() {
  return {
    title: '🔔 KPOT test push',
    body: 'If you see this, new-order alerts are working.',
    tag: 'kpot-test-' + Date.now(),
    url: 'admin-orders.html'
  };
}

/* Admin-gated: register or remove a push subscription for the owner's device.
   The body is { subscription: { endpoint, keys } }. Dedupe + atomic save happen
   inside push.js, so this stays thin. */
async function handlePushSubscription(req, res, remove) {
  let raw, body;
  try { raw = await readBody(req, 16 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
  const sub = body && body.subscription;
  const r = remove
    ? PUSH.unsubscribe(sub && sub.endpoint)
    : PUSH.subscribe(sub);
  return sendJSON(res, r.ok ? 200 : 400, r);
}

function fireDispatch(order) {
  const url = ASSETS.CONFIG.dispatch && ASSETS.CONFIG.dispatch.webhookUrl;
  if (!url) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'order_update', order }),
    signal: ac.signal
  }).then(() => clearTimeout(t)).catch(() => { clearTimeout(t); console.error('[kpot] dispatch webhook failed'); });
}

/* ---- Pay-at-counter ceiling ----------------------------------------------
   A counter order reaches the kitchen BEFORE any money is taken, so a
   no-show is a straight loss. The config caps how large such an order may
   be; anything above the cap must be prepaid.

   Two deliberate design choices:

     * Fail CLOSED on a capped order — refuse it rather than quietly letting
       it through. The guest is told to pay online instead.

     * Do NOT enforce the cap when no online method is configured. A ceiling
       with no alternative would block every large order, which is a worse
       outcome than the no-show risk it is meant to reduce.

   Kept pure so _dev/test_counter_cap.js can lift it out of this file and
   exercise the real rule rather than a re-implementation of it. */
function counterCapVerdict(total, payMethod, cfg, onlineAvailable) {
  if (payMethod !== 'counter') return { blocked: false };
  const counter = (cfg && cfg.payment && cfg.payment.counter) || {};
  const cap = Number(counter.maxTotal);
  if (!isFinite(cap) || cap <= 0) return { blocked: false };  // no ceiling configured
  if (!onlineAvailable) return { blocked: false };            // nothing to fall back to
  if (!isFinite(total) || total <= cap) return { blocked: false };
  return { blocked: true, code: 'counter_over_cap', cap: cap };
}

/* ---- Pay at the counter is DINE-IN ONLY --------------------------------
   Owner's decision (2026-10-22, final): every PICKUP and every DELIVERY order
   must be paid before the kitchen sees it, so pay-at-counter is not offered
   on either channel — at any total.

   Why this one is UNCONDITIONAL, when the ceiling above is not:

     * A delivery leaves the building. There is no counter to walk up to when
       the food arrives and nothing to collect afterwards, so a counter-paid
       delivery is not a risky order — it is an impossible one.

     * A pickup guest is not in the building either. There is no table to walk
       past and nobody to collect from when the food is ready, so an unpaid
       pickup order is food cooked for someone who may never arrive. The rule
       started as a $20 threshold the same day; the owner then dropped the
       threshold — the risk is not worth pricing, and a guest can always
       cancel after the food is made.

   So: no online-fallback carve-out, and deliberately NO config switch. The
   ceiling fails open without an online method because it would otherwise
   block orders the shop could actually have taken; there is no version of a
   counter-paid pickup or delivery that works at all. If the shop has no
   online method configured, pickup and delivery simply cannot be ordered
   until it has one — the honest outcome, and the guest page says so instead
   of dead-ending. A switch to turn THIS off is the switch somebody flips at
   9pm when the card terminal is down, which is exactly the moment the rule
   exists for; the owner's decision lives in code.

   Pure, like counterCapVerdict, so _dev/test_counter_cap.js can lift the real
   rule out of this file instead of re-implementing it. */
function counterChannelVerdict(payMethod, orderType) {
  if (payMethod !== 'counter') return { blocked: false };
  if (orderType === 'dinein') return { blocked: false };   // the only channel that may run a tab
  /* Anything else — pickup, delivery, or a type we do not recognise — is
     refused. Failing closed on the unknown matters because this function is
     the payment arm: an orderType typo must not become a way to pay cash for
     a delivery. (handleCreateOrder coerces an unknown type to pickup before
     this point, so the label below is the honest one either way.) */
  return {
    blocked: true,
    code: 'counter_not_allowed',
    channel: orderType === 'delivery' ? 'delivery' : 'pickup'
  };
}

/* ---- The kitchen arm: no unpaid order starts cooking --------------------
   The payment arm above stops a guest CHOOSING pay-at-counter on pickup or
   delivery. This one holds the food itself, because the board is where an
   unpaid order would otherwise quietly become cooked food — and because the
   payment arm alone would be enough only if every unpaid order had been
   created under it (a legacy order, a staff-typed one, or a PATCH that sets
   the payment back to 'counter' all get past it). Same owner decision: an
   order whose payment is not confirmed may not enter 'preparing' — not by
   the kitchen automation, and not by a staff tap.

   Dine-in is exempt: the guest is at the table, in the building, with staff
   walking past, and the tab is settled at the end by design.

   "Confirmed" is `isPaidStatus` — 'verified' (Stripe's own answer, or the
   server's own $0 arithmetic for an order a store credit covered in full) or
   'paid' (staff tapped 💵 Collected). Everything else — 'counter',
   'pending', 'unverified', 'unpaid', or a status we do not recognise —
   counts as unpaid. Fail closed, the same direction as every other money
   door here.

   Judged on the order the PATCH would CREATE (see handleUpdateOrder), and
   only the move INTO the kitchen is refused: the order stays on the board
   with its number, and the fix is one tap — 💵 Collected for cash, or
   💳 Re-check for a guest who paid online and closed the tab. */
function kitchenHold(order) {
  if (!order) return { blocked: false };
  const t = order.orderType;
  if (t === 'dinein') return { blocked: false };     // the tab is the design
  /* Not dine-in → the money must be in. Fails closed on a type we do not
     recognise for the same reason as the payment arm above: a typo must never
     be the thing that lets unpaid food start cooking. */
  if (L.isPaidStatus(order.paymentStatus)) return { blocked: false };
  return {
    blocked: true,
    code: 'unpaid_before_kitchen',
    channel: t === 'delivery' ? 'delivery' : 'pickup',
    total: Number(order.total) || 0
  };
}

/* ---- Delivery minimum — the smallest order that earns a driver's trip ---
   The 2-mile rule (geo.js) decides WHERE we deliver; this decides HOW BIG an
   order has to be to be delivered at all. A run across town for a $6 bowl
   loses the shop money, so the owner set a floor (2026-10-19, $10) — and the
   landing page's old "NO MINIMUM" promise was retired with it.

   Measured on the GROSS food subtotal — the line the guest's bill prints as
   "Subtotal", before any coupon or reward and before tax, tip and the
   delivery fee. That is the number the guest can see and reconcile, so a
   refusal never reads as a bait-and-switch.

   Applies to every delivery order regardless of payment method (a delivery
   is prepaid anyway — see counterChannelVerdict), and unlike the counter
   ceiling it needs no online fallback: the floor is legitimate with or
   without card payments, because it is about the run, not the risk.

   Pure, like its neighbours, so _dev/test_delivery_min.js can lift the real
   rule out of this file instead of re-implementing it. */
function deliveryMinVerdict(subtotal, orderType, cfg) {
  if (orderType !== 'delivery') return { blocked: false };
  const d = (cfg && cfg.delivery) || {};
  const min = Number(d.minSubtotal);
  if (!isFinite(min) || min <= 0) return { blocked: false };  // no floor configured
  if (!isFinite(subtotal) || subtotal >= min) return { blocked: false };
  const short = Math.round((min - subtotal) * 100) / 100;
  return { blocked: true, code: 'delivery_below_minimum', min: min, subtotal: subtotal, short: short };
}

/* Is there a real online payment path on this server? Mirrors the guest
   page's own check (stripe enabled + a way to actually charge). */
function onlinePaymentAvailable() {
  const p = (ASSETS.CONFIG.payment && ASSETS.CONFIG.payment.stripe) || {};
  if (p.enabled === false) return false;
  return !!SECRET_KEY || !!p.paymentLink;
}

function counterMaxTotal() {
  const counter = (ASSETS.CONFIG.payment && ASSETS.CONFIG.payment.counter) || {};
  const n = Number(counter.maxTotal);
  return isFinite(n) && n > 0 ? n : 0;
}

async function handleCreateOrder(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced for the same reason as handlePrice, and this is the endpoint
     where it matters most: the guest has already chosen everything and is
     about to spend money. Re-pricing a basket must never be the thing that
     stops an order going through. */
  if (throttled('orders:' + ip, 30, 60000)) return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many orders. Please wait a moment.' });

  let raw;
  try { raw = await readBody(req, 64 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  /* The order object from the client carries `tip` (the dollar amount),
     but priceOrder reads `tipAmount`. Without this mapping the server
     recomputes tip as 0, the priced total drops the tip, and any order
     with a tip fails the total-mismatch check below. */
  if (body.tip != null && body.tipAmount == null) body.tipAmount = body.tip;

  /* Recompute the price here, just like checkout — a guest can't sneak a
     cheaper total past the kitchen board. */
  const basePriced = priceOrder(body, ASSETS.MENU, ASSETS.CONFIG, deliveryPricingOpts());
  if (basePriced.error) return sendJSON(res, 400, { error: basePriced.error, message: 'Could not price that order.' });

  /* Same rule as checkout: the code — or the guest's own reward — is resolved
     and priced here, and the guest's idea of what it is worth is ignored. */
  const reward = resolveOrderDiscount(body, basePriced, body.orderType);
  if (reward.error) return sendJSON(res, 409, { error: reward.error, message: reward.message });
  const priced = reward.discount ? applyDiscount(basePriced, reward.discount, ASSETS.CONFIG) : basePriced;

  const claimed = Number(body.total);
  if (!isFinite(claimed) || Math.abs(priced.total - claimed) > 0.02) {
    return sendJSON(res, 400, { error: 'total_mismatch', message: 'Order total did not match our records.' });
  }

  /* Idempotent retry: the same client order (matched by its token) returns the
     order we already created, so a network retry never makes a duplicate. */
  if (body.token) {
    for (const o of orders.values()) {
      if (o.clientToken === body.token) {
        return sendJSON(res, 200, { ok: true, id: o.id, status: o.status, existing: true });
      }
    }
  }

  /* ---- Scheduled delivery ------------------------------------------------
     A Delivery order is for TOMORROW in a named window, so it must arrive with
     a day and a window — and both are re-checked HERE rather than trusted from
     the page. Two guests racing for the last slot in a window is settled by
     whichever request the server processes first; the loser is told the window
     is full instead of being quietly overbooked.

     `schedule` on the payload is ignored for every other order type: a guest
     who picks Pickup and still posts a delivery window has not earned one. */
  const effectiveType = ORDER_TYPES.includes(body.orderType) ? body.orderType : 'pickup';
  const sched = (body.schedule && typeof body.schedule === 'object') ? body.schedule : null;
  let schedule = null;
  /* The point the 2-mile gate measured, kept on the order below so the
     delivery run can sort by distance without geocoding again. */
  let orderGeo = null;

  if (effectiveType !== 'delivery') {
    if (sched && (sched.date || sched.slot)) {
      return sendJSON(res, 400, {
        error: 'schedule_not_delivery',
        message: 'A delivery day and window only apply to delivery orders.'
      });
    }
  } else if (storeTypeOff('delivery')) {
    return sendJSON(res, 409, {
      error: 'delivery_unavailable',
      message: 'Delivery is not taking orders right now. Please choose Pickup or Dine-In.'
    });
  } else if (!sched || !sched.date || !sched.slot) {
    return sendJSON(res, 400, {
      error: 'schedule_required',
      message: 'Choose a delivery day and time window.'
    });
  } else {
    const verdict = SC.resolveSchedule(sched, Array.from(orders.values()),
      scheduleCfg(), hoursSpec(), Date.now());
    if (!verdict.ok) {
      return sendJSON(res, 409, {
        error: verdict.error,
        message: SCHEDULE_ERRORS[verdict.error] || 'That delivery day or window is not available.'
      });
    }
    schedule = verdict;
  }
  /* ---- Open for business -----------------------------------------------
     The shop's hours have been enforced at POST /api/checkout since the first
     import (storeGate), and the guest page refuses every path to THIS
     endpoint while ordersBlocked() — but the API itself did not, so a
     hand-crafted POST landed an order on the board with the kitchen shut and
     paged the owner's phone with the new-order e-mail and push. Proven in
     _dev/probe_closed_orders_http.js, which is red without this block.

     Refused only where no money has moved — the owner's decision
     (2026-10-18): a pay-at-counter order is written to the board BEFORE
     anyone pays, so turning it away costs the guest nothing and the kitchen
     loses nothing. An order the guest is paying for online is NEVER turned
     away: the guest page writes it the moment Stripe hands back a session,
     minutes before the money lands, and a guest who paid at 21:29 must not
     come back at 21:31 to find their order gone. A kitchen can refuse an
     order that is on its board; it cannot conjure one that was never
     written. (Known residue: a hand-crafted order claiming an online method
     still lands, unpaid and marked — the same exposure as an honest guest
     mid-payment. Distinguishing them needs a Stripe round-trip, and the
     board already shows such an order as unpaid.)

     Same reading of "closed" as checkout and the guest page: the owner's
     manual switch AND the configured hours. A delivery with a resolved
     schedule above is about tomorrow and is not blocked by tonight's clock. */
  if (body.payMethod === 'counter') {
    const gate = storeGate(effectiveType, {
      scheduled: !!schedule,
      hoursSpec: hoursSpec()
    });
    if (gate.blocked) {
      console.warn('[kpot] refused counter order —', gate.code,
        '| type:', JSON.stringify(effectiveType));
      const msg = {
        closed: 'We are currently closed. Please try again during opening hours.',
        not_accepting: 'We are not accepting orders right now.',
        type_off: 'We are not taking ' + gate.label + ' orders right now.',
        unknown_type: 'That order type was not recognised. Please pick Pickup, Dine-In, or Delivery.'
      }[gate.code] || 'We could not accept that order type.';
      return sendJSON(res, 409, { error: gate.code, message: msg });
    }
  }
  /* ---- Delivery distance — the 2-mile rule -------------------------------
     Checked against the EFFECTIVE type, so a tampered payload cannot dodge it
     by sending an orderType we coerce to pickup. Runs after the schedule gate
     so an out-of-range order is also a bad-time order only when it really is.
     Fail-open on purpose (geo.js): an unverifiable address is allowed, the
     kitchen sees it on the ticket; a coordinate beyond 2 miles is refused. */
  if (effectiveType === 'delivery') {
    const geo = await G.deliveryCheck((body.customer || {}).when);
    if (geo.status === 'blocked') {
      console.warn('[kpot] refused out-of-range delivery order —',
        geo.miles !== null ? geo.miles.toFixed(2) + ' mi (' + geo.source + ')' : geo.source,
        '| addr:', JSON.stringify(String((body.customer || {}).when || '').slice(0, 80)));
      return sendJSON(res, 409, {
        error: 'delivery_out_of_range',
        miles: geo.miles,
        radius: G.RADIUS_MI,
        message: geo.message || 'That address is outside our ' + G.RADIUS_MI +
          '-mile delivery area. Please choose Pickup or Dine-In.'
      });
    }
    /* Keep the measured point on the order. This geocode is happening anyway
       — it is the same call the guest's live check and the checkout gate make
       — so throwing the coordinates away would mean paying for them twice: the
       delivery run (dispatch.js) sorts by distance, and an order with no point
       on it sorts to the back of its window. `source` records which ruler
       measured it so the driver page can say "ZIP estimate" when it was not
       the street. An unknown check stores nothing: there is no point to keep,
       and dispatch falls back to the ZIP table (or to "no distance"). */
    if (geo.coords && isFinite(Number(geo.coords.lat)) && isFinite(Number(geo.coords.lon))) {
      orderGeo = {
        lat: Number(geo.coords.lat),
        lon: Number(geo.coords.lon),
        miles: geo.miles,
        source: geo.source
      };
    }
  }
  /* ---- Delivery minimum — the smallest order that earns a run ------------
     The radius decides WHERE we deliver; this decides HOW BIG an order has
     to be to be delivered at all. Runs before the payment-method rules so a
     $6 delivery is reported for its size, not for how the guest meant to
     pay for it — the first thing to fix is the cart, not the method.

     Measured on the priced GROSS food subtotal (the printed "Subtotal"
     line), so the number the guest sees on the bill is the number that was
     judged. */
  const minVerdict = deliveryMinVerdict(priced.subtotal, effectiveType, ASSETS.CONFIG);
  if (minVerdict.blocked) {
    console.warn('[kpot] refused delivery order under the minimum — $' +
      priced.subtotal.toFixed(2) + ' < $' + minVerdict.min.toFixed(2));
    return sendJSON(res, 409, {
      error: 'delivery_below_minimum',
      min: minVerdict.min,
      subtotal: minVerdict.subtotal,
      short: minVerdict.short,
      message: 'Delivery orders start at $' + minVerdict.min.toFixed(2) +
        ' of food — add $' + minVerdict.short.toFixed(2) +
        ' more, or choose Pickup or Dine-In.'
    });
  }
  /* Pay at the counter is DINE-IN ONLY — see counterChannelVerdict(). Checked
     against the EFFECTIVE type, so a tampered payload cannot dodge the rule by
     sending an orderType we do not recognise: that is coerced to pickup, and
     pickup is refused too. Deliberately BEFORE the ceiling below — a pickup
     order that also happens to be over $30 should be refused for the reason
     that actually applies to it (the counter is not on the menu at all), not
     reported as "too big". */
  const channelVerdict = counterChannelVerdict(body.payMethod, effectiveType);
  if (channelVerdict.blocked) {
    const label = channelVerdict.channel === 'delivery' ? 'Delivery' : 'Pickup';
    /* Two honest endings, because there are two: with an online method the
       guest can just pay; without one the shop genuinely cannot take this
       order, and saying "choose Pay Online" would point at a button that is
       not there. */
    const online = onlinePaymentAvailable();
    console.warn('[kpot] refused pay-at-counter order for a ' + channelVerdict.channel +
      (online ? '' : ' (no online method configured)'));
    return sendJSON(res, 400, {
      error: 'counter_not_allowed',
      channel: channelVerdict.channel,
      message: label + ' orders must be paid online.' + (online
        ? ' Please choose ' + ((ASSETS.CONFIG.payment.stripe || {}).n || 'Pay Online') +
          ' to place this order.'
        : ' No online payment is set up right now — please call ' +
          ((ASSETS.CONFIG.store || {}).phone || 'the restaurant') + '.')
    });
  }
  /* Pay-at-counter ceiling. Checked HERE, on the server, because a greyed-out
     button in the browser is only a hint — the rule has to hold where the
     order is actually accepted. Placed after the idempotency check so a retry
     of an order we already took still resolves to that order instead of being
     refused (e.g. the owner lowers the cap while a guest is mid-checkout).

     Since the channel rule above, dine-in is the ONLY order type that can
     still reach this line — so the ceiling is now purely a table-tab rule: a
     very large tab is prepaid like everything else. */
  const capVerdict = counterCapVerdict(priced.total, body.payMethod, ASSETS.CONFIG, onlinePaymentAvailable());
  if (capVerdict.blocked) {
    console.warn('[kpot] refused pay-at-counter order over the cap — $' +
      priced.total.toFixed(2) + ' > $' + capVerdict.cap.toFixed(2));
    return sendJSON(res, 400, {
      error: 'counter_over_cap',
      cap: capVerdict.cap,
      total: priced.total,
      message: 'Orders over $' + capVerdict.cap.toFixed(2) + ' must be paid online. ' +
        'Please choose ' + ((ASSETS.CONFIG.payment.stripe || {}).n || 'Pay Online') + ' to place this order.'
    });
  }
  /* ---- "Paid by store credit" is a real pay method, with one condition ---
     It means the credit covered the WHOLE bill, so there is nothing left to
     collect. The condition is checked against the server's own total — the
     number computed here from the menu and the code's balance — so a browser
     claiming 'credit' on a $40 order is simply refused: money is owed and a
     real payment method has to be named. (This is the mirror of the covered
     branch in handleCheckout, which never sends such a guest to Stripe.) */
  if (body.payMethod === 'credit' && round2(priced.total) > 0.005) {
    console.warn('[kpot] refused payMethod=credit on an order that still owes $' +
      priced.total.toFixed(2));
    return sendJSON(res, 409, {
      error: 'order_owes_money',
      total: priced.total,
      message: 'This order still has a balance to pay. Please choose a payment method.'
    });
  }

  /* Keep the guest's suggested number when it is still free; otherwise the
     server issues the next one for today, so two devices can never collide. */
  const suggested = String(body.no || body.orderNo || '').slice(0, 60);
  const id = (suggested && !orders.has(suggested)) ? suggested : nextServerOrderNo();

  /* ---- Store credit: the balance moves HERE, and only here ----------------
     Past the idempotency check (a retried order must not deduct twice) and
     past every refusal above (an order that never happens costs nothing).
     This is the second money gate; the first was /api/checkout, which priced
     the deduction but spent nothing — handing a guest to Stripe is not a
     purchase.

     The spend re-validates against the CURRENT balance, so two orders racing
     for the last dollars of a code cannot both win: the loser gets a 409
     rather than a silently over-discounted order. */
  let creditSpend = null;
  if (reward.kind === 'credit' && reward.entry) {
    const amount = priced.discountAmount || 0;
    const r = CR.spendByCode(credits, body.creditCode, amount, { orderId: id });
    if (!r.ok) {
      console.warn('[kpot] credit refused at order creation —', r.reason,
        '| order', id, '| wanted $' + amount.toFixed(2));
      const msg = {
        insufficient: 'That store-credit code no longer has enough left for this order. Please check the amount and try again.',
        expired: 'That store-credit code has expired.',
        revoked: 'That store-credit code is no longer valid.',
        not_found: 'We do not recognise that store-credit code.'
      }[r.reason] || 'That store-credit code could not be applied.';
      return sendJSON(res, 409, { error: 'credit_' + r.reason, message: msg });
    }
    creditSpend = r;
    saveCreditsStore();
    console.log('[kpot] credit: ' + id + ' used $' + r.applied.toFixed(2) +
      ' of ' + reward.entry.codeRef + ' — $' + r.balanceAfter.toFixed(2) + ' left');
  }

  /* The guest's own contact block, rebuilt rather than copied: the e-mail is
     normalised here so a typo that only fails later fails now, and the raw
     payload never lands in the ledger as-is. */
  const guestEmail = L.normalizeEmail((body.customer || {}).email);
  const customer = {
    name: String((body.customer || {}).name || '').slice(0, 80),
    phone: String((body.customer || {}).phone || '').slice(0, 40),
    email: guestEmail || '',
    when: String((body.customer || {}).when || '').slice(0, 200),
    notes: String((body.customer || {}).notes || '').slice(0, 500)
  };

  /* The browser's proof that it is the one that placed this order, stored as
     a hash. It is the second half of the device-credential handshake: the
     guest may only collect a credential for THIS order from the browser that
     created it, and the browser generated this secret itself (32 bytes from
     crypto.getRandomValues) so there is nothing for us to hand back or
     re-issue. A payload without one simply cannot be claimed — fail closed. */
  const claim = String(body.claim || '');
  const claimHash = /^[0-9a-f]{32,128}$/i.test(claim) ? L.hashSecret(claim.toLowerCase()) : '';

  const now = new Date().toISOString();
  const order = {
    id,
    clientToken: body.token || '',
    at: now,
    updatedAt: now,
    status: 'received',
    /* The guest's word about PAYMENT is worth nothing: this payload arrives from
       a public web page and can say anything. A browser that POSTed
       paymentStatus:'verified' was being believed wholesale, and the next time a
       staff member touched that order for an unrelated reason awardLoyaltyFor()
       saw "verified", minted the points, and nobody was any the wiser.

       So only values that mean NOT PAID are accepted from the browser — the two
       the storefront actually sends, plus the two the server has always used as
       its own fallback. Anything else (a forged 'verified', a forged 'paid') is
       replaced by what the pay method implies. A status can only become paid
       through Stripe's own answer (settleBoardFromStripe) or an admin PATCH —
       the same rule that governs auto-prepare's trustPayment.

       The ONE exception is an order the SERVER priced at $0.00 — nothing is
       owed, so 'verified' is not a claim the guest made, it is arithmetic this
       function just performed. That happens two ways: payMethod 'credit' (the
       covered branch of handleCheckout, which never sends such a guest to
       Stripe), and a pay-at-counter order a store-credit code covered in full
       (the guest never went online at all). Both are refused above/elsewhere
       the moment a total the guest still has to pay appears — 'credit' by
       name, and any total above zero by arithmetic. */
    paymentStatus:
      round2(priced.total) <= 0.005 &&
        (body.payMethod === 'credit' || body.payMethod === 'counter')
        ? 'verified'
        : UNPAID_STATUSES.includes(body.paymentStatus)
          ? body.paymentStatus
          : (body.payMethod === 'counter' ? 'counter' : 'pending'),
    payMethod: body.payMethod || 'unknown',
    orderType: ORDER_TYPES.includes(body.orderType) ? body.orderType : 'pickup',
    /* Only ever present on a windowed delivery order, and only with values
       resolveSchedule() already accepted. Everything else carries no schedule
       fields at all, so the board and the ticket can simply test for their
       presence rather than asking what they mean. */
    deliveryDate: schedule ? schedule.date : '',
    deliverySlot: schedule ? schedule.slot : '',
    deliverySlotLabel: schedule ? schedule.slotLabel : '',
    scheduledFor: schedule ? schedule.scheduledFor : '',
    /* Present on delivery orders that could be measured, absent everywhere
       else. dispatch.js reads it to sequence the day's run; nothing else
       cares, and an order without one is simply sorted last in its window. */
    geo: orderGeo || undefined,
    table: body.table || '',
    customer,
    /* Never leaves the server except as this hash, and never appears in any
       outward view of the order. */
    claimHash,
    claimUsedAt: '',
    /* The guest's raw payload is kept for reference (mods, notes, addons), but
       the PRICES we show the kitchen come from `lines` — the server's own
       recomputation. Never render a line price from `items`: that number came
       from a public web page and can say anything. */
    items: body.items || [],
    lines: priced.lines,
    subtotal: priced.subtotal, tax: priced.tax, tip: priced.tip,
    delivery: priced.delivery, total: priced.total,
    discountAmount: priced.discountAmount || 0,
    discount: priced.discount || null,
    /* The store-credit side of this order. `codeHash` is the lookup key (a
       hash is not a secret — the plaintext never reaches disk), so a
       cancellation can find the ledger entry again without the code. The
       balance shown to the guest is the one recorded HERE, at the moment the
       money moved. */
    credit: creditSpend ? {
      codeHash: reward.entry.codeHash,
      codeRef: reward.entry.codeRef || '',
      applied: creditSpend.applied,
      balanceAfter: creditSpend.balanceAfter,
      expiresAt: reward.entry.expiresAt || '',
      released: false
    } : null,
    source: body.source || 'storefront'
  };

  /* Spend the code — or take the reward out of the guest's own ledger — only
     now that the order really exists. A guest who opens Stripe and walks away
     must not burn one of the owner's codes, nor their own points. */
  if (reward.kind === 'code' && reward.entry) {
    discountCodes = D.spendCode(discountCodes, reward.entry);
    saveDiscountCodes();
  }

  orders.set(id, order);
  saveOrdersSoon();

  /* Loyalty points are the guest's property, so they leave the balance here
     and come back in releaseLoyaltyFor() if this order is ever cancelled for
     non-payment. */
  if (reward.kind === 'loyalty') commitLoyalty(order, reward);

  /* Kitchen automation. A dine-in order starts cooking on arrival; pickup and
     delivery stay on the board until settleBoardFromStripe confirms the money
     (guest's phone coming back, or staff tapping Re-check). The third argument
     matters: this payload is public, so a client's CLAIM of having paid is not
     evidence — at creation only the dine-in rule can fire. */
  maybeAutoPrepare(order, 'arrival', { trustPayment: false });

  console.log('[kpot] order created ' + id + ' (' + (body.payMethod || '') + ') $' + order.total.toFixed(2) +
    (order.status === 'preparing' ? ' [auto-preparing]' : ''));
  fireDispatch(order);
  sendOrderNotification(order);
  /* Real push: lands on the owner's phone even with the board closed/locked.
     Fire-and-forget — never blocks the order response. */
  if (PUSH) PUSH.sendToAll(buildPushPayload(order));
  return sendJSON(res, 200, { ok: true, id, status: order.status });
}

function listOrders(since) {
  let arr = Array.from(orders.values());
  if (since) {
    const t = new Date(since).getTime();
    if (isFinite(t)) arr = arr.filter((o) => new Date(o.at).getTime() >= t);
  }
  arr.sort((a, b) => new Date(b.at) - new Date(a.at));
  return arr.slice(0, 200);
}

async function handleListOrders(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://localhost');
  /* Attach the kitchen-print state so the board can show whether the ticket
     actually came out. Without it staff have no way to tell "the printer is
     out of paper" from "the order is fine" — they would just re-tap and hope. */
  const list = listOrders(url.searchParams.get('since')).map((o) => {
    const p = printStateFor(o.id);
    return p ? Object.assign({}, o, { print: p }) : o;
  });

  /* The loyalty ledger for just the guests shown on this board, keyed by
     normalised phone. Small (at most one row per order listed) and it means a
     staff member can answer "how many points do I have?" without leaving the
     board or opening the owner console. */
  const now = Date.now();
  const members = {};
  for (const o of list) {
    const phone = L.normalizePhone((o.customer || {}).phone);
    if (!phone || members[phone]) continue;
    const c = L.find(customers, phone);
    if (!c) continue;
    members[phone] = {
      phone,
      name: c.name,
      points: c.points,
      settledOrders: c.settledOrders,
      stampsEvery: L.STAMP_EVERY,
      unusedCoupons: (c.coupons || []).filter((x) => L.isUsable(x, now))
        .map((x) => ({ id: x.id, value: x.value, label: x.label, expiresAt: x.expiresAt }))
    };
  }

  return sendJSON(res, 200, { orders: list, store: storeStatus, members });
}

function publicOrderView(o) {
  return {
    id: o.id, status: o.status, statusLabel: STATUS_LABELS[o.status] || o.status,
    updatedAt: o.updatedAt, createdAt: o.at,
    paymentStatus: o.paymentStatus
  };
}

async function handleGetOrder(req, res, id) {
  const o = orders.get(id);
  if (!o) return sendJSON(res, 404, { error: 'not_found' });
  return sendJSON(res, 200, publicOrderView(o));
}

/* --------------------------------------------------------------------------
   GET /api/driver/queue — the day's delivery run, in the order to run it.

   What the driver's phone shows: every delivery that is still out there —
   today's, plus anything still open from an earlier day — sequenced by
   dispatch.js (window first, then distance). Completed and cancelled orders
   are gone from the list the moment they are marked, so the card the driver
   just finished disappears instead of sitting there.

   Authenticated with the DRIVER key or the owner's ADMIN key; nothing about
   the store, the money or the other channels is on the wire. Fails closed:
   with no driver key configured, 401.
   -------------------------------------------------------------------------- */
async function handleDriverQueue(req, res) {
  if (!driverAuthorized(req)) {
    return sendJSON(res, 401, {
      error: 'unauthorized',
      message: 'A driver key is required to see the delivery run.'
    });
  }
  let seq;
  try {
    seq = DISP.sequenceDeliveries(orders.values(), { slots: scheduleCfg().slots });
  } catch (e) {
    console.error('[kpot] driver queue unhandled:', e && e.message);
    return sendJSON(res, 500, { error: 'internal_error' });
  }
  return sendJSON(res, 200, {
    ok: true,
    date: DISP.localDateKey(Date.now()),
    generatedAt: new Date().toISOString(),
    count: seq.length,
    overdue: seq.filter((e) => e.overdue).length,
    seq: seq
  });
}

async function handleUpdateOrder(req, res, id) {
  const isAdmin = adminAuthorized(req);
  /* A driver holds the weakest credential there is here, and it may move an
     order in exactly one direction: a delivery, to completed. The narrowness
     is enforced by REPLACING what the driver sent — everything past this
     branch (payment status, schedule, discounts, notes) reads `body`, and a
     driver's body is `{status:'completed'}` or nothing at all. */
  const isDriver = !isAdmin && driverAuthorized(req);
  if (!isAdmin && !isDriver) return sendJSON(res, 401, { error: 'unauthorized' });
  const o = orders.get(id);
  if (!o) return sendJSON(res, 404, { error: 'not_found' });
  let raw;
  try { raw = await readBody(req, 8 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  if (isDriver) {
    if (body.status !== 'completed' || Object.keys(body).length !== 1) {
      return sendJSON(res, 403, {
        error: 'driver_readonly',
        message: 'A driver can only mark a delivery order as delivered.'
      });
    }
    if (o.orderType !== 'delivery') {
      return sendJSON(res, 403, {
        error: 'driver_not_delivery',
        message: 'Only delivery orders can be marked delivered.'
      });
    }
    if (o.status === 'cancelled') {
      return sendJSON(res, 409, {
        error: 'order_cancelled',
        message: 'That order was cancelled.'
      });
    }
    body = { status: 'completed' };
    console.log('[kpot] driver marked order ' + id + ' delivered');
  }

  const wasStatus = o.status;
  /* The values this PATCH is ASKING for, read before anything is mutated.
     The kitchen hold below has to judge the order the request would CREATE,
     and a refusal must leave the stored order exactly as it was — mutating
     first and refusing afterwards would leave a "refused" order sitting in
     'preparing' with no ticket and no money, which is worse than either
     outcome on its own. */
  const nextStatus = (body.status && VALID_STATUS.includes(body.status)) ? body.status : o.status;
  const nextPayment = (body.paymentStatus && typeof body.paymentStatus === 'string')
    ? body.paymentStatus
    : o.paymentStatus;

  /* ---- No unpaid pickup/delivery order starts cooking -------------------
     The owner's rule (2026-10-22, final): an order whose payment is not
     confirmed may not enter 'preparing' — neither by the kitchen automation
     nor by a staff tap. Dine-in is exempt (the tab is the design).

     The payment arm at order creation keeps a guest from CHOOSING
     pay-at-counter on these channels; this one holds the food itself,
     because the board is where an unpaid order would otherwise quietly
     become cooked food. It also catches the orders the payment arm cannot:
     one placed before this rule existed, one a staff member typed, or a
     PATCH that sets the payment BACK to 'counter' on an order already in
     the kitchen.

     Only the move INTO the kitchen is refused (or a re-save that keeps an
     unpaid order sitting in it). The order stays on the board with its
     number, and the fix is one tap: 💵 Collected for cash, or 💳 Re-check for
     a guest who paid online and closed the tab — either sets the payment
     status, and the automation that fires for a confirmed payment takes it
     from there. Every other PATCH (a discount, a note, a move to
     ready/completed) is untouched: the hold is about cooking, not editing. */
  if (nextStatus === 'preparing') {
    const hold = kitchenHold(
      { orderType: o.orderType, total: o.total, paymentStatus: nextPayment });
    if (hold.blocked) {
      const label = hold.channel === 'delivery' ? 'Delivery' : 'Pickup';
      console.warn('[kpot] held ' + hold.channel + ' order ' + id + ' out of the kitchen — payment ' +
        (nextPayment || '(none)') + ', $' + hold.total.toFixed(2) + ' not confirmed');
      return sendJSON(res, 409, {
        error: 'unpaid_before_kitchen',
        channel: hold.channel,
        total: hold.total,
        message: label + ' orders must be paid before they go to the kitchen. Confirm the ' +
          'payment first (Re-check, or mark it Collected).'
      });
    }
  }

  if (body.status && VALID_STATUS.includes(body.status)) {
    o.status = body.status;
  }
  /* Allow the owner to also confirm/correct payment status (e.g. a cash
     payment that was marked pending). */
  if (body.paymentStatus && typeof body.paymentStatus === 'string') {
    o.paymentStatus = body.paymentStatus;
  }

  /* ---- move a scheduled delivery to a different window ------------------
     A guest phones and says "can we make that 6pm instead of noon?" — this is
     that. The new window is re-validated exactly as at creation, and the
     order's own slot is excluded from the count so re-picking the SAME window
     is not read as "already there". */
  if (body.schedule !== undefined) {
    if (!body.schedule || typeof body.schedule !== 'object') {
      return sendJSON(res, 400, { error: 'bad_schedule', message: 'Send a delivery day and window.' });
    }
    if (o.orderType !== 'delivery') {
      return sendJSON(res, 400, {
        error: 'schedule_not_delivery',
        message: 'Only delivery orders have a delivery window.'
      });
    }
    const others = Array.from(orders.values()).filter((x) => x.id !== o.id);
    const verdict = SC.resolveSchedule(body.schedule, others, scheduleCfg(), hoursSpec(), Date.now());
    if (!verdict.ok) {
      return sendJSON(res, 409, {
        error: verdict.error,
        message: SCHEDULE_ERRORS[verdict.error] || 'That delivery day or window is not available.'
      });
    }
    const wasFor = o.scheduledFor;
    o.deliveryDate = verdict.date;
    o.deliverySlot = verdict.slot;
    o.deliverySlotLabel = verdict.slotLabel;
    o.scheduledFor = verdict.scheduledFor;
    console.log('[kpot] order ' + id + ' rescheduled ' + (wasFor || 'immediate') +
      ' -> ' + verdict.scheduledFor + ' (' + verdict.slotLabel + ')');
  }

  /* Staff discount, applied to an order that already exists.

     One discount per order: a staff discount REPLACES any code discount rather
     than stacking with it, so a guest's 10% code and a staff $5-off can never
     quietly add up to a bigger give-away than either side intended.

     `subtotal` and `delivery` are stored GROSS (the discount is a separate
     `discountAmount`), so re-pricing from them is exact — including taking a
     discount back off again with `discount: null`. */
  if (body.discount !== undefined) {
    if (body.discount === null || body.discount === '') {
      o.discountAmount = 0;
      o.discount = null;
      o.tax = round2(((Number(o.subtotal) || 0) + (Number(o.delivery) || 0)) * ASSETS.CONFIG.taxRate);
      o.total = round2((Number(o.subtotal) || 0) + (Number(o.delivery) || 0) + o.tax + (Number(o.tip) || 0));
    } else {
      /* A staff member is typing this by hand, so a number that cannot be
         right has to be reported rather than clamped. compedMealOf(999) on a
         $16 order would silently become "free food" if we just capped it —
         the guest gets a comped meal and nobody notices the typo. A guest's
         CODE still clamps inside pricing.js: an owner's misconfiguration must
         not cost the guest money, nor the house its price integrity. */
      const stype = String(body.discount.type || '');
      const sval = Number(body.discount.value);
      const gross = Number(o.subtotal) || 0;
      if (stype === 'amount') {
        if (!isFinite(sval) || sval <= 0) {
          return sendJSON(res, 400, { error: 'bad_discount', message: 'Enter an amount greater than 0.' });
        }
        if (sval > gross) {
          return sendJSON(res, 400, {
            error: 'bad_discount',
            message: 'That is more than the order is worth ($' + gross.toFixed(2) + ').'
          });
        }
      }

      const nd = applyDiscount({
        subtotal: gross,
        delivery: Number(o.delivery) || 0,
        tax: Number(o.tax) || 0,
        tip: Number(o.tip) || 0,
        total: Number(o.total) || 0
      }, body.discount, ASSETS.CONFIG);

      if (!(nd.discountAmount > 0)) {
        return sendJSON(res, 400, {
          error: 'bad_discount',
          message: 'That discount does not apply to this order.'
        });
      }
      o.discountAmount = nd.discountAmount;
      o.discount = nd.discount;
      o.tax = nd.tax;
      o.total = nd.total;
    }
  }

  o.updatedAt = new Date().toISOString();
  orders.set(id, o);
  saveOrdersSoon();

  /* A staff member correcting a payment status (say a pickup order the guest
     settled in cash at the counter) counts as "money confirmed" for automation,
     exactly as Stripe's own answer does. Idempotent: a PATCH that ALSO sets
     status:'preparing' cannot print twice, because the queue is keyed by order
     id and maybeAutoPrepare only acts on an order still in `received`.
     trustPayment because this route is admin-gated — the same trust as Stripe. */
  maybeAutoPrepare(o, 'payment set by staff', { trustPayment: true });

  /* Staff confirming the money — the board's "💵 Collected" button, or a
     correction — earns the guest their points on exactly the same terms as
     Stripe's own answer. Idempotent by the order, so re-saving cannot pay
     twice. Cancelling an order that had a reward priced into it gives that
     reward back. */
  awardLoyaltyFor(o, 'payment set by staff');
  if (o.status === 'cancelled') {
    releaseLoyaltyFor(o, 'cancelled by staff');
    releaseCreditFor(o, 'cancelled by staff');
  }

  /* Reaching 'preparing' means the kitchen is about to cook this — that is the
     moment the ticket has to come out. Only on the TRANSITION, so re-saving an
     order that is already being prepared does not spit out another ticket.
     (The queue is separately idempotent by order id, so a duplicate PATCH
     cannot double-print either.) */
  if (o.status === 'preparing' && wasStatus !== 'preparing') {
    enqueueKitchenTicket(o);
  }

  /* Reaching 'ready' is the moment to tell the GUEST their order is up. Only on
     the TRANSITION, so re-saving a ready order does not re-mail them. No-op when
     the guest left the e-mail blank. */
  if (o.status === 'ready' && wasStatus !== 'ready') {
    sendCustomerReadyEmail(o);
  }

  console.log('[kpot] order ' + id + ' -> ' + o.status + ' (' + o.paymentStatus + ')');
  fireDispatch(o);
  return sendJSON(res, 200, {
    ok: true, id, status: o.status, statusLabel: STATUS_LABELS[o.status],
    total: o.total, discountAmount: o.discountAmount || 0, discount: o.discount || null
  });
}

/* -------------------------------------------------------------------------- */
/* Kitchen printing                                                           */
/* -------------------------------------------------------------------------- */
/* Tapping PREPARING on the board is what tells the kitchen to start cooking, so
   that is the moment the ticket has to come out.

   The awkward part is geography: the printer is on the restaurant's LAN and
   this server is not. So the server RENDERS the ticket, queues it durably, and
   a small agent on an always-on PC in the restaurant collects the bytes and
   writes them to the printer over TCP 9100 (see print-agent/).

   Rendering here rather than in the agent is deliberate:
     * the layout has exactly one home;
     * it can be unit-tested byte-for-byte without any hardware;
     * changing it never means touching the machine in the restaurant.

   The queue is lease-based rather than push-based. The agent polls, takes a
   lease, prints, and acks. If the agent dies mid-job the lease expires and the
   job comes back, so a crashed PC cannot swallow a ticket. */

const PRINT_FILE = process.env.KPOT_PRINT_FILE || path.join(ROOT, 'print.local.json');
const printJobs = new Map();

/* Stamped on every agent poll, so the owner console can say "the restaurant PC
   last checked in 3 seconds ago" instead of guessing whether the agent is even
   running. */
let lastAgentPoll = null;

/* How long a job may sit "printing" before we assume the agent died. Generous:
   a normal print + ack is well under a second, and re-printing a ticket the
   kitchen already has is only mildly annoying, whereas a ticket that never
   arrives stops the order. */
const PRINT_LEASE_MS = 120 * 1000;
/* Overridable for tests only: reaching the cap takes ~5 minutes in real life
   (the retry backoff runs 2s, 4s, 8s … 60s), which is far too slow for a suite.
   Left unset in the shop, so the real value is 10. */
const PRINT_MAX_ATTEMPTS = Math.max(1,
  parseInt(process.env.KPOT_PRINT_MAX_ATTEMPTS || '', 10) || 10);

function printConfig() {
  const p = (ASSETS.CONFIG && ASSETS.CONFIG.printer) || {};
  return {
    enabled: p.enabled !== false,
    paper: String(p.paper || '80'),
    /* Real printable width of THIS printer, in characters. Left null, printer.js
       uses its own default (48 for 80mm, 32 for 58mm) — which is the right
       thing for a generic head but the wrong thing for the Toast TP200 in
       this shop, whose 7mm + 9mm fixed margins reduce an 80mm roll to ~42
       usable columns. Without this number every line silently wraps on the
       printer and the two-column totals shred themselves. */
    cols: Number.isInteger(p.cols) && p.cols > 0 ? p.cols : null,
    cut: p.cut !== false
  };
}

function printAuthorized(req) {
  /* The print key is independent of the admin key — the agent never holds the
     console password, and the admin key never unlocks printing. */
  if (PRINT_KEY) return String(req.headers['x-print-key'] || '') === PRINT_KEY;
  if (ADMIN_KEY) return false;       // console locked, no print key => locked
  return true;                       // dev/open mode: nothing configured
}

/* Job ids are derived from the order, not random, which is what makes enqueue
   idempotent: tapping PREPARING twice (or a retried PATCH) cannot produce two
   tickets. A reprint is an explicit, deliberate action instead. */
function printJobId(orderId, kind) { return orderId + ':' + kind; }

function loadPrintJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(PRINT_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const j of arr) {
      if (!j || !j.id) continue;
      /* Keep the file small: drop finished jobs older than a day, but keep
         anything still pending however old — an unprinted ticket matters. */
      const done = j.status === 'printed' || j.status === 'failed';
      if (done && new Date(j.at).getTime() < cutoff) continue;
      printJobs.set(j.id, j);
    }
    if (printJobs.size) console.log('[kpot] loaded ' + printJobs.size + ' print job(s)');
  } catch (e) { /* no snapshot yet */ }
}

let printSaveTimer = null;
function savePrintNow() {
  try {
    /* Atomic for the same reason the order board is: a queue cannot afford a
       half-written snapshot — it is the tickets the kitchen has not printed. */
    writeFileAtomic(PRINT_FILE, JSON.stringify(Array.from(printJobs.values()), null, 2));
  } catch (e) { console.error('[kpot] could not save print jobs:', e.message); }
}
function savePrintSoon() {
  if (printSaveTimer) return;
  printSaveTimer = setTimeout(() => { printSaveTimer = null; savePrintNow(); }, 800);
}

/* Render the ticket NOW and store the bytes on the job.
   Storing bytes rather than a reference to the order is what lets a ticket
   still print correctly after the order has been edited, or after a restart
   that lost the in-memory board. */
function enqueueKitchenTicket(order, opts) {
  const cfg = printConfig();
  const kind = 'kitchen';
  const id = printJobId(order.id, kind);
  const existing = printJobs.get(id);
  if (existing) return existing;

  let bytes = null, error = '';
  try {
    bytes = renderKitchenTicket(order, { paper: cfg.paper, cols: cfg.cols, cut: cfg.cut, storeName: (ASSETS.CONFIG.store || {}).name });
  } catch (e) {
    error = e.message;
    console.error('[kpot] could not render ticket for ' + order.id + ':', e.message);
  }

  const job = {
    id,
    orderId: order.id,
    kind,
    at: new Date().toISOString(),
    attempts: 0,
    status: error ? 'failed' : 'pending',
    notBefore: 0,
    leaseUntil: 0,
    lastError: error,
    bytes: bytes ? bytes.toString('base64') : '',
    /* Kept for the on-screen preview and for re-rendering a reprint. */
    orderSnapshot: opts && opts.snapshot === false ? null : order
  };
  printJobs.set(id, job);
  savePrintSoon();
  console.log('[kpot] print job queued: ' + id + ' (' + (bytes ? bytes.length + ' bytes' : 'RENDER FAILED') + ')');
  return job;
}

/* Hand out whatever is due. Jobs are leased so two agents (or one agent with
   two tabs) cannot print the same ticket twice. */
function leasePrintJobs(limit) {
  const now = Date.now();
  const out = [];
  for (const j of printJobs.values()) {
    if (out.length >= (limit || 5)) break;
    if (j.status === 'printing' && j.leaseUntil > now) continue;   // someone else has it
    if (j.status === 'printing' && j.leaseUntil <= now) {
      /* The agent vanished. Put it back in the queue rather than losing it. */
      console.warn('[kpot] print lease expired for ' + j.id + ' — re-queueing');
      j.status = 'pending';
    }
    if (j.status !== 'pending') continue;
    if (j.notBefore && j.notBefore > now) continue;
    j.status = 'printing';
    j.attempts += 1;
    j.leaseUntil = now + PRINT_LEASE_MS;
    out.push(j);
  }
  if (out.length) savePrintSoon();
  return out;
}

function ackPrintJob(id, ok, error) {
  const j = printJobs.get(id);
  if (!j) return { error: 'not_found' };
  j.leaseUntil = 0;
  if (ok) {
    j.status = 'printed';
    j.printedAt = new Date().toISOString();
    j.lastError = '';
    console.log('[kpot] printed ' + id + ' (attempt ' + j.attempts + ')');
  } else {
    j.lastError = String(error || 'unknown').slice(0, 300);
    if (j.attempts >= PRINT_MAX_ATTEMPTS) {
      j.status = 'failed';
      console.error('[kpot] print FAILED permanently: ' + id + ' — ' + j.lastError);
    } else {
      j.status = 'pending';
      /* Exponential backoff, capped — a printer that is merely switched off
         should be picked up again within a minute of coming back. */
      const backoff = Math.min(60000, 2000 * Math.pow(2, j.attempts - 1));
      j.notBefore = Date.now() + backoff;
      console.warn('[kpot] print failed for ' + id + ' (attempt ' + j.attempts + '): ' + j.lastError +
        ' — retrying in ' + Math.round(backoff / 1000) + 's');
    }
  }
  savePrintSoon();
  return { ok: true, status: j.status };
}

/* Newest kitchen job per order — the attempt that decides what the board shows.
   Reprints carry the same orderId, so "latest" beats "original": a ticket that
   failed and was then reprinted must stop showing PRINT FAILED. Both the
   per-order badge and the printer line read this, so they cannot disagree
   about the same order. */
function latestKitchenJobs() {
  const byOrder = new Map();
  for (const j of printJobs.values()) {
    if (String(j.kind || '').indexOf('kitchen') !== 0) continue;
    const cur = byOrder.get(j.orderId);
    if (!cur || String(j.at) > String(cur.at)) byOrder.set(j.orderId, j);
  }
  return byOrder;
}

function latestKitchenJob(orderId) {
  return latestKitchenJobs().get(orderId) || null;
}

/* Is a failed kitchen ticket still outstanding work — i.e. does a human need to
   produce that paper? Two things take a failure off the list, and both mean
   "nobody needs this ticket any more":
     - it was REPRINTED afterwards (latestKitchenJobs above), or
     - the order was CANCELLED. Printing a dead order into the kitchen makes
       them cook food nobody ordered, and nobody is ever going to reprint it,
       so without this the line stays red for it forever. (Live case:
       KP-261022-004's ticket failed during the 2026-10-22 outage and the order
       was cancelled 45 seconds later — the board kept counting it the next
       morning.)

   A COMPLETED order's failure deliberately stays on the list. The food is out,
   but the ticket really never printed and that is worth the owner knowing; the
   Reprint button is still on the card if they want the paper. */
function failedJobOutstanding(job) {
  const o = orders.get(job.orderId);
  /* Order no longer on the board — do not hide a failure on a technicality. */
  if (!o) return true;
  return o.status !== 'cancelled';
}

/* What the board shows next to an order. */
function printStateFor(orderId) {
  /* Report the LATEST attempt for this order, not just the original job.
     A ticket that failed and was then successfully reprinted must stop showing
     "PRINT FAILED" — otherwise staff reprint it forever, or worse, learn to
     ignore the badge. */
  const latest = latestKitchenJob(orderId);
  if (!latest) return null;
  return {
    status: latest.status,      // pending | printing | printed | failed
    attempts: latest.attempts,
    at: latest.printedAt || latest.at,
    error: latest.lastError || '',
    reprint: !!latest.reprint
  };
}

/* Manual reprint — staff need this when the roll ran out or a ticket was lost.
   Creates a NEW job id each time so it is never deduplicated away. */
function reprintKitchenTicket(orderId) {
  const o = orders.get(orderId);
  if (!o) return { error: 'order_not_found' };
  const cfg = printConfig();
  let bytes;
  try {
    bytes = renderKitchenTicket(o, { paper: cfg.paper, cols: cfg.cols, cut: cfg.cut, storeName: (ASSETS.CONFIG.store || {}).name });
  } catch (e) {
    return { error: 'render_failed', message: e.message };
  }
  const id = printJobId(orderId, 'kitchen:reprint:' + Date.now().toString(36));
  const job = {
    id, orderId, kind: 'kitchen', reprint: true,
    at: new Date().toISOString(), attempts: 0, status: 'pending',
    notBefore: 0, leaseUntil: 0, lastError: '', bytes: bytes.toString('base64')
  };
  printJobs.set(id, job);
  savePrintSoon();
  console.log('[kpot] REPRINT queued: ' + id);
  return { ok: true, id };
}

/* ---- Print endpoints ------------------------------------------------------ */

/* GET /api/print/jobs — the agent asks for work. Leases and returns bytes. */
function handlePrintJobs(req, res, url) {
  if (!printAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  lastAgentPoll = new Date().toISOString();
  if (!printConfig().enabled) return sendJSON(res, 200, { jobs: [], printing: false });

  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get('limit') || '5', 10) || 5));
  const jobs = leasePrintJobs(limit).map((j) => ({
    id: j.id,
    orderId: j.orderId,
    kind: j.kind,
    attempts: j.attempts,
    reprint: !!j.reprint,
    bytes: j.bytes
  }));
  return sendJSON(res, 200, { jobs, printing: true });
}

/* POST /api/print/jobs/:id/ack — did it come out? */
async function handlePrintAck(req, res, id) {
  if (!printAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  let body = {};
  try {
    const raw = await readBody(req, 8 * 1024);
    if (raw) body = JSON.parse(raw);
  } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  const out = ackPrintJob(id, body.ok !== false, body.error);
  if (out.error) return sendJSON(res, 404, { error: out.error });
  return sendJSON(res, 200, out);
}

/* GET /api/print/status — is the printer setup actually alive? The single most
   useful question when a ticket does not appear.
   Accepts EITHER key: the owner console uses the admin key, and the agent uses
   its print key to confirm on startup that it is actually connected. */
function handlePrintStatus(req, res) {
  if (!printAuthorized(req) && !adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  const jobs = Array.from(printJobs.values());
  const cfg = printConfig();
  const pending = jobs.filter((j) => j.status === 'pending').length;
  const printing = jobs.filter((j) => j.status === 'printing').length;
  const printed = jobs.filter((j) => j.status === 'printed').length;
  /* Only failures that still need a human. Counting every failed job forever is
     what kept the shop's board red: two tickets had failed during a network
     outage, one of them was reprinted successfully at 19:01, and the line still
     read "2 ticket(s) failed to print" the next morning — the per-order badge
     had already gone green, so the two views disagreed and the stale one was
     the louder. A failed job whose order has a NEWER kitchen attempt (a
     reprint, printed or still queued) is history, not work: staff have already
     acted on it, and the newer job is what counts against the pending/failed
     numbers. Read through latestKitchenJobs() so the line and the badge use
     exactly the same rule. */
  const latestByOrder = latestKitchenJobs();
  const failed = jobs.filter((j) => j.status === 'failed' &&
    latestByOrder.get(j.orderId) === j && failedJobOutstanding(j));
  const lastPrinted = jobs
    .filter((j) => j.printedAt)
    .sort((a, b) => (a.printedAt < b.printedAt ? 1 : -1))[0];

  /* "No agent has ever collected a job" and "the agent collected it but the
     printer refused" look identical from the board, and they need completely
     different fixes — so report whether the agent has ever checked in. */
  return sendJSON(res, 200, {
    enabled: cfg.enabled,
    paper: cfg.paper,
    cut: cfg.cut,
    hasPrintKey: !!PRINT_KEY,
    usingDedicatedKey: !!PRINT_KEY,
    counts: { pending, printing, printed, failed: failed.length, total: jobs.length },
    lastAgentPoll: lastAgentPoll || null,
    lastPrinted: lastPrinted ? { orderId: lastPrinted.orderId, at: lastPrinted.printedAt } : null,
    failed: failed.slice(-10).map((j) => ({ id: j.id, orderId: j.orderId, attempts: j.attempts, error: j.lastError }))
  });
}

/* Load any jobs left over from before the last restart. Called here, at the end
   of the print section, because printJobs/PRINT_FILE above are `const` — calling
   it up in the generic startup block would hit their temporal dead zone. */
loadPrintJobs();

/* ---- Backup / export ------------------------------------------------------
   The order board lives in the container's memory and is snapshotted to
   orders.local.json. A redeploy or container restart wipes that file, so the
   owner needs a way to pull the data OUT of the container and keep it.

   Two formats, both admin-gated:
     /api/orders/export.json   full fidelity (what to re-import if we ever add it)
     /api/orders/export.csv    opens straight in Excel / Google Sheets

   Read-only. It never mutates the board. */

function handleExportOrders(req, res, format) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url, 'http://localhost');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let arr = Array.from(orders.values());
  if (from) {
    const t = new Date(from).getTime();
    if (isFinite(t)) arr = arr.filter((o) => new Date(o.at).getTime() >= t);
  }
  if (to) {
    const t = new Date(to).getTime();
    if (isFinite(t)) arr = arr.filter((o) => new Date(o.at).getTime() <= t);
  }
  /* Oldest first — that is the order a bookkeeper expects to read. */
  arr.sort((a, b) => new Date(a.at) - new Date(b.at));

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const rows = [CSV_COLUMNS.map(csvCell).join(',')];
    for (const o of arr) rows.push(orderToRow(o).map(csvCell).join(','));
    /* BOM so Excel on Windows reads the UTF-8 correctly. */
    const body = '\ufeff' + rows.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kpot-orders-' + stamp + '.csv"',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    count: arr.length,
    currency: 'USD',
    range: { from: from || null, to: to || null },
    /* storeStatus is not order data, but it is small and useful context. */
    store: storeStatus,
    orders: arr
  };
  return sendJSON(res, 200, payload);
}

async function handleGetStore(req, res) {
  /* Public on purpose: the guest page needs to know which channels are open
     before it renders the order-type cards, and it has no admin key. The
     projection carries nothing sensitive — see publicStoreView(). */
  return sendJSON(res, 200, publicStoreView());
}

async function handleSetStore(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  let raw;
  try { raw = await readBody(req, 4 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  /* Only the three known top-level fields are honoured. Anything else in the
     payload is ignored, so a stray key (or a hostile one) cannot end up in the
     saved file or in what we hand back to the guest page. */
  let changed = [];

  if (typeof body.open === 'boolean') {
    storeStatus.open = body.open;
    changed.push('open=' + body.open);
  }
  if (typeof body.acceptingOrders === 'boolean') {
    storeStatus.acceptingOrders = body.acceptingOrders;
    changed.push('acceptingOrders=' + body.acceptingOrders);
  }
  /* Kitchen automation. Explicitly REQUIRES a boolean — the value decides
     whether food is cooked without a human looking at the order first, so a
     sloppy payload must be refused rather than interpreted. */
  if (body.autoPrepare !== undefined) {
    if (typeof body.autoPrepare !== 'boolean') {
      return sendJSON(res, 400, { error: 'bad_value', message: 'autoPrepare must be true or false' });
    }
    storeStatus.autoPrepare = body.autoPrepare;
    changed.push('autoPrepare=' + body.autoPrepare);
  }

  /* Per-channel switches. Accepts either a single key
       { orderType: 'delivery', enabled: false }
     or a partial map, which is what the toggle row sends:
       { orderTypes: { delivery: false } } */
  let ot = null;
  if (typeof body.orderType === 'string' && typeof body.enabled === 'boolean') {
    ot = { [body.orderType]: body.enabled };
  } else if (body.orderTypes && typeof body.orderTypes === 'object') {
    ot = body.orderTypes;
  }
  if (ot) {
    for (const k of Object.keys(ot)) {
      if (!ORDER_TYPES.includes(k)) {
        return sendJSON(res, 400, { error: 'unknown_order_type', message: 'order type must be one of: ' + ORDER_TYPES.join(', ') });
      }
      if (typeof ot[k] !== 'boolean') {
        return sendJSON(res, 400, { error: 'bad_value', message: k + ' must be true or false' });
      }
      storeStatus.orderTypes[k] = ot[k];
      changed.push(k + '=' + ot[k]);
    }
  }

  if (!changed.length) {
    return sendJSON(res, 400, { error: 'nothing_to_update', message: 'send open, acceptingOrders, or orderTypes' });
  }

  saveStoreStatus();
  console.log('[kpot] store status -> ' + JSON.stringify(storeStatus));
  return sendJSON(res, 200, storeStatus);
}

/* -------------------------------------------------------------------------- */
/* Live menu — the owner edits products from the back-office                   */
/* -------------------------------------------------------------------------- */
/* The menu ships in assets/menu.js. When the owner edits it in admin-menu.html
   we keep the live copy in memory (ASSETS.MENU — the SAME object the pricing
   engine reads, so prices stay consistent with no restart) and snapshot it to
   menu.local.json so it survives a restart. Guests get it via GET /api/menu. */

const MENU_FILE = process.env.KPOT_MENU_FILE || path.join(ROOT, 'menu.local.json');
let menuMeta = { custom: false, updatedAt: null };

function loadMenuStore() {
  try {
    const j = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
    if (j && j.menu && j.categories) {
      ASSETS.MENU = j.menu;
      ASSETS.CATEGORIES = j.categories;
      menuMeta = { custom: true, updatedAt: j.updatedAt || null };
      console.log('[kpot] loaded owner menu from ' + path.basename(MENU_FILE));
    }
  } catch (e) { /* no custom menu — keep menu.js defaults */ }
}

function saveMenuStore() {
  menuMeta = { custom: true, updatedAt: new Date().toISOString() };
  try {
    /* Atomic: the owner's whole menu, corrupted by a partial write, would take
       the shop offline with a page that renders nothing. */
    writeFileAtomic(MENU_FILE, JSON.stringify({ menu: ASSETS.MENU, categories: ASSETS.CATEGORIES, updatedAt: menuMeta.updatedAt }, null, 2));
  } catch (e) { console.error('[kpot] could not save menu:', e.message); }
}

/* Structural validation — refuse anything that would break pricing or render. */
const isNum = (x) => typeof x === 'number' && isFinite(x) && x >= 0;
const isStr = (x) => typeof x === 'string' && x.length > 0 && x.length <= 200;

function validateMenu(menu, cats) {
  if (!menu || typeof menu !== 'object') return 'menu must be an object';
  for (const k of ['hotpot', 'bbq', 'drinks', 'sides']) {
    if (!menu[k] || typeof menu[k] !== 'object') return 'missing section: ' + k;
  }

  const hp = menu.hotpot;
  if (!isNum(hp.basePrice)) return 'Hot Pot base price must be a number ≥ 0';
  if (!Array.isArray(hp.steps) || !hp.steps.length) return 'Hot Pot needs at least one step';
  for (const s of hp.steps) {
    if (!isStr(s.id) || !isStr(s.title)) return 'every Hot Pot step needs an id and a title';
    if (!(Number(s.choose) >= 1)) return 'step "' + s.title + '" needs "choose" ≥ 1';
    if (!Array.isArray(s.items) || !s.items.length) return 'step "' + s.title + '" needs at least one option';
    for (const it of s.items) if (!isStr(it.n)) return 'Hot Pot options need a name';
  }
  if (!Array.isArray(hp.addons)) return 'Hot Pot add-ons must be a list';
  for (const a of hp.addons) {
    if (!isStr(a.n)) return 'add-ons need a name';
    if (!isNum(a.price)) return 'add-on price must be a number ≥ 0';
  }

  const b = menu.bbq;
  if (!Array.isArray(b.sizes) || !b.sizes.length) return 'BBQ needs at least one size';
  for (const s of b.sizes) {
    if (!isStr(s.id) || !isStr(s.n)) return 'every BBQ size needs an id and a name';
    if (!isNum(s.price)) return 'BBQ size price must be a number ≥ 0';
    if (!(Number(s.picks) >= 1)) return 'BBQ size "' + s.n + '" needs "picks" ≥ 1';
  }
  if (!Array.isArray(b.proteins) || !b.proteins.length) return 'BBQ needs at least one protein';
  for (const p of b.proteins) if (!isStr(p.n)) return 'BBQ proteins need a name';
  if (!Array.isArray(b.comesWith)) return 'BBQ "comes with" must be a list';
  for (const c of b.comesWith) if (!isStr(c)) return '"comes with" entries must be text';
  if (!Array.isArray(b.addons)) return 'BBQ add-ons must be a list';
  for (const a of b.addons) { if (!isStr(a.n)) return 'add-ons need a name'; if (!isNum(a.price)) return 'add-on price must be a number ≥ 0'; }

  const d = menu.drinks;
  if (!Array.isArray(d.groups)) return 'Drinks must be a list of groups';
  for (const g of d.groups) {
    if (!isStr(g.id) || !isStr(g.n)) return 'every drink group needs an id and a name';
    if (!isNum(g.price)) return 'drink group "' + g.n + '" price must be a number ≥ 0';
    if (!Array.isArray(g.options) || !g.options.length) return 'drink group "' + g.n + '" needs at least one option';
    for (const o of g.options) if (!isStr(o)) return 'drink options must be names';
  }

  const sd = menu.sides;
  if (!Array.isArray(sd.groups)) return 'A La Carte must be a list of groups';
  for (const g of sd.groups) {
    if (!isStr(g.id) || !isStr(g.n)) return 'every side group needs an id and a name';
    if (!Array.isArray(g.items) || !g.items.length) return 'side group "' + g.n + '" needs at least one item';
    for (const it of g.items) {
      if (!isStr(it.n)) return 'side items need a name';
      if (!isNum(it.price)) return 'side item "' + it.n + '" price must be a number ≥ 0';
    }
  }

  if (!Array.isArray(cats) || !cats.length) return 'categories must be a non-empty list';
  for (const c of cats) if (!isStr(c.id) || !isStr(c.n)) return 'every category needs an id and a name';

  return null;
}

function handleGetMenu(req, res) {
  return sendJSON(res, 200, { menu: ASSETS.MENU, categories: ASSETS.CATEGORIES, custom: menuMeta.custom, updatedAt: menuMeta.updatedAt });
}

async function handlePutMenu(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  let raw;
  try { raw = await readBody(req, 512 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
  const err = validateMenu(body.menu, body.categories);
  if (err) return sendJSON(res, 400, { error: 'invalid_menu', message: err });
  /* Point pricing at the new menu immediately — no restart needed. */
  ASSETS.MENU = body.menu;
  ASSETS.CATEGORIES = body.categories;
  saveMenuStore();
  console.log('[kpot] menu updated by owner (' + Object.keys(ASSETS.MENU).length + ' sections)');
  return sendJSON(res, 200, { ok: true, updatedAt: menuMeta.updatedAt });
}

async function handleResetMenu(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  try { fs.unlinkSync(MENU_FILE); } catch (e) { /* nothing saved yet */ }
  try {
    const fresh = loadAssets(ROOT);
    ASSETS.MENU = fresh.MENU;
    ASSETS.CATEGORIES = fresh.CATEGORIES;
  } catch (e) { return sendJSON(res, 500, { error: 'reload_failed', message: e.message }); }
  menuMeta = { custom: false, updatedAt: null };
  console.log('[kpot] menu reset to menu.js defaults');
  return sendJSON(res, 200, { ok: true, menu: ASSETS.MENU, categories: ASSETS.CATEGORIES });
}

/* -------------------------------------------------------------------------- */
/* Discount codes (owner-managed)                                              */
/* -------------------------------------------------------------------------- */

/* Overridable for the same reason as every other state file: a test must be
   able to run without touching the owner's real codes. */
const DISCOUNTS_FILE = process.env.KPOT_DISCOUNTS_FILE || path.join(ROOT, 'discounts.local.json');

let discountCodes = [];

function loadDiscountCodes() {
  const r = D.loadDiscounts(DISCOUNTS_FILE);
  discountCodes = r.codes;
  if (discountCodes.length) {
    console.log('[kpot] discount codes: ' + discountCodes.length + ' loaded from ' + path.basename(DISCOUNTS_FILE));
  }
}

function saveDiscountCodes() {
  try {
    return D.saveDiscounts(DISCOUNTS_FILE, discountCodes);
  } catch (e) {
    console.error('[kpot] could not save discounts:', e.message);
    return null;
  }
}

/* Resolve a guest-supplied code against the CURRENT subtotal. Returns
   { none: true }, { entry, discount }, or { error, message }.

   Never spends the code here — handing a guest to Stripe is not a purchase.
   The code is spent when the order is actually placed. */
function resolveCoupon(rawCode, priced) {
  if (rawCode == null || String(rawCode).trim() === '') return { none: true };
  const r = D.resolveCode(discountCodes, rawCode, priced.subtotal, Date.now());
  if (!r.ok) return { error: r.error, message: r.message };
  return { entry: r.code, discount: r.discount };
}

/* Stripe has no way to say "take $1.38 off" other than a coupon: it rejects a
   negative line item outright ("Invalid non-negative integer"). So we mint a
   one-shot coupon for the exact amount we already computed.

   Fails CLOSED on purpose. If the coupon cannot be created we must not fall
   back to charging the full price — the guest was shown the discounted total,
   and silently taking more is worse than refusing the order. */
async function createDiscountCoupon(cents, label) {
  const form = new URLSearchParams();
  form.set('amount_off', String(cents));
  form.set('currency', 'usd');
  form.set('duration', 'once');
  form.set('max_redemptions', '1');
  form.set('name', String(label || 'Discount').slice(0, 40));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(STRIPE_COUPON_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString(),
      signal: ac.signal
    });
  } catch (e) {
    return { error: 'coupon_failed', message: e && e.name === 'AbortError' ? 'Stripe coupon timed out.' : 'Could not reach Stripe.' };
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id) {
    const msg = (data && data.error && data.error.message) || ('Stripe returned HTTP ' + resp.status);
    return { error: 'coupon_failed', status: resp.status, message: msg };
  }
  return { id: data.id };
}

function handleGetDiscounts(req, res) {
  return sendJSON(res, 200, { codes: discountCodes, types: D.TYPES });
}

async function handlePutDiscounts(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  let raw;
  try { raw = await readBody(req, 128 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  const err = D.validateList(body.codes);
  if (err) return sendJSON(res, 400, { error: 'invalid_discount', message: err });

  discountCodes = body.codes.map(D.normalizeOne);
  const updatedAt = saveDiscountCodes();
  console.log('[kpot] discounts updated by owner (' + discountCodes.length + ' codes)');
  return sendJSON(res, 200, { ok: true, updatedAt, codes: discountCodes });
}

/* -------------------------------------------------------------------------- */
/* Loyalty — points, stamps and come-back coupons                              */
/* -------------------------------------------------------------------------- */
/* The ledger itself (CUSTOMERS_FILE / `customers` / load / save) is declared
   up beside the order board, because writeBackup() needs it. Everything below
   is the RULE: who earns what, what may come off a bill, and who may look. */

/* What the guest ASKED FOR, resolved against their own ledger and the price
   the server just computed. The browser sends a wish ("use my points"), never
   an amount — exactly the rule a discount code already follows. */
/* Everything a guest may take off a bill in exchange for being a member:
   their points, one of their coupons, or a member perk. THREE mutually
   exclusive requests, and the guest is allowed exactly one — a code, a staff
   discount, points, a coupon and a member perk are five doors to the same
   wallet, and letting two of them ride together is how a house hands out more
   than it meant to.

   `orderType` and `priced.delivery` are needed because a member's free-delivery
   perk only exists on a delivery order that actually has a fee to waive. */
function resolveLoyalty(req, priced, orderType) {
  if (!req || typeof req !== 'object') return { none: true };
  const wantsPoints = !!req.redeemPoints;
  const couponId = req.couponId ? String(req.couponId).trim() : '';
  const memberChoice = req.memberChoice ? String(req.memberChoice).trim() : '';

  const asked = (wantsPoints ? 1 : 0) + (couponId ? 1 : 0) + (memberChoice ? 1 : 0);
  if (asked > 1) {
    return {
      error: 'one_reward_only',
      message: 'Pick one reward for this order: points, a coupon, or your member discount.'
    };
  }
  if (asked === 0) return { none: true };

  const phone = L.normalizePhone(req.phone);
  if (!phone) return { error: 'bad_phone', message: 'We could not read that mobile number.' };

  const cust = L.find(customers, phone);
  if (!cust) {
    return { error: 'unknown_customer', message: 'We have no rewards on that mobile number yet.' };
  }

  /* ⚠️ THERE USED TO BE A GATE HERE, and it is gone on purpose.

     A phone number now IS the credential — the owner's explicit reversal of
     their own earlier instruction ("不需要EMAIL验证了，凭手机号码就可以领奖励了").
     They were shown that the number is printed on every order ticket
     (printer.js:153) and chose convenience over the lock.

     `req.device` is still sent by the guest page and still verified below, but
     only so a phone that has paid before can be recognised SILENTLY. It is
     never a condition of spending anything.

     If you are re-adding a `device_required` branch: that is a product
     decision the owner has already made once, in the other direction. Ask
     them; do not reintroduce it quietly. */
  L.verifyDevice(cust, req.device, Date.now());

  /* ---- the member perk ---- */
  if (memberChoice) {
    const benefits = MB.benefitsFor(cust, memberCfg(), Date.now());
    if (!benefits.member) {
      return {
        error: 'member_unavailable',
        message: 'That membership is not active. Ask at the counter to renew it.'
      };
    }
    const choices = MB.memberDiscountChoices(benefits, orderType, priced.delivery || 0);
    const picked = choices.find((c) => c.id === memberChoice);
    if (!picked) {
      return {
        error: 'member_unavailable',
        message: 'That member discount is not available on this order.'
      };
    }
    return { entry: cust, member: benefits, discount: picked.discount };
  }

  const r = L.resolveRedemption(cust, { redeemPoints: wantsPoints, couponId }, priced.subtotal, Date.now());
  if (r.error) return { error: r.error, message: r.message };
  if (r.none) return { none: true };
  return { entry: cust, redemption: r.redemption, discount: L.toDescriptor(r.redemption) };
}

/* ONE give-away per order. An owner's code, a staff discount, a member perk and
   a loyalty reward all come off the same bill, so letting two of them ride
   together is how a house hands out more than it meant to. The guest page
   offers them as an either/or choice; this is the server refusing to be talked
   out of it.
   Order matters: a bad code is reported before a bad reward, so the guest
   fixes the thing they typed rather than the thing we looked up. */
/* ---- Store credit (the LUCKY 66 prize code) --------------------------------
   The code is a WISH, never an amount: the browser may say "apply my code",
   but what it is worth is decided here, against the ledger, the same way a
   coupon is. `appliedFor` caps it at the food subtotal, so a $66 code on a
   $3 order takes $3 off and leaves $63 on the code.

   Reasons map to guest-facing sentences in app.js:
     not_found  "we don't recognise that code"
     revoked    "that code is no longer valid"
     expired    "that code expired on …"                                             */
function resolveCredit(rawCode, priced) {
  const code = CR.normalizeCode(rawCode);
  if (!code) return { none: true };
  const v = CR.verdict(credits, code, Date.now());
  if (!v.ok) {
    const messages = {
      not_found: 'We do not recognise that store-credit code.',
      revoked: 'That store-credit code is no longer valid.',
      expired: 'That store-credit code has expired.'
    };
    return { error: 'credit_' + v.reason, message: messages[v.reason] || 'That store-credit code cannot be used.' };
  }
  const applied = CR.appliedFor(v.entry, priced.subtotal);
  if (applied <= 0) return { none: true };   // nothing left on it — not an error
  return {
    entry: v.entry,
    discount: {
      type: 'amount',
      value: applied,
      code: '',
      label: 'Store credit',
      source: 'credit',
      amount: applied
    }
  };
}

/* -------------------------------------------------------------------------- */
/* First-time guest — an automatic welcome discount, no code to type          */
/* -------------------------------------------------------------------------- */
/* "First-time customer" means "this mobile number has never placed an order
   before". The number IS the customer here (it is the loyalty credential), so
   it is the only identity we have, and it is exactly what the page already
   collects for rewards — the guest types nothing new.

   Decided ONLY on the server. The browser sends the number it already holds
   and gets back the server's read of the order history; it can never assert
   "I am a first-timer" and get a discount. The check scans every order on the
   board, so an order placed a moment ago (by the same phone) already counts as
   "known" — the discount is spent on the first purchase, never the second. */
function isFirstTimeCustomer(phone, exceptToken) {
  const p = L.normalizePhone(phone);
  if (!p) return false;
  for (const o of orders.values()) {
    /* The order being priced right now is not "a previous order".

       The guest page posts the same order twice with the same token: once
       before it leaves for Stripe (so the board has it and the number is
       real), and again on the way back to re-resolve the order number before
       verifying the session. Without this exclusion the second post sees the
       order the first one created, concludes the guest is a returning
       customer, and prices the very SAME order at full price — which then
       fails its own total_mismatch check and never reaches the
       idempotent-retry branch that exists precisely to answer that request.

       So the welcome discount is a property of the ORDER, not of the moment
       the server happened to be asked. A genuinely second order carries a
       different token, still sees this one, and still gets nothing. */
    if (exceptToken && o.clientToken && o.clientToken === exceptToken) continue;
    const op = L.normalizePhone((o.customer || {}).phone);
    if (op && op === p) return false;
  }
  return true;
}

/* The welcome discount, resolved here and priced by applyDiscount() exactly
   like an owner's code. Returns { none: true } — never an error — when there
   is nothing to give: no config, no number on the order, a returning customer,
   or a subtotal under the floor. A first-timer who does not qualify is not
   refused, they simply pay full price. */
function resolveFirstTime(body, basePriced) {
  const cfg = (ASSETS.CONFIG && ASSETS.CONFIG.firstVisit) || {};
  if (cfg.enabled === false) return { none: true };
  const pct = Number(cfg.percent);
  if (!isFinite(pct) || pct <= 0) return { none: true };

  const phone = L.normalizePhone((body.customer || {}).phone);
  if (!phone) return { none: true }; // cannot identify -> no auto discount
  /* `body.token` is the order's own idempotency token: the one order that must
     not count as "a previous order" is the one being priced right now. */
  if (!isFirstTimeCustomer(phone, body.token)) return { none: true };

  const min = Number(cfg.minSubtotal) || 0;
  if (min > 0 && Number(basePriced.subtotal) < min) return { none: true };

  const discount = {
    type: 'percent',
    value: pct,
    code: '',
    label: String(cfg.label || '').slice(0, 60) || ('First-time guest — ' + pct + '% off'),
    source: 'welcome'
  };
  if (discountAmountFor(basePriced, discount) <= 0) return { none: true };
  return { discount };
}

function resolveOrderDiscount(body, basePriced, orderType) {
  const coupon = resolveCoupon(body.couponCode, basePriced);
  if (coupon.error) return { error: coupon.error, message: coupon.message };

  const loyalty = resolveLoyalty(body.loyalty, basePriced, orderType);
  if (loyalty.error) return { error: loyalty.error, message: loyalty.message };

  const credit = resolveCredit(body.creditCode, basePriced);
  if (credit.error) return { error: credit.error, message: credit.message };

  const first = resolveFirstTime(body, basePriced);
  if (first.error) return { error: first.error, message: first.message };

  /* One give-away per bill. A store credit, an owner's code and a loyalty
     reward are all money off, and letting two ride together is how a house
     hands out more than it meant to — the owner's standing rule for rewards,
     applied to the prize code as well. The welcome offer is NOT in this list:
     it is automatic and unrequested, so it must step aside when the guest has
     explicitly chosen something, never fight them for the same bill. */
  const chosen = [coupon.discount, loyalty.discount, credit.discount].filter(Boolean);
  if (chosen.length > 1) {
    return {
      error: 'one_discount_only',
      message: 'Use one reward per order — a discount code, your rewards, or store credit. Pick a single one.'
    };
  }

  /* An explicit choice wins; the automatic welcome offer only fills the gap
     when the guest asked for nothing else. So a first-timer who types a code
     they saw on a poster simply gets that code — no "pick one" error, no
     surprise. */
  if (chosen.length > 0) {
    if (credit.discount) {
      return { kind: 'credit', entry: credit.entry, discount: credit.discount };
    }
    if (coupon.discount) return { kind: 'code', entry: coupon.entry, discount: coupon.discount };
    return {
      kind: 'loyalty', customer: loyalty.entry,
      /* `redemption` is absent for a member perk: nothing is taken out of the
         ledger, so there is nothing to commit or release. The perk is a
         property of the membership, not a coin in the wallet. */
      redemption: loyalty.redemption || null,
      member: loyalty.member || null,
      discount: loyalty.discount
    };
  }

  if (first.discount) return { kind: 'welcome', discount: first.discount };
  return { none: true };
}

/* Take the reward out of the ledger, once the order really exists. Mirrors
   spendCode(): handing a guest to Stripe is not a purchase. */
function commitLoyalty(order, reward) {
  if (!order || !reward || reward.kind !== 'loyalty' || !reward.customer) return false;
  const at = new Date().toISOString();
  const ok = L.commitRedemption(reward.customer, reward.redemption, order.id, at);
  if (!ok) return false;
  L.touch(reward.customer, (order.customer || {}).name, at);
  order.loyalty = Object.assign({}, order.loyalty, {
    redeemed: {
      kind: reward.redemption.kind,
      points: reward.redemption.points || 0,
      couponId: reward.redemption.couponId || '',
      value: reward.redemption.value,
      label: reward.discount.label || ''
    }
  });
  saveCustomersStore();
  return true;
}

/* Keep the address the guest typed at checkout, if the account has none.

   Since 2026-10-16 an e-mail is contact data and nothing else — the phone
   number is the credential, so there is no recovery flow to defend and no
   overwrite to prevent. It stays fill-only so a guest's record does not churn
   with every order they place, but the reason is tidiness now, not security. */
function captureEmailFor(order, cust, at) {
  if (!order || !cust || cust.email) return false;
  const typed = L.normalizeEmail((order.customer || {}).email);
  if (!typed) return false;
  cust.email = typed;
  L.pushLog(cust, 'email_set', 0, 'from order ' + order.id, at);
  return true;
}

/* Money is confirmed — pay out the points, the stamps and the come-back
   coupon. Called from exactly the two places that can confirm money: Stripe's
   own answer, and an admin PATCH that sets a paid status. Idempotent by the
   ORDER, so a Re-check, a second Stripe callback or a repeated PATCH can never
   pay the same order's points twice. */
function awardLoyaltyFor(order, why) {
  if (!order || !L.isPaidStatus(order.paymentStatus)) return null;
  const phone = L.normalizePhone((order.customer || {}).phone);
  if (!phone) return null;

  const at = new Date().toISOString();
  const cust = L.ensure(customers, phone, at);
  if (!cust) return null;

  /* Before the award, so a guest whose order is being settled right now can
     immediately recover on another phone if they need to. */
  const emailSet = captureEmailFor(order, cust, at);

  /* The points multiplier comes from the LEDGER, never from the order payload.
     A guest who POSTs {loyalty:{pointsMultiplier:50}} must not be listened to —
     the same rule that says a browser cannot claim it has paid. Membership is
     a fact about the customer record, read at award time. */
  const benefits = MB.benefitsFor(cust, memberCfg(), Date.parse(at));

  const r = L.awardForOrder(cust, order, at, {
    pointsMultiplier: benefits.pointsMultiplier
  });
  /* Nothing to award (already awarded, or a zero-dollar order) — but the
     address we just attached still has to reach the disk. */
  if (!r.changed) {
    if (emailSet) saveCustomersStore();
    return null;
  }

  L.touch(cust, (order.customer || {}).name, at);
  order.loyalty = Object.assign({}, order.loyalty, {
    awarded: true,
    awardedAt: at,
    earnedPoints: r.points,
    earnedCoupons: (r.coupons || []).map((c) => c.id)
  });
  orders.set(order.id, order);
  saveOrdersSoon();
  saveCustomersStore();
  console.log('[kpot] loyalty: ' + order.id + ' earned ' + r.points + ' point(s)' +
    ((r.coupons || []).length ? ' + ' + r.coupons.length + ' reward(s)' : '') + ' (' + why + ')');
  return r;
}

/* The order never collected its money — an abandoned Stripe session is
   cancelled by settleBoardFromStripe — so whatever it was priced with has to
   go back. releaseRedemption() is itself guarded by order.loyalty.released, so
   a second cancellation cannot refund the same points twice. */
function releaseLoyaltyFor(order, why) {
  if (!order || !order.loyalty || !order.loyalty.redeemed || order.loyalty.released) return null;
  const phone = L.normalizePhone((order.customer || {}).phone);
  const cust = phone ? L.find(customers, phone) : null;
  if (!cust) return null;

  const at = new Date().toISOString();
  if (!L.releaseRedemption(cust, order, at)) return null;

  order.loyalty = Object.assign({}, order.loyalty, { released: true, releasedAt: at });
  orders.set(order.id, order);
  saveOrdersSoon();
  saveCustomersStore();
  console.log('[kpot] loyalty: released the reward on cancelled ' + order.id + ' (' + why + ')');
  return true;
}

/* The same idea for a store-credit code: a cancelled order puts the money
   back. Guarded by order.credit.released, so a second cancellation cannot
   refund the same dollars twice, and credits.js caps the restore at the
   code's original value as a second line of defence. The entry is found by
   the hash stored on the order — the plaintext is never on disk to find. */
function releaseCreditFor(order, why) {
  if (!order || !order.credit || !order.credit.applied || order.credit.released) return null;
  const at = new Date().toISOString();
  const r = CR.restore(credits, order.credit.codeHash, order.credit.applied, { orderId: order.id, now: at });
  if (!r.ok) {
    console.warn('[kpot] credit: could not restore ' + order.credit.codeRef +
      ' on cancelled ' + order.id + ' — ' + r.reason);
    return null;
  }
  order.credit = Object.assign({}, order.credit, {
    released: true, releasedAt: at, balanceAfter: r.balanceAfter
  });
  orders.set(order.id, order);
  saveOrdersSoon();
  saveCreditsStore();
  console.log('[kpot] credit: restored $' + r.applied.toFixed(2) + ' to ' +
    order.credit.codeRef + ' on cancelled ' + order.id + ' (' + why + ') — $' +
    r.balanceAfter.toFixed(2) + ' left');
  return true;
}

/* GET /api/customer?phone=…&subtotal=…&device=…

   Public, because a guest has no admin key. The phone number is the LOOKUP KEY
   and, since 2026-10-16, the CREDENTIAL: typing it is enough to see and spend
   what is on the account. See the decision record in customers.js
   (publicView) — the owner reversed their own earlier instruction after being
   shown that the number is printed on every ticket.

   `device` is still accepted and still verified, but purely so a phone that
   has already paid can be recognised without the guest retyping the number.
   It is not a condition of anything.

   Throttled, so the endpoint cannot be used to walk the phone-number space. */
function handleGetCustomer(req, res, url) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced. This endpoint is now called by the guest page to prove the
     phone number, which is a second lookup alongside the re-pricing that
     follows it — sharing one bare-IP counter with /api/price would have made
     the second call the thing that ran out. */
  if (throttled('customer:' + ip, 60, 60000)) {
    return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many lookups. Please wait a moment.' });
  }
  const phone = L.normalizePhone(url.searchParams.get('phone'));
  if (!phone) {
    return sendJSON(res, 400, { error: 'bad_phone', message: 'That does not look like a mobile number.' });
  }
  const raw = Number(url.searchParams.get('subtotal'));
  const subtotal = isFinite(raw) && raw >= 0 ? raw : null;

  const cust = L.find(customers, phone);
  /* Refresh lastSeenAt on the credential if one was presented, so the trim in
     issueDevice() drops the phones nobody uses any more. */
  if (cust) L.verifyDevice(cust, url.searchParams.get('device') || '', Date.now());
  return sendJSON(res, 200, L.publicView(cust, subtotal, Date.now()));
}

/* -------------------------------------------------------------------------- */
/* Browser recognition — the one surviving half of the rewards handshake     */
/* -------------------------------------------------------------------------- */

/* POST /api/orders/:id/claim  { claim }

   "I am the browser that placed this order, and it has been paid for — mint me
   a credential so I don't have to type my number again."

   ⚠️ SINCE 2026-10-16 THIS IS CONVENIENCE, NOT AUTHORITY. The phone number is
   the credential, so /api/price resolves rewards with or without one. What is
   left here is the silent-recognition the owner asked for in the first place:
   pay once, and this phone is filled in on every later order.

   It is still deliberately tied to a PAID ORDER rather than to the phone
   number, which now buys two things instead of one:

     * the credential on a browser is bound to an order the browser actually
       placed, so a stranger poking at numbers cannot plant a token; and
     * the cheapest way to occupy a slot in somebody's device list is still to
       buy a real order first.

   Deleting this endpoint would cost that convenience and nothing else. */
async function handleClaimOrder(req, res, id) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  /* Namespaced. throttled() keeps ONE counter per key, so a plain ip here
     would share a bucket with /api/customer, /api/price and /api/orders —
     and a guest browsing the menu would spend this endpoint's allowance
     before they ever placed an order. */
  if (throttled('claim:' + ip, 30, 60000)) {
    return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many attempts. Please wait a moment.' });
  }
  const o = orders.get(id);
  if (!o) return sendJSON(res, 404, { error: 'not_found' });

  /* An order placed before this feature existed has no claim secret, and one
     placed by a cached older page has none either. Both are told to ask at the
     counter rather than being handed an account. */
  if (!o.claimHash) {
    return sendJSON(res, 409, {
      error: 'claim_unavailable',
      message: 'We cannot set up rewards on this phone automatically. Please ask at the counter.'
    });
  }

  let raw;
  try { raw = await readBody(req, 4 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  const claim = String(body.claim || '').toLowerCase();
  if (!claim || L.hashSecret(claim) !== o.claimHash) {
    return sendJSON(res, 403, { error: 'bad_claim' });
  }
  /* Money first. An unpaid order proves nothing — it is the order the guest
     is about to walk away from. */
  if (!L.isPaidStatus(o.paymentStatus)) {
    return sendJSON(res, 409, {
      error: 'not_paid',
      message: 'We have not confirmed the payment on this order yet.'
    });
  }
  const phone = L.normalizePhone((o.customer || {}).phone);
  if (!phone) return sendJSON(res, 409, { error: 'no_phone' });

  const at = new Date().toISOString();
  const cust = L.ensure(customers, phone, at);
  if (!cust) return sendJSON(res, 400, { error: 'too_many_customers' });

  const token = L.issueDevice(cust, 'checkout', at);
  captureEmailFor(o, cust, at);
  L.touch(cust, (o.customer || {}).name, at);
  if (!o.claimUsedAt) { o.claimUsedAt = at; orders.set(o.id, o); saveOrdersSoon(); }
  saveCustomersStore();

  console.log('[kpot] device credential issued for ' + phone.slice(-4).padStart(10, '*') +
    ' via paid order ' + o.id);
  return sendJSON(res, 200, { ok: true, device: token, phone, name: L.maskName(cust.name) });
}

/* GET /api/schedule?date=YYYY-MM-DD — which days a guest may book, and how
   much room is left in each window of a given day.

   The guest page needs this to draw the picker, so it is public. It leaks
   nothing about anyone: capacities are counts, and counts of a shop's own
   delivery schedule are the shop's business to publish.

   With no `date` it returns the selectable days only — enough to draw the
   calendar. With one, it also returns that day's windows with the remaining
   capacity for each, which is what the time picker needs. */
function handleGetSchedule(req, res, url) {
  const cfg = scheduleCfg();
  const spec = hoursSpec();
  const now = Date.now();
  const out = {
    /* What the guest may act on: the RUNTIME channel switch, not the static
       config. An owner who turns Delivery back on from the board must see the
       picker light up without a redeploy. */
    enabled: !storeTypeOff('delivery'),
    fee: cfg.fee,
    perDayPerSlot: cfg.perDayPerSlot,
    maxDaysAhead: cfg.maxDaysAhead,
    days: SC.selectableDates(now, spec, cfg, 14)
  };
  const date = String(url.searchParams.get('date') || '').trim();
  if (date) {
    const ms = SC.dateKeyToMs(date);
    if (ms === null) {
      return sendJSON(res, 400, { error: 'bad_date', message: 'Use YYYY-MM-DD.' });
    }
    const key = SC.dateKeyOf(ms);
    out.date = key;
    out.open = SC.dayOpen(key, spec);
    out.slots = SC.slotsForDate(key, Array.from(orders.values()), cfg, spec);
  }
  return sendJSON(res, 200, out);
}

/* GET /api/customers?q=… — the owner's member list. Admin-gated: this one does
   show full phone numbers, because the owner already has them on every order
   and needs them to look a guest up at the counter. */
function handleListCustomers(req, res, url) {
  const q = String(url.searchParams.get('q') || '').trim();
  const lower = q.toLowerCase();
  const digits = q.replace(/\D/g, '');

  let arr = customers.slice();
  if (q) {
    arr = arr.filter((c) => (digits && c.phone.indexOf(digits) !== -1) ||
      (c.name && c.name.toLowerCase().indexOf(lower) !== -1));
  }
  arr.sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));

  const now = Date.now();
  return sendJSON(res, 200, {
    count: arr.length,
    customers: arr.slice(0, 500).map((c) => {
      const b = MB.benefitsFor(c, memberCfg(), now);
      return {
        phone: c.phone,
        name: c.name,
        /* Enough for the console to answer the two questions a counter gets:
           "can this guest recover on a new phone?" (email set?) and "are they
           signed in anywhere?" (devices > 0). The hashes stay here. */
        email: c.email || '',
        devices: L.deviceCount(c),
        points: c.points,
        lifetimePoints: c.lifetimePoints,
        settledOrders: c.settledOrders,
        stampsIssued: c.stampsIssued,
        unusedCoupons: (c.coupons || []).filter((x) => L.isUsable(x, now)).length,
        lastSeenAt: c.lastSeenAt,
        /* Membership, so the console can show "member until …" and offer the
           renew/cancel buttons without a second round trip. */
        member: b.member,
        memberUntil: c.memberUntil || null,
        memberDaysLeft: b.daysLeft
      };
    }),
    rules: loyaltyRules(),
    memberRules: (() => {
      const m = memberCfg();
      return {
        enabled: m.enabled, fee: m.fee, periodDays: m.periodDays, percent: m.percent,
        freeDelivery: m.freeDelivery, pointsMultiplier: m.pointsMultiplier,
        couponValue: m.couponValue
      };
    })()
  });
}

function loyaltyRules() {
  return L.rules();
}

/* POST /api/customers/adjust  { phone, delta?, coupon?, name?, note? }

   The escape hatch for the two things that WILL happen: a guest types the
   wrong mobile number, and a staff member forgets to confirm a payment.
   Without this the only remedy available at the counter is "sorry". Every
   change lands in the customer's own log, so a balance that looks wrong can
   be traced to whoever changed it. */
async function handleAdjustCustomer(req, res) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
  let raw;
  try { raw = await readBody(req, 16 * 1024); } catch (e) { return sendJSON(res, 413, { error: 'payload_too_large' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

  const phone = L.normalizePhone(body.phone);
  if (!phone) {
    return sendJSON(res, 400, { error: 'bad_phone', message: 'Enter a 10-digit mobile number.' });
  }

  const at = new Date().toISOString();
  const cust = L.ensure(customers, phone, at);
  if (!cust) return sendJSON(res, 400, { error: 'too_many_customers', message: 'The member list is full.' });

  const note = String(body.note || '').slice(0, 120);
  let changed = false;

  if (body.delta != null) {
    const delta = Number(body.delta);
    if (!isFinite(delta) || Math.floor(delta) !== delta) {
      return sendJSON(res, 400, { error: 'bad_delta', message: 'Points must be a whole number.' });
    }
    const next = Math.floor(Number(cust.points) || 0) + delta;
    /* Refused rather than clamped: a balance silently going to zero hides the
       mistake that caused it. */
    if (next < 0) {
      return sendJSON(res, 400, {
        error: 'points_negative',
        message: 'That would take the balance below zero — they have ' + cust.points + ' points.'
      });
    }
    cust.points = next;
    L.pushLog(cust, 'adjust', delta, note || 'staff adjustment', at);
    changed = true;
  }

  if (body.coupon) {
    const value = Number(body.coupon.value);
    if (!isFinite(value) || value <= 0 || value > 500) {
      return sendJSON(res, 400, { error: 'bad_coupon', message: 'Reward value must be between $0 and $500.' });
    }
    if ((cust.coupons || []).length >= L.MAX_COUPONS) {
      return sendJSON(res, 400, {
        error: 'too_many_coupons',
        message: 'That guest already holds ' + cust.coupons.length + ' rewards.'
      });
    }
    const c = L.makeCoupon('stamp', value,
      String(body.coupon.label || ('$' + value + ' off')).slice(0, 60), '', at);
    const days = Math.floor(Number(body.coupon.days));
    if (isFinite(days) && days > 0) {
      c.expiresAt = new Date(Date.parse(at) + days * 24 * 60 * 60 * 1000).toISOString();
    }
    cust.coupons.push(c);
    L.pushLog(cust, 'coupon_given', 0, c.label + (note ? ' — ' + note : ''), at);
    changed = true;
  }

  if (body.name) {
    cust.name = String(body.name).slice(0, 80);
    changed = true;
  }

  /* ---- the contact address, and the credentials --------------------------
     `email` is the ONE place an address may be rewritten. Since 2026-10-16 an
     address is contact data and nothing more — it authorises nothing — so this
     is the owner's phone book, not a takeover surface. An empty string clears
     it. */
  if (body.email != null) {
    const e = String(body.email).trim();
    if (!e) {
      if (cust.email) { L.pushLog(cust, 'email_cleared', 0, note || 'cleared by staff', at); cust.email = ''; changed = true; }
    } else {
      const norm = L.normalizeEmail(e);
      if (!norm) {
        return sendJSON(res, 400, { error: 'bad_email', message: 'That does not look like an e-mail address.' });
      }
      if (norm !== cust.email) {
        cust.email = norm;
        L.pushLog(cust, 'email_set', 0, (note ? note + ' — ' : '') + 'set by staff', at);
        changed = true;
      }
    }
  }

  /* "Stop remembering this browser." Kills every credential on the account;
     the guest goes back to typing their number. Nothing is lost — points and
     rewards are untouched, and since 2026-10-16 a credential was never needed
     to reach them in the first place, so this is tidiness rather than a
     security action. Kept because the owner asked for it and it is harmless. */
  if (body.revokeDevices) {
    const n = L.revokeDevices(cust);
    if (n) {
      L.pushLog(cust, 'devices_revoked', 0, n + ' device(s) signed out' + (note ? ' — ' + note : ''), at);
      changed = true;
    }
  }

  /* ---- membership: confirm / cancel -----------------------------------
     `body.member` is a string, not a number, because the only two things an
     owner can do to a membership are roll it forward and end it. Anything
     else is refused rather than treated as "cancel" — an unrecognised verb
     must not unlock or lock a guest out by accident. */
  if (body.member != null) {
    const verb = String(body.member).trim().toLowerCase();
    if (verb === 'confirm' || verb === 'renew') {
      const r = MB.confirmMember(cust, Date.parse(at), memberCfg());
      if (r.changed) {
        if (r.coupon) {
          if ((cust.coupons || []).length < L.MAX_COUPONS) {
            /* makeCoupon() only expires 'return' coupons; a member coupon is
               minted here and then given its own window, exactly as the staff
               one-off reward below does. */
            const c = L.makeCoupon('member', r.coupon.value,
              String(r.coupon.label).slice(0, 60), '', at);
            const days = Math.floor(Number(r.coupon.days));
            if (isFinite(days) && days > 0) {
              c.expiresAt = new Date(Date.parse(at) + days * 24 * 60 * 60 * 1000).toISOString();
            }
            cust.coupons.push(c);
            L.pushLog(cust, 'coupon_given', 0, c.label, at);
          }
        }
        L.pushLog(cust, 'member_renewed', 0,
          'member until ' + String(r.memberUntil).slice(0, 10), at);
        changed = true;
      } else {
        /* Tapping twice inside the same period is not an error, but it is not
           a change either — and it must NOT mint a second coupon. */
        return sendJSON(res, 200, {
          ok: true, id: phone, customer: L.adminView(cust), member: 'already_current'
        });
      }
    } else if (verb === 'cancel') {
      const r = MB.cancelMember(cust);
      if (r.changed) {
        L.pushLog(cust, 'member_cancelled', 0, 'membership ended', at);
        changed = true;
      }
    } else {
      return sendJSON(res, 400, {
        error: 'bad_member',
        message: 'Send member: "confirm" or member: "cancel".'
      });
    }
  }

  if (!changed) {
    return sendJSON(res, 400, { error: 'nothing_to_do', message: 'Send a points change, a reward, a name, or a member action.' });
  }

  saveCustomersStore();
  console.log('[kpot] loyalty: staff adjusted ' + phone + (note ? ' — ' + note : ''));
  return sendJSON(res, 200, {
    ok: true,
    customer: L.adminView(cust)
  });
}

/* GET /api/customers/export.csv|.json — the owner's own copy of the ledger.
   Same reasoning as the order export: the container is not durable, so the
   back office must be able to pull a full snapshot at any moment. */
function handleExportCustomers(req, res, format) {
  if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });

  const stamp = new Date().toISOString().slice(0, 10);
  const arr = customers.slice().sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));

  if (format === 'csv') {
    const body = L.toCsv(arr, Date.now());
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kpot-members-' + stamp + '.csv"',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  return sendJSON(res, 200, {
    exportedAt: new Date().toISOString(),
    count: arr.length,
    currency: 'USD',
    rules: loyaltyRules(),
    customers: arr
  });
}

loadDiscountCodes();
loadCustomersStore();
loadCreditsStore();
loadMenuStore();

const server = http.createServer((req, res) => {
  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      checkout: !!SECRET_KEY,
      verify: !!SECRET_KEY,
      keyMode: KEY_MODE,
      currency: ASSETS.CONFIG.currency || 'usd'
    });
  }

  /* The browser needs our VAPID public key before it can subscribe to push.
     Public, unauthenticated — it is not a secret (every subscriber gets it). */
  if (pathname === '/api/push/vapid-public-key') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return sendJSON(res, 200, { publicKey: (PUSH && PUSH.configured()) ? PUSH.publicKey() : null });
  }

  /* Which payment methods does Stripe ACTUALLY offer right now?
     ---------------------------------------------------------------------
     Wallet buttons (Apple Pay / Google Pay) are gated by Dashboard toggles and
     by device support, not by anything in this codebase — so "I don't see them"
     cannot be answered by reading our source. This asks Stripe directly:
     create a $1 session, read back `payment_method_types`, then expire it.
     Read-only in the sense that nothing is chargeable (we expire it, and
     nobody ever sees the URL).

     Admin-gated: it creates a live session, so it must not be a public probe. */
  if (pathname === '/api/payment-methods') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method_not_allowed' });
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    if (!SECRET_KEY) return sendJSON(res, 200, { ok: false, reason: 'no_key' });
    return probePaymentMethods().then((r) => sendJSON(res, 200, r))
      .catch((e) => {
        console.error('[kpot] payment-methods probe failed:', e && e.message);
        sendJSON(res, 500, { ok: false, reason: 'probe_failed', message: e && e.message });
      });
  }

  if (pathname === '/api/verify-session') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleVerifySession(req, res, url).catch((e) => {
      console.error('[kpot] verify unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error', verified: false });
    });
  }

  if (pathname === '/api/price') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handlePrice(req, res).catch((e) => {
      console.error('[kpot] price unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* Live delivery-distance check (advisory — see handleDeliveryCheck). */
  if (pathname === '/api/delivery/check') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleDeliveryCheck(req, res).catch((e) => {
      console.error('[kpot] delivery check unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error', status: 'unknown' });
    });
  }

  if (pathname === '/api/checkout') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleCheckout(req, res).catch((e) => {
      console.error('[kpot] unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* ---- Kitchen printing ---- */
  if (pathname === '/api/print/jobs') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handlePrintJobs(req, res, url);
  }
  if (pathname === '/api/print/status') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handlePrintStatus(req, res);
  }
  const printAckMatch = pathname.match(/^\/api\/print\/jobs\/([^/]+)\/ack$/);
  if (printAckMatch) {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handlePrintAck(req, res, decodeURIComponent(printAckMatch[1])).catch((e) => {
      console.error('[kpot] print ack unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }
  /* Manual reprint — admin-gated: it is a staff action, not something an agent
     or a guest should be able to trigger. */
  const reprintMatch = pathname.match(/^\/api\/orders\/([^/]+)\/reprint$/);
  if (reprintMatch) {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    const out = reprintKitchenTicket(decodeURIComponent(reprintMatch[1]));
    if (out.error) return sendJSON(res, out.error === 'order_not_found' ? 404 : 500, out);
    return sendJSON(res, 200, out);
  }

  /* Staff re-check: ask Stripe again whether this order was paid, and settle the
     board from Stripe's own answer. Needed when the guest paid and then closed
     the tab, so the browser never called /api/verify-session and the order sat
     at 'pending' while the money was already taken.

     Admin-gated for the same reason as reprint: it is a staff action, and it
     spends a Stripe round trip. It is also safe to press repeatedly — Stripe is
     the source of truth, so the result is the same every time. */
  const recheckMatch = pathname.match(/^\/api\/orders\/([^/]+)\/recheck-payment$/);
  if (recheckMatch) {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = decodeURIComponent(recheckMatch[1]);
    return recheckPayment(id).then((out) => {
      if (!out.ok) {
        const status = out.error === 'order_not_found' ? 404
          : out.error === 'stripe_not_configured' ? 503
          : out.error === 'not_a_card_order' ? 400
          : out.error === 'stripe_error' ? 502
          : 200;   // session_not_found is a legitimate "not paid yet" answer
        return sendJSON(res, status, out);
      }
      return sendJSON(res, 200, out);
    }).catch((e) => {
      console.error('[kpot] recheck unhandled:', e && e.message);
      return sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* ---- Web Push subscriptions ------------------------------------------
     Admin-gated: only the back office (which holds the admin key) may register
     or remove a push target. The public key itself is unauthenticated above. */
  if (pathname === '/api/push/subscribe' || pathname === '/api/push/unsubscribe') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    if (!PUSH || !PUSH.configured()) return sendJSON(res, 503, { error: 'push_not_configured' });
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    return handlePushSubscription(req, res, pathname.endsWith('/unsubscribe')).catch((e) => {
      console.error('[kpot] push subscription unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* Admin-only: fire a test push to every subscribed device without creating an
     order — lets the owner confirm the push link is live any time, with no print
     or reward side effects. */
  if (pathname === '/api/push/test') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    if (!PUSH || !PUSH.configured()) return sendJSON(res, 503, { error: 'push_not_configured' });
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    PUSH.sendToAll(buildTestPushPayload());
    return sendJSON(res, 200, { ok: true, devices: PUSH.count() });
  }

  /* ---- Order board + store controls ---- */
  if (pathname === '/api/orders') {
    if (req.method === 'POST') return handleCreateOrder(req, res).catch((e) => {
      console.error('[kpot] create-order unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    if (req.method === 'GET') return handleListOrders(req, res).catch((e) => {
      console.error('[kpot] list-orders unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  /* The driver's delivery run — its own path, its own key, nothing else. */
  if (pathname === '/api/driver/queue') {
    if (req.method === 'GET') return handleDriverQueue(req, res).catch((e) => {
      console.error('[kpot] driver-queue unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  /* ---- Order export (must be matched BEFORE /api/orders/:id, or "export.csv"
     would be read as an order id) ---- */
  const exportMatch = pathname.match(/^\/api\/orders\/export\.(json|csv)$/);
  if (exportMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    return handleExportOrders(req, res, exportMatch[1]);
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch) {
    const id = decodeURIComponent(orderMatch[1]);
    if (req.method === 'GET') return handleGetOrder(req, res, id).catch((e) => {
      console.error('[kpot] get-order unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    if (req.method === 'PATCH') return handleUpdateOrder(req, res, id).catch((e) => {
      console.error('[kpot] update-order unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  /* ---- Discount codes ----
     GET is admin-gated: the list is the owner's pricing, not something a guest
     should be able to enumerate. The guest flow only ever sends a code in and
     gets a price back. */
  if (pathname === '/api/discounts') {
    if (req.method === 'GET') {
      if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
      return handleGetDiscounts(req, res);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      return handlePutDiscounts(req, res).catch((e) => {
        console.error('[kpot] put-discounts unhandled:', e && e.message);
        sendJSON(res, 500, { error: 'internal_error' });
      });
    }
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  /* ---- Store credit ----
     GET /api/credit/balance?code=… — the guest page asks this while the code
     is being typed and again after a payment, because the Official Rules
     promise the remaining balance after every successful payment.

     Public for the same reason /api/customer is: the CODE is the credential.
     Whoever holds it can spend the balance anyway, so letting them read it
     grants nothing an attacker could not take. What it must NOT become is a
     code-guessing oracle, so it is throttled hard and returns only three
     fields — no history, no order ids, no e-mail. A wrong code and an expired
     one are deliberately the same answer shape. */
  if (pathname === '/api/credit/balance') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
    /* Its own bucket: a guest checking a code while re-pricing a cart would
       otherwise share (and exhaust) the /api/price allowance. */
    if (throttled('credit:' + ip, 30, 60000)) {
      return sendJSON(res, 429, { error: 'rate_limited', message: 'Too many checks. Please wait a moment.' });
    }
    const code = CR.normalizeCode(url.searchParams.get('code') || '');
    if (!code) return sendJSON(res, 400, { error: 'bad_code', message: 'Enter a store-credit code.' });
    const r = CR.balanceOf(credits, code);
    if (!r.ok) {
      return sendJSON(res, 404, {
        ok: false, reason: r.reason,
        message: r.reason === 'expired' ? 'That store-credit code has expired.'
          : r.reason === 'revoked' ? 'That store-credit code is no longer valid.'
            : 'We do not recognise that store-credit code.'
      });
    }
    return sendJSON(res, 200, {
      ok: true, balance: r.balance, expiresAt: r.expiresAt, codeRef: r.codeRef
    });
  }

  /* ---- Loyalty ----
     /api/customer is the only public one, and it is a lookup by an exact
     mobile number that returns the guest nothing they do not already know
     about themselves. The rest are admin-gated. */
  if (pathname === '/api/customer') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    return handleGetCustomer(req, res, url);
  }

  /* Mint a browser credential from a PAID order, so the guest page can
     recognise that phone next time without them retyping the number.

     ⚠️ CONVENIENCE ONLY since 2026-10-16. It used to be one of the two things
     that AUTHORISED spending. The phone number is the credential now, so
     nothing downstream refuses a caller who cannot produce one — see
     resolveLoyalty(). Deleting this endpoint would cost silent recognition and
     nothing else. */
  const claimMatch = pathname.match(/^\/api\/orders\/([^/]+)\/claim$/);
  if (claimMatch) {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleClaimOrder(req, res, decodeURIComponent(claimMatch[1])).catch((e) => {
      console.error('[kpot] claim unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* ---- Delivery schedule ----
     What days a guest may book, and how much room is left in each window.
     Public, because the guest has to see it to choose — but it reveals nothing
     about anyone: no guest names, no phone numbers, just capacities. */
  if (pathname === '/api/schedule') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    return handleGetSchedule(req, res, url);
  }

  /* Must be matched before /api/customers, or "export.csv" is read as a
     query — same trap as /api/orders/export.csv. */
  const memberExportMatch = pathname.match(/^\/api\/customers\/export\.(json|csv)$/);
  if (memberExportMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    return handleExportCustomers(req, res, memberExportMatch[1]);
  }

  if (pathname === '/api/customers/adjust') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleAdjustCustomer(req, res).catch((e) => {
      console.error('[kpot] adjust-customer unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  if (pathname === '/api/customers') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    return handleListCustomers(req, res, url);
  }

  if (pathname === '/api/store') {
    if (req.method === 'GET') return handleGetStore(req, res);
    if (req.method === 'POST') return handleSetStore(req, res).catch((e) => {
      console.error('[kpot] set-store unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  /* ---- Live menu (owner editing) ---- */
  if (pathname === '/api/menu') {
    if (req.method === 'GET') return handleGetMenu(req, res);
    if (req.method === 'PUT' || req.method === 'POST') return handlePutMenu(req, res).catch((e) => {
      console.error('[kpot] put-menu unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }

  if (pathname === '/api/menu/reset') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed' });
    return handleResetMenu(req, res).catch((e) => {
      console.error('[kpot] reset-menu unhandled:', e && e.message);
      sendJSON(res, 500, { error: 'internal_error' });
    });
  }

  /* ---- LUCKY 66 giveaway ----
     Feature-flagged OFF by default: while config.giveaway.enabled is false
     every public endpoint answers 404 and the draw/prize endpoints refuse.
     The pages themselves (giveaway.html, admin-giveaway.html,
     giveaway-rules.html, giveaway-privacy.html) are static and contain no
     shop data, so they may be served whatever the flag says — the banner in
     the ordering page is the only entry point and it is flag-gated too. */
  if (pathname.startsWith('/api/giveaway')) {
    return GWAPI.handle(req, res, pathname, url, {
      ASSETS: ASSETS,
      sendJSON: sendJSON,
      readBody: readBody,
      adminAuthorized: adminAuthorized,
      requestBaseUrl: requestBaseUrl,
      getStoreStatus: function () { return storeStatus; },
      /* The credit ledger, for prize issuance: the winner's code must exist as
         a spendable balance, not just as a sentence in an e-mail. File I/O and
         the plaintext-free store live here; giveaway-api.js decides policy. */
      credits: {
        minLength: CR.MIN_CODE_LENGTH,
        normalizeCode: function (raw) { return CR.normalizeCode(raw); },
        isValidCode: function (raw) { return CR.isValidCode(raw); },
        generateCode: function () { return CR.generateCode(); },
        issue: function (code, value, meta) {
          const r = CR.issue(credits, code, value, meta);
          if (r.ok) saveCreditsStore();
          return r;
        },
        balanceOf: function (rawCode) { return CR.balanceOf(credits, rawCode); }
      }
    }).catch((e) => {
      console.error('[kpot] giveaway unhandled:', e && e.message);
      sendJSON(res, 500, { ok: false, reason: 'internal_error' });
    });
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'not_found' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  return serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[kpot] listening on 0.0.0.0:' + PORT);
  console.log('[kpot] stripe key: ' + (SECRET_KEY ? KEY_MODE + ' mode' : 'NOT SET — online payment disabled'));
  console.log('[kpot] tax rate: ' + (ASSETS.CONFIG.taxRate * 100).toFixed(2) + '%');
});

/* Flush the order board before we go, so a deploy or Ctrl-C never loses the
   last few orders to the debounce window. The CSV/JSON backup is written here
   too: a redeploy is the single most likely moment to lose the container, so
   this is the backup that matters most.

   NOTE: on Windows this handler never runs (see the signal note above) — the
   30s flush loop is what protects data there. On the Linux deploy container it
   works normally. */
function shutdown(sig) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  saveOrdersNowSafe();
  writeBackup('shutdown-' + sig);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
/* Last-ditch for any other process.exit() path. Synchronous work only — async
   anything will not complete. */
process.on('exit', () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveOrdersNowSafe();
  writeBackup('exit');
});
