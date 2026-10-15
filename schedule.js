/* ==========================================================================
   schedule.js — 次日 + 时段配送：纯规则
   --------------------------------------------------------------------------
   Delivery 换了玩法：不再是「现在做、四十分钟送到」，而是**今天订、明天在
   某个时段送**。运费便宜，代价是客人得等，而且每个时段**每天的配送单数有
   上限**——满了那个时段就选不了，客人只能选别的。

   这条规矩对整条链路有影响，值得先说清楚：

     * 排定的单**不会自动下厨房**。`maybeAutoPrepare` 见到未来的
       `scheduledFor` 一律不动，直到那个时刻到了（由服务端定时任务触发）。
       打印是跟着「状态转到 preparing」走的，所以**出票也跟着延后**，
       打印队列本身一行都不用改。
     * 时段余量**从订单里现算**（同日期、同时段、未取消的张数），不另开
       一个文件。少一份持久化数据就少一个要备份、要隔离、要指纹比对的料。

   时段用「从午夜起的分钟数」表示，和 config.js 的 hoursSpec 同一套记法
   （720 = 12:00 PM，1290 = 9:30 PM）。日期用本地时区的 `YYYY-MM-DD`——
   店里只有一个时区，服务端和客人都在里面。

   ⚠️ 时段必须落在营业时间内。店主如果把晚市写成 22:00–23:00 而店 21:30
   关门，客人会得到一单店员送不了的承诺。这个检查在这里做，不在前端做。
   ========================================================================== */

'use strict';

/* 缺省值。午市晚市都落在 12:00 开门、21:30 关门之内。 */
const DEFAULTS = {
  fee: 1.99,
  perDayPerSlot: 10,      // 每个时段每天最多几单
  maxDaysAhead: 7,        // 最远能订到几天后
  leadMinutes: 30,        // 配送窗口开始前多久开始做
  slots: [
    { id: 'lunch', label: '12:00 PM – 2:00 PM', start: 720, end: 840 },
    { id: 'dinner', label: '5:00 PM – 8:00 PM', start: 1020, end: 1200 }
  ]
};

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function intOr(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/* 一个时段：起止都必须是 0..1439 的整数，且 start < end。读不出来就当没有
   这个时段——不是当「全天」。 */
function normalizeSlot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 20);
  if (!id) return null;
  const start = parseInt(raw.start, 10);
  const end = parseInt(raw.end, 10);
  if (!isFinite(start) || !isFinite(end)) return null;
  if (start < 0 || end > 1439 || start >= end) return null;
  return {
    id,
    label: String(raw.label || (start + ' - ' + end)).slice(0, 60),
    start,
    end
  };
}

/* 读整块配送配置。`enabled:false` 关掉整个次日配送，但不关 Delivery 渠道
   本身——那是 orderTypes 的事，两件事分开。 */
function scheduleConfig(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const slots = Array.isArray(r.slots)
    ? r.slots.map(normalizeSlot).filter(Boolean)
    : DEFAULTS.slots.map(normalizeSlot).filter(Boolean);
  return {
    enabled: r.enabled === false ? false : true,
    fee: (() => {
      const n = Number(r.fee);
      if (!isFinite(n) || n < 0) return DEFAULTS.fee;
      return round2(Math.min(n, 500));
    })(),
    perDayPerSlot: intOr(r.perDayPerSlot, DEFAULTS.perDayPerSlot, 500),
    maxDaysAhead: intOr(r.maxDaysAhead, DEFAULTS.maxDaysAhead, 60),
    leadMinutes: intOr(r.leadMinutes, DEFAULTS.leadMinutes, 1440),
    slots
  };
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/* Local YYYY-MM-DD. `padStart` is deliberate: '2026-1-5' is not a date key,
   it is a string that looks like one and sorts wrong. */
function dateKeyOf(ms) {
  const d = new Date(ms);
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* Parse a date key back into local midnight. Rejects anything that is not
   exactly YYYY-MM-DD, which also rejects '2026-02-30' (JS would roll it over
   to March 2nd and hand the guest a day that does not exist). */
function dateKeyToMs(key) {
  const s = String(key == null ? '' : key).trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  /* Round-trip: if the components came back different, the day does not
     exist (Feb 30, April 31). */
  const back = new Date(t);
  if (back.getFullYear() !== y || back.getMonth() !== m - 1 || back.getDate() !== d) return null;
  return t;
}

function weekdayOf(key) { return new Date(dateKeyToMs(key)).getDay(); }

/* Is the shop open on that day at all? Reuses the same hoursSpec the guest
   page uses. A day with no open minute, or a close at or before the open,
   is closed. 0 = Sunday, matching hoursSpec's closeSunThu/closeFriSat names. */
function dayOpen(key, hoursSpec) {
  const t = dateKeyToMs(key);
  if (t === null) return false;
  const spec = hoursSpec || {};
  const open = parseInt(spec.openMinute, 10);
  if (!isFinite(open) || open < 0 || open >= 1439) return false;
  const day = weekdayOf(key);
  const close = (day === 5 || day === 6)
    ? parseInt(spec.closeFriSat, 10)
    : parseInt(spec.closeSunThu, 10);
  if (!isFinite(close) || close <= open) return false;
  return true;
}

/* How many days from `nowMs` to a date key. Compared as DAYS, never as
   milliseconds: a "day" is 23 hours on the spring-forward night and 25 on the
   autumn one, so `ms / 86400000` silently reads 0.96 or 1.04 and an
   off-by-one-day booking sneaks through twice a year. Rounding the quotient
   is the fix, and it is exact because both ends are local midnight. */
function daysAheadOf(dateKey, nowMs) {
  const target = dateKeyToMs(dateKey);
  const base = dateKeyToMs(dateKeyOf(nowMs));
  if (target === null || base === null) return null;
  return Math.round((target - base) / 86400000);
}

/* The days a guest may pick: tomorrow onwards, only days the shop is open,
   never more than maxDaysAhead out. Sorted, and always non-empty when the
   shop is open tomorrow. */
function selectableDates(nowMs, hoursSpec, cfg, count) {
  const c = scheduleConfig(cfg);
  /* `|| 14` would swallow a deliberate 0 — and a guest handed an empty picker
     is worse off than one handed a default. So parse first, then clamp. */
  const asked = parseInt(count, 10);
  const want = Math.max(1, Math.min(isFinite(asked) ? asked : 14, 60));
  const out = [];
  for (let i = 1; i <= c.maxDaysAhead && out.length < want; i++) {
    const key = dateKeyOf(nowMs + i * 86400000);
    if (!dayOpen(key, hoursSpec)) continue;
    out.push({ iso: key, weekday: weekdayOf(key), daysAhead: i });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Slots and capacity                                                          */
/* -------------------------------------------------------------------------- */

function slotById(slotId, cfg) {
  const c = scheduleConfig(cfg);
  const id = String(slotId == null ? '' : slotId).trim();
  return c.slots.find((s) => s.id === id) || null;
}

/* How many live orders already occupy a (date, slot). "Live" means not
   cancelled and not refused — a cancelled order has released its slot, exactly
   as it releases its points and its discount code.

   Counting is DERIVED from the orders rather than kept in a counter file. A
   separate counter would be an eighth persisted data set to back up, isolate
   in tests and fingerprint in run_all.sh — and it would go wrong the moment an
   order was cancelled or the container restarted mid-cancel. */
function capacityUsed(orders, dateKey, slotId) {
  const key = String(dateKey || '');
  const slot = String(slotId || '');
  let n = 0;
  for (const o of orders || []) {
    if (!o || o.status === 'cancelled') continue;
    if (String(o.deliveryDate || '') !== key) continue;
    if (String(o.deliverySlot || '') !== slot) continue;
    n++;
  }
  return n;
}

/* Every slot for a day, with how much room is left. `outsideHours` is not an
   error state — it is shown greyed out with a reason, because the owner needs
   to SEE that their configured window falls outside opening hours rather than
   wonder why nobody can pick it. */
function slotsForDate(dateKey, orders, cfg, hoursSpec) {
  const c = scheduleConfig(cfg);
  const open = dayOpen(dateKey, hoursSpec);
  const spec = hoursSpec || {};
  const openMin = parseInt(spec.openMinute, 10);
  const day = weekdayOf(dateKey);
  const close = (day === 5 || day === 6)
    ? parseInt(spec.closeFriSat, 10) : parseInt(spec.closeSunThu, 10);
  return c.slots.map((s) => {
    const used = open ? capacityUsed(orders, dateKey, s.id) : 0;
    const remaining = Math.max(0, c.perDayPerSlot - used);
    const badHours = !isFinite(openMin) || !isFinite(close) || s.start < openMin || s.end > close;
    return {
      id: s.id, label: s.label, start: s.start, end: s.end,
      used, cap: c.perDayPerSlot, remaining,
      full: remaining <= 0,
      outsideHours: badHours
    };
  });
}

/* When the kitchen should start on a scheduled order: the window's opening,
   minus the lead time.

   Built with the local Date constructor and setMinutes() rather than by adding
   milliseconds, because a window that opens after 2 AM would otherwise be an
   hour out on the day the clocks change. setMinutes() rolls across midnight
   and across the DST boundary correctly on its own. */
function scheduledForMs(dateKey, slot, cfg) {
  const c = scheduleConfig(cfg);
  const ms = dateKeyToMs(dateKey);
  if (ms === null) return null;
  const d = new Date(ms);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  at.setMinutes(at.getMinutes() + Number(slot.start) - c.leadMinutes);
  return at.getTime();
}

/* -------------------------------------------------------------------------- */
/* Resolving a guest's choice                                                  */
/* -------------------------------------------------------------------------- */

/* The single gate every scheduled delivery order goes through. It answers one
   question: may this guest take this slot on this day?

   Errors are specific on purpose. "That day is full" and "we are closed that
   day" and "you cannot order for today" are three different conversations at
   the counter, and a single `bad_schedule` would turn all three into the same
   shrug. Every branch below was written because it is reachable from a public
   web page. */
function resolveSchedule(pick, orders, cfg, hoursSpec, nowMs) {
  const c = scheduleConfig(cfg);
  if (!c.enabled) return { ok: false, error: 'schedule_disabled' };

  const dateKey = String((pick && pick.date) || '').trim();
  const slotId = String((pick && pick.slot) || '').trim();

  if (!dateKey) return { ok: false, error: 'bad_date' };
  const dateMs = dateKeyToMs(dateKey);
  if (dateMs === null) return { ok: false, error: 'bad_date' };

  /* Day arithmetic, not millisecond arithmetic — see daysAheadOf(). */
  const ahead = daysAheadOf(dateKey, nowMs);
  if (ahead === null) return { ok: false, error: 'bad_date' };
  if (ahead < 1) return { ok: false, error: 'date_too_soon' };
  if (ahead > c.maxDaysAhead) return { ok: false, error: 'date_too_far' };
  if (!dayOpen(dateKey, hoursSpec)) return { ok: false, error: 'date_not_open' };

  const slot = slotById(slotId, c);
  if (!slot) return { ok: false, error: 'bad_slot' };

  const row = slotsForDate(dateKey, orders, c, hoursSpec).find((s) => s.id === slot.id);
  if (row && row.outsideHours) return { ok: false, error: 'slot_outside_hours' };
  if (row && row.full) return { ok: false, error: 'slot_full' };

  const forMs = scheduledForMs(dateKey, slot, c);
  return {
    ok: true,
    date: dateKey,
    slot: slot.id,
    slotLabel: slot.label,
    scheduledFor: new Date(forMs).toISOString(),
    windowStart: slot.start,
    windowEnd: slot.end
  };
}

module.exports = {
  DEFAULTS, scheduleConfig, normalizeSlot, dateKeyOf, dateKeyToMs, weekdayOf,
  dayOpen, daysAheadOf, selectableDates, slotById, capacityUsed, slotsForDate,
  scheduledForMs, resolveSchedule
};
