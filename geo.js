/* ==========================================================================
   KPOT To Go — geo.js
   --------------------------------------------------------------------------
   Delivery distance enforcement. The shop delivers within TWO MILES of the
   store and no further: a guest who types an address outside that radius is
   refused by the SERVER (not just warned in the browser) and steered to
   Pickup or Dine-In.

   How an address is decided
   -------------------------
   1. STREET-LEVEL (confident). The address is geocoded through the US Census
      Bureau's geocoder — free, keyless, and built for exactly this: turning
      "2955 Cobb Pkwy SE, Atlanta, GA 30339" into coordinates. The straight-
      line (haversine) distance to the store decides: over the radius is a
      refusal.

   2. ZIP-LEVEL FALLBACK (approximate). If the street cannot be geocoded (new
      construction, an unusual format, a typo) the ZIP code is looked up in a
      table of centroids measured by hand from OpenStreetMap. A centroid is
      the middle of a whole ZIP code, so it is allowed a grace mile beyond
      the radius: a ZIP whose centre is inside radius+grace is treated as
      deliverable, one beyond it is refused. Precision is traded for coverage
      only here, and the result is labelled 'zip' so the caller (and the log)
      knows which ruler was used.

   3. UNVERIFIED (fail OPEN). The geocoder is unreachable, or nothing about
      the address locates it. The order is ALLOWED — an outage must not stop
      the shop taking money, and the address is printed on the kitchen ticket
      either way. The caller gets status 'unknown' and can show a soft note.

   The one rule that never bends: a refusal is only ever issued on positive
   evidence (a real coordinate beyond the radius, or a ZIP centroid beyond
   the grace distance). Everything else fails open.

   Zero dependencies; Node 18+ (global fetch, AbortController).

   Run/test:  node _dev/test_delivery_geo.js
   ========================================================================== */

'use strict';

/* -------------------------------------------------------------------------- */
/* The shop, and the rule                                                      */
/* -------------------------------------------------------------------------- */

/* 2955 Cobb Pkwy SE, Suite 830, Atlanta, GA 30339 — geocoded through the US
   Census geocoder (matched "2955 COBB PKWY S, ATLANTA, GA, 30339"). The
   store does not move, so these are constants, not a lookup. */
const STORE = { lat: 33.880479, lon: -84.461181 };

/* The owner's decision (2026-10-18): 2 miles, not the 5 the old menu card
   advertised. Straight-line distance to the store address. */
const RADIUS_MI = 2.0;

/* Only used for the ZIP-centroid fallback. A ZIP centroid is the middle of a
   ZIP code that can be 2-4 miles across, so "centroid 2.2 mi away" does NOT
   mean "every address in it is outside 2 mi" — some are inside. Allowing the
   extra mile keeps the fallback from refusing addresses that are actually
   deliverable; refusing one whose centroid is beyond radius+grace is safe,
   because the nearest edge of such a ZIP is still outside the radius. */
const ZIP_GRACE_MI = 3.0;

/* Mean Earth radius, miles. */
const R_MI = 3958.7613;

/* -------------------------------------------------------------------------- */
/* ZIP centroids near the shop                                                  */
/* -------------------------------------------------------------------------- */

/* Measured from OpenStreetMap's postcode centroids. Only used when the
   street itself cannot be geocoded. Distances from the store, for reference:

     30339   0.55 mi   (the shop's own ZIP)
     30067   3.35 mi
     30082   4.52 mi   ... and everything else is farther still.

   A ZIP that is NOT in this table does not make an address deliverable or
   undeliverable on its own — with no street match and no known ZIP the check
   fails open ('unknown'). The table exists so that the ZIP codes around the
   shop can still refuse an address whose street could not be matched. */
const ZIP_CENTROIDS = {
  '30339': [33.8881227, -84.4638736],
  '30060': [33.9390735, -84.5440353],
  '30062': [33.9976224, -84.4694208],
  '30066': [34.0352930, -84.5050213],
  '30067': [33.9283750, -84.4701661],
  '30068': [33.9684210, -84.4347712],
  '30075': [34.0462112, -84.3808888],
  '30082': [33.8520697, -84.5322314],
  '30064': [33.9400670, -84.6078624],
  '30101': [34.0426166, -84.7157640],
  '30126': [33.8147681, -84.5492128],
  '30127': [33.8601741, -84.7081852],
  '30144': [34.0353117, -84.5943702],
  '30152': [34.0014040, -84.6462721],
  '30338': [33.9413330, -84.3204396],
  '30350': [33.9762223, -84.3232906]
};

/* -------------------------------------------------------------------------- */
/* The geocoder                                                                 */
/* -------------------------------------------------------------------------- */

/* The US Census Bureau's geocoder: free, no key, no quota paperwork, and it
   geocoded this shop's own address cleanly. Overridable ONLY so a test can
   point it at a local stub and never touch the network — the delivery tests
   must be hermetic, and a suite that phones the government on every run is
   neither fast nor polite. */
const GEOCODE_API = process.env.KPOT_GEOCODE_API_BASE ||
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
if (process.env.KPOT_GEOCODE_API_BASE) {
  console.warn('[kpot-geo] WARNING: geocoder redirected to ' + GEOCODE_API +
    ' (KPOT_GEOCODE_API_BASE) — for tests only; never set this in production.');
}

const GEOCODE_TIMEOUT_MS = 4500;

/* Small, short-lived cache: the guest's browser asks about the address as it
   is typed (debounced), and checkout asks again. Addresses do not move, so a
   hit is always still true. Bounded so a long-running server cannot grow it
   without limit. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const geoCache = new Map();

function cacheGet(key) {
  const hit = geoCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { geoCache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value) {
  if (geoCache.size >= CACHE_MAX) {
    /* Drop the oldest entry — Map keeps insertion order. */
    const oldest = geoCache.keys().next().value;
    if (oldest !== undefined) geoCache.delete(oldest);
  }
  geoCache.set(key, { at: Date.now(), value: value });
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                 */
/* -------------------------------------------------------------------------- */

/* Great-circle distance in miles. */
function haversineMi(a, b) {
  const lat1 = Number(a.lat) * Math.PI / 180;
  const lat2 = Number(b.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (Number(b.lon) - Number(a.lon)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* The first 5-digit ZIP in the text, ignoring ZIP+4. A leading "5" inside a
   street number is not a ZIP, but nothing here depends on that: this is only
   consulted AFTER a street geocode has already failed. */
function extractZip(text) {
  const m = String(text || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Street geocode — one attempt, any failure = null                             */
/* -------------------------------------------------------------------------- */

/* Returns { lat, lon } or null. Null means "could not geocode this" for ANY
   reason: no match, non-200, timeout, network down. The caller decides what
   a null means (fallback, or fail open); it must never throw. */
async function geocodeStreet(address) {
  const q = norm(address);
  if (!q) return null;
  const url = GEOCODE_API + '?address=' + encodeURIComponent(q) +
    '&benchmark=Public_AR_Current&format=json';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const matches = data && data.result && data.result.addressMatches;
    if (!Array.isArray(matches) || !matches.length) return null;
    const c = matches[0] && matches[0].coordinates;
    if (!c || !isFinite(Number(c.y)) || !isFinite(Number(c.x))) return null;
    return { lat: Number(c.y), lon: Number(c.x) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Cached wrapper. */
async function geocodeStreetCached(address) {
  const key = norm(address).toLowerCase();
  if (!key) return null;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit.value;
  const value = await geocodeStreet(address);
  cacheSet(key, { value: value });
  return value;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                    */
/* -------------------------------------------------------------------------- */

/* deliveryCheck(address) -> Promise<{
 *   status:  'ok'       — verified deliverable
 *            'blocked'  — verified OUTSIDE the delivery radius
 *            'unknown'  — could not verify; order is allowed (fail open)
 *   miles:   number|null — distance to the store, when known
 *   source:  'street' | 'zip' | 'unverified' | 'empty' — which ruler decided
 *   coords:  {lat, lon}|null — the point that was measured, when there was one
 *   message: string      — guest-facing sentence for the UI (may be '')
 * }>
 *
 * Never throws. Never rejects. A delivery order that cannot be measured is
 * allowed through on purpose — see the module header.
 *
 * `coords` is what the delivery-dispatch queue sorts by: the guest page
 * already pays for this geocode (it is the same call the guest's live check
 * makes), so the point is handed back rather than thrown away, and
 * handleCreateOrder keeps it on the order. A ZIP-centroid result carries
 * the CENTROID, not the house — `source` says which one you are looking at. */
async function deliveryCheck(address) {
  const q = norm(address);
  if (!q) {
    return { status: 'unknown', miles: null, source: 'empty', coords: null, message: '' };
  }

  /* 1. Street-level — the confident ruler. */
  const point = await geocodeStreetCached(q);
  if (point) {
    const miles = haversineMi(STORE, point);
    if (miles > RADIUS_MI) {
      return {
        status: 'blocked', miles: miles, source: 'street', coords: point,
        message: 'That address is about ' + miles.toFixed(1) +
          ' miles from us — we deliver within ' + RADIUS_MI + ' miles. Please choose Pickup or Dine-In.'
      };
    }
    return { status: 'ok', miles: miles, source: 'street', coords: point, message: '' };
  }

  /* 2. ZIP-level fallback — only when the street could not be matched. */
  const zip = extractZip(q);
  const centroid = zip ? ZIP_CENTROIDS[zip] : null;
  if (centroid) {
    const coords = { lat: centroid[0], lon: centroid[1] };
    const miles = haversineMi(STORE, coords);
    if (miles > RADIUS_MI + ZIP_GRACE_MI) {
      return {
        status: 'blocked', miles: miles, source: 'zip', coords: coords,
        message: 'That address looks outside our ' + RADIUS_MI +
          '-mile delivery area. Please choose Pickup or Dine-In, or call us at +1 (678) 335-5388.'
      };
    }
    return { status: 'ok', miles: miles, source: 'zip', coords: coords, message: '' };
  }

  /* 3. Unverifiable — fail OPEN. */
  return {
    status: 'unknown', miles: null, source: 'unverified', coords: null,
    message: 'We could not verify that address automatically — we deliver within ' +
      RADIUS_MI + ' miles of the store.'
  };
}

module.exports = {
  STORE,
  RADIUS_MI,
  ZIP_GRACE_MI,
  ZIP_CENTROIDS,
  GEOCODE_API,
  haversineMi,
  extractZip,
  geocodeStreet,
  deliveryCheck
};
