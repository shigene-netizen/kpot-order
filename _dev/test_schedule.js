/* Delivery schedule rules: when a guest may book, and when a window is gone.
 *
 * The whole point of this file is that a booking is a PROMISE. Three ways to
 * break one:
 *
 *   - A DATE THAT DOES NOT EXIST. '2026-02-30' is a string that looks like a
 *     date; JS rolls it over to March 2nd, so the guest is sold a day the shop
 *     never agreed to. Rejected by round-tripping the components.
 *   - A WINDOW OUTSIDE OPENING HOURS. An owner who sets dinner to 10 PM on a
 *     shop that closes at 9:30 PM has promised a delivery nobody can make.
 *   - A WINDOW THAT IS FULL. The capacity is DERIVED from the orders rather
 *     than kept in a counter, so a cancelled order has to release its slot —
 *     and the arithmetic has to be in days, not milliseconds, or the twice a
 *     year the clocks change the booking lands a day out.
 *
 * That the server really refuses each of these, and that a scheduled order
 * really does not hit the kitchen before its window, is probe_schedule.js.
 *
 * Run:  node _dev/test_schedule.js
 */

'use strict';

const S = require('../schedule.js');

const NOW = Date.parse('2026-10-14T12:00:00Z');   /* a Wednesday */
const SPEC = { openMinute: 720, closeSunThu: 1290, closeFriSat: 1350 };

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + JSON.stringify(want) + '  got=' + JSON.stringify(got));
}
function ok(desc, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + desc +
    (cond ? '' : '\n         ' + (detail || '')));
}

/* ========================================================================== */
console.log('\n--- 1. date keys ---');
/* ========================================================================== */

check('a timestamp becomes YYYY-MM-DD', S.dateKeyOf(NOW), '2026-10-14');
check('a key parses back to that midnight', new Date(S.dateKeyToMs('2026-10-14')).getDate(), 14);
check('the same key twice gives the same ms', S.dateKeyToMs('2026-10-14'), S.dateKeyToMs('2026-10-14'));
/* THE ONE: a day that does not exist. */
check('2026-02-30 is refused, not rolled into March', S.dateKeyToMs('2026-02-30'), null);
check('2026-04-31 is refused', S.dateKeyToMs('2026-04-31'), null);
check('2026-13-01 is refused', S.dateKeyToMs('2026-13-01'), null);
check('2026-00-10 is refused', S.dateKeyToMs('2026-00-10'), null);
check('2026-01-00 is refused', S.dateKeyToMs('2026-01-00'), null);
check('a leap day is accepted', S.dateKeyToMs('2028-02-29') !== null, true);
check('a non-leap 29 Feb is refused', S.dateKeyToMs('2026-02-29'), null);
check('short form 2026-1-5 is refused (it sorts wrong)', S.dateKeyToMs('2026-1-5'), null);
check('a date-time string is refused', S.dateKeyToMs('2026-10-14T12:00:00Z'), null);
check('empty is refused', S.dateKeyToMs(''), null);
check('null is refused', S.dateKeyToMs(null), null);
check('a number is refused', S.dateKeyToMs(20261014), null);
check('an object is refused', S.dateKeyToMs({}), null);
check('an array is refused', S.dateKeyToMs([]), null);

/* Day arithmetic, not millisecond arithmetic. */
check('tomorrow is 1 day ahead', S.daysAheadOf('2026-10-15', NOW), 1);
check('today is 0 days ahead', S.daysAheadOf('2026-10-14', NOW), 0);
check('yesterday is -1', S.daysAheadOf('2026-10-13', NOW), -1);
/* Spring-forward: the night of 14 March 2027 is only 23 hours long. */
const dstNight = S.dateKeyToMs('2027-03-14');
check('across a 23-hour night it is still 1 day ahead',
  S.daysAheadOf('2027-03-15', dstNight + 12 * 3600000), 1);
/* Autumn-back: 25 hours. */
const fallNight = S.dateKeyToMs('2027-11-07');
check('across a 25-hour night it is still 1 day ahead',
  S.daysAheadOf('2027-11-08', fallNight + 12 * 3600000), 1);
check('a nonsense date has no day count', S.daysAheadOf('nope', NOW), null);

console.log('\n--- 2. which days are open ---');
check('a Wednesday is open', S.dayOpen('2026-10-14', SPEC), true);
check('a Sunday is open', S.dayOpen('2026-10-18', SPEC), true);
check('a Saturday is open', S.dayOpen('2026-10-17', SPEC), true);
check('nonsense hours mean closed', S.dayOpen('2026-10-14', {}), false);
check('a close before the open means closed',
  S.dayOpen('2026-10-14', { openMinute: 720, closeSunThu: 600 }), false);
check('no open minute means closed', S.dayOpen('2026-10-14', { closeSunThu: 1290 }), false);
check('no hours at all means closed', S.dayOpen('2026-10-14', null), false);
check('a bad date is closed, not open', S.dayOpen('2026-02-30', SPEC), false);

/* ========================================================================== */
console.log('\n--- 3. the days a guest may pick ---');
/* ========================================================================== */

const days = S.selectableDates(NOW, SPEC, {}, 14);
check('starting tomorrow', days[0].iso, '2026-10-15');
check('never today', days.some((d) => d.iso === '2026-10-14'), false);
check('never yesterday', days.some((d) => d.iso === '2026-10-13'), false);
check('maxDaysAhead 7 gives at most 7 days', days.length, 7);
check('the last is 7 days out', days[days.length - 1].iso, '2026-10-21');
check('and says so', days[days.length - 1].daysAhead, 7);
ok('they are in order', days.every((d, i) => i === 0 || days[i - 1].iso < d.iso), JSON.stringify(days));
ok('every one carries a weekday', days.every((d) => d.weekday >= 0 && d.weekday <= 6));

const short = S.selectableDates(NOW, SPEC, { maxDaysAhead: 3 }, 14);
check('maxDaysAhead 3 gives 3', short.length, 3);
check('and the last is 3 out', short[short.length - 1].iso, '2026-10-17');

const few = S.selectableDates(NOW, SPEC, {}, 2);
check('asking for 2 gives 2', few.length, 2);
check('starting tomorrow', few[0].iso, '2026-10-15');
check('asking for 0 still gives 1 (a guest must be offered something)',
  S.selectableDates(NOW, SPEC, {}, 0).length, 1);
check('a closed shop offers nothing at all',
  S.selectableDates(NOW, { openMinute: 1440, closeSunThu: 1290, closeFriSat: 1350 }, {}, 5).length, 0);

/* Sun-Thu closed, Fri-Sat open: only weekend days may be picked. */
const weekendOnly = S.selectableDates(NOW,
  { openMinute: 720, closeSunThu: 600, closeFriSat: 1350 }, {}, 14);
ok('a shop open only on Fri/Sat offers only Fri/Sat',
  weekendOnly.length > 0 && weekendOnly.every((d) => d.weekday === 5 || d.weekday === 6),
  JSON.stringify(weekendOnly));

/* ========================================================================== */
console.log('\n--- 4. the windows themselves ---');
/* ========================================================================== */

/* scheduleConfig() called with nothing returns schedule.js's own LAST-RESORT
   defaults. These are NOT the windows the shop sells — those live in
   assets/config.js and are pinned in section 8 below. What is checked here is
   that the fallback is well-formed and harmless, because it is what a guest
   gets if the config block is ever deleted or mis-typed. */
const cfg = S.scheduleConfig();
check('the built-in fallback offers two windows', cfg.slots.length, 2);
check('its first window is 12:00-14:00', cfg.slots[0].start + '-' + cfg.slots[0].end, '720-840');
check('and its second 17:00-20:00', cfg.slots[1].start + '-' + cfg.slots[1].end, '1020-1200');
/* The fallback fee stays the PAID price on purpose: a config we cannot read
   must not be the thing that gives delivery away for free. */
check('the fallback fee is the paid $1.99, not $0', cfg.fee, 1.99);
check('10 orders per window per day', cfg.perDayPerSlot, 10);
check('30 minutes of lead time', cfg.leadMinutes, 30);
check('a week ahead', cfg.maxDaysAhead, 7);
check('on by default', cfg.enabled, true);
check('enabled:false switches it off', S.scheduleConfig({ enabled: false }).enabled, false);

check('the fallback finds its first window by id', S.slotById('lunch', cfg).label, cfg.slots[0].label);
check('and its second by id', S.slotById('dinner', cfg).label, cfg.slots[1].label);
check('an unknown id is null', S.slotById('brunch', cfg), null);
check('an empty id is null', S.slotById('', cfg), null);
check('null is null', S.slotById(null, cfg), null);

/* A slot that cannot be read is dropped, not defaulted to "all day". */
check('a slot with no id is dropped',
  S.scheduleConfig({ slots: [{ start: 720, end: 840 }] }).slots.length, 0);
check('a slot with no start is dropped',
  S.scheduleConfig({ slots: [{ id: 'x', end: 840 }] }).slots.length, 0);
check('a slot whose end precedes its start is dropped',
  S.scheduleConfig({ slots: [{ id: 'x', start: 840, end: 720 }] }).slots.length, 0);
check('a slot that ends after midnight is dropped',
  S.scheduleConfig({ slots: [{ id: 'x', start: 1400, end: 1500 }] }).slots.length, 0);
check('a slot that starts before midnight is dropped',
  S.scheduleConfig({ slots: [{ id: 'x', start: -60, end: 120 }] }).slots.length, 0);
check('a garbage slot is dropped, leaving the good ones',
  S.scheduleConfig({ slots: [{ id: 'ok', start: 720, end: 840 }, 'nonsense', null] }).slots.length, 1);
check('an empty slot list means no windows at all',
  S.scheduleConfig({ slots: [] }).slots.length, 0);

console.log('\n--- 5. capacity comes from the orders ---');
/* ========================================================================== */

const inSlot = (n, status, slot) =>
  Array.from({ length: n }, (_, i) => ({
    id: 'KP-' + i, status: status || 'received',
    deliveryDate: '2026-10-15', deliverySlot: slot || 'lunch'
  }));

check('no orders means nothing used', S.capacityUsed([], '2026-10-15', 'lunch'), 0);
check('one order in that slot is one used', S.capacityUsed(inSlot(1), '2026-10-15', 'lunch'), 1);
check('nine orders is nine used', S.capacityUsed(inSlot(9), '2026-10-15', 'lunch'), 9);
check('a CANCELLED order does not hold a slot',
  S.capacityUsed(inSlot(10, 'cancelled'), '2026-10-15', 'lunch'), 0);
check('only the cancelled ones release',
  S.capacityUsed([].concat(inSlot(8), inSlot(2, 'cancelled')), '2026-10-15', 'lunch'), 8);
check('a different day is a different bucket',
  S.capacityUsed(inSlot(5), '2026-10-16', 'lunch'), 0);
/* Five lunches are NOT five dinners — the windows are booked separately. */
check('five lunch orders do not fill the dinner window',
  S.capacityUsed(inSlot(5), '2026-10-15', 'dinner'), 0);
check('but they do fill the lunch one', S.capacityUsed(inSlot(5), '2026-10-15', 'lunch'), 5);
check('an order with no delivery date is not counted',
  S.capacityUsed([{ id: 'KP-X', status: 'received' }], '2026-10-15', 'lunch'), 0);

const rows = S.slotsForDate('2026-10-15', inSlot(10), {}, SPEC);
check('a full window reports used=10', rows[0].used, 10);
check('remaining 0', rows[0].remaining, 0);
check('and is full', rows[0].full, true);
check('the OTHER window is untouched by it', rows[1].used, 0);
check('and still has room', rows[1].remaining, 10);
check('a closed day reports zero used (it cannot be booked anyway)',
  S.slotsForDate('2026-10-15', inSlot(5), {}, { openMinute: 1440, closeSunThu: 1290 })[0].used, 0);

/* ========================================================================== */
console.log('\n--- 6. resolving a booking ---');
/* ========================================================================== */

const pick = { date: '2026-10-15', slot: 'lunch' };
const good = S.resolveSchedule(pick, [], {}, SPEC, NOW);
check('tomorrow lunch resolves', good.ok, true);
check('with the date back', good.date, '2026-10-15');
check('and the window id', good.slot, 'lunch');
check('and its label', good.slotLabel, cfg.slots[0].label);
check('and a timestamp to start cooking at', !!good.scheduledFor, true);

/* 720 minutes minus 30 of lead = 11:30 local on the 15th. */
const forMs = Date.parse(good.scheduledFor);
const at = new Date(forMs);
check('the cook starts at 11:30', at.getHours() + ':' + String(at.getMinutes()).padStart(2, '0'), '11:30');
check('on the delivery day', at.getDate(), 15);
check('which is 30 minutes before the window opens',
  (720 * 60000 - (forMs - S.dateKeyToMs('2026-10-15'))) / 60000, 30);

/* A lead time longer than the window start rolls back to the evening before. */
const early = S.resolveSchedule(pick, [], { leadMinutes: 900 }, SPEC, NOW);
check('a 15-hour lead time starts the night BEFORE',
  new Date(Date.parse(early.scheduledFor)).getDate(), 14);

/* ---- every refusal, and its own name ---- */
check('no date at all', S.resolveSchedule({ slot: 'lunch' }, [], {}, SPEC, NOW).error, 'bad_date');
check('an empty date', S.resolveSchedule({ date: '', slot: 'lunch' }, [], {}, SPEC, NOW).error, 'bad_date');
check('a date that does not exist',
  S.resolveSchedule({ date: '2026-02-30', slot: 'lunch' }, [], {}, SPEC, NOW).error, 'bad_date');
check('today is too soon (delivery is next-day)',
  S.resolveSchedule({ date: '2026-10-14', slot: 'lunch' }, [], {}, SPEC, NOW).error, 'date_too_soon');
check('yesterday is too soon',
  S.resolveSchedule({ date: '2026-10-13', slot: 'lunch' }, [], {}, SPEC, NOW).error, 'date_too_soon');
check('eight days out is too far with a 7-day window',
  S.resolveSchedule({ date: '2026-10-22', slot: 'lunch' }, [], {}, SPEC, NOW).error, 'date_too_far');
check('exactly seven days out is fine',
  S.resolveSchedule({ date: '2026-10-21', slot: 'lunch' }, [], {}, SPEC, NOW).ok, true);
check('a closed day is refused',
  S.resolveSchedule({ date: '2026-10-15', slot: 'lunch' }, [],
    {}, { openMinute: 1440, closeSunThu: 1290 }, NOW).error, 'date_not_open');
check('an unknown window',
  S.resolveSchedule({ date: '2026-10-15', slot: 'brunch' }, [], {}, SPEC, NOW).error, 'bad_slot');
check('no window at all', S.resolveSchedule({ date: '2026-10-15' }, [], {}, SPEC, NOW).error, 'bad_slot');
check('a full window',
  S.resolveSchedule({ date: '2026-10-15', slot: 'lunch' }, inSlot(10), {}, SPEC, NOW).error, 'slot_full');
check('nine of ten is still bookable',
  S.resolveSchedule({ date: '2026-10-15', slot: 'lunch' }, inSlot(9), {}, SPEC, NOW).ok, true);
check('a full window of CANCELLED orders is bookable',
  S.resolveSchedule({ date: '2026-10-15', slot: 'lunch' }, inSlot(10, 'cancelled'), {}, SPEC, NOW).ok, true);
check('switched off entirely',
  S.resolveSchedule(pick, [], { enabled: false }, SPEC, NOW).error, 'schedule_disabled');
/* Scheduling is ON here, so the date is the first thing that fails. */
check('no pick at all', S.resolveSchedule(null, [], {}, SPEC, NOW).error, 'bad_date');
check('an empty pick', S.resolveSchedule({}, [], {}, SPEC, NOW).error, 'bad_date');

/* A window outside opening hours is refused, not quietly accepted. */
const lateWindow = { slots: [{ id: 'late', label: 'Late', start: 1320, end: 1380 }] };
check('a 10 PM window on a shop that closes at 9:30 is refused',
  S.resolveSchedule({ date: '2026-10-15', slot: 'late' }, [], lateWindow, SPEC, NOW).error,
  'slot_outside_hours');
const earlyWindow = { slots: [{ id: 'early', label: 'Early', start: 600, end: 700 }] };
check('a 10 AM window before opening is refused too',
  S.resolveSchedule({ date: '2026-10-15', slot: 'early' }, [], earlyWindow, SPEC, NOW).error,
  'slot_outside_hours');
/* The SAME window is fine on a Friday, when the shop is open an hour later. */
check('but a 10:30 PM window is fine on a Friday night',
  S.resolveSchedule({ date: '2026-10-16', slot: 'late' }, [],
    { slots: [{ id: 'late', label: 'Late', start: 1320, end: 1350 }] }, SPEC, NOW).ok, true);
/* And it is refused on a Sunday, which closes with Sun-Thu. */
check('a 10 PM window is NOT fine on a Sunday (Sun-Thu close)',
  S.resolveSchedule({ date: '2026-10-18', slot: 'late' }, [],
    { slots: [{ id: 'late', label: 'Late', start: 1320, end: 1380 }] }, SPEC, NOW).error,
  'slot_outside_hours');

/* Every refusal must be one of the named errors, never an exception. */
const badPicks = [null, undefined, {}, { date: null }, { slot: null }, { date: 12345 },
  { date: 'x' }, { date: '2026-10-15', slot: 7 }, 'nonsense'];
ok('no weird input produces an ok or a crash',
  badPicks.every((p) => S.resolveSchedule(p, [], {}, SPEC, NOW).ok !== true));

console.log('\n--- 7. when the kitchen starts ---');
check('a lunch booking starts the same day',
  new Date(S.scheduledForMs('2026-10-15', cfg.slots[0], {})).toString().slice(0, 15),
  new Date(S.dateKeyToMs('2026-10-15')).toString().slice(0, 15));
check('the timestamp is 11:30 local',
  new Date(S.scheduledForMs('2026-10-15', cfg.slots[0], {})).getMinutes(), 30);
check('a dinner booking starts 16:30 the same day',
  new Date(S.scheduledForMs('2026-10-15', cfg.slots[1], {})).getHours(), 16);
check('a 90-minute lead starts at 10:30',
  new Date(S.scheduledForMs('2026-10-15', cfg.slots[0], { leadMinutes: 90 })).getMinutes(), 30);
check('a nonsense date has no start time', S.scheduledForMs('nope', cfg.slots[0], {}), null);

/* ========================================================================== */
console.log('\n--- 8. the SHIPPED config (assets/config.js) ---');
/* ========================================================================== */
/* Everything above tests schedule.js in isolation. What the shop actually
   sells lives in assets/config.js, and the server hands it to schedule.js via
   scheduleCfg() — so nothing above this line would notice if that block were
   edited wrongly. These pins are what would.

   Comments are stripped first, and that is not paranoia: the config's own
   explanatory text quotes the values being asserted here (window times, the
   $1.99), so a regex over the raw source reads a comment as the setting. */
const fs = require('fs');
const path = require('path');
const configSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'config.js'), 'utf8');
const configCode = configSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const slotBlock = configCode.match(/slots:\s*\[([\s\S]*?)\]/);
const nums = (re) => slotBlock ? (slotBlock[1].match(re) || []).map((s) => Number(s.replace(/\D/g, ''))) : [];
const ids = slotBlock ? (slotBlock[1].match(/id:\s*'[^']+'/g) || []).map((s) => s.replace(/^id:\s*'/, '').replace(/'$/, '')) : [];
const starts = nums(/start:\s*\d+/g);
const ends = nums(/end:\s*\d+/g);

check('the shop sells five windows', ids.join(','), '12pm,1pm,2pm,3pm,4pm');
check('running 12:00 PM to 5:00 PM', starts.join('-') + '|' + ends.join('-'),
  '720-780-840-900-960|780-840-900-960-1020');
ok('each window is exactly one hour',
  starts.length === 5 && ends.length === 5 && starts.every((s, i) => ends[i] - s === 60),
  JSON.stringify({ starts: starts, ends: ends }));
ok('and each starts where the previous ended — no gaps, no overlaps',
  starts.every((s, i) => i === 0 || s === ends[i - 1]),
  JSON.stringify({ starts: starts, ends: ends }));
ok('every window falls inside opening hours (12:00 PM – 9:30 PM)',
  starts.length === 5 && starts[0] >= 720 && ends[ends.length - 1] <= 1290,
  'first=' + starts[0] + ' last=' + ends[ends.length - 1]);

/* The money. `fee` is what is charged and is part of the taxable base;
   `listFee` is display-only — the crossed-out "was" price. */
const feeMatch = configCode.match(/delivery:\s*\{[\s\S]*?\bfee:\s*([0-9.]+)/);
const shippedFee = feeMatch ? Number(feeMatch[1]) : null;
const listMatch = configCode.match(/listFee:\s*([0-9.]+)/);
const shippedList = listMatch ? Number(listMatch[1]) : null;
check('delivery ships FREE (fee 0)', shippedFee, 0);
check('with $1.99 kept as the crossed-out "was" price', shippedList, 1.99);

/* ========================================================================== */
console.log('\n--- 9. the fee seam: static seed vs the owner\'s runtime switch ---');
/* ========================================================================== */
/* deliverySettings() in pricing.js is the ONE place where the board's runtime
   channel switch is allowed to override the static config seed. It is
   invisible at a $0 fee — both answers are "free" — so it is pinned with a
   NON-ZERO fee, which keeps these assertions meaningful whatever the shop
   happens to be charging this month. */
const P = require('../pricing.js');
const seedOff = { delivery: { enabled: false, fee: 1.99 } };   // the shipped shape

check('the static seed alone leaves the channel off',
  P.deliverySettings(seedOff, null).enabled, false);
check('but the board switching it ON wins over the seed',
  P.deliverySettings(seedOff, { deliveryEnabled: true }).enabled, true);
check('and the fee survives that switch — it is not silently dropped to $0',
  P.deliverySettings(seedOff, { deliveryEnabled: true }).fee, 1.99);
check('switching it OFF on the board suppresses the fee downstream',
  P.deliverySettings(seedOff, { deliveryEnabled: false }).enabled, false);
check('a missing opts argument falls back to the seed, not to "on"',
  P.deliverySettings(seedOff, undefined).enabled, false);
check('a garbage fee reads as 0, never NaN (NaN would poison the tax)',
  P.deliverySettings({ delivery: { fee: 'abc' } }, { deliveryEnabled: true }).fee, 0);
check('a negative fee reads as 0', P.deliverySettings({ delivery: { fee: -5 } }, { deliveryEnabled: true }).fee, 0);
check('an empty-string fee reads as 0', P.deliverySettings({ delivery: { fee: '' } }, { deliveryEnabled: true }).fee, 0);
check('a real 0 reads as 0 — free is a price, not an unreadable value',
  P.deliverySettings({ delivery: { fee: 0 } }, { deliveryEnabled: true }).fee, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('FAIL — the schedule rules do not match what the shop intends');
  process.exit(1);
}
console.log('PASS — a booking is only ever promised for a day and window the shop can keep');
