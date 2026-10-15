/* Expire the throwaway session created by _dev/mk_probe_session.js, so a
   probe session can never be paid. Safe to run twice. */
const fs = require('fs');
const path = require('path');

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets.local.json'), 'utf8'));
const KEY = process.env.STRIPE_SECRET_KEY || secrets.stripeSecretKey;

let id;
try { id = JSON.parse(fs.readFileSync('/tmp/kpot_probe_session.json', 'utf8')).id; }
catch (e) { console.log('nothing to expire (no /tmp/kpot_probe_session.json)'); process.exit(0); }
if (!id) { console.log('no session id'); process.exit(0); }

fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id) + '/expire', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
}).then(async (r) => {
  const j = await r.json().catch(() => null);
  console.log('expire', id, '->', r.status, (j && j.status) || '');
  fs.unlinkSync('/tmp/kpot_probe_session.json');
}).catch((e) => { console.error('expire failed:', e.message); process.exit(1); });
