/* ==========================================================================
   KPOT To Go — Ordering app
   Vanilla JS, no build step, no dependencies (except qrcode.min.js for tickets).
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const money = (n) => CONFIG.currencySymbol + Number(n || 0).toFixed(2);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const LS_CART = 'kpot.cart.v1';
  const LS_LAST = 'kpot.last.v1';
  const LS_SEQ = 'kpot.seq.v1';
  /* Written just before we hand the guest to Stripe, read back when Stripe
     returns them to ?paid=1 so we can print the ticket without a server call. */
  const LS_PENDING = 'kpot.pending.v1';
  /* The guest's own order history, kept on THIS device only. */
  const LS_HISTORY = 'kpot.history.v1';
  /* The membership credential for this browser: { token, phone, name }.
     Minted by the server when this browser's first order is paid for, and the
     ONLY thing that lets this browser spend a guest's rewards — a phone number
     on its own deliberately buys nothing (see customers.js). It is scoped to
     one phone number: a credential held for one account is never sent with
     another, or a shared tablet would leak rewards between guests. */
  const LS_DEVICE = 'kpot.device.v1';

  const state = {
    cat: 'hotpot',
    /* Dine-In is the default channel. It is also first in CONFIG.orderTypes,
       which matters: resolveOrderType() falls back to the first AVAILABLE type,
       so the two must agree or a guest whose dine-in is switched off would be
       moved to something other than the leading card. */
    orderType: 'dinein',
    table: '',
    cart: [],
    /* Tip model.  tipMode = 'none' | 'amt' | 'custom'
       tipAmount = the tip in dollars (flat presets and the guest-typed custom
       amount both live here). The server re-checks it against the real bill, so
       a tampered tip can never exceed 50% of the subtotal. */
    tipMode: 'none',
    tipAmount: 0,
    /* Discount code. The code itself is only ever VALIDATED by the server —
       /api/price tells us what it is worth and we adopt that number. Nothing
       here decides money; this is display state plus what to re-send. */
    couponInput: '',
    discountAmount: 0,
    discountCode: '',
    /* The server's own description of whatever came off — "Points redeemed
       (200)", "$10 reward", or an owner's code. Shown instead of the raw code
       so a guest can see WHICH kind of give-away it was. */
    discountLabel: '',
    discountSource: '',
    couponMsg: '',
    couponState: '',   // '' | 'ok' | 'err' | 'busy'
    /* Rewards. `loyalty` is the SERVER's answer for the phone the guest typed
       — points balance, usable coupons, progress to the next stamp reward —
       and `loyaltyChoice` is what they picked to spend on this bill. Like the
       discount code, this page never decides an amount: it asks /api/price
       and adopts the number that comes back. */
    loyalty: null,
    loyaltyPhone: '',
    loyaltyChoice: '',   // '' | 'points' | '<couponId>'
    loyaltyState: '',    // '' | 'busy' | 'ok' | 'err'
    loyaltyMsg: '',
    payMethod: 'counter',
    /* Whether the guest has picked a payment method THEMSELVES. Until they do,
       checkout pre-selects an online method (see defaultPayMethod) so the
       common case is prepaid; once they choose, we stop overriding them. */
    payChosen: false,
    customer: { name: '', phone: '', email: '', notes: '' },
    order: null,
    sheet: null,
    /* null = not probed yet. true when /api/health reports a working checkout
       endpoint, which means this copy is running behind the Node server. */
    backend: null,
    /* Mirrors the owner's live board: whether the store is open and whether it
       is currently accepting orders. Defaults to true so a static host (no
       server to ask) never blocks ordering. */
    storeOpen: true,
    acceptingOrders: true,
    /* Per-channel switches from the owner's board. `null` = not heard from the
       server yet; treat every channel as available until told otherwise, so a
       static deploy (or a failed fetch) never hides the whole menu. */
    orderTypes: null,
    /* Windowed delivery picker. schedule = { date, slot, slotLabel }
       for the delivery being booked; the server is the gate. */
    schedule: null,
    scheduleDate: '',
    scheduleDays: [],
    scheduleSlots: [],
    scheduleFee: 0,
    scheduleState: '',
    scheduleMsg: '',
    /* Live delivery-distance check (the 2-mile rule, measured by the server).
       status: '' (nothing typed yet) | 'busy' | 'ok' | 'blocked' | 'unknown'
       | 'err'. The server enforces the rule regardless; this only lets the
       guest find out BEFORE paying. */
    deliveryGeo: { status: '', miles: null, msg: '', source: '' },
    geoTimer: 0
  };

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */
  function saveCart() {
    try { localStorage.setItem(LS_CART, JSON.stringify(state.cart)); } catch (e) {}
  }
  function loadCart() {
    try {
      const raw = localStorage.getItem(LS_CART);
      if (raw) state.cart = JSON.parse(raw) || [];
    } catch (e) { state.cart = []; }
  }

  /* ------------------------------------------------------------------ */
  /* Pricing — every component is rounded to cents BEFORE summing, so the
     numbers shown on the receipt always add up to the total shown.      */
  /* ------------------------------------------------------------------ */
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  function cartSubtotal() {
    return round2(state.cart.reduce((s, it) => s + it.unit * it.qty, 0));
  }
  /* Runtime delivery channel gate. Prefers the owner's live board
     (state.orderTypes), falling back to the static config seed before the
     server answers. Only an explicit `false` switches delivery off. */
  function deliveryOn() {
    if (state.orderTypes && typeof state.orderTypes.delivery === 'boolean') {
      return state.orderTypes.delivery;
    }
    return (CONFIG.delivery || {}).enabled !== false;
  }
  function deliveryFee() {
    if (state.orderType !== 'delivery' || !deliveryOn()) return 0;
    const d = CONFIG.delivery || {};
    return Number(d.fee) || 0;
  }
  /* The crossed-out "was" price shown next to a FREE delivery. Display only —
     the bill uses deliveryFee(), which is the real charge. */
  function deliveryFeeWas() {
    if (state.orderType !== 'delivery' || !deliveryOn()) return 0;
    const n = Number((CONFIG.delivery || {}).listFee);
    return isFinite(n) && n > 0 ? n : 0;
  }
  /* ONE renderer for the delivery line. The cart and the checkout used to
     build this row separately and drifted; a free delivery is exactly the
     case where the two would disagree about whether to show the row at all. */
  function deliveryRowHTML() {
    if (state.orderType !== 'delivery' || !deliveryOn()) return '';
    const fee = deliveryFee();
    if (fee > 0) {
      return '<div class="trow"><span>Delivery</span><b>' + money(fee) + '</b></div>';
    }
    /* Free — and the row STAYS, because the saving is the message. The old
       price is struck through when one is configured. */
    const was = deliveryFeeWas();
    return '<div class="trow"><span>Delivery</span><b class="free">' +
      (was > 0 ? '<s>' + money(was) + '</s> ' : '') + 'FREE</b></div>';
  }

  /* ---- Windowed delivery picker ----------------------------------------
     The server owns the vocabulary: selectable dates, per-slot capacity,
     which slots fall inside opening hours. The guest picks a date then a
     slot; we send schedule:{date,slot} and the server is the gate. */
  function schedulePayload() {
    if (state.orderType !== 'delivery') return null;
    const s = state.schedule;
    return s && s.date && s.slot ? { date: s.date, slot: s.slot } : null;
  }
  function loadSchedule() {
    if (state.orderType !== 'delivery') return Promise.resolve(null);
    state.scheduleState = 'busy';
    renderScheduleBox();
    return fetch('/api/schedule')
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        state.scheduleDays = Array.isArray(j.days) ? j.days : [];
        state.scheduleFee = Number(j.fee) || 0;
        state.scheduleState = 'ok';
        renderScheduleBox();
        return j;
      })
      .catch(() => {
        state.scheduleState = 'err';
        state.scheduleMsg = 'Could not load delivery times.';
        renderScheduleBox();
        return null;
      });
  }
  function loadScheduleDate(iso) {
    /* A slot id means a different thing on a different day, so a selection made
       on the old date must not carry over. Without this the slot chip for
       "1:00 PM" stayed lit on the NEW day (the id matches) while state.schedule
       still said the OLD date — the guest reads one thing and the kitchen gets
       another. Re-picking the same day keeps the choice. */
    if (state.schedule && state.schedule.date !== iso) state.schedule = null;
    state.scheduleDate = iso;
    state.scheduleSlots = [];
    state.scheduleState = 'busy';
    renderScheduleBox();
    return fetch('/api/schedule?date=' + encodeURIComponent(iso))
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        state.scheduleSlots = Array.isArray(j.slots) ? j.slots : [];
        state.scheduleState = 'ok';
        renderScheduleBox();
      })
      .catch(() => {
        state.scheduleState = 'err';
        state.scheduleMsg = 'Could not load times for that date.';
        renderScheduleBox();
      });
  }
  /* ---- Delivery-day labels ---------------------------------------------
     The server sends `weekday` as a NUMBER, and Sunday is 0. The old chip
     read `d.weekday || d.iso`, so Sunday — the one day whose number is falsy
     — printed the raw ISO date instead of a day name, and every other chip
     printed a bare digit ("6") that means nothing to a guest standing at the
     counter. Derive the name explicitly; never fall back to a number. */
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function weekdayName(iso, weekday) {
    const n = Number(weekday);
    if (Number.isInteger(n) && n >= 0 && n <= 6) return WEEKDAYS[n];
    /* No usable number: read the day off the ISO string as UTC. Parsing it as
       LOCAL time would let the browser's timezone move the date a day, and the
       guest is not necessarily in the shop's timezone. */
    const t = Date.parse(String(iso || '') + 'T00:00:00Z');
    return isFinite(t) ? WEEKDAYS[new Date(t).getUTCDay()] : '';
  }
  function monthDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? (Number(m[2]) + '/' + Number(m[3])) : String(iso || '');
  }
  function fullDayLabel(d) {
    const wd = weekdayName(d && d.iso, d && d.weekday);
    const md = monthDay(d && d.iso);
    const ahead = Number(d && d.daysAhead);
    const rel = ahead === 1 ? ' (tomorrow)' : (ahead === 0 ? ' (today)' : '');
    return (wd ? wd + ' ' : '') + md + rel;
  }

  function renderScheduleBox() {
    const box = $('#scheduleBox');
    if (!box) return;
    if (state.orderType !== 'delivery') { box.innerHTML = ''; return; }
    if (state.scheduleState === 'busy') {
      box.innerHTML = '<div class="loy"><div class="section-label">Delivery Time</div>' +
        '<div class="small dim">Loading delivery times...</div></div>';
      return;
    }
    if (state.scheduleState === 'err') {
      box.innerHTML = '<div class="loy"><div class="section-label">Delivery Time</div>' +
        '<div class="small err">' + esc(state.scheduleMsg || 'Could not load delivery times.') + '</div></div>';
      return;
    }
    const days = state.scheduleDays || [];
    const dateChips = days.map((d) =>
      '<button class="sch-date' + (state.scheduleDate === d.iso ? ' on' : '') + '" type="button"' +
        ' data-sch-date="' + esc(d.iso) + '" title="' + esc(fullDayLabel(d)) + '"' +
        ' aria-label="' + esc(fullDayLabel(d)) + '">' +
        '<span>' + esc(weekdayName(d.iso, d.weekday)) + '</span>' +
        '<small>' + esc(monthDay(d.iso)) + '</small>' +
      '</button>').join('');
    const slots = (state.scheduleSlots || []).map((s) => {
      const on = state.schedule && state.schedule.slot === s.id;
      const dis = s.full || s.outsideHours;
      const note = s.full ? 'Full' : (s.outsideHours ? 'Outside hours' : (s.remaining + ' left'));
      return '<button class="sch-slot' + (on ? ' on' : '') + '" type="button" data-sch-slot="' + esc(s.id) + '"' +
        (dis ? ' disabled aria-disabled="true"' : '') + '>' +
        '<span>' + esc(s.label) + '</span><small>' + esc(note) + '</small>' +
      '</button>';
    }).join('');
    /* Two labelled steps, because the guest has to make two choices and the
       old single "Delivery Time" heading sat above a row of days. */
    const slotBlock = state.scheduleDate
      ? '<div class="section-label" style="margin-top:12px">Delivery Time' +
        (state.scheduleFee ? ' · ' + money(state.scheduleFee) : '') + '</div>' +
        (slots
          ? '<div class="sch-slots">' + slots + '</div>'
          : '<div class="small dim">No times left for this day.</div>')
      : '';
    /* Say the choice back to the guest. A red outline on a small chip is easy
       to miss, and "did I actually pick a time?" is a counter conversation. */
    const picked = state.schedule
      ? '<div class="small ok" style="margin-top:8px">Delivering ' +
        esc(state.schedule.slotLabel || '') + ' on ' + esc(monthDay(state.schedule.date)) + '</div>'
      : '';
    box.innerHTML = '<div class="loy">' +
      '<div class="section-label">Delivery Date</div>' +
      (dateChips
        ? '<div class="sch-dates">' + dateChips + '</div>'
        : '<div class="small dim">No delivery dates available.</div>') +
      slotBlock +
      picked +
      (state.scheduleMsg ? '<div class="small err" style="margin-top:6px">' + esc(state.scheduleMsg) + '</div>' : '') +
    '</div>';
  }
  /* Delegated, and bound ONCE per box element.
     renderScheduleBox() replaces the box's innerHTML, which throws away any
     onclick attached to the chips — and openCheckout() re-renders immediately
     after binding (loadSchedule(), then loadScheduleDate(), each render
     again), so the per-chip handlers were already gone before the guest could
     tap anything. The symptom is a picker that looks perfect and does nothing.
     One listener on the container survives every re-render. */
  function bindScheduleBox() {
    const box = $('#scheduleBox');
    if (!box || box.dataset.schBound === '1') return;
    box.dataset.schBound = '1';
    box.addEventListener('click', (ev) => {
      const hit = ev.target && ev.target.closest
        ? ev.target.closest('[data-sch-date],[data-sch-slot]') : null;
      if (!hit || hit.disabled) return;
      const iso = hit.dataset.schDate;
      if (iso) { loadScheduleDate(iso); return; }
      const slot = (state.scheduleSlots || []).find((s) => s.id === hit.dataset.schSlot);
      if (!slot) return;
      state.schedule = { date: state.scheduleDate, slot: slot.id, slotLabel: slot.label };
      state.scheduleMsg = '';
      renderScheduleBox();
    });
  }
  /* ---- Live delivery-distance check --------------------------------------
     The 2-mile rule lives on the server (geo.js) and is enforced there. This
     only moves the answer earlier: the guest typing an address outside the
     radius is told while they type, with a one-tap way out to Pickup, instead
     of discovering it after the payment page. Advisory by design — a browser
     answer can be skipped (stale tab, hand-built request); the server's
     cannot. */
  function scheduleGeoCheck(now) {
    if (state.geoTimer) { clearTimeout(state.geoTimer); state.geoTimer = 0; }
    if (now) return checkDeliveryGeo();
    state.geoTimer = setTimeout(checkDeliveryGeo, 550);
  }
  function checkDeliveryGeo() {
    state.geoTimer = 0;
    const input = $('#cWhen');
    const addr = input ? input.value.trim() : '';
    if (state.orderType !== 'delivery' || addr.length < 8) {
      /* Too short to be an address — this is pickup-time / table-number
         territory, and the box only ever applies to Delivery. */
      state.deliveryGeo = { status: '', miles: null, msg: '', source: '' };
      renderGeoBox();
      return;
    }
    state.deliveryGeo = { status: 'busy', miles: null, msg: '', source: '' };
    renderGeoBox();
    fetch('/api/delivery/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr })
    })
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        /* The address may have changed while the request was in flight — a
           stale answer shown against the new text is worse than no answer. */
        const cur = $('#cWhen');
        if (cur && cur.value.trim() !== addr) return;
        state.deliveryGeo = {
          status: (j && j.status) || 'err',
          miles: (j && typeof j.miles === 'number') ? j.miles : null,
          msg: (j && j.message) || '',
          source: (j && j.source) || ''
        };
        renderGeoBox();
      })
      .catch(() => { /* unreachable: the server still enforces — stay quiet */ });
  }
  function renderGeoBox() {
    const box = $('#geoBox');
    if (!box) return;
    if (state.orderType !== 'delivery') { box.innerHTML = ''; return; }
    const g = state.deliveryGeo;
    if (!g.status) { box.innerHTML = ''; return; }
    if (g.status === 'busy') {
      box.innerHTML = '<div class="geo"><div class="small dim">Checking delivery distance...</div></div>';
      return;
    }
    if (g.status === 'blocked') {
      box.innerHTML = '<div class="geo"><div class="geo-in">' +
        '<div class="small err">' +
          esc(g.msg || 'That address is outside our 2-mile delivery area. Please choose Pickup or Dine-In.') +
        '</div>' +
        '<button class="btn btn-sm" type="button" data-geo-pickup style="margin-top:9px">Switch to Pickup</button>' +
        '</div></div>';
      /* Place Order must not offer a delivery the server will refuse. */
      const po = $('#placeOrder');
      if (po) { po.disabled = true; po.setAttribute('aria-disabled', 'true'); }
      return;
    }
    if (g.status === 'ok') {
      const near = (g.source === 'street' && g.miles !== null)
        ? ' (' + g.miles.toFixed(1) + ' mi from us)' : '';
      box.innerHTML = '<div class="geo"><div class="small ok">Within our delivery area' + near + '</div></div>';
      return;
    }
    if (g.status === 'unknown') {
      box.innerHTML = '<div class="geo"><div class="small dim">' +
        esc(g.msg || 'We could not verify that address automatically — we deliver within 2 miles of the store.') +
        '</div></div>';
      return;
    }
    /* 'err' — the check itself failed. Silent: no evidence either way, and the
       server gate still holds the line at Place Order. */
    box.innerHTML = '';
  }
  /* Delegated, bound once per element, exactly like the schedule box above:
     renderGeoBox() replaces innerHTML, and a per-render onclick would be
     thrown away by the next render before the guest could tap it. */
  function bindGeoBox() {
    const box = $('#geoBox');
    if (!box || box.dataset.geoBound === '1') return;
    box.dataset.geoBound = '1';
    box.addEventListener('click', (ev) => {
      const hit = ev.target && ev.target.closest
        ? ev.target.closest('[data-geo-pickup]') : null;
      if (!hit) return;
      /* Do what the guest's own tap on the Pickup card would do — through the
         SAME delegated handler, so the availability check, the shell re-render
         and the checkout reopening all happen exactly once, in their usual
         order. Re-implementing the switch here would be a second copy of that
         logic to keep in sync. */
      const card = document.querySelector('#otGrid .ot-card[data-ot="pickup"]');
      if (card) card.click();
    });
  }
  /* What the discount comes off, i.e. everything tax is charged on. Mirrors
     pricing.js: the discount is taken off BEFORE tax, so the guest pays tax on
     what they actually pay. */
  function discountAmount() {
    return round2(state.discountAmount || 0);
  }
  function netBase() {
    return round2(cartSubtotal() + deliveryFee() - discountAmount());
  }
  function taxAmount() {
    return round2(netBase() * CONFIG.taxRate);
  }
  function tipAmount() {
    return round2(state.tipAmount || 0);
  }
  function surcharge() {
    if (state.payMethod !== 'stripe') return 0;
    return round2((netBase() + taxAmount()) * (CONFIG.cardSurchargeRate || 0));
  }
  function grandTotal() {
    return round2(netBase() + taxAmount() + tipAmount() + surcharge());
  }
  function cartCount() {
    return state.cart.reduce((s, it) => s + it.qty, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Cart operations                                                     */
  /* ------------------------------------------------------------------ */
  /* srcEl is the button the guest actually tapped, when there is one: it gets
     the green "added" flash. Callers that add several lines at once (the drink
     groups) flash their own submit button instead of nothing at all. */
  function addToCart(item, srcEl) {
    const blk = ordersBlocked();
    if (blk.blocked) { toast('We are not accepting orders right now.', 'err'); return; }
    const sig = JSON.stringify([item.name, item.mods || [], item.addons || [], item.note || '']);
    const found = state.cart.find((c) => c.sig === sig);
    if (found) found.qty += item.qty || 1;
    else state.cart.push(Object.assign({ uid: uid(), qty: 1, mods: [], addons: [], note: '' }, item, { sig }));
    saveCart();
    syncCartUI();
    revalidateCoupon();
    toast('Added · ' + item.name, 'ok');
    if (srcEl) flashAdded(srcEl, 'Added');
  }
  function setQty(uidv, d) {
    const it = state.cart.find((c) => c.uid === uidv);
    if (!it) return;
    it.qty += d;
    if (it.qty <= 0) state.cart = state.cart.filter((c) => c.uid !== uidv);
    saveCart();
    syncCartUI();
    revalidateCoupon();
    renderCartSheet();
  }
  function removeItem(uidv) {
    state.cart = state.cart.filter((c) => c.uid !== uidv);
    saveCart();
    syncCartUI();
    revalidateCoupon();
    renderCartSheet();
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg, kind) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = (kind === 'ok' ? '✅ ' : kind === 'err' ? '⚠️ ' : '') + esc(msg);
    wrap.appendChild(el);
    setTimeout(() => { el.style.transition = '.3s'; el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; }, 1900);
    setTimeout(() => el.remove(), 2300);
    if (CONFIG.features.sounds && kind === 'ok') chime();
  }

  /* ------------------------------------------------------------------ */
  /* Button feedback                                                     */
  /* ------------------------------------------------------------------ */
  /* Why these exist: a tap that changes nothing on screen reads as a
     broken button, and a submit button that stays live while the server is
     still deciding the order number is how one guest ends up with two
     orders. Both are fixed with movement, not words. */
  let fxLastCount = -1, fxBarOn = false;

  function fxCheck() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px">' +
      '<path d="M20 6L9 17l-5-5"/></svg>';
  }

  /* Green + check + a small pop, then the button puts itself back. The width
     is pinned while it runs so the row does not jump when the label changes,
     and dataset.fxBusy doubles as a tap lock: a second click inside the
     window is ignored, which also stops an accidental double-add. */
  function flashAdded(btn, label) {
    if (!btn || btn.dataset.fxBusy) return;
    btn.dataset.fxBusy = '1';
    const old = btn.innerHTML;
    btn.style.minWidth = btn.offsetWidth + 'px';
    btn.style.background = 'var(--green)';
    btn.style.color = '#06281A';
    btn.classList.add('fx-pop');
    btn.innerHTML = fxCheck() + esc(label || 'Added');
    setTimeout(() => {
      btn.classList.remove('fx-pop');
      btn.innerHTML = old;
      btn.style.background = '';
      btn.style.color = '';
      btn.style.minWidth = '';
      delete btn.dataset.fxBusy;
    }, 950);
  }

  /* Submit button goes busy: spinner, new label, taps ignored. Everything
     that can leave placeOrder() calls btnRestore() so the button never gets
     stuck disabled after a refusal or a network error. */
  function btnBusy(btn, label) {
    if (!btn || btn.dataset.fxBusy) return;
    btn.dataset.fxBusy = '1';
    btn.dataset.fxHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('fx-busy');
    btn.innerHTML = '<span class="fx-spin"></span>' + esc(label || 'Working…');
  }
  function btnRestore(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('fx-busy');
    if (btn.dataset.fxHtml != null) { btn.innerHTML = btn.dataset.fxHtml; delete btn.dataset.fxHtml; }
    delete btn.dataset.fxBusy;
  }

  /* Cart icon badge: wait for the entry spring to land, THEN bounce — both
     animate the same transform and the bounce would otherwise swallow the
     badge's own scale(0) → scale(1) entrance. */
  function fxBump(el) {
    if (!el) return;
    setTimeout(() => {
      el.classList.remove('fx-bump'); void el.offsetWidth; el.classList.add('fx-bump');
      el.addEventListener('animationend', () => el.classList.remove('fx-bump'), { once: true });
    }, 240);
  }
  function fxAttn(el) {
    if (!el) return;
    el.classList.remove('fx-attn'); void el.offsetWidth; el.classList.add('fx-attn');
    el.addEventListener('animationend', () => el.classList.remove('fx-attn'), { once: true });
  }
  let audioCtx = null;
  function chime() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.start(t); o.stop(t + 0.24);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Sheet                                                               */
  /* ------------------------------------------------------------------ */
  /* opts.keepScroll — the sheet body is a brand-new element every time, so its
     scroll position resets to the top. Builders re-render on every tap (to
     update chips, counters and totals); without this the guest would be yanked
     back to step 1 after each pick. Passing keepScroll restores where they were. */
  function openSheet(title, bodyHTML, footHTML, opts) {
    opts = opts || {};
    const sheet = $('#sheet');
    const wasOpen = sheet.classList.contains('on') && sheet.querySelector('.sheet-body');
    const prevScroll = wasOpen ? sheet.querySelector('.sheet-body').scrollTop : 0;

    sheet.innerHTML =
      '<div class="sheet-grip"><i></i></div>' +
      '<div class="sheet-head">' +
        '<div style="flex:1"><h3>' + title + '</h3>' +
        (opts.sub ? '<div class="small dim" style="margin-top:3px">' + opts.sub + '</div>' : '') +
        '</div>' +
        '<button class="close" data-close="1" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="sheet-body" id="sheetBody">' + bodyHTML + '</div>' +
      (footHTML ? '<div class="sheet-foot" id="sheetFoot">' + footHTML + '</div>' : '');
    $('#backdrop').classList.add('on');
    sheet.classList.add('on');
    document.body.style.overflow = 'hidden';
    sheet.querySelector('.sheet-body').scrollTop = opts.keepScroll ? prevScroll : 0;
  }
  function closeSheet() {
    $('#sheet').classList.remove('on');
    $('#backdrop').classList.remove('on');
    document.body.style.overflow = '';
    state.sheet = null;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.id === 'backdrop') closeSheet();
  });

  /* ------------------------------------------------------------------ */
  /* Opening hours — SAME-DAY service only.                               */
  /* The store opens at noon and closes in the afternoon, so "open now"   */
  /* is a simple window test on today's clock. The `closeAt < openMinute` */
  /* branch below keeps a past-midnight schedule working too, in case the */
  /* hours are ever changed back to a late-night service.                 */
  /* ------------------------------------------------------------------ */
  function fmtMin(m) {
    const h24 = Math.floor(m / 60) % 24, mm = m % 60;
    const ap = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return h12 + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }
  function storeOpenState() {
    const spec = CONFIG.store.hoursSpec;
    if (!spec) return { open: true, label: 'Kitchen open now' };
    const now = new Date();
    const day = now.getDay();                     // 0 = Sunday
    const mins = now.getHours() * 60 + now.getMinutes();
    const closeFor = (d) => (d === 5 || d === 6) ? spec.closeFriSat : spec.closeSunThu;

    const todayOpen = spec.openMinute;
    const todayClose = closeFor(day);

    /* Normal same-day window, e.g. 12:00 PM – 4:30 PM. */
    if (todayClose >= todayOpen) {
      return (mins >= todayOpen && mins < todayClose)
        ? { open: true, label: 'Open now · closes ' + fmtMin(todayClose) }
        : { open: false, label: 'Closed · opens ' + fmtMin(todayOpen) };
    }

    /* Past-midnight window, e.g. 12:00 PM – 1:30 AM. Either we are still
       inside today's service, or we are in the small hours of yesterday's. */
    if (mins >= todayOpen) {
      return { open: true, label: 'Open now · closes ' + fmtMin(todayClose) };
    }
    const y = (day + 6) % 7;                      // yesterday
    const closeAt = closeFor(y);
    return mins < closeAt
      ? { open: true, label: 'Open now · closes ' + fmtMin(closeAt) }
      : { open: false, label: 'Closed · opens ' + fmtMin(todayOpen) };
  }

  /* ------------------------------------------------------------------ */
  /* Top bar + hero                                                      */
  /* ------------------------------------------------------------------ */
  function renderShell() {
    $('#storeName').textContent = CONFIG.store.name;
    $('#storeTag').textContent = 'Order & Pay · ' + (CONFIG.orderTypes.find(o => o.id === state.orderType) || {}).n;

    const st = storeOpenState();
    const badge = $('#openBadge');
    if (badge) {
      badge.textContent = st.label;
      badge.classList.toggle('live', st.open);
      badge.classList.toggle('closed', !st.open);
    }

    // order type cards — a channel the owner switched off is shown, but
    // dimmed and marked, so the guest understands why they cannot pick it.
    const grid = $('#otGrid');
    const shown = CONFIG.orderTypes.filter((o) => o.id !== 'delivery' || deliveryOn());
    /* Only mark a card as chosen if it is actually choosable. When every
       channel is off, resolveOrderType() has nothing to offer and state keeps
       its old value — which would draw a red "selected" ring around a card
       that is struck through and unclickable. */
    const chosen = resolveOrderType();
    grid.innerHTML = shown
      .map((o) => {
        const off = !orderTypeAvailable(o.id);
        const on = !off && o.id === chosen;
        return '<button class="ot-card ' + (on ? 'on' : '') + (off ? ' off' : '') + '"' +
          ' data-ot="' + o.id + '"' + (off ? ' disabled aria-disabled="true"' : '') + '>' +
          '<span class="ic">' + o.icon + '</span><b>' + esc(o.n) + '</b>' +
          '<small>' + (off ? 'Not available right now' : esc(o.d)) + '</small>' +
        '</button>';
      }).join('');
    grid.style.gridTemplateColumns = 'repeat(' + Math.max(1, grid.children.length) + ',1fr)';

    $('#tableWrap').classList.toggle('on', state.orderType === 'dinein' && CONFIG.features.qrTableNumbers);
    if (state.table) $('#tableNo').value = state.table;

    // tabs
    $('#tabs').innerHTML = CATEGORIES.map((c) =>
      '<button class="tab ' + (state.cat === c.id ? 'on' : '') + '" data-cat="' + c.id + '">' + esc(c.n) + '</button>').join('');

    renderStoreFooter();
  }

  /* Store address / phone / hours at the bottom of the menu, with tap-to-call
     and a map link — guests can reach the restaurant without leaving the page. */
  function renderStoreFooter() {
    const s = CONFIG.store;
    const el = $('#siteFoot');
    if (!el) return;
    el.innerHTML =
      '<div class="sf-brand"><span class="logo-k" style="width:30px;height:30px;font-size:16px">K</span>' +
        '<b>' + esc(s.name) + '</b></div>' +
      '<a class="sf-row" target="_blank" rel="noopener" href="https://maps.google.com/?q=' +
        encodeURIComponent(s.addressQuery || s.address) + '">' +
        '<span class="sf-ic">📍</span><span>' + esc(s.address) + '</span></a>' +
      '<a class="sf-row" href="tel:' + esc(s.phoneRaw || s.phone) + '">' +
        '<span class="sf-ic">📞</span><span>' + esc(s.phone) + '</span></a>' +
      '<div class="sf-row"><span class="sf-ic">🕐</span><span>' + esc(s.hours) + '</span></div>' +
      (s.hoursSpec && s.hoursSpec.lastSeatingNote
        ? '<div class="sf-row"><span class="sf-ic">ℹ️</span><span>' + esc(s.hoursSpec.lastSeatingNote) + '</span></div>' : '') +
      '<div class="sf-note">Prices in USD · Sales tax added at checkout · Allergen info available on request</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Menu rendering                                                      */
  /* ------------------------------------------------------------------ */
  function renderMenu() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (state.order) { renderTicket(); return; }
    setOrderView(false);
    const c = state.cat;
    if (c === 'hotpot') renderHotpotPromo();
    else if (c === 'bbq') renderBbqPromo();
    else if (c === 'drinks') renderDrinks();
    else renderSides();
    syncCartUI();
  }

  /* Hide the marketing hero + order-type picker while a ticket is on screen */
  function setOrderView(on) {
    $$('.hero, .ordertype').forEach((el) => el.classList.toggle('hide', on));
  }

  function renderHotpotPromo() {
    const m = MENU.hotpot;
    const pills = m.steps.map((s, i) => '<span class="step-pill"><i>' + (i + 1) + '</i>' + esc(s.title.replace('Choose ', '')) + '</span>').join('');
    $('#menuBody').innerHTML =
      '<div class="cat-head"><div><h2>Hot Pot To Go</h2><div class="sub">Build Your Own Bowl · One Size</div></div>' +
      '<div class="price-tag">' + m.priceLabel + '</div></div>' +
      '<div class="build-card">' +
        '<h3>Build Your Own Bowl</h3>' +
        '<p>Pick your broth, noodle, protein, topping, 3 vegetables and a sauce. We cook it fresh to go.</p>' +
        '<div class="steps-preview">' + pills + '</div>' +
        '<button class="btn btn-primary" data-build="hotpot">Start Building →</button>' +
        '<div class="small dim center" style="margin-top:9px">Add a combo (drink + 2 spring rolls) for ' +
          money(m.addons[0].price) + ' at the end</div>' +
      '</div>' +
      '<div class="section-label">Popular Add-Ons</div>' +
      MENU.sides.groups[0].items.slice(0, 4).map(sideRow).join('');
  }

  function renderBbqPromo() {
    const m = MENU.bbq;
    $('#menuBody').innerHTML =
      '<div class="cat-head"><div><h2>BBQ To Go</h2><div class="sub">BBQ Protein Bowls</div></div>' +
      '<div class="price-tag">from ' + money(m.sizes[0].price) + '</div></div>' +
      '<div class="build-card">' +
        '<h3>BBQ Protein Bowl</h3>' +
        '<p>' + m.sizes.map((s) => s.picks + ' protein' + (s.picks > 1 ? 's' : '') + ' for ' + money(s.price)).join(' · ') + '</p>' +
        '<div class="steps-preview">' +
          '<span class="step-pill"><i>✓</i>White Rice</span>' +
          '<span class="step-pill"><i>✓</i>Kimchi</span>' +
          '<span class="step-pill"><i>✓</i>Grilled Veggies</span>' +
        '</div>' +
        '<button class="btn btn-primary" data-build="bbq">Choose Your Proteins →</button>' +
      '</div>' +
      '<div class="section-label">Proteins</div>' +
      '<div class="chip-grid">' + m.proteins.map((p) =>
        '<div class="chip"><span class="em">' + p.emoji + '</span><span class="tx"><b>' + esc(p.n) + '</b>' +
        (p.spicy ? '<small class="spicy">SPICY</small>' : '') + '</span></div>').join('') + '</div>';
  }

  function renderDrinks() {
    const groups = MENU.drinks.groups;
    $('#menuBody').innerHTML =
      '<div class="cat-head"><div><h2>Drinks</h2><div class="sub">Boba, teas &amp; sodas</div></div></div>' +
      groups.map((g) =>
        '<div class="item-row" data-group="' + g.id + '" style="cursor:pointer">' +
          '<div class="item-thumb">' + groupEmoji(g.id) + '</div>' +
          '<div class="item-main"><b>' + esc(g.n) + '</b>' +
            '<span>' + g.options.length + ' flavors' + (g.note ? ' · ' + esc(g.note) : '') + '</span></div>' +
          '<div class="item-price">' + money(g.price) + '</div>' +
          '<button class="btn btn-primary btn-sm" data-group="' + g.id + '">Choose</button>' +
        '</div>').join('');
  }

  function groupEmoji(id) {
    return { fountain: '🥤', bubbletea: '🧋', fruittea: '🍹', lemonade: '🍋' }[id] || '🥤';
  }

  function sideRow(it) {
    return '<div class="item-row">' +
      '<div class="item-thumb">' + (it.emoji || '🍽️') + '</div>' +
      '<div class="item-main"><b>' + esc(it.n) + '</b></div>' +
      '<div class="item-price">' + money(it.price) + '</div>' +
      '<div class="stepper"><button class="add-btn" data-side="' + esc(it.n) + '">Add</button></div>' +
    '</div>';
  }

  function renderSides() {
    const items = MENU.sides.groups[0].items;
    $('#menuBody').innerHTML =
      '<div class="cat-head"><div><h2>A La Carte</h2><div class="sub">Sides &amp; snacks</div></div></div>' +
      items.map(sideRow).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Simple item sheets (drinks groups, sides)                           */
  /* ------------------------------------------------------------------ */
  function openDrinkGroup(gid) {
    const g = MENU.drinks.groups.find((x) => x.id === gid);
    if (!g) return;
    const tmp = {};
    g.options.forEach((o) => (tmp[o] = 0));

    function body() {
      return g.options.map((o) =>
        '<div class="item-row">' +
          '<div class="item-main"><b>' + esc(o) + '</b></div>' +
          '<div class="stepper">' +
            '<button data-dec="' + esc(o) + '">−</button>' +
            '<span class="qty">' + tmp[o] + '</span>' +
            '<button data-inc="' + esc(o) + '">+</button>' +
          '</div>' +
        '</div>').join('');
    }
    function foot() {
      const n = Object.values(tmp).reduce((a, b) => a + b, 0);
      return '<div class="total"><small>Total</small><b>' + money(n * g.price) + '</b></div>' +
        '<button class="btn btn-primary" id="grpAdd"' + (n ? '' : ' disabled') + '>Add ' + (n || '') + ' to Order</button>';
    }
    function refresh() {
      $('#sheetBody').innerHTML = body();
      $('#sheetFoot').innerHTML = foot();
      bind();
    }
    function bind() {
      $$('#sheetBody [data-inc]').forEach((b) => b.onclick = () => { tmp[b.dataset.inc]++; refresh(); });
      $$('#sheetBody [data-dec]').forEach((b) => b.onclick = () => { tmp[b.dataset.dec] = Math.max(0, tmp[b.dataset.dec] - 1); refresh(); });
      const add = $('#grpAdd');
      if (add) add.onclick = () => {
        if (add.dataset.fxBusy) return;
        Object.entries(tmp).forEach(([o, q]) => {
          if (q > 0) addToCart({ kind: 'simple', name: o, unit: g.price, qty: q, mods: [g.n] });
        });
        /* Hold the sheet open for the length of the green flash — closing it
           instantly would hide the only confirmation the guest gets. */
        flashAdded(add, 'Added');
        setTimeout(closeSheet, 420);
      };
    }

    openSheet(esc(g.n), body(), foot(), { sub: money(g.price) + ' each' });
    bind();
  }

  /* ------------------------------------------------------------------ */
  /* Hot Pot builder                                                     */
  /* ------------------------------------------------------------------ */
  let b = null;
  /* The builder re-renders on every tap, and each render rebuilds the sheet body
     from scratch — which resets its scroll to the top. Without this flag the
     guest would be yanked back to step 1 after every single pick. */
  let builderDrawn = false;

  function openHotpotBuilder() {
    b = { cat: 'hotpot', picks: {}, addons: {}, note: '' };
    MENU.hotpot.steps.forEach((s) => (b.picks[s.id] = []));
    builderDrawn = false;
    renderBuilder();
  }

  function openBbqBuilder() {
    // default to the 2-protein bowl — the most common order
    b = { cat: 'bbq', size: 'pick2', picks: { protein: [] }, addons: {}, note: '' };
    builderDrawn = false;
    renderBuilder();
  }

  function builderUnit() {
    if (b.cat === 'hotpot') return MENU.hotpot.basePrice;
    const s = MENU.bbq.sizes.find((x) => x.id === b.size) || MENU.bbq.sizes[0];
    return s.price;
  }
  function builderAddonsTotal() {
    let t = 0;
    Object.entries(b.addons).forEach(([id, on]) => {
      if (!on) return;
      const list = (b.cat === 'hotpot' ? MENU.hotpot.addons : MENU.bbq.addons) || [];
      const a = list.find((x) => x.id === id);
      if (a) t += a.price;
    });
    return t;
  }
  function builderTotal() { return builderUnit() + builderAddonsTotal(); }

  function stepsFor() {
    if (b.cat === 'hotpot') return MENU.hotpot.steps;
    return [{
      id: 'protein',
      title: 'Choose Your Proteins',
      choose: (MENU.bbq.sizes.find(x => x.id === b.size) || {}).picks || 2,
      items: MENU.bbq.proteins,
      // BBQ lets a guest take the same protein more than once — e.g. 2× Beef Bulgogi.
      allowDuplicates: true
    }];
  }

  function stepSatisfied(step) { return (b.picks[step.id] || []).length === step.choose; }

  /* Steps that allow duplicates store an array with repeats, e.g.
     ['Corn','Corn','Corn']. The kitchen ticket should read "Corn ×3", not
     "Corn, Corn, Corn". */
  function collapseRepeats(list) {
    const grouped = [];
    (list || []).forEach((n) => {
      const g = grouped.find((x) => x.n === n);
      if (g) g.c++; else grouped.push({ n: n, c: 1 });
    });
    return grouped.map((g) => g.n + (g.c > 1 ? ' ×' + g.c : '')).join(', ');
  }

  function renderBuilder() {
    const steps = stepsFor();
    const done = steps.filter(stepSatisfied).length;
    const allDone = done === steps.length;
    const missing = steps.find((s) => !stepSatisfied(s)) || steps[0];

    let body = '';

    if (b.cat === 'bbq') {
      body += '<div class="bstep" style="padding-top:14px">' +
        '<div class="bstep-head"><span class="bstep-num">1</span><b>Bowl Size</b></div>' +
        '<div class="chip-grid">' +
        MENU.bbq.sizes.map((s) =>
          '<button class="chip ' + (b.size === s.id ? 'on' : '') + '" data-size="' + s.id + '">' +
            '<span class="em">' + (s.emoji || '🍖') + '</span>' +
            '<span class="tx"><b>' + esc(s.n) + '</b><small>' + money(s.price) + '</small></span>' +
          '</button>').join('') + '</div>' +
        '<div class="small dim" style="margin-top:10px">Every bowl comes with ' +
          MENU.bbq.comesWith.join(' · ') + '</div>' +
        '<div class="small dim" style="margin-top:4px">Want two of the same protein? Tap it twice — ' +
          'use the − button to take one back.</div>' +
      '</div>';
    }

    steps.forEach((step, i) => {
      const picked = b.picks[step.id] || [];
      const ok = picked.length === step.choose;
      const num = b.cat === 'hotpot' ? (i + 1) : 2;
      body += '<div class="bstep" id="step-' + step.id + '">' +
        '<div class="bstep-head">' +
          '<span class="bstep-num">' + num + '</span>' +
          '<b>' + esc(step.title) + '</b>' +
          '<span class="req ' + (ok ? 'ok' : 'no') + '">' + picked.length + '/' + step.choose + '</span>' +
        '</div>' +
        '<div class="chip-grid">' +
        step.items.map((it) => {
          const count = picked.filter((x) => x === it.n).length;
          const on = count > 0;
          // a chip is "spent" when the step is full and this item can't take another
          const spent = picked.length >= step.choose && !on;
          return '<button class="chip ' + (on ? 'on' : '') + (it.veg ? ' veg' : '') +
              (step.allowDuplicates ? ' chip-count' : '') +
              '" data-step="' + step.id + '" data-item="' + esc(it.n) + '"' +
            (spent ? ' style="opacity:.45"' : '') + '>' +
            '<span class="em">' + (it.emoji || '🍽️') + '</span>' +
            '<span class="tx"><b>' + esc(it.n) + '</b>' +
            (it.note ? '<small>' + esc(it.note) + '</small>' : '') +
            (it.spicy ? '<small class="spicy">' + '🌶'.repeat(it.spicy) + '</small>' : '') +
            '</span>' +
            (step.allowDuplicates && on
              ? '<span class="cnt">' + count + '</span>' +
                '<span class="minus" data-dec="' + esc(it.n) + '" data-sid="' + step.id + '" role="button" aria-label="Remove one ' + esc(it.n) + '">−</span>'
              : '') +
            '</button>';
        }).join('') + '</div>' +
      '</div>';
    });

    const addonList = (b.cat === 'hotpot' ? MENU.hotpot.addons : MENU.bbq.addons) || [];
    if (addonList.length) {
      body += '<div class="bstep"><div class="bstep-head"><span class="bstep-num">+</span><b>Make It a Combo</b></div>' +
        addonList.map((a) =>
          '<button class="addon-row ' + (b.addons[a.id] ? 'on' : '') + '" data-addon="' + a.id + '" style="width:100%;text-align:left">' +
            '<span class="sw"></span>' +
            '<span class="info"><b>' + esc(a.n) + '</b><small>' + esc(a.d) + '</small></span>' +
            '<span class="pr">+' + money(a.price) + '</span>' +
          '</button>').join('') + '</div>';
    }

    if (CONFIG.features.allergenNotes) {
      body += '<div class="field"><label>Special Instructions</label>' +
        '<textarea id="bNote" placeholder="Allergies, no cilantro, extra spicy…">' + esc(b.note) + '</textarea></div>';
    }

    /* An always-present action at the end of the scroll content. The sticky footer
       can be covered by a mobile browser's own bottom toolbar (WeChat, Safari,
       in-app browsers), so the guest always has a reachable way to add the item. */
    body += '<div class="inline-action">' +
      '<div class="ia-state ' + (allDone ? 'ok' : 'warn') + '">' +
        (allDone
          ? '✅ All ' + steps.length + ' step' + (steps.length > 1 ? 's' : '') + ' done — ready to add'
          : '⚠️ ' + (steps.length - done) + ' step' + (steps.length - done > 1 ? 's' : '') +
            ' left: ' + esc(missing.title)) +
      '</div>' +
      '<button class="btn btn-primary" data-badd="1">' +
        (allDone ? 'Add to Order · ' + money(builderTotal()) : esc(missing.title) + ' →') +
      '</button>' +
    '</div>';

    const prog = '<div class="progress">' + steps.map((s) => '<i class="' + (stepSatisfied(s) ? 'done' : '') + '"></i>').join('') + '</div>';

    /* The footer button is NEVER disabled — a greyed-out "Complete all steps" reads
       as "the button never appeared". Instead it names the step still missing and
       jumps straight to it. */
    const foot = '<div class="total"><small>' +
        (allDone ? 'Ready to add'
                 : done + ' of ' + steps.length + ' step' + (steps.length > 1 ? 's' : '') + ' done') + '</small>' +
      '<b>' + money(builderTotal()) + '</b></div>' +
      '<button class="btn btn-primary" data-badd="1">' +
        (allDone ? 'Add to Order' : 'Complete ' + (steps.length - done) + ' more →') +
      '</button>';

    const title = b.cat === 'hotpot' ? 'Hot Pot — Build Your Bowl' : 'BBQ — Build Your Bowl';
    const sub = b.cat === 'hotpot' ? 'One size · ' + money(MENU.hotpot.basePrice) : 'Comes with rice, kimchi &amp; veggies';

    /* First draw of a builder session opens at the top; every later redraw
       (i.e. every tap) keeps the guest exactly where they were. */
    const keepScroll = builderDrawn;
    builderDrawn = true;

    openSheet(title, prog + body, foot, { sub, keepScroll });
    bindBuilder();
  }

  function bindBuilder() {
    /* "−" takes back a single copy. Only rendered in duplicate-capable steps.
       stopPropagation keeps the tap from also hitting the chip underneath. */
    $$('#sheetBody [data-dec]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        const sid = el.dataset.sid, item = el.dataset.dec;
        const arr = b.picks[sid] || [];
        const idx = arr.indexOf(item);
        if (idx > -1) arr.splice(idx, 1);
        b.note = ($('#bNote') || {}).value ?? b.note;
        renderBuilder();
      };
    });

    $$('#sheetBody [data-step]').forEach((btn) => {
      btn.onclick = () => {
        const sid = btn.dataset.step, item = btn.dataset.item;
        const step = stepsFor().find((s) => s.id === sid);
        const arr = b.picks[sid] || (b.picks[sid] = []);

        if (step.allowDuplicates) {
          // tapping always ADDS another serving; removal is the "−" control
          if (arr.length >= step.choose) { toast('That is all ' + step.choose + ' picks'); return; }
          arr.push(item);
        } else {
          const idx = arr.indexOf(item);
          if (idx > -1) arr.splice(idx, 1);
          else {
            if (arr.length >= step.choose) {
              if (step.choose === 1) arr.length = 0;
              else { toast('Pick ' + step.choose + ' max'); return; }
            }
            arr.push(item);
          }
        }
        b.note = ($('#bNote') || {}).value ?? b.note;
        renderBuilder();
      };
    });
    $$('#sheetBody [data-size]').forEach((btn) => {
      btn.onclick = () => {
        const old = (MENU.bbq.sizes.find((x) => x.id === b.size) || {}).picks || 2;
        const nw = (MENU.bbq.sizes.find((x) => x.id === btn.dataset.size) || {}).picks || 2;
        b.size = btn.dataset.size;
        if (nw < old) b.picks.protein = b.picks.protein.slice(0, nw);
        renderBuilder();
      };
    });
    $$('#sheetBody [data-addon]').forEach((btn) => {
      btn.onclick = () => {
        b.note = ($('#bNote') || {}).value ?? b.note;
        b.addons[btn.dataset.addon] = !b.addons[btn.dataset.addon];
        renderBuilder();
      };
    });
    /* Both the sticky footer button and the inline one at the end of the content
       do the same thing: add when complete, otherwise jump to the missing step. */
    $$('#sheetBody [data-badd], #sheetFoot [data-badd]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.fxBusy) return;
        b.note = ($('#bNote') || {}).value || '';
        const steps = stepsFor();
        const gap = steps.find((s) => !stepSatisfied(s));
        if (gap) {
          const el = $('#step-' + gap.id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          toast(gap.title + ' still needs a pick', 'err');
          return;
        }
        const mods = [];
        if (b.cat === 'bbq') {
          const s = MENU.bbq.sizes.find((x) => x.id === b.size);
          mods.push(s.n);
          // collapse repeats so 2× the same protein reads "Beef Bulgogi ×2"
          mods.push('Proteins: ' + collapseRepeats(b.picks.protein));
          mods.push('Includes: ' + MENU.bbq.comesWith.join(', '));
        } else {
          MENU.hotpot.steps.forEach((s) =>
            mods.push(s.title.replace('Choose ', '') + ': ' + collapseRepeats(b.picks[s.id] || [])));
        }
        const addonList = (b.cat === 'hotpot' ? MENU.hotpot.addons : MENU.bbq.addons) || [];
        const addons = addonList.filter((a) => b.addons[a.id]).map((a) => a.n + ' (+' + money(a.price) + ')');
        const name = b.cat === 'hotpot' ? 'Build Your Own Bowl' : 'BBQ Protein Bowl';
        addToCart({ kind: b.cat, name, unit: builderTotal(), qty: 1, mods, addons, note: b.note });
        flashAdded(btn, 'Added');
        /* Same beat as the drink groups: let the guest SEE the green check
           before the sheet takes it away. */
        setTimeout(closeSheet, 420);
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cart UI                                                             */
  /* ------------------------------------------------------------------ */
  function syncCartUI() {
    const n = cartCount();
    const badge = $('#cartBadge');
    badge.textContent = n;
    badge.classList.toggle('on', n > 0);
    /* The first sync after a page load only records where we already are —
       a cart restored from localStorage must not re-play the animation on
       every refresh. */
    if (fxLastCount < 0) fxLastCount = n;
    else if (n > fxLastCount) fxBump(badge);
    fxLastCount = n;
    const bar = $('#cartBar');
    const blocked = ordersBlocked().blocked;
    const on = n > 0 && !state.order && !blocked;
    bar.classList.toggle('on', on);
    /* The bar pulses when it APPEARS, not on every quantity change — after
       that first beat it is furniture. */
    if (on && !fxBarOn) fxAttn($('#cartBarBtn'));
    fxBarOn = on;
    $('#cartBarTotal').textContent = money(grandTotal());
    $('#cartBarCount').textContent = n;
  }

  function renderCartSheet() {
    if (state.sheet !== 'cart') return;
    const body = $('#sheetBody');
    const foot = $('#sheetFoot');
    if (!body || !foot) return;
    /* Replacing innerHTML resets the scroll position, which would throw the
       guest back to the top every time they changed a quantity or picked a tip. */
    const prev = body.scrollTop;
    body.innerHTML = cartBodyHTML();
    foot.innerHTML = cartFootHTML();
    body.scrollTop = prev;
    bindCartSheet();
  }

  function cartBodyHTML() {
    if (!state.cart.length) {
      return '<div class="empty"><div class="em">🛒</div><b>Your order is empty</b><p>Add something tasty from the menu.</p></div>';
    }
    const tips = CONFIG.tipPresets.map((p) => {
      if (p.type === 'none') {
        const on = state.tipMode === 'none';
        return '<button class="tip ' + (on ? 'on' : '') + '" data-tip-mode="none" type="button">No Tip<small>—</small></button>';
      }
      if (p.type === 'amt') {
        const on = state.tipMode === 'amt' && round2(state.tipAmount) === round2(p.amount);
        return '<button class="tip ' + (on ? 'on' : '') + '" data-tip-mode="amt" data-tip-amount="' + p.amount + '" type="button">$' + p.amount + '<small>' + money(p.amount) + '</small></button>';
      }
      if (p.type === 'custom') {
        const on = state.tipMode === 'custom';
        const val = on && state.tipAmount > 0 ? state.tipAmount : '';
        return '<div class="tip tip-custom ' + (on ? 'on' : '') + '" data-tip-mode="custom">' +
                 '<span class="tc-label">Custom</span>' +
                 '<span class="tc-input">$<input id="tipCustomInput" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="' + val + '"></span>' +
               '</div>';
      }
      if (p.type === 'pct') {
        const on = state.tipMode === 'pct' && round2(state.tipAmount) === round2(cartSubtotal() * p.rate);
        return '<button class="tip ' + (on ? 'on' : '') + '" data-tip-mode="pct" data-tip-rate="' + p.rate + '" type="button">' + Math.round(p.rate * 100) + '%<small>' + money(cartSubtotal() * p.rate) + '</small></button>';
      }
      return '';
    }).join('');

    return '<div class="cart-list">' +
      state.cart.map((it) =>
        '<div class="cart-item">' +
          '<div class="body">' +
            '<b>' + esc(it.name) + '</b>' +
            (it.mods && it.mods.length ? '<div class="mods">' + it.mods.map((m) => '<em>' + esc(m) + '</em>').join('<br>') + '</div>' : '') +
            (it.addons && it.addons.length ? '<div class="mods">➕ ' + it.addons.map(esc).join(', ') + '</div>' : '') +
            (it.note ? '<div class="mods">📝 ' + esc(it.note) + '</div>' : '') +
            '<span class="line-total">' + money(it.unit * it.qty) + '</span>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between">' +
            '<button class="icon-btn" style="width:28px;height:28px;font-size:13px" data-rm="' + it.uid + '" aria-label="Remove">🗑</button>' +
            '<div class="stepper">' +
              '<button data-q="-1" data-u="' + it.uid + '">−</button>' +
              '<span class="qty">' + it.qty + '</span>' +
              '<button data-q="1" data-u="' + it.uid + '">+</button>' +
            '</div>' +
          '</div>' +
        '</div>').join('') +
    '</div>' +
    '<div class="tip-section">' +
      '<div class="section-label" style="margin-top:6px">Add a Tip</div>' +
      '<div class="tip-row">' + tips + '</div>' +
    '</div>' +
    couponHTML() +
    '<div class="totals" id="cartTotals">' + cartTotalsHTML() + '</div>';
  }

  /* One line, and only when there is something to show. The label is the
     SERVER's description of what came off — "Points redeemed (200)", "$10
     reward", or the owner's code — so the guest can see WHICH give-away it
     was rather than a generic "Discount". */
  function discountRowHTML() {
    if (!discountAmount()) return '';
    const tag = state.discountLabel
      ? esc(state.discountLabel)
      : (state.discountCode ? 'Discount · ' + esc(state.discountCode) : 'Discount');
    return '<div class="trow disc"><span>' + tag + '</span><b>-' + money(discountAmount()) + '</b></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Discount code                                                       */
  /* ------------------------------------------------------------------
     The code is worth exactly what the server says it is worth. This page
     never decides the amount — it asks /api/price and adopts the answer, the
     same way it adopts the server's breakdown after checkout. A guest can
     type anything into a request; only the server's number reaches the bill.
     ------------------------------------------------------------------ */

  function cartPayload() {
    return state.cart.map((it) => ({
      kind: it.kind, name: it.name, qty: it.qty, mods: it.mods, addons: it.addons, note: it.note
    }));
  }

  function couponHTML() {
    const applied = discountAmount() > 0;
    const busy = state.couponState === 'busy';
    const msg = state.couponMsg
      ? '<div class="small ' + (state.couponState === 'ok' ? 'ok' : 'err') + '" style="margin-top:6px">' + esc(state.couponMsg) + '</div>'
      : '';
    return '<div class="coupon">' +
        '<div class="section-label" style="margin-top:6px">Discount Code</div>' +
        '<div class="coupon-row">' +
          '<input id="couponInput" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="e.g. WELCOME10" value="' + esc(state.couponInput) + '">' +
          (applied
            ? '<button class="btn btn-ghost btn-sm" id="couponRemove" type="button">Remove</button>'
            : '<button class="btn btn-ghost btn-sm" id="couponApply" type="button"' + (busy ? ' disabled' : '') + '>' +
                (busy ? 'Checking…' : 'Apply') + '</button>') +
        '</div>' + msg +
      '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Rewards and discount codes share ONE price request                  */
  /* ------------------------------------------------------------------
     A code and a reward both come off the same bill, and the server allows
     only one of them per order. So they also share one re-price call: two
     separate fetches would race, and whichever landed last would silently
     undo the other. reprice() is that single call.
     ------------------------------------------------------------------ */

  function clearDiscounts() {
    state.discountAmount = 0;
    state.discountCode = '';
    state.discountLabel = '';
    state.discountSource = '';
  }

  /* The server says WHICH half of the request it refused, so the message lands
     on the control the guest has to fix rather than on whichever box happens
     to be on screen. */
  const LOYALTY_ERRORS = [
    'points_unavailable', 'coupon_unavailable', 'order_too_small',
    'unknown_customer', 'bad_phone', 'one_reward_only'
  ];

  /* Any price change has to be VISIBLE.

     Re-rendering the whole sheet would drop the guest's cursor out of the
     Custom tip field, so only the numbers move. This is not decoration: the
     first version of this code re-fetched the price after a quantity change
     and never repainted, so the bill on screen kept showing the discount for
     the OLD quantity — and a guest would then be refused at checkout with
     "total did not match". Only a real browser caught it. */
  function refreshTotals() {
    updateCartTotals();
    renderTotalsInCheckout();
    syncCartUI();
  }

  /* Never decides money — it adopts the server's answer, exactly the way
     checkout adopts the server's breakdown. */
  async function reprice(silent, opts) {
    if (!state.cart.length) return false;
    const code = (opts && opts.code != null) ? String(opts.code) : String(state.discountCode || '');
    const loyalty = (opts && opts.loyalty !== undefined) ? opts.loyalty : loyaltyPayload();

    try {
      const res = await fetch('/api/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderType: state.orderType,
          items: cartPayload(),
          tipAmount: tipAmount(),
          couponCode: code,
          loyalty: loyalty
        })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = String(data.error || '');
        const msg = data.message || 'That discount is not valid.';
        clearDiscounts();
        if (LOYALTY_ERRORS.indexOf(err) !== -1) {
          state.loyaltyChoice = '';
          state.loyaltyMsg = msg;
          state.loyaltyState = 'err';
          state.couponMsg = '';
          state.couponState = '';
        } else {
          state.couponMsg = msg;
          state.couponState = 'err';
          state.loyaltyMsg = '';
          state.loyaltyState = '';
        }
        if (silent) toast(msg, 'err');
        refreshTotals();
        return false;
      }

      state.discountAmount = Number(data.discount) || 0;
      state.discountCode = String(data.discountCode || '');
      state.discountLabel = String(data.discountLabel || '');
      state.discountSource = String(data.discountSource || '');

      if (state.discountAmount > 0) {
        if (state.discountSource === 'loyalty') {
          state.loyaltyMsg = 'Applied — you save ' + money(state.discountAmount) + '.';
          state.loyaltyState = 'ok';
          state.couponMsg = '';
          state.couponState = '';
        } else {
          state.couponMsg = 'Code applied — you save ' + money(state.discountAmount) + '.';
          state.couponState = 'ok';
          state.loyaltyMsg = '';
          state.loyaltyState = '';
        }
      } else if (code) {
        state.couponMsg = 'Code accepted, but it does not apply to this order.';
        state.couponState = 'err';
      } else if (loyalty) {
        state.loyaltyMsg = 'That reward does not apply to this order.';
        state.loyaltyState = 'err';
      }
      refreshTotals();
      return true;
    } catch (e) {
      clearDiscounts();
      state.couponMsg = 'Could not check that discount. Try again.';
      state.couponState = 'err';
      if (silent) toast('Could not re-check your discount.', 'err');
      refreshTotals();
      return false;
    }
  }

  async function applyCoupon() {
    const code = String(state.couponInput || '').trim();
    if (!code) {
      state.couponMsg = 'Enter a code first.';
      state.couponState = 'err';
      renderCartSheet();
      return;
    }
    if (!state.cart.length) return;

    state.couponState = 'busy';
    state.couponMsg = '';
    /* A code and a reward are alternatives, so picking up the code puts the
       reward down — otherwise the server refuses the whole request. */
    state.loyaltyChoice = '';
    state.loyaltyMsg = '';
    state.loyaltyState = '';
    state.discountCode = code;
    renderCartSheet();

    const ok = await reprice(false, { code: code, loyalty: null });
    if (!ok) state.discountCode = '';
    else if (state.discountAmount > 0) state.couponInput = state.discountCode;

    renderCartSheet();
    syncCartUI();
  }

  function removeCoupon() {
    state.couponInput = '';
    state.discountCode = '';
    clearDiscounts();
    state.couponMsg = '';
    state.couponState = '';
    renderCartSheet();
    syncCartUI();
  }

  /* ------------------------------------------------------------------ */
  /* Rewards                                                             */
  /* ------------------------------------------------------------------ */

  /* The server's phone rule, mirrored only far enough to decide whether a
     lookup is worth making. NOT an authority: the server re-checks every
     number and refuses anything it does not recognise. */
  function clientPhone(raw) {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    const local = (digits.length === 11 && digits.charAt(0) === '1') ? digits.slice(1) : digits;
    return local.length === 10 ? local : null;
  }

  /* ------------------------------------------------------------------ */
  /* The device credential — CONVENIENCE ONLY since 2026-10-16            */
  /* ------------------------------------------------------------------ */
  /* Kept on this device, scoped to ONE phone number. It exists so a returning
     guest does not retype their number, which is what the owner asked for
     originally ("以后在同一设备结账时，可以自动识别账户并使用奖励").

     ⚠️ It is NOT a gate any more. The phone number IS the credential — the
     owner's reversal, made with the fact in front of them that the number is
     printed on every ticket. So a missing credential costs a few keystrokes
     and nothing else: Losing it (new phone, cleared site data) just means the
     number gets typed again.

       * a credential is only ever SENT with the number it was issued for, so a
         shared tablet where one guest signs in and the next types their own
         number never mixes the two. */

  function loadDevice() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_DEVICE) || 'null');
      return (d && typeof d.token === 'string' && d.token) ? d : null;
    } catch (e) { return null; }
  }

  function saveDevice(token, phone, name) {
    if (!token) return;
    try {
      localStorage.setItem(LS_DEVICE, JSON.stringify({
        token: String(token),
        phone: clientPhone(phone) || '',
        name: String(name || '')
      }));
    } catch (e) { /* private mode — the guest just re-verifies next time */ }
  }

  /* The credential to send WITH this phone number, or ''. */
  function deviceFor(phone) {
    const d = loadDevice();
    const p = clientPhone(phone);
    if (!d || !p || d.phone !== p) return '';
    return d.token;
  }

  /* The secret that proves to the server that THIS browser placed THIS order.
     32 bytes from the platform CSPRNG, not Math.random() — it is a bearer
     token for the guest's account, so a guessable one is worse than none.

     crypto.getRandomValues needs a secure context (https, or localhost). If it
     is missing we send nothing, the server stores no claim hash, and the order
     simply cannot be claimed — fail closed, and the guest is told to ask at
     the counter rather than being handed an account somebody could guess. */
  function newClaimSecret() {
    try {
      const wc = window.crypto || window.msCrypto;
      if (!wc || !wc.getRandomValues) {
        console.warn('[kpot] no secure RNG here — this order cannot be claimed on this device');
        return '';
      }
      const a = new Uint8Array(32);
      wc.getRandomValues(a);
      return Array.prototype.map.call(a, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return ''; }
  }

  /* Trade a paid order for a credential on this device.

     Called from the two places a payment can be confirmed on this browser: the
     return from Stripe, and the ticket's status poll (which is how a
     pay-at-counter order becomes paid while the guest is still looking at the
     screen). One attempt per order number, because the poll runs every 5s. */
  const claimedOrders = {};
  function claimDevice(order) {
    if (!state.backend || !order) return Promise.resolve(false);
    const id = order.no;
    const secret = order.claim;
    if (!id || !secret || claimedOrders[id]) return Promise.resolve(false);
    /* Already signed in on this phone — nothing to collect. */
    if (deviceFor((order.customer || {}).phone)) { claimedOrders[id] = true; return Promise.resolve(false); }
    claimedOrders[id] = true;

    return fetch('/api/orders/' + encodeURIComponent(id) + '/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: secret })
    }).then((r) => r.json().catch(() => null).then((j) => ({ r: r, j: j })))
      .then((out) => {
        if (out.r && out.r.ok && out.j && out.j.device) {
          saveDevice(out.j.device, (order.customer || {}).phone, out.j.name);
          console.log('[kpot] rewards unlocked on this device');
          return true;
        }
        /* Not paid yet is the normal case while a counter order waits for
           staff — forget the attempt so the next poll can try again. */
        if (out.j && out.j.error === 'not_paid') { claimedOrders[id] = false; return false; }
        if (out.j && out.j.error) console.warn('[kpot] could not set up rewards here:', out.j.error);
        return false;
      })
      .catch(() => { claimedOrders[id] = false; return false; });
  }

  /* What we tell the server about rewards: a WISH ("use my points", "use this
     reward") and never an amount. The phone number is what the account is
     named after; `device` rides along purely so the server can recognise this
     phone, and is not a condition of anything (see the header above). */
  function loyaltyPayload() {
    if (!state.loyaltyChoice) return null;
    const phone = (state.customer || {}).phone || '';
    const device = deviceFor(phone);
    if (state.loyaltyChoice === 'points') return { phone: phone, redeemPoints: true, device: device };
    return { phone: phone, couponId: state.loyaltyChoice, device: device };
  }

  let loyaltyTimer = null;
  function scheduleLoyaltyLookup() {
    if (loyaltyTimer) clearTimeout(loyaltyTimer);
    loyaltyTimer = setTimeout(() => { loyaltyTimer = null; lookupLoyalty(); }, 500);
  }

  /* force = the cart changed, so the subtotal-dependent answers (how many
     points can come off THIS bill) have to be recomputed even though the
     phone is the same. */
  async function lookupLoyalty(force) {
    const phone = clientPhone((state.customer || {}).phone);

    if (!phone) {
      state.loyalty = null;
      state.loyaltyPhone = '';
      state.loyaltyState = '';
      state.loyaltyMsg = '';
      /* A reward picked for a number the guest has since edited away must not
         stay on the bill. */
      if (state.loyaltyChoice) { state.loyaltyChoice = ''; await reprice(true, { loyalty: null }); }
      renderLoyaltyBox();
      return;
    }
    if (!force && state.loyaltyPhone === phone && state.loyalty) { renderLoyaltyBox(); return; }

    state.loyaltyState = 'busy';
    renderLoyaltyBox();
    try {
      const res = await fetch('/api/customer?phone=' + encodeURIComponent(phone) +
        '&subtotal=' + encodeURIComponent(String(cartSubtotal())) +
        '&device=' + encodeURIComponent(deviceFor(phone)));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('lookup failed');
      /* The guest may have typed another digit while this was in flight; a
         stale answer must not overwrite the newer one. */
      if (clientPhone(state.customer.phone) !== phone) return;

      state.loyalty = data;
      state.loyaltyPhone = phone;
      state.loyaltyState = 'ok';

      /* The reward they picked may not survive a changed cart — a $5 coupon on
         a $3 order, or points that no longer cover a whole block. Drop it here
         rather than let the server refuse the order at the last moment. */
      if (state.loyaltyChoice) {
        const stillThere = state.loyaltyChoice === 'points'
          ? !!data.pointsRedemption
          : (data.coupons || []).some((c) => c.id === state.loyaltyChoice);
        if (!stillThere) {
          state.loyaltyChoice = '';
          state.loyaltyMsg = 'That reward no longer applies to this order.';
          state.loyaltyState = 'err';
          await reprice(true, { loyalty: null });
        }
      }
    } catch (e) {
      state.loyalty = null;
      state.loyaltyState = '';
    }
    renderLoyaltyBox();
    /* The options are built from the subtotal, so the bill on screen has to be
       refreshed with them — the two must never disagree. */
    refreshTotals();
  }

  function loyaltyRowHTML(value, title, right, sub) {
    const on = state.loyaltyChoice === value;
    return '<button class="loy-row' + (on ? ' on' : '') + '" type="button" data-loy="' + esc(value) + '">' +
        '<span class="rd"></span>' +
        '<span class="tx"><b>' + title + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        (right ? '<span class="amt">' + esc(right) + '</span>' : '') +
      '</button>';
  }

  /* The stamp card, drawn as a row with a progress bar rather than a bare line
     of text.

     When the card is complete the server has already minted the reward — it
     arrives as an ordinary coupon — so THIS row is where it is offered, using
     that coupon's id. That keeps one thing in one place: the guest sees "7/10"
     fill up and the reward appear on the same row, instead of a progress note
     here and an unexplained discount further down. */
  function stampCardHTML(stampCoupons, s, R) {
    const every = Math.max(1, Number(s.every) || 10);
    const into = Math.max(0, Math.min(every, Number(s.into) || 0));
    const pct = Math.round((into / every) * 100);
    const value = Number(R.stampValue) || 0;
    const held = stampCoupons.length;
    const title = 'Stamp card · ' + into + '/' + every + ' orders';
    const bar = '<span class="loy-bar" role="img" aria-label="' + into + ' of ' + every + '">' +
      '<i style="width:' + pct + '%"></i></span>';

    if (held > 0) {
      const on = state.loyaltyChoice === stampCoupons[0].id;
      const sub = held > 1
        ? held + ' rewards ready — one per order'
        : 'Ready! Pick this to take $' + value + ' off';
      return '<button class="loy-row' + (on ? ' on' : '') + '" type="button" data-loy="' + esc(stampCoupons[0].id) + '">' +
          '<span class="rd"></span>' +
          '<span class="tx"><b>' + esc(title) + '</b>' + bar + '<small>' + esc(sub) + '</small></span>' +
          '<span class="amt">-' + money(value * held) + '</span>' +
        '</button>';
    }
    const need = every - into;
    const sub = need + ' more order' + (need === 1 ? '' : 's') + ' for $' + value + ' off · never expires';
    return '<div class="loy-row is-info">' +
        '<span class="rd stamp">🎯</span>' +
        '<span class="tx"><b>' + esc(title) + '</b>' + bar + '<small>' + esc(sub) + '</small></span>' +
      '</div>';
  }

  function renderLoyaltyBox() {
    const box = $('#loyaltyBox');
    if (!box) return;

    const digits = String((state.customer || {}).phone || '').replace(/\D/g, '');
    if (digits.length < 7) { box.innerHTML = ''; return; }

    if (!clientPhone(state.customer.phone)) {
      box.innerHTML = '<div class="loy"><div class="section-label">Rewards</div>' +
        '<div class="small dim">Use a 10-digit mobile number and this order starts earning points.</div></div>';
      return;
    }

    if (state.loyaltyState === 'busy' && !state.loyalty) {
      box.innerHTML = '<div class="loy"><div class="section-label">Rewards</div>' +
        '<div class="small dim">Checking your rewards…</div></div>';
      return;
    }

    const L = state.loyalty;

    /* No lock, no unlock step, no e-mail. Since 2026-10-16 the number the guest
       typed IS the credential — the owner's call, made with the fact in front
       of them that the same number is printed on every ticket. The panel shows
       the balance to whoever types the number, which is exactly what was
       asked for. (For six weeks this branch rendered a "confirm this phone"
       panel instead.) */
    if (!L || !L.found) {
      box.innerHTML = '<div class="loy"><div class="section-label">Rewards</div>' +
        '<div class="small dim">First order on this number — you start earning points with this one.</div></div>';
      return;
    }

    const R = L.rules || {};
    const member = L.member || {};
    const memberBadge = member.is
      ? '<div class="loy-member">⭐ Member' + (member.daysLeft ? ' · ' + member.daysLeft + ' days left' : '') + '</div>'
      : '';
    const rows = [loyaltyRowHTML('', 'Keep my rewards for later', '', '')];

    const pr = L.pointsRedemption;
    if (pr) {
      /* The no-expiry promise rides on whichever points line is showing, so it
         is never missing just because the guest happens to be able to redeem
         right now. A countdown next to a balance is what started all this. */
      rows.push(loyaltyRowHTML('points', 'Use ' + pr.points + ' points',
        '-' + money(pr.value),
        'You have ' + L.points + ' points · ' + R.redeemStep + ' at a time · never expire'));
    } else if (L.points > 0) {
      /* Say the promise out loud. The owner's whole objection to the old panel
         was a countdown sitting next to a points balance — a guest who reads
         "Expires …" next to "12 points" concludes the points die.
         But which sentence depends on WHY nothing is on offer: "80 more points"
         is the truth when the balance is short and a bare lie when the guest
         has the points and the BASKET is what is too small to take $10 off. */
      const hold = L.pointsHold;
      if (hold === 'order_too_small') {
        rows.push('<div class="loy-note small dim">You have ' + L.points + ' point' +
          (L.points === 1 ? '' : 's') + ' — enough for $' + R.redeemValue + ' off on an order of $' +
          R.redeemValue + ' or more. Points never expire.</div>');
      } else {
        const need = R.redeemStep - (L.points % R.redeemStep);
        rows.push('<div class="loy-note small dim">You have ' + L.points + ' point' +
          (L.points === 1 ? '' : 's') + ' — ' + need + ' more for $' + R.redeemValue +
          ' off. Points never expire.</div>');
      }
    }

    /* Rewards split by kind. A stamp reward IS the stamp card completing, so it
       belongs on the stamp row; everything else gets its own line. Only a
       come-back coupon carries a date, and saying so is the point — it is the
       one reward that is meant to be used soon. */
    const coupons = L.coupons || [];
    const stampCoupons = coupons.filter((c) => c.kind === 'stamp');
    const otherCoupons = coupons.filter((c) => c.kind !== 'stamp');

    rows.push(stampCardHTML(stampCoupons, L.stamps || {}, R));
    rows.push('<div class="loy-note small dim">One reward per order — they cannot be stacked.</div>');

    otherCoupons.forEach((c) => {
      const sub = c.expiresAt ? 'Come back within ' + daysUntil(c.expiresAt) + ' — expires ' +
        new Date(c.expiresAt).toLocaleDateString() : '';
      rows.push(loyaltyRowHTML(c.id, esc(c.label || 'Reward'), '-' + money(c.value), sub));
    });

    box.innerHTML = '<div class="loy">' +
      '<div class="section-label">Rewards' + (L.name ? ' · ' + esc(L.name) : '') + '</div>' +
      memberBadge +
      rows.join('') +
      (state.loyaltyMsg
        ? '<div class="small ' + (state.loyaltyState === 'ok' ? 'ok' : 'err') + '" style="margin-top:6px">' +
          esc(state.loyaltyMsg) + '</div>'
        : '') +
    '</div>';
  }

  function daysUntil(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const d = Math.ceil((t - Date.now()) / 86400000);
    return d <= 0 ? 'today' : (d + ' day' + (d === 1 ? '' : 's'));
  }

  async function chooseLoyalty(value) {
    if (value === state.loyaltyChoice) return;
    state.loyaltyChoice = value;
    state.loyaltyMsg = '';
    state.loyaltyState = '';
    /* Picking a reward puts the typed code down — the server allows one. */
    state.couponMsg = '';
    state.couponState = '';
    state.discountCode = '';
    renderLoyaltyBox();
    await reprice(false, { code: '', loyalty: loyaltyPayload() });
    renderLoyaltyBox();
    renderTotalsInCheckout();
    syncCartUI();
  }

  /* Delegated for the same reason as bindScheduleBox(): renderLoyaltyBox()
     replaces the box's innerHTML, and it runs again after every reprice
     (lookupLoyalty → reprice → renderLoyaltyBox, and again inside
     chooseLoyalty), so per-button handlers were destroyed as soon as the
     guest finished typing their number. */
  function bindLoyaltyBox() {
    const box = $('#loyaltyBox');
    if (!box || box.dataset.loyBound === '1') return;
    box.dataset.loyBound = '1';
    /* Delegation, NOT per-button onclick. renderLoyaltyBox() redraws the box
       after every keystroke in the phone field and again inside
       chooseLoyalty(), so per-button handlers were destroyed as soon as the
       guest finished typing their number. */
    box.addEventListener('click', (ev) => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('[data-loy]') : null;
      if (!hit || hit.disabled) return;
      chooseLoyalty(hit.dataset.loy || '');
    });
  }

  /* The cart changed, so a percentage code is worth a different amount, a
     minimum-spend code may no longer qualify, and a reward may be worth more
     or less than it was. Ask again instead of leaving a stale number on the
     bill. Sequential, not parallel: refreshing the reward can itself trigger a
     re-price. */
  let couponTimer = null;
  function revalidateCoupon() {
    if (!state.discountCode && !state.couponInput && !state.loyaltyChoice) return;
    if (couponTimer) clearTimeout(couponTimer);
    couponTimer = setTimeout(async () => {
      couponTimer = null;
      await reprice(true);
      if (state.loyaltyPhone) await lookupLoyalty(true);
    }, 400);
  }

  /* Numeric breakdown only. Kept separate from the tip chips so a guest typing
     in the Custom tip field can refresh the numbers without the whole sheet
     (and the input) being rebuilt and losing focus. */
  function cartTotalsHTML() {
    return '' +
      '<div class="trow mt16"><span>Subtotal</span><b>' + money(cartSubtotal()) + '</b></div>' +
      deliveryRowHTML() +
      discountRowHTML() +
      '<div class="trow"><span>Tax (' + (CONFIG.taxRate * 100).toFixed(2).replace(/\.00$/, '') + '%)</span><b>' + money(taxAmount()) + '</b></div>' +
      (tipAmount() ? '<div class="trow"><span>Tip</span><b>' + money(tipAmount()) + '</b></div>' : '') +
      '<div class="trow grand"><span>Total</span><b>' + money(grandTotal()) + '</b></div>';
  }

  /* Refresh just the numbers (and footer total) — used while typing Custom. */
  function updateCartTotals() {
    const t = $('#cartTotals');
    if (t) t.innerHTML = cartTotalsHTML();
    const ft = $('#footTotal');
    if (ft) ft.textContent = money(grandTotal());
  }

  function cartFootHTML() {
    if (!state.cart.length) return '<button class="btn btn-ghost" data-close="1">Browse Menu</button>';
    return '<div class="total"><small>Total</small><b id="footTotal">' + money(grandTotal()) + '</b></div>' +
      '<button class="btn btn-primary" id="toCheckout">Checkout →</button>';
  }

  function bindCartSheet() {
    $$('#sheetBody [data-q]').forEach((btn) => btn.onclick = () => setQty(btn.dataset.u, Number(btn.dataset.q)));
    $$('#sheetBody [data-rm]').forEach((btn) => btn.onclick = () => removeItem(btn.dataset.rm));

    const cap = $('#couponApply');
    if (cap) cap.onclick = () => applyCoupon();
    const crem = $('#couponRemove');
    if (crem) crem.onclick = removeCoupon;
    const coupInp = $('#couponInput');
    if (coupInp) {
      coupInp.oninput = () => { state.couponInput = coupInp.value; };
      coupInp.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); }
      };
    }
    $$('#sheetBody [data-tip-mode]').forEach((btn) => btn.onclick = (e) => {
      /* Clicking inside the Custom field should let the guest type, not
         re-select the chip and rebuild the sheet (which would drop focus). */
      if (e.target && e.target.tagName === 'INPUT') return;
      if (btn.dataset.tipMode === 'none') {
        state.tipMode = 'none'; state.tipAmount = 0;
      } else if (btn.dataset.tipMode === 'amt') {
        state.tipMode = 'amt'; state.tipAmount = round2(Number(btn.dataset.tipAmount));
      } else if (btn.dataset.tipMode === 'pct') {
        state.tipMode = 'pct'; state.tipAmount = round2(cartSubtotal() * Number(btn.dataset.tipRate));
      } else if (btn.dataset.tipMode === 'custom') {
        state.tipMode = 'custom';
        const inp = $('#tipCustomInput');
        state.tipAmount = inp ? round2(parseFloat(inp.value) || 0) : 0;
      }
      renderCartSheet();
      syncCartUI();
      /* The sheet was just rebuilt, so focus the fresh Custom input now —
         focusing the old one beforehand would be lost on re-render. */
      if (btn.dataset.tipMode === 'custom') {
        const ni = $('#tipCustomInput');
        if (ni) ni.focus();
      }
    });
    /* Typing in the Custom field: update the tip + total live without
       rebuilding the sheet, so the cursor stays put. */
    const cinp = $('#tipCustomInput');
    if (cinp) {
      cinp.oninput = () => {
        state.tipMode = 'custom';
        state.tipAmount = round2(parseFloat(cinp.value) || 0);
        const wrap = cinp.closest('.tip-custom');
        if (wrap) wrap.classList.add('on');
        updateCartTotals();
        syncCartUI();
      };
      cinp.onfocus = () => {
        state.tipMode = 'custom';
        state.tipAmount = round2(parseFloat(cinp.value) || 0);
        const wrap = cinp.closest('.tip-custom');
        if (wrap) wrap.classList.add('on');
      };
    }
    const go = $('#toCheckout');
    if (go) go.onclick = openCheckout;
  }

  function openCart() {
    const blk = ordersBlocked();
    if (blk.blocked) { toast('We are not accepting orders right now.', 'err'); return; }
    state.sheet = 'cart';
    openSheet('Your Order', cartBodyHTML(), cartFootHTML());
    bindCartSheet();
  }

  /* Where the browser asks for a Stripe session. When this copy is served by
     our own Node server the route is simply /api/checkout, so config.js can
     stay empty. A full URL is only needed if the checkout endpoint lives
     somewhere else. */
  function checkoutUrl() {
    return CONFIG.payment.stripe.createSessionUrl || '/api/checkout';
  }

  /* A payment method only counts as ready when it has everything it needs.
     This keeps half-configured options (e.g. Stripe with no link yet) out of
     the guest's way instead of showing a button that dead-ends. */
  function stripeMode() {
    const p = CONFIG.payment.stripe;
    if (!p || !p.enabled) return 'none';
    if (state.backend) return 'backend';          // our server: amount auto-filled
    if (p.createSessionUrl) return 'backend';     // someone else's endpoint
    if (p.paymentLink) return 'link';             // guest types the amount
    return 'none';
  }
  function payReady(key) {
    const p = CONFIG.payment[key];
    if (!p || !p.enabled) return false;
    if (key === 'counter') return true;
    if (key === 'stripe') return stripeMode() !== 'none';
    if (key === 'venmo') return !!p.handle;
    if (key === 'zelle') return !!p.recipient;
    return false;
  }
  function readyPayMethods() {
    return Object.keys(CONFIG.payment).filter(payReady);
  }

  /* Which method to pre-select. Online first, counter last: an order that is
     already paid can never become a no-show loss, so the default nudges
     prepayment. A guest who would rather pay at pickup can still switch — the
     point is that they have to choose it deliberately rather than drift into
     it because it happened to be first. */
  const PAY_PREFERENCE = ['stripe', 'venmo', 'zelle', 'counter'];
  function defaultPayMethod() {
    const ready = readyPayMethods();
    for (let i = 0; i < PAY_PREFERENCE.length; i++) {
      if (ready.indexOf(PAY_PREFERENCE[i]) !== -1) return PAY_PREFERENCE[i];
    }
    return 'counter';
  }

  /* ---- Pay-at-counter ceiling (guest side) ------------------------------
     Mirrors the rule in server.js, which is the copy that actually enforces
     it. This one exists so the guest never walks into a dead end: the option
     is shown disabled with the reason, and an over-cap cart is moved to an
     online method automatically.

     Switched off when there is no online method, for the same reason as on
     the server — a ceiling with nothing to fall back to would block large
     orders outright. */
  function counterCap() {
    const c = (CONFIG.payment && CONFIG.payment.counter) || {};
    const n = Number(c.maxTotal);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function onlinePayMethod() {
    const ready = readyPayMethods().filter((k) => k !== 'counter');
    return ready.length ? ready[0] : null;
  }
  function counterBlockedByTotal() {
    const cap = counterCap();
    if (!cap) return false;
    if (grandTotal() <= cap) return false;
    return !!onlinePayMethod();
  }

  /* ---- Pay at the counter is NOT offered on delivery --------------------
     A delivery leaves the building: there is no counter to walk up to when
     the food arrives, and nothing to collect afterwards. So a counter-paid
     delivery is not a risky order, it is an impossible one — which makes this
     rule unconditional, unlike the ceiling above. It does not need an online
     fallback to be legitimate; if the owner sells delivery with no online
     method configured, delivery simply cannot be ordered until one is, and
     that is the honest outcome rather than a doorstep debt.

     Mirrors counterDeliveryVerdict() in server.js — that is the copy that
     actually enforces it. This one exists so the guest sees the reason
     instead of a button that dead-ends. */
  function counterBlockedByDelivery() {
    if (state.orderType !== 'delivery' || !deliveryOn()) return false;
    const d = CONFIG.delivery || {};
    return d.allowCounter !== true;
  }

  /* The single question the checkout asks before letting the counter card be
     picked: is pay-at-counter allowed for THIS order? Two separate reasons,
     one answer — so a new reason can never be added to one place and
     forgotten in the other. */
  function counterBlocked() {
    return counterBlockedByTotal() || counterBlockedByDelivery();
  }

  /* Ask the server whether online payment is actually wired up. On a plain
     static host this 404s and everything falls back to the Payment Link path. */
  function probeBackend() {
    return fetch('/api/health', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { state.backend = !!(j && j.checkout); })
      .catch(() => { state.backend = false; })
      .then(() => {
        renderShell();
        /* If the guest already opened checkout, refresh the options now that we
           know whether the pre-filled amount is available. */
        if (state.sheet === 'checkout') { renderStripeBox(); updatePayHint(); }
        checkStoreStatus();
      });
  }

  /* Pull the owner's live menu from the server (edited in the back-office) so
     guests see product/price changes with no redeploy. Falls back to the
     bundled assets/menu.js on any error or on a static host. Returns whether
     the menu was actually replaced (so the caller can re-render). */
  function loadLiveMenu() {
    if (!state.backend) return Promise.resolve(false);
    return fetch('/api/menu', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.menu && typeof setLiveMenu === 'function') { setLiveMenu(j.menu, j.categories); return true; }
        return false;
      })
      .catch(() => false);
  }

  /* ------------------------------------------------------------------ */
  /* Payment verification                                                */
  /* ------------------------------------------------------------------ */
  /* The address Stripe sends a guest back to is just a URL — anyone can type
     it. So "?paid=1" is NOT proof of payment: it only tells us a payment was
     attempted. Before showing anything as paid we ask our own server, which
     asks Stripe what actually happened.

     We try the payment_intent first (more reliable — it exists once the guest
     has started the flow), then fall back to the session id.

     Returns 'verified' | 'unpaid' | 'unverified'. Anything we cannot confirm
     resolves to 'unverified' — never to paid. */
  function verifyPayment(order) {
    if (!order) return Promise.resolve('unverified');
    const id = order.paymentIntent || order.sessionId;
    if (!id) return Promise.resolve('unverified');

    const base = CONFIG.payment.stripe.createSessionUrl || '';
    const endpoint = (base ? base.replace(/\/api\/checkout$/, '/api\/verify-session')
                           : '/api\/verify-session') + '?id=' + encodeURIComponent(id);

    return fetch(endpoint, { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.verified === true ? 'verified' : 'unpaid'))
      .catch(() => 'unverified');
  }

  /* ------------------------------------------------------------------ */
  /* Checkout                                                            */
  /* ------------------------------------------------------------------ */
  function openCheckout() {
    const blk = ordersBlocked();
    if (blk.blocked) { toast('We are not accepting orders right now.', 'err'); return; }
    if (!state.cart.length) return;
    state.sheet = 'checkout';
    const c = state.customer;

    /* Pre-select an online method the first time checkout opens, so most
       orders are already paid before the kitchen sees them. Once the guest
       has chosen for themselves, respect that instead of overriding it —
       and always recover if their choice is no longer available. */
    if (!state.payChosen || !payReady(state.payMethod)) state.payMethod = defaultPayMethod();
    /* A cart that has grown past the ceiling — or a Delivery order, which is
       prepaid-only — can no longer be paid at the counter. Move the guest to
       an online method rather than leaving them selected on an option the
       server will refuse. */
    if (state.payMethod === 'counter' && counterBlocked()) {
      state.payMethod = onlinePayMethod() || 'counter';
    }

    const payOpts = readyPayMethods()
      .map((k) => {
        /* A blocked counter card stays visible but disabled, with the reason
           in place of its usual blurb — hiding it entirely would leave the
           guest wondering where the option went. Which reason depends on why
           it is blocked, so the text names the thing the guest can act on. */
        const overCap = k === 'counter' && counterBlocked();
        const desc = overCap
          ? (counterBlockedByDelivery()
              ? 'Delivery orders must be paid online'
              : 'Orders over ' + money(counterCap()) + ' must be paid online')
          : CONFIG.payment[k].d;
        return '<button class="pay-opt ' + (state.payMethod === k ? 'on' : '') + '" data-pay="' + k + '"' +
            (overCap ? ' disabled aria-disabled="true"' : '') + '>' +
          '<span class="rd"></span>' +
          '<span class="ic">' + ({ counter: '🏪', stripe: '💳', venmo: '💙', zelle: '🏦' }[k] || '💰') + '</span>' +
          '<span class="tx"><b>' + esc(CONFIG.payment[k].n) + '</b><small>' + esc(desc) + '</small></span>' +
        '</button>';
      }).join('');

    const otLabel = { pickup: 'Pickup Time', dinein: 'Table Number', delivery: 'Delivery Address' }[state.orderType];

    const body =
      '<div class="section-label" style="margin-top:4px">Your Details</div>' +
      '<div class="field"><label>Name</label><input id="cName" placeholder="e.g. Alex" value="' + esc(c.name) + '"></div>' +
      '<div class="field"><label>Mobile</label><input id="cPhone" type="tel" inputmode="tel" placeholder="(555) 123-4567" value="' + esc(c.phone) + '"></div>' +
      '<div class="small dim" style="margin:8px 0 14px">Used for this order and Reward enrollment - not marketing SMS consent.</div>' +
      /* REQUIRED now: it is how we e-mail the guest the moment their order is
         ready, and it is their reward enrollment contact. A guest who leaves it
         blank cannot be told their food is up, so the order cannot be placed
         without it. */
      '<div class="field"><label>E-mail <span class="opt">(for order updates)</span></label>' +
        '<input id="cEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="' + esc(c.email || '') + '"></div>' +
      '<div class="small dim" style="margin:8px 0 14px">We e-mail you the moment your order is ready.</div>' +
      /* Rewards hang off the mobile number, so the box sits directly under it —
         the guest sees what their number is worth the moment they type it. */
      '<div id="loyaltyBox"></div>' +
      '<div id="scheduleBox"></div>' +
      '<div class="field"><label>' + esc(otLabel) + '</label>' +
        '<input id="cWhen" placeholder="' + (state.orderType === 'dinein' ? 'Table 12' : state.orderType === 'delivery' ? '123 Main St, Apt 4' : 'ASAP (20–25 min)') + '" value="' + esc(c.when || '') + '"></div>' +
      /* The live 2-mile delivery check fills this in — only ever on Delivery,
         and only once the guest has typed enough to be an address. */
      '<div id="geoBox"></div>' +
      (CONFIG.features.orderNotes ? '<div class="field"><label>Order Notes</label><textarea id="cNotes" placeholder="Extra napkins, no chopsticks…">' + esc(c.notes) + '</textarea></div>' : '') +
      '<div class="section-label">Payment Method</div>' +
      payOpts +
      '<div class="small dim" style="margin-top:8px" id="payHint"></div>' +
      '<div id="stripeBox"></div>' +
      /* An id of its own, not just the .totals class: the CART sheet's totals
         block carries that class too, and renderTotalsInCheckout() used to
         pick "the first .totals in the sheet" — which, called from the cart,
         would overwrite the cart's own totals block and leave #cartTotals
         missing. Two sheets, one class, one id. */
      '<div class="totals" id="checkoutTotals" style="padding-left:0;padding-right:0">' +
        '<div class="trow"><span>Subtotal</span><b>' + money(cartSubtotal()) + '</b></div>' +
        deliveryRowHTML() +
        discountRowHTML() +
        '<div class="trow"><span>Tax</span><b>' + money(taxAmount()) + '</b></div>' +
        (tipAmount() ? '<div class="trow"><span>Tip</span><b>' + money(tipAmount()) + '</b></div>' : '') +
        (surcharge() ? '<div class="trow"><span>Card fee</span><b>' + money(surcharge()) + '</b></div>' : '') +
        '<div class="trow grand"><span>Total</span><b>' + money(grandTotal()) + '</b></div>' +
      '</div>';

    const foot = '<div class="total"><small>Total</small><b>' + money(grandTotal()) + '</b></div>' +
      '<button class="btn btn-primary" id="placeOrder">Place Order · ' + money(grandTotal()) + '</button>';

    openSheet('Checkout', body, foot);

    updatePayHint();
    renderStripeBox();

    /* The mobile number drives the rewards, and it is typed HERE — so mirror it
       into state as it is typed (placeOrder used to read the input directly and
       nothing else ever saw it) and look up what the number is worth. */
    const ph = $('#cPhone');
    if (ph) {
      ph.oninput = () => { state.customer.phone = ph.value; scheduleLoyaltyLookup(); };
      ph.onblur = () => { state.customer.phone = ph.value; lookupLoyalty(); };
    }
    /* Mirrored for the same reason as the phone: placeOrder() used to read the
       input directly, and a re-render would otherwise drop what was typed. */
    const em = $('#cEmail');
    if (em) em.oninput = () => { state.customer.email = em.value.trim(); };
    /* On Delivery this input IS the address, so it drives the distance check
       (debounced — every keystroke would be a geocode). On the other channels
       it is a pickup time or a table number and must not trigger anything. */
    const wh = $('#cWhen');
    if (wh) wh.oninput = () => { if (state.orderType === 'delivery') scheduleGeoCheck(); };
    renderLoyaltyBox();
    bindLoyaltyBox();
    if (state.orderType === 'delivery' && deliveryOn()) {
      renderScheduleBox();
      bindScheduleBox();
      loadSchedule().then(() => {
        const first = state.scheduleDays[0];
        if (first) return loadScheduleDate(first.iso);
      });
      renderGeoBox();
      bindGeoBox();
      /* An address carried over from a previous session (or restored with the
         cart) is checked immediately — the guest must not have to retype it
         to learn it is refused. */
      const pre = $('#cWhen');
      if (pre && pre.value.trim().length >= 8) scheduleGeoCheck(true);
    }

    /* The bill may have changed while the sheet was closed, so ask again before
       showing a total the server might refuse. Sequential, not parallel: a
       reward refresh can itself trigger a re-price. */
    if (state.loyaltyPhone || state.discountCode || state.loyaltyChoice) {
      (async () => {
        await lookupLoyalty(true);
        await reprice(true);
        renderLoyaltyBox();
        renderTotalsInCheckout();
      })();
    }

    $$('#sheetBody [data-pay]').forEach((btn) => btn.onclick = () => {
      /* A disabled card must not become selectable just because some browser
         still fires the handler. */
      if (btn.disabled) return;
      state.payChosen = true;
      state.payMethod = btn.dataset.pay;
      $$('#sheetBody [data-pay]').forEach((x) => x.classList.toggle('on', x.dataset.pay === state.payMethod));
      $('#payHint').textContent = payHintText();
      renderTotalsInCheckout();
    });
    $('#placeOrder').onclick = placeOrder;
  }

  /* Two ways to run Stripe:
       backend — the server creates the session, so the amount is pre-filled
                 and the guest types nothing.
       link    — a plain Payment Link where the guest types the amount, so we
                 show it big with a Copy button to avoid a mistyped total. */
  function renderStripeBox() {
    const box = $('#stripeBox');
    if (!box) return;
    if (state.payMethod !== 'stripe') { box.innerHTML = ''; return; }

    const mode = stripeMode();

    if (mode === 'backend') {
      box.innerHTML =
        '<div class="pay-note secure">' +
          '<div class="pn-label">Secure card checkout</div>' +
          '<div class="pn-amount"><span>' + money(grandTotal()) + '</span></div>' +
          '<div class="pn-hint">Your total is filled in automatically — nothing to type. ' +
            'Pay by card, Apple Pay or Google Pay on Stripe\'s page, then you\'ll be brought back here.</div>' +
        '</div>';
      return;
    }

    if (mode === 'link') {
      box.innerHTML =
        '<div class="pay-note">' +
          '<div class="pn-label">Type this amount on the Stripe page</div>' +
          '<div class="pn-amount"><span>' + money(grandTotal()) + '</span>' +
            '<button type="button" class="pn-copy" id="copyAmt">Copy</button></div>' +
          '<div class="pn-hint">Stripe opens in a new tab. Enter the amount, pay, then come back here — ' +
            'your order is already with the kitchen.</div>' +
        '</div>';

      const btn = $('#copyAmt');
      if (btn) btn.onclick = () => {
        const txt = grandTotal().toFixed(2);
        const done = () => { btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
        } else fallbackCopy(txt, done);
      };
      return;
    }

    box.innerHTML = '';
  }
  function fallbackCopy(txt, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      ta.remove(); done();
    } catch (e) { toast('Amount: ' + txt, 'ok'); }
  }

  function renderTotalsInCheckout() {
    const box = $('#checkoutTotals');
    if (!box) return;
    box.innerHTML =
      '<div class="trow"><span>Subtotal</span><b>' + money(cartSubtotal()) + '</b></div>' +
      deliveryRowHTML() +
      discountRowHTML() +
      '<div class="trow"><span>Tax</span><b>' + money(taxAmount()) + '</b></div>' +
      (tipAmount() ? '<div class="trow"><span>Tip</span><b>' + money(tipAmount()) + '</b></div>' : '') +
      (surcharge() ? '<div class="trow"><span>Card fee</span><b>' + money(surcharge()) + '</b></div>' : '') +
      '<div class="trow grand"><span>Total</span><b>' + money(grandTotal()) + '</b></div>';
    const f = $('#sheetFoot');
    if (f) {
      f.innerHTML = '<div class="total"><small>Total</small><b>' + money(grandTotal()) + '</b></div>' +
        '<button class="btn btn-primary" id="placeOrder">Place Order · ' + money(grandTotal()) + '</button>';
      $('#placeOrder').onclick = placeOrder;
    }
    renderStripeBox();
  }

  function payHintText() {
    const p = CONFIG.payment[state.payMethod] || {};
    if (state.payMethod === 'stripe') {
      if (stripeMode() === 'none') return '⚠️ Online payment is not configured yet — see CONFIG.payment.stripe in assets/config.js.';
      return 'Card, Apple Pay and Google Pay accepted.';
    }
    if (state.payMethod === 'counter') {
      if (counterBlockedByDelivery()) {
        /* Reachable only when delivery is on, the counter is refused, and no
           online method is configured to fall back to. The guest must not be
           left believing a counter-paid delivery went through. */
        return onlinePayMethod()
          ? 'Delivery orders must be paid online. Choose a method above to continue.'
          : '⚠️ Delivery must be paid online, but no online payment is set up yet. Please call ' + CONFIG.store.phone + '.';
      }
      return 'Your order goes straight to the kitchen. Pay when you pick up.';
    }
    if (state.payMethod === 'venmo') return 'You\'ll be sent to @' + p.handle + ' on Venmo to pay ' + money(grandTotal()) + '.';
    if (state.payMethod === 'zelle') return 'Send ' + money(grandTotal()) + ' to ' + p.recipient + ' via Zelle, then show the confirmation.';
    return '';
  }
  function updatePayHint() { const h = $('#payHint'); if (h) h.textContent = payHintText(); }

  /* ------------------------------------------------------------------ */
  /* Place order                                                         */
  /* ------------------------------------------------------------------ */

  /* A random per-order token. The server keys order creation on it, so the
     same order can be POSTed more than once (a retry, or the trip back from
     Stripe) without ever creating a duplicate — and we can always ask the
     server which number it ended up with. */
  function orderToken() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'tk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Resolve no later than `ms`, even if the promise never settles. A hung
     request must never trap the guest on the checkout screen or the redirect. */
  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => finish(null), ms);
      Promise.resolve(promise).then(finish, () => finish(null));
    });
  }

  /* The SERVER owns order numbers (see server.js). We still suggest one so the
     usual case reads nicely, but if another guest on another phone already took
     that number the server hands back a different one and we adopt it here —
     updating the order everywhere it is remembered. Without this, two guests
     ordering at the same time would both be "KP-...-001" and their orders would
     be merged on the kitchen board. */
  function nextOrderNo() {
    let seq = 1;
    try {
      const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
      const raw = JSON.parse(localStorage.getItem(LS_SEQ) || '{}');
      if (raw.day === today) seq = (raw.n || 0) + 1;
      localStorage.setItem(LS_SEQ, JSON.stringify({ day: today, n: seq }));
      const d = new Date();
      return 'KP-' + d.getFullYear().toString().slice(2) +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') + '-' + String(seq).padStart(3, '0');
    } catch (e) {
      return 'KP-' + Date.now().toString().slice(-6);
    }
  }

  async function placeOrder() {
    const name = ($('#cName') || {}).value?.trim() || '';
    const phone = ($('#cPhone') || {}).value?.trim() || '';
    const email = ($('#cEmail') || {}).value?.trim() || '';
    if (!name) { toast('Please enter your name', 'err'); $('#cName').focus(); return; }
    if (phone.replace(/\D/g, '').length < 7) { toast('Please enter a valid mobile number', 'err'); $('#cPhone').focus(); return; }
    /* E-mail is now required: it is how we tell the guest their order is ready,
       and it is their reward enrollment contact. Catch a missing or malformed
       address here so the order never goes through without one. */
    if (!email) {
      toast('Please enter your e-mail — we send order updates there.', 'err');
      $('#cEmail').focus();
      return;
    }
    if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(email)) {
      toast('That e-mail does not look right — please check it.', 'err');
      $('#cEmail').focus();
      return;
    }
    if (state.orderType === 'delivery' && !schedulePayload()) {
      toast('Please pick a delivery date and time.', 'err');
      return;
    }
    /* The live distance check refused this address. Do not submit: the server
       would refuse it again (geo.js is the real gate), and the guest has
       already been shown the reason and the way out. An EMPTY check (nothing
       typed, or the check itself failed) is not a refusal and passes — that
       verdict belongs to the server. */
    if (state.orderType === 'delivery' && state.deliveryGeo.status === 'blocked') {
      toast(state.deliveryGeo.msg || 'That address is outside our delivery area. Please choose Pickup.', 'err');
      return;
    }

    state.customer = {
      name, phone, email,
      when: ($('#cWhen') || {}).value?.trim() || '',
      notes: ($('#cNotes') || {}).value?.trim() || ''
    };

    const order = {
      no: nextOrderNo(),
      token: orderToken(),
      /* The proof that THIS browser placed this order. Hashed on the server and
         never handed back; it is what lets the guest collect a membership
         credential for their number once this order is paid. */
      claim: newClaimSecret(),
      at: new Date().toISOString(),
      orderType: state.orderType,
      table: state.table || '',
      customer: state.customer,
      items: state.cart.map((it) => ({
        kind: it.kind, name: it.name, qty: it.qty, unit: it.unit, mods: it.mods, addons: it.addons, note: it.note
      })),
      subtotal: cartSubtotal(),
      deliveryFee: deliveryFee(),
      schedule: schedulePayload(),
      tax: taxAmount(),
      tip: tipAmount(),
      surcharge: surcharge(),
      total: grandTotal(),
      /* Sent so the server can resolve and price the discount itself. It is
         also where a code gets SPENT and where loyalty points leave the
         guest's balance — an order that is never recorded must not burn
         either. `loyalty` is a WISH ("use my points"), never an amount. */
      couponCode: state.discountCode || '',
      loyalty: loyaltyPayload(),
      discountAmount: discountAmount(),
      discountCode: state.discountCode || '',
      discountLabel: state.discountLabel || '',
      payMethod: state.payMethod,
      /* Explicit, never inferred later. 'counter' = nothing owed online yet.
         Online methods start unconfirmed until the server checks with Stripe. */
      paymentStatus: state.payMethod === 'counter' ? 'counter' : 'unverified',
      paid: false,
      store: CONFIG.store.name
    };

    state.order = order;
    try { localStorage.setItem(LS_LAST, JSON.stringify(order)); } catch (e) {}

    const p = CONFIG.payment[state.payMethod] || {};
    const mode = state.payMethod === 'stripe' ? stripeMode() : 'none';

    /* ---- Backend checkout -------------------------------------------------
       The server recomputes the price from the menu and hands back a Stripe
       session with the amount already filled in, so the guest types nothing
       and cannot alter what they pay. */
    if (mode === 'backend') {
      const btn = $('#placeOrder');
      btnBusy(btn, 'Starting secure checkout…');
      try {
        const res = await fetch(checkoutUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderNo: order.no,
            orderType: order.orderType,
            table: order.table,
            items: state.cart.map((it) => ({
              kind: it.kind, name: it.name, qty: it.qty,
              mods: it.mods, addons: it.addons, note: it.note
            })),
            tipAmount: tipAmount(),
            couponCode: state.discountCode || '',
            loyalty: loyaltyPayload(),
            customer: order.customer,
            schedule: schedulePayload()
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) throw new Error(data.message || 'Could not start checkout');

        /* The server is the source of truth for money. Adopt its numbers so the
           ticket we show on return matches, to the cent, what Stripe charged. */
        if (data.breakdown) {
          order.subtotal = data.breakdown.subtotal;
          order.deliveryFee = data.breakdown.delivery;
          order.tax = data.breakdown.tax;
          order.tip = data.breakdown.tip;
          order.discountAmount = data.breakdown.discount || 0;
          order.discountCode = data.breakdown.discountCode || '';
          order.discountLabel = data.breakdown.discountLabel || '';
        }
        if (typeof data.total === 'number') order.total = data.total;
        order.payMethod = 'stripe';
        /* Still NOT paid — the guest is about to be handed to Stripe. The
           status is settled when they come back and we verify the session. */
        order.paymentStatus = 'pending';
        order.paid = false;
        order.sessionId = data.id || '';
        /* payment_intent is null at creation time for hosted checkout; Stripe
           creates it lazily when the guest starts the flow. We store it if
           present so verification can use the PI directly (more reliable). */
        order.paymentIntent = data.paymentIntent || null;

        // keep the order so the ticket can be shown when Stripe sends us back
        try { localStorage.setItem(LS_PENDING, JSON.stringify(order)); } catch (e) {}
        try { localStorage.setItem(LS_LAST, JSON.stringify(order)); } catch (e) {}

        /* Let the server confirm (and, if needed, re-number) the order BEFORE we
           send the guest to Stripe. If we skipped this, a re-numbered order
           would come back carrying our local number and the confirmation would
           PATCH the wrong order on the board. Bounded so a slow server can
           never block checkout. */
        await withTimeout(recordOrder(order), 6000);

        /* Same rule as the counter path: never hand a REFUSED order to Stripe,
           or the guest would pay for food nobody is going to cook. */
        if (order.__rejected) {
          btnRestore(btn);
          toast(order.__rejected.message || 'Could not place that order.', 'err');
          return;
        }

        dispatchOrder(order);
        /* Save it before we leave for Stripe, so the guest can find it in
           Recent Orders even if they never come back to this tab. The return
           leg refreshes it with the verified payment status. */
        saveHistory(order);

        state.cart = [];
        saveCart();
        window.location.href = data.url;
        return;
      } catch (e) {
        btnRestore(btn);
        toast(e.message || 'Could not start checkout', 'err');
        return;
      }
    }

    /* ---- No server involved: show the ticket straight away ---------------- */

    /* Open any external payment page FIRST, while we are still inside the
       click's user-gesture — awaiting the server before window.open() would
       let the browser's popup blocker swallow it. */
    if (mode === 'link') {
      window.open(p.paymentLink, '_blank', 'noopener');
    } else if (state.payMethod === 'venmo' && p.handle) {
      const url = 'https://venmo.com/' + encodeURIComponent(p.handle) +
        '?txn=pay&amount=' + order.total.toFixed(2) + '&note=' + encodeURIComponent('KPOT order ' + order.no);
      window.open(url, '_blank', 'noopener');
    }

    /* Wait for the server to assign the final order number before drawing the
       ticket, so the number the guest reads is the number the kitchen sees.
       The button goes busy for the whole wait. It used to stay live here, so a
       guest double-tapping while the server was slow recorded TWO orders —
       the spinner is the visible half of that fix, the tap lock the other. */
    btnBusy($('#placeOrder'), 'Submitting…');
    await withTimeout(recordOrder(order), 6000);

    /* The server refused it. Do NOT draw a ticket: the kitchen never got the
       order, and a ticket would send the guest away believing it did. Leave
       the cart intact so they can fix it and try again. */
    if (order.__rejected) {
      btnRestore($('#placeOrder'));
      const rej = order.__rejected;
      if (rej.error === 'counter_over_cap' || rej.error === 'counter_not_allowed_delivery') {
        const alt = onlinePayMethod();
        if (alt) state.payMethod = alt;
        openCheckout();
      }
      /* A schedule refusal (slot full, outside hours, …) leaves the guest on
         the checkout sheet — point it at the picker so they can pick again. */
      if (rej.error && rej.error.indexOf('schedule') === 0) {
        state.schedule = null;
        state.scheduleState = 'err';
        state.scheduleMsg = rej.message || 'That delivery time is no longer available.';
        renderScheduleBox();
        bindScheduleBox();
      }
      toast(rej.message || 'We could not place that order. Please try again.', 'err');
      return;
    }

    dispatchOrder(order);
    /* Remember it on this device so the guest can look the order up later. */
    saveHistory(order);

    state.cart = [];
    saveCart();
    closeSheet();
    renderShell();
    renderMenu();
    syncCartUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Order ' + order.no + ' placed!', 'ok');
  }

  function dispatchOrder(order) {
    const d = CONFIG.dispatch || {};
    if (d.webhookUrl) {
      try {
        fetch(d.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order)
        }).catch(() => {});
      } catch (e) {}
    }
  }

  /* ---- Order board integration -----------------------------------------
     These only do anything when the page is running behind our Node server
     (state.backend). On a plain static host there is no board to talk to, so
     they no-op and the app behaves exactly as before. */

  /* Record the order on the owner's live board. The server re-prices it and is
     the source of truth for the ORDER NUMBER: if another guest already took the
     number we suggested, the server hands back a different one. We adopt it —
     re-keying the order and its saved copies — so the ticket, the live-status
     poll and the payment-return PATCH all point at the right order.
     Resolves with the (possibly re-numbered) order. */
  function recordOrder(order) {
    if (!state.backend || !order) return Promise.resolve(order);
    return fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    }).then((r) => r.json().catch(() => null).then((j) => ({ r: r, j: j })))
      .then((out) => {
        if (out.r && out.r.ok && out.j && out.j.id) { adoptServerNo(order, out.j.id); return order; }
        /* A definite refusal (an over-cap counter order, a closed store, a bad
           payload) is NOT a network hiccup — the order really was not
           recorded. Flag it so the caller stops instead of drawing a ticket
           for food the kitchen will never make.
           A network failure is left unflagged on purpose: we cannot tell
           whether the order landed, and blocking the guest would be worse. */
        if (out.r && out.r.status >= 400 && out.r.status < 500 && out.j && out.j.error) {
          order.__rejected = { error: out.j.error, message: out.j.message || '' };
        }
        return order;
      })
      .catch(() => order);
  }

  /* The server gave this order a number different from the one we suggested.
     Update the order object and every place it was stashed, so nothing
     downstream keeps using the stale number. */
  function adoptServerNo(order, id) {
    order._serverId = id;
    if (order.no === id) return;
    const oldNo = order.no;
    order.no = id;
    try { if (state.order && state.order.token === order.token) state.order.no = id; } catch (e) {}
    try { localStorage.setItem(LS_LAST, JSON.stringify(order)); } catch (e) {}
    try { historyRekey(oldNo, order); } catch (e) {}
    try {
      const pending = JSON.parse(localStorage.getItem(LS_PENDING) || 'null');
      if (pending && pending.token && pending.token === order.token) {
        localStorage.setItem(LS_PENDING, JSON.stringify(order));
      }
    } catch (e) {}
  }

  /* Removed: patchOrderStatus(). It PATCHed /api/orders/:id from the guest's
     page, but that endpoint is admin-gated, so every call came back 401 —
     which is how a paid order ended up stuck as UNPAID on the kitchen board.
     The server settles the board itself inside /api/verify-session. Do not
     reintroduce a guest-side PATCH here: it cannot work, and it fails
     silently. */

  /* Customer-facing live status on the ticket. Polls the server so the guest
     sees "Being prepared" -> "Ready for pickup" without us needing SMS/push
     (works with zero external services). */
  const STATUS_CUSTOMER = {
    received: { text: 'We received your order — the kitchen will start it shortly.', emoji: '📋' },
    preparing: { text: 'Your order is being prepared', emoji: '👩‍🍳' },
    ready: { text: 'Your order is ready! Come pick it up', emoji: '🛎️' },
    completed: { text: 'Thanks! Enjoy your meal', emoji: '🙏' },
    cancelled: { text: 'This order was cancelled. Please ask at the counter.', emoji: '⚠️' }
  };
  let watchTimer = null;
  function startOrderWatch(order) {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (!state.backend || !order || !order.no) return;
    const id = order.no;
    const tick = () => {
      fetch('/api/orders/' + encodeURIComponent(id))
        .then((r) => r.json().catch(() => null))
        /* The whole payload, not just the status: the rewards strip also needs
           to know whether the PAYMENT was confirmed, which can happen while the
           guest is sitting here (their return from Stripe). */
        .then((j) => { if (j && j.status) updateOrderWatch(j); })
        .catch(() => {});
    };
    tick();
    watchTimer = setInterval(tick, 5000);
  }
  function updateOrderWatch(j) {
    const status = j.status;
    /* Keep this device's order history in step with what the ticket is showing,
       so the Recent Orders list never disagrees with the screen the guest is
       looking at. Only write when it actually changed — this runs every 5s. */
    if (state.order && state.order.status !== status) {
      state.order.status = status;
      saveHistory(state.order);
    }
    /* Ask again for the rewards only when the payment verdict actually moved —
       not on every poll, which would be a request every 5 seconds forever. */
    if (j.paymentStatus && state.order && state.order.paymentStatus !== j.paymentStatus) {
      state.order.paymentStatus = j.paymentStatus;
      saveHistory(state.order);
      renderTicketLoyalty(state.order);
      /* A pay-at-counter order is settled by staff while the guest is sitting
         on this screen — which is the only chance this browser gets to turn
         that payment into a credential. claimDevice() is a no-op once we hold
         one, and retries itself while the order is still unpaid. */
      if (j.paymentStatus === 'paid' || j.paymentStatus === 'verified') claimDevice(state.order);
    }
    const box = $('#tkStatus');
    if (!box) return;
    const s = STATUS_CUSTOMER[status] || STATUS_CUSTOMER.received;
    box.className = 'tk-status st-' + status;
    box.innerHTML =
      '<div class="ts-row"><span class="ts-emoji">' + s.emoji + '</span>' +
      '<div class="ts-txt"><b>' + esc(s.text) + '</b>' +
      '<small>Live status · ' + esc(status) + '</small></div></div>';
    if (status === 'ready') {
      box.classList.add('ready-pulse');
      if (CONFIG.features.sounds) chime();
      const no = state.order && state.order.no;
      if (no && notifiedReadyFor !== no) {
        notifiedReadyFor = no;
        showReadyNotification(state.order);
      }
    }
  }

  /* ---- Recent orders (per-device history) -------------------------------
     A guest who closes the tab should still be able to look up "did my order
     go through, and is it ready yet?". We keep their own orders on THIS device
     in localStorage.

     It is deliberately local-only. The server's order endpoint is public but
     answers about ONE id you already know — there is no "list every order"
     endpoint for guests, so this can never leak another guest's data. The
     trade-off is honest and we say so in the UI: orders placed on a different
     phone (or after clearing site data) won't appear here. */
  const HISTORY_MAX = 20;
  const ACTIVE_STATUSES = ['received', 'preparing', 'ready'];

  function loadHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeHistory(arr) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(0, HISTORY_MAX))); } catch (e) {}
  }

  /* Keep only what the ticket and the list actually render. */
  function trimForHistory(o) {
    return {
      no: o.no, token: o.token || '', at: o.at || new Date().toISOString(),
      orderType: o.orderType || 'pickup', table: o.table || '',
      customer: o.customer || {},
      items: o.items || [],
      subtotal: o.subtotal, deliveryFee: o.deliveryFee, tax: o.tax, tip: o.tip,
      surcharge: o.surcharge, total: o.total,
      payMethod: o.payMethod, paymentStatus: o.paymentStatus, paid: !!o.paid,
      sessionId: o.sessionId || '', paymentIntent: o.paymentIntent || null,
      status: o.status || 'received',
      store: o.store || CONFIG.store.name
    };
  }

  /* Insert or update an order, newest first. Matched on the token when we have
     one — it survives the server re-numbering the order — else on the number. */
  function saveHistory(order) {
    if (!order || !order.no) return;
    const arr = loadHistory();
    const i = arr.findIndex((o) =>
      (order.token && o.token === order.token) || o.no === order.no);
    const rec = trimForHistory(order);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], rec);
    else arr.unshift(rec);
    writeHistory(arr);
    syncHistoryUI();
  }

  /* The server re-numbered this order; follow it here too, or the guest's list
     would point at a number that never existed. */
  function historyRekey(oldNo, order) {
    const arr = loadHistory();
    const i = arr.findIndex((o) => o.no === oldNo || (order.token && o.token === order.token));
    if (i < 0) return;
    arr[i] = Object.assign({}, arr[i], trimForHistory(order));
    writeHistory(arr);
    syncHistoryUI();
  }

  /* The top-bar button only appears once there is something to look at, and its
     badge counts orders still in progress — the number a guest cares about. */
  function syncHistoryUI() {
    const btn = $('#histBtn');
    if (!btn) return;
    const arr = loadHistory();
    btn.hidden = arr.length === 0;
    const n = arr.filter((o) => ACTIVE_STATUSES.indexOf(o.status) >= 0).length;
    const badge = $('#histBadge');
    if (badge) {
      badge.textContent = n;
      badge.classList.toggle('on', n > 0);
    }
  }

  function historyStatusOf(o) {
    const s = o.status || 'received';
    return STATUS_CUSTOMER[s] ? s : 'received';
  }

  function historyRowHTML(o) {
    const s = historyStatusOf(o);
    const meta = STATUS_CUSTOMER[s];
    const d = new Date(o.at);
    const whenTxt = isNaN(d.getTime()) ? '' :
      d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const nItems = (o.items || []).reduce((n, it) => n + (it.qty || 0), 0);
    const live = ACTIVE_STATUSES.indexOf(s) >= 0;
    return '<button class="hist-row" data-hist="' + esc(o.no) + '">' +
      '<span class="hr-ic' + (live ? ' live' : '') + '">' + meta.emoji + '</span>' +
      '<span class="hr-mid">' +
        '<b>' + esc(o.no) + '</b>' +
        '<small>' + esc(whenTxt) + ' · ' + nItems + ' item' + (nItems === 1 ? '' : 's') +
          ' · ' + money(o.total) + '</small>' +
        '<small class="hr-st' + (live ? ' live' : '') + '">' + esc(meta.text) + '</small>' +
      '</span>' +
      '<span class="hr-go">›</span>' +
    '</button>';
  }

  function renderHistorySheet() {
    if (state.sheet !== 'history') return;
    const body = $('#sheetBody');
    if (!body) return;
    const arr = loadHistory();
    const prev = body.scrollTop;
    body.innerHTML = arr.length
      ? '<div class="hist-list">' + arr.map(historyRowHTML).join('') + '</div>' +
        '<p class="hist-note">Orders placed on this device. Tap one to reopen its ticket and ' +
        'see the live status.</p>'
      : '<div class="empty"><div class="em">🧾</div><b>No orders yet</b>' +
        '<p>Orders you place here will show up so you can check on them later.</p></div>';
    body.scrollTop = prev;
    $$('#sheetBody [data-hist]').forEach((el) => {
      el.onclick = () => openHistoryOrder(el.dataset.hist);
    });
    /* Refresh from the server in the background, then redraw if anything moved. */
    refreshHistoryStatuses().then((changed) => { if (changed) renderHistorySheet(); });
  }

  function openHistorySheet() {
    state.sheet = 'history';
    openSheet('Recent Orders', '', '', { sub: 'Status updates live from the kitchen' });
    renderHistorySheet();
  }

  /* Ask the server for the current status of the orders we are still tracking.
     Only the id goes out; the endpoint answers about one order at a time and is
     public by design, so this can't expose anyone else's data. Orders in a
     terminal state (completed / cancelled) are never re-fetched. */
  function refreshHistoryStatuses() {
    if (!state.backend) return Promise.resolve(false);
    const stale = loadHistory().filter((o) => o.no && ACTIVE_STATUSES.indexOf(o.status) >= 0);
    if (!stale.length) return Promise.resolve(false);
    return Promise.all(stale.map((o) =>
      fetch('/api/orders/' + encodeURIComponent(o.no))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.status ? { no: o.no, status: j.status, paymentStatus: j.paymentStatus } : null))
        .catch(() => null)
    )).then((hits) => {
      const found = hits.filter(Boolean);
      if (!found.length) return false;
      const cur = loadHistory();
      let changed = false;
      found.forEach((h) => {
        const i = cur.findIndex((o) => o.no === h.no);
        if (i >= 0 && (cur[i].status !== h.status ||
                       (h.paymentStatus && cur[i].paymentStatus !== h.paymentStatus))) {
          cur[i].status = h.status;
          if (h.paymentStatus) cur[i].paymentStatus = h.paymentStatus;
          changed = true;
        }
      });
      if (changed) { writeHistory(cur); syncHistoryUI(); }
      return changed;
    });
  }

  /* Reopen a past order exactly like the ticket the guest saw when they placed
     it — including the live-status poll, so the badge keeps updating. */
  function openHistoryOrder(no) {
    const o = loadHistory().find((x) => x.no === no);
    if (!o) { toast('That order is no longer saved on this device', 'err'); return; }
    closeSheet();
    state.order = o;
    try { localStorage.setItem(LS_LAST, JSON.stringify(o)); } catch (e) {}
    renderMenu();                      // -> renderTicket(), because state.order is set
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---- Phone notification when the order is ready ----------------------
     A real OS notification in the guest's notification tray (not just the
     in-page chime). Uses the browser's Notification API — zero dependencies.
     It fires from the same 5s poll above, so it needs the ticket page to be
     open (Android Chrome still shows it with the tab in the background). On
     iOS, Web Notifications require the page to be added to the Home Screen;
     we detect that and show a hint instead of a dead button. */
  const LS_NOTIFY = 'kpot.notify.v1';
  /* Two assets, because a notification uses the icon in two very different ways.
     `icon` is the large thumbnail: a red disc on a TRANSPARENT square, so a
     rounded/circular thumbnail doesn't clip a red square into a broken shape.
     `badge` is the tiny status-bar mark, which Android/Linux draw as an ALPHA
     MASK — the colour is discarded and only the shape survives. So it has to be
     a transparent PNG with the glyph in opaque pixels; an opaque full-colour
     tile masks out to a solid blob (the small white box the owner saw). */
  const NOTIFY_ICON = 'assets/icon-notify-192.png';
  const NOTIFY_BADGE = 'assets/icon-notify-badge.png';
  let notifiedReadyFor = null;

  function notifySupported() { return typeof window !== 'undefined' && 'Notification' in window; }
  function notifyPerm() { return notifySupported() ? Notification.permission : 'unsupported'; }

  function notifyUIHTML() {
    if (!notifySupported()) {
      return '<div class="notify-row">🔔 Want a phone alert when your order is ready? Add this page to your Home Screen first.</div>';
    }
    const p = notifyPerm();
    if (p === 'granted') return '<div class="notify-row on">🔔 Notifications on — we\'ll buzz you when your order is ready.</div>';
    if (p === 'denied') return '<div class="notify-row off">🔕 Notifications are blocked for this site. Enable them in your browser settings to be alerted.</div>';
    return '<button class="btn btn-ghost" id="notifyBtn">🔔 Notify me when it\'s ready</button>';
  }

  function bindNotify() {
    const b = $('#notifyBtn');
    if (b) b.onclick = requestNotify;
  }

  function requestNotify() {
    if (!notifySupported()) return;
    try {
      Promise.resolve(Notification.requestPermission()).then((p) => {
        try { localStorage.setItem(LS_NOTIFY, p === 'granted' ? '1' : '0'); } catch (e) {}
        const slot = $('#notifySlot');
        if (slot) { slot.innerHTML = notifyUIHTML(); bindNotify(); }
        /* Fire one right away so the guest can see it works. */
        if (p === 'granted') showReadyNotification(state.order);
      });
    } catch (e) {}
  }

  function showReadyNotification(order) {
    if (!notifySupported() || notifyPerm() !== 'granted') return;
    const no = order && order.no ? order.no : '';
    try {
      const n = new Notification('🛎️ Your order is ready!', {
        body: (no ? 'Order ' + no + ' — ' : '') + 'Come pick it up at the counter.',
        tag: 'kpot-' + (no || 'order'),
        icon: NOTIFY_ICON,
        badge: NOTIFY_BADGE,
        requireInteraction: true
      });
      n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
    } catch (e) {}
  }

  /* ---- Add to Home Screen (so phone notifications can reach them) -------
     On iPhone, web notifications only work once the page is added to the Home
     Screen, so this nudges the guest to do that — with the native install
     prompt on Android, and clear Share-sheet instructions on iOS. */
  const LS_A2HS = 'kpot.a2hs.v1';
  let deferredInstall = null;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isMobile() { return isIOS() || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent); }

  function a2hsDismissed() {
    try {
      const t = Number(localStorage.getItem(LS_A2HS) || 0);
      if (t === -1) return true;                       // installed / dismissed forever
      return Date.now() - t < 3 * 24 * 3600 * 1000;    // snooze 3 days
    } catch (e) { return false; }
  }
  function dismissA2HS(forever) {
    try { localStorage.setItem(LS_A2HS, String(forever ? -1 : Date.now())); } catch (e) {}
    const el = $('#installBanner'); if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  function installBannerHTML() {
    const head = '<div class="ib-txt"><b>📲 Add KPOT To Go to your Home Screen</b><small>';
    if (isIOS()) {
      return head + 'Tap the <b>Share</b> button ⬆️ in Safari, then <b>Add to Home Screen</b>. ' +
        'That way you get a phone notification the moment your order is ready.</small></div>' +
        '<div class="ib-actions"><button class="ib-close" data-a2hs="close">Got it</button></div>';
    }
    if (deferredInstall) {
      return head + 'Get a phone notification the moment your order is ready — no app store needed.</small></div>' +
        '<div class="ib-actions"><button class="ib-btn" data-a2hs="install">Add</button>' +
        '<button class="ib-close" data-a2hs="close">Not now</button></div>';
    }
    return head + 'Open your browser menu (⋮) and choose <b>Add to Home Screen</b> to get a ' +
      'notification when your order is ready.</small></div>' +
      '<div class="ib-actions"><button class="ib-close" data-a2hs="close">Got it</button></div>';
  }

  function showInstallBanner() {
    if (isStandalone() || a2hsDismissed()) return;
    if (!isMobile()) return;   // phone-only nudge — that's where notifications matter
    const el = $('#installBanner');
    if (!el) return;
    el.innerHTML = installBannerHTML();
    el.hidden = false;
  }

  function initInstall() {
    /* Register the service worker (makes the app installable; also the channel
       for future Web Push). Ignored on insecure origins. */
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {}
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstall = e;
      showInstallBanner();
    });
    window.addEventListener('appinstalled', () => { deferredInstall = null; dismissA2HS(true); });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a2hs]');
      if (!b) return;
      if (b.dataset.a2hs === 'install' && deferredInstall) {
        try {
          deferredInstall.prompt();
          if (deferredInstall.userChoice) {
            deferredInstall.userChoice.then(() => { deferredInstall = null; dismissA2HS(true); });
          } else { deferredInstall = null; dismissA2HS(true); }
        } catch (err) { dismissA2HS(false); }
      } else {
        dismissA2HS(false);
      }
    });
    showInstallBanner();
  }

  /* ---- Store open / stop-sales gate ------------------------------------ */
  let storeBannerEl = null;
  function ensureStoreBanner() {
    if (storeBannerEl) return storeBannerEl;
    const b = document.createElement('div');
    b.id = 'storeBanner';
    b.className = 'store-banner';
    b.hidden = true;
    const app = $('#app') || document.body;
    app.insertBefore(b, app.firstChild);
    storeBannerEl = b;
    return b;
  }
  /* Is this order type available right now? When we have not heard from the
     server, everything is available — the alternative is hiding the menu from
     every guest because one fetch failed. */
  function orderTypeAvailable(t) {
    if (!state.orderTypes) return true;
    return state.orderTypes[t] !== false;
  }
  /* Types the guest can actually pick, in CONFIG order. */
  function availableOrderTypes() {
    return CONFIG.orderTypes.filter((o) =>
      (o.id !== 'delivery' || deliveryOn()) && orderTypeAvailable(o.id));
  }
  /* The type we should be on: the guest's choice if it is still available,
     otherwise the first one that is. Returns null when nothing is orderable. */
  function resolveOrderType() {
    const avail = availableOrderTypes();
    if (!avail.length) return null;
    if (avail.some((o) => o.id === state.orderType)) return state.orderType;
    return avail[0].id;
  }

  function ordersBlocked() {
    if (state.acceptingOrders === false) return { blocked: true, reason: 'not accepting orders' };
    if (state.storeOpen === false) return { blocked: true, reason: 'closed' };
    /* Every channel switched off individually is, for the guest, the same as
       the store being shut — there is nothing they can order. */
    if (!availableOrderTypes().length) return { blocked: true, reason: 'no order types' };
    /* The currently selected channel was switched off (possibly mid-session,
       by the owner, while this page was open). */
    if (!orderTypeAvailable(state.orderType)) return { blocked: true, reason: 'type unavailable' };
    return { blocked: false };
  }

  function applyStoreStatus(store) {
    if (!store) return;
    state.acceptingOrders = store.acceptingOrders !== false;
    /* The store is open only when BOTH the owner's manual switch AND the
       configured business hours (computed on the server clock) say so. This
       is the bug fix: previously state.storeOpen tracked only the manual
       switch, so the badge said closed but ordering still went through. */
    state.storeOpen = store.open !== false && store.openNow !== false;
    if (store.orderTypes && typeof store.orderTypes === 'object') {
      state.orderTypes = store.orderTypes;
    }

    /* If the owner switched off the channel this guest had chosen, move them
       to one that is still open rather than leaving them on a dead card. */
    const next = resolveOrderType();
    if (next) state.orderType = next;

    const b = ensureStoreBanner();
    const blk = ordersBlocked();
    if (blk.blocked) {
      b.hidden = false;
      if (!state.storeOpen) {
        b.textContent = '🔒 We are currently closed for ordering.';
      } else if (!state.acceptingOrders) {
        b.textContent = '⏸️ We are temporarily not accepting online orders. Please call or visit us.';
      } else if (!availableOrderTypes().length) {
        b.textContent = '⏸️ We are not taking online orders right now. Please call or visit us.';
      } else {
        const nm = (CONFIG.orderTypes.find((o) => o.id === state.orderType) || {}).n || 'That option';
        b.textContent = '⏸️ ' + nm + ' is not available right now — please pick another option.';
      }
    } else {
      b.hidden = true;
    }

    /* Repaint the order-type row. This must happen even when the selected type
       did not change: switching Delivery off does not move a guest who is on
       Pickup, but their Delivery card still has to be marked unavailable.
       Earlier this only re-rendered when the selection moved, so a disabled
       channel stayed looking perfectly clickable — the click was refused
       underneath, which is the worst of both worlds.

       Guarded because applyStoreStatus() can run before the shell exists. */
    try { renderShell(); } catch (e) { /* shell not ready yet */ }
    syncCartUI();
  }
  function checkStoreStatus() {
    if (!state.backend) return;
    fetch('/api/store')
      .then((r) => r.json().catch(() => null))
      .then((j) => { if (j) applyStoreStatus(j); })
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Ticket / confirmation                                               */
  /* ------------------------------------------------------------------ */
  function renderTicket() {
    const o = state.order;
    const otName = (CONFIG.orderTypes.find((x) => x.id === o.orderType) || {}).n || o.orderType;
    const payName = (CONFIG.payment[o.payMethod] || {}).n || 'Pay at Counter';

    /* Payment status is explicit and comes from the server's check with Stripe.
       It is never inferred from the payment method name — "they chose Pay
       Online" is not the same as "they paid". Orders written by an older build
       have no paymentStatus; those fall back to unconfirmed rather than paid. */
    const ps = o.paymentStatus || (o.payMethod === 'counter' ? 'counter' : 'unverified');
    const paidOK = ps === 'verified';

    const payLabel = {
      verified: payName + ' ✓',
      counter: payName + ' · due',
      unverified: payName + ' · unconfirmed',
      unpaid: 'Not confirmed · pay at counter'
    }[ps] || (payName + ' · unconfirmed');

    /* A guest who is not confirmed as paid must be told plainly, on the ticket
       itself, so the counter conversation is easy. */
    const payBanner =
      paidOK
        ? '<div class="pay-flag ok">✓ Payment confirmed by Stripe</div>'
        : ps === 'unpaid'
          ? '<div class="pay-flag warn">⚠️ We could not confirm an online payment for this order. Please pay at the counter.</div>'
          : ps === 'unverified'
            ? '<div class="pay-flag warn">⚠️ Online payment not verified. Please show your payment confirmation at the counter.</div>'
            : '';

    const lines = o.items.map((it) =>
      '<div class="tk-line">' +
        '<span class="q">' + it.qty + '×</span>' +
        '<span class="d">' + esc(it.name) +
          (it.mods && it.mods.length ? '<small>' + it.mods.map(esc).join('<br>') + '</small>' : '') +
          (it.addons && it.addons.length ? '<small>➕ ' + it.addons.map(esc).join(', ') + '</small>' : '') +
          (it.note ? '<small>📝 ' + esc(it.note) + '</small>' : '') +
        '</span>' +
        '<span class="p">' + money(it.unit * it.qty) + '</span>' +
      '</div>').join('');

    const html =
      '<div class="ticket">' +
        '<div class="tk-head">' +
          '<div class="ok' + (paidOK ? '' : ' pending') + '">' + (paidOK ? '✓' : '!') + '</div>' +
          '<h3>' + (paidOK ? 'Order Confirmed' : 'Order Received') + '</h3>' +
          '<p>' + esc(CONFIG.store.name) + ' · ' + esc(otName) + '</p>' +
          '<div class="tk-num">' + esc(o.no) + '</div>' +
          payBanner +
        '</div>' +
        '<div class="tk-status" id="tkStatus"></div>' +
        '<div class="notify-slot no-print" id="notifySlot"></div>' +
        '<div class="tk-meta">' +
          '<div><small>Name</small><b>' + esc(o.customer.name) + '</b></div>' +
          '<div><small>Mobile</small><b>' + esc(o.customer.phone) + '</b></div>' +
          '<div><small>' + (o.orderType === 'dinein' ? 'Table' : 'Time') + '</small><b>' + esc(o.customer.when || (o.table ? 'Table ' + o.table : 'ASAP')) + '</b></div>' +
          '<div><small>Payment</small><b>' + esc(payLabel) + '</b></div>' +
        '</div>' +
        scheduleTicketHTML(o) +
        '<div class="tk-items">' + lines + '</div>' +
        '<div class="tk-tot">' +
          '<div><span>Subtotal</span><span>' + money(o.subtotal) + '</span></div>' +
          (o.deliveryFee ? '<div><span>Delivery</span><span>' + money(o.deliveryFee) + '</span></div>' : '') +
          (Number(o.discountAmount) > 0
            ? '<div><span>' + esc(o.discountLabel || ('Discount' + (o.discountCode ? ' · ' + o.discountCode : ''))) +
              '</span><span>-' + money(o.discountAmount) + '</span></div>'
            : '') +
          '<div><span>Tax</span><span>' + money(o.tax) + '</span></div>' +
          (o.tip ? '<div><span>Tip</span><span>' + money(o.tip) + '</span></div>' : '') +
          (o.surcharge ? '<div><span>Card fee</span><span>' + money(o.surcharge) + '</span></div>' : '') +
          '<div class="g"><span>Total</span><span>' + money(o.total) + '</span></div>' +
        '</div>' +
        /* Rewards. Not marked no-print on purpose: this ticket IS the guest's
           receipt, and the come-back coupon only does its job if they can see
           it — on screen now, and on paper if they print. */
        '<div id="ticketLoyalty"></div>' +
        (o.customer.notes ? '<div class="small" style="padding-top:12px;color:#6B6255"><b>Notes:</b> ' + esc(o.customer.notes) + '</div>' : '') +
      '</div>' +
      '<div class="no-print" style="padding:0 18px 16px">' +
        '<div class="qr-holder">' +
          '<div class="box"><div id="orderQR"></div></div>' +
          '<p>Show this code at the counter</p>' +
        '</div>' +
        '<button class="btn btn-ghost" id="printTicket">🖨️ Print Ticket</button>' +
        '<button class="btn btn-ghost mt8" id="newOrder">＋ Start a New Order</button>' +
        (CONFIG.features.orderAgain ? '<button class="btn btn-ghost mt8" id="reorder">🔁 Order This Again</button>' : '') +
        '<div class="store-foot">' +
          '<a class="sf-row" target="_blank" rel="noopener" href="https://maps.google.com/?q=' +
            encodeURIComponent(CONFIG.store.addressQuery || CONFIG.store.address) + '">' +
            '<span class="sf-ic">📍</span><span>' + esc(CONFIG.store.address) + '</span></a>' +
          '<a class="sf-row" href="tel:' + esc(CONFIG.store.phoneRaw || CONFIG.store.phone) + '">' +
            '<span class="sf-ic">📞</span><span>' + esc(CONFIG.store.phone) + '</span></a>' +
          '<div class="sf-row"><span class="sf-ic">🕐</span><span>' + esc(CONFIG.store.hours) + '</span></div>' +
        '</div>' +
      '</div>';

    $('#menuBody').innerHTML = html;
    $('#tabsWrap').classList.add('hide');
    $('#cartBar').classList.remove('on');
    setOrderView(true);

    /* Fill in the "notify me" control for the current permission state. */
    const nslot = $('#notifySlot');
    if (nslot) nslot.innerHTML = notifyUIHTML();
    bindNotify();

    try {
      if (window.QRCode) {
        new QRCode($('#orderQR'), {
          text: JSON.stringify({ o: o.no, t: o.total, n: o.customer.name, p: o.payMethod }),
          width: 132, height: 132,
          colorDark: '#17161A', colorLight: '#FFFFFF',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    } catch (e) {}

    $('#printTicket').onclick = () => window.print();
    $('#newOrder').onclick = () => {
      state.order = null;
      $('#tabsWrap').classList.remove('hide');
      renderMenu();
    };
    const re = $('#reorder');
    if (re) re.onclick = () => {
      o.items.forEach((it) => state.cart.push(Object.assign({ uid: uid(), sig: uid() }, it)));
      saveCart();
      state.order = null;
      $('#tabsWrap').classList.remove('hide');
      renderMenu();
      openCart();
    };

    /* Keep the live status fresh while the guest sits on this ticket. */
    startOrderWatch(o);
    renderTicketLoyalty(o);
  }

  /* Delivery schedule line on the ticket: the window the guest booked, so
     they can see when to expect the rider without asking the counter. */
  function scheduleTicketHTML(o) {
    if (!o || o.orderType !== 'delivery') return '';
    const parts = [];
    if (o.deliverySlotLabel) parts.push(esc(o.deliverySlotLabel));
    else if (o.deliveryDate) parts.push(esc(o.deliveryDate));
    if (o.scheduledFor && isFinite(o.scheduledFor)) {
      parts.push(new Date(o.scheduledFor).toLocaleString());
    }
    if (!parts.length) return '';
    return '<div class="tk-sched"><small>Delivery</small><b>' + parts.join(' · ') + '</b></div>';
  }

  /* ---- Rewards strip on the guest's own ticket --------------------------
     Fetched fresh rather than derived from the order: the ledger is the
     SERVER's, and this page has no idea how many points the guest had before
     this order. Guessing would be worse than saying nothing.

     On a pay-at-counter order the points land only when staff confirm the
     payment, so until then the strip says so rather than showing a balance
     that has not moved. */
  async function renderTicketLoyalty(o) {
    const el = $('#ticketLoyalty');
    if (!el || !o) return;
    const phone = clientPhone(o.customer && o.customer.phone);
    if (!phone) return;

    let L = null;
    try {
      const r = await fetch('/api/customer?phone=' + encodeURIComponent(phone) +
        '&device=' + encodeURIComponent(deviceFor(phone)));
      if (!r.ok) return;
      L = await r.json();
    } catch (e) { return; }
    if (!L || !L.found) return;

    const R = L.rules || {};
    const s = L.stamps || {};
    const need = (s.every || 0) - (s.into || 0);

    const bits = [];
    if (L.points > 0) bits.push('<b>' + L.points + '</b> point' + (L.points === 1 ? '' : 's'));
    if (need > 0) {
      bits.push(need + ' more order' + (need === 1 ? '' : 's') + ' for a $' + R.stampValue + ' reward');
    }

    const coupons = (L.coupons || []).map((c) =>
      '<div class="loy-coupon">🎁 ' + esc(c.label || 'Reward') +
        (c.expiresAt ? ' <small>· expires ' + new Date(c.expiresAt).toLocaleDateString() + '</small>' : '') +
      '</div>').join('');

    const paidNow = o.paymentStatus === 'verified' || o.paymentStatus === 'paid';
    const member = L.member || {};
    const memberLine = member.is
      ? '<div class="tl-line">⭐ Member' + (member.daysLeft ? ' · ' + member.daysLeft + ' days left' : '') + '</div>'
      : '';

    el.innerHTML = '<div class="ticket-loy">' +
      '<div class="tl-head">⭐ Rewards' + (L.name ? ' · ' + esc(L.name) : '') + '</div>' +
      memberLine +
      (bits.length ? '<div class="tl-line">' + bits.join(' · ') + '</div>' : '') +
      coupons +
      (paidNow ? '' : '<div class="tl-line dim">Points are added once your payment is confirmed.</div>') +
    '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */
  function bindGlobal() {
    $('#cartBtn').onclick = openCart;
    const hb = $('#histBtn');
    if (hb) hb.onclick = openHistorySheet;

    document.addEventListener('click', (e) => {
      const ot = e.target.closest('[data-ot]');
      if (ot) {
        /* A disabled card still receives the click in some browsers even with
           the disabled attribute, so refuse it explicitly rather than trusting
           the attribute alone. */
        if (!orderTypeAvailable(ot.dataset.ot)) {
          toast('That option is not available right now.', 'err');
          return;
        }
        if (ordersBlocked().blocked) {
          toast('We are not accepting orders right now.', 'err');
          return;
        }
        state.orderType = ot.dataset.ot;
        /* A distance verdict belongs to the Delivery channel: keeping a
           'blocked' one would leave a Pickup checkout shown as out of range
           (and Place Order disabled) for an address that is not being
           delivered to at all. */
        state.deliveryGeo = { status: '', miles: null, msg: '', source: '' };
        renderShell();
        syncCartUI();
        if (state.sheet === 'checkout') openCheckout();
        return;
      }
      const tab = e.target.closest('[data-cat]');
      if (tab) {
        state.cat = tab.dataset.cat;
        renderShell();
        renderMenu();
        const y = $('#tabsWrap').offsetTop - 60;
        window.scrollTo({ top: y, behavior: 'smooth' });
        return;
      }
      const build = e.target.closest('[data-build]');
      if (build) {
        if (build.dataset.build === 'hotpot') openHotpotBuilder();
        else openBbqBuilder();
        return;
      }
      const grp = e.target.closest('[data-group]');
      if (grp) { openDrinkGroup(grp.dataset.group); return; }
      const side = e.target.closest('[data-side]');
      if (side) {
        if (side.dataset.fxBusy) return;
        const it = MENU.sides.groups[0].items.find((x) => x.n === side.dataset.side);
        if (it) addToCart({ kind: 'simple', name: it.n, unit: it.price, qty: 1, mods: [] }, side);
        return;
      }
    });

    $('#tableNo').addEventListener('input', (e) => { state.table = e.target.value.trim(); });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function readQuery() {
    const q = new URLSearchParams(location.search);
    const t = q.get('table') || q.get('t');
    if (t && CONFIG.features.qrTableNumbers) {
      state.table = t;
      state.orderType = 'dinein';
    }
    const ot = q.get('type');
    if (ot && CONFIG.orderTypes.some((x) => x.id === ot)) state.orderType = ot;
    /* Note: a ?table= link asks for dine-in, but the owner may have dine-in
       switched off. We do NOT second-guess it here — readQuery() runs before
       we have asked the server. applyStoreStatus() reconciles the choice once
       the real availability arrives, and moves the guest to an open channel
       rather than leaving them parked on a dead one. */
  }

  /* Stripe sends the guest back to ?paid=1 (success) or ?canceled=1 (backed
     out). We stash the order in localStorage just before leaving, so the
     confirmation can be rebuilt here.

     IMPORTANT: the URL is NOT trusted. "?paid=1" only means a payment was
     *attempted* — anyone can type it. The order is therefore shown as
     "unconfirmed" until our server has asked Stripe and confirmed the money
     actually arrived. That is the only path to a "paid" ticket.

     Resolves true when a ticket should be shown instead of the menu. */
  function handlePaymentReturn() {
    const q = new URLSearchParams(location.search);
    const paid = q.get('paid');
    const canceled = q.get('canceled');
    if (!paid && !canceled) return Promise.resolve(false);

    // Drop the query so a refresh, a bookmark or a shared link can't replay this.
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}

    if (canceled) {
      let abandoned = null;
      try { abandoned = JSON.parse(localStorage.getItem(LS_PENDING) || 'null'); } catch (e) {}
      try { localStorage.removeItem(LS_PENDING); } catch (e) {}
      toast('Payment canceled — your order was not placed.', 'err');

      /* The order is recorded on the kitchen board BEFORE we hand the guest to
         Stripe (it has to be — that is how the number gets reserved). Backing
         out must therefore take it back off, or the kitchen is left cooking an
         order the guest has just been told was never placed.
         We cannot PATCH it away (that endpoint is admin-gated), so we route it
         through verify-session: the server asks Stripe, finds the session
         unpaid, and cancels the order itself. Best effort — the guest is
         leaving either way and must never be blocked by it. */
      if (state.backend && abandoned && abandoned.sessionId) {
        fetch('/api/verify-session?id=' + encodeURIComponent(abandoned.sessionId)).catch(() => {});
      }
      return Promise.resolve(false);
    }

    let order = null;
    try { order = JSON.parse(localStorage.getItem(LS_PENDING) || 'null'); } catch (e) {}
    try { localStorage.removeItem(LS_PENDING); } catch (e) {}

    if (!order || !order.items || !order.items.length) {
      toast('We could not find that order — please ask at the counter.', 'err');
      return Promise.resolve(false);
    }

    /* Show something immediately — the Stripe round trip takes a moment and a
       blank screen reads as "it broke". */
    renderVerifying();

    /* Re-post by token (idempotent) before verifying. Normally the order
       already carries the server's number — we adopt it before leaving for
       Stripe — but if that POST never landed (flaky network) the saved order
       still holds our local suggestion, and we would PATCH the wrong order on
       the board. This re-resolves the real number. Bounded, never blocks. */
    const settled = state.backend ? withTimeout(recordOrder(order), 6000) : Promise.resolve(order);

    return settled.then(() => verifyPayment(order)).then((status) => {
      order.payMethod = 'stripe';
      order.paymentStatus = status;                 // 'verified' | 'unpaid' | 'unverified'
      order.paid = status === 'verified';           // kept in sync for dispatch/webhooks
      order.verifiedAt = new Date().toISOString();

      state.order = order;
      state.cart = [];
      saveCart();
      try { localStorage.setItem(LS_LAST, JSON.stringify(order)); } catch (e) {}
      /* Update the history entry saved before the redirect with the outcome of
         the Stripe check, so Recent Orders shows the true payment state. */
      saveHistory(order);

      if (status !== 'verified') {
        console.warn('[kpot] online payment NOT confirmed for ' + order.no + ' →', status);
      }
      /* The board is settled by the SERVER inside /api/verify-session — the
         call we just made. It used to be PATCHed from here, but PATCH is
         admin-gated, so this request came back 401 and paid orders stayed
         UNPAID on the kitchen board. The server now does it from Stripe's own
         session data, which is both trustworthy and unaffected by the guest
         closing the tab. Nothing to do here. */
      dispatchOrder(order);
      /* Stripe has confirmed the money, so this browser has now earned its
         membership credential for the number on the order. Fire and forget —
         the guest is looking at their ticket, not at a login screen. */
      if (status === 'verified') claimDevice(order);
      return true;
    });
  }

  /* Shown while we wait for Stripe's answer. */
  function renderVerifying() {
    setOrderView(true);
    $('#tabsWrap').classList.add('hide');
    $('#cartBar').classList.remove('on');
    $('#menuBody').innerHTML =
      '<div class="verifying">' +
        '<div class="spin"></div>' +
        '<b>Confirming your payment…</b>' +
        '<p>Hang on a moment while we check with Stripe.</p>' +
      '</div>';
  }

  function boot() {
    loadCart();
    readQuery();
    renderShell();

    /* Payment returns first: the guest should land straight on their ticket,
       never back on the menu with an empty cart. */
    const isReturn = /[?&](paid|canceled)=/.test(location.search);

    if (isReturn) {
      /* Resolve whether a backend exists BEFORE we verify the payment.
         handlePaymentReturn() only PATCHes the owner's board when
         state.backend is true, and that flag is set by probeBackend(). If we
         waited until after handlePaymentReturn() to probe, the PATCH decision
         would run with state.backend still false and the paid order would
         never be confirmed on the board. */
      probeBackend().then(() => handlePaymentReturn()).then((showTicket) => {
        if (showTicket) renderTicket();
        else { $('#tabsWrap').classList.remove('hide'); renderMenu(); }
        bindGlobal();
        syncCartUI();
        syncHistoryUI();
        refreshHistoryStatuses();
      });
      return;
    }

    renderMenu();
    bindGlobal();
    syncCartUI();
    /* Bring back the Recent Orders button and refresh any order still in
       progress, so a guest who returns to the page sees the current status. */
    syncHistoryUI();
    refreshHistoryStatuses();
    /* Offer "Add to Home Screen" so guests can receive ready notifications. */
    initInstall();
    /* Render the bundled menu instantly, then swap in the owner's live menu if
       the server has one (and re-render so the change is visible). */
    probeBackend().then(loadLiveMenu).then((changed) => { if (changed) renderMenu(); });
    setInterval(checkStoreStatus, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
