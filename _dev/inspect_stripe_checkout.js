/* Inspect the DOM structure of a Stripe hosted Checkout page, so the
   end-to-end test knows where the card fields live.

   Stripe renders the payment form inside cross-origin iframes, so an ordinary
   in-page script cannot see it. This talks CDP directly and enumerates every
   frame's execution context. Phase 1 dumps the landing page; phase 2 clicks
   "Pay with card" (which is what reveals the card fields) and dumps again.

   Usage: node _dev/inspect_stripe_checkout.js <checkout-url>
*/
const { spawn } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
const URL_TO_OPEN = process.argv[2];
if (!URL_TO_OPEN) { console.error('usage: inspect_stripe_checkout.js <url>'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = require('os').tmpdir() + '\\stripe-probe-' + Date.now();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=430,932', 'about:blank'
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (list && list.some((t) => t.type === 'page')) break;
    } catch (e) {}
  }
  if (!list) { console.error('chrome did not start'); chrome.kill(); process.exit(1); }

  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const contexts = new Map();

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.executionContextCreated') {
      const c = m.params.context;
      if (c.auxData && c.auxData.frameId) contexts.set(c.auxData.frameId, c.id);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  async function evalIn(ctxId, expression) {
    const r = await send('Runtime.evaluate', { expression, contextId: ctxId, returnByValue: true });
    return r.result && r.result.value;
  }

  const FIELD_EXPR = `(() => {
    const out = [];
    document.querySelectorAll('input,select,textarea,button').forEach((el) => {
      out.push({
        tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
        id: el.id || '', ac: el.autocomplete || '',
        aria: el.getAttribute('aria-label') || '', ph: el.placeholder || '',
        text: el.tagName === 'BUTTON' ? (el.textContent || '').trim().slice(0, 40) : ''
      });
    });
    return JSON.stringify({ title: document.title, count: out.length, els: out });
  })()`;

  async function dump(label) {
    const tree = await send('Page.getFrameTree');
    const frames = [];
    (function walk(node) {
      frames.push({ id: node.frame.id, url: node.frame.url });
      (node.childFrames || []).forEach(walk);
    })(tree.frameTree);

    console.log('\n=========== ' + label + ' — ' + frames.length + ' frame(s) ===========');
    for (const f of frames) {
      const ctxId = contexts.get(f.id);
      console.log('\n-- ' + f.url.slice(0, 100));
      if (!ctxId) { console.log('   (no execution context)'); continue; }
      try {
        const v = JSON.parse(await evalIn(ctxId, FIELD_EXPR));
        console.log('   title: ' + v.title + '   elements: ' + v.count);
        v.els.slice(0, 30).forEach((e) => {
          console.log('   <' + e.tag + (e.type ? ' type=' + e.type : '') +
            (e.name ? ' name=' + e.name : '') + (e.id ? ' id=' + e.id : '') +
            (e.ac ? ' ac=' + e.ac : '') + (e.aria ? ' aria=' + e.aria : '') +
            (e.ph ? ' ph=' + e.ph : '') + (e.text ? ' text="' + e.text + '"' : '') + '>');
        });
      } catch (e) {
        console.log('   evaluate failed: ' + e.message.slice(0, 100));
      }
    }
    return frames;
  }

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_TO_OPEN });
  await sleep(12000);

  const frames1 = await dump('PHASE 1 — landing');
  const rootCtx = contexts.get(frames1[0].id);

  console.log('\n########## clicking "Pay with card" ##########');
  try {
    const res = await evalIn(rootCtx, `(() => {
      const b = document.querySelector('[aria-label="Pay with card"]') ||
        Array.from(document.querySelectorAll('button')).find(x => /pay with card/i.test(x.textContent || ''));
      if (!b) return 'button not found';
      b.click();
      return 'clicked';
    })()`);
    console.log('click result: ' + res);
  } catch (e) { console.log('click failed: ' + e.message.slice(0, 120)); }

  await sleep(8000);
  await dump('PHASE 2 — after clicking card');

  try { ws.close(); } catch (e) {}
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
