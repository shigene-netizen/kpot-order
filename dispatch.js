/* ==========================================================================
   KPOT To Go — dispatch.js
   --------------------------------------------------------------------------
   Which delivery goes FIRST.

   Every delivery this shop takes is booked for a named window on a named day
   (see schedule.js), and every one of them carries a street address the
   guest's own checkout already geocoded. This module turns that into the
   order the driver actually runs: the day's deliveries, sequenced.

   The sequence, in one line (the owner's decision, 2026-10-18):

       1. the delivery WINDOW — the earlier window is delivered first, always
       2. then DISTANCE    — inside one window, the nearer address goes first
       3. then age, then id — so two identical orders never swap places

   Nothing here talks to the network, the clock (unless asked), or the disk.
   The server feeds it orders and reads back the list; the browser is handed
   the result verbatim. Pure, so _dev/test_dispatch.js can exercise every rule
   without spawning anything.

   Zero dependencies; the only import is geo.js for the store's coordinates
   and the ZIP-centroid table.

   Run/test:  node _dev/test_dispatch.js
   ========================================================================== */

'use strict';

const G = require('./geo.js');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/* A Google Maps link that opens the address straight into navigation — the
   driver taps the card and the phone already knows where to go. Plain,
   unauthenticated, no API key: Maps opens whatever it is given, and a link
   costs nothing to build or to leak. */
function mapsUrlFor(address) {
  const q = String(address || '').replace(/\s+/g, ' ').trim();
  if (!q) return '';
  return 'https://maps.google.com/?q=' + encodeURIComponent(q);
}

/* How far this order is from the store, and WHICH ruler said so. The label
   matters: a ZIP centroid is the middle of a postcode, not the house, and the
   driver deserves to know the difference between "0.7 mi, geocoded" and
   "0.5 mi, ZIP estimate".
     'street' — the order carries the point the guest's checkout geocoded
     'zip'    — recomputed from a ZIP centroid (older orders, or a geocode
                that only ever reached ZIP level)
     null     — nothing to measure with; the order sorts LAST in its window */
function orderDistanceMi(order) {
  if (!order || typeof order !== 'object') return { miles: null, source: null };
  const o = order;

  /* 1. What the order already knows. handleCreateOrder keeps the measured
        point on delivery orders (`order.geo`), so the common case is free. */
  const g = o.geo;
  if (g && typeof g === 'object') {
    if (isFinite(Number(g.miles))) {
      return { miles: Number(g.miles), source: g.source || 'street' };
    }
    if (isFinite(Number(g.lat)) && isFinite(Number(g.lon))) {
      return {
        miles: G.haversineMi(G.STORE, { lat: Number(g.lat), lon: Number(g.lon) }),
        source: g.source || 'coords'
      };
    }
  }

  /* 2. The address text itself — a ZIP in the string is enough for a rough
        sort when no point was stored. */
  const zip = G.extractZip((o.customer || {}).when);
  const centroid = zip ? G.ZIP_CENTROIDS[zip] : null;
  if (centroid) {
    return {
      miles: G.haversineMi(G.STORE, { lat: centroid[0], lon: centroid[1] }),
      source: 'zip'
    };
  }

  return { miles: null, source: null };
}

/* -------------------------------------------------------------------------- */
/* The window                                                                   */
/* -------------------------------------------------------------------------- */

/* Minutes from midnight at which this order's window opens, or null when
   nobody can tell. `slots` is scheduleConfig().slots — the same normalized
   array resolveSchedule() validated against, so the id -> minutes mapping is
   the shop's own configuration rather than a guess.

   Fallback order: the slot table, then the stored kitchen-start moment
   (scheduledFor, an ISO string). An order with neither is anomalous — every
   delivery is created with a schedule — and it is sent to the END of the day
   rather than to the front, so a broken row can never jump the queue. */
function windowStartOf(order, slots) {
  const slotId = String(order.deliverySlot || '').trim();
  if (slotId && Array.isArray(slots)) {
    const hit = slots.find((s) => s && s.id === slotId);
    if (hit && isFinite(Number(hit.start))) return Number(hit.start);
  }
  const iso = String(order.scheduledFor || '');
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The sequence                                                                 */
/* -------------------------------------------------------------------------- */

/* sequenceDeliveries(orders, opts) -> Array<entry>
 *
 * opts:
 *   todayKey  'YYYY-MM-DD' of the shop's own day (default: derived from nowMs
 *             with the host's clock — the VM runs America/New_York)
 *   slots     scheduleConfig().slots, for window-start minutes
 *   nowMs     injected for tests (default Date.now())
 *
 * An order is in the run when it is a DELIVERY, it has not been completed or
 * cancelled, and its delivery day is today. An order left open from an
 * EARLIER day is still in the run and flagged `overdue` — the driver should
 * see it rather than wonder where the missing box went. Tomorrow's deliveries
 * are not today's problem and stay out.
 *
 * Returns one entry per order, in delivery order, with `seq` filled in from
 * 1. Same input -> same output, always: the sort is total (window, distance,
 * age, id), so a re-fetch cannot shuffle the run under the driver's thumb. */
function sequenceDeliveries(orders, opts) {
  const o = opts || {};
  const nowMs = isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();
  const todayKey = o.todayKey || localDateKey(nowMs);
  const slots = Array.isArray(o.slots) ? o.slots : [];

  const rows = [];
  for (const order of orders || []) {
    if (!order || typeof order !== 'object') continue;
    if (order.orderType !== 'delivery') continue;
    const status = String(order.status || '');
    if (status === 'completed' || status === 'cancelled') continue;

    const day = String(order.deliveryDate || '').trim() || todayKey;
    if (day > todayKey) continue;                    // a future booking
    const overdue = day < todayKey;                  // still open from before

    const start = windowStartOf(order, slots);
    const dist = orderDistanceMi(order);
    const cust = order.customer || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const lines = Array.isArray(order.lines) ? order.lines : [];
    const address = String(cust.when || '').replace(/\s+/g, ' ').trim();

    rows.push({
      id: String(order.id || ''),
      no: String(order.no || order.id || ''),
      at: String(order.at || ''),
      atMs: Date.parse(order.at || '') || 0,
      status: status,
      address: address,
      windowLabel: String(order.deliverySlotLabel || ''),
      windowStart: start,
      scheduledFor: String(order.scheduledFor || ''),
      overdue: overdue,
      miles: dist.miles,
      distSource: dist.source,
      customer: {
        name: String(cust.name || ''),
        phone: String(cust.phone || ''),
        email: String(cust.email || '')
      },
      total: isFinite(Number(order.total)) ? Number(order.total) : null,
      paid: order.paymentStatus === 'paid',
      payMethod: String(order.payMethod || ''),
      notes: String(cust.notes || ''),
      /* The kitchen's own line list, not the guest's word: qty x name, so the
         driver can check the bag against the door. */
      itemsText: items.length
        ? items.map((it) => (Number(it && it.qty) || 1) + '× ' + String((it && it.name) || 'item')).join(', ')
        : lines.map((l) => (Number(l && l.qty) || 1) + '× ' + String((l && l.name) || 'item')).join(', '),
      mapsUrl: mapsUrlFor(address)
    });
  }

  /* Sort key for a distance. `Number(null)` is 0 — a lie that would make an
   unmeasurable order look like the shop's next-door neighbour — so null and
   NaN both become "sorts last", never "sorts first". */
function distanceKey(miles) {
  if (miles === null || miles === undefined) return Number.MAX_SAFE_INTEGER;
  const n = Number(miles);
  return isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

rows.sort((a, b) => {
    /* Unknown window goes to the end of the day, never to the front. */
    const wa = a.windowStart === null ? Number.MAX_SAFE_INTEGER : a.windowStart;
    const wb = b.windowStart === null ? Number.MAX_SAFE_INTEGER : b.windowStart;
    if (wa !== wb) return wa - wb;
    /* Unmeasurable order goes last inside its window. */
    if (distanceKey(a.miles) !== distanceKey(b.miles)) return distanceKey(a.miles) - distanceKey(b.miles);
    if (a.atMs !== b.atMs) return a.atMs - b.atMs;   // older order first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;   // total, so it is stable
  });

  return rows.map((r, i) => {
    const e = Object.assign({}, r);
    e.seq = i + 1;
    delete e.atMs;                                    // internal only
    return e;
  });
}

/* Local YYYY-MM-DD for a timestamp. Same convention as schedule.js's
   dateKeyOf — the host runs America/New_York, so "today" is Atlanta's today.
   Kept local to this module so the pure tests can drive it with a fixed
   nowMs and never depend on the host's zone. */
function localDateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = {
  mapsUrlFor,
  orderDistanceMi,
  windowStartOf,
  sequenceDeliveries,
  localDateKey
};
