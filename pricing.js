/* ==========================================================================
   KPOT To Go — Server-side pricing
   --------------------------------------------------------------------------
   THE PRICE IS ALWAYS COMPUTED HERE, NEVER TAKEN FROM THE BROWSER.

   The checkout request arrives from a public web page, so anything in it can
   be edited by anyone with a browser console. We therefore recompute every
   line from the same menu file the storefront uses, and only use the client
   payload to describe WHAT was ordered — never what it costs.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* The storefront files declare top-level `const`s, which do not land on the vm
   context's global object. Appending an explicit export inside the same script
   scope is the simplest way to read them without changing the browser files. */
function loadFromScript(file, exportExpr, name) {
  const src = fs.readFileSync(file, 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__out = ' + exportExpr + ';', ctx, { filename: file });
  if (ctx.__out === undefined) throw new Error('Could not read ' + name + ' from ' + file);
  return ctx.__out;
}

/* Where the delivery fee comes from. ONE place, so the browser, the server and
   the ticket cannot disagree.

   The flat `deliveryEnabled` / `deliveryFee` keys are gone; everything now
   lives in the `delivery` block (see config.js). Reads are defensive because
   a host page or a hand-edited config can hand us anything: an unreadable fee
   falls back to 0 rather than NaN, because a NaN fee silently poisons the
   total and the tax. */
function deliverySettings(CONFIG, opts) {
  const d = (CONFIG && typeof CONFIG === 'object' && CONFIG.delivery) || {};
  let enabled = d.enabled === false ? false : true;
  if (opts && typeof opts.deliveryEnabled === 'boolean') {
    enabled = opts.deliveryEnabled;
  }
  let fee = 0;
  if (d.fee !== undefined && d.fee !== null && d.fee !== '') {
    const n = Number(d.fee);
    if (isFinite(n) && n >= 0) fee = round2(n);
  }
  return { enabled, fee };
}

function loadAssets(root) {
  const menuFile = path.join(root, 'assets', 'menu.js');
  const MENU = loadFromScript(menuFile, 'MENU', 'MENU');
  const CATEGORIES = loadFromScript(menuFile, 'CATEGORIES', 'CATEGORIES');
  const CONFIG = loadFromScript(path.join(root, 'assets', 'config.js'), 'CONFIG', 'CONFIG');
  return { MENU, CONFIG, CATEGORIES };
}

/* -------------------------------------------------------------------------- */
/* Unit price lookups                                                          */
/* -------------------------------------------------------------------------- */

function findSimplePrice(name, MENU) {
  for (const g of MENU.drinks.groups) {
    if (Array.isArray(g.options) && g.options.includes(name)) return g.price;
  }
  for (const g of MENU.sides.groups) {
    const hit = (g.items || []).find((i) => i.n === name);
    if (hit) return hit.price;
  }
  return null;
}

/* Add-ons are stored in the cart as display strings, e.g.
   "Make It a Combo (+$3.99)". Match on the leading name, ignore the price the
   browser wrote — the real price comes from the menu. */
function addonPrice(kind, label, MENU) {
  const list = (kind === 'hotpot' ? MENU.hotpot.addons : MENU.bbq.addons) || [];
  const hit = list.find((a) => String(label).indexOf(a.n) === 0);
  return hit ? hit.price : 0;
}

function unitPrice(item, MENU) {
  const kind = item.kind || 'simple';

  if (kind === 'hotpot') {
    let p = MENU.hotpot.basePrice;
    (item.addons || []).forEach((a) => { p += addonPrice('hotpot', a, MENU); });
    return p;
  }

  if (kind === 'bbq') {
    // mods[0] is the chosen bowl size, e.g. "Pick 2 Proteins"
    const sizeName = (item.mods || [])[0] || '';
    const size = MENU.bbq.sizes.find((s) => s.n === sizeName);
    let p = size ? size.price : MENU.bbq.sizes[0].price;
    (item.addons || []).forEach((a) => { p += addonPrice('bbq', a, MENU); });
    return p;
  }

  return findSimplePrice(item.name, MENU);
}

/* -------------------------------------------------------------------------- */
/* Whole-order pricing                                                         */
/* -------------------------------------------------------------------------- */

const MAX_LINES = 60;
const MAX_QTY = 50;
const MAX_TIP_RATE = 0.5;
const MAX_DISCOUNT_PERCENT = 100;

function priceOrder(order, MENU, CONFIG, opts) {
  if (!order || typeof order !== 'object') return { error: 'bad_request' };
  if (!Array.isArray(order.items) || order.items.length === 0) return { error: 'empty_order' };
  if (order.items.length > MAX_LINES) return { error: 'too_many_items' };

  const lines = [];
  let subtotal = 0;

  for (const raw of order.items) {
    if (!raw || typeof raw.name !== 'string') return { error: 'bad_item' };

    const qty = Math.max(1, Math.min(MAX_QTY, parseInt(raw.qty, 10) || 1));
    const unit = unitPrice(raw, MENU);

    if (unit === null || !isFinite(unit) || unit < 0) {
      return { error: 'unknown_item', item: raw.name };
    }

    const mods = Array.isArray(raw.mods) ? raw.mods.map(String).slice(0, 12) : [];
    const addons = Array.isArray(raw.addons) ? raw.addons.map(String).slice(0, 6) : [];
    const desc = mods.concat(addons).join(' · ').slice(0, 300);

    lines.push({
      name: raw.name.slice(0, 120),
      desc,
      unit: round2(unit),
      qty
    });
    subtotal += round2(unit) * qty;
  }

  subtotal = round2(subtotal);

  const dset = deliverySettings(CONFIG, opts);
  const isDelivery = order.orderType === 'delivery' && dset.enabled;
  const delivery = isDelivery ? dset.fee : 0;
  const tax = round2((subtotal + delivery) * CONFIG.taxRate);

  /* Tip — accept a flat dollar amount (tipAmount) OR a percentage rate
     (tipRate); a flat amount wins when present. Either way the server
     recomputes it from the real subtotal and caps it, so a tampered tip can
     never exceed 50% of the bill. */
  let tipRate = Number(order.tipRate);
  if (!isFinite(tipRate) || tipRate < 0) tipRate = 0;
  tipRate = Math.min(tipRate, MAX_TIP_RATE);

  let flatTip = Number(order.tipAmount);
  if (!isFinite(flatTip) || flatTip < 0) flatTip = 0;
  flatTip = round2(flatTip);
  const tipCap = round2(subtotal * MAX_TIP_RATE);
  flatTip = Math.min(flatTip, tipCap);

  let tip, effectiveRate;
  if (flatTip > 0) {
    tip = flatTip;
    effectiveRate = subtotal > 0 ? round2(flatTip / subtotal) : 0;
  } else {
    tip = round2(subtotal * tipRate);
    effectiveRate = tipRate;
  }

  const total = round2(subtotal + delivery + tax + tip);

  return { lines, subtotal, delivery, tax, tip, tipRate: effectiveRate, tipAmount: tip, total };
}

/* -------------------------------------------------------------------------- */
/* Discounts                                                                   */
/* --------------------------------------------------------------------------
   Three shapes, all resolved HERE so the browser can never decide the price:

     percent   value = 10  → 10% off the subtotal
     amount    value = 5   → $5 off the subtotal
     freeship  value ignored → the delivery fee is waived

   Sales tax is charged on the DISCOUNTED amount, which is how a
   merchant-funded discount works: the guest pays tax on what they actually
   pay, not on the crossed-out price. The tip is left exactly as the guest
   chose it — it is their money to give, not ours to shrink.

   `subtotal` and `delivery` stay GROSS. The discount is a separate
   `discountAmount`, so the kitchen ticket can show the menu price, the
   discount, and the collected total. Only tax and total are net.
   -------------------------------------------------------------------------- */

/* How much money comes off, before any tax recomputation. Never more than
   there is to discount — a $5 code on a $3 order takes off $3, not $5, and a
   "free shipping" code on a pickup order takes off nothing. */
function discountAmountFor(priced, discount) {
  if (!priced || priced.error || !discount) return 0;

  const type = String(discount.type || '');
  const value = Number(discount.value);

  if (type === 'percent') {
    if (!isFinite(value) || value <= 0) return 0;
    const pct = Math.min(value, MAX_DISCOUNT_PERCENT);
    return Math.min(round2(priced.subtotal * pct / 100), priced.subtotal);
  }

  if (type === 'amount') {
    if (!isFinite(value) || value <= 0) return 0;
    return Math.min(round2(value), priced.subtotal);
  }

  if (type === 'freeship') {
    return round2(priced.delivery || 0);
  }

  /* Unknown shape → no discount. Guessing here would be worse than nothing:
     the same request would price differently on two servers. */
  return 0;
}

/* Re-price an order with a discount applied. Returns the same shape as
   priceOrder plus `discountAmount` / `discount`. Pure, and safe to call with
   a null discount — it then returns `priced` unchanged. */
function applyDiscount(priced, discount, CONFIG) {
  if (!priced || priced.error) return priced;

  const amount = discountAmountFor(priced, discount);
  if (amount <= 0) return priced;

  /* Everything tax is charged on: the order, minus what we gave away. */
  const netBase = round2(priced.subtotal + priced.delivery - amount);
  const tax = round2(netBase * CONFIG.taxRate);
  const total = round2(netBase + tax + priced.tip);

  return Object.assign({}, priced, {
    tax,
    total,
    discountAmount: amount,
    discount: {
      type: String(discount.type),
      value: Number(discount.value) || 0,
      code: discount.code ? String(discount.code) : '',
      /* Free text for the ticket and the board ("Points redeemed (200)",
         "$10 reward"). A loyalty give-away and an owner's code can both be a
         plain dollar amount, and the guest deserves to see which one it was. */
      label: discount.label ? String(discount.label).slice(0, 60) : '',
      /* Four sources, never guessed: an owner's code, a staff discount, a
         loyalty reward, or a monthly member perk. Anything unrecognised is
         treated as a code — an unknown source on a money-off object is not
         something to be generous about. */
      source: (discount.source === 'staff' || discount.source === 'loyalty' || discount.source === 'member')
        ? discount.source : 'code',
      amount
    }
  });
}

/* Turn a priced order into Stripe Checkout line items.

   Line amounts stay GROSS and the discount is applied separately as a Stripe
   coupon (see createStripeSession). That is not a style choice: Stripe
   REJECTS a negative `unit_amount` with "Invalid non-negative integer", so a
   "-$1.38" line cannot be sent. Because `tax` here is already the discounted
   figure, the session total still lands on the right number:

       subtotal + delivery + tax(net) + tip − coupon = total                  */
function toStripeLineItems(priced, currency) {
  const out = priced.lines.map((l) => ({
    name: l.name,
    desc: l.desc,
    unit_amount: Math.round(l.unit * 100),
    quantity: l.qty
  }));

  /* `delivery` stays GROSS, so a member who waived the fee with a freeship
     discount still sees the real price crossed out on the ticket and in
     Stripe. The coupon that follows subtracts it. */
  if (priced.delivery > 0) {
    out.push({ name: 'Delivery', desc: '', unit_amount: Math.round(priced.delivery * 100), quantity: 1 });
  }
  if (priced.tax > 0) {
    out.push({ name: 'Sales tax', desc: '', unit_amount: Math.round(priced.tax * 100), quantity: 1 });
  }
  if (priced.tip > 0) {
    out.push({
      name: 'Tip',
      desc: 'Thank you!',
      unit_amount: Math.round(priced.tip * 100),
      quantity: 1
    });
  }

  // Stripe rejects a zero-amount line item
  return out.filter((l) => l.unit_amount > 0);
}

module.exports = {
  round2, loadAssets, unitPrice, priceOrder, toStripeLineItems,
  discountAmountFor, applyDiscount, MAX_DISCOUNT_PERCENT
};
