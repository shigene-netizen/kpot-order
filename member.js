/* ==========================================================================
   member.js — 月度会员：纯规则
   --------------------------------------------------------------------------
   收一份月费，换四项权益。**没有银行卡、没有自动续费**：店主在后台点一下
   「确认续费」，会员身份往后延一个周期，同时发一张本周期专属券。客人不付钱
   就自然过期，店主点「取消」就立刻失效。

   为什么不做 Stripe 订阅：那要把卡号存下来、跑订阅 webhook、处理扣款失败和
   退订。这个项目的订单恰恰是**刻意**从 webhook 上挪走的（重发一次回调就等于
   再送一单），再加一条订阅链路不划算。手动确认的代价是店主每个月要记得点
   一次——对一个十几个会员的店，这是对的取舍。

   四项权益（缺省值就是「省钱包」那一档，全部可在 config.js 的 member 块里改）：

       percent          每单 5% off
       freeDelivery     Delivery 单免运费
       pointsMultiplier 积分 ×2（只影响赚取，不影响余额）
       couponValue      每周期一张 $5 专属券

   ⚠️ 客人一次只能用一个折扣。会员折成为第五个互斥项，由 server.js 的
   resolveOrderDiscount 拦——不是靠前端把按钮变灰。

   ⚠️ 配置** fail closed**：percent 读不出来就当 0（绝不当 100），
   pointsMultiplier 读不出来就当 1。一个看不懂的配置项应该是「没有优惠」，
   而不是「白送」。
   ========================================================================== */

'use strict';

/* 缺省值。写在这里而不是只在 config.js 里，是为了让「店主删掉整块」和
   「店主写错一个值」变成同一件事：读不出来就用缺省，服务照常起。 */
const DEFAULTS = {
  enabled: true,
  fee: 9.99,             // 每个周期收多少（只是给后台显示用，不收钱在这里发生）
  periodDays: 30,        // 一次续费延多少天
  percent: 5,            // 每单折扣，百分数的整数部分：5 = 5% off
  freeDelivery: true,
  pointsMultiplier: 2,
  couponValue: 5,
  couponDays: 30,
  couponLabel: 'Member reward'
};

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function roundMs(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

/* 读一个正整数，读不出来就退回 fallback。 */
function positiveInt(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/* A fraction between 0 and 1, or the fallback. Used for the points multiplier,
   which must never be allowed to reach 0 or to explode. */
function saneMultiplier(raw, fallback) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 10);
}

/* Two different failures must produce different answers:
     the key is ABSENT  → fall back to the default (the owner deleted the block)
     the key is GARBAGE → 0 (the owner typo'd a value)

   A blank string counts as absent, because a JSON editor left half-finished is
   closer to "not set" than to "set to nothing". */
function valueOrZero(raw, key, fallback, max, asInt) {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = asInt ? parseInt(v, 10) : Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

function memberConfig(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const cfg = {
    enabled: r.enabled === false ? false : true,
    fee: Math.max(0, Number(r.fee) || DEFAULTS.fee),
    periodDays: positiveInt(r.periodDays, DEFAULTS.periodDays, 400),
    /* 百分数，整数。0 表示不开这个权益；读不出来也当 0 —— fail closed。 */
    percent: valueOrZero(r, 'percent', DEFAULTS.percent, 100, true),
    freeDelivery: r.freeDelivery === false ? false : true,
    pointsMultiplier: saneMultiplier(r.pointsMultiplier, DEFAULTS.pointsMultiplier),
    couponValue: round2(valueOrZero(r, 'couponValue', DEFAULTS.couponValue, 1000, false)),
    couponDays: positiveInt(r.couponDays, DEFAULTS.couponDays, 4000),
    couponLabel: String(r.couponLabel || DEFAULTS.couponLabel).slice(0, 60)
  };
  return cfg;
}

/* -------------------------------------------------------------------------- */
/* Membership state                                                            */
/* -------------------------------------------------------------------------- */

/* `now` is milliseconds. A member is whoever has an expiry still in the future.
   A missing, unparseable or past memberUntil is NOT a member — and a NaN
   comparison is false, so a corrupt date fails closed without a special case. */
function isMember(cust, now) {
  if (!cust) return false;
  const until = Date.parse(cust.memberUntil || '');
  if (!isFinite(until)) return false;
  return until > now;
}

/* Days left, rounded up so "expires tomorrow" reads 1 rather than 0. */
function daysLeft(cust, now) {
  const until = Date.parse(cust.memberUntil || '');
  if (!isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - now) / (24 * 60 * 60 * 1000)));
}

function memberUntilFrom(now, cfg) {
  const d = positiveInt(cfg && cfg.periodDays, DEFAULTS.periodDays, 400);
  return new Date(now + d * 24 * 60 * 60 * 1000).toISOString();
}

/* A parsed, sane copy of memberUntil, or null. The customer file is a JSON file
   on disk: a hand-edited ISO string, a number, or garbage are all possible. */
function normalizeMemberUntil(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = (raw instanceof Date) ? raw.getTime() : Date.parse(raw);
  if (!isFinite(t)) return null;
  return new Date(t).toISOString();
}

/* -------------------------------------------------------------------------- */
/* What a member actually gets, for a given order                              */
/* -------------------------------------------------------------------------- */

/* Everything the caller needs to decide, in one object. A non-member gets a
   flat object of zeros and falses, so no caller has to special-case. */
function benefitsFor(cust, cfg, now) {
  const c = memberConfig(cfg);
  const member = c.enabled && isMember(cust, now);
  return {
    member,
    daysLeft: member ? daysLeft(cust, now) : 0,
    /* 0 when not a member: the discount machinery treats 0 as "no discount",
       which is exactly the fail-closed answer. */
    percent: member ? c.percent : 0,
    freeDelivery: member ? c.freeDelivery : false,
    pointsMultiplier: member ? c.pointsMultiplier : 1,
    couponValue: member ? c.couponValue : 0
  };
}

/* The discount descriptor this member may apply to THIS order.

   A delivery order from a member with freeDelivery gets TWO options — a
   percentage off or the fee waived — because a guest may prefer one over the
   other and they may not have both (five-way exclusivity, enforced by the
   server). A pickup order only ever gets the percentage.

   `deliveryFee` is the fee that would otherwise be charged. If it is 0 (already
   free, or not a delivery order) the freeship option is not offered, because
   waiving nothing is not a benefit. */
function memberDiscountChoices(benefits, orderType, deliveryFee) {
  if (!benefits || !benefits.member) return [];
  const out = [];
  if (benefits.percent > 0) {
    out.push({
      id: 'member_percent',
      label: 'Member ' + benefits.percent + '% off',
      discount: { type: 'percent', value: benefits.percent, label: 'Member ' + benefits.percent + '% off', source: 'member' }
    });
  }
  if (benefits.freeDelivery && orderType === 'delivery' && (Number(deliveryFee) || 0) > 0) {
    out.push({
      id: 'member_freeship',
      label: 'Member free delivery',
      discount: { type: 'freeship', value: 0, label: 'Member free delivery', source: 'member' }
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Renewing and cancelling                                                      */
/* -------------------------------------------------------------------------- */

/* The owner taps "confirm renewal": the membership rolls forward one period
   from NOW (not from the old expiry), and one reward coupon is minted for the
   new period.

   Rolling from now rather than from the old expiry is deliberate. A guest who
   renews late has already been locked out since their expiry; adding a fresh
   full period is simpler to explain at the counter than "you get the remainder
   of last month plus a new one".

   ⚠️ The issued-for stamp is a CALENDAR DAY, not the exact millisecond. An
   owner double-tapping (or a flaky double-submit) lands two requests
   milliseconds apart, and comparing full timestamps made those look like two
   different periods — the guest got two coupons and nobody noticed until the
   ledger was audited. "One coupon per renewal day" is coarse enough to catch
   that and fine enough that a genuine re-enrolment after a cancellation still
   works the next day.

   Returns { changed, memberUntil, coupon }. `coupon` is null when the config
   turns the coupon off or when this day already issued one. */
function confirmMember(cust, nowMs, cfg) {
  if (!cust) return { changed: false, reason: 'no_customer', memberUntil: null, coupon: null };
  const c = memberConfig(cfg);
  const until = memberUntilFrom(nowMs, c);
  /* The stamp is the renewal DAY. `memberUntil` stays exact — it is the real
     expiry the guest is entitled to. */
  const issuedFor = new Date(nowMs).toISOString().slice(0, 10);
  if (cust.memberCouponIssuedFor === issuedFor) {
    /* Already renewed today — an owner tapping twice must not mint a second
       coupon. Return what is STORED, not what we just computed, so a caller
       comparing the two cannot be misled into thinking the date moved. */
    return {
      changed: false, reason: 'already_current',
      memberUntil: cust.memberUntil || null, coupon: null
    };
  }
  cust.memberUntil = until;
  cust.memberCouponIssuedFor = issuedFor;
  let coupon = null;
  if (c.couponValue > 0) {
    coupon = {
      kind: 'member',
      value: c.couponValue,
      label: c.couponLabel + ' · ' + c.couponValue + ' off',
      days: c.couponDays,
      note: 'member cycle ' + until.slice(0, 10)
    };
  }
  return { changed: true, memberUntil: until, coupon };
}

/* Cancelling wipes the expiry outright. History stays in the customer's log
   (the server writes it) so the counter can see what happened; the field itself
   is cleared so there is no window where a stale date could resurrect access. */
function cancelMember(cust) {
  if (!cust) return { changed: false, reason: 'no_customer' };
  if (!cust.memberUntil) return { changed: false, reason: 'not_a_member' };
  cust.memberUntil = null;
  return { changed: true, memberUntil: null };
}

/* -------------------------------------------------------------------------- */
/* Points                                                                      */
/* -------------------------------------------------------------------------- */

/* Points are earned on the DISCOUNTED food total, and a member earns the
   multiplier on top. `pointsFor` lives in customers.js and already floors the
   result, so the multiplier multiplies the INTEGER: $15.99 earns 15 points like
   everyone else, and a 2x member earns 30.

   Doubling the dollars first and flooring after would give 31, quietly handing
   every member a bonus in fractions of a cent. test_member.js pins this down. */
function pointsWithMultiplier(basePoints, multiplier) {
  const b = Math.max(0, Math.floor(Number(basePoints) || 0));
  const m = saneMultiplier(multiplier, 1);
  return Math.floor(b * m);
}

module.exports = {
  DEFAULTS, memberConfig, isMember, daysLeft, memberUntilFrom,
  normalizeMemberUntil, benefitsFor, memberDiscountChoices,
  confirmMember, cancelMember, pointsWithMultiplier
};
