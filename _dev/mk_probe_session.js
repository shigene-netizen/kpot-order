/* Create ONE throwaway Checkout Session and park its id/url in /tmp so a
   browser probe can inspect the hosted page structure.

   Writes /tmp/kpot_probe_session.json. The caller MUST expire it afterwards
   with _dev/rm_probe_session.js — never leave a payable session lying around.

   Read-only intent: no money moves, nothing is charged. */
const fs = require('fs');
const path = require('path');

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets.local.json'), 'utf8'));
const KEY = process.env.STRIPE_SECRET_KEY || secrets.stripeSecretKey;
if (!KEY) { console.error('no stripe key'); process.exit(1); }
console.log('key mode:', (KEY.match(/^(?:sk|rk)_(live|test)_/) || [])[1] || 'unknown');

async function main() {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', 'https://example.com/?paid=1');
  form.set('cancel_url', 'https://example.com/?canceled=1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][product_data][name]', 'KPOT probe');
  form.set('line_items[0][price_data][unit_amount]', '100');
  form.set('line_items[0][quantity]', '1');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'domprobe-' + Date.now()
    },
    body: form.toString()
  });
  const s = await res.json();
  if (!res.ok) { console.error('CREATE FAILED', res.status, JSON.stringify(s.error || s)); process.exit(1); }
  fs.writeFileSync('/tmp/kpot_probe_session.json', JSON.stringify({ id: s.id, url: s.url }, null, 2));
  console.log('id:', s.id);
  console.log('url:', s.url);
  console.log('saved to /tmp/kpot_probe_session.json');
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
