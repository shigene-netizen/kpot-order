/* ==========================================================================
   Pure-logic probe: the delivery run sequence.

   dispatch.js decides which delivery the driver takes first. Nothing here
   spawns a server: the rules are exercised directly, with fixed orders and a
   fixed clock.

   Covers:
     - which orders are in the run at all (delivery only, not completed or
       cancelled, today or overdue, never tomorrow)
     - the owner's sort: window first, then distance, then age, then id
     - anomalous rows (no window, no measurable distance) going to the END,
       never to the front
     - determinism: the same input twice gives the same run

   Run:  node _dev/test_dispatch.js
   ========================================================================== */

'use strict';

const D = require('../dispatch.js');
const G = require('../geo.js');

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (ok ? '' : '\n         ' + (detail || '')));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 0.01); }

/* The shop's own slot table, normalized the way scheduleConfig() normalizes
   it (id / label / start / end, minutes from midnight). */
const SLOTS = [
  { id: '12pm', label: '12:00 PM – 1:00 PM', start: 720, end: 780 },
  { id: '1pm', label: '1:00 PM – 2:00 PM', start: 780, end: 840 },
  { id: '6pm', label: '6:00 PM – 7:00 PM', start: 1080, end: 1140 }
];
const TODAY = '2026-10-18';
const OPTS = { todayKey: TODAY, slots: SLOTS, nowMs: Date.parse(TODAY + 'T15:00:00Z') };

/* An order as handleCreateOrder builds one. `geo` is what the shop's own
   geocode measured at checkout; `miles` is the straight-line distance. */
function order(no, extra) {
  const base = {
    id: 'KP-' + no,
    no: 'KP-' + no,
    at: '2026-10-18T09:00:00.000Z',
    orderType: 'delivery',
    status: 'received',
    deliveryDate: TODAY,
    deliverySlot: '12pm',
    deliverySlotLabel: '12:00 PM – 1:00 PM',
    scheduledFor: '2026-10-18T16:30:00.000Z',
    paymentStatus: 'paid',
    payMethod: 'stripe',
    total: 16.95,
    customer: { name: 'Alex Smith', phone: '(404) 555-0199', when: '1 NEAR Rd, Atlanta, GA 30339', notes: '' },
    items: [{ name: 'Pick 2 Proteins Bowl', qty: 1 }],
    lines: [{ name: 'Pick 2 Proteins Bowl', qty: 1, unit: 15.99, desc: '' }]
  };
  return Object.assign(base, extra || {});
}

function ids(rows) { return rows.map((r) => r.no).join(' '); }

function main() {
  console.log('the delivery run sequence');
  console.log('='.repeat(74));

  /* ====================================================================== */
  section('which orders are in the run');

  const mixed = [
    order('TODAY-1', { deliverySlot: '1pm', deliverySlotLabel: '1:00 PM – 2:00 PM' }),
    order('TOMORROW-1', { deliveryDate: '2026-10-19' }),
    order('DONE-1', { status: 'completed' }),
    order('CANCELLED-1', { status: 'cancelled' }),
    order('PICKUP-1', { orderType: 'pickup', deliveryDate: '', deliverySlot: '' }),
    order('DINEIN-1', { orderType: 'dinein', deliveryDate: '', deliverySlot: '' }),
    order('OVERDUE-1', { deliveryDate: '2026-10-17', deliverySlot: '6pm', deliverySlotLabel: '6:00 PM – 7:00 PM' })
  ];
  const run = D.sequenceDeliveries(mixed, OPTS);
  check("tomorrow's, finished, cancelled and non-delivery orders are all OUT",
    !/TOMORROW|DONE|CANCELLED|PICKUP|DINEIN/.test(ids(run)),
    'run was: ' + ids(run));
  check("today's order is IN", /TODAY-1/.test(ids(run)), 'run was: ' + ids(run));
  check("an order still open from an EARLIER day is IN, and flagged",
    /OVERDUE-1/.test(ids(run)) &&
      run.find((r) => r.no === 'KP-OVERDUE-1').overdue === true,
    'run was: ' + ids(run));
  check('the entries are numbered from 1',
    run.every((r, i) => r.seq === i + 1), JSON.stringify(run.map((r) => r.seq)));

  /* ====================================================================== */
  section('the sort: window first');

  const byWindow = D.sequenceDeliveries([
    order('EVENING', { deliverySlot: '6pm', deliverySlotLabel: '6:00 PM – 7:00 PM', scheduledFor: '2026-10-18T22:30:00.000Z' }),
    order('LUNCH-A', { deliverySlot: '12pm' }),
    order('EARLY-AFTER', { deliverySlot: '1pm', deliverySlotLabel: '1:00 PM – 2:00 PM' })
  ], OPTS);
  check('the earlier window is delivered first',
    ids(byWindow) === 'KP-LUNCH-A KP-EARLY-AFTER KP-EVENING', ids(byWindow));

  /* ====================================================================== */
  section('then distance, inside one window');

  /* Points on the same bearing as the store, at measured distances. */
  function atMiles(no, miles, extra) {
    /* Walk due north: 1 degree of latitude is ~69 miles. */
    const lat = G.STORE.lat + miles / 69.0;
    return order(no, Object.assign({
      geo: { lat: lat, lon: G.STORE.lon, miles: miles, source: 'street' },
      customer: { name: 'Alex', phone: '(404) 555-0100', when: no + ' Test Rd, Atlanta, GA 30339', notes: '' }
    }, extra || {}));
  }

  const byDistance = D.sequenceDeliveries([
    atMiles('FAR', 1.9),
    atMiles('NEAR', 0.7),
    atMiles('MID', 1.2)
  ], OPTS);
  check('inside one window the nearer address goes first',
    ids(byDistance) === 'KP-NEAR KP-MID KP-FAR', ids(byDistance));
  check('each entry carries its distance', byDistance[0].miles !== null && near(byDistance[0].miles, 0.7),
    JSON.stringify(byDistance.map((r) => r.miles)));

  /* ====================================================================== */
  section('anomalous rows go to the END, never to the front');

  const mixed2 = D.sequenceDeliveries([
    atMiles('MEASURED', 1.5),
    order('NOWINDOW', { deliverySlot: '', deliverySlotLabel: '', scheduledFor: '' }),
    order('NOMEASURE', { geo: null, customer: { name: 'B', phone: '(404) 555-0111', when: 'somewhere unknown', notes: '' } })
  ], OPTS);
  check('an order with no window is delivered last',
    ids(mixed2).split(' ').pop() === 'KP-NOWINDOW', ids(mixed2));
  check('an order with no measurable distance goes after the measured one',
    ids(mixed2) === 'KP-MEASURED KP-NOMEASURE KP-NOWINDOW', ids(mixed2));

  /* ====================================================================== */
  section('distance resolution');

  const stored = D.orderDistanceMi(order('X', { geo: { lat: 33.9, lon: -84.5, miles: 1.23, source: 'street' } }));
  check('a stored measurement is used as-is, with its ruler',
    near(stored.miles, 1.23) && stored.source === 'street', JSON.stringify(stored));

  const recomputed = D.orderDistanceMi(order('Y', {
    geo: { lat: G.STORE.lat + 1.0 / 69.0, lon: G.STORE.lon, source: 'street' }
  }));
  check('a stored point without miles is measured here',
    near(recomputed.miles, 1.0, 0.02) && recomputed.source === 'street', JSON.stringify(recomputed));

  const byZip = D.orderDistanceMi(order('Z', {
    geo: null, customer: { name: 'C', phone: '(404) 555-0122', when: 'Somewhere in Marietta, GA 30060' }
  }));
  check('an older order with no stored point falls back to its ZIP centroid',
    byZip.miles !== null && near(byZip.miles, 6.24, 0.05) && byZip.source === 'zip',
    JSON.stringify(byZip));

  const nothing = D.orderDistanceMi(order('W', {
    geo: null, customer: { name: 'D', phone: '(404) 555-0133', when: 'around here somewhere' }
  }));
  check('with nothing to measure, the answer is null (sorts last)', nothing.miles === null && nothing.source === null,
    JSON.stringify(nothing));

  /* ====================================================================== */
  section('what the driver is handed');

  const entry = D.sequenceDeliveries([order('CARD', {
    customer: { name: 'Alex Smith', phone: '(404) 555-0199', when: '2955 Cobb Pkwy SE, Suite 830, Atlanta, GA 30339', notes: 'Leave at the door' }
  })], OPTS)[0];
  check('the address is on the entry', /Cobb Pkwy/.test(entry.address), entry.address);
  check('and taps open into Maps navigation',
    entry.mapsUrl === 'https://maps.google.com/?q=' + encodeURIComponent('2955 Cobb Pkwy SE, Suite 830, Atlanta, GA 30339'),
    entry.mapsUrl);
  check('the customer and phone come along',
    entry.customer.name === 'Alex Smith' && entry.customer.phone === '(404) 555-0199', JSON.stringify(entry.customer));
  check('the window label comes along', entry.windowLabel === '12:00 PM – 1:00 PM', entry.windowLabel);
  check('a paid delivery is marked paid', entry.paid === true, JSON.stringify(entry.paid));
  check('the bag summary is qty x name from the kitchen lines',
    entry.itemsText === '1× Pick 2 Proteins Bowl', entry.itemsText);
  check('notes come along', entry.notes === 'Leave at the door', entry.notes);
  check('an unpaid delivery is NOT marked paid',
    D.sequenceDeliveries([order('UNPAID', { paymentStatus: 'pending' })], OPTS)[0].paid === false);

  const emptyAddr = D.sequenceDeliveries([order('NOADDR', { customer: { name: 'E', phone: '(404) 555-0144', when: '' } })], OPTS)[0];
  check('an order with no address still gets a row, with no map link',
    emptyAddr.mapsUrl === '' && emptyAddr.miles === null, JSON.stringify(emptyAddr.mapsUrl));

  /* ====================================================================== */
  section('determinism');

  const once = D.sequenceDeliveries([atMiles('A', 1.0), atMiles('B', 1.0), atMiles('C', 1.0)], OPTS);
  const twice = D.sequenceDeliveries([atMiles('C', 1.0), atMiles('A', 1.0), atMiles('B', 1.0)], OPTS);
  check('the same run comes back in the same order, whatever the input order',
    ids(once) === ids(twice), ids(once) + ' vs ' + ids(twice));
  check('and identical distances fall back to creation time',
    ids(once) === 'KP-A KP-B KP-C', ids(once));

  /* ====================================================================== */
  section('edges');

  check('no orders -> no run', D.sequenceDeliveries([], OPTS).length === 0);
  check('a null bag of orders is not a crash', D.sequenceDeliveries(null, OPTS).length === 0);
  check('junk rows are skipped, not thrown',
    D.sequenceDeliveries([null, 'nonsense', 42, order('GOOD')], OPTS).length === 1);
  check('the clock defaults to now when not injected',
    D.sequenceDeliveries([order('CLOCK')], { slots: SLOTS }).length === 1);
  check('todayKey defaults to the host day',
    D.localDateKey(Date.parse('2026-01-05T23:30:00Z')) === new Date(Date.parse('2026-01-05T23:30:00Z')).toISOString().slice(0, 10));

  /* ====================================================================== */
  section('window resolution');

  const fromSlot = D.windowStartOf(order('S'), SLOTS);
  check('the slot table gives the window start in minutes', fromSlot === 720, String(fromSlot));
  const fromSched = D.windowStartOf(order('T', { deliverySlot: '', scheduledFor: '2026-10-18T17:30:00.000Z' }), SLOTS);
  const expect = (() => { const d = new Date('2026-10-18T17:30:00.000Z'); return d.getHours() * 60 + d.getMinutes(); })();
  check('an unknown slot id falls back to the kitchen-start moment', fromSched === expect,
    String(fromSched) + ' expected ' + expect);
  check('and with neither, null', D.windowStartOf(order('U', { deliverySlot: '', scheduledFor: '' }), SLOTS) === null);

  console.log('\n' + '='.repeat(74));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main();
