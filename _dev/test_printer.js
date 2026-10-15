#!/usr/bin/env node
/* ==========================================================================
   Unit tests for printer.js — the ESC/POS kitchen-ticket renderer.

   No printer, no server, no sockets. printer.js is pure on purpose, so the
   whole layout can be pinned down byte-for-byte here.

   The interesting test is `replay()`: it re-reads the emitted escape stream and
   reconstructs the style that is ACTIVE at each printed line. Escape codes are
   sticky on a thermal printer — ESC E 1 (bold) stays on until ESC E 0 — so a
   layout that forgets to reset a style leaks it into every later line. That
   bug is invisible in a plain-text preview and only shows up on paper, which is
   the one place you cannot easily inspect. So we assert on the reconstructed
   state, not on the presence of a particular escape sequence.

   Run:  node _dev/test_printer.js
   ========================================================================== */

'use strict';

const P = require('../printer.js');

let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function eq(desc, got, want) {
  check(desc, got === want, got === want ? '' : 'got ' + JSON.stringify(got) + '  want ' + JSON.stringify(want));
}

/* --------------------------------------------------------------- replaying */

const ESC = 0x1B, GS = 0x1D, LF = 0x0A;

/* Replay an ESC/POS byte stream and return the lines that would actually be
   printed, each tagged with the style that was in force when it printed. */
function replay(buf) {
  const out = [];
  let size = 1, align = 'left', bold = false;
  let cur = '';
  let sawInit = false;

  const flush = () => { out.push({ text: cur, size, align, bold }); cur = ''; };

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === ESC) {
      const c = buf[i + 1];
      if (c === 0x40) { sawInit = true; size = 1; align = 'left'; bold = false; i += 1; continue; }
      if (c === 0x61) { align = { 0: 'left', 1: 'center', 2: 'right' }[buf[i + 2]] || 'left'; i += 2; continue; }
      if (c === 0x45) { bold = buf[i + 2] === 1; i += 2; continue; }
      if (c === 0x74) { i += 2; continue; }                 // ESC t n — code page
      if (c === 0x64) { i += 2; continue; }                 // ESC d n — feed
      i += 1; continue;
    }
    if (b === GS) {
      const c = buf[i + 1];
      if (c === 0x21) { size = buf[i + 2] === 0x11 ? 2 : 1; i += 2; continue; }   // GS ! n
      if (c === 0x56) { i += 3; continue; }                                       // GS V m n
      i += 1; continue;
    }
    if (b === LF) { flush(); continue; }
    cur += String.fromCharCode(b);
  }
  if (cur) flush();
  return { lines: out, sawInit };
}

const lineFor = (r, needle) => r.lines.find((l) => l.text.includes(needle));

/* ------------------------------------------------------------------ fixtures */

function order(over) {
  return Object.assign({
    id: 'KP-1234',
    orderType: 'pickup',
    at: '2026-10-07T16:02:00.000Z',
    customer: { name: 'Print Probe', phone: '4045550142', when: 'ASAP', notes: 'no chopsticks' },
    lines: [{ name: 'Build Your Own Bowl', qty: 2, unit: 15.99, desc: 'Broth: Japanese Miso \u00B7 Protein: Beef \u00B7 Spicy: Medium' }],
    subtotal: 31.98, tax: 1.92, tip: 0, total: 33.90,
    payMethod: 'counter', paymentStatus: 'counter'
  }, over || {});
}

/* --------------------------------------------------------------------- main */

console.log('printer.js — ESC/POS kitchen ticket');
console.log('='.repeat(74));

/* ---- sanitize ---- */
console.log('\nsanitize()');
eq('smart single quotes become ASCII', P.sanitize('\u2018a\u2019'), "'a'");
eq('smart double quotes become ASCII', P.sanitize('\u201Cq\u201D'), '"q"');
eq('em dash and en dash become hyphen', P.sanitize('a\u2014b\u2013c'), 'a-b-c');
eq('ellipsis becomes three dots', P.sanitize('wait\u2026'), 'wait...');
eq('non-breaking space becomes a normal space', P.sanitize('a\u00A0b'), 'a b');
eq('multiplication sign becomes x', P.sanitize('2\u00D7'), '2x');
eq('check mark becomes OK', P.sanitize('\u2713'), 'OK');
eq('emoji is dropped entirely', P.sanitize('hot \u{1F336} soup'), 'hot soup');
eq('arrow is dropped', P.sanitize('a \u2192 b'), 'a b');
eq('trademark sign is dropped', P.sanitize('KPOT\u2122'), 'KPOT');
eq('surviving non-ASCII becomes ? (honest, not garbage)', P.sanitize('\u00E9clair'), '?clair');
eq('whitespace is collapsed', P.sanitize('a   b\n\tc'), 'a b c');
eq('empty and null are safe', P.sanitize(null) + '|' + P.sanitize(undefined), '|');
check('every sanitize output is pure printable ASCII',
  ['\u2018\u2019\u{1F600}\u00E9', 'a\u2014b', '\u2713 \u00D7'].every((s) => /^[\x20-\x7E]*$/.test(P.sanitize(s))));

/* ---- wrap ---- */
console.log('\nwrap()');
const w48 = P.wrap('one two three four five six seven eight nine ten eleven twelve', 48, 0);
check('wrap never exceeds the column count', w48.every((l) => l.length <= 48), 'max=' + Math.max(...w48.map((l) => l.length)));
check('wrap keeps every word', w48.join(' ').split(/\s+/).length === 12, w48.join(' | '));
check('indent is applied to every line', P.wrap('aaa bbb ccc ddd eee fff ggg', 20, 3).every((l) => l.startsWith('   ')));
const longTok = P.wrap('X'.repeat(120), 48, 0);
check('an unbreakable token is hard-split, not overflowed', longTok.every((l) => l.length <= 48) && longTok.join('').length === 120,
  'lines=' + longTok.length);
eq('empty text yields one empty line, never zero', P.wrap('', 48, 0).length, 1);

/* ---- twoCol ---- */
console.log('\ntwoCol via buildTicket');
const r80 = replay(P.renderKitchenTicket(order(), { paper: '80' }));
const typeLine = lineFor(r80, 'TYPE');
eq('left/right pair fills exactly the full width', typeLine.text.length, 48);
check('the label is on the left', typeLine.text.startsWith('TYPE'));
check('the value is pinned right', typeLine.text.trim().endsWith('PICKUP'));

/* ---- payment emphasis ---- */
console.log('\npayment emphasis');
const rPaid = replay(P.renderKitchenTicket(order({ paymentStatus: 'verified', payMethod: 'stripe' }), { paper: '80' }));
check('a paid order says DO NOT COLLECT', !!lineFor(rPaid, 'PAID - DO NOT COLLECT'));
check('a paid order never says COLLECT $', !rPaid.lines.some((l) => /COLLECT \$/.test(l.text)));

const rUnpaid = replay(P.renderKitchenTicket(order(), { paper: '80' }));
check('a counter order shouts UNPAID', !!lineFor(rUnpaid, '*** UNPAID ***'));
const collect = lineFor(rUnpaid, 'COLLECT');
eq('and names the exact amount to collect', collect && collect.text.trim(), 'COLLECT $33.90');

const rUnconf = replay(P.renderKitchenTicket(order({ paymentStatus: 'unverified', payMethod: 'stripe' }), { paper: '80' }));
check('an unconfirmed online payment says so', !!lineFor(rUnconf, '*** PAYMENT NOT CONFIRMED ***'));
check('an unconfirmed payment is not labelled PAID', !lineFor(rUnconf, 'PAID - DO NOT COLLECT'));

/* ---- a discount on the ticket ----
   "TOTAL $15.25" printed next to a $15.99 menu price reads as a pricing bug
   unless the kitchen can see where the money went. The line is named, so a
   staff discount and a guest's code are not the same thing on paper. */
console.log('\ndiscount');
const rDisc = replay(P.renderKitchenTicket(order({
  subtotal: 15.99, tax: 0.86, total: 15.25,
  discountAmount: 1.6, discount: { type: 'percent', value: 10, code: 'TEN', source: 'code', amount: 1.6 }
}), { paper: '80' }));
/* twoCol right-aligns the amount, so the pair has to be matched as a pattern,
   not as a literal string — the padding is the layout. */
const discLine = (r, needle) => (r.lines.find((l) => l.text.includes(needle)) || { text: '' }).text;
eq('the discount line names the code and the amount',
  discLine(rDisc, 'DISCOUNT TEN'), 'DISCOUNT TEN                              -$1.60');
eq('the discount is printed between the subtotal and the tax',
  (function () {
    const t = rDisc.lines.map((l) => l.text);
    return t.findIndex((x) => x.includes('SUBTOTAL')) < t.findIndex((x) => x.includes('DISCOUNT')) &&
      t.findIndex((x) => x.includes('DISCOUNT')) < t.findIndex((x) => x.startsWith('TAX'));
  })(), true);
/* 'SUBTOTAL' contains 'TOTAL', so the TOTAL line has to be anchored — a
   substring search would happily match the subtotal and pass silently. */
const totalLine = (r) => (r.lines.map((l) => l.text).find((t) => /^TOTAL\s/.test(t)) || '');
check('the total printed is the discounted one',
  /^TOTAL\s+\$15\.25$/.test(totalLine(rDisc)), totalLine(rDisc));
check('an order with no discount has no DISCOUNT line at all',
  !rUnpaid.lines.some((l) => /DISCOUNT/.test(l.text)));

const rDiscStaff = replay(P.renderKitchenTicket(order({
  subtotal: 15.99, tax: 0.78, total: 13.77,
  discountAmount: 3, discount: { type: 'amount', value: 3, source: 'staff', amount: 3 }
}), { paper: '80' }));
eq('a staff discount is labelled STAFF, not a code',
  discLine(rDiscStaff, 'DISCOUNT'), 'DISCOUNT STAFF                            -$3.00');

/* ---- style does not leak (the regression this file exists for) ---- */
console.log('\nstyle is per-line, never sticky');
const noLine = lineFor(r80, 'KP-1234');
eq('the order number is double size', noLine && noLine.size, 2);
eq('the order number is bold', noLine && noLine.bold, true);
const afterNo = r80.lines[r80.lines.indexOf(noLine) + 1];
eq('the line after the double-size order number is back to normal size', afterNo.size, 1);
eq('and back to not-bold', afterNo.bold, false);

/* The real invariant: every line that reaches the paper must carry exactly the
   style its layout op asked for. Checking "is this particular line size 1"
   only samples one line; walking the whole stream catches a leak anywhere.
   (Item names are legitimately double size when they fit — that is deliberate,
   so asserting "nothing after the order number is big" was simply wrong.) */
function assertStyles(desc, ord, paper) {
  const cols = P.COLUMNS[String(paper)] || 48;
  const ops = P.buildTicket(ord, { cols, paper: String(paper) });
  const r = replay(P.renderKitchenTicket(ord, { paper }));
  let i = 0;
  const bad = [];
  for (const op of ops) {
    if (op.t === 'text') {
      for (const _part of String(op.s).split('\n')) {
        const got = r.lines[i++];
        if (!got) { bad.push('missing line for op ' + JSON.stringify(op.s)); continue; }
        const want = { size: op.size || 1, align: op.align || 'left', bold: !!op.bold };
        if (want.size !== got.size || want.align !== got.align || want.bold !== got.bold) {
          bad.push(JSON.stringify(got.text) + ' got ' + JSON.stringify({ size: got.size, align: got.align, bold: got.bold }) +
            ' want ' + JSON.stringify(want));
        }
      }
    } else if (op.t === 'rule') {
      const got = r.lines[i++];
      if (!got || got.size !== 1 || got.bold !== false || got.align !== 'left') bad.push('rule emitted with a stale style');
    }
  }
  check(desc, bad.length === 0, bad.slice(0, 4).join('\n         '));
}
assertStyles('every line renders with exactly the style its op asked for (80mm)', order(), '80');
assertStyles('every line renders with exactly the style its op asked for (58mm)', order(), '58');
assertStyles('no style leak with a paid order', order({ paymentStatus: 'verified', payMethod: 'stripe' }), '80');
assertStyles('no style leak with an unconfirmed payment', order({ paymentStatus: 'unverified', payMethod: 'stripe' }), '80');
assertStyles('no style leak with a note and several items', order({
  customer: { name: 'A', phone: '1', when: 'ASAP', notes: 'a fairly long note that must wrap across more than one line on the paper' },
  lines: [
    { name: 'Short', qty: 1, desc: 'a \u00B7 b' },
    { name: 'A Very Long Item Name That Cannot Possibly Fit Double Width', qty: 12, desc: '' }
  ]
}), '80');

/* ---- modifiers ---- */
console.log('\nmodifiers');
check('each modifier gets its own line',
  ['Broth: Japanese Miso', 'Protein: Beef', 'Spicy: Medium'].every((m) => r80.lines.some((l) => l.text.includes(m))));
check('modifiers are indented', r80.lines.filter((l) => /Broth:|Protein:|Spicy:/.test(l.text)).every((l) => l.text.startsWith(' ')));
const itemLine = lineFor(r80, '2x Build Your Own Bowl');
eq('an item line is bold (readable at a glance)', itemLine.bold, true);
eq('an item name that fits at double width is double size', itemLine.size, 2);
const bigName = replay(P.renderKitchenTicket(order({
  lines: [{ name: 'A Very Long Item Name That Cannot Possibly Fit Double Width', qty: 1, desc: '' }]
}), { paper: '80' }));
eq('a long item name falls back to single size rather than wrapping',
  bigName.lines.find((l) => l.text.includes('A Very Long')).size, 1);
const modLine = r80.lines.find((l) => l.text.includes('Broth: Japanese Miso'));
eq('a modifier line is not bold', modLine.bold, false);
eq('a modifier line is not double size', modLine.size, 1);

/* ---- the server's own lines win over the guest's payload ---- */
console.log('\ntrust boundary');
const rLines = replay(P.renderKitchenTicket(order({
  lines: [{ name: 'SERVER TRUTH', qty: 1, desc: '' }],
  items: [{ name: 'GUEST PAYLOAD', qty: 9, mods: [] }]
}), { paper: '80' }));
check('the ticket prints `lines` (server-recomputed)', rLines.lines.some((l) => l.text.includes('SERVER TRUTH')));
check('the ticket ignores `items` when `lines` is present', !rLines.lines.some((l) => l.text.includes('GUEST PAYLOAD')));

const rItems = replay(P.renderKitchenTicket(order({ lines: null, items: [{ name: 'Fallback Item', qty: 3, mods: ['Extra Spicy'], addons: ['Egg'] }] }), { paper: '80' }));
check('with no `lines`, items are used as a fallback', rItems.lines.some((l) => l.text.includes('Fallback Item')));
check('fallback joins mods and addons', rItems.lines.some((l) => l.text.includes('Extra Spicy')) && rItems.lines.some((l) => l.text.includes('Egg')));

/* ---- paper widths ---- */
console.log('\npaper widths');
const r58 = replay(P.renderKitchenTicket(order(), { paper: '58' }));
check('58mm uses 32 columns', r58.lines.some((l) => l.text === '-'.repeat(32)));
check('58mm never emits a line wider than 32', r58.lines.every((l) => l.text.length <= 32),
  'max=' + Math.max(...r58.lines.map((l) => l.text.length)));
check('58mm uses the full 32 columns for a left/right row', (lineFor(r58, 'TYPE') || {}).text.length === 32);

/* ---- control codes ---- */
console.log('\ncontrol codes');
check('the stream initialises the printer first', r80.sawInit && P.renderKitchenTicket(order(), {}).slice(0, 2).toString('hex') === '1b40');
check('a code page is selected', P.renderKitchenTicket(order(), {}).includes(Buffer.from([ESC, 0x74, 0x00])));
check('the ticket ends with a cut', P.renderKitchenTicket(order(), {}).slice(-4).toString('hex') === '1d564200');
check('cut can be disabled', !P.renderKitchenTicket(order(), { cut: false }).includes(Buffer.from([GS, 0x56, 0x42, 0x00])));
check('a feed is emitted before the cut', P.renderKitchenTicket(order(), {}).includes(Buffer.from([ESC, 0x64, 0x03])));

/* ---- ASCII safety on the wire ---- */
console.log('\nwire safety');
const dirty = order({
  customer: { name: 'Jos\u00E9 \u{1F600}', phone: '404', when: 'ASAP', notes: 'extra \u201Cspicy\u201D \u2014 please' },
  lines: [{ name: 'Bowl \u{1F35C}\u2122', qty: 1, desc: 'Broth: Miso \u00B7 Size: L\u00D7' }]
});
const dirtyBuf = P.renderKitchenTicket(dirty, { paper: '80' });
check('no byte above 0x7F is ever sent to the printer', dirtyBuf.every((b) => b < 0x80),
  'high bytes: ' + Array.from(dirtyBuf).filter((b) => b >= 0x80).length);
check('a dropped emoji does not corrupt the surrounding text',
  replay(dirtyBuf).lines.some((l) => l.text.includes('Bowl')));

/* ---- determinism & preview fidelity ---- */
console.log('\ndeterminism and preview');
const a = P.renderKitchenTicket(order(), { paper: '80' });
const b = P.renderKitchenTicket(order(), { paper: '80' });
check('the same order renders byte-identically twice', a.equals(b));

const preview = P.previewKitchenTicket(order(), { paper: '80' });
/* The preview mimics double-width by putting a space between characters, so
   literal substring matching has to account for that — squash the spaces. */
const squash = (s) => s.replace(/\s+/g, '');
check('the preview names the order', squash(preview).includes('KP-1234'));
check('the preview shows the unpaid warning',
  squash(preview).includes('***UNPAID***') && squash(preview).includes('COLLECT$33.90'),
  squash(preview).split('UNPAID')[0].slice(-30));
check('the preview shows the item', squash(preview).includes('2xBuildYourOwnBowl'));
check('the preview shows each modifier',
  ['Broth:JapaneseMiso', 'Protein:Beef', 'Spicy:Medium'].every((m) => squash(preview).includes(m)));
check('the preview shows the note', squash(preview).includes('nochopsticks'));
check('the preview marks the cut', /cut/.test(preview));
check('the preview never exceeds the paper width', preview.split('\n').every((l) => l.length <= 48),
  'max=' + Math.max(...preview.split('\n').map((l) => l.length)));
const preview58 = P.previewKitchenTicket(order(), { paper: '58' });
check('the 58mm preview never exceeds 32 columns', preview58.split('\n').every((l) => l.length <= 32),
  'max=' + Math.max(...preview58.split('\n').map((l) => l.length)));
/* The preview and the printer must agree on content, since the preview is what
   the owner is shown when deciding whether the layout is right. */
const previewLines = preview.split('\n').map(squash).filter(Boolean);
check('every printed line appears in the preview',
  replay(a).lines.filter((l) => l.text.trim()).every((l) => previewLines.includes(squash(l.text))),
  'missing: ' + JSON.stringify(replay(a).lines.filter((l) => l.text.trim() && !previewLines.includes(squash(l.text))).map((l) => l.text).slice(0, 3)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
