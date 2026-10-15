/* ==========================================================================
   KPOT To Go — ESC/POS kitchen ticket renderer
   --------------------------------------------------------------------------
   Turns an order into the bytes a thermal receipt printer understands.

   Design rules, learned the hard way:

   1. PURE. No sockets, no files, no printer, no clock beyond the order's own
      timestamp. That is what lets it be unit-tested byte-for-byte without
      hardware — and hardware is exactly what you do not have while writing it.

   2. ONE layout, TWO backends. The ticket is built as a list of style "ops"
      first, then rendered either to ESC/POS bytes or to plain text. The plain
      text version is what we show the owner as a preview, so the preview can
      never drift from what the printer actually produces.

   3. THE SERVER RENDERS, THE AGENT RELAYS. The little program in the
      restaurant only moves bytes to the printer. Changing the ticket layout
      therefore never means touching the machine in the restaurant.

   4. ASCII ONLY. Thermal printers in ESC/POS text mode speak a code page, not
      Unicode. The menu is English, so we sanitise down to printable ASCII and
      mark anything we had to drop rather than emitting garbage.
   ========================================================================== */

'use strict';

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

/* --------------------------------------------------------------------------
   Character-cell widths. Font A on the usual 203dpi heads:
     80mm paper -> 48 columns      58mm paper -> 32 columns
   -------------------------------------------------------------------------- */
const COLUMNS = { '80': 48, '58': 32 };

/* ---------------------------------------------------------------- sanitising */

/* Map the typographic characters that sneak in from the menu and the guest's
   keyboard onto ASCII equivalents, strip decorative glyphs (emoji, arrows,
   variation selectors), and finally replace anything still unprintable with
   '?'. A '?' on a ticket is ugly but honest; raw high bytes would print as
   random symbols or wedge the printer. */
function sanitize(input) {
  let t = String(input == null ? '' : input);

  t = t.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
       .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
       .replace(/[\u2013\u2014\u2212]/g, '-')
       .replace(/\u2026/g, '...')
       .replace(/\u00A0/g, ' ')
       .replace(/[\u00D7\u2715\u2716]/g, 'x')
       .replace(/[\u2713\u2714]/g, 'OK');

  /* Decorative ranges: emoji, pictographs, dingbats, arrows, geometric shapes,
     plus the invisible joiners/selectors that ride along with them. */
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{2122}]/gu, '');

  /* Collapse whitespace BEFORE the catch-all below. A newline and a tab are
     both outside printable ASCII, so doing this second turned them into literal
     '?' marks — a guest's multi-line note printed as a row of question marks.
     Collapsing first turns them into spaces, which is what they mean. */
  t = t.replace(/\s+/g, ' ');

  t = t.replace(/[^\x20-\x7E]/g, '?');
  return t.trim();
}

/* ------------------------------------------------------------------- layout */

function wrap(text, cols, indent) {
  const pad = ' '.repeat(indent || 0);
  const width = Math.max(8, cols - (indent || 0));
  const words = sanitize(text).split(' ').filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (w.length > width) {
      /* A single unbreakable token longer than the line — hard-split it so it
         cannot silently overflow and wrap into the margin. */
      if (line) { out.push(pad + line); line = ''; }
      let rest = w;
      while (rest.length > width) { out.push(pad + rest.slice(0, width)); rest = rest.slice(width); }
      line = rest;
      continue;
    }
    if (!line) line = w;
    else if ((line + ' ' + w).length <= width) line += ' ' + w;
    else { out.push(pad + line); line = w; }
  }
  if (line) out.push(pad + line);
  return out.length ? out : [pad];
}

/* Left text with right text pinned to the same line; if they cannot share a
   line, the right side drops to its own line rather than being truncated. */
function twoCol(left, right, cols) {
  const l = sanitize(left);
  const r = sanitize(right);
  const gap = cols - l.length - r.length;
  if (gap >= 1) return l + ' '.repeat(gap) + r;
  return l + '\n' + ' '.repeat(Math.max(0, cols - r.length)) + r;
}

function money(n) {
  const v = Number(n);
  return '$' + (isFinite(v) ? v : 0).toFixed(2);
}

/* The biggest size we can use for `text` without it wrapping. */
function sizeFor(text, cols) {
  return sanitize(text).length * 2 <= cols ? 2 : 1;
}

/* --------------------------------------------------------- the ticket layout */

/* Returns a list of ops: { t:'text'|'rule'|'feed'|'cut', ... } */
function buildTicket(order, opts) {
  const o = opts || {};
  const paper = String(o.paper || '80');
  const cols = o.cols || COLUMNS[paper] || 48;
  const store = o.storeName || (order && order.store) || 'KPOT To Go';

  const ord = order || {};
  const ops = [];
  const rule = () => ops.push({ t: 'rule' });
  /* EVERY text op carries an explicit align/bold/size. Leaving them implicit
     means the style set by an earlier line (the double-size order number, say)
     silently leaks into everything after it — both on the printer, where the
     escape codes are sticky, and in the preview. */
  const line = (s, style) => ops.push(Object.assign(
    { t: 'text', s: s, align: 'left', bold: false, size: 1 }, style || {}));

  /* ---- header ---- */
  line('KITCHEN', { align: 'center', bold: true, size: sizeFor('KITCHEN', cols) });
  line(store, { align: 'center' });
  const when = ord.at ? new Date(ord.at) : new Date();
  line(when.toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }), { align: 'center' });

  rule();

  /* ---- order identity ---- */
  const no = sanitize(ord.id || ord.no || '');
  line(no, { align: 'center', bold: true, size: sizeFor(no, cols) });

  const typeLabel = ord.orderType === 'dinein' ? 'DINE-IN'
    : ord.orderType === 'delivery' ? 'DELIVERY' : 'PICKUP';
  const cust = ord.customer || {};
  const rows = [['TYPE', typeLabel]];
  if (ord.orderType === 'dinein') rows.push(['TABLE', ord.table || '?']);
  if (cust.name) rows.push(['NAME', cust.name]);
  if (cust.phone) rows.push(['PHONE', cust.phone]);
  if (cust.when) rows.push(['WHEN', cust.when]);
  for (const [k, v] of rows) line(twoCol(k, v, cols));

  /* ---- payment, loud ----
     A pay-at-counter order reaches this kitchen before any money is
     collected. If it is unpaid the ticket has to say so where nobody can
     miss it, or the food walks out the door. */
  const ps = ord.paymentStatus || (ord.payMethod === 'counter' ? 'counter' : 'unverified');
  const paid = ps === 'verified' || ps === 'paid';
  const isCounter = ps === 'counter' || ord.payMethod === 'counter';

  rule();
  if (paid) {
    line('PAID - DO NOT COLLECT', { align: 'center', bold: true });
  } else if (isCounter) {
    line('*** UNPAID ***', { align: 'center', bold: true, size: sizeFor('*** UNPAID ***', cols) });
    line('COLLECT ' + money(ord.total), { align: 'center', bold: true, size: sizeFor('COLLECT ' + money(ord.total), cols) });
  } else {
    line('*** PAYMENT NOT CONFIRMED ***', { align: 'center', bold: true });
    line('CHECK BEFORE HAND-OFF', { align: 'center' });
  }
  rule();

  /* ---- items ----
     Names, quantities and modifiers come from `lines` — the server's own
     recomputation. `items` is the guest's raw payload and must never be the
     source of anything the kitchen acts on. */
  const lines = Array.isArray(ord.lines) && ord.lines.length
    ? ord.lines
    : (ord.items || []).map((it) => ({ name: it.name, qty: it.qty, unit: it.unit, desc: (it.mods || []).concat(it.addons || []).join(' \u00B7 ') }));

  if (!lines.length) line('(no items)', { align: 'center' });

  for (const l of lines) {
    const qty = Number(l.qty) || 1;
    line(qty + 'x ' + sanitize(l.name), { bold: true, size: sizeFor(qty + 'x ' + sanitize(l.name), cols) });
    /* `desc` was built by pricing.js as mods.concat(addons).join(' · '), so
       splitting on that exact separator recovers the individual choices and
       lets each one sit on its own line where it can be ticked off. */
    const parts = String(l.desc || '').split(' \u00B7 ').map(sanitize).filter(Boolean);
    for (const p of parts) for (const w of wrap(p, cols, 3)) line(w);
    ops.push({ t: 'feed', n: 1 });
  }

  /* ---- order-level note ---- */
  const note = sanitize(cust.notes || '');
  if (note) {
    rule();
    line('NOTE', { bold: true });
    for (const w of wrap(note, cols, 2)) line(w);
  }

  /* ---- totals ---- */
  rule();
  const sub = ord.subtotal != null ? Number(ord.subtotal) : null;
  const tax = ord.tax != null ? Number(ord.tax) : null;
  const tip = Number(ord.tip) || 0;
  if (sub != null) line(twoCol('SUBTOTAL', money(sub), cols));

  /* Shown as a negative amount right under the subtotal, which is the only way
     the kitchen can tell why TOTAL is smaller than the menu price. Named, so a
     staff discount and a guest's code are not the same thing on paper. */
  const disc = Number(ord.discountAmount) || 0;
  if (disc > 0) {
    const d = ord.discount || {};
    const tag = d.code ? String(d.code) : (d.source === 'staff' ? 'STAFF' : '');
    line(twoCol(tag ? 'DISCOUNT ' + tag : 'DISCOUNT', '-' + money(disc), cols));
  }

  if (tax != null) line(twoCol('TAX', money(tax), cols));
  if (tip > 0) line(twoCol('TIP', money(tip), cols));
  line(twoCol('TOTAL', money(ord.total), cols), { bold: true });

  line('');
  line(no, { align: 'center' });
  ops.push({ t: 'feed', n: 3 });
  if (o.cut !== false) ops.push({ t: 'cut' });
  return ops;
}

/* ------------------------------------------------------------- ESC/POS bytes */

function toEscPos(ops, opts) {
  const o = opts || {};
  const cols = o.cols || COLUMNS[String(o.paper || '80')] || 48;
  const chunks = [];

  const ALIGN = { left: 0x00, center: 0x01, right: 0x02 };
  const SIZE = { 1: 0x00, 2: 0x11 };   // GS ! n : high nibble = width-1, low = height-1

  const push = (b) => chunks.push(Buffer.from(b));

  push([ESC, 0x40]);                       // ESC @ — initialise
  push([ESC, 0x74, 0x00]);                 // ESC t 0 — code page 0 (CP437); we only send ASCII

  /* Style is tracked so we only emit a command when it actually changes, but
     it is ALWAYS driven from the op — never left to persist implicitly. */
  let align = 'left', bold = false, size = 1;
  const style = (a, b, s) => {
    if (a !== align) { align = a; push([ESC, 0x61, ALIGN[a]]); }
    if (b !== bold) { bold = b; push([ESC, 0x45, b ? 1 : 0]); }
    if (s !== size) { size = s; push([GS, 0x21, SIZE[s]]); }
  };

  for (const op of ops) {
    if (op.t === 'text') {
      style(op.align || 'left', !!op.bold, op.size || 1);
      /* A multi-line string inside one op (twoCol falling back to two rows)
         is emitted line by line under the same style. */
      for (const part of String(op.s).split('\n')) {
        push(Buffer.from(part, 'ascii'));
        push([LF]);
      }
    } else if (op.t === 'rule') {
      style('left', false, 1);
      push(Buffer.from('-'.repeat(cols), 'ascii'));
      push([LF]);
    } else if (op.t === 'feed') {
      style('left', false, 1);
      push([ESC, 0x64, Math.min(255, op.n || 1)]);   // ESC d n — feed n lines
    } else if (op.t === 'cut') {
      push([GS, 0x56, 0x42, 0x00]);                  // GS V 66 0 — feed to cutter, partial cut
    }
  }

  return Buffer.concat(chunks);
}

/* ---------------------------------------------------------------- plain text */

/* Same ops, no escape codes. Used for the owner-facing preview and for tests
   that assert on layout without caring about control bytes. */
function toPlainText(ops, opts) {
  const o = opts || {};
  const cols = o.cols || COLUMNS[String(o.paper || '80')] || 48;
  const out = [];
  let size = 1, align = 'left';

  const place = (s) => {
    let t = s;
    if (size === 2) {
      /* Mimic double-width so the preview's line lengths are honest. */
      t = t.split('').join(' ');
    }
    if (align === 'center') {
      const pad = Math.max(0, Math.floor((cols - t.length) / 2));
      return ' '.repeat(pad) + t;
    }
    if (align === 'right') return ' '.repeat(Math.max(0, cols - t.length)) + t;
    return t;
  };

  for (const op of ops) {
    if (op.t === 'text') {
      if (op.align) align = op.align;
      if (op.size) size = op.size;
      for (const part of String(op.s).split('\n')) out.push(place(part));
    } else if (op.t === 'rule') {
      align = 'left'; size = 1;
      out.push('-'.repeat(cols));
    } else if (op.t === 'feed') {
      align = 'left'; size = 1;
      for (let i = 0; i < (op.n || 1); i++) out.push('');
    } else if (op.t === 'cut') {
      /* Width-aware so the preview never shows a line longer than the paper.
         A fixed 61-char marker was wider than 58mm and 80mm both, which made
         the preview's line lengths quietly dishonest. */
      const label = ' cut ';
      const left = Math.max(0, Math.floor((cols - label.length) / 2));
      out.push('='.repeat(left) + label + '='.repeat(Math.max(0, cols - label.length - left)));
    }
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------- public */

function renderKitchenTicket(order, opts) {
  const o = Object.assign({}, opts || {});
  o.cols = o.cols || COLUMNS[String(o.paper || '80')] || 48;
  return toEscPos(buildTicket(order, o), o);
}

function previewKitchenTicket(order, opts) {
  const o = Object.assign({}, opts || {});
  o.cols = o.cols || COLUMNS[String(o.paper || '80')] || 48;
  return toPlainText(buildTicket(order, o), o);
}

module.exports = {
  COLUMNS,
  sanitize,
  wrap,
  buildTicket,
  toEscPos,
  toPlainText,
  renderKitchenTicket,
  previewKitchenTicket
};
