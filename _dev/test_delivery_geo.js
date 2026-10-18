/* ==========================================================================
   Pure tests for geo.js — the 2-mile delivery rule.
   (no shop server, no network: the geocoder is a local stub on 127.0.0.1)

   The rule these pin down, in one line each:

     * a STREET coordinate inside 2 mi   -> ok
     * a STREET coordinate beyond 2 mi   -> blocked (this is the feature)
     * no street match, ZIP centroid near -> ok   (zip ruler)
     * no street match, ZIP centroid far  -> blocked (zip ruler)
     * no street match, unknown ZIP       -> unknown, order ALLOWED (fail open)
     * geocoder failing entirely          -> unknown, order ALLOWED (fail open)
     * an empty address                   -> unknown (nothing to enforce)

   The last three are as load-bearing as the refusals: a rule that blocks
   orders whenever a government website is down would take the shop offline
   over a network hiccup, and that is not what the owner asked for.

   Run:  node _dev/test_delivery_geo.js
   ========================================================================== */

'use strict';

const http = require('http');

const STUB_PORT = 8971;
process.env.KPOT_GEOCODE_API_BASE = 'http://127.0.0.1:' + STUB_PORT;

let hits = 0;                       /* how many geocode calls the stub answered */

/* Census-shaped responses, addressed by a keyword in the query. */
const RESPONSES = [
  { key: 'NEAR', coords: { x: -84.461181, y: 33.880479 + 1.0 / 69.0 } },  /* ~1 mi */
  { key: 'FAR', coords: { x: -122.084, y: 37.422 } },                     /* Mountain View */
  { key: 'OUTAGE', fail: true }
  /* anything else -> no matches */
];

const stub = http.createServer((req, res) => {
  hits++;
  const addr = decodeURIComponent((req.url.split('?address=')[1] || '')).toUpperCase();
  const hit = RESPONSES.find((r) => addr.indexOf(r.key) !== -1);
  res.setHeader('Content-Type', 'application/json');
  if (hit && hit.fail) { res.statusCode = 500; res.end('{"error":"down"}'); return; }
  const matches = hit
    ? [{ coordinates: hit.coords, matchedAddress: addr }]
    : [];
  res.end(JSON.stringify({ result: { addressMatches: matches } }));
});

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

const G = require('../geo.js');

async function main() {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  console.log('geo.js — the 2-mile delivery rule (geocoder stubbed locally)');
  console.log('='.repeat(74));
  console.log('stub up on ' + G.GEOCODE_API + '\n');

  /* ====================================================================== */
  section('the ruler itself');
  check('store -> itself is 0 mi', G.haversineMi(G.STORE, G.STORE) === 0);
  const oneMi = G.haversineMi(G.STORE, { lat: G.STORE.lat + 1 / 69, lon: G.STORE.lon });
  check('one degree-minute-of-latitude north is ~1.00 mi',
    Math.abs(oneMi - 1) < 0.01, oneMi.toFixed(3) + ' mi');
  check('the shop\'s own ZIP centroid is inside the radius',
    G.haversineMi(G.STORE, { lat: G.ZIP_CENTROIDS['30339'][0], lon: G.ZIP_CENTROIDS['30339'][1] }) < G.RADIUS_MI);
  check('RADIUS_MI is 2, the owner\'s decision', G.RADIUS_MI === 2, 'radius=' + G.RADIUS_MI);

  /* ====================================================================== */
  section('extracting a ZIP out of free text');
  check('a plain address', G.extractZip('123 Main St, Atlanta, GA 30339') === '30339');
  check('ZIP+4 is read as the 5-digit ZIP', G.extractZip('Atlanta GA 30339-1234') === '30339');
  check('no ZIP at all', G.extractZip('123 Main St, Atlanta') === null);
  check('a street number is not a ZIP', G.extractZip('2955 Cobb Pkwy SE') === null);

  /* ====================================================================== */
  section('STREET-level: the confident ruler');
  const near = await G.deliveryCheck('1 NEAR Test Rd, Atlanta, GA 30339');
  check('an address ~1 mi away is ok', near.status === 'ok', JSON.stringify(near));
  check('and says so from the street geocode', near.source === 'street', 'source=' + near.source);
  check('and reports the distance', typeof near.miles === 'number' && near.miles < G.RADIUS_MI,
    'miles=' + near.miles);

  const far = await G.deliveryCheck('1600 Amphitheatre Pkwy, Mountain View, CA 94043 FAR');
  check('an address 2000 mi away is BLOCKED', far.status === 'blocked', JSON.stringify(far));
  check('with the distance attached', far.miles > 2000, 'miles=' + far.miles);
  check('and a guest-facing message', /outside|2 miles|Pickup/i.test(far.message || ''), far.message);

  const just = await G.deliveryCheck('123 Edge Case Rd, Atlanta, GA 30339');
  check('an unmatched street with a known local ZIP falls to the ZIP ruler',
    just.status === 'ok' && just.source === 'zip', JSON.stringify(just));

  /* ====================================================================== */
  section('ZIP-level fallback: only when the street could not be matched');
  const zipOk = await G.deliveryCheck('Some New Subdivision Rd, Atlanta, GA 30339');
  check('a deliverable ZIP passes when the street is unknown',
    zipOk.status === 'ok' && zipOk.source === 'zip', JSON.stringify(zipOk));

  const zipFar = await G.deliveryCheck('Somewhere, Kennesaw, GA 30101');
  check('a far ZIP is BLOCKED even when the street is unknown',
    zipFar.status === 'blocked' && zipFar.source === 'zip', JSON.stringify(zipFar));
  check('and the message offers Pickup, not a dead end',
    /Pickup|Dine-In/i.test(zipFar.message || ''), zipFar.message);

  const zipUnknown = await G.deliveryCheck('123 Nowhere Ln, Metropolis, GA 99999');
  check('an UNKNOWN ZIP fails open (allowed, unverified)',
    zipUnknown.status === 'unknown' && zipUnknown.source === 'unverified', JSON.stringify(zipUnknown));
  check('and the message explains the 2-mile rule',
    /2 miles/i.test(zipUnknown.message || ''), zipUnknown.message);

  /* ====================================================================== */
  section('nothing to go on — fail OPEN by design');
  const empty = await G.deliveryCheck('');
  check('an empty address is unknown, not blocked',
    empty.status === 'unknown' && empty.source === 'empty', JSON.stringify(empty));

  const nonsense = await G.deliveryCheck('asdf');
  check('nonsense with no ZIP is unknown, not blocked',
    nonsense.status === 'unknown' && nonsense.source === 'unverified', JSON.stringify(nonsense));

  /* ====================================================================== */
  section('the geocoder itself failing — an outage must not stop the shop');
  const outageZip = await G.deliveryCheck('OUTAGE 5 Main St, Marietta, GA 30060');
  check('with a far ZIP known locally, the ZIP ruler still refuses',
    outageZip.status === 'blocked' && outageZip.source === 'zip', JSON.stringify(outageZip));

  const outageNoZip = await G.deliveryCheck('OUTAGE somewhere with no zip');
  check('with nothing to measure, an outage fails OPEN',
    outageNoZip.status === 'unknown' && outageNoZip.source === 'unverified', JSON.stringify(outageNoZip));

  const outageNear = await G.deliveryCheck('OUTAGE 1 Home St, Atlanta, GA 30339');
  check('an outage never manufactures a refusal',
    outageNear.status === 'ok', JSON.stringify(outageNear));

  /* ====================================================================== */
  section('the cache (the guest\'s keystrokes must not hammer the geocoder)');
  const before = hits;
  await G.deliveryCheck('1 NEAR Test Rd, Atlanta, GA 30339');   /* already asked above */
  check('a repeated address does not re-geocode', hits === before,
    'hits went ' + before + ' -> ' + hits);

  await new Promise((r) => stub.close(r));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
