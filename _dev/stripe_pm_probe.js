/* Ask Stripe what payment method types a Checkout Session actually gets, using
   the LIVE restricted key from secrets.local.json. Read-only: we create one
   session and immediately read it back (and expire it) — no money moves.

   The point: when `payment_method_types` is NOT sent, Stripe uses the dynamic
   payment methods configured in the Dashboard for that account. Wallets
   (Apple Pay / Google Pay / Link) are then gated by separate Dashboard toggles
   and by whether they are *available* — so the authoritative answer comes from
   the session object, not from our source code. */
const fs = require('fs');
const path = require('path');

const secretsPath = path.join(__dirname, '..', 'secrets.local.json');
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const KEY = secrets.stripeSecretKey || process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('no stripe key'); process.exit(1); }
console.log('key prefix:', KEY.slice(0, 12) + '…');

const API = 'https://api.stripe.com/v1';

async function main() {
  /* 1. Create a throwaway session the same way server.js does. */
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', 'https://example.com/?paid=1');
  form.set('cancel_url', 'https://example.com/?canceled=1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][product_data][name]', 'probe');
  form.set('line_items[0][price_data][unit_amount]', '100');
  form.set('line_items[0][quantity]', '1');

  const res = await fetch(API + '/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'probe-' + Date.now()
    },
    body: form.toString()
  });
  const session = await res.json();
  if (!res.ok) {
    console.log('CREATE FAILED', res.status);
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  console.log('\n=== SESSION CREATED ===');
  console.log('id:', session.id);
  console.log('url:', session.url ? session.url.slice(0, 80) + '…' : null);
  console.log('payment_method_types:', JSON.stringify(session.payment_method_types));
  console.log('payment_method_collection:', session.payment_method_collection);
  console.log('wallet_options:', JSON.stringify(session.wallet_options || null));

  /* 2. What does the ACCOUNT have enabled? */
  const cfgRes = await fetch(API + '/payment_method_configurations?limit=5', {
    headers: { Authorization: 'Bearer ' + KEY }
  });
  const cfg = await cfgRes.json();
  console.log('\n=== PAYMENT METHOD CONFIGURATIONS ===');
  if (!cfgRes.ok) {
    console.log('HTTP', cfgRes.status, JSON.stringify(cfg.error || cfg));
  } else {
    for (const c of (cfg.data || [])) {
      console.log('—', c.id, '| active:', c.active, '| name:', c.name);
      const pm = c.payment_method && c.payment_method;
      // the object nests per-method config under keys like `card`, `link`, `apple_pay`
      for (const k of Object.keys(c).filter(k => /pay|card|wallet|link/i.test(k))) {
        const v = c[k];
        if (v && typeof v === 'object' && 'display_preference' in v) {
          console.log('     ', k, '→', v.display_preference && v.display_preference.value,
                      '(available:', v.display_preference && v.display_preference.value !== null, ')');
        }
      }
    }
  }

  /* 3. Account capability probe: does the account expose apple_pay / google_pay? */
  const accRes = await fetch(API + '/accounts', { headers: { Authorization: 'Bearer ' + KEY } });
  console.log('\n=== ACCOUNT PROBE ===');
  console.log('GET /accounts →', accRes.status, '(restricted keys often lack permission here — that is fine)');

  /* 4. Clean up: expire the probe session so it cannot be paid. */
  const exp = await fetch(API + '/checkout/sessions/' + session.id + '/expire', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  console.log('\nexpire probe session →', exp.status);
}

main().catch(e => { console.error('probe failed:', e.message); process.exit(1); });