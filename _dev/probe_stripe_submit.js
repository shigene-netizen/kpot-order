#!/usr/bin/env node
/* Focused probe: why does Stripe's hosted Checkout refuse our submit?

   The full e2e (_dev/e2e_real_stripe.js) fills the card form and clicks Pay,
   and the page just sits there. This isolates that one step and dumps what
   Stripe is actually objecting to, instead of guessing.

   It creates a real TEST-mode session, drives it in headless Chrome, and
   expires the session on the way out — nothing is left payable.

   Usage:
     KPOT_KEY_FILE=C:/test/kpot-test-key.txt node _dev/probe_stripe_submit.js
   Test a different expiry format:
     EXPIRY='1234' KPOT_KEY_FILE=... node _dev/probe_stripe_submit.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KEY = (() => {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  const f = process.env.KPOT_KEY_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
})();
if (!KEY) { console.error('no key: set KPOT_KEY_FILE or STRIPE_SECRET_KEY'); process.exit(1); }

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9371', 10);
const EXPIRY = process.env.EXPIRY || '12 / 34';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD = { number: process.env.CARD || '4242 4242 4242 4242', expiry: EXPIRY, cvc: process.env.CVC || '123' };

async function createSession() {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', 'https://example.com/?paid=1');
  form.set('cancel_url', 'https://example.com/?canceled=1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][product_data][name]', 'KPOT To Go');
  form.set('line_items[0][price_data][unit_amount]', '1695');
  form.set('line_items[0][quantity]', '1');
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'submitprobe-' + Date.now() },
    body: form.toString()
  });
  const s = await r.json();
  if (!r.ok) throw new Error('create failed: ' + JSON.stringify(s.error || s));
  return s;
}

async function expire(id) {
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + id + '/expire', {
      method: 'POST', headers: { Authorization: 'Bearer ' + KEY }
    });
    console.log('expire ' + id + ' → HTTP ' + r.status);
  } catch (e) { console.log('expire failed: ' + e.message); }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + ((d.exception && d.exception.description) || d.text));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  async function rawEval(expression) {
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try { return await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
      catch (e) { lastErr = e; await sleep(400); }
    }
    throw lastErr;
  }
  async function evalJs(expression) {
    const r = await rawEval(expression);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('IN-PAGE: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).split('\n')[0]);
    }
    return r.result ? (r.result.value !== undefined ? r.result.value : r.result.description) : undefined;
  }
  return { ws, send, evalJs, logs };
}

async function main() {
  console.log('key mode:', (KEY.match(/^(?:sk|rk)_(live|test)_/) || [])[1] || 'unknown');
  console.log('expiry value under test:', JSON.stringify(CARD.expiry), '\n');

  const session = await createSession();
  console.log('session:', session.id);
  console.log('url    :', session.url.slice(0, 70) + '…\n');

  const profile = path.join(os.tmpdir(), 'kpot-submit-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--window-size=430,932', 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
        list = await r.json();
        if (list && list.some((t) => t.type === 'page')) break;
      } catch (e) {}
    }
    if (!list) throw new Error('chrome did not start');

    cdp = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.ws.addEventListener('open', r));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: session.url });
    await sleep(10000);

    const filled = await cdp.evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const setNative = (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
      };

      const email = document.querySelector('#email') || document.querySelector('input[type="email"]');
      if (email) { email.focus(); setNative(email, 'e2e@example.com'); }
      await sleep(800);

      if (!document.querySelector('#cardNumber')) {
        const b = document.querySelector('[aria-label="Pay with card"]') ||
          Array.from(document.querySelectorAll('button')).find(x => /pay with card/i.test(x.textContent || ''));
        if (b) b.click();
        await sleep(4500);
      }
      out.cardFormVisible = !!document.querySelector('#cardNumber');
      if (!out.cardFormVisible) return out;

      setNative(document.querySelector('#cardNumber'), ${JSON.stringify(CARD.number)});
      await sleep(500);
      const exp = document.querySelector('#cardExpiry'); if (exp) setNative(exp, ${JSON.stringify(CARD.expiry)});
      await sleep(500);
      const cvc = document.querySelector('#cardCvc');   if (cvc) setNative(cvc, ${JSON.stringify(CARD.cvc)});
      await sleep(500);
      const bn = document.querySelector('#billingName'); if (bn) setNative(bn, 'E2E Test');
      const pc = document.querySelector('#billingPostalCode'); if (pc) setNative(pc, '30339');
      /* Stripe's sandbox asks for a phone number and marks it required; leaving
         it blank produces a bare "Required" alert and the submit never fires. */
      const ph = document.querySelector('#phoneNumber'); if (ph) setNative(ph, ${JSON.stringify(process.env.PHONE || '4045550142')});
      await sleep(900);

      const snap = () => ({
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({
          id: i.id, name: i.name, type: i.type,
          value: (i.type === 'password' ? '***' : (i.value || '')),
          invalid: i.getAttribute('aria-invalid') || '',
          required: i.required || false
        })),
        selects: Array.from(document.querySelectorAll('select')).map(s => ({
          id: s.id, name: s.name, value: s.value,
          options: s.options.length, required: s.required || false
        }))
      });
      out.beforeSubmit = snap();

      const byTestId = document.querySelector('[data-testid="hosted-payment-submit-button"]');
      const byText = Array.from(document.querySelectorAll('button')).find(b => /^pay/i.test((b.textContent || '').trim()) && !b.disabled);
      const pay = (byTestId && !byTestId.disabled) ? byTestId : byText;
      out.payLabel = pay ? (pay.textContent || '').trim() : null;
      out.payDisabled = pay ? !!pay.disabled : null;
      if (pay) pay.click();
      return out;
    })()`);

    console.log('--- FILLED ---');
    console.log(JSON.stringify(filled, null, 2));

    await sleep(9000);

    const after = await cdp.evalJs(`(() => {
      const txt = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const alerts = [];
      document.querySelectorAll('[role="alert"], [aria-live="polite"], [aria-live="assertive"]').forEach(e => {
        const t = txt(e); if (t) alerts.push(t.slice(0, 200));
      });
      const errNodes = [];
      document.querySelectorAll('[class*="Error" i], [class*="error" i], [data-testid*="error" i]').forEach(e => {
        const t = txt(e); if (t && t.length < 250) errNodes.push(t.slice(0, 250));
      });
      return {
        url: location.href.slice(0, 90),
        title: document.title,
        alerts: alerts.slice(0, 12),
        errNodes: Array.from(new Set(errNodes)).slice(0, 15),
        invalidInputs: Array.from(document.querySelectorAll('input')).filter(i => i.getAttribute('aria-invalid') === 'true')
          .map(i => ({ id: i.id, name: i.name })),
        selects: Array.from(document.querySelectorAll('select')).map(s => ({ id: s.id, name: s.name, value: s.value })),
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({
          id: i.id, name: i.name, value: (i.value || '').slice(0, 40), invalid: i.getAttribute('aria-invalid') || ''
        })),
        submitBtn: (() => { const b = document.querySelector('[data-testid="hosted-payment-submit-button"]'); return b ? { text: txt(b).slice(0,60), disabled: !!b.disabled } : null; })(),
        bodyTail: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(-1400)
      };
    })()`);

    console.log('\n--- AFTER SUBMIT (' + (after && after.url) + ') ---');
    console.log(JSON.stringify(after, null, 2));

    if (cdp.logs.length) {
      console.log('\n--- PAGE EXCEPTIONS ---');
      console.log(cdp.logs.slice(-10).join('\n'));
    }
  } catch (e) {
    console.log('probe failed: ' + e.message);
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    chrome.kill();
    await expire(session.id);
    await sleep(300);
    process.exit(0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
