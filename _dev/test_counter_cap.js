/* Test for the pay-at-counter rules.
 *
 * TWO rules live side by side here, and they are deliberately different shapes:
 *
 *  1. THE CEILING (counterCapVerdict). A pay-at-counter order reaches the
 *     kitchen BEFORE any money is collected, so a guest who never shows up is a
 *     straight loss — and the loss scales with the ticket. The config caps how
 *     large such an order may be; anything above the cap must be prepaid.
 *
 *     Getting this wrong is expensive in both directions:
 *       - too permissive → a large unpaid order is cooked and never collected;
 *       - too strict     → the store silently stops taking large orders at all,
 *                          which is worse than the risk the cap guards against.
 *
 *  2. THE DELIVERY BAN (counterDeliveryVerdict). A delivery leaves the
 *     building: there is no counter to walk up to when the food arrives and
 *     nothing to collect afterwards. So a counter-paid delivery is not risky,
 *     it is impossible — which makes this rule UNCONDITIONAL. Unlike the
 *     ceiling it must NOT relax when no online method is configured; that
 *     carve-out would quietly re-open counter-paid delivery on a shop that has
 *     not wired up card payments yet.
 *
 * Both rules live in server.js. This test LIFTS THOSE FUNCTIONS OUT of the
 * source and exercises them directly, rather than re-implementing the rules —
 * a re-implementation would only prove the test agrees with itself.
 *
 * Run:  node _dev/test_counter_cap.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name + '() in server.js');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unterminated ' + name + '()');
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  grab('counterCapVerdict') + '\n' +
  grab('counterDeliveryVerdict') + '\n' +
  'this.verdict = (total, payMethod, cfg, online) => counterCapVerdict(total, payMethod, cfg, online);\n' +
  'this.deliveryVerdict = (payMethod, orderType, cfg) => counterDeliveryVerdict(payMethod, orderType, cfg);',
  ctx
);

const verdict = (total, payMethod, cfg, online) => ctx.verdict(total, payMethod, cfg, online);
const dv = (payMethod, orderType, cfg) => ctx.deliveryVerdict(payMethod, orderType, cfg);

/* Config shapes used below. */
const cap30 = { payment: { counter: { maxTotal: 30 } } };
const noCap = { payment: { counter: {} } };
const capOff = { payment: { counter: { maxTotal: 0 } } };
const capGarbage = { payment: { counter: { maxTotal: 'abc' } } };
const capNegative = { payment: { counter: { maxTotal: -5 } } };

let pass = 0, fail = 0;
function check(desc, got, wantBlocked, wantCode) {
  const ok = got.blocked === wantBlocked && (!wantBlocked || got.code === wantCode);
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + desc +
    '\n         want=' + (wantBlocked ? 'BLOCKED(' + wantCode + ')' : 'allowed') +
    '  got=' + (got.blocked ? 'BLOCKED(' + got.code + ')' : 'allowed')
  );
}

/* --- under and at the cap: still allowed --------------------------------- */
check('$12 counter, cap $30, online available → allowed',
  verdict(12, 'counter', cap30, true), false);
check('$30.00 EXACTLY at the cap → allowed (cap is a ceiling, not a wall)',
  verdict(30, 'counter', cap30, true), false);
check('$29.99 just under → allowed',
  verdict(29.99, 'counter', cap30, true), false);

/* --- over the cap: refused ----------------------------------------------- */
check('$30.01 one cent over → BLOCKED',
  verdict(30.01, 'counter', cap30, true), true, 'counter_over_cap');
check('$45 over → BLOCKED',
  verdict(45, 'counter', cap30, true), true, 'counter_over_cap');
check('$150 large party order → BLOCKED',
  verdict(150, 'counter', cap30, true), true, 'counter_over_cap');

/* --- no online alternative: the cap must NOT bite ------------------------ */
/* Otherwise a shop with no card processing would silently stop taking every
   order above the cap — a self-inflicted outage. */
check('over cap but NO online method → allowed (never lock out large orders)',
  verdict(150, 'counter', cap30, false), false);

/* --- cap switched off ---------------------------------------------------- */
check('maxTotal 0 → cap off, $150 allowed',
  verdict(150, 'counter', capOff, true), false);
check('maxTotal missing → cap off, $150 allowed',
  verdict(150, 'counter', noCap, true), false);
check('maxTotal garbage ("abc") → treated as no cap',
  verdict(150, 'counter', capGarbage, true), false);
check('maxTotal negative → treated as no cap',
  verdict(150, 'counter', capNegative, true), false);
check('payment block missing entirely → no crash, allowed',
  verdict(150, 'counter', {}, true), false);
check('cfg null → no crash, allowed',
  verdict(150, 'counter', null, true), false);

/* --- the cap is about the COUNTER only ----------------------------------- */
/* A prepaid order is paid before the kitchen sees it, so its size is
   irrelevant to this rule. */
check('stripe $150 → allowed (already prepaid)',
  verdict(150, 'stripe', cap30, true), false);
check('venmo $150 → allowed',
  verdict(150, 'venmo', cap30, true), false);
check('zelle $150 → allowed',
  verdict(150, 'zelle', cap30, true), false);
check('unknown method $150 → not this rule\'s business (allowed)',
  verdict(150, 'teleport', cap30, true), false);
check('empty method $150 → allowed by this rule',
  verdict(150, '', cap30, true), false);

/* --- defensive ----------------------------------------------------------- */
check('NaN total → not blocked (never refuse on a number we cannot read)',
  verdict(NaN, 'counter', cap30, true), false);

/* ========================================================================== */
console.log('\n--- pay at the counter on DELIVERY (counterDeliveryVerdict) ---');
/* ========================================================================== */
/* A delivery leaves the building: no counter to walk up to, nothing to
   collect afterwards. So this is a BAN, not a ceiling — and the difference
   matters, because a ban must hold even with no online method configured.
   (The ceiling above deliberately does NOT hold in that case; copying that
   carve-over would silently re-open counter-paid delivery on a shop that has
   not wired up card payments yet.) */

check('delivery + counter → BLOCKED',
  dv('counter', 'delivery', cap30), true, 'counter_not_allowed_delivery');
check('pickup + counter → allowed (this rule is about delivery only)',
  dv('counter', 'pickup', cap30), false);
check('dine-in + counter → allowed',
  dv('counter', 'dinein', cap30), false);

/* The rule is about HOW the delivery is paid, not about delivery itself. */
check('delivery + stripe → allowed',
  dv('stripe', 'delivery', cap30), false);
check('delivery + venmo → allowed',
  dv('venmo', 'delivery', cap30), false);
check('delivery + zelle → allowed',
  dv('zelle', 'delivery', cap30), false);

/* No online fallback must NOT reopen it — this is the whole point. */
check('delivery + counter with no online method → still BLOCKED',
  dv('counter', 'delivery', { delivery: {} }), true, 'counter_not_allowed_delivery');
check('delivery + counter, cfg has no delivery block at all → still BLOCKED',
  dv('counter', 'delivery', {}), true, 'counter_not_allowed_delivery');
check('delivery + counter, cfg null → still BLOCKED (fail closed)',
  dv('counter', 'delivery', null), true, 'counter_not_allowed_delivery');

/* Owner override — the one way back on, and only an explicit `true`. */
check('allowCounter:true → allowed (owner collects on the doorstep)',
  dv('counter', 'delivery', { delivery: { allowCounter: true } }), false);
check('allowCounter:false → BLOCKED',
  dv('counter', 'delivery', { delivery: { allowCounter: false } }), true, 'counter_not_allowed_delivery');
check('allowCounter:"yes" is NOT true → BLOCKED (no truthy coercion)',
  dv('counter', 'delivery', { delivery: { allowCounter: 'yes' } }), true, 'counter_not_allowed_delivery');
check('allowCounter:1 is NOT true → BLOCKED',
  dv('counter', 'delivery', { delivery: { allowCounter: 1 } }), true, 'counter_not_allowed_delivery');

/* --- the shipped config really does set $30 ------------------------------ */
/* Pins the owner's actual decision, so a stray edit to config.js is caught.
   Comments are stripped first: the config's own explanatory comment mentions
   "maxTotal: 0", and a naive regex reads that as the real setting. */
const configSrc = fs.readFileSync(path.join(ROOT, 'assets', 'config.js'), 'utf8');
const configCode = configSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/\/\/[^\n]*/g, '');        // line comments
const m = configCode.match(/counter:\s*\{[\s\S]*?maxTotal:\s*([0-9.]+)/);
const shipped = m ? Number(m[1]) : null;
const cfgOk = shipped === 30;
if (cfgOk) pass++; else fail++;
console.log((cfgOk ? '  ok  ' : '  FAIL') +
  '  config.js ships maxTotal = 30 (owner decision)' +
  (cfgOk ? '' : '\n         parsed maxTotal = ' + shipped));

/* The delivery ban is the same kind of owner decision and has the same trap:
   the config's own comment names `allowCounter: false`, so a regex over the
   RAW source would read the comment as the setting. `configCode` above is
   already comment-stripped for exactly this reason. */
const acMatch = configCode.match(/allowCounter:\s*(true|false)/);
const allowCounter = acMatch ? acMatch[1] : '(absent)';
const acOk = allowCounter === 'false';
if (acOk) pass++; else fail++;
console.log((acOk ? '  ok  ' : '  FAIL') +
  '  config.js ships delivery.allowCounter = false (delivery is prepaid-only)' +
  (acOk ? '' : '\n         parsed allowCounter = ' + allowCounter));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
